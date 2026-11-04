import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZONES, computeInsights, fmtHz, fmtRange } from './insights.ts';
import type { Frame, MapData, TrackMap } from './types.ts';

export interface ViewerActions {
  onOpenAnother: () => void;
  onDownload: () => void;
}

interface PFrame extends Frame {
  lin: number[];
  tot: number;
  p10: number;
  p90: number;
  centroid: number;
  barColor: THREE.Color;
  beatColors: THREE.Color[];
}

interface Shape { x: number; y: number; z: number; rx: number; ry: number; rz: number; op: number }

interface VTrack {
  t: TrackMap;
  frames: (PFrame | null)[];
  short: string;
  liveColor: THREE.Color;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  wire: THREE.LineSegments;
  core: THREE.Mesh;
  label: HTMLDivElement;
  dot: HTMLElement;
  cur: Shape;
  tgt: Shape;
}

interface Clash { a: VTrack; b: VTrack; score: number; weight: number; fLo: number; fHi: number; dl: number }

const YH = 10, FMIN = 20, FMAX = 20000, XW = 6, ZB = -5.6, ZF = 5.4;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const yOf = (f: number) => clamp((Math.log2(f / FMIN) / Math.log2(FMAX / FMIN)) * YH, 0, YH);
const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const KIND_LABEL: Record<TrackMap['kind'], string> = { stem: 'measured · stem', audio: 'measured · samples', midi: 'estimated · MIDI', drums: 'estimated · drums' };

function chromaColor(ch: number[], centroid: number): THREE.Color {
  let x = 0, y = 0, s = 0;
  for (let k = 0; k < 12; k++) {
    const a = (((k * 7) % 12) / 12) * Math.PI * 2;
    x += ch[k] * Math.cos(a);
    y += ch[k] * Math.sin(a);
    s += ch[k];
  }
  const c = new THREE.Color();
  if (s <= 1e-6) return c.setHSL(0.62, 0.06, 0.55);
  const r = Math.hypot(x, y) / s;
  let h = Math.atan2(y, x) / (Math.PI * 2);
  if (h < 0) h += 1;
  const l = 0.42 + 0.22 * clamp(Math.log2(Math.max(centroid, 40) / 40) / Math.log2(100), 0, 1);
  return c.setHSL(h, 0.22 + 0.72 * clamp(r * 1.5, 0, 1), l);
}

function prepFrame(f: Frame, C: number[]): PFrame {
  const lin = f.bands.map((db) => 10 ** (db / 10));
  const tot = lin.reduce((a, b) => a + b, 0);
  let cum = 0, p10 = C[0], p90 = C[C.length - 1], lc = 0;
  let got10 = false, got90 = false;
  for (let k = 0; k < C.length; k++) {
    const w = lin[k] / tot;
    lc += w * Math.log2(C[k]);
    const prev = cum;
    cum += w;
    if (!got10 && cum >= 0.1) { p10 = C[Math.max(0, k - 1)] * (C[k] / C[Math.max(0, k - 1)]) ** ((0.1 - prev) / Math.max(1e-9, w)); got10 = true; }
    if (!got90 && cum >= 0.9) { p90 = C[Math.max(0, k - 1)] * (C[k] / C[Math.max(0, k - 1)]) ** ((0.9 - prev) / Math.max(1e-9, w)); got90 = true; }
  }
  const centroid = 2 ** lc;
  const sum = new Array<number>(12).fill(0);
  f.chroma.forEach((c) => c.forEach((v, i) => (sum[i] += v)));
  return { ...f, lin, tot, p10, p90, centroid, barColor: chromaColor(sum, centroid), beatColors: f.chroma.map((c) => chromaColor(c, centroid)) };
}

