export const SAMPLE_RATE = 48000;

export const BAND_EDGES: readonly number[] = Array.from({ length: 31 }, (_, i) => 20 * 2 ** (i / 3));
export const BAND_CENTERS: readonly number[] = BAND_EDGES.slice(0, -1).map((f, i) => Math.sqrt(f * BAND_EDGES[i + 1]));
export const NB = BAND_CENTERS.length;
const LOG_CENTERS = BAND_CENTERS.map(Math.log2);

function biquadMagnitude(b: readonly number[], a: readonly number[], f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const re = (c: readonly number[]) => c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
  const im = (c: readonly number[]) => -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
  return Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
}

// ITU-R BS.1770 K-weighting, evaluated at each band center.
const K_WEIGHT_LIN: readonly number[] = BAND_CENTERS.map((f) => {
  const shelf = biquadMagnitude([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], f, 48000);
  const highpass = biquadMagnitude([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], f, 48000);
  return (shelf * highpass) ** 2;
});

export function loudness(bandsLin: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < NB; k++) s += bandsLin[k] * K_WEIGHT_LIN[k];
  return 10 * Math.log10(s + 1e-30) - 0.691;
}

export function shiftBands(bandsLin: Float64Array, semitones: number): Float64Array {
  if (!semitones) return bandsLin;
  const out = new Float64Array(NB);
  const lg = Array.from(bandsLin, (v) => Math.log10(Math.max(v, 1e-30)));
  const step = 1 / 3;
  for (let k = 0; k < NB; k++) {
    const src = (LOG_CENTERS[k] - semitones / 12 - LOG_CENTERS[0]) / step;
    if (src <= 0) out[k] = 10 ** (lg[0] + src * 3);
    else if (src >= NB - 1) out[k] = 10 ** (lg[NB - 1] - (src - NB + 1) * 3);
    else {
      const i = Math.floor(src);
      const fr = src - i;
      out[k] = 10 ** (lg[i] * (1 - fr) + lg[i + 1] * fr);
    }
  }
  return out;
}

export function rollChroma(chroma: number[], semitones: number): number[] {
  const s = Math.round(semitones);
  if (!s) return chroma;
  return chroma.map((_, i) => chroma[(((i - s) % 12) + 12) % 12]);
}

interface WindowFn {
  w: Float64Array;
  sumSq: number;
}

export class Spectrum {
  readonly n: number;
  readonly sampleRate: number;
  readonly binBand: Int16Array;
  readonly binPitchClass: Int8Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly acc: Float64Array;
  private readonly windows = new Map<number, WindowFn>();

  constructor(n = 4096, sampleRate = SAMPLE_RATE) {
    this.n = n;
    this.sampleRate = sampleRate;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.acc = new Float64Array(n / 2 + 1);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.binBand = new Int16Array(n / 2 + 1).fill(-1);
    this.binPitchClass = new Int8Array(n / 2 + 1).fill(-1);
    for (let k = 1; k <= n / 2; k++) {
      const f = (k * sampleRate) / n;
      for (let b = 0; b < NB; b++) if (f >= BAND_EDGES[b] && f < BAND_EDGES[b + 1]) this.binBand[k] = b;
      if (f > 50 && f < 4000) this.binPitchClass[k] = (((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12);
    }
  }

  private windowFor(len: number): WindowFn {
    let w = this.windows.get(len);
    if (!w) {
      const arr = new Float64Array(len);
      let s = 0;
      for (let i = 0; i < len; i++) {
        arr[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, len - 1));
        s += arr[i] * arr[i];
      }
      w = { w: arr, sumSq: s };
      if (this.windows.size > 64) this.windows.clear();
      this.windows.set(len, w);
    }
    return w;
  }

  private fft(): void {
    const { re, im, n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  /** Mean power per one-sided bin of x[start, start+len), averaged over Hann frames. Sum ≈ mean square. */
  psd(x: Float32Array, start: number, len: number, out: Float64Array): boolean {
    out.fill(0);
    const n = this.n;
    if (len < 64) return false;
    const frameLen = Math.min(n, len);
    const { w, sumSq } = this.windowFor(frameLen);
    const hop = frameLen === n ? n / 2 : frameLen;
    const starts: number[] = [];
    for (let o = 0; o + frameLen <= len; o += hop) starts.push(start + o);
    if (starts.length === 0 || starts[starts.length - 1] + frameLen < start + len - hop / 2) starts.push(start + len - frameLen);
    this.acc.fill(0);
    for (const s0 of starts) {
      this.re.fill(0);
      this.im.fill(0);
      for (let i = 0; i < frameLen; i++) this.re[i] = x[s0 + i] * w[i];
      this.fft();
      for (let k = 0; k <= n / 2; k++) this.acc[k] += this.re[k] * this.re[k] + this.im[k] * this.im[k];
    }
    const norm = 1 / (n * sumSq * starts.length);
    for (let k = 0; k <= n / 2; k++) out[k] = this.acc[k] * norm * (k === 0 || k === n / 2 ? 1 : 2);
    return true;
  }

  bands(psd: Float64Array, out: Float64Array): void {
    out.fill(0);
    for (let k = 1; k < psd.length; k++) {
      const b = this.binBand[k];
      if (b >= 0) out[b] += psd[k];
    }
  }

  chroma(psd: Float64Array): number[] {
    const c = new Array<number>(12).fill(0);
    let s = 0;
    for (let k = 1; k < psd.length; k++) {
      const pc = this.binPitchClass[k];
      if (pc >= 0) { c[pc] += psd[k]; s += psd[k]; }
    }
    return s > 0 ? c.map((v) => v / s) : c;
  }
}
