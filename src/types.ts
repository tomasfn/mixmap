export type TrackKind = 'stem' | 'audio' | 'midi' | 'drums';

export interface Frame {
  /** Power per 1/3-octave band, dB relative to full scale. */
  bands: number[];
  /** Ungated K-weighted loudness of the bar, close to LUFS. */
  loud: number;
  /** Side RMS divided by mid RMS. 0 is mono. */
  width: number;
  /** (R − L) / (R + L) energy, −1 is hard left. */
  balance: number;
  /** One value per sixteenth note, 0..1, normalized per track. */
  env: number[];
  /** One 12-bin pitch-class profile per beat. */
  chroma: number[][];
}

export interface TrackMap {
  id: string;
  name: string;
  color: string;
  kind: TrackKind;
  muted: boolean;
  /** True when the track has clips or a stem but never makes a sound. */
  silent: boolean;
  /** One entry per bar; null where the track is quiet. */
  frames: (Frame | null)[];
}

export interface Locator {
  name: string;
  bar: number;
}

export interface MapData {
  format: 'mixmap';
  version: 1;
  name: string;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  bandCenters: number[];
  locators: Locator[];
  tracks: TrackMap[];
  notes: string[];
}

export interface ProjectFile {
  file: File;
  path: string;
}

export interface Progress {
  (message: string, fraction: number): void;
}
