// Renders a short synthetic song into stems, analyzes them with the same code the app uses,
// and writes public/demo.mixmap.json. Pass --wav to also write the stems to local/demo-stems/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { analyzeAudio, type Stereo, type WindowSource } from '../src/analyze.ts';
import { BAND_CENTERS, SAMPLE_RATE, Spectrum } from '../src/dsp.ts';
import { LIVE_PALETTE } from '../src/palette.ts';
import type { MapData, TrackMap } from '../src/types.ts';

const BPM = 96;
const BARS = 32;
const SR = SAMPLE_RATE;
const BEAT = 60 / BPM;
const LEN = Math.ceil(BARS * 4 * BEAT * SR);
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const BASS = [33, 29, 36, 31];
const LEAD = [69, 72, 71, 67, 69, 64, 67, 69, 72, 74, 72, 71, 69, 67, 64, 62];

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (p: number) => 440 * 2 ** ((p - 69) / 12);
const at = (bar: number, beat: number) => Math.floor(((bar - 1) * 4 + beat) * BEAT * SR);

function stereo(): Stereo {
  return { L: new Float32Array(LEN), R: new Float32Array(LEN), sampleRate: SR };
}

function add(s: Stereo, start: number, sig: Float32Array, gl: number, gr: number) {
  for (let i = 0; i < sig.length && start + i < LEN; i++) {
    s.L[start + i] += sig[i] * gl;
    s.R[start + i] += sig[i] * gr;
  }
}

function lowpass(x: Float32Array, fc: number) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) x[i] = y += a * (x[i] - y);
  return x;
}

function highpass(x: Float32Array, fc: number) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let lp = 0;
  for (let i = 0; i < x.length; i++) { lp += a * (x[i] - lp); x[i] -= lp; }
  return x;
}

function saw(f: number, n: number, detune = 0) {
  const out = new Float32Array(n);
  let ph = Math.random();
  const inc = (f * 2 ** (detune / 1200)) / SR;
  for (let i = 0; i < n; i++) { out[i] = 2 * ph - 1; ph = (ph + inc) % 1; }
  return out;
}

const env = (x: Float32Array, attack: number, decay: number) => {
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] *= Math.min(1, t / Math.max(attack, 1e-4)) * Math.exp(-t / decay);
  }
  return x;
};

function kick(): Float32Array {
  const n = Math.floor(0.45 * SR), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (45 + 90 * Math.exp(-t * 28))) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t * 7);
  }
  return out;
}

function clap(): Float32Array {
  const n = Math.floor(0.25 * SR), noise = new Float32Array(n), body = new Float32Array(n);
  for (let i = 0; i < n; i++) { noise[i] = rand(); body[i] = Math.sin((2 * Math.PI * 190 * i) / SR); }
  highpass(lowpass(noise, 5200), 900);
  env(noise, 0.001, 0.07);
  env(body, 0.001, 0.04);
  for (let i = 0; i < n; i++) noise[i] = noise[i] * 1.4 + body[i] * 0.5;
  return noise;
}

