import { BAND_CENTERS, NB, Spectrum, loudness, rollChroma, shiftBands } from './dsp.ts';
import type { Frame } from './types.ts';

export interface Stereo {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
}

export interface AudioWindow {
  buf: Stereo;
  start: number;
  len: number;
  shift: number;
  gainDb: number;
}

/** Returns the audio heard between two arrangement positions (in beats), or null for silence. */
export type WindowSource = (beat0: number, beat1: number) => AudioWindow | null;

export interface Grid {
  bars: number;
  beatsPerBar: number;
}

export interface ArrNote {
  t: number;
  d: number;
  v: number;
  p: number;
}

const SILENCE = 1e-9;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface RawBar {
  bands: Float64Array;
  env: number[];
  chroma: number[][];
  mid: number;
  side: number;
  left: number;
  right: number;
}

function finish(raw: RawBar[], widthOverride?: number, balanceOverride?: number): (Frame | null)[] {
  let envMax = 0;
  for (const r of raw) for (const v of r.env) if (v > envMax) envMax = v;
  return raw.map((r) => {
    let total = 0;
    for (const v of r.bands) total += v;
    if (total < SILENCE) return null;
    return {
      bands: Array.from(r.bands, (v) => r1(10 * Math.log10(v + 1e-30))),
      loud: r1(loudness(r.bands)),
      width: r3(widthOverride ?? Math.sqrt(r.side / (r.mid + 1e-30))),
      balance: r3(balanceOverride ?? (r.right - r.left) / (r.right + r.left + 1e-30)),
      env: r.env.map((v) => r3(envMax > 0 ? v / envMax : 0)),
      chroma: r.chroma.map((c) => c.map(r3)),
    };
  });
}

export function analyzeAudio(source: WindowSource, grid: Grid, spectrum: Spectrum): (Frame | null)[] {
  const { bars, beatsPerBar } = grid;
  const steps = Math.max(1, Math.round(beatsPerBar * 4));
  const beatsInBar = Math.ceil(beatsPerBar - 1e-6);
  const psd = new Float64Array(spectrum.n / 2 + 1);
  const bandTmp = new Float64Array(NB);
  let mid = new Float32Array(0);
  const raw: RawBar[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * beatsPerBar;
    const rb: RawBar = { bands: new Float64Array(NB), env: new Array<number>(steps).fill(0), chroma: [], mid: 0, side: 0, left: 0, right: 0 };
    for (let j = 0; j < beatsInBar; j++) {
      const t0 = b0 + j;
      const t1 = Math.min(b0 + j + 1, b0 + beatsPerBar);
      const w = source(t0, t1);
      if (!w || w.len < 64) {
        rb.chroma.push(new Array<number>(12).fill(0));
        continue;
      }
      const { L, R } = w.buf;
      if (mid.length < w.len) mid = new Float32Array(w.len);
      const g = 10 ** (w.gainDb / 10);
      const frac = (t1 - t0) / beatsPerBar;
      let sm = 0, ss = 0, sl = 0, sr = 0;
      for (let i = 0; i < w.len; i++) {
        const l = L[w.start + i], r = R[w.start + i];
        const m = (l + r) / 2, s = (l - r) / 2;
        mid[i] = m;
        sm += m * m; ss += s * s; sl += l * l; sr += r * r;
      }
      rb.mid += (sm / w.len) * g * frac;
      rb.side += (ss / w.len) * g * frac;
      rb.left += (sl / w.len) * g * frac;
      rb.right += (sr / w.len) * g * frac;
      spectrum.psd(mid, 0, w.len, psd);
      spectrum.bands(psd, bandTmp);
      const shifted = shiftBands(bandTmp, w.shift);
      for (let k = 0; k < NB; k++) rb.bands[k] += shifted[k] * g * frac;
      rb.chroma.push(rollChroma(spectrum.chroma(psd), w.shift));
      const stepsHere = Math.max(1, Math.round((t1 - t0) * 4));
      for (let q = 0; q < stepsHere; q++) {
        const s0 = Math.floor((q * w.len) / stepsHere);
        const s1 = Math.floor(((q + 1) * w.len) / stepsHere);
        let e = 0;
        for (let i = s0; i < s1; i++) e += mid[i] * mid[i];
        const idx = j * 4 + q;
        if (idx < steps) rb.env[idx] = Math.sqrt((e / Math.max(1, s1 - s0)) * g);
      }
    }
    raw.push(rb);
  }
  return finish(raw);
}

