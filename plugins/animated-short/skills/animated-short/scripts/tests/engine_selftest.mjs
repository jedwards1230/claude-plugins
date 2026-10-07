#!/usr/bin/env node
// Engine self-test in a real headless Chromium, run by scripts/test-golden.sh on its scratch film:
//   node engine_selftest.mjs <film dir>
// 1. D.sticker draws the visible placeholder (logged as "<id>:missing") for a sticker that is not loaded
// 2. a manifest anchor is the sticker's pivot: anchor [0, 1] puts the bottom-left corner at (x, y)
// 3. a scene's custom shot draws over its elements, or under them with {"layer": "under"}
// 4. the glyph test fails when a face declared in config.fonts.faces does not load
// Prints one line per check and exits 1 on any failure. Uses the film's own render.mjs and
// playwright-core, so nothing here is copied into films.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const film = path.resolve(process.argv[2] || '.');
const R = await import(pathToFileURL(path.join(film, 'tools', 'render.mjs')).href);
const { chromium } = await import(pathToFileURL(path.join(film, 'node_modules', 'playwright-core', 'index.mjs')).href);
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };

const srv = await R.serve(path.join(film, 'web')), errors = [];
const browser = await chromium.launch({ executablePath: R.findChromium(), args: R.CHROME_ARGS });
try {
  const page = await R.openPage(browser, srv.address().port, errors, false);
  const r = await page.evaluate(() => {
    const D = window.FILM.D, mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const g = mk(400, 300).getContext('2d');
    D.textLog = [];
    D.sticker(g, 'no-such-sticker', 200, 150, { w: 200, id: 'probe' });
    const log = D.textLog; D.textLog = null;
    const src = mk(20, 10), sg = src.getContext('2d');
    sg.fillStyle = '#ff0000'; sg.fillRect(0, 0, 20, 10);
    D.addSticker('probe-red', src, { anchor: [0, 1] });
    const g2 = mk(200, 200).getContext('2d', { willReadFrequently: true });
    g2.fillStyle = '#ffffff'; g2.fillRect(0, 0, 200, 200);
    D.sticker(g2, 'probe-red', 100, 100, { shadow: 0 });
    const px = (x, y) => Array.from(g2.getImageData(x, y, 1, 1).data);
    return { placeholder: log.some((x) => x.id === 'probe:missing' && x.text === 'no-such-sticker'), inside: px(110, 95), below: px(110, 105), left: px(95, 95),
      anchor: D.anchor('probe-red'), fallback: D.anchor('no-such-sticker') };
  });
  check('missing sticker draws the placeholder', r.placeholder);
  const red = (p) => p[0] > 200 && p[1] < 60, white = (p) => p[0] > 200 && p[1] > 200;
  check('manifest anchor is the pivot', red(r.inside) && white(r.below) && white(r.left) && r.anchor.join() === '0,1' && r.fallback.join() === '0.5,0.5',
    `inside ${r.inside}, below ${r.below}, left ${r.left}`);
  // the last check replaces the page's storyboard state: nothing else runs on this page after it
  const layers = await page.evaluate(() => {
    const F = window.FILM, SB = F.SB;
    F.shot('probe-fill', (ctx) => { ctx.fillStyle = '#ff0000'; ctx.fillRect(-1000, -600, 2000, 1200); });
    const centre = (layer) => {
      const custom = layer ? { canvas: 'probe-fill', layer } : 'probe-fill';
      SB.prepare({ meta: { duration: 2, size: [1920, 1080] }, layout: { type: 'stage', handheld: 0 },
        scenes: [{ id: 'a', at: 0, until: 2, custom, elements: [{ id: 'box', kind: 'shape', shape: 'rect', w: 300, h: 300, color: '#00ff00' }] }] });
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
      const g = c.getContext('2d', { willReadFrequently: true });
      SB.drawWorld(g, 1, { x0: 0, y0: 0, x1: 1920, y1: 1080 });
      return Array.from(g.getImageData(960, 540, 1, 1).data);
    };
    return { over: centre(null), under: centre('under') };
  });
  const green = (p) => p[1] > 200 && p[0] < 60;
  check('a scene shot draws over its elements, or under them', red(layers.over) && green(layers.under), `over ${layers.over}, under ${layers.under}`);
} finally {
  await browser.close(); srv.close();
}

const cfgFile = path.join(film, 'web', 'film', 'config.json'), original = fs.readFileSync(cfgFile, 'utf8');
try {
  const cfg = JSON.parse(original);
  cfg.fonts = Object.assign({}, cfg.fonts, { faces: [{ family: 'Probe Missing Face', src: 'fonts/probe-missing.woff2', weight: '400 700' }] });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1) + '\n');
  const g = spawnSync(process.execPath, [path.join(film, 'tools', 'render.mjs'), 'glyph', '--film', film], { encoding: 'utf8' });
  let faces = [];
  try { faces = JSON.parse(g.stdout).faces || []; } catch { /* reported below */ }
  check('glyph test fails on a face that does not load', g.status === 1 && faces.length === 1 && !faces[0].loaded, `exit ${g.status}`);
} finally {
  fs.writeFileSync(cfgFile, original);
}
process.exitCode = results.every(Boolean) && !errors.length ? 0 : 1;
