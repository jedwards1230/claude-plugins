#!/usr/bin/env node
// Delivery: one entry point for every output mode.
//   ffmpeg     render frames + mix (tools/render.mjs), then tools/mux.sh: two-pass loudnorm,
//              H.264 + AAC, soft subtitles, master/share/phone variants. Best quality.
//   webcodecs  no ffmpeg needed: the ?render page encodes H.264 + Opus MP4s frame-exactly with
//              WebCodecs and Mediabunny; loudness via web/js/loudness.js (BS.1770-4).
//   webm       MediaRecorder real-time capture (VP9/VP8 + Opus). Not frame-exact; last resort.
//   bundle     JPEG frames + normalized mix.wav + captions + a README with the ffmpeg command.
// Every mode also writes <out>/<slug>.srt and .vtt, transcript.md, page/ (the live player, ready
// to host, with the film's title and description in its static tags) and export.json (what was
// made, how, the measured loudness and the mix's SHA-256); --host artifact adds page-artifact/.
// The functions exported here are shared with tools/qa.mjs; importing this file runs nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// playwright-core and render.mjs load on first use, so --help works before npm install
let RT = null;
async function runtime() {
  if (!RT) { const [pw, r] = await Promise.all([import('playwright-core'), import('./render.mjs')]); RT = Object.assign({ chromium: pw.chromium }, r); }
  return RT;
}

const HELP = `Usage: node tools/export.mjs [--film <dir>] [--mode auto|ffmpeg|webcodecs|webm|bundle] [options]
       node tools/export.mjs --probe [--film <dir>]

Modes
  auto        ffmpeg if ffmpeg and ffprobe are on PATH, else webcodecs if this Chromium can
              encode H.264 + Opus, else webm if MediaRecorder can record WebM, else bundle
  ffmpeg      H.264 + AAC MP4s via tools/mux.sh (two-pass loudnorm, soft mov_text subtitles)
  webcodecs   H.264 + Opus MP4s encoded in the page (WebCodecs + Mediabunny), WebVTT track
  webm        real-time MediaRecorder capture to <slug>.webm (not frame-exact)
  bundle      <slug>-bundle/ (frames, normalized mix.wav, captions, README) and a .tar

Options
  --film <dir>        film directory (default: current directory)
  --out <dir>         output directory (default: <film>/out)
  --variants <list>   MP4 variants, comma list of master,share,phone (default: all three)
                      master: 1080-line, share: same size and smaller file, phone: 720-line and
                      under 30 MiB
  --lufs <x>          integrated loudness target (default -14.5)
  --tp <x>            true-peak ceiling in dBTP (default -1.2 for ffmpeg, -1.5 for the
                      in-browser limiter, which leaves room for Opus overshoot)
  --lra <x>           loudness range target for ffmpeg loudnorm (default 11)
  --workers <n>       parallel pages for frame rendering (ffmpeg and bundle modes)
  --keep-frames       keep work/export-frames after an ffmpeg export
  --host <h>          web (default): page/ is a whole HTML document for any static host.
                      artifact: also page-artifact/, the same files with index.html as a
                      fragment (no doctype, html, head or body tags) and only relative
                      same-origin file references, for hosts that wrap a page in their own
                      document (a Claude artifact viewer); fails if the page uses another host
  --probe             print what this machine can do (JSON) and exit
  --chromium <path>   Chromium binary (else env CHROMIUM_PATH, playwright's own, ~/.cache/ms-playwright)
  --verbose           print page messages
  -h, --help          this help`;

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error(...a);
export const PHONE_LIMIT = 30 * 1048576;

