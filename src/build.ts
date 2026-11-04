import { beatToSeconds, contentBeat, parseAls, type AlsSet, type AlsTrack, type AudioClipInfo } from './als.ts';
import { analyzeAudio, estimateMidi, type ArrNote, type Grid, type Stereo, type WindowSource } from './analyze.ts';
import { BAND_CENTERS, SAMPLE_RATE, Spectrum } from './dsp.ts';
import { LIVE_PALETTE, paletteColor } from './palette.ts';
import type { Frame, MapData, ProjectFile, Progress, TrackMap } from './types.ts';

const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i;
const SAMPLE_DIR = /(^|\/)(Samples|Backup|Ableton Project Info)\//i;
const MAX_BARS = 2000;

export interface BuildOptions {
  stemStartBar: number;
  fallbackBpm: number;
  onProgress: Progress;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const normName = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function decodeFile(file: File): Promise<Stereo> {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  return { L, R, sampleRate: buf.sampleRate };
}

function pickAls(files: ProjectFile[]): ProjectFile | null {
  const sets = files.filter((f) => /\.als$/i.test(f.path) && !/(^|\/)Backup\//i.test(f.path));
  if (!sets.length) return null;
  return sets.sort((a, b) => b.file.lastModified - a.file.lastModified)[0];
}

function matchStems(tracks: AlsTrack[], stems: ProjectFile[]): { byTrack: Map<string, ProjectFile>; unmatched: ProjectFile[] } {
  const byTrack = new Map<string, ProjectFile>();
  const score = new Map<string, number>();
  const unmatched: ProjectFile[] = [];
  for (const stem of stems) {
    const sn = ` ${normName(baseName(stem.path))} `;
    let best: AlsTrack | null = null;
    let bestLen = 0;
    for (const t of tracks) {
      const tn = normName(t.name);
      if (!tn || !sn.includes(` ${tn} `)) continue;
      const len = tn.length + (sn.trim() === tn ? 1000 : 0);
      if (len > bestLen) { best = t; bestLen = len; }
    }
    if (!best) { unmatched.push(stem); continue; }
    if (best.type === 'group' || best.type === 'return') continue;
    if ((score.get(best.id) ?? 0) < bestLen) { byTrack.set(best.id, stem); score.set(best.id, bestLen); }
  }
  return { byTrack, unmatched };
}

function stemSource(buf: Stereo, offsetBeats: number, bpm: number): WindowSource {
  return (t0, t1) => {
    const sr = buf.sampleRate;
    const s0 = Math.max(0, Math.round((((t0 - offsetBeats) * 60) / bpm) * sr));
    const s1 = Math.min(buf.L.length, Math.round((((t1 - offsetBeats) * 60) / bpm) * sr));
    return s1 - s0 >= 64 ? { buf, start: s0, len: s1 - s0, shift: 0, gainDb: 0 } : null;
  };
}

function clipSource(track: AlsTrack, decoded: Map<AudioClipInfo, Stereo>, bpm: number): WindowSource {
  const clips = track.clips.filter((c): c is AudioClipInfo => c.kind === 'audio' && decoded.has(c)).sort((a, b) => a.start - b.start);
  return (t0, t1) => {
    let clip: AudioClipInfo | null = null;
    for (const c of clips) if (c.start < t1 && c.end > t0) clip = c;
    if (!clip) return null;
    const buf = decoded.get(clip)!;
    const a = Math.max(t0, clip.start);
    const b = Math.min(t1, clip.end);
    const c0 = contentBeat(clip, a);
    if (c0 === null) return null;
    const limit = clip.loopOn ? clip.loopEnd : Infinity;
    const c1 = Math.min(c0 + (b - a), limit);
    const sr = buf.sampleRate;
    const s0 = Math.max(0, Math.round(beatToSeconds(clip, c0, bpm) * sr));
    const s1 = Math.min(buf.L.length, Math.round(beatToSeconds(clip, c1, bpm) * sr));
    if (s1 - s0 < 64) return null;
    const coverage = (b - a) / (t1 - t0);
    return { buf, start: s0, len: s1 - s0, shift: clip.pitch, gainDb: clip.gainDb + track.volumeDb + 10 * Math.log10(coverage) };
  };
}

function withPan(frames: (Frame | null)[], pan: number): (Frame | null)[] {
  if (!pan) return frames;
  return frames.map((f) => (f ? { ...f, balance: Math.max(-1, Math.min(1, Math.round((f.balance + pan) * 1000) / 1000)) } : null));
}

function lookupSample(index: Map<string, ProjectFile[]>, clip: AudioClipInfo): ProjectFile | null {
  const candidates = index.get(clip.fileName.toLowerCase());
  if (!candidates?.length) return null;
  const rel = clip.relativePath.toLowerCase();
  return candidates.find((c) => rel && c.path.toLowerCase().endsWith(rel)) ?? candidates[0];
}

export async function buildMap(files: ProjectFile[], opts: BuildOptions): Promise<MapData> {
  const progress = opts.onProgress;
  const alsFile = pickAls(files);
  const audio = files.filter((f) => AUDIO_EXT.test(f.path));
  const stems = audio.filter((f) => !SAMPLE_DIR.test(f.path));
  const sampleIndex = new Map<string, ProjectFile[]>();
  for (const f of audio) {
    const k = baseName(f.path).toLowerCase();
    sampleIndex.set(k, [...(sampleIndex.get(k) ?? []), f]);
  }
  if (!alsFile && !stems.length) throw new Error('No Ableton set (.als) or audio stems found in what you dropped.');

  progress('Reading the set', 0.02);
  const set: AlsSet | null = alsFile ? await parseAls(await alsFile.file.arrayBuffer()) : null;
  const bpm = set?.bpm ?? opts.fallbackBpm;
  const beatsPerBar = set?.beatsPerBar ?? 4;
  const tracks = (set?.tracks ?? []).filter((t) => t.type === 'audio' || t.type === 'midi');
  const { byTrack, unmatched } = matchStems(set?.tracks ?? [], stems);
  const stemOffset = (Math.max(1, opts.stemStartBar) - 1) * beatsPerBar;

  const decodedStems = new Map<ProjectFile, Stereo>();
  const stemList = set ? [...byTrack.values()] : stems;
  let maxBeat = 0;
  for (const t of tracks) for (const c of t.clips) maxBeat = Math.max(maxBeat, c.end);
  for (let i = 0; i < stemList.length; i++) {
    progress(`Decoding stem ${i + 1} of ${stemList.length}`, 0.05 + (0.35 * i) / stemList.length);
    try {
      const buf = await decodeFile(stemList[i].file);
      decodedStems.set(stemList[i], buf);
      maxBeat = Math.max(maxBeat, stemOffset + ((buf.L.length / buf.sampleRate) * bpm) / 60);
    } catch {
      unmatched.push(stemList[i]);
    }
  }
  const bars = Math.min(MAX_BARS, Math.max(1, Math.ceil(maxBeat / beatsPerBar - 1e-6)));
  const grid: Grid = { bars, beatsPerBar };
  const spectrum = new Spectrum(4096, SAMPLE_RATE);
  const out: TrackMap[] = [];
  const missing = new Set<string>();
  let fromStems = 0, fromSamples = 0, estimated = 0;

  const silentOf = (frames: (Frame | null)[]) => frames.every((f) => f === null);
  const work = set ? tracks : [];
  for (let i = 0; i < work.length; i++) {
    const t = work[i];
    progress(`Analyzing ${t.name}`, 0.4 + (0.58 * i) / Math.max(1, work.length));
    await new Promise((r) => setTimeout(r, 0));
    const stem = byTrack.get(t.id);
    const stemBuf = stem ? decodedStems.get(stem) : undefined;
    let frames: (Frame | null)[] | null = null;
    let kind: TrackMap['kind'] = t.type === 'audio' ? 'audio' : t.hasDrumRack ? 'drums' : 'midi';
    if (stemBuf) {
      frames = analyzeAudio(stemSource(stemBuf, stemOffset, bpm), grid, spectrum);
      kind = 'stem';
      if (silentOf(frames) && t.muted && t.clips.length) frames = null;
      else fromStems++;
    }
    if (!frames) {
      if (!t.clips.length) continue;
      if (t.type === 'audio') {
        const decoded = new Map<AudioClipInfo, Stereo>();
        const cache = new Map<ProjectFile, Stereo>();
        for (const c of t.clips) {
          if (c.kind !== 'audio') continue;
          const f = lookupSample(sampleIndex, c);
          if (!f) { missing.add(c.fileName); continue; }
          let buf = cache.get(f);
          if (!buf) {
            try { buf = await decodeFile(f.file); cache.set(f, buf); } catch { missing.add(c.fileName); continue; }
          }
          decoded.set(c, buf);
        }
        kind = 'audio';
        frames = withPan(analyzeAudio(clipSource(t, decoded, bpm), grid, spectrum), t.pan);
        fromSamples++;
      } else {
        const notes: ArrNote[] = t.clips.flatMap((c) => (c.kind === 'midi' ? c.notes : []));
        frames = estimateMidi(notes, grid, t.hasDrumRack, t.pan, t.volumeDb);
        estimated++;
      }
    }
    out.push({ id: t.id, name: t.name, color: paletteColor(t.colorIndex), kind, muted: t.muted, silent: silentOf(frames), frames });
  }

  let stemSetName = '';
  if (!set) {
    const names = stems.map((s) => baseName(s.path).replace(AUDIO_EXT, ''));
    const words = names.map((n) => n.split(' '));
    let common = 0;
    while (names.length > 1 && words.every((w) => w.length > common + 1 && w[common] === words[0][common])) common++;
    stemSetName = words[0]?.slice(0, common).join(' ') ?? '';
    stems.forEach((s, i) => {
      const buf = decodedStems.get(s);
      if (!buf) return;
      progress(`Analyzing ${baseName(s.path)}`, 0.4 + (0.58 * i) / stems.length);
      const frames = analyzeAudio(stemSource(buf, stemOffset, bpm), grid, spectrum);
      out.push({ id: `stem-${i}`, name: words[i].slice(common).join(' '), color: LIVE_PALETTE[(i * 7 + 9) % LIVE_PALETTE.length], kind: 'stem', muted: false, silent: silentOf(frames), frames });
      fromStems++;
    });
  }

  const notes: string[] = [];
  if (fromStems) notes.push(`${fromStems} track${fromStems > 1 ? 's' : ''} measured from exported stems${stemOffset ? `, aligned to bar ${opts.stemStartBar}` : ''}.`);
  if (fromSamples) notes.push(`${fromSamples} audio track${fromSamples > 1 ? 's' : ''} measured from their clip samples, with clip gain, transposition, volume and pan. Effects are not included.`);
  if (estimated) notes.push(`${estimated} MIDI track${estimated > 1 ? 's' : ''} estimated from their notes. Level and tone are approximate; export stems to measure them.`);
  if (missing.size) notes.push(`${missing.size} sample${missing.size > 1 ? 's were' : ' was'} not in the folder: ${[...missing].slice(0, 4).join(', ')}${missing.size > 4 ? '…' : ''}. Use File → Collect All and Save to copy them in.`);
  if (set && unmatched.length) notes.push(`${unmatched.length} audio file${unmatched.length > 1 ? 's' : ''} did not match a track name and were skipped: ${unmatched.slice(0, 3).map((u) => baseName(u.path)).join(', ')}${unmatched.length > 3 ? '…' : ''}.`);

  progress('Done', 1);
  return {
    format: 'mixmap',
    version: 1,
    name: alsFile ? baseName(alsFile.path).replace(/\.als$/i, '') : stemSetName || 'Stems',
    bpm: Math.round(bpm * 100) / 100,
    beatsPerBar,
    bars,
    bandCenters: BAND_CENTERS.map((c) => Math.round(c * 10) / 10),
    locators: (set?.locators ?? []).map((l) => ({ name: l.name, bar: Math.round((l.beat / beatsPerBar + 1) * 100) / 100 })),
    tracks: out,
    notes,
  };
}
