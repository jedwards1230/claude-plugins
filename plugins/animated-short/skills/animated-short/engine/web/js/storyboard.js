// Storyboard interpreter: turns the RESOLVED storyboard (web/film/storyboard.json, every time
// in seconds) into pictures. Layouts: `stage` (one full-frame scene at a time, with cuts,
// fades or slides) and `board` (a scrapbook grid of panels with a camera that travels between
// them and pulls back at the end). Elements: text | sprite | shape | svg-path | chart |
// equation | clip | group | custom. Beats: fade | pop | slide | move | scale | type-on |
// draw-on | count-up | morph | camera. Canvas downgrades: morph -> crossfade,
// equation -> text, clip -> poster sprite.
//
// The top half (cue parser, defaults, geometry, camera planner) touches no DOM, so
// tools/resolve.mjs loads this same file in a Node vm and shares one source of truth.
(function (root) {
  const FILM = (root.FILM = root.FILM || {});
  const { clamp, lerp, seg, E, deg } = FILM;
  const SB = (FILM.SB = {});
  FILM.shots = FILM.shots || {};
  // Shot files (web/film/shots/<id>.js) call FILM.shot('<id>', (ctx, t, api) => { ... }).
  FILM.shot = function (id, fn) { FILM.shots[id] = fn; };

  SB.VERSION = 1;
  SB.LAYOUTS = ['stage', 'board'];
  SB.KINDS = ['text', 'sprite', 'shape', 'svg-path', 'chart', 'equation', 'clip', 'group', 'custom'];
  SB.BEATS = ['fade', 'pop', 'slide', 'move', 'scale', 'type-on', 'draw-on', 'count-up', 'morph', 'camera'];
  SB.SHAPES = ['rect', 'ellipse', 'circle', 'triangle', 'diamond', 'star', 'heart', 'blob', 'arrow', 'line', 'ring', 'check', 'sparkle', 'tape'];
  SB.TRANSITIONS = ['cut', 'fade', 'slide'];
  // Default beat lengths (s). type-on defaults to characters / cps instead.
  SB.BEAT_DUR = { fade: 0.4, pop: 0.3, slide: 0.45, move: 0.6, scale: 0.35, 'draw-on': 0.5, 'count-up': 1.0, morph: 0.5, camera: 1.2 };
  SB.CPS = 30;
  // Text styles; every field can be overridden on the element.
  SB.TEXT_STYLES = {
    title: { ransom: true, size: 110, cps: 14 },
    heading: { font: 'hand', weight: 700, size: 80, color: 'ink', underline: 'accent', cps: 30 },
    body: { font: 'hand', weight: 700, size: 48, color: 'ink', cps: 26 },
    label: { font: 'print', weight: 400, size: 32, color: 'pencil', cps: 40 },
    caption: { font: 'print', weight: 400, size: 40, color: 'ink', cps: 40 },
  };

  // ---------------------------------------------------------------- cues
  // 12.5 | "12.5" | "+0.8" (relative to the previous cue in the same list) | "end" |
  // "vo:<line>" | "vo:<line>.end" | "vo:<line>.w<i>" | "vo:<line>.w<i>.end" (i is 0-based) |
  // "beat:<n>" | "bar:<n>" (0-based) | "scene:<id>" | "scene:<id>.end"; any non-relative cue
  // may end in an offset such as "+0.3" or "-0.2".
  const NUM = '\\d+(?:\\.\\d+)?', ID = '[A-Za-z0-9_-]+';
  SB.CUE_RE = new RegExp(`^(?:(\\+${NUM})|(${NUM}|end|vo:(${ID})(?:\\.w(\\d+))?(\\.end)?|beat:(\\d+)|bar:(\\d+)|scene:(${ID})(\\.end)?)([+-]${NUM})?)$`);
  SB.isCue = (c) => (typeof c === 'number' && isFinite(c)) || (typeof c === 'string' && SB.CUE_RE.test(c.trim()));
  // env: {vo: {id: {at, dur, words: [{w, s, e}] absolute}}, beats, downbeats, duration,
  //       scenes: {id: {at, until}}, prev (previous cue in the list), anchor (list start)}
  SB.resolveCue = function (cue, env = {}) {
    if (typeof cue === 'number') { if (!isFinite(cue)) throw new Error('not a finite number'); return cue; }
    if (typeof cue !== 'string') throw new Error(`cue must be a number or string, got ${JSON.stringify(cue)}`);
    const m = SB.CUE_RE.exec(cue.trim());
    if (!m) throw new Error(`"${cue}" is not a cue (see the cue syntax)`);
    if (m[1]) return +((env.prev != null ? env.prev : env.anchor || 0) + parseFloat(m[1])).toFixed(4);
    let v;
    const b = m[2];
    if (/^\d/.test(b)) v = parseFloat(b);
    else if (b === 'end') { if (env.duration == null) throw new Error('"end" needs meta.duration'); v = env.duration; }
    else if (m[3]) {
      const line = env.vo && env.vo[m[3]];
      if (!line) throw new Error(`unknown voice line "${m[3]}" (no words.json entry)`);
      if (m[4] != null) {
        const w = line.words && line.words[+m[4]];
        if (!w) throw new Error(`line "${m[3]}" has ${line.words ? line.words.length : 0} words; w${m[4]} does not exist`);
        v = m[5] ? w.e : w.s;
      } else v = m[5] ? line.at + line.dur : line.at;
    } else if (m[6] != null) {
      const x = env.beats && env.beats[+m[6]];
      if (x == null) throw new Error(`beat:${m[6]} does not exist (${env.beats ? env.beats.length : 0} beats)`);
      v = x;
    } else if (m[7] != null) {
      const x = env.downbeats && env.downbeats[+m[7]];
      if (x == null) throw new Error(`bar:${m[7]} does not exist (${env.downbeats ? env.downbeats.length : 0} bars)`);
      v = x;
    } else if (m[8]) {
      const sc = env.scenes && env.scenes[m[8]];
      if (!sc) throw new Error(`unknown scene "${m[8]}" (or it is not resolved yet)`);
      v = m[9] ? sc.until : sc.at;
      if (v == null) throw new Error(`scene "${m[8]}" has no resolved ${m[9] ? 'until' : 'at'} yet`);
    }
    if (m[10]) v += parseFloat(m[10]);
    return +v.toFixed(4);
  };

  // ---------------------------------------------------------------- defaults and geometry
  const plain = (s) => String(s || '').replace(/\n/g, '');
  SB.forEachElement = function (sb, fn) {
    const walk = (els, scene, parent) => (els || []).forEach((el) => { fn(el, scene, parent); if (el.kind === 'group') walk(el.children, scene, el); });
    (sb.scenes || []).forEach((sc) => walk(sc.elements, sc, null));
  };
  SB.textStyle = (el) => Object.assign({}, SB.TEXT_STYLES[el.style || (el.kind === 'equation' ? 'caption' : 'body')] || SB.TEXT_STYLES.body, el);
  // Number of characters a type-on reveals for an element (text + sub line).
  SB.textLength = (el) => {
    if (!el) return 0;
    if (el.kind === 'equation') return plain(el.text || el.tex).length;
    return plain(el.text).length + plain(el.sub).length;
  };
  SB.refSize = function (size) {
    const [W, H] = size, f = 1080 / Math.min(W, H);
    return [Math.round(W * f), Math.round(H * f)];
  };
  SB.panelScenes = (sb) => (sb.scenes || []).filter((s) => !s.overlay);
  // Fill defaults in place (engine and resolve.mjs both call this). Returns a list of downgrade notes.
  SB.normalize = function (sb) {
    const meta = (sb.meta = Object.assign({ fps: 30, size: [1920, 1080], seed: 1, title: '' }, sb.meta || {}));
    if (!(meta.duration > 0)) throw new Error('meta.duration must be a positive number of seconds');
    const [RW, RH] = SB.refSize(meta.size);
    const L = (sb.layout = Object.assign({ type: 'stage' }, sb.layout || {}));
    const panels = SB.panelScenes(sb);
    if (L.type === 'board') {
      const n = Math.max(1, panels.length);
      if (!L.grid) { const c = Math.ceil(Math.sqrt(n)); L.grid = [c, Math.ceil(n / c)]; }
      L.panel = L.panel || [Math.round(RW * 0.927), Math.round(RH * 0.926)];
      L.gutter = L.gutter || [Math.round(L.panel[0] * 0.35), Math.round(L.panel[1] * 0.4)];
      if (L.arrows == null) L.arrows = true;
      if (L.doodles == null) L.doodles = true;
      if (L.finale !== false) {
        const last = panels[panels.length - 1];
        const f = Object.assign({ dur: 2.1 }, L.finale || {});
        if (f.at == null) f.at = Math.max(last ? last.at + 1 : 0, meta.duration - f.dur - 0.6);
        L.finale = f;
      }
      panels.forEach((s, i) => {
        if (!s.cell) s.cell = [i % L.grid[0], Math.floor(i / L.grid[0])];
        s.panel = Object.assign({ index: i, r: (i % 2 ? 1 : -1) * (0.3 + 0.15 * FILM.rnd(meta.seed, s.id, 'tilt')), seed: 11 + i * 10 }, s.panel || {});
      });
    }
    if (L.whoosh == null) L.whoosh = true;
    if (L.handheld == null) L.handheld = 1;
    const index = {};
    SB.forEachElement(sb, (el) => { index[el.id] = el; });
    const notes = [];
    SB.forEachElement(sb, (el) => {
      if (el.kind === 'equation') notes.push(`equation "${el.id}" renders as plain text on the canvas engine`);
      if (el.kind === 'clip') notes.push(`clip "${el.id}" renders as its poster sprite on the canvas engine`);
    });
    for (const sc of sb.scenes || []) {
      for (const b of sc.beats || []) {
        if (b.until != null && b.dur == null) b.dur = Math.max(0.01, b.until - b.at);
        if (b.dur == null) {
          if (b.do === 'type-on') {
            const el = index[b.target], st = el ? SB.textStyle(el) : {};
            b.dur = +(Math.max(1, SB.textLength(el)) / (b.cps || st.cps || SB.CPS)).toFixed(3);
          } else b.dur = SB.BEAT_DUR[b.do] || 0.4;
        }
        if (b.do === 'morph') notes.push(`morph "${b.target}" -> "${b.to}" renders as a crossfade on the canvas engine`);
      }
    }
    sb.downgrades = notes;
    return notes;
  };

  // World geometry. Units are px of the 1080-line reference frame (short side = 1080).
  SB.geometry = function (sb) {
    const [RW, RH] = SB.refSize(sb.meta.size), L = sb.layout, g = { RW, RH, board: L.type === 'board' };
    if (g.board) {
      const [pw, ph] = L.panel, [gx, gy] = L.gutter;
      Object.assign(g, { pw, ph, gx, gy, cellW: pw + gx, cellH: ph + gy });
      g.W = L.grid[0] * g.cellW; g.H = L.grid[1] * g.cellH;
    } else { g.W = RW; g.H = RH; }
    g.center = (sc) => (g.board && !sc.overlay ? [g.cellW * (sc.cell[0] + 0.5), g.cellH * (sc.cell[1] + 0.5)] : [RW / 2, RH / 2]);
    g.box = (sc) => (g.board && !sc.overlay ? [g.pw, g.ph] : [RW, RH]);
    return g;
  };

  // ---------------------------------------------------------------- camera
  // camAt(keys, t) -> {x, y, z, r}. Keys: {t, x, y, z, r, ease: sine|cubic|linear, cut, zoomTo}.
  // zoomTo keys zoom about a fixed point (the centre moves linearly in 1/z), which keeps a
  // pull-back from swinging sideways; cut keys hold the previous key until they start.
  SB.camAt = function (keys, t) {
    if (!keys.length) return { x: 0, y: 0, z: 1, r: 0 };
    if (t <= keys[0].t) return keys[0];
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (t < b.t || (t === b.t && !b.cut)) {
        if (b.cut) return a;
        const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
        const ez = b.ease === 'cubic' ? E.inOut(u) : b.ease === 'linear' ? u : E.sine(u);
        let z = Math.exp(lerp(Math.log(a.z), Math.log(b.z), ez));
        if (b.zoomTo && Math.abs(1 / b.z - 1 / a.z) > 1e-9) {
          const f = (1 / z - 1 / a.z) / (1 / b.z - 1 / a.z);
          return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z, r: lerp(a.r, b.r, ez) };
        }
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist > 1300 && Math.abs(Math.log(b.z / a.z)) < 0.5) z *= 1 - 0.1 * Math.sin(Math.PI * u);
        return { x: lerp(a.x, b.x, ez), y: lerp(a.y, b.y, ez), z, r: lerp(a.r, b.r, ez) };
      }
    }
    return keys[keys.length - 1];
  };
  // planCamera(sb) -> {keys, moves}. sb must be normalized. Board layouts get an automatic path:
  // settle on each panel in scene order (slow push-in while it plays), a sine pan to the
  // next one around its start, and a finale pull-back to the whole board. Stage layouts hold
  // the frame and cut back to it at each scene. Source camera keys ({at, scene?, focus?, x?,
  // y?, z?, r?, ease?, cut?}) replace the automatic path; camera beats are layered on top.
  SB.planCamera = function (sb) {
    const g = SB.geometry(sb), L = sb.layout, dur = sb.meta.duration, keys = [], moves = [];
    const byId = {}; (sb.scenes || []).forEach((s) => { byId[s.id] = s; });
    const K = (t, c, dx, dy, z, r, ease, extra) => Object.assign({ t: +t.toFixed(4), x: c[0] + dx, y: c[1] + dy, z, r, ease: ease || 'sine' }, extra || {});
    const focusPt = (sc, f, target) => {
      const c = g.center(sc), [bw, bh] = g.box(sc);
      let fx = f ? f[0] : 0.5, fy = f ? f[1] : 0.5;
      if (target) { const el = SB.findElement(sb, target); if (el && el.pos) { fx = el.pos[0]; fy = el.pos[1]; } }
      return [c[0] + (fx - 0.5) * bw, c[1] + (fy - 0.5) * bh];
    };
    const explicit = sb.camera && Array.isArray(sb.camera.keys) && sb.camera.keys.length && !sb.camera.resolved;
    if (explicit) {
      for (const k of sb.camera.keys) {
        const sc = k.scene ? byId[k.scene] : null;
        const p = sc ? focusPt(sc, k.focus) : [k.x != null ? k.x : g.RW / 2, k.y != null ? k.y : g.RH / 2];
        keys.push(K(k.at, p, 0, 0, k.z || 1, k.r || 0, k.ease, { cut: !!k.cut, zoomTo: !!k.zoomTo, role: 'key' }));
      }
      keys.sort((a, b) => a.t - b.t);
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (!b.cut && (Math.hypot(b.x - a.x, b.y - a.y) > 40 || Math.abs(Math.log(b.z / a.z)) > 0.05)) moves.push({ from: a.t, to: b.t });
      }
    } else if (g.board) {
      const ps = SB.panelScenes(sb);
      if (ps.length) {
        keys.push(K(0, g.center(ps[0]), -20, 10, 1.03, 0, 'sine', { scene: ps[0].id, role: 'start' }));
        for (let i = 1; i < ps.length; i++) {
          const a = ps[i - 1], b = ps[i], ca = g.center(a), cb = g.center(b), odd = i % 2 === 1;
          const pan = clamp(0.55 + Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) / 3000, 0.8, 1.6);
          const leave = b.at - pan * 0.72, arrive = b.at + pan * 0.28;
          keys.push(K(leave, ca, odd ? 30 : 0, odd ? -10 : 10, i === 1 ? 1.075 : 1.045, odd ? 0.2 : -0.1, 'sine', { scene: a.id, role: 'leave' }));
          keys.push(K(arrive, cb, 0, 0, 1.0, odd ? -0.3 : 0.3, 'sine', { scene: b.id, role: 'arrive' }));
          moves.push({ from: +leave.toFixed(4), to: +arrive.toFixed(4), scene: a.id, next: b.id });
        }
        const last = ps[ps.length - 1], cl = g.center(last);
        if (L.finale) {
          const z0 = L.finale.at, z1 = z0 + L.finale.dur, zFit = Math.min(g.RW / g.W, g.RH / g.H) * 1.02;
          const mid = [g.W / 2, g.H / 2];
          keys.push(K(z0, cl, 40, 30, 1.07, 0.3, 'sine', { scene: last.id, role: 'leave' }));
          keys.push(K(z1, mid, 0, 0, zFit, 0, 'cubic', { zoomTo: true, role: 'finale' }));
          keys.push(K(Math.max(dur, z1 + 0.1), mid, 0, 0, zFit * 1.045, 0, 'sine', { role: 'hold' }));
          moves.push({ from: +z0.toFixed(4), to: +z1.toFixed(4), scene: last.id, finale: true });
        } else keys.push(K(Math.max(dur, last.at + 0.1), cl, 30, -10, 1.045, 0.2, 'sine', { scene: last.id, role: 'leave' }));
        keys.sort((p, q) => p.t - q.t);
      }
    } else {
      const base = [g.RW / 2, g.RH / 2];
      keys.push(K(0, base, 0, 0, 1, 0, 'sine', { role: 'start' }));
      SB.panelScenes(sb).forEach((sc, i) => { if (i > 0) keys.push(K(sc.at, base, 0, 0, 1, 0, 'sine', { cut: true, scene: sc.id, role: 'cut' })); });
      keys.push(K(Math.max(dur, 0.1), base, 0, 0, 1, 0, 'sine', { role: 'hold' }));
    }
    // camera beats: move from wherever the camera is to the beat's framing, then hold it
    const cbeats = [];
    (sb.scenes || []).forEach((sc) => (sc.beats || []).forEach((b) => { if (b.do === 'camera') cbeats.push({ b, sc }); }));
    cbeats.sort((p, q) => p.b.at - q.b.at);
    for (const { b, sc } of cbeats) {
      const from = SB.camAt(keys, b.at), to = focusPt(sc, b.focus, b.target);
      const k0 = K(b.at, [from.x, from.y], 0, 0, from.z, from.r, 'sine', { role: 'beat' });
      const k1 = K(b.at + b.dur, to, 0, 0, b.z || 1.3, b.r || 0, b.ease === 'cubic' || b.ease === 'linear' ? b.ease : 'sine', { role: 'beat', scene: sc.id });
      for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t > k0.t && keys[i].t < k1.t) keys.splice(i, 1);
      keys.push(k0, k1); keys.sort((p, q) => p.t - q.t);
      // hold the new framing: the scene's next resting key (its 'leave' or the final 'hold')
      // takes the beat's framing with a small drift; a following cut or move starts from it
      const nxt = keys[keys.indexOf(k1) + 1];
      if (nxt && ((nxt.role === 'leave' && nxt.scene === sc.id) || nxt.role === 'hold')) Object.assign(nxt, { x: k1.x + 10, y: k1.y - 6, z: k1.z * 1.02, r: k1.r });
      moves.push({ from: b.at, to: +(b.at + b.dur).toFixed(4), scene: sc.id, beat: true });
    }
    moves.sort((p, q) => p.from - q.from);
    return { keys, moves };
  };
  SB.findElement = function (sb, id) { let hit = null; SB.forEachElement(sb, (el) => { if (el.id === id) hit = el; }); return hit; };

  // ---------------------------------------------------------------- runtime (browser)
  // Everything below runs only in the page (it needs FILM.D and FILM.ACT).
  let S = null; // prepared state

  // prepare(sb, cfg): index elements and beats, plan the camera, precompute board dressing.
  SB.prepare = function (sb) {
    SB.normalize(sb);
    const g = SB.geometry(sb), nodes = {}, meta = sb.meta;
    const cam = sb.camera && sb.camera.resolved && sb.camera.keys ? { keys: sb.camera.keys, moves: sb.camera.moves || [] } : SB.planCamera(sb);
    S = { sb, g, nodes, keys: cam.keys, moves: cam.moves, scenes: sb.scenes || [] };
    S.panels = SB.panelScenes(sb);
    S.overlays = S.scenes.filter((s) => s.overlay);
    const add = (el, scene, parent, box, idx) => {
      const node = { el, id: el.id, scene, parent, box, beats: [], children: [], seed: FILM.ACT.seed(el.id, meta.seed), idx };
      const pos = el.pos || [0.5, 0.5];
      node.x = (pos[0] - 0.5) * box[0]; node.y = (pos[1] - 0.5) * box[1];
      nodes[el.id] = node;
      if (el.kind === 'group') {
        const gb = [el.w || box[0], el.h || box[1]];
        (el.children || []).forEach((c, i) => node.children.push(add(c, scene, node, gb, i)));
      }
      return node;
    };
    for (const sc of S.scenes) sc._nodes = (sc.elements || []).map((el, i) => add(el, sc, null, g.box(sc), i));
    for (const sc of S.scenes) {
      for (const b of sc.beats || []) {
        if (b.do === 'camera') continue;
        const n = nodes[b.target];
        if (!n) { console.warn(`beat target "${b.target}" not found`); continue; }
        if (b.do === 'morph') {
          n.beats.push(Object.assign({}, b, { role: 'out' }));
          if (nodes[b.to]) nodes[b.to].beats.push(Object.assign({}, b, { role: 'in' }));
        } else n.beats.push(b);
      }
    }
    for (const id in nodes) nodes[id].beats.sort((a, b) => a.at - b.at);
    // runtime cue table for shots: vo lines with word times, beat grid, scenes
    const vo = {}; (sb.vo || []).forEach((v) => { vo[v.id] = v; });
    const scenes = {}; S.scenes.forEach((s) => { scenes[s.id] = { at: s.at, until: s.until }; });
    S.env = { vo, beats: (sb.timing && sb.timing.beats) || [], downbeats: (sb.timing && sb.timing.downbeats) || [], duration: meta.duration, scenes };
    if (g.board) {
      const r = FILM.rng('stains:' + meta.seed), n = Math.round((g.W + 1200) * (g.H + 1000) / 950000);
      S.stains = [...Array(n)].map(() => ({ x: -600 + r() * (g.W + 1200), y: -500 + r() * (g.H + 1000), rad: 160 + r() * 520, a: 0.03 + r() * 0.05 }));
    }
    for (const note of sb.downgrades || []) console.info('[downgrade] ' + note);
    return S;
  };
  SB.state = () => S;
  SB.cam = (t) => SB.camAt(S.keys, t);

  // ---- element state from beats (pure in ts)
  const CHANNELS = { fade: ['fade'], pop: ['pop'], slide: ['slide'], move: ['pos'], scale: ['scale'], 'type-on': ['p'], 'draw-on': ['p'], 'count-up': ['count'], morph: ['morph'] };
  const EASE = (name, u, dflt) => {
    const e = name || dflt;
    if (e === 'back') return E.back(u, 1.7);
    if (e === 'spring') return FILM.ACT.settle(u * 1.2, { freq: 1.6, damp: 6 });
    return (E[e] || E.linear)(u);
  };
  function applyBeat(b, u, s, ts, node) {
    const [bw, bh] = node.box;
    switch (b.do) {
      case 'fade': { const to = b.to == null ? 1 : b.to, from = b.from == null ? (to > 0 ? 0 : 1) : b.from; s.aFade = lerp(from, to, EASE(b.ease, u, 'sine')); break; }
      case 'pop': s.pop = E.back(u, b.k || 2.3); s.lift = (1 - u) * 0.8; s.r += (1 - u) * (b.spin == null ? 12 : b.spin); s.aPop = u > 0 ? 1 : 0; break;
      case 'slide': {
        if (b.to) { const e = E.in(u); s.dx += b.to[0] * e; s.dy += b.to[1] * e; s.aSlide = 1 - e; }
        else { const f = b.from || [-240, 0], e = E.back(u, 1.3); s.dx += f[0] * (1 - e); s.dy += f[1] * (1 - e); s.aSlide = clamp(u * 4); s.lift = Math.max(s.lift, (1 - u) * 0.5); }
        break;
      }
      case 'move': {
        const x0 = s.x, y0 = s.y, x1 = b.to ? (b.to[0] - 0.5) * bw : x0 + (b.by ? b.by[0] : 0), y1 = b.to ? (b.to[1] - 0.5) * bh : y0 + (b.by ? b.by[1] : 0);
        const e = EASE(b.ease, u, 'sine');
        s.x = lerp(x0, x1, e); s.y = lerp(y0, y1, e) - (b.arc ? Math.sin(u * Math.PI) * b.arc : 0);
        if (b.arc && b.squash !== false) {
          const k = u < 1 ? -0.12 * Math.sin(u * Math.PI) : 0.14 * (1 - FILM.ACT.settle(ts - (b.at + b.dur), { freq: 3, damp: 9 }));
          const q = FILM.ACT.squash(k); s.sx *= q.sx; s.sy *= q.sy;
        }
        break;
      }
      case 'scale': {
        const from = b.from == null ? s.scale : b.from, to = b.to == null ? 1.2 : b.to;
        const v = b.ease ? EASE(b.ease, u) : (u <= 0 ? 0 : FILM.ACT.settle(ts - b.at, { freq: 1.1 / b.dur, damp: 4.5 / b.dur }));
        s.scale = lerp(from, to, v); break;
      }
      case 'type-on': s.p = u; s.typeAt = b.at; s.typeDur = b.dur; s.typeEnd = b.at + b.dur; break;
      case 'draw-on': s.p = EASE(b.ease, u, 'linear'); s.typeEnd = b.at + b.dur; break;
      case 'count-up': {
        const from = b.from == null ? (s.count == null ? 0 : s.count) : b.from, to = b.to == null ? 0 : b.to;
        s.count = lerp(from, to, EASE(b.ease, u, 'out')); s.countUp = to >= from; s.decimals = b.decimals || 0; break;
      }
      case 'morph': { const e = EASE(b.ease, u, 'sine'); s.aMorph = b.role === 'in' ? e : 1 - e; break; }
      default: break;
    }
  }
  function nodeState(node, ts) {
    const el = node.el;
    const s = { x: node.x, y: node.y, dx: 0, dy: 0, scale: el.scale == null ? 1 : el.scale, pop: 1, sx: 1, sy: 1, r: el.r || 0,
      aFade: 1, aPop: 1, aSlide: 1, aMorph: 1, lift: 0, p: 1, count: null, typeEnd: -Infinity, typeAt: null, typeDur: null };
    const seen = {};
    for (const b of node.beats) {
      const ch = CHANNELS[b.do] || [];
      if (ts < b.at) { if (!ch.some((c) => seen[c])) applyBeat(b, 0, s, ts, node); ch.forEach((c) => { seen[c] = true; }); continue; }
      applyBeat(b, clamp((ts - b.at) / Math.max(1e-6, b.dur)), s, ts, node);
      ch.forEach((c) => { seen[c] = true; });
    }
    s.alpha = (el.alpha == null ? 1 : el.alpha) * s.aFade * s.aPop * s.aSlide * s.aMorph;
    return s;
  }
  SB.nodeState = (id, t) => nodeState(S.nodes[id], FILM.step(t));

  // ---- element drawing
  const D = () => FILM.D;
  // count-ups truncate toward the target, so the final value appears only when the beat ends
  const fmtCount = (el, s) => {
    const k = Math.pow(10, s.decimals), v = s.countUp ? Math.floor(s.count * k + 1e-6) / k : Math.ceil(s.count * k - 1e-6) / k;
    const n = v.toFixed(s.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return el.text && el.text.includes('{n}') ? el.text.replace('{n}', n) : n;
  };
  const TEX = [[/\\times/g, '\u00d7'], [/\\cdot/g, '\u00b7'], [/\\pi/g, '\u03c0'], [/\\approx/g, '\u2248'], [/\\le/g, '\u2264'], [/\\ge/g, '\u2265'],
    [/\\neq/g, '\u2260'], [/\\sqrt\{([^}]*)\}/g, '\u221a($1)'], [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)'], [/\^2/g, '\u00b2'], [/\^3/g, '\u00b3'],
    [/\\[a-zA-Z]+/g, ''], [/[{}]/g, '']];
  const texToText = (tex) => TEX.reduce((s, [re, r]) => s.replace(re, r), String(tex || ''));

  function drawText(ctx, node, s, t, ts) {
    const d = D(), el = node.el, st = SB.textStyle(el);
    let str = el.kind === 'equation' ? (el.text || texToText(el.tex)) : String(el.text == null ? '' : el.text);
    if (s.count != null) str = fmtCount(el, s);
    const size = st.size, font = st.font || 'hand', weight = st.weight || (font === 'print' ? 400 : 700);
    if (st.w && !st.ransom) str = d.wrap(ctx, str, st.w, size, font, weight);
    const id = node.id, color = st.color || 'ink';
    if (st.ransom) {
      const n = Math.max(1, str.replace(/ /g, '').length);
      d.ransom(ctx, str, 0, 0, { size, seed: node.seed % 97, t, t0: s.typeAt == null ? -Infinity : s.typeAt, dt: s.typeDur == null ? 0.09 : s.typeDur / n, id });
      return;
    }
    const lh = st.lh || 1.15, lines = str.split('\n'), sub = st.sub ? String(st.sub) : null;
    const nMain = plain(str).length, nSub = sub ? plain(sub).length : 0, shown = s.p * (nMain + nSub);
    const pMain = nMain ? clamp(shown / nMain) : 1, pSub = nSub ? clamp((shown - nMain) / nSub) : 1;
    if (st.card) {
      // paper card behind the block: baseline of line 1 is y = 0, glyphs span about -0.8..+0.28 size
      const c = st.card === true ? {} : st.card, pad = c.pad == null ? size * 0.45 : c.pad;
      const W = Math.max(d.textWidth(ctx, str, size, font, weight), sub ? d.textWidth(ctx, sub, Math.round(size * 0.8), font, weight) : 0);
      const top = -size * 0.8, bottom = (lines.length - 1) * size * lh + size * 0.28 + (sub ? size * 0.8 * lh : 0);
      const tw = W + pad * 2, th = bottom - top + pad * 1.2;
      const cx = st.align === 'left' ? W / 2 : st.align === 'right' ? -W / 2 : 0, cy = (top + bottom) / 2;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(deg(-1.2)); ctx.globalAlpha *= s.typeAt == null && s.p >= 1 ? 1 : clamp(s.p * 8);
      d.card(ctx, tw, th, { bg: c.color || 'paper', seed: node.seed % 1000, tail: c.tail, shadow: c.shadow });
      ctx.restore();
    }
    if (pMain > 0) d.text(ctx, str, 0, 0, { size, font, weight, c: color, align: st.align, p: pMain, t, seed: node.seed % 1000, lh, id });
    if (sub && pSub > 0) {
      d.text(ctx, sub, 0, lines.length * size * lh - size * 0.08, { size: Math.round(size * 0.8), font, weight, c: st.sub_color || d.alpha(color === 'pencil' ? 'pencil' : color, 0.62),
        align: st.align, p: pSub, t, seed: (node.seed + 7) % 1000, lh, id: id + ':sub' });
    }
    if (st.underline && s.p >= 1) {
      const w = d.textWidth(ctx, lines[0], size, font, weight), x0 = st.align === 'left' ? 0 : st.align === 'right' ? -w : -w / 2;
      const u = s.typeEnd === -Infinity ? 1 : seg(ts, s.typeEnd, s.typeEnd + 0.3);
      const pts = d.arcPts(Math.round(x0 - 6), Math.round(size * 0.27), Math.round(x0 + w + 12), Math.round(size * 0.3), 0.02, 12);
      d.ink(ctx, pts, { w: Math.max(4, size * 0.07), p: u, seed: 9, t, c: st.underline === true ? 'accent' : st.underline });
    }
  }
  function toLocal(node, f) { return [(f[0] - 0.5) * node.box[0] - node.x, (f[1] - 0.5) * node.box[1] - node.y]; }
  function drawShape(ctx, node, s, t) {
    const d = D(), el = node.el, kind = el.shape || 'rect', w = el.w || 200, h = el.h || (kind === 'circle' ? w : w * 0.7);
    const ink = { w: el.stroke_w || 5, seed: node.seed % 1000, t, c: el.stroke || 'ink', p: s.p, dash: el.dash, wob: el.wob };
    if (kind === 'arrow') {
      const a = toLocal(node, el.from || [0.3, 0.5]), b = toLocal(node, el.to || [0.7, 0.5]);
      d.arrow(ctx, d.arcPts(Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]), el.bend == null ? 0.2 : el.bend), { ...ink, head: el.head || 26 });
    } else if (kind === 'line') {
      d.ink(ctx, (el.points || [[0.3, 0.5], [0.7, 0.5]]).map((f) => toLocal(node, f)), ink);
    } else if (kind === 'ring') {
      d.ink(ctx, d.circlePts(0, 0, Math.round(w / 2), Math.round(h / 2), node.seed % 1000, el.turns || 1.13), ink);
    } else if (kind === 'check') {
      d.check(ctx, 0, 0, w, ink);
    } else if (kind === 'sparkle') {
      if (el.twinkle) d.sparkleAt(ctx, 0, 0, w / 2, ((t * (el.rate || 0.6)) + FILM.rnd(node.seed)) % 1.2, node.seed, el.color || 'accent');
      else d.sparkle(ctx, 0, 0, (w / 2) * clamp(s.p), FILM.rnd(node.seed) * 3, el.color || 'accent');
    } else if (kind === 'tape') {
      d.tape(ctx, 0, 0, w, 0, node.seed % 1000, el.h || 46);
    } else {
      const color = el.color || 'accent';
      if (s.p < 1) {
        const base = d.shapePts(kind === 'circle' ? 'ellipse' : kind, w, h, node.seed % 1000, el);
        d.ink(ctx, base.concat([base[0]]), { ...ink, sharp: ['rect', 'triangle', 'diamond', 'star'].includes(kind) });
        const fa = seg(s.p, 0.75, 1);
        if (fa <= 0) return;
        ctx.save(); ctx.globalAlpha *= fa;
        d.paperShape(ctx, kind, w, h, color, node.seed % 1000, { ...el, lift: s.lift });
        ctx.restore();
      } else d.paperShape(ctx, kind, w, h, color, node.seed % 1000, { shadow: el.shadow, rim: el.rim, lift: s.lift, spikes: el.spikes, inner: el.inner, amp: el.amp });
      if (el.outline) {
        const base = d.shapePts(kind === 'circle' ? 'ellipse' : kind, w, h, node.seed % 1000, el);
        d.ink(ctx, base.concat([base[0]]), { ...ink, p: 1, sharp: ['rect', 'triangle', 'diamond', 'star'].includes(kind) });
      }
    }
  }
  function drawSvg(ctx, node, s, t) {
    const d = D(), el = node.el, polys = d.svgPolylines(el.d);
    if (!polys.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const [x, y] of p.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const k = el.size ? el.size / Math.max(1e-6, x1 - x0) : el.unit || 1, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const key = node.id + '|' + k;
    if (!node.svg || node.svg.key !== key) {
      const pl = polys.map((p) => p.pts.map(([x, y]) => [Math.round((x - cx) * k * 10) / 10, Math.round((y - cy) * k * 10) / 10]));
      node.svg = { key, pl, lens: pl.map((pts) => d.pathLength(pts, true)) };
    }
    const { pl, lens } = node.svg, total = lens.reduce((a, b) => a + b, 0);
    if (el.fill && s.p > 0.8) {
      ctx.save(); ctx.globalAlpha *= seg(s.p, 0.8, 1); ctx.scale(k, k); ctx.translate(-cx, -cy);
      ctx.fillStyle = d.color(el.fill); ctx.fill(new Path2D(el.d)); ctx.restore();
    }
    let done = 0;
    pl.forEach((pts, i) => {
      const p = clamp((s.p * total - done) / Math.max(1e-6, lens[i])); done += lens[i];
      if (p > 0 && el.stroke !== 'none') d.ink(ctx, pts, { w: el.stroke_w || 5, p, seed: (node.seed + i) % 1000, t, c: el.stroke || 'ink', sharp: true, wob: el.wob == null ? 0.8 : el.wob, dash: el.dash });
    });
  }
  function drawChart(ctx, node, s, t, ts) {
    const d = D(), el = node.el, data = el.data || [], n = data.length;
    if (!n) return;
    const w = el.w || 600, h = el.h || 360, max = el.max || Math.max(...data) || 1, lab = el.labels || [];
    const fs = el.label_size || 30, base = h / 2 - (lab.length ? fs * 1.5 : 0), top = -h / 2 + fs * 1.3, plotH = base - top;
    const colors = (el.colors || [el.color || 'accent']).map((c) => d.color(c));
    d.ink(ctx, [[-w / 2 - 10, base], [w / 2 + 10, base]], { w: 4, seed: node.seed % 1000, t, c: el.axis || 'ink', p: clamp(s.p * 3), sharp: true });
    if ((el.chart || 'bar') === 'line') {
      const pts = data.map((v, i) => [-w / 2 + (w * (i + 0.5)) / n, base - (v / max) * plotH]);
      d.ink(ctx, pts, { w: el.stroke_w || 6, p: s.p, seed: node.seed % 1000 + 3, t, c: colors[0], sharp: true, wob: 0.6 });
      pts.forEach(([x, y], i) => {
        if (s.p <= 0 || s.p * (n - 1) < i - 0.01) return;
        ctx.fillStyle = colors[0]; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
        if (lab[i] != null) d.text(ctx, String(lab[i]), x, base + fs * 1.2, { size: fs, font: 'print', weight: 400, c: 'pencil', t, seed: i + 3, id: node.id + ':label' });
        if (el.values) d.text(ctx, String(data[i]), x, y - 22, { size: fs, font: 'hand', c: 'ink', t, seed: i + 5, id: node.id + ':value' });
      });
      return;
    }
    const slot = w / n, bw = slot * (el.bar_w || 0.62);
    for (let i = 0; i < n; i++) {
      const g = E.out(clamp(s.p * n - i)), bh = (data[i] / max) * plotH, x = -w / 2 + slot * (i + 0.5);
      if (g > 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(x - bw, base - bh * g - 20, bw * 2, bh * g + 20); ctx.clip();
        ctx.translate(x, base - bh / 2);
        d.paperShape(ctx, 'rect', Math.round(bw), Math.max(8, Math.round(bh)), colors[i % colors.length], (node.seed + i) % 1000, { shadow: 0.7, amp: 3 });
        ctx.restore();
        if (el.values && g >= 1) d.text(ctx, String(data[i]), x, base - bh - 16, { size: fs, font: 'hand', c: 'ink', t, seed: i + 5, id: node.id + ':value' });
      }
      if (lab[i] != null && s.p > 0) d.text(ctx, String(lab[i]), x, base + fs * 1.2, { size: fs, font: 'print', weight: 400, c: 'pencil', t, seed: i + 3, p: clamp(s.p * n - i + 0.5), id: node.id + ':label' });
    }
  }
  function drawSprite(ctx, node, s, name, w) {
    const d = D();
    if (d.stickers[name]) { d.sticker(ctx, name, 0, 0, { w, lift: s.lift, shadow: node.el.shadow }); return; }
    // visible placeholder so a missing sticker is caught in stills, never silently dropped
    if (!node.warned) { console.warn(`missing sticker "${name}" (element "${node.id}")`); node.warned = true; }
    d.paperShape(ctx, 'rect', Math.round(w), Math.round(w * 0.7), 'paper', node.seed % 1000, { shadow: 0.6 });
    d.ink(ctx, d.circlePts(0, 0, Math.round(w * 0.4), Math.round(w * 0.27), 3, 1.02), { w: 3, c: 'coral', dash: [10, 8] });
    d.text(ctx, name, 0, 10, { size: Math.max(20, Math.round(w * 0.1)), font: 'print', weight: 400, c: 'coral', id: node.id + ':missing' });
  }
  SB.cueFor = function (node, name) {
    if (node && node.el.cues && node.el.cues[name] != null) return node.el.cues[name];
    if (S.sb.cues && S.sb.cues[name] != null) return S.sb.cues[name];
    return SB.resolveCue(name, S.env);
  };
  // The api object a custom shot receives: (ctx, t, api).
  function shotApi(node, s, t, box, scene) {
    const d = D();
    return {
      D: d, ACT: FILM.ACT, E, U: FILM, t, ts: FILM.step(t), step: FILM.step,
      id: node.id, seed: node.seed, el: node.el, params: node.el.params || {}, state: s, box: { w: box[0], h: box[1] },
      scene: { id: scene.id, at: scene.at, until: scene.until },
      cue: (name) => SB.cueFor(node, name), color: d.color, palette: d.PAL,
      text: (c, str, x, y, o = {}) => d.text(c, str, x, y, Object.assign({ seed: node.seed % 1000, t, id: node.id }, o)),
    };
  }
  function drawCustom(ctx, node, s, t) {
    const fn = FILM.shots[node.el.shot];
    if (!fn) throw new Error(`custom element "${node.id}": shot "${node.el.shot}" is not registered (missing web/film/shots/${node.el.shot}.js?)`);
    fn(ctx, t, shotApi(node, s, t, [node.el.w || 400, node.el.h || 400], node.scene));
  }
  const KIND = {
    text: drawText, equation: drawText, shape: drawShape, 'svg-path': drawSvg, chart: drawChart, custom: drawCustom,
    sprite: (ctx, node, s) => drawSprite(ctx, node, s, node.el.src, node.el.w || 240),
    clip: (ctx, node, s) => drawSprite(ctx, node, s, node.el.poster || node.el.src, node.el.w || 480),
    group: (ctx, node, s, t, ts) => node.children.forEach((c) => drawNode(ctx, c, t, ts)),
  };
  function drawNode(ctx, node, t, ts) {
    const el = node.el, s = nodeState(node, ts);
    if (s.alpha <= 0.002 || s.scale * s.pop <= 0.001) return;
    const draw = KIND[el.kind];
    if (!draw) { if (!node.warned) { console.warn(`unknown element kind "${el.kind}"`); node.warned = true; } return; }
    const [bx, by, br] = FILM.ACT.boil(node.id, t, el.boil == null ? (el.kind === 'text' || el.kind === 'custom' ? 0 : 1) : el.boil);
    const idle = el.idle ? FILM.ACT.idle(t, node.id, el.idle === true ? {} : el.idle) : { dx: 0, dy: 0, r: 0, sx: 1, sy: 1 };
    ctx.save();
    ctx.translate(s.x + s.dx + bx + idle.dx, s.y + s.dy + by + idle.dy);
    ctx.rotate(deg(s.r + br + idle.r));
    const sc = s.scale * s.pop;
    ctx.scale(sc * s.sx * idle.sx * (el.flip ? -1 : 1), sc * s.sy * idle.sy);
    ctx.globalAlpha *= clamp(s.alpha);
    const prev = D().currentId; D().currentId = node.id;
    draw(ctx, node, s, t, ts);
    D().currentId = prev;
    ctx.restore();
  }
  function drawSceneContent(ctx, sc, t, ts) {
    for (const n of sc._nodes) drawNode(ctx, n, t, ts);
    const cid = sc.custom && (typeof sc.custom === 'string' ? sc.custom : sc.custom.canvas);
    if (cid) {
      const fn = FILM.shots[cid];
      if (!fn) throw new Error(`scene "${sc.id}": shot "${cid}" is not registered (missing web/film/shots/${cid}.js?)`);
      const node = { id: sc.id, seed: FILM.ACT.seed(sc.id, S.sb.meta.seed), el: { params: sc.params || {}, cues: sc.cues } };
      const prev = D().currentId; D().currentId = sc.id;
      fn(ctx, t, shotApi(node, { alpha: 1, p: 1 }, t, S.g.box(sc), sc));
      D().currentId = prev;
    }
  }

  // ---- board dressing
  function drawBoard(ctx, t, v) {
    const d = D(), g = S.g, L = S.sb.layout;
    ctx.fillStyle = d.color(L.color || 'board'); ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    for (const s of S.stains) {
      if (s.x + s.rad < v.x0 || s.x - s.rad > v.x1 || s.y + s.rad < v.y0 || s.y - s.rad > v.y1) continue;
      const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.rad);
      gr.addColorStop(0, d.alpha('stain', s.a)); gr.addColorStop(1, d.alpha('stain', 0));
      ctx.fillStyle = gr; ctx.fillRect(s.x - s.rad, s.y - s.rad, s.rad * 2, s.rad * 2);
    }
    d.grainFill(ctx, v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0, 1);
    if (L.doodles) {
      const [c, r] = L.grid, rx = c > 1 ? g.cellW : g.gx * 0.3, ry = r > 1 ? g.cellH : g.gy * 0.3;
      ctx.save(); ctx.globalAlpha *= 0.9;
      d.ink(ctx, d.circlePts(rx, ry, 105, 100, 901, 1.02), { w: 11, seed: 901, c: d.alpha('stain', 0.3), boil: 0 });
      d.ink(ctx, d.circlePts(rx, ry, 96, 92, 902, 0.8), { w: 4, seed: 902, c: d.alpha('stain', 0.22), boil: 0 });
      ctx.restore();
      for (let k = 0; k < 5; k++) {
        const x = (Math.floor(FILM.rnd('dx', k) * (c + 1))) * g.cellW, y = g.cellH * (Math.floor(FILM.rnd('dy', k) * r) + 0.5) + FILM.srnd('dj', k) * g.ph * 0.3;
        d.sparkle(ctx, Math.max(g.gx * 0.25, Math.min(g.W - g.gx * 0.25, x)), y, 34, k, d.alpha('pencil', 0.4));
      }
    }
    if (L.caption) {
      const cap = typeof L.caption === 'string' ? { text: L.caption } : L.caption;
      d.text(ctx, cap.text, g.gx / 2 + 20, g.gy / 2 * 0.72, { size: cap.size || 64, align: 'left', font: cap.font || 'print', weight: 400, c: cap.color || 'pencil', t, seed: 77, id: 'board-caption' });
    }
    if (L.arrows && L.finale && S.panels.length > 1) {
      const z0 = L.finale.at;
      for (let i = 1; i < S.panels.length; i++) {
        const p = seg(FILM.step(t), z0 + 0.5 + (i - 1) * 0.11, z0 + 0.85 + (i - 1) * 0.11);
        if (p <= 0) continue;
        const a = g.center(S.panels[i - 1]), b = g.center(S.panels[i]), dx = b[0] - a[0], dy = b[1] - a[1];
        let pa, pb;
        if (Math.abs(dx) >= Math.abs(dy)) { const sx = Math.sign(dx); pa = [a[0] + sx * (g.pw / 2 + 50), a[1] + 15]; pb = [b[0] - sx * (g.pw / 2 + 120), b[1] - 5]; }
        else { const sy = Math.sign(dy); pa = [a[0] + 10, a[1] + sy * (g.ph / 2 + 50)]; pb = [b[0] - 10, b[1] - sy * (g.ph / 2 + 115)]; }
        d.arrow(ctx, d.arcPts(Math.round(pa[0]), Math.round(pa[1]), Math.round(pb[0]), Math.round(pb[1]), 0.18), { w: 7, p, seed: i, t, dash: [26, 16], head: 34, c: d.alpha('ink', 0.8) });
      }
    }
  }
  function drawPanel(ctx, sc, t, ts) {
    const d = D(), g = S.g, P = sc.panel, [cx, cy] = g.center(sc);
    ctx.save(); ctx.translate(cx, cy);
    if (P.enter === 'drop') { const at = P.enter_at == null ? sc.at : P.enter_at, u = seg(ts, at, at + 0.55); ctx.translate(0, -g.RH * 1.25 * (1 - E.back(u, 1.1))); }
    const color = P.color || d.PANELS[P.index % d.PANELS.length];
    const poly = d.panel(ctx, { x: 0, y: 0, w: g.pw, h: g.ph, color, seed: P.seed, r: P.r });
    ctx.rotate(deg(P.r || 0));
    if (!S.light) {
      const c = d.mk(445, 250), lg = c.getContext('2d'), gr = lg.createLinearGradient(0, 0, 445, 250);
      gr.addColorStop(0, 'rgba(255,250,235,0.16)'); gr.addColorStop(0.45, 'rgba(255,250,235,0)'); gr.addColorStop(1, d.sh(0.1));
      lg.fillStyle = gr; lg.fillRect(0, 0, 445, 250); S.light = c;
    }
    ctx.save(); d.path(ctx, poly); ctx.clip(); ctx.drawImage(S.light, -g.pw / 2, -g.ph / 2, g.pw, g.ph); ctx.restore();
    drawSceneContent(ctx, sc, t, ts);
    const tw = Math.round(g.pw * 0.112);
    d.tape(ctx, g.pw * 0.475, -g.ph * 0.478, tw, 36, P.seed); d.tape(ctx, -g.pw * 0.475, g.ph * 0.478, tw, 36, P.seed + 1);
    ctx.restore();
  }
  function stageBackground(ctx, sc, v) {
    const d = D();
    ctx.fillStyle = d.color(sc.bg || S.sb.layout.color || 'board'); ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
    if (sc.texture !== false) d.grainFill(ctx, v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0, 1);
  }
  function drawStageScene(ctx, sc, t, ts, v) {
    stageBackground(ctx, sc, v);
    ctx.save(); ctx.translate(S.g.RW / 2, S.g.RH / 2);
    drawSceneContent(ctx, sc, t, ts);
    ctx.restore();
  }

  // drawWorld(ctx, t, v): everything under the camera. v = visible world rect {x0, y0, x1, y1}.
  SB.drawWorld = function (ctx, t, v) {
    const ts = FILM.step(t), g = S.g;
    if (g.board) {
      drawBoard(ctx, t, v);
      for (const sc of S.panels) {
        const [cx, cy] = g.center(sc), rx = g.pw * 0.62, ry = g.ph * 0.62;
        if (cx + rx < v.x0 || cx - rx > v.x1 || cy + ry < v.y0 || cy - ry > v.y1) continue;
        drawPanel(ctx, sc, t, ts);
      }
      return;
    }
    const ps = S.panels;
    let i = -1;
    for (let k = 0; k < ps.length; k++) if (t >= ps[k].at) i = k;
    if (i < 0) { if (ps.length) drawStageScene(ctx, ps[0], t, ts, v); return; }
    const sc = ps[i], tr = sc.transition ? (typeof sc.transition === 'string' ? { type: sc.transition } : sc.transition) : { type: 'cut' };
    const u = tr.type === 'cut' || i === 0 ? 1 : E.inOut(seg(t, sc.at, sc.at + (tr.dur || 0.5)));
    if (u < 1) drawStageScene(ctx, ps[i - 1], t, ts, v);
    ctx.save();
    if (tr.type === 'fade') ctx.globalAlpha *= u;
    else if (tr.type === 'slide') ctx.translate((1 - u) * g.RW * (tr.dir === 'left' ? -1 : 1), 0);
    drawStageScene(ctx, sc, t, ts, v);
    ctx.restore();
  };
  // drawOverlay(ctx, t): screen-space scenes (title cards, lower thirds) above the camera.
  SB.drawOverlay = function (ctx, t) {
    const ts = FILM.step(t), g = S.g;
    for (const sc of S.overlays) {
      if (t < sc.at || (t >= sc.until && !sc.hold)) continue;
      ctx.save();
      if (sc.dim) { ctx.fillStyle = FILM.D.sh(sc.dim * seg(t, sc.at, sc.at + 0.5)); ctx.fillRect(0, 0, g.RW, g.RH); }
      ctx.translate(g.RW / 2, g.RH / 2);
      drawSceneContent(ctx, sc, t, ts);
      ctx.restore();
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