function hat(open: boolean): Float32Array {
  const n = Math.floor((open ? 0.18 : 0.05) * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand();
  highpass(highpass(out, 7000), 7000);
  return env(out, 0.0005, open ? 0.06 : 0.015);
}

function render(): { name: string; color: string; buf: Stereo }[] {
  const kickS = stereo(), clapS = stereo(), hatS = stereo(), bassS = stereo(), padS = stereo(), leadS = stereo(), voxS = stereo();
  const k = kick(), c = clap();
  for (let bar = 1; bar <= BARS; bar++) {
    const chord = CHORDS[(bar - 1) % 4];
    if (bar >= 9 && bar <= 28) for (let b = 0; b < 4; b++) add(kickS, at(bar, b), k, 0.9, 0.9);
    if (bar >= 29) for (const b of [0, 2]) add(kickS, at(bar, b), k, 0.7, 0.7);
    if (bar >= 9 && bar <= 28) for (const b of [1, 3]) add(clapS, at(bar, b), c, 0.5, 0.46);
    if (bar >= 5) for (let s = 0; s < 16; s++) add(hatS, at(bar, s / 4), hat(s % 4 === 2), (s % 2 ? 0.16 : 0.26) * 0.75, s % 2 ? 0.16 : 0.26);
    if (bar >= 9 && bar <= 28) {
      for (let e = 0; e < 8; e++) {
        const n = Math.floor(BEAT * SR * 0.45);
        const note = BASS[(bar - 1) % 4] + (e === 6 ? 12 : 0);
        const sig = env(lowpass(lowpass(saw(hz(note), n), 420), 420), 0.004, 0.25);
        add(bassS, at(bar, e / 2), sig, 0.55, 0.55);
      }
    }
    const padLen = Math.floor(4 * BEAT * SR);
    if (bar !== 25 && bar !== 26) {
      for (const p of chord) {
        const l = lowpass(saw(hz(p), padLen, -9), 2200), r = lowpass(saw(hz(p), padLen, 9), 2200);
        for (let i = 0; i < padLen; i++) { const t = i / SR; const g = Math.min(1, t / 0.4) * Math.min(1, (padLen / SR - t) / 0.3); l[i] *= g; r[i] *= g; }
        add(padS, at(bar, 0), l, 0.07, 0);
        add(padS, at(bar, 0), r, 0, 0.07);
      }
    }
    if (bar >= 17 && bar <= 28) {
      for (let s = 0; s < 4; s++) {
        const p = LEAD[((bar - 17) * 4 + s) % LEAD.length];
        const n = Math.floor(BEAT * SR * 0.9);
        const sq = saw(hz(p), n).map((v) => (v > 0 ? 0.6 : -0.6));
        add(leadS, at(bar, s), env(lowpass(sq, 3200), 0.01, 0.45), 0.22, 0.12);
      }
    }
    if (bar >= 13 && bar <= 24) {
      for (const b of [0.5, 2.5, 3.25]) {
        const n = Math.floor(0.22 * SR);
        const src = saw(hz(chord[2] + 12), n);
        const f1 = lowpass(highpass(Float32Array.from(src), 600), 900);
        const f2 = lowpass(highpass(Float32Array.from(src), 1100), 1500);
        const sig = env(f1.map((v, i) => v + f2[i] * 0.6), 0.005, 0.09);
        add(voxS, at(bar, b), sig, 0.5, 0.5);
      }
    }
  }
  const P = LIVE_PALETTE;
  return [
    { name: 'Kick', color: P[14], buf: kickS },
    { name: 'Clap', color: P[1], buf: clapS },
    { name: 'Hats', color: P[17], buf: hatS },
    { name: 'Bass', color: P[9], buf: bassS },
    { name: 'Pad', color: P[11], buf: padS },
    { name: 'Lead', color: P[19], buf: leadS },
    { name: 'Vox Chop', color: P[26], buf: voxS },
  ];
}

function wav(s: Stereo): Buffer {
  const n = s.L.length, data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s.L[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s.R[i] * 32767))), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const stems = render();
const spectrum = new Spectrum(4096, SR);
const tracks: TrackMap[] = stems.map((st, i) => {
  const source: WindowSource = (t0, t1) => {
    const s0 = Math.round(t0 * BEAT * SR), s1 = Math.min(LEN, Math.round(t1 * BEAT * SR));
    return s1 - s0 >= 64 ? { buf: st.buf, start: s0, len: s1 - s0, shift: 0, gainDb: 0 } : null;
  };
  const frames = analyzeAudio(source, { bars: BARS, beatsPerBar: 4 }, spectrum);
  return { id: `demo-${i}`, name: st.name, color: st.color, kind: 'stem', muted: false, silent: frames.every((f) => !f), frames };
});

const map: MapData = {
  format: 'mixmap',
  version: 1,
  name: 'Night Bus (demo)',
  bpm: BPM,
  beatsPerBar: 4,
  bars: BARS,
  bandCenters: BAND_CENTERS.map((c) => Math.round(c * 10) / 10),
  locators: [{ name: 'Drop', bar: 9 }, { name: 'Lead', bar: 17 }, { name: 'Break', bar: 25 }, { name: 'Outro', bar: 29 }],
  tracks,
  notes: ['This demo is a short synthetic song made from code (scripts/make-demo.ts), measured from its seven stems.'],
};

mkdirSync('public', { recursive: true });
writeFileSync('public/demo.mixmap.json', JSON.stringify(map));
console.log(`wrote public/demo.mixmap.json (${tracks.length} tracks, ${BARS} bars)`);
if (process.argv.includes('--wav')) {
  mkdirSync('local/demo-stems', { recursive: true });
  for (const st of stems) writeFileSync(`local/demo-stems/Night Bus ${st.name}.wav`, wav(st.buf));
  console.log('wrote local/demo-stems/*.wav');
}
