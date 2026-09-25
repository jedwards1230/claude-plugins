#!/usr/bin/env node
// Resolve the SOURCE storyboard (src/storyboard.json, with word and beat cues) into the
// engine's web/film/storyboard.json, where every time is in seconds. Reads src/script.json,
// src/words.json and, if present, src/beats.json. Validates the shape (a hand-written check
// that mirrors references/storyboard.schema.json), resolves every cue, places the voice lines,
// fills defaults and plans the camera with the engine's own code (web/js/storyboard.js, loaded
// in a vm), then prints a summary and warnings. Exit 1 on errors (or on warnings with --strict).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HELP = `Usage: node tools/resolve.mjs [--film <dir>] [--out <file>] [--check] [--strict] [--json] [--quiet]

Reads   <film>/src/storyboard.json   source storyboard (cues)
        <film>/src/script.json       {lines: [{id, text, tts?, reads?}]} (or a bare array)
        <film>/src/words.json        {<line id>: {t, d, words: [{w, s, e}]}}  (t = line start in the
                                     film, d = length, word times relative to the line start)
        <film>/src/beats.json        optional {bpm, beats: [s], downbeats: [s]} of the final music
Writes  <film>/web/film/storyboard.json (or --out)

Cues    12.5 | "+0.8" (after the previous cue in the same list) | "end" | "vo:<line>" |
        "vo:<line>.end" | "vo:<line>.w<i>" | "vo:<line>.w<i>.end" | "beat:<n>" | "bar:<n>" |
        "scene:<id>" | "scene:<id>.end"   (indexes are 0-based; add "+0.3" or "-0.2" to offset)

