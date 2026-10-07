#!/usr/bin/env node
// Frame QA and the technical gate, all headless through the ?render page hooks.
//   contact / strip / crop   look at the film at three zoom levels (whole film, one motion, pixels)
//   text-check               machine checks on every text drawn: size at 1080p, read dwell,
//                            on-screen text repeating the narration, write-ons ending before a move
//   ascii                    film JavaScript must be ASCII-only
//   null                     the audio null test: render the mix twice and compare sample by sample
//   check                    the technical reviewer: deliverables, loudness, captions, purity (frames
//                            and mix), glyphs and the text checks, as rubric JSON (reviewer "technical")
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFilm, openFilm, measureDeliverables, variantSizes, loudness, PHONE_LIMIT, RENDER_ONLY, htmlText, artifactIssues, listFiles } from './export.mjs';

const HELP = `Usage: node tools/qa.mjs <command> [options]

Commands
  contact [--times a,b,...|--every <s>] [--cols 4] [--width 480]
                     grid of labelled thumbnails -> <out>/contact.jpg
  strip <t> [--span 0.6] [--n 8] [--cols 4] [--width 640]
                     frames around one motion -> <out>/strip-tNNN.NN.jpg
  crop <t> <x,y,w,h> [--scale 2]
                     a region in 1080-line pixels (a 1920x1080 frame for 16:9), zoomed with
                     square pixels -> <out>/crop-tNNN.NN-X_Y_W_H.png
  text-check [--step 0.1] [--min-px 28] [--min-read 1.2] [--json]
                     samples every text the film draws: size >= min-px at 1080p (camera finale
                     windows exempt), each text fully written and visible >= min-read seconds,
                     no on-screen text repeating the line being spoken (>= 6 consecutive words,
                     or >= 80% of a 5+ word sentence), write-ons ending >= 0.3 s before a camera
                     move or cut. Exit 1 on any finding.
  ascii              fail on any non-ASCII byte in web/js/*.js and web/film/**/*.js
  null [--limit -60] [--json]
                     render the offline mix twice and compare sample by sample; passes when the
                     peak difference is under --limit dBFS (render-to-render float noise, far
                     below hearing, is expected; a real difference means audio depends on state)
  check [--json] [--from <dir>] [--cut <id>] [--step 0.1]
                     the technical gate over the deliverables in <dir> (default <film>/out);
                     --json prints rubric JSON (reviewer "technical"). Exit 1 unless it ships.

Options
  --film <dir>       film directory (default: current directory)
  --out <dir>        where images go (default <film>/work/qa)
  --chromium <path>  Chromium binary
  -h, --help         this help

Check ids (defects cite them)
  TECH-1 duration +-1 s      TECH-6 transcript           TECH-11 narration repeat
  TECH-2 loudness +-0.5 LU   TECH-7 frame + mix purity   TECH-12 write-on before move
  TECH-3 true peak <= -1     TECH-8 glyph test           TECH-13 ASCII-only JS
  TECH-4 phone < 30 MiB      TECH-9 text size            TECH-14 streams and frame size
  TECH-5 captions            TECH-10 read dwell          TECH-15 hostable page (its static
                                                         <title>; page-artifact/ when present)`;

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error(...a);
const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const tag = (t) => t.toFixed(2).padStart(6, '0');
const dataUrlBytes = (u) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('='), k = eq > 0 ? a.slice(2, eq) : a.slice(2), v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v == null) throw new Error(`option --${k} needs a value`);
      o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    } else o._.push(a);
  }
  return o;
}
const num = (v, d) => (v == null ? d : Number(v));

// ---------------------------------------------------------------- labels for frames
function sceneAt(f, t) {
  const sc = (f.sb.scenes || []).filter((s) => !s.overlay && t >= s.at && t < s.until);
  return sc.length ? sc[sc.length - 1].id : '';
}
function wordAt(f, t) {
  for (const v of f.vo) for (const w of v.words || []) if (t >= w.s && t <= w.e) return w.w;
  return '';
}
const label = (f, t) => [`${t.toFixed(2)} s`, sceneAt(f, t), wordAt(f, t) && `"${wordAt(f, t)}"`].filter(Boolean).join('  ');

