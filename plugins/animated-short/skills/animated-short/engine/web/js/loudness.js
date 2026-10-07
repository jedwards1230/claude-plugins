// Loudness measurement and normalization without ffmpeg (render-only; not part of the live page).
// ITU-R BS.1770-4 integrated loudness: K-weighting (high shelf + high pass, coefficients derived
// for any sample rate), 400 ms blocks with 75% overlap, an absolute gate at -70 LUFS and a
// relative gate 10 LU below the ungated mean. True peak: 4x oversampling with a windowed-sinc
// polyphase interpolator. normalize() applies a gain to the target loudness and, when the true
// peak would pass the ceiling, a linked look-ahead peak limiter, iterating until both hold.
// Works in the page (window.FILM.LOUD) and in Node (loaded into a vm, like resolve.mjs does).
// Channels are arrays of Float32Array; channel weights are 1 (mono or stereo programmes).
(function (root) {
  const FILM = (root.FILM = root.FILM || {});
  const L = (FILM.LOUD = {});
  const dB = (x) => 20 * Math.log10(x);
  const lin = (d) => Math.pow(10, d / 20);

  // ---- K-weighting: two biquads (pre-filter shelf, RLB high pass)
  function coeffs(sr) {
    let K = Math.tan((Math.PI * 1681.974450955533) / sr);
    const Q1 = 0.7071752369554196, Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q1 + K * K;
    const s1 = { b0: (Vh + (Vb * K) / Q1 + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q1 + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q1 + K * K) / a0 };
    K = Math.tan((Math.PI * 38.13547087602444) / sr);
    const Q2 = 0.5003270373238773;
    a0 = 1 + K / Q2 + K * K;
    const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
    return [s1, s2];
  }
  function biquad(x, c) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], o = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
    }
    return y;
  }
  L.kWeight = function (ch, sr) { const [s1, s2] = coeffs(sr); return biquad(biquad(ch, s1), s2); };

  // Mean-square energy of every 400 ms block (100 ms hop), summed over channels.
  function blockEnergies(chans, sr) {
    const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), n = chans[0].length;
    const count = n >= block ? Math.floor((n - block) / hop) + 1 : 0, z = new Float64Array(count);
    for (const ch of chans) {
      const k = L.kWeight(ch, sr), cum = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + k[i] * k[i];
      for (let j = 0; j < count; j++) z[j] += (cum[j * hop + block] - cum[j * hop]) / block;
    }
    return z;
  }
  const lufs = (e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
  // Integrated loudness in LUFS (-Infinity for silence or a programme shorter than one block).
  L.integrated = function (chans, sr) {
    const z = Array.from(blockEnergies(chans, sr)).filter((e) => lufs(e) > -70);
    if (!z.length) return -Infinity;
    const rel = lufs(z.reduce((a, b) => a + b, 0) / z.length) - 10;
    const g = z.filter((e) => lufs(e) > rel);
    return g.length ? lufs(g.reduce((a, b) => a + b, 0) / g.length) : -Infinity;
  };

  // ---- true peak: 4x oversampling, 12 taps per phase (Hann-windowed sinc, unity DC gain)
  const OS = 4, TAPS = 12, K0 = 1 - TAPS / 2; // taps cover samples i-5 .. i+6
  const [H1, H2, H3] = [1, 2, 3].map((p) => {
    const h = new Float64Array(TAPS);
    for (let t = 0; t < TAPS; t++) {
      const x = K0 + t - p / OS, w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2 + 1));
      h[t] = (Math.sin(Math.PI * x) / (Math.PI * x)) * w;
    }
    const s = h.reduce((a, b) => a + b, 0);
    return h.map((v) => v / s);
  });
  // Per-sample peak envelope: max |x| at sample i and at the three interpolated points after it.
  function peakEnvelope(ch) {
    const n = ch.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s1 = 0, s2 = 0, s3 = 0;
      const j0 = i + K0;
      if (j0 >= 0 && j0 + TAPS <= n) {
        for (let t = 0; t < TAPS; t++) { const x = ch[j0 + t]; s1 += x * H1[t]; s2 += x * H2[t]; s3 += x * H3[t]; }
      } else {
        for (let t = 0; t < TAPS; t++) { const j = j0 + t; if (j >= 0 && j < n) { const x = ch[j]; s1 += x * H1[t]; s2 += x * H2[t]; s3 += x * H3[t]; } }
      }
      out[i] = Math.max(Math.abs(ch[i]), Math.abs(s1), Math.abs(s2), Math.abs(s3));
    }
    return out;
  }
  L.truePeak = function (chans) {
    let m = 0;
    for (const ch of chans) { const e = peakEnvelope(ch); for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i]; }
    return m > 0 ? dB(m) : -Infinity;
  };
  L.samplePeak = function (chans) {
    let m = 0;
    for (const ch of chans) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; }
    return m > 0 ? dB(m) : -Infinity;
  };
  const r2 = (x) => (isFinite(x) ? +x.toFixed(2) : x === -Infinity ? null : x);
  // measure(chans, sr) -> {I (LUFS), TP (dBTP), SP (dBFS), seconds}; silent values are null
  L.measure = function (chans, sr) {
    return { I: r2(L.integrated(chans, sr)), TP: r2(L.truePeak(chans)), SP: r2(L.samplePeak(chans)), seconds: +(chans[0].length / sr).toFixed(3) };
  };

  // ---- linked look-ahead limiter. The gain never exceeds what each sample's true-peak envelope
  // needs: a centred running minimum (radius R) followed by a centred moving average (radius R/2)
  // keeps every sample under the ceiling, then an exponential release and a mirrored attack
  // smooth the gain further (each pass can only lower it, so the guarantee holds).
  function limit(chans, sr, ceiling) {
    const n = chans[0].length, env = new Float32Array(n);
    for (const ch of chans) { const e = peakEnvelope(ch); for (let i = 0; i < n; i++) if (e[i] > env[i]) env[i] = e[i]; }
    const c = lin(ceiling), need = new Float32Array(n);
    let worst = 1;
    for (let i = 0; i < n; i++) { need[i] = env[i] > c ? c / env[i] : 1; if (need[i] < worst) worst = need[i]; }
    if (worst >= 1) return { chans, reductionDb: 0 };
    const R = Math.max(8, Math.round(0.0025 * sr)), H = Math.max(4, R >> 1);
    const mn = new Float32Array(n), dq = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n + R; i++) { // sliding-window minimum over [i - 2R, i], written at i - R
      if (i < n) { while (tail > head && need[dq[tail - 1]] >= need[i]) tail--; dq[tail++] = i; }
      while (dq[head] < i - 2 * R) head++;
      if (i - R >= 0) mn[i - R] = need[dq[head]];
    }
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + mn[i];
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - H), b = Math.min(n, i + H + 1); g[i] = (cum[b] - cum[a]) / (b - a); }
    const rel = Math.exp(-1 / (0.08 * sr)), att = Math.exp(-1 / (0.004 * sr));
    for (let i = 1; i < n; i++) { const up = 1 - (1 - g[i - 1]) * rel; if (g[i] > up) g[i] = up; }
    for (let i = n - 2; i >= 0; i--) { const up = 1 - (1 - g[i + 1]) * att; if (g[i] > up) g[i] = up; }
    const out = chans.map((ch) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = ch[i] * g[i]; return o; });
    let min = 1; for (let i = 0; i < n; i++) if (g[i] < min) min = g[i];
    return { chans: out, reductionDb: +(-dB(min)).toFixed(2) };
  }
  const gain = (chans, d) => { const k = lin(d); return chans.map((ch) => { const o = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) o[i] = ch[i] * k; return o; }); };

  // normalize(chans, sr, {I = -14.5, TP = -1.5, tolerance = 0.1}) ->
  //   {chans, gainDb, limiterDb, before: measure, after: measure, silent}
  // TP is the limiter ceiling in dBTP; keep it a little under the delivery gate (-1 dBTP) so
  // lossy encoding cannot push the peaks over.
  L.normalize = function (chans, sr, o = {}) {
    const target = o.I == null ? -14.5 : o.I, ceiling = o.TP == null ? -1.5 : o.TP, tol = o.tolerance || 0.1;
    const before = L.measure(chans, sr);
    if (before.I == null) return { chans, gainDb: 0, limiterDb: 0, before, after: before, silent: true };
    let g = target - before.I, out = chans, red = 0, ceil = ceiling, I = before.I;
    for (let it = 0; it < 6; it++) {
      const lim = limit(gain(chans, g), sr, ceil);
      out = lim.chans; red = lim.reductionDb;
      I = L.integrated(out, sr);
      const tp = L.truePeak(out);
      if (tp > ceiling + 0.01) { ceil -= tp - ceiling + 0.02; continue; }
      if (Math.abs(I - target) <= tol) break;
      g += target - I;
    }
    return { chans: out, gainDb: +g.toFixed(2), limiterDb: red, before, after: L.measure(out, sr), silent: false };
  };

  // ---- WAV (PCM 16/24/32-bit or float32) <-> channels
  L.wavDecode = function (bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
    let fmt = null, off = 12;
    while (off + 8 <= u8.length) {
      const id = tag(off), size = dv.getUint32(off + 4, true), body = off + 8;
      if (id === 'fmt ') {
        fmt = { format: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
        if (fmt.format === 0xfffe && size >= 26) fmt.format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV data before fmt');
        const bps = fmt.bits / 8, n = Math.floor(Math.min(size, u8.length - body) / (bps * fmt.ch));
        const float = fmt.format === 3;
        const chans = [...Array(fmt.ch)].map(() => new Float32Array(n));
        for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
          const p = body + (i * fmt.ch + c) * bps;
          chans[c][i] = float ? dv.getFloat32(p, true) : fmt.bits === 16 ? dv.getInt16(p, true) / 32768
            : fmt.bits === 24 ? ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608) : dv.getInt32(p, true) / 2147483648;
        }
        return { sr: fmt.sr, chans };
      }
      off = body + size + (size & 1);
    }
    throw new Error('WAV has no data chunk');
  };
  L.wavEncode = function (chans, sr) {
    const ch = chans.length, n = chans[0].length, dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); dv.setInt16(o, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true); o += 2; }
    return new Uint8Array(dv.buffer);
  };
})(typeof window !== 'undefined' ? window : globalThis);
