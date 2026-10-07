// Drawing primitives for the paper-collage look: paper grain, torn paper pieces, tape,
// stickers with lift shadows, wobbly ink strokes and arrows, sparkles, handwriting with a
// letter-by-letter write-on, and ransom-note letters. Colours and font stacks come from
// web/film/config.json via D.configure(); nothing here is specific to one film.
(function () {
  const FILM = window.FILM;
  const { rnd, srnd, noise, clamp, lerp, deg, E } = FILM;
  const D = (FILM.D = {});

  // ---------- palette and fonts (neutral defaults, replaced by D.configure) ----------
  D.DEFAULT_PALETTE = {
    ground: '#1B1D24', ground2: '#262A34', line: '#3A4050', text: '#F3EEE4', muted: '#B5AFA4',
    board: '#E8E0CF', paper: '#FBF7EE', ink: '#26303F', pencil: 'rgba(72,68,62,0.88)',
    shadow: '#2D1C0C', stain: '#A0733C', tape: '#EEE2BE', accent: '#D9A441', accent_ink: '#2A1F06',
    swatches: {
      teal: '#2F8C8C', coral: '#E0664F', gold: '#E2AE3E', sage: '#9DB88A', rose: '#E6A69E',
      lilac: '#C3B3D6', sky: '#9CC3DD', cream: '#F4EAD6', navy: '#26303F', white: '#FFFDF7',
    },
    panels: ['#CFE3E0', '#F2D3C6', '#DCE6C8', '#E4DCF0', '#F3E2B0', '#D3E1EE'],
    ransom: ['#F4EAD6', '#E2AE3E', '#2F8C8C', '#E0664F', '#FBF7EE', '#9DB88A', '#26303F', '#E6A69E', '#FFFFFF'],
  };
  // Generic stacks only: bundle real font files in web/fonts and declare them in
  // config.fonts.faces for renders that look the same on every machine.
  D.DEFAULT_FONTS = {
    hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Comic Neue", "Chalkboard SE", "Trebuchet MS", sans-serif',
    print: '"Trebuchet MS", "Gill Sans", "Segoe UI", "Noto Sans", "DejaVu Sans", sans-serif',
    ui: 'system-ui, "Segoe UI", "Noto Sans", sans-serif',
    ransom: [
      'Georgia, "Noto Serif", "DejaVu Serif", serif', 'Impact, "Arial Black", "DejaVu Sans", sans-serif',
      '"Courier New", "Noto Sans Mono", monospace', '"Trebuchet MS", "Noto Sans", sans-serif',
      '"Times New Roman", "Noto Serif", serif', 'Verdana, "DejaVu Sans", sans-serif',
    ],
  };

  const parseColor = (c) => {
    if (typeof c !== 'string') return null;
    let m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(m[2] ? parseInt(m[2], 16) / 255 : 1);
    m = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    return null;
  };
  // D.alpha(color, a): the colour with its alpha multiplied by a (hex / rgb / rgba input)
  D.alpha = function (c, a) {
    const p = parseColor(D.color(c));
    return p ? `rgba(${p[0]},${p[1]},${p[2]},${+(p[3] * a).toFixed(4)})` : D.color(c);
  };
  // D.color(name): palette key or swatch name -> css colour; anything else passes through
  D.color = function (name, fallback) {
    if (name == null) return fallback == null ? D.INK : D.color(fallback);
    if (typeof name !== 'string') return name;
    if (D.PAL && Object.prototype.hasOwnProperty.call(D.PAL, name)) return D.PAL[name];
    return name;
  };
  D.configure = function (cfg = {}) {
    const p = cfg.palette || {}, dp = D.DEFAULT_PALETTE;
    const sw = Object.assign({}, dp.swatches, p.swatches || {});
    D.PAL = Object.assign({}, sw);
    for (const k of Object.keys(dp)) if (!['swatches', 'panels', 'ransom'].includes(k)) D.PAL[k] = p[k] || dp[k];
    D.PANELS = (p.panels || dp.panels).map((c) => D.color(c));
    D.RANSOM_BGS = (p.ransom || dp.ransom).map((c) => D.color(c));
    D.INK = D.PAL.ink; D.PENCIL = D.PAL.pencil; D.PAPER = D.PAL.paper;
    const f = cfg.fonts || {};
    D.HAND = f.hand || D.DEFAULT_FONTS.hand;
    D.PRINT = f.print || D.DEFAULT_FONTS.print;
    D.UI = f.ui || D.PRINT;
    D.RANSOM_FONTS = (f.ransom && f.ransom.length ? f.ransom : D.DEFAULT_FONTS.ransom).slice();
    D.FONT_NAMES = { hand: D.HAND, print: D.PRINT, ui: D.UI };
  };
  D.font = (name) => (D.FONT_NAMES && D.FONT_NAMES[name]) || name || D.HAND;
  D.sh = (a) => D.alpha(D.PAL.shadow, a); // warm paper shadow at alpha a
  D.configure({});

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  D.mk = mk;

  // ---------- text registry (window.__film.text(t) reads it) ----------
  // When D.textLog is an array, every text drawn records {id, text, px1080, bbox, alpha, progress}.
  // D.logScale converts device pixels to a 1080-line frame; main.js sets it per canvas.
  D.textLog = null; D.logScale = 1; D.currentId = null;
  D.logText = function (ctx, id, str, x0, y0, x1, y1, size, p) {
    if (!D.textLog || p <= 0 || ctx.globalAlpha <= 0.002) return;
    const m = ctx.getTransform(), s = D.logScale;
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const bx = Math.min(...xs) * s, by = Math.min(...ys) * s, bw = Math.max(...xs) * s - bx, bh = Math.max(...ys) * s - by;
    const cw = ctx.canvas.width * s, ch = ctx.canvas.height * s;
    D.textLog.push({
      id: id || D.currentId || null, text: str, px1080: +(size * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * s).toFixed(1),
      bbox: [bx, by, bw, bh].map((v) => +v.toFixed(1)), alpha: +ctx.globalAlpha.toFixed(3), progress: +clamp(p).toFixed(3),
      inframe: bx < cw && by < ch && bx + bw > 0 && by + bh > 0,
    });
  };

  // ---------- stickers ----------
  D.stickers = {};
  function makeShadow(img) {
    const k = 0.3, pad = 22;
    const w = Math.ceil(img.width * k) + pad * 2, h = Math.ceil(img.height * k) + pad * 2;
    const sil = mk(w, h), sg = sil.getContext('2d');
    sg.drawImage(img, pad, pad, img.width * k, img.height * k);
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = D.sh(1); sg.fillRect(0, 0, w, h);
    const out = mk(w, h), og = out.getContext('2d');
    og.filter = 'blur(6px)'; og.drawImage(sil, 0, 0);
    return { canvas: out, k };
  }
  // meta: the sticker's web/img/manifest.json entry; meta.anchor = [ax, ay] (fractions of its width and
  // height) is the point D.sticker places at (x, y) and turns and scales about. Default: the centre.
  D.addSticker = function (name, img, meta = {}) {
    const a = Array.isArray(meta.anchor) && meta.anchor.length === 2 ? meta.anchor.map(Number) : [0.5, 0.5];
    D.stickers[name] = { img, w: img.width, h: img.height, shadow: makeShadow(img), anchor: a };
  };
  D.anchor = (name) => { const s = D.stickers[name]; return s ? s.anchor.slice() : [0.5, 0.5]; };
  // A missing sticker: a paper card with a dashed ring and the sticker's name, w wide, centred on 0,0.
  // Visible on purpose, so stills and contact sheets catch it (never ship one: VIS-6).
  D.placeholder = function (ctx, name, w, seed = 3, id = null) {
    D.paperShape(ctx, 'rect', Math.round(w), Math.round(w * 0.7), 'paper', seed, { shadow: 0.6 });
    D.ink(ctx, D.circlePts(0, 0, Math.round(w * 0.4), Math.round(w * 0.27), 3, 1.02), { w: 3, c: 'coral', dash: [10, 8] });
    D.text(ctx, name, 0, 10, { size: Math.max(20, Math.round(w * 0.1)), font: 'print', weight: 400, c: 'coral', id: (id || D.currentId || name) + ':missing' });
  };
  const warned = new Set();
  // Draw a sticker with its anchor (default: the centre) at (x,y). o: w (display width), r (deg),
  // a (alpha), lift (0..1), sx, sy, shadow, anchor ([ax, ay] overrides the manifest's), seed and id
  // (for the placeholder). A missing sticker draws the placeholder and warns once.
  D.sticker = function (ctx, name, x, y, o = {}) {
    const s = D.stickers[name];
    const alpha = o.a == null ? 1 : o.a;
    if (alpha <= 0.002) return;
    if (!s) {
      if (!warned.has(name)) { console.warn(`missing sticker "${name}"${D.currentId ? ` (element "${D.currentId}")` : ''}`); warned.add(name); }
      ctx.save(); ctx.translate(x, y); if (o.r) ctx.rotate(deg(o.r)); ctx.globalAlpha *= alpha;
      D.placeholder(ctx, name, o.w || 240, o.seed == null ? 3 : o.seed, o.id);
      ctx.restore();
      return;
    }
    const w = o.w || s.w, sc = w / s.w;
    const lift = o.lift || 0, [ax, ay] = Array.isArray(o.anchor) ? o.anchor : s.anchor;
    const cx = (0.5 - ax) * s.w, cy = (0.5 - ay) * s.h; // the image centre relative to the anchor
    ctx.save();
    ctx.translate(x, y);
    if (o.r) ctx.rotate(deg(o.r));
    ctx.scale(sc * (o.sx == null ? 1 : o.sx), sc * (o.sy == null ? 1 : o.sy));
    const sh = s.shadow, iw = sh.canvas.width / sh.k, ih = sh.canvas.height / sh.k;
    const off = (6 + lift * 34) / sc, grow = 1 + lift * 0.05, base = ctx.globalAlpha;
    ctx.globalAlpha = base * alpha * (0.4 - 0.17 * lift) * (o.shadow == null ? 1 : o.shadow);
    ctx.drawImage(sh.canvas, cx - iw * grow / 2 + off * 0.4, cy - ih * grow / 2 + off, iw * grow, ih * grow);
    ctx.globalAlpha = base * alpha;
    ctx.drawImage(s.img, cx - s.w / 2, cy - s.h / 2);
    ctx.restore();
  };
  D.aspect = (name) => { const s = D.stickers[name]; return s ? s.h / s.w : 1; };

  // ---------- paper ----------
  // Static paper texture tile (fibres, flecks, blotches); drawn as a repeating pattern.
  D.makeGrain = function () {
    const N = 512, c = mk(N, N), g = c.getContext('2d'), r = FILM.rng('grain-v1');
    const dark = parseColor(D.PAL.shadow) || [45, 28, 12, 1];
    const dk = (a) => `rgba(${Math.min(255, dark[0] + 50)},${Math.min(255, dark[1] + 40)},${Math.min(255, dark[2] + 25)},${a})`;
    const wrap = (fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) fn(dx, dy); };
    for (let i = 0; i < 220; i++) {
      const x = r() * N, y = r() * N, rad = 12 + r() * 70, isDark = r() < 0.6;
      wrap((dx, dy) => {
        const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
        gr.addColorStop(0, isDark ? dk(0.035) : 'rgba(255,255,245,0.05)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
      });
    }
    for (let i = 0; i < 2200; i++) {
      const x = r() * N, y = r() * N, len = 5 + r() * 26, a = r() * Math.PI * 2, bend = (r() - 0.5) * 0.8;
      const isDark = r() < 0.55;
      g.strokeStyle = isDark ? dk(0.05 + r() * 0.07) : `rgba(255,255,250,${0.1 + r() * 0.14})`;
      g.lineWidth = 0.5 + r() * 0.9;
      wrap((dx, dy) => {
        g.beginPath(); g.moveTo(x + dx, y + dy);
        g.quadraticCurveTo(x + dx + Math.cos(a + bend) * len * 0.5, y + dy + Math.sin(a + bend) * len * 0.5,
          x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
        g.stroke();
      });
    }
    for (let i = 0; i < 700; i++) {
      const x = r() * N, y = r() * N, rr = 0.4 + r() * 1.3;
      g.fillStyle = r() < 0.7 ? dk(0.08 + r() * 0.12) : 'rgba(255,255,255,0.25)';
      wrap((dx, dy) => { g.beginPath(); g.arc(x + dx, y + dy, rr, 0, 7); g.fill(); });
    }
    return c;
  };
  // One static full-frame film-grain tile. Keep it static: flickering grain balloons file size.
  D.makeFilmGrain = function () {
    const N = 256, c = mk(N, N), g = c.getContext('2d'), id = g.createImageData(N, N), r = FILM.rng('film-grain');
    for (let p = 0; p < N * N; p++) {
      const v = r() * 255; id.data[p * 4] = id.data[p * 4 + 1] = id.data[p * 4 + 2] = v; id.data[p * 4 + 3] = 255;
    }
    g.putImageData(id, 0, 0); return c;
  };

  // ---------- torn shapes ----------
  const polyCache = new Map();
  const cachedPoly = (key, fn) => { if (!polyCache.has(key)) polyCache.set(key, fn()); return polyCache.get(key); };
  D.tornRect = function (w, h, seed, amp = 7, step = 14) {
    return cachedPoly(`r${w}|${h}|${seed}|${amp}|${step}`, () => {
      const pts = [], per = 2 * (w + h);
      for (let s = 0; s < per; s += step) {
        let x, y, nx, ny;
        if (s < w) { x = -w / 2 + s; y = -h / 2; nx = 0; ny = -1; }
        else if (s < w + h) { x = w / 2; y = -h / 2 + (s - w); nx = 1; ny = 0; }
        else if (s < 2 * w + h) { x = w / 2 - (s - w - h); y = h / 2; nx = 0; ny = 1; }
        else { x = -w / 2; y = h / 2 - (s - 2 * w - h); nx = -1; ny = 0; }
        const d = amp * ((noise(s / 34, seed) - 0.5) * 1.8 + (rnd(seed, 'j', s) - 0.5) * 0.9);
        pts.push([x + nx * d, y + ny * d]);
      }
      return pts;
    });
  };
  D.tornEllipse = function (rx, ry, seed, amp = 8, n = 120) {
    return cachedPoly(`e${rx}|${ry}|${seed}|${amp}|${n}`, () => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, s = i * 9;
        const d = amp * ((noise(s / 30, seed) - 0.5) * 1.8 + (rnd(seed, 'e', i) - 0.5) * 0.8);
        pts.push([Math.cos(a) * (rx + d), Math.sin(a) * (ry + d)]);
      }
      return pts;
    });
  };
  // Torn version of any closed polygon: subdivide every `step` px and jitter along the normal.
  D.tornPoly = function (key, pts, seed, amp = 6, step = 12) {
    return cachedPoly(`p${key}|${seed}|${amp}|${step}`, () => {
      const out = []; let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L, n = Math.max(1, Math.ceil(L / step));
        for (let j = 0; j < n; j++, s += L / n) {
          const u = j / n, d = amp * ((noise(s / 34, seed) - 0.5) * 1.8 + (rnd(seed, 'q', i, j) - 0.5) * 0.9);
          out.push([lerp(a[0], b[0], u) + nx * d, lerp(a[1], b[1], u) + ny * d]);
        }
      }
      return out;
    });
  };
  // Base outline for a named shape, centred on 0,0 and fitting w x h.
  D.shapePts = function (kind, w, h, seed = 1, o = {}) {
    return cachedPoly(`s${kind}|${w}|${h}|${seed}|${o.spikes || ''}|${o.inner || ''}`, () => {
      const pts = [];
      if (kind === 'rect') return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
      if (kind === 'triangle') return [[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
      if (kind === 'diamond') return [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]];
      if (kind === 'star') {
        const n = o.spikes || 5, inner = o.inner || 0.45;
        for (let i = 0; i < n * 2; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / n, k = i % 2 ? inner : 1;
          pts.push([Math.cos(a) * (w / 2) * k, Math.sin(a) * (h / 2) * k]);
        }
        return pts;
      }
      if (kind === 'heart') {
        for (let i = 0; i < 72; i++) {
          const a = (i / 72) * Math.PI * 2, x = 16 * Math.pow(Math.sin(a), 3);
          const y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
          pts.push([(x / 34) * w, (y / 30) * h + h * 0.05]);
        }
        return pts;
      }
      const blob = kind === 'blob';
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2, k = blob ? 0.82 + 0.3 * noise(i / 9, seed + 17) : 1;
        pts.push([Math.cos(a) * (w / 2) * k, Math.sin(a) * (h / 2) * k]);
      }
      return pts;
    });
  };
  D.PAPER_SHAPES = ['rect', 'ellipse', 'circle', 'triangle', 'diamond', 'star', 'heart', 'blob'];
  D.path = function (ctx, pts, ox = 0, oy = 0) {
    ctx.beginPath(); ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + ox, pts[i][1] + oy);
    ctx.closePath();
  };
  D.grainFill = function (ctx, x, y, w, h, alpha = 1) {
    if (!D.grainPattern) return;
    ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = D.grainPattern; ctx.fillRect(x, y, w, h); ctx.restore();
  };
  // A torn paper piece: soft fake shadow, light torn rim, colour fill, grain.
  // o: shadow (0..n), rim (false = none), rimColor, grain (false = none), grainAlpha, lift (0..1)
  D.paper = function (ctx, poly, rim, color, o = {}) {
    const sh = o.shadow == null ? 1 : o.shadow, lift = o.lift || 0;
    if (sh > 0) {
      ctx.fillStyle = D.sh(0.07 * sh * (1 - lift * 0.4)); D.path(ctx, rim, 11 + lift * 18, 15 + lift * 26); ctx.fill();
      ctx.fillStyle = D.sh(0.09 * sh * (1 - lift * 0.4)); D.path(ctx, rim, 5 + lift * 8, 7 + lift * 12); ctx.fill();
    }
    if (o.rim !== false) { ctx.fillStyle = D.color(o.rimColor || 'paper'); D.path(ctx, rim); ctx.fill(); }
    ctx.fillStyle = D.color(color); D.path(ctx, poly); ctx.fill();
    if (o.grain !== false) {
      ctx.save(); D.path(ctx, poly); ctx.clip();
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const p of rim) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
      D.grainFill(ctx, minx, miny, maxx - minx, maxy - miny, o.grainAlpha == null ? 0.95 : o.grainAlpha);
      ctx.restore();
    }
  };
  // Paper cut-out of a named shape (see D.PAPER_SHAPES), centred on 0,0.
  D.paperShape = function (ctx, kind, w, h, color, seed, o = {}) {
    const amp = o.amp == null ? Math.min(7, Math.max(2.5, Math.min(w, h) * 0.02)) : o.amp;
    let poly, rim;
    if (kind === 'rect') { poly = D.tornRect(Math.round(w), Math.round(h), seed, amp); rim = D.tornRect(Math.round(w) + 9, Math.round(h) + 9, seed + 101, amp * 0.8, 11); }
    else if (kind === 'ellipse' || kind === 'circle') { poly = D.tornEllipse(Math.round(w / 2), Math.round(h / 2), seed, amp); rim = D.tornEllipse(Math.round(w / 2) + 5, Math.round(h / 2) + 5, seed + 101, amp * 0.8); }
    else {
      const base = D.shapePts(kind, w, h, seed, o), big = D.shapePts(kind, w + 12, h + 12, seed, o);
      poly = D.tornPoly(`${kind}|${w}|${h}`, base, seed, amp * 0.8); rim = D.tornPoly(`${kind}|${w + 12}|${h + 12}`, big, seed + 101, amp * 0.6);
    }
    D.paper(ctx, poly, rim, color, o);
    return poly;
  };
  D.panel = function (ctx, P) {
    const poly = D.tornRect(P.w, P.h, P.seed, P.amp || 7);
    const rim = D.tornRect(P.w + 9, P.h + 9, P.seed + 101, (P.amp || 7) * 0.8, 11);
    ctx.save(); ctx.translate(P.x, P.y); if (P.r) ctx.rotate(deg(P.r));
    if (P.a != null) ctx.globalAlpha *= P.a;
    D.paper(ctx, poly, rim, P.color, P);
    ctx.restore();
    return poly;
  };
  D.tape = function (ctx, x, y, w, r, seed, h = 46) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(deg(r));
    const pts = [], n = 6;
    pts.push([-w / 2, -h / 2], [w / 2, -h / 2]);
    for (let i = 1; i < n; i++) pts.push([w / 2 + (i % 2 ? 5 : -3) + srnd(seed, 'r', i) * 2, -h / 2 + (h * i) / n]);
    pts.push([w / 2, h / 2], [-w / 2, h / 2]);
    for (let i = n - 1; i > 0; i--) pts.push([-w / 2 + (i % 2 ? -5 : 3) + srnd(seed, 'l', i) * 2, -h / 2 + (h * i) / n]);
    ctx.fillStyle = D.sh(0.1); D.path(ctx, pts, 2, 4); ctx.fill();
    ctx.fillStyle = D.alpha('tape', 0.86); D.path(ctx, pts); ctx.fill();
    ctx.save(); D.path(ctx, pts); ctx.clip(); D.grainFill(ctx, -w / 2 - 8, -h / 2, w + 16, h, 0.8);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-w / 2 - 8, -h / 2, w + 16, h * 0.35); ctx.restore();
    ctx.restore();
  };

  // ---------- ink ----------
  function cr(p0, p1, p2, p3, u) {
    const u2 = u * u, u3 = u2 * u;
    return [
      0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3),
      0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3),
    ];
  }
  const sampCache = new WeakMap();
  // Resample a polyline (Catmull-Rom smoothed when it has > 2 points) to ~step px spacing.
  // Each output point is [x, y, arcLength]. o.sharp keeps straight segments (no smoothing).
  D.resample = function (pts, step = 4, sharp = false) {
    const c = sampCache.get(pts);
    if (c && c.step === step && c.sharp === sharp) return c.out;
    const out = []; let s = 0, prev = null;
    const push = (p) => { if (prev) s += Math.hypot(p[0] - prev[0], p[1] - prev[1]); out.push([p[0], p[1], s]); prev = p; };
    if (pts.length === 2 || sharp) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], m = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let j = 0; j < m; j++) push([lerp(a[0], b[0], j / m), lerp(a[1], b[1], j / m)]);
      }
      push(pts[pts.length - 1]);
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
        const m = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
        for (let j = 0; j < m; j++) push(cr(p0, p1, p2, p3, j / m));
      }
      push(pts[pts.length - 1]);
    }
    sampCache.set(pts, { step, sharp, out }); return out;
  };
  // Draw a hand-inked stroke along pts. o: w, c, p (progress 0..1), seed, t, wob, boil, dash:[on,off], taper, sharp
  D.ink = function (ctx, pts, o = {}) {
    const p = o.p == null ? 1 : o.p;
    if (p <= 0.001 || !pts || pts.length < 2) return null;
    const smp = D.resample(pts, o.step || 4, !!o.sharp);
    const L = smp[smp.length - 1][2], Lp = L * clamp(p);
    const w = o.w || 5, seed = o.seed || 1, wob = o.wob == null ? 1.6 : o.wob;
    const boil = Math.floor((o.t || 0) * 8), boilAmp = o.boil == null ? 0.7 : o.boil;
    const tp = o.taper == null ? w * 2.5 + 3 : o.taper;
    const X = [], Y = [], W = [], S = [];
    for (let i = 0; i < smp.length; i++) {
      let [x, y, s] = smp[i];
      if (s > Lp) {
        const a = smp[i - 1]; const f = (Lp - a[2]) / Math.max(1e-6, s - a[2]);
        x = lerp(a[0], x, f); y = lerp(a[1], y, f); s = Lp;
      }
      const a = smp[Math.max(0, i - 1)], b = smp[Math.min(smp.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = -ty, ny = tx;
      const d = wob * (noise(s / 55, seed) - 0.5) * 2.2 + boilAmp * (noise(s / 13, seed * 7 + boil * 13) - 0.5) * 2;
      const taper = clamp(Math.min(s / tp, (Lp - s) / tp) * 0.8 + 0.2, 0.2, 1);
      const ww = w * (0.8 + 0.4 * noise(s / 80, seed + 3)) * taper;
      X.push(x + nx * d); Y.push(y + ny * d); W.push(ww); S.push(s);
      if (s >= Lp) break;
    }
    ctx.fillStyle = D.color(o.c || 'ink');
    const ribbon = (i0, i1) => {
      if (i1 - i0 < 1) return;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const a = Math.max(i0, i - 1), b = Math.min(i1, i + 1);
        const tx = X[b] - X[a], ty = Y[b] - Y[a]; const tl = Math.hypot(tx, ty) || 1;
        const nx = -ty / tl, ny = tx / tl;
        if (i === i0) ctx.moveTo(X[i] + nx * W[i] / 2, Y[i] + ny * W[i] / 2); else ctx.lineTo(X[i] + nx * W[i] / 2, Y[i] + ny * W[i] / 2);
      }
      for (let i = i1; i >= i0; i--) {
        const a = Math.max(i0, i - 1), b = Math.min(i1, i + 1);
        const tx = X[b] - X[a], ty = Y[b] - Y[a]; const tl = Math.hypot(tx, ty) || 1;
        const nx = -ty / tl, ny = tx / tl;
        ctx.lineTo(X[i] - nx * W[i] / 2, Y[i] - ny * W[i] / 2);
      }
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(X[i0], Y[i0], W[i0] / 2, 0, 7); ctx.arc(X[i1], Y[i1], W[i1] / 2, 0, 7); ctx.fill();
    };
    if (o.dash) {
      const [on, off] = o.dash; let st = -1;
      for (let i = 0; i < X.length; i++) {
        const inDash = (S[i] % (on + off)) < on;
        if (inDash && st < 0) st = i;
        if ((!inDash || i === X.length - 1) && st >= 0) { ribbon(st, i - (inDash ? 0 : 1)); st = -1; }
      }
    } else ribbon(0, X.length - 1);
    return { x: X[X.length - 1], y: Y[Y.length - 1] };
  };
  D.pathLength = (pts, sharp = false) => { const s = D.resample(pts, 4, sharp); return s[s.length - 1][2]; };
  // point + direction at progress p along a path
  D.tip = function (pts, p, sharp = false) {
    const smp = D.resample(pts, 4, sharp), L = smp[smp.length - 1][2] * clamp(p);
    for (let i = 1; i < smp.length; i++) if (smp[i][2] >= L) {
      const a = smp[i - 1], b = smp[i], f = (L - a[2]) / Math.max(1e-6, b[2] - a[2]);
      return { x: lerp(a[0], b[0], f), y: lerp(a[1], b[1], f), dx: b[0] - a[0], dy: b[1] - a[1] };
    }
    const a = smp[smp.length - 2], b = smp[smp.length - 1];
    return { x: b[0], y: b[1], dx: b[0] - a[0], dy: b[1] - a[1] };
  };
  const shapeCache = new Map();
  const cached = (key, fn) => { if (!shapeCache.has(key)) shapeCache.set(key, fn()); return shapeCache.get(key); };
  // A hand-drawn loop around (cx,cy); turns > 1 overlaps the start like a real pen circle.
  D.circlePts = (cx, cy, rx, ry, seed, turns = 1.13) => cached(`c${cx}|${cy}|${rx}|${ry}|${seed}|${turns}`, () => {
    const n = 90, a0 = -2.2 + rnd(seed, 'a0') * 0.8, pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = a0 + u * Math.PI * 2 * turns, k = 1 + (noise(u * 5, seed) - 0.5) * 0.09 + u * 0.05;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    return pts;
  });
  // A quadratic arc from (x0,y0) to (x1,y1); bend > 0 bows to the left of travel.
  D.arcPts = (x0, y0, x1, y1, bend = 0.25, n = 24) => cached(`a${x0}|${y0}|${x1}|${y1}|${bend}|${n}`, () => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0;
    const cx = mx - dy * bend, cy = my + dx * bend, pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      pts.push([(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1]);
    }
    return pts;
  });
  // Ink arrow along pts; the head appears once the stroke is complete. o as D.ink plus head (px)
  D.arrow = function (ctx, pts, o = {}) {
    const end = D.ink(ctx, pts, o);
    const p = o.p == null ? 1 : o.p;
    if (p < 0.97 || !end) return;
    const tp = D.tip(pts, 0.999, !!o.sharp), a = Math.atan2(tp.dy, tp.dx), s = o.head || 26;
    for (const k of [-1, 1]) {
      const ang = a + Math.PI - k * 0.5;
      D.ink(ctx, [[tp.x, tp.y], [tp.x + Math.cos(ang) * s, tp.y + Math.sin(ang) * s]], { ...o, p: 1, seed: (o.seed || 1) + k * 3, dash: null });
    }
  };
  D.check = function (ctx, x, y, s, o) {
    const pts = cached(`k${x}|${y}|${s}`, () => [[x - s * 0.5, y], [x - s * 0.12, y + s * 0.38], [x + s * 0.6, y - s * 0.55]]);
    D.ink(ctx, pts, o);
  };
  D.sparkle = function (ctx, x, y, r, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = D.color(color || 'accent');
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.quadraticCurveTo(Math.cos(a + Math.PI / 4) * r * 0.16, Math.sin(a + Math.PI / 4) * r * 0.16, Math.cos(a + Math.PI / 2) * r, Math.sin(a + Math.PI / 2) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  };
  // A sparkle that blinks on and twinkles; visible for local time u in [0, 0.85]
  D.sparkleAt = function (ctx, x, y, r, u, seed, color) {
    if (u <= 0 || u > 0.85) return;
    const k = Math.sin(clamp(u / 0.85) * Math.PI);
    D.sparkle(ctx, x, y, r * k, rnd(seed) * 3 + u * 2, color);
  };
  D.heart = function (ctx, x, y, s, c) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = D.color(c || 'coral'); ctx.beginPath();
    ctx.moveTo(0, s * 0.9);
    ctx.bezierCurveTo(-s * 1.4, 0, -s * 0.9, -s * 1.1, 0, -s * 0.35);
    ctx.bezierCurveTo(s * 0.9, -s * 1.1, s * 1.4, 0, 0, s * 0.9);
    ctx.fill(); ctx.restore();
  };
  // Soft radial light of colour c (any css colour) and strength a
  D.glow = function (ctx, x, y, r, c, a) {
    if (a <= 0) return;
    const g = ctx.createRadialGradient(x, y, 4, x, y, r);
    g.addColorStop(0, D.alpha(c, a)); g.addColorStop(1, D.alpha(c, 0));
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // ---------- SVG path data -> polylines ----------
  // Returns [{pts:[[x,y]...], closed}] with curves and arcs flattened; used for draw-on ink.
  D.svgPolylines = (d) => cached('svg' + d, () => {
    const toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    const out = []; let cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lcmd = '';
    const num = () => parseFloat(toks[i++]);
    const line = (nx, ny) => { cur.pts.push([nx, ny]); x = nx; y = ny; };
    const bez = (pts) => {
      const n = 16;
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u;
        if (pts.length === 3) line(v * v * x0 + 2 * v * u * pts[0][0] + u * u * pts[1][0], v * v * y0 + 2 * v * u * pts[0][1] + u * u * pts[1][1]);
        else line(v * v * v * x0 + 3 * v * v * u * pts[0][0] + 3 * v * u * u * pts[1][0] + u * u * u * pts[2][0],
          v * v * v * y0 + 3 * v * v * u * pts[0][1] + 3 * v * u * u * pts[1][1] + u * u * u * pts[2][1]);
      }
    };
    let x0 = 0, y0 = 0;
    const arc = (rx, ry, phi, large, sweep, ex, ey) => { // SVG spec F.6.5 endpoint -> centre
      if (!rx || !ry) return line(ex, ey);
      rx = Math.abs(rx); ry = Math.abs(ry);
      const c = Math.cos(deg(phi)), s = Math.sin(deg(phi));
      const dx = (x - ex) / 2, dy = (y - ey) / 2, x1 = c * dx + s * dy, y1 = -s * dx + c * dy;
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
      const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
      const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
      const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
      const cx = c * cx1 - s * cy1 + (x + ex) / 2, cy = s * cx1 + c * cy1 + (y + ey) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
      let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
      if (!sweep && dt > 0) dt -= Math.PI * 2; else if (sweep && dt < 0) dt += Math.PI * 2;
      const n = Math.max(4, Math.ceil(Math.abs(dt) / 0.2));
      for (let j = 1; j <= n; j++) {
        const a = t1 + (dt * j) / n;
        line(cx + rx * Math.cos(a) * c - ry * Math.sin(a) * s, cy + rx * Math.cos(a) * s + ry * Math.sin(a) * c);
      }
      x = ex; y = ey;
    };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
      x0 = x; y0 = y;
      if (C === 'M') {
        const nx = num() + ox, ny = num() + oy;
        cur = { pts: [[nx, ny]], closed: false }; out.push(cur); x = sx = nx; y = sy = ny;
        cmd = rel ? 'l' : 'L';
      } else if (C === 'Z') { if (cur) { cur.closed = true; cur.pts.push([sx, sy]); } x = sx; y = sy; cur = null; }
      else {
        if (!cur) { cur = { pts: [[x, y]], closed: false }; out.push(cur); }
        if (C === 'L') line(num() + ox, num() + oy);
        else if (C === 'H') line(num() + ox, y);
        else if (C === 'V') line(x, num() + oy);
        else if (C === 'C') { const a = [num() + ox, num() + oy], b = [num() + ox, num() + oy], e = [num() + ox, num() + oy]; bez([a, b, e]); lcx = b[0]; lcy = b[1]; }
        else if (C === 'S') {
          const a = /[CS]/i.test(lcmd) ? [2 * x0 - lcx, 2 * y0 - lcy] : [x0, y0];
          const b = [num() + ox, num() + oy], e = [num() + ox, num() + oy]; bez([a, b, e]); lcx = b[0]; lcy = b[1];
        } else if (C === 'Q') { const a = [num() + ox, num() + oy], e = [num() + ox, num() + oy]; bez([a, e]); lcx = a[0]; lcy = a[1]; }
        else if (C === 'T') {
          const a = /[QT]/i.test(lcmd) ? [2 * x0 - lcx, 2 * y0 - lcy] : [x0, y0];
          const e = [num() + ox, num() + oy]; bez([a, e]); lcx = a[0]; lcy = a[1];
        } else if (C === 'A') { const rx = num(), ry = num(), ph = num(), la = num(), sw = num(); arc(rx, ry, ph, la, sw, num() + ox, num() + oy); }
        else { i++; continue; }
      }
      lcmd = cmd;
    }
    return out.filter((p) => p.pts.length > 1);
  });

  // ---------- text ----------
  const widthCache = new Map();
  // Letters are drawn one at a time, so measure with ligatures broken (ZWNJ): a measured
  // "fi" ligature would place the i inside the f and it would vanish ("finds" -> "fnds").
  D.noLig = (s) => s.replace(/f(?=[fijlt])/g, 'f\u200c');
  D.prefixWidths = function (ctx, str) {
    const key = ctx.font + '|' + str;
    let a = widthCache.get(key);
    if (!a) { a = [0]; for (let i = 1; i <= str.length; i++) a.push(ctx.measureText(D.noLig(str.slice(0, i))).width); widthCache.set(key, a); }
    return a;
  };
  D.fontStr = (size, font, weight) => `${weight || 700} ${size}px ${D.font(font)}`;
  // Word-wrap str (keeps explicit \n) so no line is wider than maxW px in the given font.
  D.wrap = function (ctx, str, maxW, size, font, weight) {
    if (!maxW) return str;
    const key = `w${maxW}|${size}|${font}|${weight}|${str}`;
    return cached(key, () => {
      ctx.save(); ctx.font = D.fontStr(size, font, weight);
      const out = [];
      for (const para of str.split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
          const next = line ? line + ' ' + word : word;
          if (line && ctx.measureText(next).width > maxW) { out.push(line); line = word; } else line = next;
        }
        out.push(line);
      }
      ctx.restore(); return out.join('\n');
    });
  };
  // Handwritten text with a letter-by-letter write-on.
  // o: size, font (hand|print|ui|css stack), weight, c, align (center|left|right), p (0..1),
  //    t, seed, r (deg), lh (line height factor), id (for the text registry)
  // Returns {w, h} of the laid-out block.
  D.text = function (ctx, str, x, y, o = {}) {
    const p = o.p == null ? 1 : o.p;
    const size = o.size || 48, seed = o.seed || 7, boil = Math.floor((o.t || 0) * 8);
    ctx.save(); ctx.translate(x, y); if (o.r) ctx.rotate(deg(o.r));
    ctx.font = D.fontStr(size, o.font || 'hand', o.weight);
    ctx.fillStyle = D.color(o.c || 'ink'); ctx.textBaseline = 'alphabetic';
    const lines = String(str).split('\n'), lh = (o.lh || 1.15) * size;
    const total = lines.join('').length; const shown = p * total; let k = 0;
    const widths = lines.map((line) => D.prefixWidths(ctx, line)[line.length]);
    const Wmax = Math.max(0, ...widths);
    const xOf = (W) => (o.align === 'left' ? 0 : o.align === 'right' ? -W : -W / 2);
    if (p > 0) {
      const bx = o.align === 'left' ? 0 : o.align === 'right' ? -Wmax : -Wmax / 2;
      D.logText(ctx, o.id, String(str), bx, -size * 0.78, bx + Wmax, (lines.length - 1) * lh + size * 0.26, size, p);
      const baseA = ctx.globalAlpha;
      lines.forEach((line, li) => {
        const pw = D.prefixWidths(ctx, line), x0 = xOf(widths[li]);
        for (let i = 0; i < line.length; i++, k++) {
          const f = clamp(shown - k); if (f <= 0) break;
          if (line[i] === ' ') continue;
          const jy = srnd(seed, k, boil) * size * 0.018, jr = srnd(seed, 'r', k, boil) * 0.025;
          ctx.globalAlpha = baseA * f;
          ctx.save(); ctx.translate(x0 + pw[i], li * lh + jy + (1 - f) * size * 0.08); ctx.rotate(jr);
          ctx.fillText(line[i], 0, 0); ctx.restore();
        }
      });
    }
    ctx.restore();
    return { w: Wmax, h: lines.length * lh };
  };
  D.textWidth = function (ctx, str, size, font, weight) {
    ctx.save(); ctx.font = D.fontStr(size, font, weight);
    const w = Math.max(...String(str).split('\n').map((l) => D.prefixWidths(ctx, l)[l.length]));
    ctx.restore(); return w;
  };
  // A torn paper card, optionally with a speech-bubble tail toward (tail[0], tail[1]).
  D.card = function (ctx, w, h, o = {}) {
    const seed = o.seed || 5, bg = o.bg || 'paper';
    D.paper(ctx, D.tornRect(Math.round(w), Math.round(h), seed, 3.5), D.tornRect(Math.round(w) + 6, Math.round(h) + 6, seed + 100, 2.5), bg, { shadow: o.shadow == null ? 1 : o.shadow });
    if (o.tail) {
      const [tx, ty] = o.tail, side = ty > 0 ? h / 2 - 4 : -h / 2 + 4;
      ctx.fillStyle = D.color(bg);
      ctx.beginPath(); ctx.moveTo(tx * 0.2 - 18, side); ctx.lineTo(tx, ty); ctx.lineTo(tx * 0.2 + 18, side); ctx.closePath(); ctx.fill();
    }
  };

  // Ransom-note letters, each on its own torn scrap. Letters slap on from o.t0, o.dt apart.
  // o: size, seed, t, t0 (-Infinity = already landed), dt, r (deg), id
  const ransomCache = new Map();
  D.ransom = function (ctx, str, x, y, o = {}) {
    const size = o.size || 110, seed = o.seed || 3, ts = FILM.step(o.t || 0);
    const key = str + '|' + size + '|' + seed + '|' + D.RANSOM_FONTS.join('/') + D.RANSOM_BGS.join('/');
    let L = ransomCache.get(key);
    if (!L) {
      L = []; let cx = 0, k = 0;
      const bgs = D.RANSOM_BGS;
      const lum = (c) => { const q = parseColor(c) || [255, 255, 255]; return 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]; };
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === ' ') { cx += size * 0.34; continue; }
        const font = D.RANSOM_FONTS[Math.floor(rnd(seed, 'f', i) * D.RANSOM_FONTS.length)];
        const sz = size * (0.86 + rnd(seed, 's', i) * 0.28);
        ctx.save(); ctx.font = `400 ${sz}px ${font}`;
        const m = ctx.measureText(ch); ctx.restore();
        const gw = m.width, asc = m.actualBoundingBoxAscent || sz * 0.7, desc = m.actualBoundingBoxDescent || 0;
        const bg = bgs[Math.floor(rnd(seed, 'b', i) * bgs.length)];
        const w = gw + size * 0.3, h = asc + desc + size * 0.34;
        L.push({ ch, font, sz, gw, asc, desc, bg, fg: lum(bg) < 140 ? D.PAL.paper : D.PAL.ink, w, h, k: k++,
          x: cx + w / 2, dy: srnd(seed, 'y', i) * size * 0.07, r: srnd(seed, 'r', i) * 7, seed: seed * 100 + i });
        cx += w + size * 0.05;
      }
      L.total = cx - size * 0.05; ransomCache.set(key, L);
    }
    ctx.save(); ctx.translate(x, y); if (o.r) ctx.rotate(deg(o.r));
    const boil = Math.floor((o.t || 0) * 8), t0 = o.t0 == null ? -Infinity : o.t0;
    let landed = 0;
    for (const l of L) {
      const u = clamp((ts - (t0 + l.k * (o.dt || 0.09))) / 0.13);
      if (u <= 0) continue;
      landed++;
      const s = lerp(1.65, 1, E.out(u));
      ctx.save();
      ctx.translate(l.x - L.total / 2, l.dy);
      ctx.rotate(deg(l.r + srnd(l.seed, boil) * 0.6)); ctx.scale(s, s); ctx.globalAlpha *= clamp(u * 2.5);
      const poly = D.tornRect(Math.round(l.w), Math.round(l.h), l.seed, 3.2, 8);
      const rim = D.tornRect(Math.round(l.w) + 6, Math.round(l.h) + 6, l.seed + 9, 2.5, 7);
      D.paper(ctx, poly, rim, l.bg, { shadow: 1.3, grainAlpha: 0.7 });
      ctx.font = `400 ${l.sz}px ${l.font}`; ctx.fillStyle = l.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(l.ch, 0, (l.asc - l.desc) / 2);
      ctx.restore();
    }
    if (landed) D.logText(ctx, o.id, str, -L.total / 2, -size * 0.62, L.total / 2, size * 0.62, size, landed / Math.max(1, L.length));
    ctx.restore();
    return L.total;
  };

  // Glyph test: every letter must advance the write-on (no ligature may swallow a letter).
  // Checks each configured font stack; returns {ok, details:[{font, text, ok, minAdvance, zwnjChanged}]}
  // (minAdvance = smallest letter advance / that letter's own width; zwnjChanged = the font
  // ligates or kerns across the ZWNJ positions, i.e. the fix is doing work for this font).
  D.glyphTest = function (ctx, strings = ['finds fluffy office', 'fjord affix flute', 'waffle shift']) {
    const stacks = [['hand', D.HAND, 700], ['print', D.PRINT, 400]].concat(D.RANSOM_FONTS.map((f, i) => ['ransom' + i, f, 400]));
    const details = [];
    for (const [name, stack, weight] of stacks) {
      for (const str of strings) {
        ctx.save(); ctx.font = `${weight} 64px ${stack}`;
        const pw = D.prefixWidths(ctx, str);
        let ok = true, minAdv = Infinity, lig = false;
        for (let i = 0; i < str.length; i++) {
          const adv = pw[i + 1] - pw[i], alone = ctx.measureText(str[i]).width;
          const ratio = alone > 0 ? adv / alone : 1;
          minAdv = Math.min(minAdv, ratio);
          if (!(adv > 0) || ratio < 0.5) ok = false;
          if (Math.abs(ctx.measureText(str.slice(0, i + 1)).width - pw[i + 1]) > 0.5) lig = true;
        }
        ctx.restore();
        details.push({ font: name, stack, text: str, ok, minAdvance: +minAdv.toFixed(3), zwnjChanged: lig });
      }
    }
    return { ok: details.every((d) => d.ok), details };
  };
})();
