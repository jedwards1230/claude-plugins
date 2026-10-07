// Render-only page toolkit (FILM.X) used by tools/export.mjs and tools/qa.mjs; the live page never
// loads it and the hosted page bundle leaves it out. It provides:
//   probe()        what this browser can encode (WebCodecs video/audio/subtitles, MediaRecorder)
//   mp4(o)         frame-exact MP4s in one pass: every frame is drawn once with FILM.R.draw and fed
//                  to Mediabunny CanvasSources (H.264) with explicit timestamps; smaller variants
//                  get a downscaled copy of the same frame; the offline mix is loudness-normalized
//                  (FILM.LOUD) and encoded as Opus; captions go in as a WebVTT track
//   webm(o)        real-time MediaRecorder capture of the canvas plus the normalized mix (not
//                  frame-exact; the last-resort path)
//   sheet(o), crop(o)   contact sheets, strips and 1080p-space crops for frame QA
// Results too big for one evaluate() stay in memory and are pulled in chunks with take().
// Mediabunny is served by the render server at /vendor/mediabunny.mjs (never from a CDN).
(function () {
  const FILM = (window.FILM = window.FILM || {});
  const X = (FILM.X = { progress: null });
  let mbP = null;
  const mb = () => mbP || (mbP = import('/vendor/mediabunny.mjs'));
  const store = {};
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  X.size = (id) => (store[id] ? store[id].length : -1);
  X.take = (id, off, len) => b64(store[id].subarray(off, off + len));
  X.drop = (id) => { delete store[id]; };

  const RECORDER_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=av01,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  X.probe = async function (o = {}) {
    const w = o.w || 1920, h = o.h || 1080, fps = o.fps || 30;
    const res = { secure: window.isSecureContext, webcodecs: typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function', video: {}, audio: {}, subtitles: {}, mediaRecorder: [] };
    if (res.webcodecs) {
      const M = await mb(), ok = (p) => p.then((v) => !!v, () => false);
      for (const c of ['avc', 'vp9', 'av1']) res.video[c] = await ok(M.canEncodeVideo(c, { width: w, height: h, frameRate: fps, quality: new M.Quality({ bitrate: 6e6 }) }));
      for (const c of ['opus', 'aac']) res.audio[c] = await ok(M.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, quality: new M.Quality({ bitrate: 160000 }) }));
      res.subtitles.webvtt = (await ok(M.canEncodeSubtitles('webvtt'))) && new M.Mp4OutputFormat().getSupportedCodecs().includes('webvtt');
    }
    if (typeof MediaRecorder === 'function') res.mediaRecorder = RECORDER_TYPES.filter((t) => MediaRecorder.isTypeSupported(t));
    return res;
  };

  const channels = (buf) => [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
  // The offline mix, loudness-normalized to `lufs` with the limiter ceiling `ceiling` (dBTP).
  let raw = null;
  async function normalizedMix(lufs, ceiling) {
    const A = FILM.A;
    raw = raw || (await A.renderBuffer(await A.fetchAll(''), 48000));
    const r = FILM.LOUD.normalize(channels(raw), raw.sampleRate, { I: lufs, TP: ceiling });
    const out = new AudioBuffer({ length: raw.length, numberOfChannels: r.chans.length, sampleRate: raw.sampleRate });
    r.chans.forEach((c, i) => out.copyToChannel(c, i));
    store.mix = FILM.LOUD.wavEncode(r.chans, raw.sampleRate);
    return { buffer: out, report: { gainDb: r.gainDb, limiterDb: r.limiterDb, before: r.before, after: r.after, silent: r.silent } };
  }
  async function decodeMeasure(arrayBuffer) {
    const buf = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(arrayBuffer);
    return Object.assign(FILM.LOUD.measure(channels(buf), buf.sampleRate), { decoded_seconds: +buf.duration.toFixed(3) });
  }
  // Opus can overshoot sharp transients by a dB or more. Encode the normalized mix on its own,
  // decode it, and lower the limiter ceiling until the ENCODED true peak clears the gate.
  // o: {lufs, ceiling, gate (-1 dBTP)}; bitrate: the Opus bitrate the deliverables use.
  async function deliveryMix(o, bitrate) {
    const M = await mb(), gate = o.gate == null ? -1 : o.gate;
    let ceiling = o.ceiling, r = await normalizedMix(o.lufs, ceiling), enc = null;
    for (let i = 0; i < 4 && !r.report.silent; i++) {
      try {
        const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
        const src = new M.AudioBufferSource({ codec: 'opus', quality: new M.Quality({ bitrate }) });
        output.addAudioTrack(src);
        await output.start(); await src.add(r.buffer); src.close(); await output.finalize();
        enc = await decodeMeasure(output.target.buffer);
      } catch (e) { enc = { error: String(e && e.message ? e.message : e) }; break; }
      if (enc.TP == null || enc.TP <= gate - 0.25) break; // margin: decoders differ by ~0.1 dB
      ceiling = +(ceiling - (enc.TP - (gate - 0.35))).toFixed(2);
      r = await normalizedMix(o.lufs, ceiling);
    }
    Object.assign(r.report, { ceiling, encoded: enc });
    return r;
  }

  // Decode the audio of a stored result (or a URL) back and measure it (post-encode loudness).
  X.measure = async function (idOrUrl) {
    return decodeMeasure(store[idOrUrl] ? store[idOrUrl].slice().buffer : await (await fetch(idOrUrl)).arrayBuffer());
  };

  // mp4(o) -> {mix: report, variants: [{id, w, h, bytes}], subtitles}
  // o: {variants: [{id, w, h, videoBitrate}], audioBitrate, lufs, ceiling, gate, vtt, title,
  //     comment, description, lang, keyFrameInterval}
  X.mp4 = async function (o) {
    const M = await mb(), R = FILM.R, fps = R.fps, N = Math.round(R.dur * fps);
    const { buffer, report } = await deliveryMix(o, o.audioBitrate);
    const main = canvas(R.W, R.H), mctx = main.getContext('2d', { alpha: false }), k = R.W / R.RW;
    const subs = !!o.vtt && (await M.canEncodeSubtitles('webvtt').catch(() => false));
    const outs = o.variants.map((v) => {
      const cv = v.w === R.W && v.h === R.H ? main : canvas(v.w, v.h);
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
      const video = new M.CanvasSource(cv, { codec: 'avc', quality: new M.Quality({ bitrate: v.videoBitrate }), keyFrameInterval: o.keyFrameInterval || 2 });
      const audio = new M.AudioBufferSource({ codec: 'opus', quality: new M.Quality({ bitrate: o.audioBitrate }) });
      output.addVideoTrack(video, { frameRate: fps });
      output.addAudioTrack(audio, { languageCode: o.lang || 'eng' });
      const text = subs ? new M.TextSubtitleSource('webvtt') : null;
      if (text) output.addSubtitleTrack(text, { languageCode: o.lang || 'eng' });
      const tags = {};
      for (const key of ['title', 'comment', 'description']) if (o[key]) tags[key] = o[key];
      output.setMetadataTags(tags);
      return { v, cv, ctx: cv === main ? null : cv.getContext('2d', { alpha: false }), output, video, audio, text };
    });
    await Promise.all(outs.map((x) => x.output.start()));
    // audio and captions run alongside the video loop so the muxer can interleave the tracks
    const side = Promise.all(outs.map(async (x) => {
      await x.audio.add(buffer); x.audio.close();
      if (x.text) { await x.text.add(o.vtt); x.text.close(); }
    }));
    X.progress = { done: 0, total: N };
    for (let i = 0; i < N; i++) {
      const t = i / fps;
      R.draw(mctx, t, k);
      for (const x of outs) {
        if (!x.ctx) continue;
        x.ctx.imageSmoothingEnabled = true; x.ctx.imageSmoothingQuality = 'high';
        x.ctx.drawImage(main, 0, 0, x.v.w, x.v.h);
      }
      await Promise.all(outs.map((x) => x.video.add(t, 1 / fps)));
      X.progress.done = i + 1;
    }
    outs.forEach((x) => x.video.close());
    await side;
    await Promise.all(outs.map((x) => x.output.finalize()));
    for (const x of outs) store[x.v.id] = new Uint8Array(x.output.target.buffer);
    return { mix: report, subtitles: subs, frames: N, variants: outs.map((x) => ({ id: x.v.id, w: x.v.w, h: x.v.h, bytes: store[x.v.id].length })) };
  };

  // webm(o) -> {bytes, mime, drawn, expected, mix}: real-time capture, so frames the page cannot
  // draw in time are repeated. o: {w, h, mime, videoBitrate, audioBitrate, lufs, ceiling, gate}
  X.webm = async function (o) {
    const R = FILM.R, { buffer, report } = await deliveryMix(o, o.audioBitrate);
    const cv = canvas(o.w, o.h), ctx = cv.getContext('2d', { alpha: false }), k = o.w / R.RW;
    R.draw(ctx, 0, k);
    const stream = cv.captureStream(R.fps), ac = new AudioContext({ sampleRate: 48000 });
    await ac.resume();
    const dest = ac.createMediaStreamDestination(), src = ac.createBufferSource();
    src.buffer = buffer; src.connect(dest);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(stream, { mimeType: o.mime, videoBitsPerSecond: o.videoBitrate, audioBitsPerSecond: o.audioBitrate });
    const parts = [], stopped = new Promise((res) => { rec.onstop = res; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.start(500);
    const t0 = ac.currentTime;
    src.start(t0);
    let drawn = 0;
    X.progress = { done: 0, total: Math.round(R.dur * R.fps) };
    await new Promise((res) => {
      const tick = () => {
        const t = ac.currentTime - t0;
        if (t >= R.dur) return res();
        if (t >= 0) { R.draw(ctx, t, k); drawn++; X.progress.done = Math.min(X.progress.total, Math.round(t * R.fps)); }
        setTimeout(tick, 0);
      };
      tick();
    });
    rec.stop(); await stopped; await ac.close();
    const recorded = new Uint8Array(await new Blob(parts, { type: o.mime }).arrayBuffer());
    // MediaRecorder writes no duration or seek index; a stream-copy remux adds both, trims the
    // tail to the film length and sets the metadata tags
    let remuxed = false;
    try {
      const M = await mb(), input = new M.Input({ source: new M.BufferSource(recorded), formats: M.ALL_FORMATS });
      const output = new M.Output({ format: new M.WebMOutputFormat(), target: new M.BufferTarget() });
      const tags = {};
      for (const key of ['title', 'comment', 'description']) if (o[key]) tags[key] = o[key];
      const conv = await M.Conversion.init({ input, output, trim: { end: R.dur }, tags, showWarnings: false });
      if (conv.isValid) { await conv.execute(); store.webm = new Uint8Array(output.target.buffer); remuxed = true; }
    } catch (e) { console.warn('webm remux failed; keeping the raw recording: ' + e.message); }
    if (!remuxed) store.webm = recorded;
    return { bytes: store.webm.length, mime: o.mime, drawn, expected: X.progress.total, remuxed, mix: report };
  };

  // ---- frame QA images
  function frameCanvas() {
    const R = FILM.R;
    if (!X.full) X.full = canvas(R.W, R.H);
    return X.full;
  }
  function drawFrame(t) { const R = FILM.R, c = frameCanvas(); R.draw(c.getContext('2d', { alpha: false }), t, R.W / R.RW); return c; }
  // sheet({items: [{t, label}], cols, tw, q}) -> JPEG data URL: labelled thumbnails in a grid
  X.sheet = function (o) {
    const R = FILM.R, cols = Math.max(1, Math.min(o.cols || 4, o.items.length)), tw = o.tw || 480, th = Math.round((tw * R.H) / R.W);
    const lab = 24, gap = 6, rows = Math.ceil(o.items.length / cols);
    const s = canvas(cols * tw + (cols + 1) * gap, rows * (th + lab) + (rows + 1) * gap), g = s.getContext('2d', { alpha: false });
    g.fillStyle = '#151515'; g.fillRect(0, 0, s.width, s.height);
    o.items.forEach((it, i) => {
      const x = gap + (i % cols) * (tw + gap), y = gap + Math.floor(i / cols) * (th + lab + gap);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(drawFrame(it.t), x, y + lab, tw, th);
      g.fillStyle = '#FFD84A'; g.font = '600 15px system-ui, "Noto Sans", sans-serif'; g.textBaseline = 'middle';
      g.fillText(it.label, x + 4, y + lab / 2, tw - 8);
    });
    return s.toDataURL('image/jpeg', o.q || 0.88);
  };
  // crop({t, rect: [x, y, w, h] in 1080-line reference px, scale}) -> PNG data URL (pixel zoom)
  X.crop = function (o) {
    const R = FILM.R, f = R.W / R.RW, [x, y, w, h] = o.rect, sc = o.scale || 2;
    const src = drawFrame(o.t), out = canvas(Math.round(w * sc), Math.round(h * sc)), g = out.getContext('2d', { alpha: false });
    g.imageSmoothingEnabled = false;
    g.drawImage(src, x * f, y * f, w * f, h * f, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };
})();