Options
  --check    validate and report, do not write
  --strict   treat warnings as errors (exit 1)
  --json     print a machine-readable report instead of the text summary
  --quiet    print warnings and errors only
  -h, --help this help`;

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') opt.help = true;
  else if (['--check', '--strict', '--json', '--quiet'].includes(a)) opt[a.slice(2)] = true;
  else if (a === '--film' || a === '--out') opt[a.slice(2)] = args[++i];
  else { console.error(`unknown argument ${a}\n\n${HELP}`); process.exit(2); }
}
if (opt.help) { console.log(HELP); process.exit(0); }

const film = path.resolve(opt.film || '.');
const here = path.dirname(new URL(import.meta.url).pathname);
const errors = [], warnings = [];
const err = (p, m) => errors.push(`${p}: ${m}`);
const warn = (m) => warnings.push(m);
const readJSON = (rel, optional) => {
  const f = path.join(film, rel);
  if (!fs.existsSync(f)) { if (optional) return null; errors.push(`${rel}: file not found`); return null; }
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errors.push(`${rel}: invalid JSON (${e.message})`); return null; }
};
function fail() {
  if (opt.json) console.log(JSON.stringify({ ok: false, errors, warnings }, null, 1));
  else { for (const e of errors) console.error('error: ' + e); for (const w of warnings) console.error('warning: ' + w); }
  process.exit(1);
}

// ---- the engine's own storyboard code, shared through a vm sandbox
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'storyboard.js', 'audio.js']) {
  const p = [path.join(film, 'web/js', f), path.join(here, '../web/js', f)].find((x) => fs.existsSync(x));
  if (!p) { console.error(`cannot find web/js/${f}`); process.exit(2); }
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
}
const SB = sandbox.FILM.SB, SFX_TYPES = sandbox.FILM.A.SFX_TYPES;

// ---- shape check (mirrors references/storyboard.schema.json)
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const T = {
  num: (v) => typeof v === 'number' && isFinite(v),
  int: (v) => Number.isInteger(v),
  str: (v) => typeof v === 'string',
  bool: (v) => typeof v === 'boolean',
  obj: isObj,
  arr: Array.isArray,
  pair: (v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && isFinite(x)),
  cue: (v) => SB.isCue(v),
  any: () => true,
};
const TNAME = { num: 'a number', int: 'an integer', str: 'a string', bool: 'true/false', obj: 'an object', arr: 'an array', pair: 'a [number, number] pair', cue: 'a cue' };
// spec: {key: type | [type, 'req'] | ['enum', [...values], 'req'?] | fn(value) -> error string | null}
function check(o, p, spec) {
  if (!isObj(o)) { err(p, 'must be an object'); return false; }
  for (const [k, s] of Object.entries(spec)) {
    const req = Array.isArray(s) && s[s.length - 1] === 'req';
    if (o[k] === undefined) { if (req) err(`${p}.${k}`, 'is required'); continue; }
    const ty = Array.isArray(s) ? s[0] : s;
    if (typeof ty === 'function') { const m = ty(o[k]); if (m) err(`${p}.${k}`, m); }
    else if (ty === 'enum') { if (!s[1].includes(o[k])) err(`${p}.${k}`, `must be one of ${s[1].map((x) => JSON.stringify(x)).join(', ')}`); }
    else if (!T[ty](o[k])) err(`${p}.${k}`, `must be ${TNAME[ty]}${ty === 'cue' ? ` (got ${JSON.stringify(o[k])})` : ''}`);
  }
  for (const k of Object.keys(o)) if (!(k in spec) && !k.startsWith('$') && !k.startsWith('_')) warn(`${p}.${k}: unknown field (ignored)`);
  return true;
}
const oneOf = (...types) => (v) => (types.some((t) => T[t](v)) ? null : `must be ${types.map((t) => TNAME[t] || t).join(' or ')}`);
const arrOf = (t) => (v) => (Array.isArray(v) && v.every(T[t]) ? null : `must be an array of ${t === 'str' ? 'strings' : t === 'num' ? 'numbers' : t + 's'}`);
const EASES = ['linear', 'in', 'out', 'inOut', 'sine', 'back', 'elastic', 'spring', 'cubic'];
const COMMON_EL = { id: ['str', 'req'], kind: ['enum', SB.KINDS, 'req'], pos: 'pair', scale: 'num', r: 'num', alpha: 'num', flip: 'bool',
  boil: 'num', idle: oneOf('bool', 'obj'), cues: 'obj', notes: 'str' };
const TEXT_FIELDS = { text: 'str', style: ['enum', Object.keys(SB.TEXT_STYLES)], size: 'num', font: 'str', weight: oneOf('int', 'str'), color: 'str',
  align: ['enum', ['left', 'center', 'right']], lh: 'num', w: 'num', sub: 'str', sub_color: 'str', card: oneOf('bool', 'obj'), underline: oneOf('bool', 'str'), cps: 'num' };
const KIND_FIELDS = {
  text: Object.assign({}, TEXT_FIELDS, { text: ['str', 'req'] }),
  equation: Object.assign({}, TEXT_FIELDS, { tex: 'str' }),
  sprite: { src: ['str', 'req'], w: 'num', shadow: 'num' },
  clip: { src: ['str', 'req'], poster: 'str', w: 'num', shadow: 'num' },
  shape: { shape: ['enum', SB.SHAPES, 'req'], w: 'num', h: 'num', color: 'str', stroke: 'str', stroke_w: 'num', dash: 'pair', outline: 'bool',
    from: 'pair', to: 'pair', bend: 'num', head: 'num', points: (v) => (Array.isArray(v) && v.every(T.pair) ? null : 'must be an array of [x, y] pairs'),
    turns: 'num', twinkle: 'bool', rate: 'num', spikes: 'int', inner: 'num', amp: 'num', rim: 'bool', shadow: 'num', wob: 'num' },
  'svg-path': { d: ['str', 'req'], size: 'num', unit: 'num', stroke: 'str', stroke_w: 'num', fill: 'str', wob: 'num', dash: 'pair' },
  chart: { chart: ['enum', ['bar', 'line']], data: [arrOf('num'), 'req'], labels: 'arr', w: 'num', h: 'num', max: 'num', color: 'str', colors: arrOf('str'),
    values: 'bool', label_size: 'num', axis: 'str', bar_w: 'num', stroke_w: 'num' },
  group: { children: ['arr', 'req'], w: 'num', h: 'num' },
  custom: { shot: ['str', 'req'], params: 'obj', w: 'num', h: 'num' },
};
const BEAT_FIELDS = { at: ['cue', 'req'], do: ['enum', SB.BEATS, 'req'], target: 'str', dur: 'num', until: 'cue', ease: ['enum', EASES], from: 'any', to: 'any',
  by: 'pair', arc: 'num', squash: 'bool', k: 'num', spin: 'num', cps: 'num', decimals: 'int', focus: 'pair', z: 'num', r: 'num', notes: 'str' };

function checkElement(el, p, ids) {
  if (!isObj(el)) return err(p, 'must be an object');
  const spec = Object.assign({}, COMMON_EL, KIND_FIELDS[el.kind] || {});
  check(el, p, spec);
  if (el.kind === 'equation' && el.tex == null && el.text == null) err(p, 'an equation needs tex or text');
  if (T.str(el.id)) { if (ids.has(el.id)) err(`${p}.id`, `duplicate element id "${el.id}"`); ids.add(el.id); }
  if (el.kind === 'group' && Array.isArray(el.children)) el.children.forEach((c, i) => checkElement(c, `${p}.children[${i}]`, ids));
}
function checkBeat(b, p, ids) {
  if (!check(b, p, BEAT_FIELDS)) return;
  if (b.do !== 'camera' && !T.str(b.target)) err(`${p}.target`, 'is required');
  if (T.str(b.target) && !ids.has(b.target)) err(`${p}.target`, `no element with id "${b.target}"`);
  const num = (k) => b[k] !== undefined && !T.num(b[k]) && err(`${p}.${k}`, `must be a number for ${b.do}`);
  const pair = (k) => b[k] !== undefined && !T.pair(b[k]) && err(`${p}.${k}`, `must be a [x, y] pair for ${b.do}`);
  if (['fade', 'scale', 'count-up'].includes(b.do)) { num('from'); num('to'); }
  if (b.do === 'slide' || b.do === 'move') { pair('from'); pair('to'); }
  if (b.do === 'count-up' && b.to === undefined) err(`${p}.to`, 'is required for count-up');
  if (b.do === 'morph') { if (!T.str(b.to)) err(`${p}.to`, 'must be the id of the element to morph into'); else if (!ids.has(b.to)) err(`${p}.to`, `no element with id "${b.to}"`); }
}

// ---- load inputs
const src = readJSON('src/storyboard.json');
if (!src) fail();
const scriptRaw = readJSON('src/script.json', true), words = readJSON('src/words.json', true) || {}, beatsFile = readJSON('src/beats.json', true);
const cfg = readJSON('web/film/config.json', true) || {};
if (errors.length) fail();

check(src, 'storyboard', { version: 'int', meta: ['obj', 'req'], layout: 'obj', music: 'obj', vo: 'arr', sfx: 'arr', camera: 'obj', cues: 'obj', mix: 'obj',
  scenes: ['arr', 'req'], shots: arrOf('str'), notes: 'str' });
if (isObj(src.meta)) {
  check(src.meta, 'meta', { duration: ['num', 'req'], fps: 'int', size: 'pair', seed: 'int', title: 'str' });
  if (T.num(src.meta.duration) && src.meta.duration <= 0) err('meta.duration', 'must be > 0');
  if (T.pair(src.meta.size) && !src.meta.size.every((x) => Number.isInteger(x) && x >= 16 && x % 2 === 0)) err('meta.size', 'must be even integers (video encoders need even sizes)');
}
if (src.layout !== undefined) check(src.layout, 'layout', { type: ['enum', SB.LAYOUTS], grid: 'pair', panel: 'pair', gutter: 'pair', caption: oneOf('str', 'obj'),
  color: 'str', arrows: 'bool', doodles: 'bool', finale: (v) => (v === false || isObj(v) ? null : 'must be false or {at, dur}'), whoosh: 'bool', handheld: 'num' });
if (isObj(src.layout) && isObj(src.layout.finale)) check(src.layout.finale, 'layout.finale', { at: 'cue', dur: 'num' });
if (src.music !== undefined && check(src.music, 'music', { asset: 'str', synth: 'obj', gain_db: 'num', duck_db: 'num', intro_db: 'num', outro_db: 'num',
  duck_under: ['enum', ['vo', 'none']], at: 'cue', offset: 'num', end_at: 'cue' })) {
  if (src.music.asset == null && src.music.synth == null) err('music', 'needs asset or synth');
  if (isObj(src.music.synth)) check(src.music.synth, 'music.synth', { bpm: 'num', key: 'str', mode: ['enum', ['major', 'minor']], progression: arrOf('int'), pad: 'num', pulse: 'num', kick: 'num' });
}
if (src.mix !== undefined) check(src.mix, 'mix', { master: 'num', vo_db: 'num', sfx_db: 'num', music_db: 'num' });
(src.vo || []).forEach((v, i) => check(v, `vo[${i}]`, { id: ['str', 'req'], at: 'cue', asset: 'str', gain_db: 'num' }));
(src.sfx || []).forEach((s, i) => check(s, `sfx[${i}]`, { at: ['cue', 'req'], type: ['enum', SFX_TYPES, 'req'], gain: 'num', pan: 'num', dur: 'num', pitch: 'num', note: 'int', notes: 'str' }));
if (src.camera !== undefined && check(src.camera, 'camera', { keys: ['arr', 'req'] })) {
  (src.camera.keys || []).forEach((k, i) => check(k, `camera.keys[${i}]`, { at: ['cue', 'req'], scene: 'str', focus: 'pair', x: 'num', y: 'num', z: 'num', r: 'num',
    ease: ['enum', ['sine', 'cubic', 'linear']], cut: 'bool', zoomTo: 'bool' }));
}
if (isObj(src.cues)) for (const [k, v] of Object.entries(src.cues)) if (!T.cue(v)) err(`cues.${k}`, `must be a cue (got ${JSON.stringify(v)})`);
const ids = new Set(), sceneIds = new Set();
(src.scenes || []).forEach((sc, i) => {
  const p = `scenes[${i}]`;
  if (!check(sc, p, { id: ['str', 'req'], at: 'cue', until: 'cue', overlay: 'bool', hold: 'bool', dim: 'num', reads: arrOf('str'), cell: 'pair', panel: 'obj',
    bg: 'str', texture: 'bool', transition: oneOf('str', 'obj'), elements: 'arr', beats: 'arr', custom: oneOf('str', 'obj'), params: 'obj', cues: 'obj', notes: 'str' })) return;
  if (T.str(sc.id)) { if (sceneIds.has(sc.id)) err(`${p}.id`, `duplicate scene id "${sc.id}"`); sceneIds.add(sc.id); }
  if (isObj(sc.panel)) check(sc.panel, `${p}.panel`, { color: 'str', r: 'num', seed: 'int', enter: ['enum', ['drop', 'none']], enter_at: 'cue' });
  if (T.str(sc.transition) && !SB.TRANSITIONS.includes(sc.transition)) err(`${p}.transition`, `must be one of ${SB.TRANSITIONS.join(', ')}`);
  if (isObj(sc.transition)) check(sc.transition, `${p}.transition`, { type: ['enum', SB.TRANSITIONS, 'req'], dur: 'num', dir: ['enum', ['left', 'right']] });
  if (isObj(sc.custom) && !T.str(sc.custom.canvas)) err(`${p}.custom.canvas`, 'must name the canvas shot id');
  (sc.elements || []).forEach((el, j) => checkElement(el, `${p}.elements[${j}]`, ids));
});
(src.scenes || []).forEach((sc, i) => (isObj(sc) && Array.isArray(sc.beats) ? sc.beats : []).forEach((b, j) => checkBeat(b, `scenes[${i}].beats[${j}]`, ids)));
if (!Array.isArray(src.scenes) || !src.scenes.length) warn('storyboard has no scenes');
if (errors.length) fail();

// ---- voice lines and the beat grid
const meta = Object.assign({ fps: 30, size: [1920, 1080], seed: 1, title: '' }, src.meta);
const duration = meta.duration;
const lines = Array.isArray(scriptRaw) ? scriptRaw : (scriptRaw && scriptRaw.lines) || [];
const scriptById = {};
lines.forEach((l, i) => { if (!isObj(l) || !T.str(l.id) || !T.str(l.text)) err(`script.json lines[${i}]`, 'needs id and text strings'); else scriptById[l.id] = l; });
for (const [id, w] of Object.entries(words)) {
  if (!isObj(w) || !T.num(w.t) || !T.num(w.d) || w.d <= 0) { err(`words.json.${id}`, 'needs t (line start, s) and d (length, s > 0)'); continue; }
  if (w.words !== undefined && !(Array.isArray(w.words) && w.words.every((x) => isObj(x) && T.num(x.s) && T.num(x.e)))) err(`words.json.${id}.words`, 'must be [{w, s, e}] with s and e in seconds from the line start');
}
if (errors.length) fail();
const voIds = src.vo ? src.vo.map((v) => v.id) : lines.map((l) => l.id).filter((id) => words[id]);
if (!src.vo) for (const l of lines) if (!words[l.id]) warn(`script line "${l.id}" has no timing in words.json; it is not placed (no captions, no cues)`);
const env = { vo: {}, beats: [], downbeats: [], duration, scenes: {} };
const R = (cue, p, extra = {}) => {
  try { return SB.resolveCue(cue, Object.assign({}, env, extra)); } catch (e) { err(p, e.message); return null; }
};
if (beatsFile) {
  env.beats = (beatsFile.beats || []).filter(T.num); env.downbeats = (beatsFile.downbeats || []).filter(T.num);
} else if (src.music && src.music.synth) {
  const bpm = src.music.synth.bpm || 92, at0 = T.num(src.music.at) ? src.music.at : 0;
  for (let k = 0; at0 + (k * 60) / bpm < duration; k++) { env.beats.push(+(at0 + (k * 60) / bpm).toFixed(4)); if (k % 4 === 0) env.downbeats.push(env.beats[k]); }
}
const vo = [];
let prevVo = null;
voIds.forEach((id, i) => {
  const w = words[id], line = scriptById[id], ov = (src.vo || [])[i] || {};
  if (!w) return err(`vo[${i}]`, `line "${id}" has no entry in words.json`);
  if (!line) warn(`vo line "${id}" is not in script.json; it has no caption text`);
  const at = ov.at != null ? R(ov.at, `vo[${i}].at`, { prev: prevVo, anchor: 0 }) : w.t;
  if (at == null) return;
  prevVo = at;
  let asset = ov.asset || null;
  if (!asset) for (const ext of ['mp3', 'wav', 'ogg', 'm4a']) if (fs.existsSync(path.join(film, 'web/audio', `vo_${id}.${ext}`))) { asset = `audio/vo_${id}.${ext}`; break; }
  const v = { id, at: +at.toFixed(4), dur: w.d, text: line ? line.text : '', asset,
    words: (w.words || []).map((x) => ({ w: x.w, s: +(at + x.s).toFixed(4), e: +(at + x.e).toFixed(4) })) };
  if (ov.gain_db != null) v.gain_db = ov.gain_db;
  vo.push(v); env.vo[id] = v;
});

// ---- resolve every cue
const out = JSON.parse(JSON.stringify(src));
delete out.$schema;
out.version = 1;
out.meta = meta;
out.vo = vo;
const scenes = out.scenes;
let prevAt = null;
scenes.forEach((sc, i) => {
  sc.at = sc.at == null ? (i === 0 ? 0 : null) : R(sc.at, `scenes[${i}].at`, { prev: prevAt, anchor: 0 });
  if (sc.at == null && i > 0) err(`scenes[${i}].at`, 'is required (only the first scene defaults to 0)');
  prevAt = sc.at;
  env.scenes[sc.id] = { at: sc.at };
});
scenes.forEach((sc, i) => {
  if (sc.until != null) sc.until = R(sc.until, `scenes[${i}].until`, { prev: sc.at, anchor: sc.at });
  else {
    const next = sc.overlay ? null : scenes.slice(i + 1).find((s) => !s.overlay);
    sc.until = next ? next.at : duration;
  }
  env.scenes[sc.id].until = sc.until;
  if (sc.at != null && sc.until != null && sc.until <= sc.at) err(`scenes[${i}]`, `until (${sc.until}) must be after at (${sc.at})`);
});
if (errors.length) fail();
const resolveMap = (m, p, anchor) => { for (const k of Object.keys(m || {})) m[k] = R(m[k], `${p}.${k}`, { anchor }); };
scenes.forEach((sc, i) => {
  const p = `scenes[${i}]`;
  if (isObj(sc.panel) && sc.panel.enter_at != null) sc.panel.enter_at = R(sc.panel.enter_at, `${p}.panel.enter_at`, { anchor: sc.at });
  if (sc.cues) resolveMap(sc.cues, `${p}.cues`, sc.at);
  SB.forEachElement({ scenes: [sc] }, (el) => { if (el.cues) resolveMap(el.cues, `${p} element "${el.id}".cues`, sc.at); });
  let prev = null;
  (sc.beats || []).forEach((b, j) => {
    b.at = R(b.at, `${p}.beats[${j}].at`, { prev, anchor: sc.at });
    if (b.until != null) b.until = R(b.until, `${p}.beats[${j}].until`, { prev: b.at, anchor: b.at });
    if (b.at != null && b.until != null && b.until <= b.at) err(`${p}.beats[${j}]`, 'until must be after at');
    prev = b.at;
  });
});
if (out.cues) resolveMap(out.cues, 'cues', 0);
let prevS = null;
(out.sfx || []).forEach((s, i) => { s.at = R(s.at, `sfx[${i}].at`, { prev: prevS, anchor: 0 }); prevS = s.at; });
let prevK = null;
if (out.camera) out.camera.keys.forEach((k, i) => { k.at = R(k.at, `camera.keys[${i}].at`, { prev: prevK, anchor: 0 }); prevK = k.at; });
if (out.music) {
  if (out.music.at != null) out.music.at = R(out.music.at, 'music.at', { anchor: 0 });
  if (out.music.end_at != null) out.music.end_at = R(out.music.end_at, 'music.end_at', { anchor: 0 });
}
if (isObj(out.layout) && isObj(out.layout.finale) && out.layout.finale.at != null) out.layout.finale.at = R(out.layout.finale.at, 'layout.finale.at', { anchor: 0 });
if (errors.length) fail();

// ---- defaults, shots, camera (engine code), automatic whooshes
try { SB.normalize(out); } catch (e) { err('storyboard', e.message); fail(); }
const shotIds = new Set(out.shots || []);
SB.forEachElement(out, (el) => { if (el.kind === 'custom') shotIds.add(el.shot); });
for (const sc of scenes) if (sc.custom) shotIds.add(typeof sc.custom === 'string' ? sc.custom : sc.custom.canvas);
out.shots = [...shotIds].map((id) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) err(`shots`, `"${id}" is not a valid shot id`);
  else if (!fs.existsSync(path.join(film, 'web/film/shots', id + '.js'))) err(`shot "${id}"`, `web/film/shots/${id}.js does not exist`);
  return `film/shots/${id}.js`;
});
if (errors.length) fail();
const plan = SB.planCamera(out);
out.camera = { resolved: true, auto: !(src.camera && src.camera.keys && src.camera.keys.length), keys: plan.keys, moves: plan.moves };
out.sfx = out.sfx || [];
if (out.layout.whoosh) {
  for (const m of plan.moves) {
    out.sfx.push({ at: +(m.from + 0.05).toFixed(4), type: 'whoosh', gain: m.beat ? 0.35 : m.finale ? 0.5 : 0.8, dur: +(m.to - m.from).toFixed(3), pan: 0, auto: true });
  }
  out.sfx.sort((a, b) => a.at - b.at);
}
out.timing = { beats: env.beats, downbeats: env.downbeats };

// ---- warnings
const panels = SB.panelScenes(out);
for (let i = 1; i < panels.length; i++) if (panels[i].at < panels[i - 1].at) warn(`scene "${panels[i].id}" starts before the scene listed ahead of it`);
for (let i = 1; i < plan.keys.length; i++) if (plan.keys[i].t < plan.keys[i - 1].t) warn('camera keys overlap: a scene is too short for its pans');
for (const m of plan.moves) {
  const prevArrive = plan.moves.find((x) => x.to > m.from && x.from < m.from && x !== m);
  if (prevArrive && !m.beat && !prevArrive.beat) warn(`camera moves overlap at ${m.from.toFixed(2)} s: scene "${m.scene}" is too short for its pans`);
}
const byId = {};
SB.forEachElement(out, (el) => { byId[el.id] = el; });
for (const sc of scenes) {
  const len = sc.until - sc.at;
  if (sc.reads && sc.reads.length && len < 1.2 * sc.reads.length) warn(`scene "${sc.id}": ${sc.reads.length} reads in ${len.toFixed(2)} s; each read needs >= 1.2 s`);
  // when the camera leaves this scene: board pans/finale away from its panel, or a stage cut
  const leaves = plan.moves.filter((m) => !m.beat && m.scene === sc.id).map((m) => m.from);
  if (out.layout.type === 'stage' && !sc.overlay && sc.until < duration) leaves.push(sc.until);
  for (const b of sc.beats || []) {
    if (b.at < sc.at - 0.01 || b.at >= sc.until) warn(`scene "${sc.id}": ${b.do} on "${b.target || 'camera'}" at ${b.at.toFixed(2)} s is outside the scene (${sc.at.toFixed(2)}-${sc.until.toFixed(2)} s)`);
    if (b.do === 'type-on' || b.do === 'draw-on') {
      const end = b.at + b.dur, L = Math.min(...leaves);
      if (b.at >= L) warn(`scene "${sc.id}": ${b.do} "${b.target}" starts at ${b.at.toFixed(2)} s, after the camera leaves at ${L.toFixed(2)} s; nobody will see it`);
      else if (end > L - 0.3) warn(`scene "${sc.id}": ${b.do} "${b.target}" ends at ${end.toFixed(2)} s, ${(L - end).toFixed(2)} s before the camera moves at ${L.toFixed(2)} s (want >= 0.3 s)`);
    }
  }
}
SB.forEachElement(out, (el, sc) => {
  if (el.kind === 'text' || el.kind === 'equation') {
    const size = SB.textStyle(el).size;
    if (size < 28) warn(`text "${el.id}" is ${size} px at zoom 1; the minimum is 28 px at 1080p`);
  }
  if (el.kind === 'chart' && (el.label_size || 30) < 28) warn(`chart "${el.id}" labels are ${el.label_size} px; the minimum is 28 px at 1080p`);
  if (el.pos && (el.pos[0] < 0 || el.pos[0] > 1 || el.pos[1] < 0 || el.pos[1] > 1)) warn(`element "${el.id}" pos ${JSON.stringify(el.pos)} is outside its box (0..1)`);
  const sticker = el.kind === 'sprite' ? el.src : el.kind === 'clip' ? el.poster : null;
  if (sticker && !fs.existsSync(path.join(film, 'web/img/manifest.json'))) warn(`${el.kind} "${el.id}" uses sticker "${sticker}" but web/img/manifest.json does not exist`);
});
const man = readJSON('web/img/manifest.json', true);
if (man) SB.forEachElement(out, (el) => { const n = el.kind === 'clip' ? el.poster : el.kind === 'sprite' ? el.src : null; if (n && !(n in man)) warn(`sticker "${n}" (element "${el.id}") is not in web/img/manifest.json`); });
for (let i = 1; i < vo.length; i++) if (vo[i].at < vo[i - 1].at + vo[i - 1].dur) warn(`voice lines "${vo[i - 1].id}" and "${vo[i].id}" overlap`);
if (vo.length && vo[vo.length - 1].at + vo[vo.length - 1].dur > duration) warn(`the last voice line ends after the film (${duration} s)`);
for (const s of out.sfx) if (s.at < 0 || s.at > duration) warn(`sfx ${s.type} at ${s.at} s is outside the film`);
for (const k of ['size', 'fps', 'duration']) {
  if (cfg[k] != null && JSON.stringify(cfg[k]) !== JSON.stringify(meta[k])) warn(`web/film/config.json ${k} ${JSON.stringify(cfg[k])} differs from meta.${k} ${JSON.stringify(meta[k])}; the storyboard wins`);
}
if (errors.length) fail();

// ---- write
const ordered = {};
for (const k of ['version', 'meta', 'layout', 'timing', 'music', 'mix', 'vo', 'cues', 'scenes', 'camera', 'sfx', 'shots', 'downgrades']) if (out[k] !== undefined) ordered[k] = out[k];
for (const k of Object.keys(out)) if (!(k in ordered) && k !== 'notes') ordered[k] = out[k];
// ASCII-only JSON (non-ASCII as \uXXXX) so no server or editor charset can garble it
const asciiJSON = (o) => JSON.stringify(o, null, 1).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const dest = path.resolve(opt.out || path.join(film, 'web/film/storyboard.json'));
if (!opt.check) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, asciiJSON(ordered) + '\n'); }

const report = {
  ok: true, out: opt.check ? null : dest, duration, layout: out.layout.type,
  scenes: scenes.map((s) => ({ id: s.id, at: s.at, until: s.until, overlay: !!s.overlay, cell: s.cell, beats: (s.beats || []).length })),
  vo: vo.map((v) => ({ id: v.id, at: v.at, dur: v.dur, words: v.words.length, asset: v.asset })),
  sfx: out.sfx.length, moves: plan.moves, shots: out.shots, downgrades: out.downgrades, warnings,
};
if (opt.json) console.log(JSON.stringify(report, null, 1));
else {
  if (!opt.quiet) {
    console.log(`${opt.check ? 'checked' : 'wrote ' + (path.relative(process.cwd(), dest) || dest)}: ${duration} s, ${out.layout.type} layout, ${scenes.length} scenes, ${vo.length} voice lines, ${out.sfx.length} sfx, ${out.shots.length} shots`);
    for (const s of report.scenes) console.log(`  scene ${s.id.padEnd(12)} ${s.at.toFixed(2).padStart(6)}-${s.until.toFixed(2).padStart(6)} s${s.cell ? `  cell ${s.cell.join(',')}` : ''}${s.overlay ? '  overlay' : ''}  ${s.beats} beats`);
    for (const v of report.vo) console.log(`  line  ${v.id.padEnd(12)} ${v.at.toFixed(2).padStart(6)}-${(v.at + v.dur).toFixed(2).padStart(6)} s  ${v.words} words  ${v.asset || '(no audio: captions only)'}`);
    for (const m of plan.moves) console.log(`  camera ${m.from.toFixed(2)}-${m.to.toFixed(2)} s ${m.finale ? 'finale pull-back' : m.beat ? `beat in ${m.scene}` : `${m.scene} -> ${m.next || ''}`}`);
    for (const d of out.downgrades) console.log('  downgrade: ' + d);
  }
  for (const w of warnings) console.log('warning: ' + w);
}
if (opt.strict && warnings.length) process.exit(1);