const hex = (c: THREE.Color) => `#${c.getHexString()}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);

const VERT = 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const FRAG = 'uniform vec3 uColor; uniform float uOpacity; uniform float uPulse; uniform float uSel; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float rim = pow(f, 2.1); float a = (0.09 + 0.22 * uPulse + rim * (0.5 + 0.5 * uPulse)) * uOpacity; vec3 c = uColor * (0.6 + 0.85 * uPulse) + vec3(rim * 0.25 * uSel); gl_FragColor = vec4(c, a); }';

export function mountViewer(root: HTMLElement, map: MapData, actions: ViewerActions): () => void {
  const C = map.bandCenters;
  const NB = C.length;
  const bpb = map.beatsPerBar;
  const END = map.bars * bpb;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(document.documentElement);
  const tok = (n: string) => css.getPropertyValue(n).trim();
  const tsLabel = Number.isInteger(bpb) ? `${bpb}/4` : `${bpb * 2}/8`;

  root.innerHTML = `
  <div class="app">
    <header class="vhead">
      <div class="ttl">
        <a class="eyebrow brand" href="./" data-new>Mixmap</a>
        <h1>${esc(map.name)}</h1>
        <div class="meta">${map.bpm} BPM · ${tsLabel} · ${map.tracks.length} tracks · ${map.bars} bars</div>
      </div>
      <div class="ctrls">
        <div class="seg" role="group" aria-label="Color mode">
          <button data-mode="sin" aria-pressed="true">Synesthesia</button>
          <button data-mode="live" aria-pressed="false">Live colors</button>
        </div>
        <button class="btn" data-act="mute" aria-pressed="true">Show muted</button>
        <button class="btn" data-act="view">Reset view</button>
        <button class="btn" data-act="download">Save map file</button>
        <button class="btn primary" data-act="new">Open another set</button>
      </div>
    </header>
    <div class="scene">
      <div class="labels"></div>
      <div class="hint">drag to orbit · scroll to zoom</div>
      <div class="legend"><b>Height</b> = frequency · <b>Width</b> = stereo · <b>Front</b> = louder · <b>Amber</b> = clash</div>
      <div class="tip" hidden></div>
    </div>
    <div class="time">
      <div class="tbar">
        <button class="play" aria-label="Play"><svg viewBox="0 0 14 14"><path d="M3 1.5v11l9-5.5z"/></svg></button>
        <div class="pos">1|1</div>
        <div class="jumps"></div>
      </div>
      <div class="tl"><canvas aria-label="Arrangement. Click or drag to move through the song."></canvas></div>
    </div>
    <aside>
      <section class="sec"><h2>Track <em data-el="sel-src"></em></h2><div data-el="sel"></div></section>
      <section class="sec">
        <h2>Clashes in this bar <em data-el="clash-n"></em></h2>
        <div class="clash" data-el="clash"></div>
        <div><div class="eyebrow" style="margin-bottom:6px">Nearly empty zones</div><div class="gaps" data-el="gaps"></div></div>
      </section>
      <section class="sec"><h2>Tracks <em data-el="now-n"></em></h2><div class="rows" data-el="rows"></div></section>
      <section class="sec" data-el="wheel-sec">
        <h2>How color works</h2>
        <div class="wheel"><svg viewBox="-50 -50 100 100" data-el="wheel" aria-label="Color wheel following the circle of fifths"></svg>
        <p>Color comes from the notes, arranged on the circle of fifths with C as red, like Scriabin's color wheel. Related keys get neighboring colors. Saturation shows how tonal a sound is, brightness how bright it sounds. Colors change beat by beat.</p></div>
      </section>
      <section class="sec"><h2>What the map shows</h2><ol class="read" data-el="insights"></ol></section>
      <section class="sec"><h2>How this map was made</h2><ul class="foot" data-el="notes"></ul></section>
    </aside>
  </div>`;

  const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const el = (name: string) => q<HTMLElement>(`[data-el="${name}"]`);
  const sceneEl = q<HTMLDivElement>('.scene');
  const labelsEl = q<HTMLDivElement>('.labels');
  const tip = q<HTMLDivElement>('.tip');
  const posEl = q<HTMLDivElement>('.pos');
  const playBtn = q<HTMLButtonElement>('.play');
  const tl = q<HTMLDivElement>('.tl');
  const tlc = q<HTMLCanvasElement>('.tl canvas');
  const tg = tlc.getContext('2d')!;

  const insights = computeInsights(map);
  el('insights').innerHTML = insights.length ? insights.map((i) => `<li><b>${esc(i.title)}.</b> ${esc(i.body)}</li>`).join('') : '<li>Nothing stands out. The tracks share the space well.</li>';
  el('notes').innerHTML = map.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  const state = { b: 0, playing: false, mode: 'sin' as 'sin' | 'live', showMute: true, sel: null as VTrack | null, hover: null as VTrack | null, hlPair: null as number | null, key: '', nowCount: 0 };

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(tok('--scene')), 1);
  sceneEl.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
  const HOME = { pos: new THREE.Vector3(10.9, 7.0, 14.2), target: new THREE.Vector3(0.8, 4.5, -0.4) };
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 34;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.update();

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const gridCol = new THREE.Color(tok('--grid'));
  const matGrid = new THREE.LineBasicMaterial({ color: gridCol });
  const matFaint = new THREE.LineBasicMaterial({ color: gridCol, transparent: true, opacity: 0.45 });
  const line = (pts: THREE.Vector3[], mat: THREE.Material) => scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  const stripeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tok('--stripe')), side: THREE.DoubleSide });
  ZONES.forEach(([, lo, hi], i) => {
    if (i % 2) return;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * XW, yOf(hi) - yOf(lo)), stripeMat);
    m.position.set(0, (yOf(lo) + yOf(hi)) / 2, ZB - 0.02);
    scene.add(m);
  });
  line([V(-XW, 0, ZB), V(XW, 0, ZB), V(XW, YH, ZB), V(-XW, YH, ZB), V(-XW, 0, ZB)], matGrid);
  line([V(-XW, 0, ZB), V(-XW, 0, ZF), V(XW, 0, ZF), V(XW, 0, ZB)], matGrid);
  const TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  TICKS.forEach((f) => { line([V(-XW, yOf(f), ZB), V(XW, yOf(f), ZB)], matFaint); line([V(-XW, yOf(f), ZB), V(-XW, yOf(f), ZB + 2.2)], matFaint); });
  for (let x = -XW + 3; x < XW; x += 3) line([V(x, 0, ZB), V(x, 0, ZF)], matFaint);
  for (let z = ZB + 2.75; z < ZF; z += 2.75) line([V(-XW, 0, z), V(XW, 0, z)], matFaint);
  line([V(0, 0, ZB), V(0, YH, ZB)], matFaint);

  interface Label { el: HTMLDivElement; pos: THREE.Vector3; right: boolean }
  const labels: Label[] = [];
  const addLabel = (text: string, pos: THREE.Vector3, cls: string, right = false) => {
    const d = document.createElement('div');
    d.className = `lb ${cls}`;
    d.textContent = text;
    labelsEl.appendChild(d);
    labels.push({ el: d, pos, right });
  };
  TICKS.forEach((f) => addLabel(fmtHz(f), V(-XW - 0.25, yOf(f), ZB), 'axis', true));
  ZONES.forEach(([n, lo, hi]) => addLabel(n.toUpperCase(), V(XW + 0.3, (yOf(lo) + yOf(hi)) / 2, ZB), 'zone'));
  addLabel('LEFT', V(-XW + 0.4, 0, ZF + 0.5), 'zone');
  addLabel('CENTER', V(-0.5, 0, ZF + 0.5), 'zone');
  addLabel('RIGHT', V(XW - 0.9, 0, ZF + 0.5), 'zone');

  const sphereGeo = new THREE.SphereGeometry(1, 56, 36);
  const wireGeo = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 18, 12));
  const coreGeo = new THREE.SphereGeometry(1, 20, 14);

  const tracks: VTrack[] = map.tracks.map((t) => {
    const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uPulse: { value: 0 }, uSel: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(sphereGeo, mat);
    const wire = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    core.scale.setScalar(0.16);
    mesh.add(wire, core);
    mesh.visible = false;
    scene.add(mesh);
    const label = document.createElement('div');
    label.className = 'lb trk';
    label.innerHTML = '<i></i><span></span>';
    label.querySelector('span')!.textContent = t.name;
    labelsEl.appendChild(label);
    const vt: VTrack = { t, frames: t.frames.map((f) => (f ? prepFrame(f, C) : null)), short: t.name, liveColor: new THREE.Color(t.color), mesh, mat, wire, core, label, dot: label.querySelector('i')!, cur: { x: 0, y: 5, z: 0, rx: 0.5, ry: 0.5, rz: 0.5, op: 0 }, tgt: { x: 0, y: 5, z: 0, rx: 0.5, ry: 0.5, rz: 0.5, op: 0 } };
    mesh.userData.vt = vt;
    return vt;
  });

  const ringGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => V(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2))));
  const rings = Array.from({ length: NB }, () => {
    const l = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
    l.visible = false;
    scene.add(l);
    return l;
  });
  const warn = new THREE.Color(tok('--warn'));
  const slabs = Array.from({ length: 4 }, () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: warn, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: warn, transparent: true, opacity: 0.5, depthWrite: false }));
    box.add(edges);
    box.visible = false;
    scene.add(box);
    return { box, edges };
  });

  const barOf = (b: number) => clamp(Math.floor(b / bpb), 0, map.bars - 1);
  const frameAt = (vt: VTrack, b: number) => vt.frames[barOf(b)] ?? null;
  const shown = (vt: VTrack) => !vt.t.muted || state.showMute;
  const fmtPos = (b: number) => `${barOf(b) + 1}|${Math.floor(b - barOf(b) * bpb) + 1}`;

  function target(f: PFrame): Omit<Shape, 'op'> {
    const lo = clamp((f.loud + 50) / 35, 0, 1);
    const y0 = yOf(f.p10), y1 = yOf(f.p90);
    return { x: clamp(f.balance * 1.6, -1, 1) * 4.6, y: (y0 + y1) / 2, z: lo * 9 - 4.6, rx: Math.min(4.6, 0.32 + f.width * 2.6), ry: Math.max(0.28, (y1 - y0) / 2 + 0.12), rz: 0.42 + lo * 0.95 };
  }

  function pulseOf(f: PFrame, b: number): number {
    const steps = f.env.length;
    const pos = ((b - barOf(b) * bpb) / bpb) * steps;
    const i = clamp(Math.floor(pos), 0, steps - 1);
    const fr = pos - i;
    return f.env[i] * (1 - fr) + (f.env[Math.min(steps - 1, i + 1)] ?? 0) * fr;
  }

  function colorOf(vt: VTrack, f: PFrame | null, b: number): THREE.Color {
    if (state.mode === 'live' || !f) return vt.liveColor;
    const beat = clamp(Math.floor(b - barOf(b) * bpb), 0, f.beatColors.length - 1);
    const ch = f.chroma[beat];
    return ch && ch.some((v) => v > 0) ? f.beatColors[beat] : f.barColor;
  }

  function clashesAt(b: number): Clash[] {
    const act = tracks.filter((vt) => !vt.t.muted).map((vt) => [vt, frameAt(vt, b)] as const).filter((p): p is readonly [VTrack, PFrame] => p[1] !== null);
    const out: Clash[] = [];
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const [ta, fa] = act[i], [tb, fb] = act[j];
      const m = new Array<number>(NB);
      let sh = 0, mx = 0;
      for (let k = 0; k < NB; k++) { m[k] = Math.min(fa.lin[k], fb.lin[k]); sh += m[k]; mx = Math.max(mx, m[k]); }
      const score = sh / Math.min(fa.tot, fb.tot);
      const weight = score * clamp((10 * Math.log10(sh + 1e-30) + 62) / 34, 0, 1);
      if (score < 0.3 || weight < 0.12) continue;
      let lo = -1, hi = -1;
      for (let k = 0; k < NB; k++) if (m[k] >= mx * 0.22) { if (lo < 0) lo = k; hi = k; }
      out.push({ a: ta, b: tb, score, weight, fLo: C[lo] / 2 ** (1 / 6), fHi: C[hi] * 2 ** (1 / 6), dl: 10 * Math.log10(fa.tot / fb.tot) });
    }
    return out.sort((x, y) => y.weight - x.weight).slice(0, 4);
  }

  function gapsAt(b: number): string[] | null {
    const tot = new Array<number>(NB).fill(0);
    let any = false;
    tracks.forEach((vt) => { if (vt.t.muted) return; const f = frameAt(vt, b); if (f) { any = true; for (let k = 0; k < NB; k++) tot[k] += f.lin[k]; } });
    if (!any) return null;
    const dens = ZONES.map(([, lo, hi]) => { let e = 0; for (let k = 0; k < NB; k++) if (C[k] >= lo && C[k] < hi) e += tot[k]; return 10 * Math.log10(e / Math.log2(hi / lo) + 1e-30); });
    const mx = Math.max(...dens);
    return ZONES.filter((_, i) => dens[i] < mx - 22).map(([n, lo, hi]) => `${n} (${fmtRange(lo, hi)})`);
  }

  let clashes: Clash[] = [];

  function renderRows() {
    const b = state.b;
    const list = tracks.map((vt) => ({ vt, f: frameAt(vt, b) }));
    list.sort((A, B) => (Number(!!B.f && !B.vt.t.muted) - Number(!!A.f && !A.vt.t.muted)) || ((B.f?.loud ?? -200) - (A.f?.loud ?? -200)));
    state.nowCount = list.filter((x) => x.f && !x.vt.t.muted).length;
    const rows = el('rows');
    rows.innerHTML = '';
    for (const { vt, f } of list) {
      const any = f ?? vt.frames.find((x) => x) ?? null;
      const btn = document.createElement('button');
      btn.className = `trow${f && !vt.t.muted ? '' : ' off'}`;
      btn.setAttribute('aria-current', String(state.sel === vt));
      const col = hex(any ? colorOf(vt, any, b) : vt.liveColor);
      let badges = '';
      if (vt.t.muted) badges += '<span class="badge">muted</span>';
      if (vt.t.silent) badges += '<span class="badge w">silent</span>';
      else if (vt.t.kind === 'midi' || vt.t.kind === 'drums') badges += '<span class="badge">estimated</span>';
      const lv = any ? clamp((any.loud + 55) / 40, 0.03, 1) : 0;
      btn.innerHTML = `<span class="sw" style="background:${col}"></span><span class="nm">${esc(vt.short)}${badges}</span><span class="rg">${any ? fmtRange(any.p10, any.p90) : '—'}</span><span class="lv"><b style="width:${(lv * 100).toFixed(0)}%;background:${col}"></b></span>`;
      btn.addEventListener('click', () => select(state.sel === vt ? null : vt));
      rows.appendChild(btn);
    }
  }

  function renderClashes() {
    const box = el('clash');
    box.innerHTML = '';
    el('clash-n').textContent = clashes.length ? String(clashes.length) : '';
    if (!clashes.length) box.innerHTML = '<div class="empty">Nothing collides strongly in this bar.</div>';
    clashes.forEach((c, i) => {
      const est = [c.a, c.b].some((v) => v.t.kind === 'midi' || v.t.kind === 'drums');
      const louder = c.dl >= 0 ? c.a : c.b, quieter = c.dl >= 0 ? c.b : c.a;
      const verb = Math.abs(c.dl) > 6 && !est ? `${louder.short} masks ${quieter.short}` : `${c.a.short} and ${c.b.short} overlap`;
      const d = document.createElement('div');
      d.className = 'cl';
      d.innerHTML = `<div class="who">${esc(verb)}</div><div class="wh">${fmtRange(c.fLo, c.fHi)} · ${Math.round(c.score * 100)}% shared energy${est ? ' · estimated level' : ''}</div>`;
      d.addEventListener('mouseenter', () => (state.hlPair = i));
      d.addEventListener('mouseleave', () => (state.hlPair = null));
      box.appendChild(d);
    });
    const g = gapsAt(state.b), gb = el('gaps');
    gb.innerHTML = g === null ? '<span class="empty">Nothing plays in this bar.</span>' : g.length ? g.map((z) => `<span class="gap">${esc(z)}</span>`).join('') : '<span class="empty">None.</span>';
  }

  function topNotes(f: PFrame): string {
    const sum = new Array<number>(12).fill(0);
    f.chroma.forEach((c) => c.forEach((v, i) => (sum[i] += v)));
    const s = sum.reduce((a, b) => a + b, 0);
    if (s <= 0) return '—';
    return sum.map((v, i) => [v / s, i] as const).filter((p) => p[0] > 0.12).sort((a, b) => b[0] - a[0]).slice(0, 3).map((p) => NOTE_NAMES[p[1]]).join(' · ') || '—';
  }

  function renderSel() {
    const box = el('sel');
    const vt = state.sel;
    if (!vt) { el('sel-src').textContent = ''; box.innerHTML = '<div class="empty">Click a shape in the scene or a track in the list to see its spectrum.</div>'; return; }
    el('sel-src').textContent = KIND_LABEL[vt.t.kind];
    const here = frameAt(vt, state.b);
    const f = here ?? vt.frames.find((x) => x) ?? null;
    const name = `<div class="sel-name"><i style="background:${hex(colorOf(vt, f, state.b))}"></i><span>${esc(vt.t.name)}</span></div>`;
    if (!f) { box.innerHTML = `${name}<div class="note">${vt.t.silent ? 'This track never makes a sound. Its audio is digital silence.' : 'No audio for this track.'}</div>`; return; }
    const w = f.width < 0.15 ? 'nearly mono' : f.width < 0.45 ? 'a little wide' : 'wide';
    const side = Math.abs(f.balance) < 0.08 ? 'center' : f.balance < 0 ? `${Math.round(-f.balance * 100)}% left` : `${Math.round(f.balance * 100)}% right`;
    box.innerHTML = `<div class="selbox">${name}
      <dl class="stats">
        <dt>Range</dt><dd>${fmtRange(f.p10, f.p90)}</dd>
        <dt>Center</dt><dd>${fmtHz(f.centroid)}</dd>
        <dt>Stereo</dt><dd>${w} (${f.width.toFixed(2)}), ${side}</dd>
        <dt>Level</dt><dd>${Math.round(f.loud)} LUFS${vt.t.kind === 'midi' || vt.t.kind === 'drums' ? ' (approx.)' : ''}</dd>
        <dt>Notes</dt><dd>${topNotes(f)}</dd>
        <dt>Bar</dt><dd>${here ? fmtPos(state.b) : `not playing at ${fmtPos(state.b)}`}</dd>
      </dl>
      <canvas class="spec"></canvas>
      <div class="speclegend"><span><i style="background:${hex(colorOf(vt, f, state.b))}"></i>this track</span><span><i style="background:var(--faint)"></i>whole mix</span></div></div>`;
    drawSpec(vt, f);
  }

  function drawSpec(vt: VTrack, f: PFrame) {
    const cv = root.querySelector<HTMLCanvasElement>('.spec');
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    const mix = new Array<number>(NB).fill(0);
    tracks.forEach((x) => { if (x.t.muted) return; const ff = frameAt(x, state.b); if (ff) for (let k = 0; k < NB; k++) mix[k] += ff.lin[k]; });
    const mixDb = mix.map((v) => 10 * Math.log10(v + 1e-30)), selDb = f.lin.map((v) => 10 * Math.log10(v + 1e-30));
    const top = Math.max(...mixDb, ...selDb) + 3, bot = top - 60;
    const X = (k: number) => 26 + (k / (NB - 1)) * (W - 30);
    const Y = (db: number) => clamp((top - db) / (top - bot), 0, 1) * (H - 16) + 2;
    g.font = '10px "IBM Plex Mono", monospace';
    g.fillStyle = tok('--faint');
    g.strokeStyle = tok('--line');
    [50, 200, 1000, 5000].forEach((fr) => {
      const x = X(Math.log2(fr / C[0]) * 3);
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x, H - 14); g.stroke();
      g.fillText(fr >= 1000 ? `${fr / 1000}k` : String(fr), x - 8, H - 3);
    });
    const area = (arr: number[], fill: string, stroke: string) => {
      g.beginPath(); g.moveTo(X(0), H - 14);
      arr.forEach((v, k) => g.lineTo(X(k), Y(v)));
      g.lineTo(X(NB - 1), H - 14); g.closePath(); g.fillStyle = fill; g.fill();
      g.beginPath(); arr.forEach((v, k) => (k ? g.lineTo(X(k), Y(v)) : g.moveTo(X(k), Y(v)))); g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke();
    };
    area(mixDb, 'rgba(91,97,118,.22)', tok('--faint'));
    const c = colorOf(vt, f, state.b);
    area(selDb, `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},.28)`, hex(c));
  }

  function select(vt: VTrack | null) { state.sel = vt; renderSel(); renderRows(); }
  function refreshPanel() { clashes = clashesAt(state.b); renderRows(); renderClashes(); renderSel(); }

  // Timeline
  const GUT = 96;
  const beatToX = (b: number, W: number) => GUT + (b / END) * (W - GUT - 8);
  const xToBeat = (x: number, W: number) => clamp(((x - GUT) / (W - GUT - 8)) * END, 0, END - 0.01);
  function drawTimeline() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = tl.clientWidth, H = tl.clientHeight;
    if (tlc.width !== Math.round(W * dpr) || tlc.height !== Math.round(H * dpr)) { tlc.width = Math.round(W * dpr); tlc.height = Math.round(H * dpr); }
    tg.setTransform(dpr, 0, 0, dpr, 0, 0);
    tg.clearRect(0, 0, W, H);
    const top = 16, rh = (H - top - 4) / Math.max(1, tracks.length);
    tg.font = '10px "IBM Plex Mono", monospace';
    const every = map.bars > 160 ? 16 : map.bars > 64 ? 8 : 4;
    const locX = map.locators.map((l) => beatToX((l.bar - 1) * bpb, W));
    for (let bar = 0; bar <= map.bars; bar += every) {
      const x = beatToX(bar * bpb, W);
      tg.fillStyle = tok('--line'); tg.fillRect(x, top - 2, 1, H - top);
      if (locX.some((lx) => x > lx - 18 && x < lx + 56)) continue;
      tg.fillStyle = tok('--faint'); tg.fillText(String(bar + 1), x + 2, 11);
    }
    map.locators.forEach((l) => { const x = beatToX((l.bar - 1) * bpb, W); tg.fillStyle = tok('--accent'); tg.fillRect(x, 0, 1, H); tg.fillText(l.name, x + 3, 11); });
    const barW = (W - GUT - 8) / map.bars;
    tracks.forEach((vt, i) => {
      const y = top + i * rh;
      tg.fillStyle = state.sel === vt ? tok('--fg') : tok('--muted');
      tg.font = `${Math.min(10, Math.max(8, rh - 1))}px "IBM Plex Mono", monospace`;
      const nm = vt.short.length > 13 ? `${vt.short.slice(0, 12)}…` : vt.short;
      tg.fillText(nm, 4, y + rh * 0.5 + 3.5);
      vt.frames.forEach((f, bar) => {
        if (!f) return;
        const x0 = beatToX(bar * bpb, W);
        tg.globalAlpha = vt.t.muted ? 0.25 : 0.35 + 0.6 * clamp((f.loud + 50) / 35, 0, 1);
        tg.fillStyle = hex(state.mode === 'live' ? vt.liveColor : f.barColor);
        tg.fillRect(x0, y + 1, Math.max(1, barW + 0.4), Math.max(2, rh - 2));
      });
      tg.globalAlpha = 1;
    });
    const px = beatToX(state.b, W);
    tg.fillStyle = tok('--fg');
    tg.fillRect(px - 0.5, 0, 1.5, H);
  }
  let dragging = false;
  tlc.addEventListener('pointerdown', (e) => { dragging = true; tlc.setPointerCapture(e.pointerId); state.b = xToBeat(e.offsetX, tl.clientWidth); });
  tlc.addEventListener('pointermove', (e) => { if (dragging) state.b = xToBeat(e.offsetX, tl.clientWidth); });
  tlc.addEventListener('pointerup', () => (dragging = false));

  const activeCount = (bar: number) => tracks.filter((vt) => !vt.t.muted && vt.frames[bar]).length;
  let busiest = 0;
  for (let bar = 0; bar < map.bars; bar++) if (activeCount(bar) > activeCount(busiest)) busiest = bar;
  state.b = busiest * bpb + 0.001;

  const jumps: { label: string; bar: number }[] = map.locators.map((l) => ({ label: l.name, bar: Math.floor(l.bar) - 1 }));
  let prevSet = new Set<VTrack>();
  for (let bar = 0; bar < map.bars; bar++) {
    const cur = new Set(tracks.filter((vt) => !vt.t.muted && vt.frames[bar]));
    const inter = [...cur].filter((x) => prevSet.has(x)).length;
    const uni = new Set([...cur, ...prevSet]).size;
    if (cur.size && uni && inter / uni < 0.6 && !jumps.some((j) => Math.abs(j.bar - bar) < 4)) jumps.push({ label: bar === 0 || !prevSet.size ? 'In' : 'Change', bar });
    prevSet = cur;
  }
  jumps.sort((a, b) => a.bar - b.bar).slice(0, 9).forEach((j) => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.innerHTML = `<span>${j.bar + 1}</span>${esc(j.label)}`;
    c.addEventListener('click', () => (state.b = j.bar * bpb + 0.001));
    q('.jumps').appendChild(c);
  });

  const setPlaying = (p: boolean) => {
    state.playing = p;
    playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
    playBtn.querySelector('svg')!.innerHTML = p ? '<path d="M3 1.5h3v11H3zM8 1.5h3v11H8z"/>' : '<path d="M3 1.5v11l9-5.5z"/>';
  };
  playBtn.addEventListener('click', () => setPlaying(!state.playing));
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    if (e.key === 'ArrowRight') state.b = Math.min(END - 0.01, (barOf(state.b) + 1) * bpb);
    if (e.key === 'ArrowLeft') state.b = Math.max(0, (barOf(state.b) - 1) * bpb);
  };
  document.addEventListener('keydown', onKey);

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode === 'live' ? 'live' : 'sin';
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    el('wheel-sec').hidden = state.mode !== 'sin';
    state.key = '';
  }));
  const muteBtn = q<HTMLButtonElement>('[data-act="mute"]');
  muteBtn.addEventListener('click', () => { state.showMute = !state.showMute; muteBtn.setAttribute('aria-pressed', String(state.showMute)); muteBtn.textContent = state.showMute ? 'Show muted' : 'Muted hidden'; state.key = ''; });
  q('[data-act="view"]').addEventListener('click', () => { camera.position.copy(HOME.pos); controls.target.copy(HOME.target); controls.update(); });
  q('[data-act="download"]').addEventListener('click', actions.onDownload);
  q('[data-act="new"]').addEventListener('click', actions.onOpenAnother);
  q('[data-new]').addEventListener('click', (e) => { e.preventDefault(); actions.onOpenAnother(); });

  (function wheel() {
    const NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
    let h = '';
    const p = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    for (let i = 0; i < 12; i++) {
      const a0 = ((i - 0.5) / 12) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.5) / 12) * Math.PI * 2 - Math.PI / 2, am = (i / 12) * Math.PI * 2 - Math.PI / 2;
      h += `<path d="M ${p(24, a0)} L ${p(46, a0)} A 46 46 0 0 1 ${p(46, a1)} L ${p(24, a1)} A 24 24 0 0 0 ${p(24, a0)} Z" fill="#${new THREE.Color().setHSL(i / 12, 0.85, 0.58).getHexString()}"/>`;
      h += `<text x="${(35 * Math.cos(am)).toFixed(1)}" y="${(35 * Math.sin(am) + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-family="IBM Plex Mono, monospace" fill="#0b0d13">${NAMES[i]}</text>`;
    }
    el('wheel').innerHTML = h;
  })();

  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let downAt: [number, number] | null = null;
  const pick = (e: PointerEvent): VTrack | null => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(tracks.filter((vt) => vt.mesh.visible && vt.cur.op > 0.1).map((vt) => vt.mesh), false)[0];
    return hit ? (hit.object.userData.vt as VTrack) : null;
  };
  renderer.domElement.addEventListener('pointermove', (e) => {
    const vt = pick(e);
    state.hover = vt;
    renderer.domElement.style.cursor = vt ? 'pointer' : 'grab';
    const f = vt && frameAt(vt, state.b);
    if (!vt || !f) { tip.hidden = true; return; }
    tip.innerHTML = `<div class="n">${esc(vt.short)}</div><div class="d">${fmtRange(f.p10, f.p90)} · ${Math.round(f.loud)} LUFS${vt.t.kind === 'midi' || vt.t.kind === 'drums' ? ' approx.' : ''}${vt.t.muted ? ' · muted' : ''}</div>`;
    tip.hidden = false;
    const r = sceneEl.getBoundingClientRect();
    tip.style.left = `${clamp(e.clientX - r.left + 14, 4, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${clamp(e.clientY - r.top + 14, 4, r.height - tip.offsetHeight - 4)}px`;
  });
  renderer.domElement.addEventListener('pointerleave', () => { state.hover = null; tip.hidden = true; });
  renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const vt = pick(e);
    select(vt && state.sel !== vt ? vt : null);
  });

  const tmp = new THREE.Vector3();
  const project = (pos: THREE.Vector3, W: number, H: number): [number, number] | null => {
    tmp.copy(pos).project(camera);
    return tmp.z > 1 ? null : [((tmp.x + 1) / 2) * W, ((1 - tmp.y) / 2) * H];
  };
  let last = performance.now(), first = true, raf = 0, specKey = -1;

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.playing) { state.b += (dt * map.bpm) / 60; if (state.b >= END) state.b = 0; }
    const b = state.b;
    const key = `${barOf(b)}:${state.mode}:${state.showMute}:${state.playing ? '' : Math.floor(b * 4)}`;
    if (key !== state.key) { state.key = key; refreshPanel(); }
    else if (state.sel && state.playing && Math.floor(b * 2) !== specKey) { specKey = Math.floor(b * 2); const f = frameAt(state.sel, b); if (f) drawSpec(state.sel, f); }
    posEl.textContent = fmtPos(b);
    el('now-n').textContent = `${state.nowCount} playing at ${fmtPos(b)}`;
    const k = first || reduce ? 1 : 1 - Math.exp(-dt * 9);
    const pair = state.hlPair !== null && clashes[state.hlPair] ? [clashes[state.hlPair].a, clashes[state.hlPair].b] : null;

    for (const vt of tracks) {
      const f = frameAt(vt, b);
      const on = !!f && shown(vt);
      if (f) Object.assign(vt.tgt, target(f));
      vt.tgt.op = on ? (vt.t.muted ? 0.35 : 1) : 0;
      (Object.keys(vt.cur) as (keyof Shape)[]).forEach((p) => (vt.cur[p] += (vt.tgt[p] - vt.cur[p]) * k));
      vt.mesh.visible = vt.cur.op > 0.01;
      if (!vt.mesh.visible) { vt.label.style.opacity = '0'; continue; }
      const pulse = f && on ? pulseOf(f, b) : 0;
      const pz = reduce ? 0 : pulse * 0.07;
      vt.mesh.position.set(vt.cur.x, vt.cur.y, vt.cur.z);
      vt.mesh.scale.set(vt.cur.rx * (1 + pz), vt.cur.ry * (1 + pz * 0.5), vt.cur.rz * (1 + pz));
      const col = colorOf(vt, f, b);
      const focus = state.sel === vt || state.hover === vt || (pair?.includes(vt) ?? false);
      const dim = (state.sel && state.sel !== vt && !focus) || (pair && !pair.includes(vt)) ? 0.35 : 1;
      vt.mat.uniforms.uColor.value.copy(col);
      vt.mat.uniforms.uOpacity.value = vt.cur.op * dim * (vt.t.muted ? 0.4 : 1);
      vt.mat.uniforms.uPulse.value = vt.t.muted ? 0.1 : pulse;
      vt.mat.uniforms.uSel.value = focus ? 1 : 0;
      const wm = vt.wire.material as THREE.LineBasicMaterial;
      wm.color.copy(col);
      wm.opacity = (vt.t.muted ? 0.35 : focus ? 0.22 : 0.06) * vt.cur.op;
      const cm = vt.core.material as THREE.MeshBasicMaterial;
      cm.color.copy(col);
      cm.opacity = (vt.t.muted ? 0 : 0.25 + 0.75 * pulse) * vt.cur.op * dim;
      vt.dot.style.background = hex(col);
    }

    const sel = state.sel, sf = sel ? frameAt(sel, b) : null;
    rings.forEach((r, i) => {
      if (!sel || !sf || !sel.mesh.visible) { r.visible = false; return; }
      const mx = Math.max(...sf.bands);
      const rel = clamp((sf.bands[i] - mx + 36) / 36, 0, 1);
      r.visible = rel > 0.02;
      if (!r.visible) return;
      r.position.set(sel.cur.x, yOf(C[i]), sel.cur.z);
      r.scale.set(0.15 + sel.cur.rx * 1.25 * rel, 1, 0.15 + sel.cur.rz * 1.25 * rel);
      const rm = r.material as THREE.LineBasicMaterial;
      rm.color.copy(colorOf(sel, sf, b));
      rm.opacity = 0.35 + 0.6 * rel;
    });

    slabs.forEach((sl, i) => {
      const c = clashes[i];
      if (!c || !c.a.mesh.visible || !c.b.mesh.visible) { sl.box.visible = false; return; }
      const A = c.a.cur, B = c.b.cur;
      const x0 = Math.min(A.x - A.rx * 0.7, B.x - B.rx * 0.7), x1 = Math.max(A.x + A.rx * 0.7, B.x + B.rx * 0.7);
      const z0 = Math.min(A.z, B.z) - 0.5, z1 = Math.max(A.z, B.z) + 0.5;
      const y0 = yOf(c.fLo), y1 = yOf(c.fHi);
      sl.box.visible = true;
      sl.box.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      sl.box.scale.set(x1 - x0, Math.max(0.12, y1 - y0), z1 - z0);
      const hl = state.hlPair === i;
      (sl.box.material as THREE.MeshBasicMaterial).opacity = (hl ? 0.2 : 0.07) * (0.6 + c.weight);
      (sl.edges.material as THREE.LineBasicMaterial).opacity = hl ? 0.95 : 0.4;
    });

    controls.update();
    renderer.render(scene, camera);

    const W = sceneEl.clientWidth, H = sceneEl.clientHeight;
    for (const L of labels) {
      const p = project(L.pos, W, H);
      if (!p) { L.el.style.opacity = '0'; continue; }
      L.el.style.opacity = '1';
      L.el.style.transform = `translate(${(L.right ? p[0] - L.el.offsetWidth : p[0]).toFixed(1)}px,${(p[1] - 7).toFixed(1)}px)`;
    }
    for (const vt of tracks) {
      if (!vt.mesh.visible) continue;
      const p = project(V(vt.cur.x, vt.cur.y + vt.cur.ry + 0.3, vt.cur.z), W, H);
      if (!p) { vt.label.style.opacity = '0'; continue; }
      vt.label.style.opacity = (Math.min(1, vt.cur.op * 1.4) * (state.sel && state.sel !== vt ? 0.45 : 1)).toFixed(2);
      vt.label.style.transform = `translate(${(p[0] - vt.label.offsetWidth / 2).toFixed(1)}px,${(p[1] - 22).toFixed(1)}px)`;
    }
    drawTimeline();
    first = false;
    raf = requestAnimationFrame(frame);
  }

  const resize = () => {
    const W = sceneEl.clientWidth, H = sceneEl.clientHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / Math.max(1, H);
    camera.fov = W < 560 ? 52 : 40;
    camera.updateProjectionMatrix();
    if (state.sel) renderSel();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(sceneEl);
  resize();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    controls.dispose();
    renderer.dispose();
    root.innerHTML = '';
  };
}
