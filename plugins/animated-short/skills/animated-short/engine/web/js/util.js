// Shared math for the film engine: deterministic randomness, value noise, easing and
// stop-motion time. Everything visual is a pure function of time, so frames can render in
// any order and on any number of pages. Never use Math.random or wall-clock time.
(function (root) {
  const FILM = (root.FILM = root.FILM || {});

  function mix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16; return h >>> 0;
  }
  // hash(str) -> uint32 (FNV-1a); used to turn ids into seeds
  FILM.hash = function (s) {
    s = String(s);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  // rnd(...keys) -> [0,1), stable for the same keys (numbers are keyed at 1e-3 resolution)
  FILM.rnd = function (...keys) {
    let h = 0x9e3779b9;
    for (const k of keys) {
      const v = typeof k === 'string' ? FILM.hash(k) : (Math.round(k * 1000) | 0);
      h = mix32(h ^ v) + 0x6d2b79f5;
    }
    return mix32(h) / 4294967296;
  };
  FILM.srnd = (...k) => FILM.rnd(...k) * 2 - 1; // [-1,1)

  // rng(seed) -> a seeded generator () => [0,1) for building static textures
  FILM.rng = function (seed) {
    let a = (typeof seed === 'string' ? FILM.hash(seed) : seed) >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // 1D value noise in [0,1]
  FILM.noise = function (x, seed = 0) {
    const i = Math.floor(x), f = x - i;
    const u = f * f * (3 - 2 * f);
    return FILM.rnd(seed, i) * (1 - u) + FILM.rnd(seed, i + 1) * u;
  };

  FILM.clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  FILM.lerp = (a, b, u) => a + (b - a) * u;
  // seg(t, a, b): 0 before a, 1 after b, linear between
  FILM.seg = (t, a, b) => (b <= a ? (t >= a ? 1 : 0) : FILM.clamp((t - a) / (b - a)));
  FILM.E = {
    linear: (u) => u,
    inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    out: (u) => 1 - Math.pow(1 - u, 3),
    in: (u) => u * u * u,
    sine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
    back: (u, k = 1.9) => 1 + (k + 1) * Math.pow(u - 1, 3) + k * Math.pow(u - 1, 2),
    elastic: (u) => (u === 0 || u === 1 ? u : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  };
  // Stop-motion time: element animation advances "on twos" at 15 fps, which gives the
  // hand-made boil. Camera moves use raw t so pans stay smooth.
  FILM.STEP_FPS = 15;
  FILM.step = (t) => Math.floor(t * FILM.STEP_FPS + 1e-6) / FILM.STEP_FPS;
  FILM.deg = (d) => (d * Math.PI) / 180;
  // Fade lengths from the film duration (picture and sound share them):
  //   in  = clamp(1% of duration, 0.1 s, 0.35 s)   (from the paper colour)
  //   out = clamp(2% of duration, 0.25 s, 0.8 s)   (to the page ground colour; ends 0.03 s early
  //         so the last frame is fully faded)
  FILM.fades = (dur) => ({ in: FILM.clamp(dur * 0.01, 0.1, 0.35), out: FILM.clamp(dur * 0.02, 0.25, 0.8) });
})(typeof window !== 'undefined' ? window : globalThis);