const TARGET_LOUDNESS = -24;

function normalizeTo(spec: Float64Array, target: number): Float64Array {
  const l = loudness(spec);
  const k = 10 ** ((target - l) / 10);
  for (let i = 0; i < spec.length; i++) spec[i] *= k;
  return spec;
}

function bandOf(f: number): number {
  for (let b = 0; b < NB; b++) if (f < BAND_CENTERS[b] * 2 ** (1 / 6)) return f >= BAND_CENTERS[b] * 2 ** (-1 / 6) ? b : -1;
  return -1;
}

const PITCH_SPECTRA: Float64Array[] = Array.from({ length: 128 }, (_, p) => {
  const spec = new Float64Array(NB);
  const f0 = 440 * 2 ** ((p - 69) / 12);
  for (let h = 1; h <= 24; h++) {
    const f = f0 * h;
    if (f > 20000) break;
    const b = bandOf(f);
    if (b < 0) continue;
    spec[b] += (1 / (h * h)) / (1 + (f / 6000) ** 4);
  }
  return normalizeTo(spec, TARGET_LOUDNESS);
});

const DRUM_SPECTRUM: Float64Array = normalizeTo(
  Float64Array.from(BAND_CENTERS, (f) => 1 / (1 + (40 / f) ** 4) / (1 + (f / 12000) ** 4)),
  TARGET_LOUDNESS,
);

function noteLevel(dt: number, dur: number, drums: boolean): number {
  if (dt < 0) return 0;
  if (drums) return Math.exp(-dt * 6);
  if (dt < dur) return 0.55 + 0.45 * Math.exp(-dt * 3);
  return 0.55 * Math.exp(-(dt - dur) * 2.4);
}

/** Builds approximate frames for a MIDI track from its notes, when no audio is available. */
export function estimateMidi(notes: ArrNote[], grid: Grid, drums: boolean, balance: number, gainDb: number): (Frame | null)[] {
  const { bars, beatsPerBar } = grid;
  const steps = Math.max(1, Math.round(beatsPerBar * 4));
  const beatsInBar = Math.ceil(beatsPerBar - 1e-6);
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  const g = 10 ** (gainDb / 10);
  const raw: RawBar[] = [];
  let cursor = 0;
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * beatsPerBar;
    const b1 = b0 + beatsPerBar;
    while (cursor < sorted.length && sorted[cursor].t + sorted[cursor].d + 2 < b0) cursor++;
    const near: ArrNote[] = [];
    for (let i = cursor; i < sorted.length && sorted[i].t < b1; i++) if (sorted[i].t + sorted[i].d + 2 >= b0) near.push(sorted[i]);
    const rb: RawBar = { bands: new Float64Array(NB), env: new Array<number>(steps).fill(0), chroma: [], mid: 0, side: 0, left: 0, right: 0 };
    for (let j = 0; j < beatsInBar; j++) {
      const t0 = b0 + j;
      const t1 = Math.min(b0 + j + 1, b1);
      const pc = new Array<number>(12).fill(0);
      let pcSum = 0;
      for (const n of near) {
        const end = n.t + (drums ? 0.5 : n.d + 0.25);
        const ov = Math.min(t1, end) - Math.max(t0, n.t);
        if (ov <= 0) continue;
        const w = (ov / (t1 - t0)) * (n.v / 100) ** 2 * g * ((t1 - t0) / beatsPerBar);
        const spec = drums ? DRUM_SPECTRUM : PITCH_SPECTRA[Math.max(0, Math.min(127, n.p))];
        for (let k = 0; k < NB; k++) rb.bands[k] += spec[k] * w;
        if (!drums) { pc[n.p % 12] += w; pcSum += w; }
      }
      rb.chroma.push(pcSum > 0 ? pc.map((v) => v / pcSum) : pc);
    }
    for (let q = 0; q < steps; q++) {
      const ts = b0 + q / 4 + 0.125;
      let v = 0;
      for (const n of near) v = Math.max(v, (n.v / 127) * noteLevel(ts - n.t, n.d, drums));
      rb.env[q] = v;
    }
    raw.push(rb);
  }
  return finish(raw, drums ? 0.2 : 0.3, balance);
}
