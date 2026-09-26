#!/usr/bin/env node
// Page self-test, run by scripts/test-golden.sh on its scratch film after `export --host artifact`:
//   node page_selftest.mjs <film dir>
// 1. out/page/index.html carries the film's title and description (web/film/config.json) in its
//    static tags, and web/index.html is the same file (the live page and the delivered page agree)
// 2. out/page-artifact/ holds the same files as out/page/, byte for byte except index.html, which
//    is a fragment: no doctype, html, head or body tag, no favicon link, still the tags, the style
//    and the scripts; no http(s) URL in any of its HTML, JavaScript, CSS or JSON files
// 3. artifactIssues flags a document wrapper, an absolute URL, a root-relative src, a
//    protocol-relative URL in JavaScript and a fetched JSON reference to another host, and ignores an
//    SVG namespace name and a URL in credits text
// 4. export --host artifact on a copy of the film with an external URL fails before rendering,
//    names the file and line and leaves no page-artifact/; an unknown --host is refused
// 5. in headless Chromium, the fragment inside a host's own document (doctype, html, head, body)
//    loads the player without page errors, and every request stays on the page's origin
// Prints one line per check and exits 1 on any failure. Uses the film's own render.mjs and
// playwright-core; no network.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const film = path.resolve(process.argv[2] || '.');
const X = await import(pathToFileURL(path.join(film, 'tools', 'export.mjs')).href);
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const read = (...p) => fs.readFileSync(path.join(film, ...p), 'utf8');
const tag = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };
const TITLE = /<title>([^<]*)<\/title>/i, DESC = /<meta\s+name="description"\s+content="([^"]*)"/i;

// 1. the static tags
const cfg = JSON.parse(read('web', 'film', 'config.json')), page = read('out', 'page', 'index.html');
const title = X.htmlText(cfg.title), desc = X.htmlText(cfg.description || cfg.subtitle || '');
check('page/index.html <title> is the film title', tag(page, TITLE) === title, `"${tag(page, TITLE)}"`);
check('page/index.html description is the film description', tag(page, DESC) === desc, `"${tag(page, DESC)}"`);
check('web/index.html and page/index.html are the same file', read('web', 'index.html') === page);
check('the tags are idempotent', X.pageTags(page, cfg.title, cfg.description || cfg.subtitle) === page);

// 2. the artifact-ready page
const pageDir = path.join(film, 'out', 'page'), artDir = path.join(film, 'out', 'page-artifact');
const hasArt = fs.existsSync(path.join(artDir, 'index.html')), art = hasArt ? read('out', 'page-artifact', 'index.html') : '';
check('page-artifact/index.html exists', hasArt);
const pf = X.listFiles(pageDir), af = fs.existsSync(artDir) ? X.listFiles(artDir) : [];
check('page-artifact/ has the same files as page/', JSON.stringify(pf) === JSON.stringify(af), `${af.length} files`);
const differ = pf.filter((r) => r !== 'index.html' && af.includes(r) && !fs.readFileSync(path.join(pageDir, r)).equals(fs.readFileSync(path.join(artDir, r))));
check('every file but index.html is identical', !differ.length, differ.join(', '));
const wrapper = /<!doctype|<\/?(?:html|head|body)(?:\s[^>]*)?>|<link\s[^>]*rel="icon"/i.exec(art);
check('page-artifact/index.html has no document wrapper', hasArt && !wrapper, wrapper ? wrapper[0] : `first line ${JSON.stringify(art.split('\n')[0])}`);
check('page-artifact/index.html keeps the tags, the style and the scripts',
  tag(art, TITLE) === title && tag(art, DESC) === desc && /<style>/.test(art) && /<script src="js\/main\.js"><\/script>/.test(art) && /<header>/.test(art));
