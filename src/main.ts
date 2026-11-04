import { buildMap } from './build.ts';
import type { MapData, ProjectFile } from './types.ts';
import { mountViewer } from './viewer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const landing = $('landing');
const viewerRoot = $('viewer');
const drop = $('drop');
const progress = $('progress');
const err = $('err');
let unmount: (() => void) | null = null;
let current: MapData | null = null;

const KEEP = /\.(als|json|wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i;

function showError(message: string) {
  progress.hidden = true;
  err.textContent = message;
  err.hidden = false;
}

function setProgress(message: string, fraction: number) {
  err.hidden = true;
  progress.hidden = false;
  progress.querySelector<HTMLElement>('.msg')!.textContent = message;
  progress.querySelector<HTMLElement>('.bar b')!.style.width = `${Math.round(fraction * 100)}%`;
}

function show(map: MapData, hash = '') {
  current = map;
  history.replaceState(null, '', location.pathname + location.search + hash);
  unmount?.();
  landing.hidden = true;
  viewerRoot.hidden = false;
  document.title = `${map.name} · Mixmap`;
  unmount = mountViewer(viewerRoot, map, { onOpenAnother: reset, onDownload: download });
}

function reset() {
  unmount?.();
  unmount = null;
  current = null;
  viewerRoot.hidden = true;
  landing.hidden = false;
  progress.hidden = true;
  document.title = 'Mixmap';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function download() {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.name.replace(/[^\w\- ]+/g, '').trim() || 'set'}.mixmap.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function isMap(x: unknown): x is MapData {
  return typeof x === 'object' && x !== null && (x as { format?: unknown }).format === 'mixmap' && Array.isArray((x as { tracks?: unknown }).tracks);
}

async function handle(files: ProjectFile[]) {
  const kept = files.filter((f) => KEEP.test(f.path));
  const json = kept.find((f) => /\.json$/i.test(f.path));
  try {
    if (json && !kept.some((f) => /\.als$/i.test(f.path))) {
      const data: unknown = JSON.parse(await json.file.text());
      if (!isMap(data)) throw new Error('That JSON file is not a Mixmap file.');
      show(data);
      return;
    }
    const map = await buildMap(kept, {
      stemStartBar: Number($<HTMLInputElement>('stem-bar').value) || 1,
      fallbackBpm: Number($<HTMLInputElement>('bpm').value) || 120,
      onProgress: setProgress,
    });
    if (!map.tracks.length) throw new Error('No tracks with clips or stems were found.');
    show(map);
  } catch (e) {
    showError(e instanceof Error ? e.message : 'Something went wrong while reading the project.');
  }
}

async function walk(entry: FileSystemEntry, prefix: string, out: ProjectFile[]): Promise<void> {
  if (entry.isFile) {
    if (!KEEP.test(entry.name)) return;
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path: prefix + entry.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await walk(e, `${prefix}${entry.name}/`, out);
  }
}

async function fromDataTransfer(dt: DataTransfer): Promise<ProjectFile[]> {
  const entries = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.() ?? null).filter((e): e is FileSystemEntry => e !== null);
  if (!entries.length) return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  const out: ProjectFile[] = [];
  for (const e of entries) await walk(e, '', out);
  return out;
}

const fromInput = (input: HTMLInputElement): ProjectFile[] => Array.from(input.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer) await handle(await fromDataTransfer(e.dataTransfer));
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

for (const id of ['pick-folder', 'pick-files']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', async () => { await handle(fromInput(input)); input.value = ''; });
}

async function loadDemo() {
  setProgress('Loading the demo', 0.3);
  try {
    const res = await fetch('./demo.mixmap.json');
    const data: unknown = await res.json();
    if (!isMap(data)) throw new Error('The demo file is missing.');
    show(data, '#demo');
  } catch (e) {
    showError(e instanceof Error ? e.message : 'Could not load the demo.');
  }
}
$('demo').addEventListener('click', loadDemo);
if (location.hash === '#demo') void loadDemo();

if (import.meta.env.DEV) {
  (window as unknown as { mixmapLoadUrls: (urls: string[], root: string) => Promise<void> }).mixmapLoadUrls = async (urls, root) => {
    const files: ProjectFile[] = [];
    for (const u of urls) {
      const blob = await (await fetch(u)).blob();
      const path = decodeURIComponent(u.slice(u.indexOf(root)));
      files.push({ file: new File([blob], path.split('/').pop()!, { lastModified: Date.now() }), path });
    }
    await handle(files);
  };
}
