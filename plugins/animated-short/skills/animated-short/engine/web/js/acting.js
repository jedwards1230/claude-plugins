// Acting kit: small pure helpers that make drawn characters act instead of snap.
// Every helper is a function of time (pass FILM.step(t) for the stop-motion feel, or raw t
// for smooth motion), so frames stay order-independent. Conventions: times in seconds,
// distances in px of the 1080-line frame, angles in degrees, poses are any values you like.
(function (root) {
  const FILM = root.FILM;
  const { rnd, srnd, clamp, lerp, seg, E } = FILM;
  const ACT = (FILM.ACT = {});

  // seed(id, base): a stable integer seed for an element id (base = storyboard meta.seed).
  ACT.seed = (id, base = 0) => FILM.hash(base + ':' + id) % 100000;

  // anticip(t, t0, o): wind-up before an action that starts at t0.
  //   Returns 0 .. -1 .. 0: dips to -1 just before t0, back to 0 at t0.
  //   Multiply by a pull-back distance opposite the action (e.g. x += anticip(...) * 20 * dir).
  //   o.lead: wind-up length in s (default 0.18).
  ACT.anticip = function (t, t0, o = {}) {
    const lead = o.lead || 0.18, u = (t - (t0 - lead)) / lead;
    if (u <= 0 || u >= 1) return 0;
    return u < 0.75 ? -E.out(u / 0.75) : -(1 - E.in((u - 0.75) / 0.25));
  };

  // squash(k): volume-preserving scale factors. k > 0 squashes (wider and shorter),
  //   k < 0 stretches (narrower and taller). Returns {sx, sy} with sx * sy === 1.
  ACT.squash = (k) => { const sx = Math.max(0.2, 1 + k); return { sx, sy: 1 / sx }; };

  // settle(dt, o): damped spring from 0 to 1 with overshoot; dt = seconds since the start.
  //   o.freq: oscillations per second (default 2.2), o.damp: decay per second (default 7).
  //   Returns 0 for dt <= 0; about 20% overshoot with the defaults.
  ACT.settle = function (dt, o = {}) {
    if (dt <= 0) return 0;
    const f = o.freq || 2.2, d = o.damp || 7;
    return 1 - Math.exp(-d * dt) * Math.cos(2 * Math.PI * f * dt);
  };

  // spring(t, t0, from, to, o): a value moving from `from` to `to` starting at t0, with an
  //   overshoot settle (o as settle()).
  ACT.spring = (t, t0, from, to, o) => lerp(from, to, ACT.settle(t - t0, o));

  // blink(t, seed, o): eyelid closure 0 (open) .. 1 (closed) at time t. The schedule is
  //   seeded and irregular: one blink somewhere in each slot of o.every seconds (default 3.4),
  //   a fifth of them doubled. o.dur: length of one blink in s (default 0.2); lids close in
  //   the first 35% and open over the rest.
  ACT.blink = function (t, seed, o = {}) {
    const P = o.every || 3.4, d = o.dur || 0.2, i = Math.floor(t / P);
    const lid = (dt) => (dt < 0 || dt > d ? 0 : dt < d * 0.35 ? dt / (d * 0.35) : 1 - (dt - d * 0.35) / (d * 0.65));
    let c = 0;
    for (const k of [i - 1, i]) {
      const t0 = (k + 0.1 + rnd(seed, 'blink', k) * 0.75) * P;
      c = Math.max(c, lid(t - t0));
      if (rnd(seed, 'double', k) < 0.2) c = Math.max(c, lid(t - t0 - d * 1.5));
    }
    return c;
  };
  // blinkTimes(seed, t0, t1, o): start times of the scheduled blinks in [t0, t1) (for tests or sound).
  ACT.blinkTimes = function (seed, t0, t1, o = {}) {
    const P = o.every || 3.4, d = o.dur || 0.2, out = [];
    for (let k = Math.floor(t0 / P) - 1; k * P < t1; k++) {
      const s = (k + 0.1 + rnd(seed, 'blink', k) * 0.75) * P;
      for (const x of rnd(seed, 'double', k) < 0.2 ? [s, s + d * 1.5] : [s]) if (x >= t0 && x < t1) out.push(x);
    }
    return out;
  };

  // take(t, t0, o): a pose/expression swap at t0 that never snaps. The body squashes during
  //   o.lead s before t0 (anticipation), the swap happens at maximum squash (exactly t0),
  //   then it springs back through a small stretch and settles.
  //   o.from / o.to: the poses; o.amt: squash depth (default 0.14); o.lead: wind-up
  //   (default 0.12 s); o.settle: settle() options.
  //   Returns {pose, sx, sy, k} (k = signed squash amount, 0 at rest).
  ACT.take = function (t, t0, o = {}) {
    const lead = o.lead || 0.12, amt = o.amt == null ? 0.14 : o.amt;
    if (t < t0 - lead) return { pose: o.from, sx: 1, sy: 1, k: 0 };
    if (t < t0) { const k = amt * E.inOut(seg(t, t0 - lead, t0)); return { pose: o.from, ...ACT.squash(k), k }; }
    const k = amt * (1 - ACT.settle(t - t0, o.settle));
    return { pose: o.to, ...ACT.squash(k), k };
  };
  // takes(t, list, o): a sequence of takes. list = [{at, pose}] sorted by at; the first entry
  //   is the resting pose (its at is ignored). o as take(). Returns take()'s result.
  ACT.takes = function (t, list, o = {}) {
    let cur = { pose: list[0].pose, sx: 1, sy: 1, k: 0 };
    for (let i = 1; i < list.length; i++) {
      const r = ACT.take(t, list[i].at, { ...o, from: list[i - 1].pose, to: list[i].pose });
      if (t >= list[i].at - (o.lead || 0.12)) cur = r; else break;
    }
    return cur;
  };

  // boil(id, t, amt): per-element stop-motion jitter [dx px, dy px, dr deg] keyed by the
  //   element id (so each element boils on its own seed), changing 7.5 times a second.
  //   amt scales it (1 = about 1.3 px and 0.35 deg; 0 = still).
  ACT.boil = function (id, t, amt = 1) {
    if (!amt) return [0, 0, 0];
    const b = Math.floor(t * 7.5 + 1e-6);
    return [srnd(id, 'bx', b) * 1.3 * amt, srnd(id, 'by', b) * 1.3 * amt, srnd(id, 'br', b) * 0.35 * amt];
  };

  // desync(id, i): offsets that keep sibling elements from moving as mirrored twins.
  //   id: the element's id; i: its index among siblings. Returns {phase (rad), amp (0.75..1.25),
  //   rate (0.85..1.15)}; phases are spread by the golden ratio so neighbours never match.
  ACT.desync = function (id, i = 0) {
    const g = (i * 0.6180339887 + rnd(id, 'phase')) % 1;
    return { phase: g * Math.PI * 2, amp: 0.75 + rnd(id, 'amp', i) * 0.5, rate: 0.85 + rnd(id, 'rate', i) * 0.3 };
  };
  // wave(t, id, freq, amp, i): a de-synced sine (Hz, amplitude) for idle motion.
  ACT.wave = function (t, id, freq = 0.5, amp = 1, i = 0) {
    const d = ACT.desync(id, i);
    return Math.sin(t * Math.PI * 2 * freq * d.rate + d.phase) * amp * d.amp;
  };
  // idle(t, id, o): gentle life for a resting element: {dx, dy, r, sx, sy}.
  //   o.bob: vertical drift px (default 4), o.sway: rotation deg (default 1.5),
  //   o.breathe: squash amount (default 0.015), o.rate: speed factor (default 1).
  ACT.idle = function (t, id, o = {}) {
    const f = o.rate || 1, bob = o.bob == null ? 4 : o.bob, sway = o.sway == null ? 1.5 : o.sway;
    const br = ACT.wave(t, id + ':breathe', 0.28 * f, o.breathe == null ? 0.015 : o.breathe);
    return { dx: 0, dy: ACT.wave(t, id + ':bob', 0.55 * f, bob), r: ACT.wave(t, id + ':sway', 0.37 * f, sway), ...ACT.squash(-br) };
  };

  // hop(a, b, u, h): point on a hop from a [x,y] to b [x,y] at progress u (0..1), arc height h px.
  ACT.hop = (a, b, u, h) => [lerp(a[0], b[0], E.sine(u)), lerp(a[1], b[1], E.sine(u)) - Math.sin(u * Math.PI) * h];

  // leap(t, t0, dur, o): a jump in place: anticipation squash before t0, stretch while
  //   airborne (strongest at take-off and landing), a landing squash that settles.
  //   o.h: height px (default 80), o.amt: squash depth (default 0.18), o.lead: wind-up s (0.14).
  //   Returns {y (px, negative is up), sx, sy}.
  ACT.leap = function (t, t0, dur, o = {}) {
    const h = o.h == null ? 80 : o.h, amt = o.amt == null ? 0.18 : o.amt, lead = o.lead || 0.14;
    if (t < t0 - lead) return { y: 0, sx: 1, sy: 1 };
    if (t < t0) return { y: 0, ...ACT.squash(amt * E.inOut(seg(t, t0 - lead, t0))) };
    if (t < t0 + dur) {
      const u = (t - t0) / dur;
      return { y: -Math.sin(u * Math.PI) * h, ...ACT.squash(-amt * 0.8 * Math.abs(Math.cos(u * Math.PI))) };
    }
    return { y: 0, ...ACT.squash(amt * (1 - ACT.settle(t - t0 - dur, { freq: 3, damp: 9 }))) };
  };

  // face(ctx, x, y, s, o): a simple ink face for code-drawn characters, centred at (x,y), size s px.
  //   o.pose: 'calm' | 'glad' | 'surprised' | 'worried' | 'sleepy' (default 'calm');
  //   o.blink: 0..1 lid closure (use blink()); o.look: [-1..1, -1..1] gaze; o.c: ink colour;
  //   o.t, o.seed: for the ink boil. Swap poses with take() so the change hides in a squash.
  ACT.face = function (ctx, x, y, s, o = {}) {
    const D = FILM.D, pose = o.pose || 'calm', c = o.c || 'ink', seed = o.seed || 1, t = o.t || 0;
    const lx = (o.look ? o.look[0] : 0) * s * 0.05, ly = (o.look ? o.look[1] : 0) * s * 0.04;
    const ex = s * 0.2, ey = -s * 0.08, er = s * (pose === 'surprised' ? 0.085 : 0.07);
    const lid = clamp(Math.max(o.blink || 0, pose === 'sleepy' ? 0.55 : 0));
    ctx.save(); ctx.fillStyle = D.color(c);
    for (const k of [-1, 1]) {
      const cx = x + k * ex + lx, cy = y + ey + ly;
      if (pose === 'glad' && lid < 0.5) {
        D.ink(ctx, D.arcPts(cx - er, cy + er * 0.3, cx + er, cy + er * 0.3, -0.55, 10), { w: s * 0.035, seed: seed + k, t, c, wob: 0.3 });
      } else if (lid > 0.85) {
        D.ink(ctx, [[cx - er, cy], [cx + er, cy]], { w: s * 0.03, seed: seed + k, t, c, wob: 0.2 });
      } else {
        ctx.beginPath(); ctx.ellipse(cx, cy + er * lid * 0.5, er * 0.8, er * (1 - lid), 0, 0, Math.PI * 2); ctx.fill();
      }
      if (pose === 'worried') D.ink(ctx, [[cx - er * 1.1, cy - er * 1.9 + k * er * 0.4], [cx + er * 1.1, cy - er * 1.9 - k * er * 0.4]], { w: s * 0.025, seed: seed + 5 + k, t, c, wob: 0.2 });
    }
    const my = y + s * 0.16 + ly, mw = s * 0.16;
    if (pose === 'surprised') { ctx.beginPath(); ctx.ellipse(x + lx, my, s * 0.05, s * 0.07, 0, 0, Math.PI * 2); ctx.fill(); }
    else if (pose === 'worried') D.ink(ctx, D.arcPts(x - mw + lx, my + s * 0.02, x + mw + lx, my + s * 0.02, -0.35, 10), { w: s * 0.03, seed: seed + 9, t, c, wob: 0.3 });
    else if (pose === 'sleepy') D.ink(ctx, [[x - mw * 0.5 + lx, my], [x + mw * 0.5 + lx, my]], { w: s * 0.03, seed: seed + 9, t, c, wob: 0.3 });
    else D.ink(ctx, D.arcPts(x - mw + lx, my - s * 0.02, x + mw + lx, my - s * 0.02, pose === 'glad' ? 0.45 : 0.25, 10), { w: s * 0.03, seed: seed + 9, t, c, wob: 0.3 });
    ctx.restore();
  };
})(typeof window !== 'undefined' ? window : globalThis);