// ---------------------------------------------------------------- environment
function isExe(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
export function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(dir || '.', name); if (isExe(p)) return p; }
  return null;
}
export function binVersion(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split('\n')[0] || '').trim() : null;
}
// The browser bundle of mediabunny, searched upward from the film and from this file.
export function mediabunnyBundle(film) {
  for (let d of [film, here]) {
    for (;;) {
      const p = path.join(d, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.mjs');
      if (fs.existsSync(p)) return p;
      const up = path.dirname(d); if (up === d) break; d = up;
    }
  }
  return null;
}
// web/js/loudness.js evaluated in Node (FILM.LOUD). A plain Function scope, not a vm context:
// vm globals are interceptors and make the sample loops about ten times slower.
let LOUD = null;
export function loudness() {
  if (!LOUD) { const root = {}; new Function('window', fs.readFileSync(path.join(here, '../web/js/loudness.js'), 'utf8'))(root); LOUD = root.FILM.LOUD; }
  return LOUD;
}

// ---------------------------------------------------------------- the film
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export function slugify(title) {
  const s = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'film';
}
export function loadFilm(dir) {
  const film = path.resolve(dir || '.'), web = path.join(film, 'web');
  const sbFile = path.join(web, 'film', 'storyboard.json');
  if (!fs.existsSync(sbFile)) throw new Error(`${sbFile} not found (run tools/resolve.mjs first, or pass --film <dir>)`);
  const cfgFile = path.join(web, 'film', 'config.json');
  const cfg = fs.existsSync(cfgFile) ? readJSON(cfgFile) : {}, sb = readJSON(sbFile), meta = sb.meta || {};
  const size = meta.size || cfg.size || [1920, 1080], fps = meta.fps || cfg.fps || 30, duration = meta.duration || cfg.duration || 5;
  const title = cfg.title || meta.title || 'Untitled film';
  const vo = (sb.vo || []).filter((v) => v && v.dur > 0).sort((a, b) => a.at - b.at);
  return { film, web, cfg, sb, size, fps, duration, title, slug: slugify(title), vo };
}
const creditText = (c) => (typeof c === 'string' ? c : `${c.role}: ${c.name}`);
// The AI-made note: page credits, transcript, MP4/WebM comment. config.disclosure.note "" turns it off.
export const disclosureNote = (cfg) => { const n = cfg.disclosure && cfg.disclosure.note; return n == null ? 'Made with AI. The credits list the models and tools used.' : String(n); };

// ---------------------------------------------------------------- captions and transcript
// Cues of at most `lines` x `chars` characters, split at word boundaries using the word times,
// at least `minDur` seconds long where the next cue leaves room, never overlapping.
export function captionCues(vo, duration, o = {}) {
  const chars = o.chars || 42, maxLines = o.lines || 2, minDur = o.minDur || 1.0;
  const wrap = (toks) => {
    const text = toks.join(' ');
    if (text.length <= chars) return [text];
    let best = null;
    for (let i = 1; i < toks.length; i++) {
      const a = toks.slice(0, i).join(' '), b = toks.slice(i).join(' '), m = Math.max(a.length, b.length);
      if (a.length <= chars && b.length <= chars && (!best || m < best.m)) best = { m, lines: [a, b] };
    }
    if (best) return best.lines;
    const out = []; let line = ''; // longer than two lines (only a single cue built from one huge word)
    for (const t of toks) { if (line && (line + ' ' + t).length > chars) { out.push(line); line = t; } else line = line ? line + ' ' + t : t; }
    return out.concat(line ? [line] : []);
  };
  const fits = (toks) => toks.length === 1 || wrap(toks).length <= maxLines;
  const cues = [];
  for (const v of vo) {
    const toks = String(v.text || '').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    let times;
    if (v.words && v.words.length === toks.length) times = v.words.map((w) => [w.s, w.e]);
    else { // no usable word times: spread the line by character count
      const total = toks.reduce((a, s) => a + s.length + 1, 0);
      let acc = 0;
      times = toks.map((s) => { const a = v.at + (v.dur * acc) / total; acc += s.length + 1; return [a, v.at + (v.dur * (acc - 1)) / total]; });
    }
    const lineCues = [];
    let cur = [];
    const flush = () => { if (cur.length) lineCues.push({ line: v.id, idx: cur.slice(), start: times[cur[0]][0], end: times[cur[cur.length - 1]][1] }); cur = []; };
    toks.forEach((tk, i) => {
      if (cur.length && !fits(cur.concat([i]).map((j) => toks[j]))) flush();
      cur.push(i);
      // a sentence ends: close the cue if it already carries a readable chunk
      if (/[.!?]["')\]]*$/.test(tk) && i < toks.length - 1 && cur.map((j) => toks[j]).join(' ').length >= 24) flush();
    });
    flush();
    // a short last cue (an orphan word or two) takes words from the cue before it while that
    // evens them out, never across a sentence end
    const len = (idx) => idx.map((j) => toks[j]).join(' ').length, ends = (j) => /[.!?]["')\]]*$/.test(toks[j]);
    const lastC = lineCues[lineCues.length - 1], prevC = lineCues[lineCues.length - 2];
    if (prevC && len(lastC.idx) < 20) {
      while (prevC.idx.length > 1 && !ends(prevC.idx[prevC.idx.length - 1])) {
        const a = prevC.idx.slice(0, -1), b = [prevC.idx[prevC.idx.length - 1]].concat(lastC.idx);
        if (!fits(b.map((j) => toks[j])) || Math.abs(len(a) - len(b)) >= Math.abs(len(prevC.idx) - len(lastC.idx))) break;
        prevC.idx = a; lastC.idx = b;
      }
      prevC.end = times[prevC.idx[prevC.idx.length - 1]][1]; lastC.start = times[lastC.idx[0]][0];
    }
    // merge cues that are too short into a neighbour on the same line when the text still fits
    for (let i = 0; i < lineCues.length; i++) {
      const c = lineCues[i];
      if (c.end - c.start >= minDur) continue;
      const nx = lineCues[i + 1], pv = lineCues[i - 1];
      if (nx && fits(c.idx.concat(nx.idx).map((j) => toks[j]))) { nx.idx = c.idx.concat(nx.idx); nx.start = c.start; lineCues.splice(i--, 1); }
      else if (pv && fits(pv.idx.concat(c.idx).map((j) => toks[j]))) { pv.idx = pv.idx.concat(c.idx); pv.end = c.end; lineCues.splice(i--, 1); }
    }
    for (const c of lineCues) cues.push({ line: c.line, start: c.start, end: c.end, lines: wrap(c.idx.map((j) => toks[j])) });
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((c, i) => {
    const next = cues[i + 1], cap = Math.min(next ? next.start - 0.04 : duration, duration);
    c.start = Math.max(0, +c.start.toFixed(3));
    c.end = +Math.max(c.start + 0.1, Math.min(Math.max(c.end + 0.25, c.start + minDur), cap)).toFixed(3);
  });
  return cues;
}
const stamp = (s, sep) => {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
export const toSRT = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
export const toVTT = (cues) => 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export function transcript(f) {
  const out = [`# ${f.title}`, ''];
  if (f.cfg.subtitle) out.push(f.cfg.subtitle, '');
  out.push(`Length: ${mmss(f.duration)}`, '', '## Narration', '');
  if (f.vo.length) for (const v of f.vo) out.push(String(v.text || '').trim(), '');
  else out.push('This film has no narration.', '');
  const credits = (f.cfg.credits || []).map(creditText);
  if (credits.length) { out.push('## Credits', ''); for (const c of credits) out.push(`- ${c}`); out.push(''); }
  if (disclosureNote(f.cfg)) out.push('## About this film', '', disclosureNote(f.cfg), '');
  return out.join('\n');
}
// The live page, ready to host: web/ minus the render-only scripts.
export const RENDER_ONLY = ['js/export.js', 'js/loudness.js'];
function copyPage(web, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(web, dest, { recursive: true, filter: (src) => !RENDER_ONLY.includes(path.relative(web, src).split(path.sep).join('/')) });
}
export const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])).sort();

// ---------------------------------------------------------------- the page's static tags
// Hosts that never run the page's script (link previews, galleries, a tab before main.js loads)
// read index.html's <title> and <meta name="description">. scripts/scaffold.py writes the same two
// tags with the same escaping (page_tags, html_text there): ASCII whitespace runs become one space,
// & < > " ' are escaped, anything outside ASCII becomes a numeric entity.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
export const htmlText = (s) => Array.from(String(s).replace(/[\t\n\r\f\v ]+/g, ' ').replace(/^ +| +$/g, ''))
  .map((c) => ENTITIES[c] || (c.codePointAt(0) > 127 ? `&#${c.codePointAt(0)};` : c)).join('');
// Only those two tags change; an empty description leaves its tag as it is.
export function pageTags(html, title, description) {
  const out = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${htmlText(title)}</title>`);
  return description ? out.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, () => `<meta name="description" content="${htmlText(description)}">`) : out;
}
export const pageMeta = (f) => ({ title: f.title, description: f.cfg.description || f.cfg.subtitle || '' });

// ---------------------------------------------------------------- the artifact-ready page
// Some hosts (a Claude artifact viewer) wrap a page in their own document and serve only the files
// uploaded with it. page-artifact/ is page/ with index.html as a fragment: the doctype and the
// html, head and body tags go (the head's meta, title and style stay, as top-level elements; the
// favicon link goes too, the host sets its own), and nothing may point outside the page's files.
export function artifactFragment(html) {
  return html.replace(/<!doctype[^>]*>[ \t]*\n?/gi, '').replace(/<\/?(?:html|head|body)(?:\s[^>]*)?>[ \t]*\n?/gi, '')
    .replace(/<link\s[^>]*rel=["']?icon["']?[^>]*>[ \t]*\n?/gi, '');
}
// XML namespace names are identifiers, never fetched
const NAMESPACE = /^https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)$/;
// JSON keys whose values the page fetches (fonts.faces[].src, vo[].asset, music.asset, shots,
// img/manifest.json file); other strings (credits, notes) are only shown as text
const REF_KEYS = new Set(['src', 'asset', 'file', 'url', 'href', 'poster', 'shots']);
// artifactIssues(dir) -> [{where: 'file:line', issue}]: a document wrapper in index.html; an
// absolute or protocol-relative URL anywhere in its HTML, JavaScript or CSS; a root-relative path
// in an HTML attribute or CSS url(); a fetched JSON reference that is not relative to the page.
export function artifactIssues(dir) {
  const files = listFiles(dir), issues = [];
  const add = (rel, text, i, issue) => issues.push({ where: `${rel}:${text.slice(0, i).split('\n').length}`, issue });
  if (!files.includes('index.html')) return [{ where: 'index.html', issue: 'missing' }];
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), w = /<!doctype|<\/?(?:html|head|body)(?:\s[^>]*)?>/i.exec(index);
  if (w) add('index.html', index, w.index, `has its own document wrapper (${w[0]}); the host adds one`);
  for (const rel of files.filter((r) => /\.(?:html?|m?js|css|json)$/i.test(r))) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (!rel.toLowerCase().endsWith('.json')) {
      for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]*/gi)) if (!NAMESPACE.test(m[0])) add(rel, text, m.index, `absolute URL ${m[0]}`);
      for (const m of text.matchAll(/["'`(=]\s*(\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s'"`<>()]*)/gi)) add(rel, text, m.index, `protocol-relative URL ${m[1]}`);
      if (!/\.m?js$/i.test(rel)) for (const m of text.matchAll(/(?:\b(?:src|href|action|poster)\s*=\s*["']?|url\(\s*["']?)(\/(?!\/)[^\s'"<>()]*)/gi)) add(rel, text, m.index, `root-relative path ${m[1]}`);
    } else {
      let doc;
      try { doc = JSON.parse(text); } catch { continue; }
      const walk = (v, key) => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
        else if (typeof v === 'string' && REF_KEYS.has(key)) {
          const bad = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? 'absolute URL' : v.startsWith('//') ? 'protocol-relative URL' : v.startsWith('/') ? 'root-relative path' : null;
          if (bad) issues.push({ where: rel, issue: `"${key}": ${bad} ${v}` });
        }
      };
      walk(doc, '');
    }
  }
  return issues;
}
// page/ -> page-artifact/; throws, leaving no page-artifact/, when the result would not work there.
function artifactPage(page, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(page, dest, { recursive: true });
  const index = path.join(dest, 'index.html');
  if (fs.existsSync(index)) fs.writeFileSync(index, artifactFragment(fs.readFileSync(index, 'utf8')));
  const issues = artifactIssues(dest);
  if (!issues.length) return listFiles(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  throw new Error(`--host artifact: the page would not work where the host serves only the uploaded files:\n${issues.map((x) => `  ${x.where}: ${x.issue}`).join('\n')}\n`
    + 'Ship every file the page uses inside web/ and refer to it by a relative path (film/..., img/..., audio/..., fonts/...); text drawn on screen can leave out the scheme.');
}

// ---------------------------------------------------------------- the render page
// openFilm(film, o) -> {browser, page, info, errors, newPage(), close()}: the ?render page with
// loudness.js and export.js injected and mediabunny served at /vendor/mediabunny.mjs.
// o.routes adds more {'/url': file} routes (qa.mjs serves deliverables this way).
export async function openFilm(f, o = {}) {
  const routes = Object.assign({
    '/__x/loudness.js': path.join(here, '../web/js/loudness.js'),
    '/__x/export.js': path.join(here, '../web/js/export.js'),
  }, o.routes || {});
  const mb = mediabunnyBundle(f.film);
  if (mb) routes['/vendor/mediabunny.mjs'] = mb;
  const { chromium, findChromium, serve, openPage, CHROME_ARGS } = await runtime();
  const srv = await serve(f.web, 0, routes), port = srv.address().port, errors = [];
  const browser = await chromium.launch({ executablePath: findChromium(o.chromium), args: CHROME_ARGS });
  const newPage = async () => {
    const p = await openPage(browser, port, errors, o.verbose);
    await p.addScriptTag({ url: '/__x/loudness.js' });
    await p.addScriptTag({ url: '/__x/export.js' });
    return p;
  };
  try {
    const page = await newPage();
    const info = await page.evaluate(() => ({ dur: window.__film.dur, fps: window.__film.fps, size: window.__film.size, posterT: window.__film.posterT, RW: window.FILM.R.RW, RH: window.FILM.R.RH }));
    return { browser, page, info, errors, port, newPage, hasMediabunny: !!mb, close: async () => { await browser.close(); srv.close(); } };
  } catch (e) { await browser.close(); srv.close(); throw e; }
}
// Pull a result stored in the page (FILM.X store) in 4 MiB chunks.
export async function pull(page, id) {
  const n = await page.evaluate((id) => window.FILM.X.size(id), id);
  if (n < 0) throw new Error(`no result "${id}" in the page`);
  const parts = [], CH = 4 * 1048576;
  for (let off = 0; off < n; off += CH) parts.push(Buffer.from(await page.evaluate(([id, a, b]) => window.FILM.X.take(id, a, b), [id, off, CH]), 'base64'));
  await page.evaluate((id) => window.FILM.X.drop(id), id);
  return Buffer.concat(parts);
}
// Print page progress (FILM.X.progress) every few seconds while `job` runs.
async function withProgress(page, label, job) {
  const t0 = Date.now();
  let last = -1;
  const timer = setInterval(async () => {
    try {
      const p = await page.evaluate(() => window.FILM.X.progress);
      if (p && p.done !== last) { last = p.done; log(`${label}: ${p.done}/${p.total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
    } catch { /* page busy or closed */ }
  }, 5000);
  try { return await job; } finally { clearInterval(timer); }
}
// What this browser can encode, from a blank secure page (works without a film).
async function probeBrowser(o, film) {
  const routes = { '/__probe.html': { body: '<!doctype html><meta charset="utf-8"><title>probe</title>' }, '/__x/export.js': path.join(here, '../web/js/export.js') };
  const mb = mediabunnyBundle(film);
  if (mb) routes['/vendor/mediabunny.mjs'] = mb;
  const { chromium, findChromium, serve, CHROME_ARGS } = await runtime();
  const srv = await serve(path.join(here, '.no-such-root'), 0, routes); // only the routes above are served
  let exePath;
  try { exePath = findChromium(o.chromium); } catch (e) { srv.close(); return { chromium: null, error: e.message }; }
  const browser = await chromium.launch({ executablePath: exePath, args: CHROME_ARGS });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/__probe.html`);
    await page.addScriptTag({ url: '/__x/export.js' });
    const r = mb ? await page.evaluate((s) => window.FILM.X.probe(s), o.size) : { error: 'mediabunny is not installed (run npm install in the film directory)' };
    if (!mb) r.mediaRecorder = await page.evaluate(() => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].filter((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)));
    return Object.assign({ chromium: exePath, version: browser.version() }, r);
  } finally { await browser.close(); srv.close(); }
}
export async function probe(o = {}, film = process.cwd()) {
  const ff = which('ffmpeg'), fp = which('ffprobe'), tar = which('tar');
  const res = {
    ffmpeg: ff ? { path: ff, version: binVersion(ff) } : null,
    ffprobe: fp ? { path: fp, version: binVersion(fp) } : null,
    tar: tar || null,
    browser: await probeBrowser(o, film),
  };
  const b = res.browser, wc = b.video && b.video.avc && b.audio && b.audio.opus && b.secure;
  const rec = (b.mediaRecorder || []).find((t) => t.startsWith('video/webm'));
  if (ff && fp) res.auto = { mode: 'ffmpeg', reason: `ffmpeg and ffprobe found (${ff})` };
  else if (wc) res.auto = { mode: 'webcodecs', reason: `no ffmpeg on PATH; this Chromium encodes H.264 + Opus with WebCodecs in a secure localhost page` };
  else if (rec) res.auto = { mode: 'webm', reason: `no ffmpeg and no H.264 + Opus WebCodecs encoder; MediaRecorder supports ${rec}` };
  else res.auto = { mode: 'bundle', reason: 'no ffmpeg, no WebCodecs H.264 + Opus and no WebM MediaRecorder: writing frames + WAV for someone else to encode' };
  return res;
}

// ---------------------------------------------------------------- measuring deliverables
// ffprobe summary: {duration, bytes, width, height, video, audio, subtitles: [codec]}
export function ffprobeInfo(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,codec_tag_string,width,height', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout), st = j.streams || [], v = st.find((s) => s.codec_type === 'video'), a = st.find((s) => s.codec_type === 'audio');
  // ffmpeg lists an MP4 WebVTT track (sample entry "wvtt") as a data stream of unknown codec
  const subs = st.filter((s) => s.codec_type === 'subtitle' || s.codec_tag_string === 'wvtt').map((s) => (s.codec_tag_string === 'wvtt' ? 'webvtt' : s.codec_name));
  return { duration: +(+j.format.duration).toFixed(3), bytes: +j.format.size, width: v ? v.width : null, height: v ? v.height : null,
    video: v ? v.codec_name : null, audio: a ? a.codec_name : null, subtitles: subs, by: 'ffprobe' };
}
// Integrated loudness and true peak of the first audio stream, by ffmpeg's ebur128 filter.
export function ebur128(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = r.stderr || '', sum = s.slice(s.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum), TP = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum);
  if (r.status !== 0 || !I) throw new Error(`ffmpeg ebur128 failed on ${file}`);
  const num = (m) => (m && m[1] !== '-inf' ? +m[1] : null);
  return { I: num(I), TP: num(TP), by: 'ffmpeg ebur128' };
}
// Subtitle sample entries (WebVTT "wvtt", 3GPP timed text "tx3g") inside an MP4's moov box;
// mediabunny's demuxer lists only the audio and video tracks.
function mp4SubtitleEntries(file) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, h = Buffer.alloc(16);
  try {
    for (let off = 0; off + 8 <= size;) {
      fs.readSync(fd, h, 0, 16, off);
      let len = h.readUInt32BE(0), head = 8;
      if (len === 1) { len = Number(h.readBigUInt64BE(8)); head = 16; } else if (len === 0) len = size - off;
      if (len < head) break;
      if (h.toString('latin1', 4, 8) === 'moov') {
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, off);
        return [['wvtt', 'webvtt'], ['tx3g', 'mov_text']].filter(([fourcc]) => b.includes(fourcc)).map(([, name]) => name);
      }
      off += len;
    }
    return [];
  } finally { fs.closeSync(fd); }
}
// Container facts without ffprobe, by mediabunny's demuxer (Node).
export async function inspectMedia(file) {
  const M = await import('mediabunny');
  const input = new M.Input({ source: new M.FilePathSource(file), formats: M.ALL_FORMATS });
  try {
    const tracks = await input.getTracks(), v = tracks.find((t) => t.type === 'video'), a = tracks.find((t) => t.type === 'audio');
    let subtitles = tracks.filter((t) => t.type === 'subtitle').map((t) => t.codec);
    if (!subtitles.length && file.endsWith('.mp4')) subtitles = mp4SubtitleEntries(file);
    return { duration: +(await input.computeDuration()).toFixed(3), bytes: fs.statSync(file).size, width: v ? v.displayWidth : null, height: v ? v.displayHeight : null,
      video: v ? v.codec : null, audio: a ? a.codec : null, subtitles, by: 'mediabunny' };
  } finally { input.dispose(); }
}

// ---------------------------------------------------------------- variants
// master: short side 1080 (never upscaled); share: same size, smaller; phone: short side 720.
export function variantSizes(size, names) {
  const [W, H] = size, short = Math.min(W, H), even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const at = (line) => (short <= line ? [W, H] : W >= H ? [even((W * line) / H), line] : [line, even((H * line) / W)]);
  const all = { master: at(1080), share: at(1080), phone: at(720) };
  return names.map((n) => { if (!all[n]) throw new Error(`unknown variant "${n}" (use master, share, phone)`); return { id: n, w: all[n][0], h: all[n][1] }; });
}
export const variantFile = (slug, id) => (id === 'master' ? `${slug}.mp4` : `${slug}-${id}.mp4`);

function run(cmd, args, what) {
  log(`$ ${[cmd].concat(args).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status})`);
}
const renderArgs = (f, o, extra) => [path.join(here, 'render.mjs')].concat(extra, ['--film', f.film], o.chromium ? ['--chromium', o.chromium] : [], o.workers ? ['--workers', String(o.workers)] : []);

// ffmpeg: loudnorm (two passes) is tried first and verified with ebur128; when it misses the
// target (it can on short programmes, whose first-pass estimate is off) loudness.js normalizes
// instead. After encoding, every file's true peak is measured: AAC can overshoot, in which case
// the limiter ceiling drops by the overshoot and all variants are encoded again.
async function modeFfmpeg(f, o, out, files) {
  const work = path.join(f.film, 'work'), mix = path.join(work, 'mix.wav'), frames = path.join(work, 'export-frames'), norm = path.join(work, 'mix_norm.wav');
  const gate = -1, notes = [];
  let ceiling = o.tp == null ? -1.2 : o.tp, method = 'ffmpeg loudnorm, two passes';
  run(process.execPath, renderArgs(f, o, ['audio', '--out', mix]), 'rendering the mix');
  fs.rmSync(frames, { recursive: true, force: true });
  run(process.execPath, renderArgs(f, o, ['video', '--out', frames]), 'rendering frames');
  const L = loudness(), wav = L.wavDecode(fs.readFileSync(mix)), before = L.measure(wav.chans, wav.sr);
  const mux = (extra) => run('bash', [path.join(here, 'mux.sh'), '--frames', frames, '--fps', String(f.fps), '--srt', files.srt, '--out', out, '--slug', f.slug,
    '--duration', String(f.duration), '--title', f.title, '--comment', disclosureNote(f.cfg), '--description', f.cfg.subtitle || '',
    '--lufs', String(o.lufs), '--tp', String(ceiling), '--lra', String(o.lra)].concat(extra), 'tools/mux.sh');
  const byLimiter = () => {
    const n = L.normalize(wav.chans, wav.sr, { I: o.lufs, TP: ceiling });
    fs.writeFileSync(norm, L.wavEncode(n.chans, wav.sr));
    method = 'loudness.js gain + true-peak limiter (BS.1770-4), in Node';
  };
  mux(['--audio', mix, '--norm', norm, '--normalize-only']);
  const chk = ebur128(norm);
  if (chk.I != null && (Math.abs(chk.I - o.lufs) > 0.3 || chk.TP > ceiling + 0.1)) {
    notes.push(`ffmpeg loudnorm missed the target (I ${chk.I} LUFS, TP ${chk.TP} dBTP); normalized with loudness.js instead`);
    byLimiter();
  }
  for (let pass = 0; pass < 3; pass++) {
    mux(['--audio', norm, '--no-loudnorm', '--variants', o.variants.join(',')]);
    // accept only with 0.2 dB of headroom: AAC overshoot varies a little from encode to encode
    const over = o.variants.map((id) => ({ id, tp: ebur128(path.join(out, variantFile(f.slug, id))).TP })).filter((x) => x.tp != null && x.tp > gate - 0.2);
    if (!over.length) break;
    const worst = Math.max(...over.map((x) => x.tp));
    ceiling = +(ceiling - (worst - (gate - 0.35))).toFixed(2);
    notes.push(`AAC raised the true peak to ${worst} dBTP (${over.map((x) => x.id).join(', ')}); encoding again with the limiter ceiling at ${ceiling} dBTP`);
    byLimiter();
  }
  if (!o.keepFrames) fs.rmSync(frames, { recursive: true, force: true });
  const n = L.wavDecode(fs.readFileSync(norm));
  return { method, target: o.lufs, ceiling, before, after: L.measure(n.chans, n.sr), notes, mix: path.relative(f.film, norm) };
}

async function modeWebcodecs(f, o, out, files) {
  const F = await openFilm(f, o);
  try {
    if (!F.hasMediabunny) throw new Error('mediabunny is not installed: run npm install in the film directory');
    const caps = await F.page.evaluate((s) => window.FILM.X.probe(s), { w: F.info.size[0], h: F.info.size[1], fps: F.info.fps });
    if (!(caps.secure && caps.video.avc && caps.audio.opus)) throw new Error(`this Chromium cannot encode H.264 + Opus with WebCodecs (${JSON.stringify(caps)}); use --mode webm or bundle`);
    const vtt = fs.readFileSync(files.vtt, 'utf8'), fps = F.info.fps;
    // one Opus bitrate for every variant: lower rates overshoot sharp transients (the mix is
    // checked after an encode round trip either way)
    const audioBitrate = 160000;
    let variants = variantSizes(F.info.size, o.variants).map((v) => {
      const px = v.w * v.h * fps;
      const bits = v.id === 'master' ? px * 0.1 : v.id === 'share' ? px * 0.05 : Math.min(px * 0.08, (PHONE_LIMIT * 0.9 * 8) / f.duration - audioBitrate);
      return Object.assign(v, { videoBitrate: Math.round(Math.max(3e5, bits)) });
    });
    const opts = { audioBitrate, lufs: o.lufs, ceiling: o.tp == null ? -1.5 : o.tp, gate: -1, vtt, title: f.title, comment: disclosureNote(f.cfg), description: f.cfg.subtitle || '' };
    let report = null, subtitles = false;
    for (let pass = 0; pass < 4 && variants.length; pass++) {
      const r = await withProgress(F.page, 'webcodecs', F.page.evaluate((a) => window.FILM.X.mp4(a), Object.assign({ variants }, opts)));
      report = report || r.mix; subtitles = r.subtitles;
      if (pass === 0) fs.writeFileSync(path.join(f.film, 'work', 'mix_norm.wav'), await pull(F.page, 'mix'));
      const again = [];
      for (const v of r.variants) {
        const file = path.join(out, variantFile(f.slug, v.id)), bytes = await pull(F.page, v.id);
        fs.writeFileSync(file, bytes);
        log(`webcodecs: wrote ${file} (${bytes.length} bytes, ${v.w}x${v.h})`);
        if (v.id === 'phone' && bytes.length >= PHONE_LIMIT) {
          const lower = variants.find((x) => x.id === 'phone');
          again.push(Object.assign({}, lower, { videoBitrate: Math.round(lower.videoBitrate * 0.75) }));
          log(`webcodecs: the phone copy is over 30 MiB; encoding it again at ${again[0].videoBitrate} bit/s`);
        }
      }
      variants = again;
    }
    if (!subtitles) log('webcodecs: this browser cannot write a WebVTT track; captions are in the .srt/.vtt files only');
    return mixReport(report, o, 'in the page');
  } finally { await F.close(); }
}
const mixReport = (r, o, where) => ({ method: `loudness.js gain + true-peak limiter (BS.1770-4), ${where}`, target: o.lufs, ceiling: r.ceiling == null ? (o.tp == null ? -1.5 : o.tp) : r.ceiling,
  before: r.before, after: r.after, gain_db: r.gainDb, limiter_db: r.limiterDb, opus_round_trip: r.encoded || undefined, mix: 'work/mix_norm.wav' });

async function modeWebm(f, o, out) {
  const F = await openFilm(f, o);
  try {
    const caps = await F.page.evaluate(() => window.FILM.X.probe({}));
    const mime = (caps.mediaRecorder || []).find((t) => t.startsWith('video/webm'));
    if (!mime) throw new Error('MediaRecorder cannot record WebM in this browser; use --mode bundle');
    const [v] = variantSizes(F.info.size, ['phone']);
    log(`webm: REAL-TIME capture, not frame-exact (${mime}, ${v.w}x${v.h}); this takes about ${Math.ceil(F.info.dur)} s`);
    const r = await withProgress(F.page, 'webm', F.page.evaluate((a) => window.FILM.X.webm(a), {
      w: v.w, h: v.h, mime, videoBitrate: Math.round(v.w * v.h * F.info.fps * 0.1), audioBitrate: 160000, lufs: o.lufs, ceiling: o.tp == null ? -1.5 : o.tp, gate: -1,
      title: f.title, comment: disclosureNote(f.cfg), description: f.cfg.subtitle || '',
    }));
    if (!r.remuxed) log('webm: could not remux the recording; it has no duration header or seek index');
    const file = path.join(out, `${f.slug}.webm`);
    fs.writeFileSync(file, await pull(F.page, 'webm'));
    fs.writeFileSync(path.join(f.film, 'work', 'mix_norm.wav'), await pull(F.page, 'mix'));
    log(`webm: wrote ${file} (${fs.statSync(file).size} bytes); drew ${r.drawn} of ${r.expected} frames in real time`);
    return Object.assign(mixReport(r.mix, o, 'in the page'), { realtime: { drawn: r.drawn, expected: r.expected, mime } });
  } finally { await F.close(); }
}

function modeBundle(f, o, out, files) {
  const dir = path.join(out, `${f.slug}-bundle`), mix = path.join(f.film, 'work', 'mix.wav');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  run(process.execPath, renderArgs(f, o, ['audio', '--out', mix]), 'rendering the mix');
  run(process.execPath, renderArgs(f, o, ['video', '--out', path.join(dir, 'frames')]), 'rendering frames');
  fs.rmSync(path.join(dir, 'frames', 'frames.json'), { force: true });
  const L = loudness(), wav = L.wavDecode(fs.readFileSync(mix)), n = L.normalize(wav.chans, wav.sr, { I: o.lufs, TP: o.tp == null ? -1.5 : o.tp });
  fs.writeFileSync(path.join(dir, 'mix.wav'), L.wavEncode(n.chans, wav.sr));
  for (const k of ['srt', 'vtt']) fs.copyFileSync(files[k], path.join(dir, path.basename(files[k])));
  const [W, H] = f.size, name = f.slug;
  fs.writeFileSync(path.join(dir, 'README.txt'), [
    `${f.title}: frames and sound, ready to encode`,
    '',
    `frames/f00000.jpg ...    ${Math.round(f.duration * f.fps)} JPEG frames, ${W}x${H}, ${f.fps} fps`,
    `mix.wav                  the soundtrack, 48 kHz stereo, already normalized to ${n.after.I} LUFS (true peak ${n.after.TP} dBTP)`,
    `${name}.srt, ${name}.vtt`,
    '                         captions',
    '',
    'Encode an MP4 with ffmpeg (https://ffmpeg.org), run from this folder:',
    '',
    `  ffmpeg -framerate ${f.fps} -i frames/f%05d.jpg -i mix.wav -i ${name}.srt -map 0:v -map 1:a -map 2:s \\`,
    '    -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 -preset slow -c:a aac -b:a 192k \\',
    `    -c:s mov_text -t ${f.duration} -movflags +faststart ${name}.mp4`,
    '',
    'The mix is already at the target loudness, so no loudness filter is needed.',
    '',
  ].join('\n'));
  let tarFile = null;
  if (which('tar')) {
    tarFile = path.join(out, `${f.slug}-bundle.tar`);
    run('tar', ['-C', out, '-cf', tarFile, `${f.slug}-bundle`], 'tar');
  }
  return { loud: { method: 'loudness.js gain + true-peak limiter (BS.1770-4), in Node', target: o.lufs, ceiling: o.tp == null ? -1.5 : o.tp, before: n.before, after: n.after,
    gain_db: n.gainDb, limiter_db: n.limiterDb, mix: path.relative(f.film, path.join(dir, 'mix.wav')) }, dir, tarFile };
}

// Measure every video deliverable in out/: container facts plus loudness (ffmpeg when present,
// else decoded in Chromium and measured with loudness.js).
export async function measureDeliverables(f, out, o = {}) {
  const names = ['master', 'share', 'phone'].map((id) => ({ id, file: path.join(out, variantFile(f.slug, id)) })).concat([{ id: 'webm', file: path.join(out, `${f.slug}.webm`) }]);
  const found = names.filter((x) => fs.existsSync(x.file));
  const ff = which('ffmpeg') && which('ffprobe');
  let F = null;
  try {
    for (const x of found) {
      Object.assign(x, ff ? ffprobeInfo(x.file) : await inspectMedia(x.file));
      if (ff) { const m = ebur128(x.file); Object.assign(x, { lufs: m.I, true_peak: m.TP, loudness_by: m.by }); }
      else {
        if (!F) F = await openFilm(f, Object.assign({}, o, { routes: Object.fromEntries(found.map((y) => [`/__out/${path.basename(y.file)}`, y.file])) }));
        const m = await F.page.evaluate((u) => window.FILM.X.measure(u), `/__out/${path.basename(x.file)}`);
        Object.assign(x, { lufs: m.I, true_peak: m.TP, loudness_by: 'Chromium decode + loudness.js' });
      }
      x.path = path.relative(f.film, x.file); delete x.file;
    }
  } finally { if (F) await F.close(); }
  return found;
}

// ---------------------------------------------------------------- main
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--probe') o.probe = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--keep-frames') o.keepFrames = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('='), k = eq > 0 ? a.slice(2, eq) : a.slice(2), v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (!['film', 'out', 'mode', 'variants', 'lufs', 'tp', 'lra', 'workers', 'chromium', 'host'].includes(k)) throw new Error(`unknown option --${k}\n\n${HELP}`);
      if (v == null) throw new Error(`option --${k} needs a value`);
      o[k] = v;
    } else throw new Error(`unexpected argument "${a}"\n\n${HELP}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  if (o.probe) {
    let size;
    try { size = loadFilm(o.film).size; } catch { size = [1920, 1080]; }
    console.log(JSON.stringify(await probe({ chromium: o.chromium, size: { w: size[0], h: size[1] } }, path.resolve(o.film || '.')), null, 1));
    return 0;
  }
  o.lufs = o.lufs == null ? -14.5 : Number(o.lufs);
  o.tp = o.tp == null ? null : Number(o.tp);
  o.lra = o.lra == null ? 11 : Number(o.lra);
  o.variants = (o.variants || 'master,share,phone').split(',').map((s) => s.trim()).filter(Boolean);
  o.host = o.host || 'web';
  if (!['web', 'artifact'].includes(o.host)) throw new Error(`unknown --host ${o.host} (use web or artifact)`);
  if (![o.lufs, o.lra].every(isFinite) || (o.tp != null && !isFinite(o.tp))) throw new Error('--lufs, --tp and --lra must be numbers');
  variantSizes([1920, 1080], o.variants);
  const f = loadFilm(o.film), out = path.resolve(o.out || path.join(f.film, 'out'));
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(f.film, 'work'), { recursive: true });

  let mode = o.mode || 'auto', reason = 'requested with --mode';
  if (!['auto', 'ffmpeg', 'webcodecs', 'webm', 'bundle'].includes(mode)) throw new Error(`unknown --mode ${mode}`);
  if (mode === 'auto') { const p = await probe({ chromium: o.chromium, size: { w: f.size[0], h: f.size[1] } }, f.film); ({ mode, reason } = p.auto); }
  if (mode === 'ffmpeg' && !(which('ffmpeg') && which('ffprobe'))) throw new Error('--mode ffmpeg needs ffmpeg and ffprobe on PATH (try --mode webcodecs)');
  log(`export: mode ${mode} (${reason})`);

  // captions, transcript and the hostable page come first: every mode ships them. The live
  // web/index.html gets the static title and description first, so page/ and web/ agree.
  const cues = captionCues(f.vo, f.duration);
  const files = { srt: path.join(out, `${f.slug}.srt`), vtt: path.join(out, `${f.slug}.vtt`), transcript: path.join(out, 'transcript.md'), page: path.join(out, 'page') };
  fs.writeFileSync(files.srt, toSRT(cues)); fs.writeFileSync(files.vtt, toVTT(cues));
  fs.writeFileSync(files.transcript, transcript(f));
  const live = path.join(f.web, 'index.html');
  if (fs.existsSync(live)) {
    const { title, description } = pageMeta(f), html = fs.readFileSync(live, 'utf8'), tagged = pageTags(html, title, description);
    if (tagged !== html) { fs.writeFileSync(live, tagged); log('export: web/index.html now carries the title and description from web/film/config.json'); }
  }
  copyPage(f.web, files.page);
  let artifactFiles = null;
  if (o.host === 'artifact') { files.pageArtifact = path.join(out, 'page-artifact'); artifactFiles = artifactPage(files.page, files.pageArtifact); }
  log(`export: ${cues.length} caption cues, transcript.md, page/${artifactFiles ? ', page-artifact/' : ''} -> ${out}`);

  const t0 = Date.now(), manifest = { mode, reason, host: o.host, title: f.title, slug: f.slug, duration: f.duration, size: f.size, fps: f.fps };
  if (mode === 'ffmpeg') manifest.loudness = await modeFfmpeg(f, o, out, files);
  else if (mode === 'webcodecs') manifest.loudness = await modeWebcodecs(f, o, out, files);
  else if (mode === 'webm') manifest.loudness = await modeWebm(f, o, out);
  else { const b = modeBundle(f, o, out, files); manifest.loudness = b.loud; manifest.bundle = { dir: path.relative(f.film, b.dir), tar: b.tarFile && path.relative(f.film, b.tarFile) }; }
  if (mode === 'webm') manifest.note = 'real time, not frame-exact';
  // the normalized mix's fingerprint: a later export with an unchanged film should match it, or differ
  // only by render-to-render float noise (qa.mjs null measures that)
  const mixFile = manifest.loudness && manifest.loudness.mix && path.join(f.film, manifest.loudness.mix);
  if (mixFile && fs.existsSync(mixFile)) manifest.loudness.mix_sha256 = crypto.createHash('sha256').update(fs.readFileSync(mixFile)).digest('hex');
  manifest.files = await measureDeliverables(f, out, o);
  Object.assign(manifest, { captions: { srt: path.relative(f.film, files.srt), vtt: path.relative(f.film, files.vtt), cues: cues.length }, transcript: path.relative(f.film, files.transcript),
    page: path.relative(f.film, files.page), seconds: +((Date.now() - t0) / 1000).toFixed(1) });
  if (artifactFiles) manifest.page_artifact = { dir: path.relative(f.film, files.pageArtifact), files: artifactFiles };
  fs.writeFileSync(path.join(out, 'export.json'), JSON.stringify(manifest, null, 1) + '\n');

  const L = manifest.loudness;
  console.log(`\n${mode} export of "${f.title}" in ${manifest.seconds} s -> ${path.relative(process.cwd(), out) || '.'}`);
  if (L && L.before) console.log(`  loudness: mix ${L.before.I} LUFS / ${L.before.TP} dBTP -> ${L.after.I} LUFS / ${L.after.TP} dBTP (${L.method})`);
  for (const n of (L && L.notes) || []) console.log(`  note: ${n}`);
  if (manifest.note) console.log(`  note: ${manifest.note}`);
  for (const x of manifest.files) {
    console.log(`  ${x.path.padEnd(34)} ${String(x.width)}x${x.height}  ${x.duration.toFixed(3)} s  ${(x.bytes / 1048576).toFixed(2)} MiB  ${x.video}+${x.audio}${x.subtitles.length ? '+' + x.subtitles.join(',') : ''}  ${x.lufs} LUFS  TP ${x.true_peak} dBTP`);
  }
  if (manifest.bundle) console.log(`  ${manifest.bundle.dir}/ ${manifest.bundle.tar ? '+ ' + manifest.bundle.tar : '(tar not found: directory only)'}`);
  console.log(`  captions ${manifest.captions.srt}, ${manifest.captions.vtt} (${cues.length} cues); ${manifest.transcript}; ${manifest.page}/`);
  if (artifactFiles) console.log(`  ${manifest.page_artifact.dir}/ (${artifactFiles.length} files: index.html is the page, the rest are its files at the same relative paths)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { log(e.message || e); process.exitCode = 1; });
}
