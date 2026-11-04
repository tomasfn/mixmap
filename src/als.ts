import type { ArrNote } from './analyze.ts';

export interface ClipLoop {
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  startRelative: number;
  loopOn: boolean;
}

export interface AudioClipInfo extends ClipLoop {
  kind: 'audio';
  fileName: string;
  relativePath: string;
  absolutePath: string;
  pitch: number;
  gainDb: number;
  warped: boolean;
  warpMarkers: [number, number][];
}

export interface MidiClipInfo extends ClipLoop {
  kind: 'midi';
  notes: ArrNote[];
}

export type TrackType = 'audio' | 'midi' | 'group' | 'return';

export interface AlsTrack {
  id: string;
  type: TrackType;
  name: string;
  colorIndex: number;
  muted: boolean;
  volumeDb: number;
  pan: number;
  hasDrumRack: boolean;
  clips: (AudioClipInfo | MidiClipInfo)[];
}

export interface AlsSet {
  bpm: number;
  beatsPerBar: number;
  tracks: AlsTrack[];
  locators: { name: string; beat: number }[];
  creator: string;
}

function kid(el: Element | null, path: string): Element | null {
  let cur = el;
  for (const tag of path.split('/')) {
    if (!cur) return null;
    let next: Element | null = null;
    for (const c of Array.from(cur.children)) if (c.tagName === tag) { next = c; break; }
    cur = next;
  }
  return cur;
}

function kids(el: Element | null, path: string, tag: string): Element[] {
  const parent = kid(el, path);
  return parent ? Array.from(parent.children).filter((c) => c.tagName === tag) : [];
}

function val(el: Element | null, path: string): string | null {
  const k = kid(el, path);
  return k ? k.getAttribute('Value') : null;
}