const withHttp = af.filter((r) => /\.(?:html?|m?js|css|json)$/i.test(r) && /https?:\/\//i.test(fs.readFileSync(path.join(artDir, r), 'utf8')));
check('no http(s) URL in any page-artifact file', hasArt && !withHttp.length, withHttp.join(', '));
check('artifactIssues finds nothing in page-artifact/', hasArt && !X.artifactIssues(artDir).length);
const frag = X.artifactFragment('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>T</title>\n<link rel="icon" href="data:,">\n</head>\n<body class="x">\n<header>h</header>\n</body>\n</html>\n');
check('a fragment of explicit head and body tags keeps <header>', frag === '<meta charset="utf-8">\n<title>T</title>\n<header>h</header>\n', JSON.stringify(frag));

// 3. what the artifact check flags
const scratch = path.join(film, 'work', 'qa', 'page-selftest');
fs.rmSync(scratch, { recursive: true, force: true });
const neg = path.join(scratch, 'page');
if (hasArt) {
  fs.cpSync(artDir, neg, { recursive: true });
  const edit = (rel, fn) => fs.writeFileSync(path.join(neg, rel), fn(fs.readFileSync(path.join(neg, rel), 'utf8')));
  edit('index.html', (s) => '<!doctype html>\n' + s.replace('<script src="js/util.js">', '<script src="https://cdn.example.com/lib.js"></script>\n<img src="/logo.png" alt="">\n<script src="js/util.js">'));
  edit('js/main.js', (s) => s + "\nfetch('//cdn.example.com/data.json');\ndocument.createElementNS('http://www.w3.org/2000/svg', 'svg');\n");
  edit('film/config.json', (s) => {
    const j = JSON.parse(s);
    j.fonts = Object.assign({}, j.fonts, { faces: [{ family: 'Remote', src: 'https://fonts.example.com/remote.woff2' }] });
    j.credits = (j.credits || []).concat(['Music: see https://example.com/track']);
    return JSON.stringify(j);
  });
  const found = X.artifactIssues(neg), has = (re) => found.some((x) => re.test(`${x.where} ${x.issue}`));
  check('flags a document wrapper', has(/^index\.html:1 has its own document wrapper/));
  check('flags an absolute URL', has(/^index\.html:\d+ absolute URL https:\/\/cdn\.example\.com\/lib\.js$/));
  check('flags a root-relative src', has(/^index\.html:\d+ root-relative path \/logo\.png$/));
  check('flags a protocol-relative URL in JavaScript', has(/^js\/main\.js:\d+ protocol-relative URL \/\/cdn\.example\.com\/data\.json$/));
  check('flags a fetched JSON reference to another host', has(/^film\/config\.json "src": absolute URL https:\/\/fonts\.example\.com\/remote\.woff2$/));
  check('ignores an SVG namespace name and a URL in credits text', !has(/w3\.org|example\.com\/track/) && found.length === 5, found.map((x) => `${x.where} ${x.issue}`).join('; '));
}

// 4. the export refuses such a page, before rendering anything
const tmp = path.join(scratch, 'film');
fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
fs.cpSync(path.join(film, 'web'), path.join(tmp, 'web'), { recursive: true });
fs.copyFileSync(path.join(film, 'tools', 'export.mjs'), path.join(tmp, 'tools', 'export.mjs'));
fs.appendFileSync(path.join(tmp, 'web', 'js', 'main.js'), '\n// the player once came from https://cdn.example.com/player\n');
const exp = (args) => spawnSync(process.execPath, [path.join(tmp, 'tools', 'export.mjs'), '--film', tmp].concat(args), { encoding: 'utf8', timeout: 60000 });
const r = exp(['--mode', 'bundle', '--host', 'artifact']);
check('export --host artifact fails on an external URL, naming it', r.status === 1 && /--host artifact/.test(r.stderr) && /js\/main\.js:\d+: absolute URL https:\/\/cdn\.example\.com\/player/.test(r.stderr),
  `exit ${r.status}; ${r.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
check('... before rendering, leaving no page-artifact/', !fs.existsSync(path.join(tmp, 'out', 'page-artifact')) && !fs.existsSync(path.join(tmp, 'work', 'mix.wav')) && fs.existsSync(path.join(tmp, 'out', 'page', 'index.html')));
const bad = exp(['--host', 'nowhere']);
check('an unknown --host is refused', bad.status === 1 && /unknown --host nowhere/.test(bad.stderr), bad.stderr.trim().split('\n')[0]);
fs.rmSync(scratch, { recursive: true, force: true });

// 5. the fragment where a host puts it
if (hasArt) {
  const R = await import(pathToFileURL(path.join(film, 'tools', 'render.mjs')).href);
  const { chromium } = await import(pathToFileURL(path.join(film, 'node_modules', 'playwright-core', 'index.mjs')).href);
  const hostDoc = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"></head>\n<body>\n${art}</body>\n</html>\n`;
  const srv = await R.serve(artDir, 0, { '/__host.html': { body: hostDoc } }), origin = `127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: R.findChromium(), args: R.CHROME_ARGS });
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [], foreign = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('request', (q) => { const u = new URL(q.url()); if (!['data:', 'blob:'].includes(u.protocol) && u.host !== origin) foreign.push(q.url()); });
    p.on('response', (q) => { const u = new URL(q.url()).pathname; if (q.status() >= 400 && !['/img/manifest.json', '/favicon.ico'].includes(u)) errors.push(`HTTP ${q.status()} ${u}`); });
    await p.goto(`http://${origin}/__host.html`);
    const ready = await p.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 30000 }).then(() => true, () => false);
    const st = await p.evaluate(() => ({ h1: document.getElementById('title').textContent, label: document.getElementById('poster-label').textContent, title: document.title }));
    check('in a host document the player loads', ready && st.h1 === cfg.title && st.title === cfg.title && !errors.length, `"${st.h1}", poster "${st.label}"${errors.length ? '; ' + errors.join('; ') : ''}`);
    check('every request stays on the page origin', !foreign.length, foreign.join(', '));
  } finally { await browser.close(); srv.close(); }
}

const failed = results.filter((ok) => !ok).length;
console.log(`page self-test: ${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