async function images(cmd, f, o) {
  const out = path.resolve(o.out || path.join(f.film, 'work', 'qa'));
  fs.mkdirSync(out, { recursive: true });
  const F = await openFilm(f, o);
  try {
    const dur = F.info.dur;
    let file;
    if (cmd === 'contact') {
      let times;
      if (o.times) times = o.times.split(',').map((s) => (s.trim() === 'poster' ? F.info.posterT : Number(s)));
      else {
        const every = num(o.every, dur <= 12 ? 0.5 : dur <= 48 ? 2 : Math.max(2, Math.round(dur / 24 / 0.5) * 0.5));
        times = [];
        for (let t = every / 2; t < dur; t += every) times.push(+t.toFixed(3));
      }
      if (!times.length || !times.every((t) => isFinite(t) && t >= 0 && t <= dur)) throw new Error(`times must be within 0-${dur} s`);
      const url = await F.page.evaluate((a) => window.FILM.X.sheet(a), { items: times.map((t) => ({ t, label: label(f, t) })), cols: num(o.cols, 4), tw: num(o.width, 480) });
      file = path.join(out, 'contact.jpg');
      fs.writeFileSync(file, dataUrlBytes(url));
      console.log(`${file}  (${times.length} frames: ${times[0]}-${times[times.length - 1]} s)`);
    } else if (cmd === 'strip') {
      const t = Number(o._[1]), span = num(o.span, 0.6), n = Math.max(2, num(o.n, 8));
      if (!isFinite(t)) throw new Error('strip needs a time: qa.mjs strip <t>');
      const fps = F.info.fps, times = [...Array(n)].map((_, i) => Math.round(Math.min(dur, Math.max(0, t - span / 2 + (i * span) / (n - 1))) * fps) / fps); // on real frame times
      const url = await F.page.evaluate((a) => window.FILM.X.sheet(a), { items: times.map((x) => ({ t: x, label: `${x.toFixed(3)} s  f${Math.round(x * F.info.fps)}` })), cols: num(o.cols, 4), tw: num(o.width, 640) });
      file = path.join(out, `strip-t${tag(t)}.jpg`);
      fs.writeFileSync(file, dataUrlBytes(url));
      console.log(`${file}  (${n} frames over ${span} s)`);
    } else {
      const t = Number(o._[1]), rect = String(o._[2] || '').split(',').map(Number);
      if (!isFinite(t) || rect.length !== 4 || !rect.every(isFinite)) throw new Error('crop needs a time and a rectangle: qa.mjs crop <t> <x,y,w,h>');
      const [x, y, w, h] = rect;
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > F.info.RW + 0.5 || y + h > F.info.RH + 0.5) throw new Error(`the rectangle must lie inside the ${F.info.RW}x${F.info.RH} frame`);
      const url = await F.page.evaluate((a) => window.FILM.X.crop(a), { t, rect, scale: num(o.scale, 2) });
      file = path.join(out, `crop-t${tag(t)}-${rect.join('_')}.png`);
      fs.writeFileSync(file, dataUrlBytes(url));
      console.log(file);
    }
    return F.errors.length ? 1 : 0;
  } finally { await F.close(); }
}

// ---------------------------------------------------------------- text checks
async function sampleAll(F, times, pages) {
  const extra = await Promise.all([...Array(Math.max(0, pages - 1))].map(() => F.newPage()));
  const all = [F.page].concat(extra), res = new Array(times.length);
  let next = 0;
  await Promise.all(all.map(async (p) => { while (next < times.length) { const i = next++; res[i] = await p.evaluate((t) => window.__film.text(t), times[i]); } }));
  await Promise.all(extra.map((p) => p.close()));
  return res;
}
const words = (s) => String(s).toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
function longestRun(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = up;
    }
  }
  return best;
}

