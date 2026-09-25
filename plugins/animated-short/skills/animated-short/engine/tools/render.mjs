#!/usr/bin/env node
// Headless renderer for a film page: stills, video frames, the offline audio mix, the text
// drawn at given times, the glyph test and a frame-purity check. It serves <film>/web from a
// tiny static server on 127.0.0.1 (a secure context, like production) and drives Chromium
// through playwright-core. Page errors fail the command; console errors are printed.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HELP = `Usage: node tools/render.mjs <mode> [times] [options]

Modes
  stills <t,t,...>   JPEG stills (t in seconds, or "poster") -> <film>/work/qa/stills/tNNN.NN.jpg
  video              every frame as JPEG -> <film>/work/frames/f00000.jpg ... plus frames.json
  audio              the offline mix as 48 kHz 16-bit WAV -> <film>/work/mix.wav
  text <t,t,...>     JSON to stdout: every text drawn at each time
                     [{t, texts: [{id, text, px1080, bbox:[x,y,w,h], alpha, progress, inframe}]}]
  glyph              JSON to stdout: write-on glyph test for every configured font; exit 1 on failure
  purity             render sample frames in order and shuffled on a fresh page; compare SHA-256;
                     exit 1 on any mismatch
  serve              serve <film>/web on http://127.0.0.1:<port>/ to watch the live player (Ctrl-C stops)

