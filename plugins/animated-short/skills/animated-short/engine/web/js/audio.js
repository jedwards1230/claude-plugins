// The mix: narration, a ducked music bed and synthesized foley. One builder serves both the
// live player (AudioContext) and the offline render (OfflineAudioContext), so they sound the
// same. Inputs come from the resolved storyboard: vo [{id, at, dur, asset, text, gain_db}],
// music {asset | synth, gain_db, duck_db, intro_db, outro_db, at, offset, end_at},
// sfx [{at, type, gain, pan, dur, pitch, note}], mix {master, vo_db, sfx_db, music_db}.
// Missing VO or music files are silence, never an error ("no voice" is a valid film).
(function () {
  const FILM = window.FILM;
  const A = (FILM.A = {});
  const db = (x) => Math.pow(10, (x || 0) / 20);
  const PENTA = [1046.5, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0, 2349.32, 2637.02];
  A.SFX_TYPES = ['pop', 'tap', 'thud', 'stamp', 'rustle', 'scribble', 'whoosh', 'swish', 'twinkle', 'sparkleburst', 'ding', 'chime', 'tick',
    'click', 'boing', 'boink', 'snooze', 'whistle', 'latch', 'beep', 'thunder', 'buzz', 'power-on', 'ring', 'rumble'];

  // setup(sb): remember the storyboard and work out which files to fetch.
  A.setup = function (sb) {
    A.sb = sb;
    A.dur = sb.meta.duration;
    A.vo = (sb.vo || []).filter((v) => v.dur > 0).slice().sort((a, b) => a.at - b.at);
    A.music = sb.music || null;
    A.mix = Object.assign({ master: 0.7, vo_db: 0, sfx_db: 0, music_db: 0 }, sb.mix || {});
    A.files = {};
    if (A.music && A.music.asset) A.files.music = A.music.asset;
    for (const v of A.vo) if (v.asset) A.files['vo:' + v.id] = v.asset;
  };
  A.fetchAll = async function (base = '') {
    const out = {};
    await Promise.all(Object.entries(A.files).map(async ([k, f]) => {
      try {
        const r = await fetch(base + f);
        if (!r.ok) { console.warn(`audio file ${f} not found (${r.status}); that track is silent`); return; }
        out[k] = await r.arrayBuffer();
      } catch (e) { console.warn(`audio file ${f} could not be fetched: ${e.message}`); }
    }));
    return out;
  };
  A.decodeAll = async function (ac, raw) {
    const out = {};
    await Promise.all(Object.entries(raw).map(async ([k, ab]) => {
      try { out[k] = await ac.decodeAudioData(ab.slice(0)); } catch (e) { console.warn(`audio ${k} could not be decoded; silent`); }
    }));
    return out;
  };

  // ---- ducking: the envelope is derived from the gaps between lines.
  // Lines closer than 0.8 s merge into one ducked region (short gaps stay ducked). Around a
  // region the bed ramps down over pre = clamp(0.3 * gap before, 0.12, 0.45) s and back up
  // over post = clamp(0.3 * gap after, 0.15, 0.6) s, so long gaps breathe and short ones don't pump.
  A.regions = function () {
    const out = [];
    for (const v of A.vo) {
      const s = v.at, e = v.at + v.dur, last = out[out.length - 1];
      if (last && s - last.e < 0.8) last.e = Math.max(last.e, e); else out.push({ s, e });
    }
    out.forEach((r, i) => {
      const gb = i ? r.s - out[i - 1].e : r.s + 2, ga = i < out.length - 1 ? out[i + 1].s - r.e : A.dur - r.e + 2;
      r.pre = FILM.clamp(0.3 * gb, 0.12, 0.45); r.post = FILM.clamp(0.3 * ga, 0.15, 0.6);
    });
    return out;
  };
  // Tail point: where the bed stops pulsing and resolves (end of the last line, or music.end_at).
  A.tailAt = function () {
    if (A.music && A.music.end_at != null) return A.music.end_at;
    if (A.vo.length) { const l = A.vo[A.vo.length - 1]; return Math.min(A.dur - 0.5, l.at + l.dur + 0.15); }
    return A.dur - Math.min(2.5, A.dur * 0.25);
  };
  // Music gain at time t (linear): louder before the first line and after the last, gap level
  // between lines, ducked under the voice, faded out at the end.
  A.musicGain = function (t) {
    const m = A.music || {}, gap = db(m.gain_db == null ? -12 : m.gain_db) * db(A.mix.music_db);
    const intro = gap * db(m.intro_db == null ? 5 : m.intro_db), outro = gap * db(m.outro_db == null ? 6 : m.outro_db);
    const duck = gap * db(m.duck_db == null ? -8 : m.duck_db);
    const R = m.duck_under === 'none' ? [] : A.regionsCache || (A.regionsCache = A.regions());
    let g;
    if (!R.length) g = gap;
    else {
      const base = t < R[0].s ? intro : t > R[R.length - 1].e ? outro : gap;
      let env = 0;
      for (const r of R) {
        let k = 0;
        if (t >= r.s - r.pre && t < r.s) k = FILM.E.sine((t - (r.s - r.pre)) / r.pre);
        else if (t >= r.s && t <= r.e) k = 1;
        else if (t > r.e && t < r.e + r.post) k = 1 - FILM.E.sine((t - r.e) / r.post);
        env = Math.max(env, k);
      }
      g = base + (duck - base) * env;
    }
    const fo = Math.max(1.0, FILM.fades(A.dur).out), f0 = A.dur - fo;
    return t > f0 ? g * Math.max(0, 1 - (t - f0) / fo) : g;
  };

  function noiseBuffer(ac, seconds, kind, seed) {
    const n = Math.floor(ac.sampleRate * seconds), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    const r = FILM.rng(seed);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return b;
  }
  function impulse(ac) {
    const len = Math.floor(ac.sampleRate * 1.3), b = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch), r = FILM.rng('ir' + ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const tt = i / ac.sampleRate; lp = lp * 0.72 + (r() * 2 - 1) * 0.28;
        d[i] = lp * Math.exp(-tt * 4.2) * (i < 40 ? i / 40 : 1);
      }
    }
    return b;
  }

  // ---- synthesized bed for $0 drafts: soft pad chords, a plucked pulse and a light kick.
  // synth: {bpm (92), key ('C'), mode ('major'|'minor'), progression (scale degrees, 0-based,
  // default [0,5,3,4]), pad (1), pulse (1), kick (0.5)}. Beat k lands at music.at + k * 60 / bpm,
  // which is the grid tools/resolve.mjs uses for beat:/bar: cues when there is no beats.json.
  const KEYS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
  function synthBed(ac, out, cfg, when, offset, t0, tail, end) {
    const bpm = cfg.bpm || 92, beat = 60 / bpm, bar = beat * 4;
    const scale = cfg.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const root = 48 + (KEYS[cfg.key] == null ? 0 : KEYS[cfg.key]), prog = cfg.progression || [0, 5, 3, 4];
    const deg = (d) => root + scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    const triad = (d) => [deg(d), deg(d + 2), deg(d + 4)];
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.5; lp.connect(out);
    // LVL puts the bed near a mastered track (about -12 dBFS RMS before the bus), so the same
    // gain_db defaults suit a synth bed and a music file
    const LVL = 3.5;
    const padG = LVL * (cfg.pad == null ? 1 : cfg.pad), pulseG = LVL * (cfg.pulse == null ? 1 : cfg.pulse), kickG = LVL * (cfg.kick == null ? 0.5 : cfg.kick);
    const chord = (notes, s, e, lvl) => {
      if (e < offset || s >= end) return;
      for (const n of notes) for (const [type, det] of [['triangle', -6], ['sine', 7]]) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type; o.frequency.value = hz(n); o.detune.value = det; o.connect(g); g.connect(lp);
        const a = when(s), z = when(Math.min(e, end));
        g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(lvl, a + 0.45);
        g.gain.setValueAtTime(lvl, Math.max(a + 0.46, z - 0.6)); g.gain.linearRampToValueAtTime(0.0001, z);
        o.start(a); o.stop(z + 0.05);
      }
    };
    const pluck = (f, s, lvl) => {
      if (s < offset - 0.01 || s >= tail) return;
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(out);
      const a = when(s); g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(lvl, a + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, a + 0.38);
      o.start(a); o.stop(a + 0.42);
    };
    const kick = (s, lvl) => {
      if (s < offset - 0.01 || s >= tail) return;
      const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 90; o.connect(g); g.connect(out);
      const a = when(s); o.frequency.setValueAtTime(95, a); o.frequency.exponentialRampToValueAtTime(42, a + 0.16);
      g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(lvl, a + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, a + 0.3);
      o.start(a); o.stop(a + 0.32);
    };
    const pattern = [0, 1, 2, 1];
    for (let b = 0; t0 + b * bar < tail; b++) {
      const s = t0 + b * bar, d = prog[b % prog.length], tri = triad(d);
      chord([deg(d) - 12].concat(tri.map((n) => n + 12)), s, Math.min(tail, s + bar + 0.6), 0.03 * padG);
      for (let k = 0; k < 4; k++) {
        pluck(hz(tri[pattern[k]] + 24), s + k * beat, (k ? 0.035 : 0.05) * pulseG);
        if (k % 2 === 0) kick(s + k * beat, 0.22 * kickG);
      }
    }
    // resolve on the tonic right after the last line and hold it to the end
    chord([deg(0) - 12].concat(triad(0).map((n) => n + 12), [deg(7) + 12]), tail, end + 0.5, 0.036 * padG);
    pluck(hz(deg(0) + 24), tail, 0.06 * pulseG); pluck(hz(deg(4) + 24), tail + beat / 2, 0.045 * pulseG);
  }

  // build(ac, dest, buffers, startAt, offset): schedule the whole mix on ac, starting film time
  // `offset` at context time `startAt`. Returns {stop()}.
  A.build = function (ac, dest, buffers, startAt, offset = 0) {
    const nodes = [], D = A.dur, when = (t) => startAt + (t - offset);
    A.regionsCache = null;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -2.5; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    const M = A.mix.master, master = ac.createGain(); master.gain.value = M;
    master.connect(limiter); limiter.connect(dest);
    const fo = FILM.fades(D).out;
    master.gain.setValueAtTime(M, Math.max(startAt, when(D - fo)));
    master.gain.linearRampToValueAtTime(0.0001, Math.max(startAt + 0.01, when(D)));

    const verb = ac.createConvolver(); verb.buffer = impulse(ac); verb.connect(master);
    const voBus = ac.createGain(); voBus.gain.value = db(A.mix.vo_db); voBus.connect(master);
    const voSend = ac.createGain(); voSend.gain.value = 0.07; voBus.connect(voSend); voSend.connect(verb);
    const sfxBus = ac.createGain(); sfxBus.gain.value = 0.9 * db(A.mix.sfx_db); sfxBus.connect(master);
    const sfxSend = ac.createGain(); sfxSend.gain.value = 0.16; sfxBus.connect(sfxSend); sfxSend.connect(verb);

    if (A.music && (buffers.music || A.music.synth)) {
      // music bus: gain curve (duck envelope) plus a gentle pocket around the voice band
      const mBus = ac.createGain();
      const pocket = ac.createBiquadFilter(); pocket.type = 'peaking'; pocket.frequency.value = 2600; pocket.Q.value = 0.7; pocket.gain.value = A.vo.length ? -5 : 0;
      mBus.connect(pocket); pocket.connect(master);
      const rate = 60, from = Math.max(0, offset), n = Math.max(2, Math.ceil((D + 0.5 - from) * rate));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = A.musicGain(from + i / rate);
      mBus.gain.setValueCurveAtTime(curve, startAt, n / rate);
      const at = A.music.at || 0;
      if (buffers.music) {
        const ms = ac.createBufferSource(); ms.buffer = buffers.music; ms.connect(mBus);
        const off = (A.music.offset || 0) + Math.max(0, offset - at);
        if (off < ms.buffer.duration) { ms.start(Math.max(startAt, when(at)), off); nodes.push(ms); }
      } else synthBed(ac, mBus, A.music.synth, when, offset, at, A.tailAt(), D);
    }

    for (const v of A.vo) {
      const buf = buffers['vo:' + v.id];
      if (!buf || v.at + buf.duration < offset) continue;
      const g = ac.createGain(); g.gain.value = db(v.gain_db); g.connect(voBus);
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(g);
      if (v.at >= offset) src.start(when(v.at)); else src.start(startAt, offset - v.at);
      nodes.push(src);
    }

    const white = noiseBuffer(ac, 3, 'white', 'w1'), brown = noiseBuffer(ac, 3, 'brown', 'b1');
    const SFX = makeSfx(ac, white, brown);
    for (const ev of A.sb.sfx || []) {
      if (ev.at < offset - 0.05 || ev.at > D) continue;
      if (!SFX[ev.type]) { console.warn(`unknown sfx type "${ev.type}"`); continue; }
      const e = { t: ev.at, d: ev.dur, pitch: ev.pitch, note: ev.note };
      const out = ac.createStereoPanner(); out.pan.value = FILM.clamp(ev.pan || 0, -1, 1);
      const g = ac.createGain(); g.gain.value = ev.gain == null ? 1 : ev.gain; g.connect(out); out.connect(sfxBus);
      SFX[ev.type](g, Math.max(startAt, when(ev.at)), e);
    }
    return { stop() { nodes.forEach((s) => { try { s.stop(); } catch (_) { /* already stopped */ } }); try { limiter.disconnect(); } catch (_) { /* gone */ } } };
  };

  // ~25 synthesized foley sounds. Each is (outNode, contextTime, event{t, d, pitch, note}).
  function makeSfx(ac, white, brown) {
    const env = (param, t, peak, a, d, floor = 0.0001) => {
      param.setValueAtTime(floor, t); param.linearRampToValueAtTime(peak, t + a); param.exponentialRampToValueAtTime(floor, t + a + d);
    };
    const filt = (type, f, q = 0.7) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = () => ac.createGain();
    const osc = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; return o; };
    const noise = (buf, out, t, off, len) => { const s = ac.createBufferSource(); s.buffer = buf; s.connect(out); s.start(t, off, len); return s; };
    const bell = (out, t, f, lvl, dec = 1.1) => {
      [[1, 1], [2.76, 0.22], [5.4, 0.08]].forEach(([m, a]) => {
        const o = osc('sine', f * m), g = gain(); o.connect(g); g.connect(out);
        env(g.gain, t, lvl * a, 0.002, dec / m); o.start(t); o.stop(t + dec + 0.1);
      });
    };
    const R = (k, e) => FILM.rnd(k, e.t);
    const S = {
      pop(out, t, e) {
        const o = osc('sine', 480 + R('pp', e) * 160), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(o.frequency.value, t); o.frequency.exponentialRampToValueAtTime(170, t + 0.08);
        env(g.gain, t, 0.3, 0.004, 0.11); o.start(t); o.stop(t + 0.2);
        const bp = filt('bandpass', 2300, 0.9), ng = gain(); bp.connect(ng); ng.connect(out);
        env(ng.gain, t, 0.22, 0.002, 0.04); noise(white, bp, t, R('po', e) * 2, 0.08);
      },
      tap(out, t, e) {
        const bp = filt('bandpass', 1400 + (e.pitch || 0) * 90, 0.8), ng = gain(); bp.connect(ng); ng.connect(out);
        env(ng.gain, t, 0.5, 0.002, 0.05); noise(white, bp, t, R('tp', e) * 2, 0.08);
        const o = osc('sine', 150 + (e.pitch || 0) * 6), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(80, t + 0.07);
        env(g.gain, t, 0.35, 0.002, 0.08); o.start(t); o.stop(t + 0.14);
      },
      thud(out, t) {
        const o = osc('sine', 120), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.2);
        env(g.gain, t, 0.75, 0.004, 0.28); o.start(t); o.stop(t + 0.4);
        const lp = filt('lowpass', 700), ng = gain(); lp.connect(ng); ng.connect(out); env(ng.gain, t, 0.35, 0.002, 0.09); noise(white, lp, t, 0.3, 0.14);
      },
      stamp(out, t, e) {
        S.thud(out, t, e);
        const bp = filt('bandpass', 1600, 0.6), ng = gain(); bp.connect(ng); ng.connect(out); env(ng.gain, t, 0.45, 0.001, 0.06); noise(white, bp, t, 1.1, 0.1);
      },
      rustle(out, t, e) {
        const d = e.d || 0.5, bp = filt('bandpass', 900, 0.6), g = gain(), am = gain();
        bp.connect(am); am.connect(g); g.connect(out);
        bp.frequency.setValueAtTime(900, t); bp.frequency.linearRampToValueAtTime(3000, t + d);
        const n = 24, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = 0.25 + 0.75 * FILM.rnd('rs', e.t, i);
        am.gain.setValueCurveAtTime(c, t, d);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.28, t + d * 0.25); g.gain.linearRampToValueAtTime(0.0001, t + d);
        noise(white, bp, t, R('ro', e) * 2, d + 0.05);
      },
      scribble(out, t, e) {
        const d = Math.min(2.4, e.d || 0.5), hp = filt('highpass', 1800), bp = filt('bandpass', 4200, 1.1), g = gain(), am = gain();
        hp.connect(bp); bp.connect(am); am.connect(g); g.connect(out);
        const n = Math.max(4, Math.floor(d * 60)), c = new Float32Array(n);
        for (let i = 0; i < n; i++) { const ph = (i / 60) * (10 + FILM.rnd('sf', e.t) * 4) * Math.PI * 2; c[i] = Math.pow(Math.abs(Math.sin(ph)), 1.5) * (0.5 + 0.5 * FILM.rnd('sa', e.t, Math.floor(i / 6))); }
        am.gain.setValueCurveAtTime(c, t, d);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.03); g.gain.setValueAtTime(0.16, t + Math.max(0.04, d - 0.05)); g.gain.linearRampToValueAtTime(0.0001, t + d);
        noise(white, hp, t, R('so', e) * 2, d + 0.05);
      },
      whoosh(out, t, e) {
        const d = e.d || 0.9, bp = filt('bandpass', 300, 1.1), g = gain(), p = ac.createStereoPanner();
        bp.connect(g); g.connect(p); p.connect(out);
        bp.frequency.setValueAtTime(260, t); bp.frequency.exponentialRampToValueAtTime(1500, t + d * 0.5); bp.frequency.exponentialRampToValueAtTime(420, t + d);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.32, t + d * 0.5); g.gain.linearRampToValueAtTime(0.0001, t + d);
        p.pan.setValueAtTime(-0.5, t); p.pan.linearRampToValueAtTime(0.5, t + d);
        noise(white, bp, t, R('wo', e) * 2, d + 0.05);
      },
      swish(out, t, e) {
        const d = e.d || 0.25, bp = filt('bandpass', 2200, 1.4), g = gain(); bp.connect(g); g.connect(out);
        bp.frequency.setValueAtTime(1400, t); bp.frequency.exponentialRampToValueAtTime(5200, t + d);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + d * 0.4); g.gain.linearRampToValueAtTime(0.0001, t + d);
        noise(white, bp, t, R('sw', e) * 2, d + 0.03);
      },
      twinkle(out, t) { [0, 2, 3, 5, 7].forEach((k, i) => bell(out, t + i * 0.055, PENTA[k], 0.09, 0.9)); },
      sparkleburst(out, t) {
        for (let i = 0; i < 9; i++) bell(out, t + i * 0.045 + FILM.rnd('sb', i) * 0.02, PENTA[Math.floor(FILM.rnd('sn', i) * PENTA.length)] * (i % 3 === 0 ? 0.5 : 1), 0.08, 1.4);
        const hp = filt('highpass', 6000), g = gain(); hp.connect(g); g.connect(out); env(g.gain, t, 0.05, 0.05, 0.9); noise(white, hp, t, 0.7, 1.1);
      },
      ding(out, t, e) { bell(out, t, PENTA[(e.note || 0) % PENTA.length], 0.13, 1.2); },
      chime(out, t) { bell(out, t, PENTA[2], 0.12, 1.0); bell(out, t + 0.16, PENTA[4], 0.12, 1.3); },
      tick(out, t, e) {
        const o = osc('sine', 1700 + ((e.pitch || 0) % 5) * 180), g = gain(); o.connect(g); g.connect(out);
        env(g.gain, t, 0.09, 0.001, 0.035); o.start(t); o.stop(t + 0.07);
      },
      click(out, t) {
        const hp = filt('highpass', 1500), g = gain(); hp.connect(g); g.connect(out); env(g.gain, t, 0.55, 0.0005, 0.018); noise(white, hp, t, 0.9, 0.03);
        const o = osc('sine', 2100), og = gain(); o.connect(og); og.connect(out); env(og.gain, t, 0.12, 0.0005, 0.02); o.start(t); o.stop(t + 0.04);
      },
      boing(out, t, e) {
        const o = osc('sine', 220), g = gain(), lfo = osc('sine', 16), lg = gain(); lfo.connect(lg); lg.connect(o.frequency);
        o.connect(g); g.connect(out);
        const f0 = 200 + ((e.pitch || 0) % 4) * 30;
        o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 2.8, t + 0.13);
        lg.gain.setValueAtTime(22, t); lg.gain.exponentialRampToValueAtTime(1, t + 0.3);
        env(g.gain, t, 0.16, 0.004, 0.32); o.start(t); lfo.start(t); o.stop(t + 0.45); lfo.stop(t + 0.45);
      },
      boink(out, t, e) {
        const o = osc('triangle', 420), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(460 - (e.pitch || 0) * 60, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.14);
        env(g.gain, t, 0.22, 0.003, 0.16); o.start(t); o.stop(t + 0.25);
      },
      snooze(out, t) {
        const o = osc('sine', 1100), g = gain(), lfo = osc('sine', 6), lg = gain(); lfo.connect(lg); lg.connect(o.frequency); lg.gain.value = 25;
        o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(1150, t); o.frequency.exponentialRampToValueAtTime(420, t + 0.6);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        o.start(t); lfo.start(t); o.stop(t + 0.75); lfo.stop(t + 0.75);
      },
      whistle(out, t) {
        const o = osc('sine', 500), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
        o.start(t); o.stop(t + 0.45);
      },
      latch(out, t, e) {
        [0, 0.075].forEach((dt, i) => {
          const hp = filt('highpass', 2200), g = gain(); hp.connect(g); g.connect(out); env(g.gain, t + dt, i ? 0.5 : 0.35, 0.001, 0.02); noise(white, hp, t + dt, 0.5 + i, 0.04);
          const o = osc('square', i ? 1250 : 950), og = gain(), lp = filt('lowpass', 3000); o.connect(lp); lp.connect(og); og.connect(out);
          env(og.gain, t + dt, 0.05, 0.001, 0.05); o.start(t + dt); o.stop(t + dt + 0.08);
        });
        S.thud(out, t + 0.075, e);
      },
      beep(out, t) {
        [0, 0.17].forEach((dt) => {
          const o = osc('square', 880), lp = filt('lowpass', 2200), g = gain(); o.connect(lp); lp.connect(g); g.connect(out);
          g.gain.setValueAtTime(0.0001, t + dt); g.gain.linearRampToValueAtTime(0.05, t + dt + 0.01); g.gain.setValueAtTime(0.05, t + dt + 0.08); g.gain.linearRampToValueAtTime(0.0001, t + dt + 0.1);
          o.start(t + dt); o.stop(t + dt + 0.12);
        });
      },
      thunder(out, t) {
        const lp = filt('lowpass', 170), hp = filt('highpass', 55), g = gain();
        hp.connect(lp); lp.connect(g); g.connect(out);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.9, t + 0.04); g.gain.exponentialRampToValueAtTime(0.35, t + 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
        noise(brown, hp, t, 0.2, 2.1);
        const bp = filt('bandpass', 800, 0.5), cg = gain(), am = gain(); bp.connect(am); am.connect(cg); cg.connect(out);
        const n = 30, cv = new Float32Array(n); for (let i = 0; i < n; i++) cv[i] = FILM.rnd('th', i) > 0.6 ? 1 : 0.15;
        am.gain.setValueCurveAtTime(cv, t, 0.35);
        env(cg.gain, t, 0.12, 0.01, 0.45); noise(white, bp, t, 1.3, 0.6);
      },
      buzz(out, t) {
        const o = osc('sawtooth', 165), lp = filt('lowpass', 420), bhp = filt('highpass', 180), g = gain(), am = osc('square', 28), ag = gain();
        am.connect(ag); ag.gain.value = 0.5; o.connect(bhp); bhp.connect(lp); lp.connect(g); g.connect(out); ag.connect(g.gain);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.5, t + 0.02); g.gain.setValueAtTime(0.5, t + 0.3); g.gain.linearRampToValueAtTime(0.0001, t + 0.34);
        o.start(t); am.start(t); o.stop(t + 0.36); am.stop(t + 0.36);
      },
      'power-on'(out, t) {
        const o = osc('sine', 200), g = gain(); o.connect(g); g.connect(out);
        o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(760, t + 0.18);
        env(g.gain, t, 0.08, 0.01, 0.22); o.start(t); o.stop(t + 0.3);
        const hp = filt('highpass', 3500), ng = gain(); hp.connect(ng); ng.connect(out); env(ng.gain, t, 0.05, 0.08, 0.35); noise(white, hp, t, 2.0, 0.5);
      },
      ring(out, t, e) { // an old-fashioned bell-phone trill
        const d = e.d || 0.5, o = osc('sine', 1350), lfo = osc('square', 18), lg = gain(), g = gain(), bp = filt('bandpass', 1450, 1.4);
        lfo.connect(lg); lg.gain.value = 110; lg.connect(o.frequency); o.connect(bp); bp.connect(g); g.connect(out);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.015); g.gain.setValueAtTime(0.16, t + Math.max(0.02, d - 0.04)); g.gain.linearRampToValueAtTime(0.0001, t + d);
        o.start(t); lfo.start(t); o.stop(t + d + 0.02); lfo.stop(t + d + 0.02);
      },
      rumble(out, t, e) { // a low machine rumble
        const d = e.d || 0.8, lp = filt('lowpass', 240), hp = filt('highpass', 45), g = gain(), am = gain(), l = osc('sine', 11), lg = gain();
        hp.connect(lp); lp.connect(am); am.connect(g); g.connect(out);
        am.gain.value = 0.6; l.connect(lg); lg.gain.value = 0.4; lg.connect(am.gain);
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.7, t + 0.1); g.gain.setValueAtTime(0.7, t + Math.max(0.11, d - 0.15)); g.gain.linearRampToValueAtTime(0.0001, t + d);
        noise(brown, hp, t, 0.5, d + 0.05); l.start(t); l.stop(t + d + 0.05);
      },
    };
    return S;
  }

  // Render the whole mix offline: renderBuffer returns the AudioBuffer (the in-browser exporter
  // encodes it directly), renderOffline the same mix as 16-bit stereo WAV bytes.
  A.renderBuffer = async function (raw, sr = 48000) {
    const oc = new OfflineAudioContext(2, Math.ceil(A.dur * sr), sr);
    const bufs = await A.decodeAll(oc, raw);
    A.build(oc, oc.destination, bufs, 0, 0);
    return oc.startRendering();
  };
  A.renderOffline = async function (raw, sr = 48000) { return A.toWav(await A.renderBuffer(raw, sr)); };
  A.toWav = function (buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, sr, true);
    data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
    const chans = [...Array(ch).keys()].map((c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
    return new Uint8Array(data.buffer);
  };
})();