// textCheck(f, F, o) -> {ok, step, samples, size, dwell, repeat, writeon}
export async function textCheck(f, F, o = {}) {
  const step = num(o.step, 0.1), minPx = num(o.minPx, 28), minRead = num(o.minRead, 1.2), dur = F.info.dur, RW = F.info.RW, RH = F.info.RH;
  const moves = await F.page.evaluate(() => window.__film.moves());
  const finale = moves.filter((m) => m.finale).map((m) => m.from);
  const finaleAt = finale.length ? Math.min(...finale) : Infinity;
  const events = moves.map((m) => m.from);
  if ((f.sb.layout || {}).type !== 'board') for (const s of (f.sb.scenes || []).filter((x) => !x.overlay && x.at > 0)) events.push(s.at);
  const times = [];
  for (let t = 0; t < dur - 1e-6; t += step) times.push(+t.toFixed(4));
  const samples = await sampleAll(F, times, Math.min(4, Math.max(1, Math.round(times.length / 40))));
  const size = {}, series = {};
  const visFrac = (b) => {
    const ix = Math.max(0, Math.min(b[0] + b[2], RW) - Math.max(b[0], 0)), iy = Math.max(0, Math.min(b[1] + b[3], RH) - Math.max(b[1], 0));
    return b[2] * b[3] > 0 ? (ix * iy) / (b[2] * b[3]) : 0;
  };
  const repeat = {};
  samples.forEach((texts, i) => {
    const t = times[i], line = f.vo.find((v) => t >= v.at - 0.25 && t <= v.at + v.dur + 0.5), vw = line ? words(line.text) : [];
    const seen = {};
    for (const x of texts) {
      const key = x.id || x.text, vf = visFrac(x.bbox), visible = x.alpha >= 0.5 && vf >= 0.5;
      const pt = { t, p: x.progress, shown: visible && x.progress >= 0.999, legible: x.px1080 >= minPx };
      const s = (series[key] = series[key] || { text: x.text, pts: [], before: false });
      if (visible && t < finaleAt - 1e-6) s.before = true;
      if (!seen[key]) { s.pts.push(pt); seen[key] = pt; }
      else { seen[key].shown = seen[key].shown || pt.shown; seen[key].legible = seen[key].legible || pt.legible; } // one id, several pieces (chart labels)
      s.text = x.text;
      if (visible && t < finaleAt - 1e-6 && x.px1080 < minPx) {
        const e = size[key];
        if (!e || x.px1080 < e.px) size[key] = { id: key, text: x.text, px: x.px1080, at: e ? e.at : t };
      }
      if (line && x.alpha >= 0.3 && vf > 0 && x.progress >= 0.5 && !repeat[key]) {
        const ow = words(x.text);
        if (ow.length >= 2) {
          const run = longestRun(ow, vw), set = new Set(vw), share = ow.filter((w) => set.has(w)).length / ow.length;
          if (run >= 6 || (ow.length >= 5 && share >= 0.8)) repeat[key] = { id: key, text: x.text, line: line.id, at: t, run, share: +share.toFixed(2) };
        }
      }
    }
  });
  // dwell: the longest unbroken run of readable samples (fully written and visible). Inside the
  // finale pull-back, text already seen before it counts only while still legible (so board text
  // shrinking into the wide shot earns nothing, an end card does); text first seen in the finale
  // is measured there with the size exemption the size check gives it.
  const dwell = [];
  for (const [key, s] of Object.entries(series)) {
    let best = 0, run = 0, last = -Infinity;
    for (const q of s.pts) {
      const ok = q.shown && (q.t < finaleAt - 1e-6 || q.legible || !s.before);
      run = ok ? (q.t - last <= step * 1.5 ? run + step : step) : 0;
      if (ok) last = q.t;
      if (run > best) best = run;
    }
    if (best + 1e-6 < minRead) dwell.push({ id: key, text: s.text, seconds: +best.toFixed(2), first: s.pts[0].t });
  }
  // write-ons: progress rising to 1; refine the finish time by bisection, compare with the next
  // camera move or cut that starts after the write-on began
  const writeon = [];
  const progressAt = async (key, t) => { const xs = await F.page.evaluate((u) => window.__film.text(u), t); const x = xs.find((y) => (y.id || y.text) === key); return x ? x.progress : 0; };
  for (const [key, s] of Object.entries(series)) {
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1], b = s.pts[i];
      if (!(a.p < 0.999 && a.p > 0 && b.p >= 0.999 && b.t - a.t <= step * 1.5)) continue;
      let j = i - 1;
      while (j > 0 && s.pts[j - 1].p > 0 && s.pts[j - 1].p < 0.999 && s.pts[j].t - s.pts[j - 1].t <= step * 1.5) j--;
      const start = s.pts[j].t, next = events.filter((e) => e >= start - 1e-6).sort((x, y) => x - y)[0];
      if (next == null || next - b.t >= 0.5) continue;
      let lo = a.t, hi = b.t;
      for (let k = 0; k < 5; k++) { const mid = (lo + hi) / 2; if ((await progressAt(key, mid)) >= 0.999) hi = mid; else lo = mid; }
      if (next - hi < 0.3) writeon.push({ id: key, text: s.text, done: +hi.toFixed(3), move: next, gap: +(next - hi).toFixed(3) });
    }
  }
  const r = { step, samples: times.length, min_px: minPx, min_read: minRead, finale_from: isFinite(finaleAt) ? finaleAt : null,
    size: Object.values(size), dwell, repeat: Object.values(repeat), writeon };
  r.ok = !(r.size.length || r.dwell.length || r.repeat.length || r.writeon.length);
  return r;
}
function printText(r) {
  console.log(`text-check: ${r.samples} samples every ${r.step} s${r.finale_from != null ? `, size exempt from ${r.finale_from} s (finale)` : ''}`);
  const sec = (name, list, fmt) => { console.log(`  ${list.length ? 'FAIL' : 'ok  '} ${name}${list.length ? ':' : ''}`); for (const x of list) console.log('       ' + fmt(x)); };
  sec(`text >= ${r.min_px} px at 1080p`, r.size, (x) => `${fmtT(x.at)} "${x.text}" (${x.id}) is ${x.px} px`);
  sec(`every text readable >= ${r.min_read} s`, r.dwell, (x) => `"${x.text}" (${x.id}) readable for ${x.seconds} s`);
  sec('no text repeating the narration', r.repeat, (x) => `${fmtT(x.at)} "${x.text}" repeats line ${x.line} (${x.run} words in a row, ${Math.round(x.share * 100)}% shared)`);
  sec('write-ons end >= 0.3 s before a camera move', r.writeon, (x) => `"${x.text}" finishes at ${x.done} s, ${x.gap} s before the move at ${x.move} s`);
}

