// Renderer and player. FILM.R.draw(ctx, t, k) paints one frame as a pure function of t
// (k = canvas px per reference px). Loads web/film/config.json and web/film/storyboard.json,
// webfonts declared in config.fonts.faces, stickers from img/manifest.json and the shot files
// the storyboard lists. With ?render in the URL it exposes window.__film for tools/render.mjs;
// otherwise it runs the live player (poster, play/pause, captions, full screen, scrubber).
(function () {
  const FILM = window.FILM;
  const { D, SB, A, E, clamp, seg, deg } = FILM;
  const R = (FILM.R = {});
  const RENDER = /[?&]render\b/.test(location.search);

  async function getJSON(url, optional) {
    const r = await fetch(url);
    if (!r.ok) { if (optional) return null; throw new Error(`${url}: HTTP ${r.status}`); }
    return r.json();
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = () => res(); s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }

  // ---------- loading ----------
  R.load = async function () {
    const cfg = (FILM.cfg = (await getJSON('film/config.json', true)) || {});
    const sb = (FILM.sb = await getJSON('film/storyboard.json'));
    if (!sb.meta) sb.meta = {};
    // storyboard meta wins; config supplies defaults
    for (const k of ['size', 'fps', 'duration']) if (sb.meta[k] == null && cfg[k] != null) sb.meta[k] = cfg[k];
    if (sb.meta.duration == null) sb.meta.duration = 5;
    D.configure(cfg);
    const faces = (cfg.fonts && cfg.fonts.faces) || [];
    await Promise.all(faces.map(async (f) => {
      try {
        const face = new FontFace(f.family, `url(${f.src})`, { weight: String(f.weight || '400'), style: f.style || 'normal', display: 'block' });
        document.fonts.add(await face.load());
      } catch (e) { console.warn(`font ${f.family} (${f.src}) failed to load: ${e.message}`); }
    }));
    if (document.fonts) {
      const stacks = [D.HAND, D.PRINT].concat(D.RANSOM_FONTS);
      await Promise.all(stacks.flatMap((s) => ['400', '700'].map((w) => document.fonts.load(`${w} 48px ${s}`, 'finds').catch(() => null))));
    }
    const man = await getJSON('img/manifest.json', true);
    if (man) {
      await Promise.all(Object.entries(man).map(async ([n, v]) => {
        const im = new Image(); im.src = 'img/' + ((v && v.file) || n + '.webp');
        try { await im.decode(); D.addSticker(n, im); } catch (e) { console.warn(`sticker ${n} failed to load`); }
      }));
    }
    for (const src of sb.shots || []) await loadScript(src);
    const st = SB.prepare(sb);
    A.setup(sb);
    const [RW, RH] = [st.g.RW, st.g.RH];
    Object.assign(R, { sb, cfg, RW, RH, W: sb.meta.size[0], H: sb.meta.size[1], dur: sb.meta.duration, fps: sb.meta.fps || 30 });
    R.fades = FILM.fades(R.dur);
    R.endCard = endCardPlan(cfg);
    R.posterT = cfg.poster_t != null ? cfg.poster_t : Math.max(0, R.endCard ? R.endCard.at - 0.5 : R.dur - 1.2);
    R.grain = D.makeGrain();
    R.film = D.makeFilmGrain();
    R.vignette = (() => {
      const c = D.mk(RW, RH), g = c.getContext('2d'), m = Math.min(RW, RH), big = Math.max(RW, RH);
      const gr = g.createRadialGradient(RW / 2, RH / 2, m * 0.35, RW / 2, RH / 2, big * 0.6);
      gr.addColorStop(0, D.sh(0)); gr.addColorStop(1, D.sh(cfg.vignette == null ? 0.34 : cfg.vignette));
      g.fillStyle = gr; g.fillRect(0, 0, RW, RH); return c;
    })();
    R.loaded = true;
    return R;
  };

  // ---------- disclosure end card ----------
  // config.disclosure = {end_card, seconds (2.5), title ("Made with AI"), lines (default: the
  // credits), note}. The card sits inside the film's duration: it fades in over the last
  // `seconds` (at most 40% of the film) and the normal fade-out closes it.
  const creditText = (c) => (typeof c === 'string' ? c : `${c.role}: ${c.name}`);
  function endCardPlan(cfg) {
    const dc = cfg.disclosure || {};
    if (dc.end_card !== true) return null;
    const secs = clamp(dc.seconds || 2.5, Math.min(1.6, R.dur * 0.4), R.dur * 0.4);
    let lines = (dc.lines || (cfg.credits || []).map(creditText)).map(String);
    if (!dc.lines && lines.length > 5) lines = lines.slice(0, 4).concat([`and ${lines.length - 4} more: see the credits`]);
    return { at: R.dur - secs, title: dc.title || 'Made with AI', lines };
  }
  function drawEndCard(ctx, t) {
    const ec = R.endCard;
    if (!ec || t < ec.at) return;
    const u = E.sine(seg(t, ec.at, ec.at + 0.4)), TS = 72, LS = 38, LH = 1.3, maxW = R.RW * 0.84 - 100;
    // balanced wrap: the narrowest width that still needs no more lines than the greedy wrap
    const wrapN = (l, w) => D.wrap(ctx, l, w, LS, 'print', 400).split('\n');
    const balanced = (l) => {
      const n = wrapN(l, maxW).length;
      let lo = maxW / n, hi = maxW;
      for (let i = 0; n > 1 && i < 8; i++) { const mid = Math.round((lo + hi) / 2); if (wrapN(l, mid).length > n) lo = mid; else hi = mid; }
      return wrapN(l, hi);
    };
    const lines = ec.lines.flatMap(balanced);
    const w = Math.min(R.RW * 0.9, Math.max(D.textWidth(ctx, ec.title, TS, 'hand', 700), ...lines.map((l) => D.textWidth(ctx, l, LS, 'print', 400))) + 120);
    const h = TS * 1.3 + lines.length * LS * LH + (lines.length ? 40 : 0) + 80;
    ctx.save();
    ctx.fillStyle = D.sh(0.45 * u); ctx.fillRect(0, 0, R.RW, R.RH);
    ctx.globalAlpha = u;
    ctx.translate(R.RW / 2, R.RH / 2 + (1 - u) * 24);
    D.card(ctx, w, h, { seed: 41 });
    let y = -h / 2 + 40 + TS * 0.9;
    D.text(ctx, ec.title, 0, y, { size: TS, font: 'hand', weight: 700, c: 'ink', t, seed: 41, id: 'end-card' });
    y += TS * 0.45 + 40 + LS * 0.8;
    lines.forEach((l, i) => D.text(ctx, l, 0, y + i * LS * LH, { size: LS, font: 'print', weight: 400, c: 'ink', t, seed: 43 + i, id: `end-card:${i}` }));
    ctx.restore();
  }

  // ---------- one frame ----------
  function blurScratch(cv) {
    if (!R.scratch || R.scratch.width !== cv.width || R.scratch.height !== cv.height) R.scratch = D.mk(cv.width, cv.height);
    const sg = R.scratch.getContext('2d'); sg.setTransform(1, 0, 0, 1, 0, 0); sg.clearRect(0, 0, cv.width, cv.height); sg.drawImage(cv, 0, 0);
    return R.scratch;
  }
  R.draw = function (ctx, t, k = 1) {
    const { RW, RH } = R, cv = ctx.canvas, L = R.sb.layout;
    if (ctx.__grainSrc !== R.grain) { ctx.__pat = ctx.createPattern(R.grain, 'repeat'); ctx.__film = ctx.createPattern(R.film, 'repeat'); ctx.__grainSrc = R.grain; }
    D.grainPattern = ctx.__pat;
    D.logScale = 1080 / Math.min(cv.width, cv.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = D.color('board'); ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);

    // camera plus a slow hand-held drift
    const cam = SB.cam(t), hh = L.handheld == null ? 1 : L.handheld;
    const hx = (Math.sin(t * 0.63) * 4 + Math.sin(t * 1.37) * 2.5) * hh, hy = (Math.cos(t * 0.51) * 3.5 + Math.sin(t * 1.11) * 2) * hh;
    const z = cam.z, rot = deg(cam.r + Math.sin(t * 0.4) * 0.12 * hh);
    ctx.save();
    ctx.translate(RW / 2, RH / 2); ctx.scale(z, z); ctx.rotate(rot); ctx.translate(-(cam.x + hx / z), -(cam.y + hy / z));
    const hw = (RW / 2 / z) * 1.12 + 60, hhh = (RH / 2 / z) * 1.25 + 60;
    SB.drawWorld(ctx, t, { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hhh, y1: cam.y + hhh });
    ctx.restore();

    // camera motion blur: a quarter-frame shutter, only while panning; zoom blur separately
    const sh = 0.125 / R.fps, c0 = SB.cam(t - sh), c1 = SB.cam(t + sh);
    const dx = -(c1.x - c0.x) * z, dy = -(c1.y - c0.y) * z, zoomRate = Math.abs(Math.log(c1.z / c0.z));
    const mag = Math.hypot(dx, dy) * Math.max(0, 1 - zoomRate * 250);
    if (mag > 2.5) {
      const src = blurScratch(cv), n = Math.min(28, Math.max(3, Math.ceil(mag / 1.4)));
      const bx = dx * (mag / Math.hypot(dx, dy)), by = dy * (mag / Math.hypot(dx, dy));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = 0; i < n; i++) { const f = i / (n - 1) - 0.5; ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(src, f * bx * k, f * by * k); }
      ctx.globalAlpha = 1; ctx.setTransform(k, 0, 0, k, 0, 0);
    } else if (zoomRate > 0.0015) {
      const src = blurScratch(cv), Lz = 0.6 * Math.log(c1.z / c0.z), n = Math.min(12, Math.max(3, Math.ceil((zoomRate * 660) / 1.2)));
      for (let i = 0; i < n; i++) {
        const s = Math.exp((i / (n - 1) - 0.5) * Lz);
        ctx.setTransform(s, 0, 0, s, (cv.width / 2) * (1 - s), (cv.height / 2) * (1 - s));
        ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(src, 0, 0);
      }
      ctx.globalAlpha = 1; ctx.setTransform(k, 0, 0, k, 0, 0);
    }

    SB.drawOverlay(ctx, t);
    drawEndCard(ctx, t);
    // vignette and a whisper of STATIC grain (flickering full-frame grain multiplies file size)
    ctx.drawImage(R.vignette, 0, 0, RW, RH);
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.035;
    ctx.fillStyle = ctx.__film; ctx.fillRect(0, 0, RW, RH); ctx.restore();
    // fade in from paper, fade out to the page ground (lengths from FILM.fades(duration))
    const fin = 1 - seg(t, 0, R.fades.in);
    if (fin > 0) { ctx.fillStyle = D.alpha('board', fin); ctx.fillRect(0, 0, RW, RH); }
    const fout = E.sine(seg(t, R.dur - R.fades.out, R.dur - 0.03));
    if (fout > 0) { ctx.fillStyle = D.alpha('ground', fout); ctx.fillRect(0, 0, RW, RH); }
  };

  // ---------- offline render hooks (tools/render.mjs) ----------
  if (RENDER) {
    const cv = document.getElementById('film');
    const hooks = (window.__film = { ready: null });
    let ctx = null;
    const frame = (t) => { R.draw(ctx, t, R.W / R.RW); return cv; };
    hooks.ready = R.load().then(() => {
      cv.width = R.W; cv.height = R.H;
      ctx = cv.getContext('2d', { alpha: false });
      Object.assign(hooks, {
        dur: R.dur, fps: R.fps, size: [R.W, R.H], posterT: R.posterT,
        frame: (t, q) => frame(t).toDataURL('image/jpeg', q || 0.95),
        png: (t) => frame(t).toDataURL('image/png'),
        text(t) { D.textLog = []; try { frame(t); return D.textLog; } finally { D.textLog = null; } },
        glyphTest: () => D.glyphTest(ctx),
        moves: () => SB.state().moves,
        async audio() {
          const wav = await A.renderOffline(await A.fetchAll(''));
          let s = ''; const CH = 0x8000;
          for (let i = 0; i < wav.length; i += CH) s += String.fromCharCode.apply(null, wav.subarray(i, i + CH));
          return btoa(s);
        },
      });
      return true;
    });
    return;
  }

  // ---------- live player ----------
  const $ = (id) => document.getElementById(id);
  const cv = $('film'), stage = $('stage'), ctx = cv.getContext('2d', { alpha: false });
  const playBtn = $('play'), restartBtn = $('restart'), ccBtn = $('cc'), fsBtn = $('fs'), scrub = $('scrub'), timeEl = $('time');
  const cc = $('captions'), poster = $('poster'), posterLabel = $('poster-label');
  let ac = null, bufs = null, raw = null, mix = null, t0 = 0, playing = false, pausedAt = 0, needsStart = true, ended = false, ccOn = false;

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const spoken = (s) => (s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 6) / 10} minutes`);
  function applyChrome(cfg) {
    const pal = D.PAL, root = document.documentElement.style;
    for (const [k, v] of Object.entries({ ground: pal.ground, 'ground-2': pal.ground2, line: pal.line, text: pal.text, muted: pal.muted, accent: pal.accent, 'accent-ink': pal.accent_ink, paper: pal.board })) root.setProperty('--' + k, v);
    root.setProperty('--display', D.HAND); root.setProperty('--ui', D.UI);
    root.setProperty('--ar', `${R.W} / ${R.H}`); root.setProperty('--arw', R.W); root.setProperty('--arh', R.H);
    const title = cfg.title || R.sb.meta.title || 'Untitled film';
    document.title = title; $('title').textContent = title;
    $('subtitle').textContent = cfg.subtitle || ''; $('subtitle').hidden = !cfg.subtitle;
    cv.setAttribute('aria-label', 'Animated film: ' + title);
    const hasSound = (R.sb.vo || []).some((v) => v.asset) || R.sb.music || (R.sb.sfx || []).length;
    $('hint').textContent = spoken(R.dur) + (hasSound ? ' \u00b7 turn your sound on' : '');
    const notes = $('notes'); notes.textContent = '';
    for (const n of cfg.notes || []) {
      const p = document.createElement('p'); p.className = 'note';
      const b = document.createElement('b'); b.textContent = n.title || ''; p.appendChild(b);
      p.appendChild(document.createTextNode(n.text || '')); notes.appendChild(p);
    }
    const credits = $('credits'), list = $('credit-list'), note = $('disclosure-note'); list.textContent = '';
    for (const c of cfg.credits || []) { const li = document.createElement('li'); li.textContent = creditText(c); list.appendChild(li); }
    // the AI-made note (also the transcript's closing note and the MP4 comment); "" turns it off
    const dnote = cfg.disclosure && cfg.disclosure.note, noteText = dnote == null ? 'Made with AI. The credits list the models and tools used.' : String(dnote);
    note.textContent = noteText; note.hidden = !noteText;
    credits.hidden = !((cfg.credits && cfg.credits.length) || noteText);
    scrub.max = String(Math.round(R.dur * 10));
    ccOn = cfg.captions === true;
    try { const s = localStorage.getItem('film-cc'); if (s != null) ccOn = s === '1'; } catch (_) { /* storage blocked */ }
  }
  function sizeCanvas() {
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(Math.min(R.W, Math.max(320, r.width * dpr)));
    if (cv.width !== w) { cv.width = w; cv.height = Math.round((w * R.H) / R.W); }
  }
  const now = () => (playing && ac ? Math.max(0, ac.currentTime - t0 - (ac.outputLatency || 0)) : pausedAt);

  async function startAt(from) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state !== 'running') await ac.resume();
    if (!bufs) { raw = raw || (await A.fetchAll('')); bufs = await A.decodeAll(ac, raw); }
    if (mix) mix.stop();
    const at = ac.currentTime + 0.06;
    mix = A.build(ac, ac.destination, bufs, at, from);
    t0 = at - from; playing = true; needsStart = false; ended = false;
    sync();
  }
  async function toggle() {
    if (!R.loaded) return;
    if (playing) { pausedAt = now(); playing = false; await ac.suspend(); }
    else if (needsStart || ended) await startAt(ended ? 0 : pausedAt);
    else { playing = true; await ac.resume(); }
    sync();
  }
  function seek(t) {
    pausedAt = clamp(t, 0, R.dur - 0.05);
    if (playing) startAt(pausedAt); else { if (mix) { mix.stop(); mix = null; } needsStart = true; ended = false; }
  }
  function sync() {
    playBtn.textContent = playing ? 'Pause' : ended ? 'Watch again' : 'Play';
    playBtn.setAttribute('aria-pressed', String(playing));
    poster.hidden = playing || (!ended && !needsStart) || (pausedAt > 0 && !ended);
    posterLabel.textContent = ended ? 'Watch again' : 'Play the film';
    ccBtn.setAttribute('aria-pressed', String(ccOn));
  }
  function loop() {
    let t = now();
    if (playing && t >= R.dur) { playing = false; ended = true; pausedAt = R.dur; t = R.dur; if (mix) mix.stop(); sync(); }
    if (R.loaded) {
      sizeCanvas();
      R.draw(ctx, needsStart && !ended && pausedAt === 0 ? R.posterT : Math.min(t, R.dur - 0.001), cv.width / R.RW);
      if (document.activeElement !== scrub) scrub.value = String(Math.round(Math.min(t, R.dur) * 10));
      timeEl.textContent = `${fmt(Math.min(t, R.dur))} / ${fmt(R.dur)}`;
      const line = ccOn && (playing || pausedAt > 0) ? (R.sb.vo || []).find((v) => t >= v.at - 0.1 && t <= v.at + v.dur + 0.4) : null;
      const txt = line ? line.text : '';
      if (cc.textContent !== txt) cc.textContent = txt;
      cc.hidden = !txt;
    }
    requestAnimationFrame(loop);
  }
  playBtn.addEventListener('click', toggle);
  poster.addEventListener('click', toggle);
  restartBtn.addEventListener('click', () => { seek(0); if (!playing) toggle(); });
  ccBtn.addEventListener('click', () => { ccOn = !ccOn; try { localStorage.setItem('film-cc', ccOn ? '1' : '0'); } catch (_) { /* storage blocked */ } sync(); });
  fsBtn.addEventListener('click', () => { (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen ? stage.requestFullscreen() : Promise.reject()).catch(() => {}); });
  scrub.addEventListener('input', () => seek(Number(scrub.value) / 10));
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'BUTTON'].includes(e.target.tagName) && e.key !== ' ') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'c') ccBtn.click();
    else if (e.key === 'f') fsBtn.click();
    else if (e.key === 'ArrowLeft') seek(now() - 5);
    else if (e.key === 'ArrowRight') seek(now() + 5);
    else if (e.key === 'Home' || e.key === '0') seek(0);
  });
  R.load().then(() => {
    applyChrome(R.cfg); sync();
    posterLabel.textContent = 'Play the film'; poster.disabled = false; playBtn.disabled = false;
    A.fetchAll('').then((r) => { raw = r; }).catch(() => {});
  }).catch((e) => { posterLabel.textContent = 'Could not load: ' + e.message; throw e; });
  requestAnimationFrame(loop);
})();
