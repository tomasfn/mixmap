import type { MapData } from './types.ts';

export interface Insight {
  title: string;
  body: string;
}

export const ZONES: readonly [string, number, number][] = [
  ['Sub', 20, 60],
  ['Bass', 60, 250],
  ['Low mids', 250, 500],
  ['Mids', 500, 2000],
  ['Presence', 2000, 6000],
  ['Air', 6000, 20000],
];

export const fmtHz = (f: number): string => (f >= 1000 ? `${Math.round(f / 100) / 10} kHz` : `${Math.round(f)} Hz`);
export const fmtRange = (a: number, b: number): string => (a >= 1000 && b >= 1000 ? `${Math.round(a / 100) / 10}–${fmtHz(b)}` : `${Math.round(a)}–${b >= 1000 ? fmtHz(b) : `${Math.round(b)} Hz`}`);

export function computeInsights(map: MapData): Insight[] {
  const out: Insight[] = [];
  const C = map.bandCenters;
  const live = map.tracks.filter((t) => !t.muted && !t.silent);
  if (!live.length) return out;

  const widths: { name: string; w: number; bal: number }[] = live.map((t) => {
    const fs = t.frames.filter((f) => f !== null);
    const w = fs.reduce((s, f) => s + f!.width, 0) / Math.max(1, fs.length);
    const bal = fs.reduce((s, f) => s + f!.balance, 0) / Math.max(1, fs.length);
    return { name: t.name, w, bal };
  });
  const centered = widths.filter((x) => Math.abs(x.bal) < 0.12).length;
  if (centered / widths.length >= 0.8) {
    const wide = [...widths].sort((a, b) => b.w - a.w).slice(0, 2).filter((x) => x.w > 0.3).map((x) => x.name);
    out.push({ title: 'Almost everything sits in the center', body: `${centered} of ${widths.length} sounding tracks are balanced dead center.${wide.length ? ` The width you see comes from the sounds themselves (${wide.join(' and ')} are the widest).` : ''} The sides of the stereo field are open.` });
  }

  const zoneDensity = ZONES.map(([, lo, hi]) => {
    let e = 0;
    for (const t of live) for (const f of t.frames) if (f) for (let k = 0; k < C.length; k++) if (C[k] >= lo && C[k] < hi) e += 10 ** (f.bands[k] / 10);
    return 10 * Math.log10(e / Math.log2(hi / lo) + 1e-30);
  });
  const top = Math.max(...zoneDensity);
  const topZone = ZONES[zoneDensity.indexOf(top)];
  const weak = ZONES.filter((_, i) => zoneDensity[i] < top - 20 && i >= 3);
  if (weak.length) {
    const gap = Math.round(top - zoneDensity[ZONES.indexOf(weak[0])]);
    out.push({ title: `The mix lives low`, body: `Most of the energy is in the ${topZone[0].toLowerCase()} range (${fmtRange(topZone[1], topZone[2])}). ${weak.map((z) => z[0]).join(' and ')} sit${weak.length > 1 ? '' : 's'} about ${gap} dB below it, which can make a mix sound closed or simple.` });
  }

  const crowd = ZONES.map(([, lo, hi]) => {
    let sum = 0, bars = 0;
    for (let b = 0; b < map.bars; b++) {
      let n = 0;
      for (const t of live) {
        const f = t.frames[b];
        if (!f) continue;
        let mx = -Infinity, inZone = -Infinity;
        for (let k = 0; k < C.length; k++) { mx = Math.max(mx, f.bands[k]); if (C[k] >= lo && C[k] < hi) inZone = Math.max(inZone, f.bands[k]); }
        if (inZone > mx - 6) n++;
      }
      if (n) { sum += n; bars++; }
    }
    return bars ? sum / bars : 0;
  });
  const ci = crowd.indexOf(Math.max(...crowd));
  if (crowd[ci] >= 2.5) {
    const who = live.filter((t) => t.frames.some((f) => {
      if (!f) return false;
      const mx = Math.max(...f.bands);
      return f.bands.some((v, k) => C[k] >= ZONES[ci][1] && C[k] < ZONES[ci][2] && v > mx - 6);
    })).map((t) => t.name);
    const zone = ZONES[ci][0].toLowerCase();
    out.push({ title: `The ${zone} ${zone.endsWith('mids') ? 'are' : 'is'} crowded`, body: `On average ${crowd[ci].toFixed(1)} tracks peak in ${fmtRange(ZONES[ci][1], ZONES[ci][2])} at the same time: ${who.slice(0, 5).join(', ')}${who.length > 5 ? '…' : ''}.` });
  }

  const silent = map.tracks.filter((t) => t.silent && !t.muted);
  if (silent.length) {
    const many = silent.length > 1;
    out.push({ title: `${silent.map((t) => t.name).join(', ')} never sound${many ? '' : 's'}`, body: `${many ? 'They have' : 'It has'} clips, but the audio is digital silence. The file may have been exported empty.` });
  }

  let first = -1, last = -1;
  const active = Array.from({ length: map.bars }, (_, b) => live.some((t) => t.frames[b] !== null));
  active.forEach((a, b) => { if (a) { if (first < 0) first = b; last = b; } });
  let run = 0, best = 0, bestStart = 0;
  for (let b = first; b <= last && b >= 0; b++) {
    if (!active[b]) { run++; if (run > best) { best = run; bestStart = b - run + 1; } } else run = 0;
  }
  if (best >= 8) out.push({ title: `Nothing plays from bar ${bestStart + 1} to ${bestStart + best + 1}`, body: `A ${best}-bar gap in the arrangement.` });

  return out.slice(0, 5);
}