function num(el: Element | null, path: string, fallback = 0): number {
  const v = val(el, path);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function inflate(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

function readLoop(clip: Element): ClipLoop {
  const start = Number(clip.getAttribute('Time') ?? num(clip, 'CurrentStart'));
  return {
    start,
    end: num(clip, 'CurrentEnd', start),
    loopStart: num(clip, 'Loop/LoopStart'),
    loopEnd: num(clip, 'Loop/LoopEnd'),
    startRelative: num(clip, 'Loop/StartRelative'),
    loopOn: val(clip, 'Loop/LoopOn') === 'true',
  };
}

/** Content position (in clip beats) heard at arrangement beat t, or null after a non-looping clip runs out. */
export function contentBeat(c: ClipLoop, t: number): number | null {
  if (t < c.start || t >= c.end) return null;
  const len = c.loopEnd - c.loopStart;
  if (c.loopOn && len > 0) {
    const first = c.loopStart + c.startRelative;
    const pos = first + (t - c.start);
    return pos < c.loopEnd ? pos : c.loopStart + ((pos - c.loopStart) % len);
  }
  return c.loopStart + (t - c.start);
}

function unrollNotes(c: ClipLoop, notes: ArrNote[]): ArrNote[] {
  const out: ArrNote[] = [];
  const len = c.loopEnd - c.loopStart;
  if (c.loopOn && len > 0) {
    const first = c.loopStart + c.startRelative;
    for (const n of notes) {
      if (n.t < c.loopStart || n.t >= c.loopEnd) continue;
      const offset = (((n.t - first) % len) + len) % len;
      for (let at = c.start + offset; at < c.end; at += len) out.push({ t: at, d: Math.min(n.d, c.end - at), v: n.v, p: n.p });
    }
  } else {
    for (const n of notes) {
      if (n.t < c.loopStart) continue;
      const at = c.start + (n.t - c.loopStart);
      if (at < c.end) out.push({ t: at, d: Math.min(n.d, c.end - at), v: n.v, p: n.p });
    }
  }
  return out;
}

function readNotes(clip: Element): ArrNote[] {
  const out: ArrNote[] = [];
  for (const kt of kids(clip, 'Notes/KeyTracks', 'KeyTrack')) {
    const p = num(kt, 'MidiKey');
    for (const ev of kids(kt, 'Notes', 'MidiNoteEvent')) {
      if (ev.getAttribute('IsEnabled') === 'false') continue;
      out.push({ t: Number(ev.getAttribute('Time')), d: Number(ev.getAttribute('Duration')), v: Number(ev.getAttribute('Velocity')), p });
    }
  }
  return out;
}

function readAudioClip(clip: Element): AudioClipInfo {
  const rel = val(clip, 'SampleRef/FileRef/RelativePath') ?? '';
  const abs = val(clip, 'SampleRef/FileRef/Path') ?? '';
  const name = (abs || rel).split(/[\\/]/).pop() ?? '';
  const markers = kids(clip, 'WarpMarkers', 'WarpMarker').map((m): [number, number] => [Number(m.getAttribute('SecTime')), Number(m.getAttribute('BeatTime'))]);
  const vol = num(clip, 'SampleVolume', 1);
  return {
    kind: 'audio',
    ...readLoop(clip),
    fileName: name,
    relativePath: rel,
    absolutePath: abs,
    pitch: num(clip, 'PitchCoarse') + num(clip, 'PitchFine') / 100,
    gainDb: 20 * Math.log10(Math.max(vol, 1e-6)),
    warped: val(clip, 'IsWarped') !== 'false',
    warpMarkers: markers.sort((a, b) => a[1] - b[1]),
  };
}

const TRACK_TYPES: Record<string, TrackType> = { AudioTrack: 'audio', MidiTrack: 'midi', GroupTrack: 'group', ReturnTrack: 'return' };

export async function parseAls(buf: ArrayBuffer): Promise<AlsSet> {
  const xml = await inflate(buf);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This .als file could not be read.');
  const root = doc.documentElement;
  const live = kid(root, 'LiveSet');
  if (!live) throw new Error('This file does not look like an Ableton Live set.');
  const main = kid(live, 'MainTrack') ?? kid(live, 'MasterTrack');
  const bpm = num(main, 'DeviceChain/Mixer/Tempo/Manual', 120);
  const ts = num(main, 'DeviceChain/Mixer/TimeSignature/Manual', 201);
  const numerator = (ts % 99) + 1;
  const denominator = 2 ** Math.floor(ts / 99);
  const tracks: AlsTrack[] = [];
  const tracksEl = kid(live, 'Tracks');
  for (const t of tracksEl ? Array.from(tracksEl.children) : []) {
    const type = TRACK_TYPES[t.tagName];
    if (!type) continue;
    const name = val(t, 'Name/EffectiveName') || val(t, 'Name/UserName') || t.tagName;
    const mixer = kid(t, 'DeviceChain/Mixer');
    const clips: (AudioClipInfo | MidiClipInfo)[] = [];
    if (type === 'audio') {
      for (const c of kids(t, 'DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events', 'AudioClip')) {
        if (val(c, 'Disabled') === 'true') continue;
        clips.push(readAudioClip(c));
      }
    } else if (type === 'midi') {
      for (const c of kids(t, 'DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events', 'MidiClip')) {
        if (val(c, 'Disabled') === 'true') continue;
        const loop = readLoop(c);
        clips.push({ kind: 'midi', ...loop, notes: unrollNotes(loop, readNotes(c)) });
      }
    }
    const chain = kid(t, 'DeviceChain');
    tracks.push({
      id: t.getAttribute('Id') ?? String(tracks.length),
      type,
      name,
      colorIndex: num(t, 'Color', 0),
      muted: val(mixer, 'Speaker/Manual') === 'false',
      volumeDb: 20 * Math.log10(Math.max(num(mixer, 'Volume/Manual', 1), 1e-6)),
      pan: num(mixer, 'Pan/Manual', 0),
      hasDrumRack: chain ? chain.getElementsByTagName('DrumGroupDevice').length > 0 : false,
      clips,
    });
  }
  const locators = kids(live, 'Locators/Locators', 'Locator').map((l) => ({ name: val(l, 'Name') ?? 'Locator', beat: num(l, 'Time') }));
  return { bpm, beatsPerBar: (numerator * 4) / denominator, tracks, locators, creator: root.getAttribute('Creator') ?? 'Ableton Live' };
}

/** Maps a content beat of a warped clip to a position in the sample, in seconds. */
export function beatToSeconds(clip: AudioClipInfo, beat: number, bpm: number): number {
  const m = clip.warpMarkers;
  if (!clip.warped || m.length === 0) return (beat * 60) / bpm;
  if (m.length === 1) return m[0][0] + ((beat - m[0][1]) * 60) / bpm;
  let i = 0;
  while (i < m.length - 2 && beat > m[i + 1][1]) i++;
  const [s0, b0] = m[i];
  const [s1, b1] = m[i + 1];
  const slope = b1 !== b0 ? (s1 - s0) / (b1 - b0) : 60 / bpm;
  return s0 + (beat - b0) * slope;
}