// ---------------------------------------------------------------- ascii
function asciiCheck(f) {
  const files = [], walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  for (const e of fs.existsSync(path.join(f.web, 'js')) ? fs.readdirSync(path.join(f.web, 'js')) : []) if (e.endsWith('.js')) files.push(path.join(f.web, 'js', e));
  walk(path.join(f.web, 'film'));
  const bad = [];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    let line = 1, col = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) { line++; col = 0; continue; }
      col++;
      if (buf[i] > 127) { bad.push({ file: path.relative(f.film, file), line, col }); while (i + 1 < buf.length && buf[i + 1] > 127) i++; }
    }
  }
  return { files: files.length, bad };
}

// ---------------------------------------------------------------- audio null test
// nullTest(f, o) -> {ok, peak_dbfs, rms_dbfs, identical, limit_dbfs, sha256: [a, b]} or {ok: false, error}.
// The mix is a pure function of the storyboard and its assets, but floating-point processing in the
// browser's OfflineAudioContext may differ in the last bits between renders (around -90 dBFS): that
// is expected and inaudible. A difference above the limit means some sound depends on state or time.
export function nullTest(f, o = {}) {
  const limit = num(o.limit, -60), dir = path.join(f.film, 'work', 'qa');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['null-a.wav', 'null-b.wav'].map((n) => path.join(dir, n));
  for (const file of files) {
    const r = spawnSync(process.execPath, [path.join(here, 'render.mjs'), 'audio', '--film', f.film, '--out', file].concat(o.chromium ? ['--chromium', o.chromium] : []), { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, error: `render.mjs audio failed: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}` };
  }
  const L = loudness(), bytes = files.map((file) => fs.readFileSync(file)), [a, b] = bytes.map((x) => L.wavDecode(x));
  const sha256 = bytes.map((x) => crypto.createHash('sha256').update(x).digest('hex'));
  if (a.chans.length !== b.chans.length || a.chans[0].length !== b.chans[0].length) return { ok: false, error: 'the two renders differ in length or channel count', sha256 };
  let peak = 0, sum = 0, n = 0;
  for (let c = 0; c < a.chans.length; c++) {
    const x = a.chans[c], y = b.chans[c];
    for (let i = 0; i < x.length; i++) { const d = x[i] - y[i], m = Math.abs(d); if (m > peak) peak = m; sum += d * d; n++; }
  }
  const db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : null);
  const ok = peak === 0 || db(peak) < limit;
  if (ok) for (const file of files) fs.rmSync(file, { force: true });
  return { ok, identical: sha256[0] === sha256[1], peak_dbfs: db(peak), rms_dbfs: db(Math.sqrt(sum / Math.max(1, n))), limit_dbfs: limit, sha256 };
}
const nullText = (nt) => (nt.error ? nt.error : nt.identical ? 'mix renders identical' : `mix null peak ${nt.peak_dbfs} dBFS (rms ${nt.rms_dbfs})`);