Options
  --film <dir>       film directory (contains web/); default: current directory
  --out <path>       output directory (stills, video) or file (audio)
  --workers <n>      parallel pages for video (default: min(6, CPUs))
  --range <a-b>      video frame range, a inclusive, b exclusive (default: all)
  --q <0..1>         JPEG quality (default 0.95 video, 0.92 stills)
  --n <count>        purity sample count (default 12)
  --port <n>         serve: port (default: a free one)
  --chromium <path>  Chromium binary (else env CHROMIUM_PATH, playwright's own, ~/.cache/ms-playwright,
                     then a system chromium / google-chrome)
  --verbose          also print page info messages (e.g. engine downgrade notes)
  -h, --help         this help`;

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a.slice(2), argv[++i]];
      if (v == null) throw new Error(`option --${k} needs a value`);
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}
const log = (...a) => console.error(...a);

// ---- Chromium discovery: never a hard-coded path
function exe(p) { try { return p && fs.statSync(p).isFile() ? p : null; } catch { return null; } }
export function findChromium(flag) {
  if (flag) { if (exe(flag)) return flag; throw new Error(`--chromium ${flag}: no such file`); }
  if (process.env.CHROMIUM_PATH) { if (exe(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH; throw new Error(`CHROMIUM_PATH=${process.env.CHROMIUM_PATH}: no such file`); }
  try { const p = chromium.executablePath(); if (exe(p)) return p; } catch { /* playwright has no browser of its own */ }
  const home = os.homedir();
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  const inside = {
    'chromium-': ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    'chromium_headless_shell-': ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-headless-shell-mac-x64/chrome-headless-shell'],
  };
  for (const [prefix, rels] of Object.entries(inside)) {
    for (const root of roots) {
      let dirs = [];
      try { dirs = fs.readdirSync(root).filter((d) => d.startsWith(prefix) && /^\d+$/.test(d.slice(prefix.length))); } catch { continue; }
      dirs.sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      for (const d of dirs) for (const r of rels) { const p = exe(path.join(root, d, r)); if (p) return p; }
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const p = exe(path.join(dir, name)); if (p) return p; }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) if (exe(p)) return p;
  throw new Error('No Chromium found. Install one with:  npx playwright install chromium\n(or pass --chromium <path>, or set CHROMIUM_PATH)');
}

// ---- static server for <film>/web on 127.0.0.1
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
// extra: {'/url/path': '/abs/file' | {body, type}} routes served ahead of root (tools/export.mjs
// adds the mediabunny bundle and the deliverables it inspects this way).
export function serve(root, port = 0, extra = {}) {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let u;
      try { u = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rsp.writeHead(400); return rsp.end(); }
      const x = extra[u];
      if (x && typeof x === 'object') { rsp.writeHead(200, { 'Content-Type': x.type || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return rsp.end(x.body); }
      const f = x || path.resolve(root, '.' + (u === '/' ? '/index.html' : u));
      if (!(x || f === root || f.startsWith(root + path.sep)) || !exe(f)) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(port, '127.0.0.1', () => res(srv));
  });
}

const OPTIONAL = ['/img/manifest.json', '/favicon.ico']; // files a film may legitimately lack
// Chromium flags for deterministic software rendering (shared with tools/export.mjs and qa.mjs)
export const CHROME_ARGS = ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', '--disable-gpu', '--disable-lcd-text'];
export async function openPage(browser, port, errors, verbose) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const ty = m.type(), text = m.text();
    if (/^Failed to load resource: .*404/.test(text)) return; // reported by URL below
    if (ty === 'error' || ty === 'warning' || (verbose && (ty === 'info' || ty === 'log'))) log(`[page ${ty}] ${text}`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url()).pathname;
    if (r.status() === 404 && !OPTIONAL.includes(u)) log(`[page 404] ${u}`);
  });
  page.on('pageerror', (e) => { errors.push(e.message); log('[pageerror] ' + e.message); });
  await page.goto(`http://127.0.0.1:${port}/index.html?render=1`);
  await page.waitForFunction(() => window.__film && window.__film.ready);
  await page.evaluate(() => window.__film.ready);
  return page;
}
const b64 = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
const times = (arg, info) => {
  if (!arg) throw new Error('give times, e.g. 0.5,2,5');
  return arg.split(',').map((s) => (s.trim() === 'poster' ? info.posterT : Number(s))).map((t) => {
    if (!isFinite(t)) throw new Error(`bad time in "${arg}"`);
    return t;
  });
};

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const mode = o._[0];
  if (o.help || !mode) { console.log(HELP); return mode || o.help ? 0 : 2; }
  if (!['stills', 'video', 'audio', 'text', 'glyph', 'purity', 'serve'].includes(mode)) { log(`unknown mode "${mode}"\n\n${HELP}`); return 2; }
  const film = path.resolve(o.film || '.'), web = path.join(film, 'web');
  if (!exe(path.join(web, 'index.html'))) { log(`${web}/index.html not found (use --film <dir>)`); return 2; }
  if (mode === 'serve') {
    const s = await serve(web, Number(o.port || 0));
    console.log(`serving ${web} at http://127.0.0.1:${s.address().port}/  (Ctrl-C to stop)`);
    return new Promise(() => {});
  }
  const exePath = findChromium(o.chromium);
  const srv = await serve(web), port = srv.address().port, errors = [];
  const browser = await chromium.launch({ executablePath: exePath, args: CHROME_ARGS });
  let code = 0;
  try {
    const page = await openPage(browser, port, errors, o.verbose);
    const info = await page.evaluate(() => ({ dur: window.__film.dur, fps: window.__film.fps, size: window.__film.size, posterT: window.__film.posterT }));
    if (mode === 'stills') {
      const out = path.resolve(o.out || path.join(film, 'work/qa/stills')); fs.mkdirSync(out, { recursive: true });
      for (const t of times(o._[1], info)) {
        const t0 = Date.now(), url = await page.evaluate(([t, q]) => window.__film.frame(t, q), [t, Number(o.q || 0.92)]);
        const f = path.join(out, `t${t.toFixed(2).padStart(6, '0')}.jpg`);
        fs.writeFileSync(f, b64(url)); console.log(`${f}  (${Date.now() - t0} ms)`);
      }
    } else if (mode === 'text') {
      const res = [];
      for (const t of times(o._[1], info)) res.push({ t, texts: await page.evaluate((t) => window.__film.text(t), t) });
      console.log(JSON.stringify(res, null, 1));
    } else if (mode === 'glyph') {
      const r = await page.evaluate(() => window.__film.glyphTest());
      console.log(JSON.stringify(r, null, 1));
      if (!r.ok) { log('glyph test FAILED: a letter does not advance the write-on in at least one font'); code = 1; }
    } else if (mode === 'audio') {
      const out = path.resolve(o.out || path.join(film, 'work/mix.wav')); fs.mkdirSync(path.dirname(out), { recursive: true });
      const t0 = Date.now(), data = await page.evaluate(() => window.__film.audio());
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log(`${out}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } else if (mode === 'video') {
      const N = Math.round(info.dur * info.fps);
      const [a, b] = o.range ? o.range.split('-').map(Number) : [0, N];
      if (!(a >= 0 && b <= N && a < b)) throw new Error(`--range must be within 0-${N}`);
      const workers = Math.max(1, Number(o.workers || Math.min(6, os.cpus().length)));
      const out = path.resolve(o.out || path.join(film, 'work/frames')); fs.mkdirSync(out, { recursive: true });
      const pages = [page].concat(await Promise.all([...Array(workers - 1)].map(() => openPage(browser, port, errors, false))));
      const q = Number(o.q || 0.95), t0 = Date.now(), step = Math.max(1, Math.round((b - a) / 10));
      let next = a, done = 0;
      await Promise.all(pages.map(async (p) => {
        while (next < b) {
          const i = next++;
          const url = await p.evaluate(([t, q]) => window.__film.frame(t, q), [i / info.fps, q]);
          fs.writeFileSync(path.join(out, `f${String(i).padStart(5, '0')}.jpg`), b64(url));
          if (++done % step === 0) log(`${done}/${b - a} frames, ${((Date.now() - t0) / done).toFixed(0)} ms/frame`);
        }
      }));
      fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify({ fps: info.fps, size: info.size, duration: info.dur, frames: N, pattern: 'f%05d.jpg', rendered: [a, b] }, null, 1) + '\n');
      console.log(`${b - a} frames -> ${out}  (${((Date.now() - t0) / 1000).toFixed(1)} s, ${workers} pages)`);
    } else if (mode === 'purity') {
      const n = Math.max(2, Number(o.n || 12)), moves = await page.evaluate(() => window.__film.moves());
      const ts = [...Array(n)].map((_, i) => +(((i + 0.37) / n) * info.dur).toFixed(4));
      for (const m of moves) ts.push(+((m.from + m.to) / 2).toFixed(4));
      const hash = async (p, t) => crypto.createHash('sha256').update(b64(await p.evaluate((t) => window.__film.png(t), t))).digest('hex');
      const fwd = {};
      for (const t of ts) fwd[t] = await hash(page, t);
      const other = await openPage(browser, port, errors, false);
      const shuffled = ts.slice().sort((x, y) => crypto.createHash('md5').update(String(x)).digest('hex').localeCompare(crypto.createHash('md5').update(String(y)).digest('hex')));
      const bad = [];
      for (const t of shuffled) { const h = await hash(other, t); if (h !== fwd[t]) bad.push(t); }
      // a repeat on the first page after other frames catches state leaking between frames
      for (const t of ts.slice(0, 3)) { const h = await hash(page, t); if (h !== fwd[t] && !bad.includes(t)) bad.push(t); }
      console.log(JSON.stringify({ ok: !bad.length, samples: ts.length, camera_moves_sampled: moves.length, mismatches: bad }, null, 1));
      if (bad.length) { log(`purity FAILED at t = ${bad.join(', ')}: frames depend on render order or page state`); code = 1; }
    }
  } finally {
    await browser.close(); srv.close();
  }
  if (errors.length) { log(`${errors.length} page error(s); failing`); code = code || 1; }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { log(e.message || e); process.exitCode = 1; });
}