// ---------------------------------------------------------------- check (technical reviewer)
function parseCues(text) {
  return text.split(/\r?\n\r?\n/).map((b) => /(\d+):(\d\d):(\d\d)[,.](\d{3}) --> (\d+):(\d\d):(\d\d)[,.](\d{3})/.exec(b)).filter(Boolean)
    .map((m) => ({ start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000 }));
}
function renderTool(f, o, mode) {
  const r = spawnSync(process.execPath, [path.join(here, 'render.mjs'), mode, '--film', f.film].concat(o.chromium ? ['--chromium', o.chromium] : []), { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON: reported through the exit status */ }
  return { ok: r.status === 0, json, stderr: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
}

export async function check(f, o = {}) {
  const outDir = path.resolve(o.from || path.join(f.film, 'out')), checks = [], defects = [];
  const add = (id, name, ok, value, found) => {
    checks.push({ id, name, ok, value });
    for (const d of ok ? [] : found) defects.push(Object.assign({ at: '0:00', check: id }, d));
  };
  const B = 'blocking', MAJ = 'major';

  // deliverables: container facts and loudness (ffmpeg when present, else Chromium + loudness.js)
  const files = fs.existsSync(outDir) ? await measureDeliverables(f, outDir, o) : [];
  const expect = Object.fromEntries(variantSizes(f.size, ['master', 'share', 'phone']).map((v) => [v.id, [v.w, v.h]]));
  expect.webm = expect.phone;
  const vids = files.filter((x) => x.video);
  const bundleDir = path.join(outDir, `${f.slug}-bundle`);
  const bundle = !vids.length && fs.existsSync(path.join(bundleDir, 'mix.wav'));
  add('TECH-1', 'duration within 1 s of the film', vids.length > 0 && vids.every((x) => Math.abs(x.duration - f.duration) <= 1),
    vids.map((x) => `${x.id} ${x.duration} s`).join(', ') || (bundle ? 'bundle only (no video file)' : 'no video file'),
    vids.length ? vids.filter((x) => Math.abs(x.duration - f.duration) > 1).map((x) => ({ severity: B, issue: `${x.path} lasts ${x.duration} s; the film is ${f.duration} s`, fix: 'export again; check meta.duration and the frame count' }))
      : [{ severity: B, issue: bundle ? `only a frames + WAV bundle in ${path.relative(f.film, outDir)}; no video file to check` : `no MP4 or WebM in ${path.relative(f.film, outDir)}`, fix: 'run tools/export.mjs (an MP4 mode) first' }]);
  let loud = vids.map((x) => ({ id: x.id, path: x.path, I: x.lufs, TP: x.true_peak, by: x.loudness_by }));
  if (bundle) {
    const L = loudness(), w = L.wavDecode(fs.readFileSync(path.join(bundleDir, 'mix.wav'))), m = L.measure(w.chans, w.sr);
    loud = [{ id: 'bundle', path: path.relative(f.film, path.join(bundleDir, 'mix.wav')), I: m.I, TP: m.TP, by: 'loudness.js' }];
  }
  const target = num(o.lufs, -14.5);
  if (loud.length && loud.every((x) => x.I == null && x.TP == null)) loud = loud.map((x) => Object.assign(x, { I: target, by: 'silent: nothing to normalize' }));
  add('TECH-2', `integrated loudness ${target} +-0.5 LUFS`, loud.length > 0 && loud.every((x) => x.I != null && Math.abs(x.I - target) <= 0.5), loud.map((x) => `${x.id} ${x.I} LUFS (${x.by})`).join(', ') || 'nothing measured',
    loud.length ? loud.filter((x) => !(x.I != null && Math.abs(x.I - target) <= 0.5)).map((x) => ({ severity: B, issue: `${x.path} measures ${x.I} LUFS`, fix: 'export again; the exporter normalizes to -14.5 LUFS' }))
      : [{ severity: B, issue: 'no audio to measure', fix: 'export first' }]);
  add('TECH-3', 'true peak <= -1 dBTP', loud.length > 0 && loud.every((x) => x.TP == null || x.TP <= -1), loud.map((x) => `${x.id} ${x.TP} dBTP`).join(', ') || 'nothing measured',
    loud.filter((x) => x.TP != null && x.TP > -1).map((x) => ({ severity: B, issue: `${x.path} peaks at ${x.TP} dBTP`, fix: 'export again with a lower --tp' })).concat(loud.length ? [] : [{ severity: B, issue: 'no audio to measure', fix: 'export first' }]));
  const phone = vids.find((x) => x.id === 'phone');
  add('TECH-4', 'phone copy under 30 MiB', !phone || phone.bytes < PHONE_LIMIT, vids.map((x) => `${x.id} ${(x.bytes / 1048576).toFixed(2)} MiB`).join(', ') || 'no files',
    phone ? [{ severity: B, issue: `${phone.path} is ${(phone.bytes / 1048576).toFixed(1)} MiB`, fix: 'export the phone variant again (it lowers the bitrate until it fits)' }] : []);
  // captions
  const srtF = path.join(outDir, `${f.slug}.srt`), vttF = path.join(outDir, `${f.slug}.vtt`), cap = [];
  const needCues = f.vo.some((v) => String(v.text || '').trim());
  for (const [file, head] of [[srtF, null], [vttF, 'WEBVTT']]) {
    if (!fs.existsSync(file)) { cap.push({ severity: B, issue: `${path.basename(file)} is missing`, fix: 'run tools/export.mjs' }); continue; }
    const text = fs.readFileSync(file, 'utf8'), cues = parseCues(text);
    if (head && !text.startsWith(head)) cap.push({ severity: B, issue: `${path.basename(file)} does not start with ${head}`, fix: 'export again' });
    if (needCues && !cues.length) cap.push({ severity: B, issue: `${path.basename(file)} has no cues but the film has narration`, fix: 'check vo lines in the resolved storyboard' });
    for (const c of cues) if (!(c.end > c.start) || c.end > f.duration + 0.5) { cap.push({ severity: MAJ, at: fmtT(c.start), issue: `${path.basename(file)} cue ${c.start}-${c.end} s is empty or runs past the film`, fix: 'check the word timings' }); break; }
  }
  for (const x of vids.filter((v) => v.path.endsWith('.mp4') && !v.subtitles.length)) cap.push({ severity: 'minor', issue: `${x.path} has no subtitle track`, fix: 'export again (soft captions are added when the encoder supports them)' });
  add('TECH-5', 'captions: SRT and VTT', !cap.some((d) => d.severity === B || d.severity === MAJ), `${fs.existsSync(srtF) ? parseCues(fs.readFileSync(srtF, 'utf8')).length : 0} cues`, cap);
  if (cap.length && !cap.some((d) => d.severity === B || d.severity === MAJ)) for (const d of cap) defects.push(Object.assign({ at: '0:00', check: 'TECH-5' }, d));
  // transcript
  const trF = path.join(outDir, 'transcript.md'), tr = fs.existsSync(trF) ? fs.readFileSync(trF, 'utf8').replace(/\s+/g, ' ') : null;
  const missing = tr == null ? [] : f.vo.filter((v) => !tr.includes(String(v.text || '').replace(/\s+/g, ' ').trim()));
  add('TECH-6', 'transcript with every narration line', tr != null && !missing.length, tr == null ? 'missing' : `${f.vo.length - missing.length}/${f.vo.length} lines`,
    tr == null ? [{ severity: B, issue: 'transcript.md is missing', fix: 'run tools/export.mjs' }] : missing.map((v) => ({ severity: B, issue: `transcript.md lacks line ${v.id}`, fix: 'export again' })));
  // purity and glyphs (tools/render.mjs)
  const pur = renderTool(f, o, 'purity'), nt = nullTest(f, o);
  const frameDefects = pur.ok ? [] : pur.json && pur.json.mismatches.length ? pur.json.mismatches.map((t) => ({ severity: B, at: fmtT(t), issue: `the frame at ${t} s depends on render order or page state`, fix: 'remove Math.random, Date, performance.now and state carried between frames from shot code' }))
    : [{ severity: B, issue: `purity check failed: ${pur.stderr}`, fix: 'run node tools/render.mjs purity and fix the page errors' }];
  const mixDefects = nt.ok ? [] : [{ severity: B, issue: nt.error || `two renders of the mix differ by up to ${nt.peak_dbfs} dBFS (limit ${nt.limit_dbfs})`, fix: 'look for Math.random, Date or state carried between calls in audio or sfx code; run node tools/qa.mjs null' }];
  add('TECH-7', 'frames and the audio mix are pure functions of time', pur.ok && nt.ok,
    `${pur.json ? `${pur.json.samples} samples, ${pur.json.mismatches.length} mismatches` : pur.stderr}; ${nullText(nt)}`, frameDefects.concat(mixDefects));
  const gl = renderTool(f, o, 'glyph');
  const faces = (gl.json && gl.json.faces) || [];
  add('TECH-8', 'every font advances every letter; every declared face loads', gl.ok, gl.json ? `${gl.json.details.length} checks, ${faces.length} faces` : gl.stderr,
    gl.json ? gl.json.details.filter((d) => !d.ok).map((d) => ({ severity: B, issue: `font ${d.font} swallows letters in "${d.text}" (min advance ${d.minAdvance})`, fix: 'use another font or ship the font file via config.fonts.faces' }))
      .concat(faces.filter((x) => !(x.loaded && x.check)).map((x) => ({ severity: B, issue: `font face "${x.family}" (${x.src}) did not load${x.error ? ': ' + x.error : ''}`, fix: 'fix the path or the file under web/fonts/, or the family name in film.json style.fonts' })))
      : [{ severity: B, issue: `glyph test failed: ${gl.stderr}`, fix: 'run node tools/render.mjs glyph' }]);
  // text checks
  const F = await openFilm(f, o);
  let tc;
  try { tc = await textCheck(f, F, o); } finally { await F.close(); }
  add('TECH-9', `text >= ${tc.min_px} px at 1080p`, !tc.size.length, `${tc.size.length} small texts`,
    tc.size.map((x) => ({ severity: B, at: fmtT(x.at), issue: `"${x.text}" is ${x.px} px at 1080p`, fix: `set its size (or the camera zoom) so it draws at >= ${tc.min_px} px` })));
  add('TECH-10', `every text readable >= ${tc.min_read} s`, !tc.dwell.length, `${tc.dwell.length} short reads`,
    tc.dwell.map((x) => ({ severity: B, at: fmtT(x.first), issue: `"${x.text}" is fully written and on screen for ${x.seconds} s`, fix: 'start the write-on earlier or hold the shot longer' })));
  add('TECH-11', 'no on-screen text repeating the narration', !tc.repeat.length, `${tc.repeat.length} repeats`,
    tc.repeat.map((x) => ({ severity: B, at: fmtT(x.at), issue: `"${x.text}" repeats narration line ${x.line} while it is spoken`, fix: 'show a keyword, label or number instead of the sentence' })));
  add('TECH-12', 'write-ons end >= 0.3 s before a camera move', !tc.writeon.length, `${tc.writeon.length} late write-ons`,
    tc.writeon.map((x) => ({ severity: MAJ, at: fmtT(x.done), issue: `"${x.text}" finishes writing ${x.gap} s before the camera moves at ${x.move} s`, fix: 'start the write-on earlier or move the camera later' })));
  const asc = asciiCheck(f);
  add('TECH-13', 'film JavaScript is ASCII-only', !asc.bad.length, `${asc.files} files`,
    asc.bad.slice(0, 10).map((b) => ({ severity: MAJ, issue: `non-ASCII byte at ${b.file}:${b.line}:${b.col}`, fix: 'use \\u escapes in strings' })));
  const st = [];
  for (const x of vids) {
    const exp = expect[x.id], okV = /^(h264|avc|vp9|vp8|av1)/.test(String(x.video)), okA = !!x.audio;
    if (!okV || !okA) st.push({ severity: B, issue: `${x.path}: video ${x.video}, audio ${x.audio}`, fix: 'export again' });
    if (exp && (x.width !== exp[0] || x.height !== exp[1])) st.push({ severity: B, issue: `${x.path} is ${x.width}x${x.height}; expected ${exp[0]}x${exp[1]}`, fix: 'export again; check config size' });
  }
  add('TECH-14', 'streams and frame sizes', vids.length > 0 && !st.length, vids.map((x) => `${x.id} ${x.width}x${x.height} ${x.video}+${x.audio}${x.subtitles.length ? '+' + x.subtitles.join(',') : ''}`).join(', ') || 'no files',
    vids.length ? st : [{ severity: B, issue: 'no video file', fix: 'export first' }]);
  const page = path.join(outDir, 'page'), pageIssues = [];
  for (const need of ['index.html', 'js/main.js', 'film/config.json', 'film/storyboard.json']) if (!fs.existsSync(path.join(page, need))) pageIssues.push({ severity: MAJ, issue: `page/${need} is missing`, fix: 'run tools/export.mjs' });
  for (const extra of RENDER_ONLY) if (fs.existsSync(path.join(page, extra))) pageIssues.push({ severity: MAJ, issue: `page/${extra} is render-only and should not be hosted`, fix: 'export again' });
  // the static title, read by hosts that never run the page's script
  const index = path.join(page, 'index.html'), shown = fs.existsSync(index) && /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(index, 'utf8'));
  if (fs.existsSync(index) && !(shown && shown[1] === htmlText(f.title))) pageIssues.push({ severity: MAJ, issue: `page/index.html's static <title> is ${shown ? `"${shown[1]}"` : 'missing'}, not the film's title`, fix: 'export again (tools/export.mjs writes it from web/film/config.json)' });
  // the artifact-ready variant (export --host artifact), when there is one
  const art = path.join(outDir, 'page-artifact');
  if (fs.existsSync(art)) {
    const have = new Set(listFiles(art));
    for (const rel of fs.existsSync(page) ? listFiles(page) : []) if (!have.has(rel)) pageIssues.push({ severity: MAJ, issue: `page-artifact/${rel} is missing (page/ has it)`, fix: 'export again with --host artifact' });
    for (const x of artifactIssues(art)) pageIssues.push({ severity: MAJ, issue: `page-artifact/${x.where}: ${x.issue}`, fix: 'refer to every file by a relative path inside web/, then export again with --host artifact' });
  }
  add('TECH-15', 'hostable page bundle', !pageIssues.length, fs.existsSync(page) ? `page/${fs.existsSync(art) ? ', page-artifact/' : ''}` : 'missing', pageIssues);

  const blocking = defects.some((d) => d.severity === B), major = defects.some((d) => d.severity === MAJ);
  const order = { blocking: 0, major: 1, minor: 2, nit: 3 };
  defects.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check, 'en', { numeric: true }));
  return { reviewer: 'technical', cut: o.cut || 'final', scores: {}, defects: defects.map((d) => ({ at: d.at, severity: d.severity, check: d.check, issue: d.issue, fix: d.fix })),
    verdict: blocking || major ? 'iterate' : 'ship', checks, text_check: tc, files };
}
function printCheck(r) {
  console.log(`technical check (${r.cut}): ${r.verdict.toUpperCase()}`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(8)} ${c.name.padEnd(46)} ${c.value}`);
  if (r.defects.length) console.log('defects:');
  for (const d of r.defects) console.log(`  [${d.severity}] ${d.check} ${d.at} ${d.issue} -> ${d.fix}`);
}

// ---------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2)), cmd = o._[0];
  if (o.help || !cmd) { console.log(HELP); return cmd || o.help ? 0 : 2; }
  const f = loadFilm(o.film);
  if (['contact', 'strip', 'crop'].includes(cmd)) return images(cmd, f, o);
  if (cmd === 'ascii') {
    const r = asciiCheck(f);
    for (const b of r.bad) console.log(`${b.file}:${b.line}:${b.col}: non-ASCII byte`);
    console.log(`ascii: ${r.files} files, ${r.bad.length} non-ASCII ${r.bad.length === 1 ? 'run' : 'runs'}`);
    return r.bad.length ? 1 : 0;
  }
  if (cmd === 'null') {
    const r = nullTest(f, o);
    if (o.json) console.log(JSON.stringify(r, null, 1));
    else console.log(`audio null test: ${r.ok ? 'ok' : 'FAIL'} - ${nullText(r)}${r.ok ? '' : ` (limit ${r.limit_dbfs} dBFS)`}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'text-check') {
    const F = await openFilm(f, o);
    let r;
    try { r = await textCheck(f, F, o); } finally { await F.close(); }
    if (o.json) console.log(JSON.stringify(r, null, 1)); else printText(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'check') {
    const r = await check(f, o);
    if (o.json) {
      const { text_check: _t, files: _f, ...rubric } = r;
      console.log(JSON.stringify(rubric, null, 1));
    } else printCheck(r);
    return r.verdict === 'ship' ? 0 : 1;
  }
  log(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { log(e.message || e); process.exitCode = 1; });
}
