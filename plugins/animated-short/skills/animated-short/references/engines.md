# Engines: the adapter contract

The film is data (the storyboard) plus a few custom shots. An engine turns it into pictures.
The bundled canvas engine is the default; others can plug in behind the same contract.
`$SKILL` is the skill's base directory and `$FILM` the film directory.

## The contract

An engine is anything that can render any moment on demand, silently, from the engine-neutral
storyboard (`storyboard.md`, `$SKILL/references/storyboard.schema.json`). Audio is always mixed
outside the engine, from the same resolved storyboard, so every engine sounds the same.

```text
EngineAdapter {
  id                       "canvas", "hyperframes", ...
  caps()      -> {layouts, kinds, beats, downgrades, sizes, fps, deterministic, needs}
  check()     -> {ok, problems, license_notice}          tools present, fonts render, license shown
  compile(spec) -> {resolved, downgrades[], warnings[]}  cues to seconds, unsupported features downgraded
  renderStill(t) -> image                                any frame, any order
  render(range) -> silent frames or video                frame-exact, deterministic
}
audio (engine-independent): offline mix of vo + music + sfx -> WAV -> loudness at export
```

Rules every adapter keeps:

- A frame is a pure function of time. Rendering frames in any order, on any number of pages,
  gives identical pixels.
- Compile reports every downgrade (a feature the engine cannot draw and replaces with a
  simpler one) instead of silently dropping it.
- The text drawn at any time is queryable (for the size, dwell and repeat checks), or the
  adapter says the text gates cannot run.
- The golden example (`$SKILL/examples/golden/`) is the conformance test: an adapter is usable
  when it renders the golden storyboard with every reported downgrade accounted for and the
  technical checks pass.

## The canvas engine (default)

Plain JavaScript on a 2D canvas in headless Chromium, driven by Playwright; frames are JPEGs,
the mix comes from an OfflineAudioContext. `FILM.R.draw(ctx, t)` paints one frame.

| Contract | Canvas command |
| --- | --- |
| `caps()` | Layouts `stage`, `board` (+ overlay scenes); all nine element kinds and ten beats; downgrades `morph` -> crossfade, `equation` -> text, `clip` -> poster sprite; any even size (16:9, 9:16, 1:1); any fps (30 default); deterministic. Needs Node 18+ and Chromium; ffmpeg optional. |
| `check()` | `node "$FILM/tools/render.mjs" glyph --film "$FILM"` (fonts), `node "$FILM/tools/export.mjs" --probe --film "$FILM"` (Chromium, WebCodecs, ffmpeg), `python3 "$SKILL/scripts/preflight.py" --film "$FILM"`. License: part of this plugin (MIT); dependencies playwright-core (Apache-2.0) and mediabunny (MPL-2.0, unmodified npm dependency). |
| `compile(spec)` | `node "$FILM/tools/resolve.mjs" --film "$FILM" --strict [--json]` -> `web/film/storyboard.json` with `downgrades[]`, camera moves, resolved cues. |
| `renderStill(t)` | `node "$FILM/tools/render.mjs" stills 1.5,poster --film "$FILM"` -> `work/qa/stills/tNNN.NN.jpg`; in the page, `window.__film.frame(t)` / `png(t)`. |
| `render(range)` | `node "$FILM/tools/render.mjs" video --film "$FILM" [--range a-b] [--workers n]` -> `work/frames/f%05d.jpg` (silent); `export.mjs` encodes. |
| audio | `node "$FILM/tools/render.mjs" audio --film "$FILM"` -> `work/mix.wav` (48 kHz); loudness at export. |
| text query | `node "$FILM/tools/render.mjs" text 3.2,7 --film "$FILM"` -> every text drawn at t with `px1080` and bbox. |
| purity | `node "$FILM/tools/render.mjs" purity --film "$FILM" [--n 24]` renders samples in order and shuffled and compares hashes. |
| conformance | `bash "$SKILL/scripts/test-golden.sh" --scaffold-py --out <dir>` (and `--no-ffmpeg`, `--aspect 9:16`, `--end-card`). |

Page hooks when loaded with `?render`: `window.__film = {ready, dur, fps, size, posterT,
frame(t, q), png(t), text(t), glyphTest(), moves(), audio()}`. The live player (the same page
without `?render`) is the always-on deliverable.

## HyperFrames: the next adapter (planned, not implemented)

HyperFrames (HeyGen, Apache-2.0, 0.x releases) renders HTML compositions (GSAP, Lottie, Three)
by seeking a page clock: `window.__hf = {duration, seek(t)}`, captured frame-exactly with
BeginFrame through chrome-headless-shell; it needs Node 22+. The seek contract is the same idea
as `window.__film`, which makes it the closest sibling. It fits explainers with kinetic type,
charts, captions and launch-video polish that the paper look does not.

Implementation plan (for whoever builds it; read HyperFrames' own README for its current CLI
and composition format before starting, since 0.x details change):

1. `engine-hyperframes/` template beside `engine/`, scaffolded by a `--engine hyperframes`
   option; film.json `engine` gains the value `hyperframes`.
2. `compile`: a Node script reads the resolved storyboard (reuse `tools/resolve.mjs` unchanged:
   cues, camera plan and downgrade notes are engine-neutral) and emits one composition: scenes
   as timed groups, elements as DOM/SVG nodes, beats as a paused GSAP timeline keyed to
   seconds, camera keys as a transform on a world container. Report downgrades for anything
   without a mapping (paper tearing, boil, ransom letters by default).
3. `renderStill(t)`: load the composition, `await __hf.seek(t)`, screenshot.
4. `render(range)`: HyperFrames' own renderer, frames only (silent).
5. Text query: walk visible text nodes after `seek(t)`, report bbox in 1080-line pixels and
   font px, same shape as `__film.text(t)`, so `qa.mjs text-check` works unchanged.
6. Audio: keep ours. Render `work/mix.wav` with the canvas engine's offline mixer from the same
   resolved storyboard, and mux with `tools/mux.sh` or the WebCodecs path.
7. `check()`: Node >= 22, chrome-headless-shell present, license notice printed.
8. Conformance: render the golden storyboard; compare stills and text bboxes with the canvas
   engine at the same times, run `qa.mjs check`.

## Other engines

| Engine | Best for | License | Fit |
| --- | --- | --- | --- |
| Remotion | product demos, kinetic type, React-shaped data viz | source-available; free for individuals and companies of up to 3 people, larger companies pay, automated rendering is billed per render with a $100 monthly minimum (terms as of 2026-09) | strong, but print a license notice in `check()` and have the user confirm before use |
| Manim CE | math, equations, geometric proofs | MIT | good adapter for math; reportedly weaker when Claude writes it, better with Gemini |
| Revideo | Motion-Canvas-style code and diagram explainers | MIT | usable; slow releases, telemetry on by default (turn it off) |
| p5.js + p5.brush | painterly and watercolour looks | LGPL-2.1 | better as a future style preset on the canvas engine than a separate engine |
| Three.js / React Three Fiber | stylized 3D in the browser | MIT | drive a manual clock from `t`; needs a GPU for speed |
| Blender (headless) | high-quality 3D, Grease Pencil 2D | GPL application, output is yours | heavy and slow on CPU |
| dotLottie | logo stings, icon loops | MIT | renders in Node without a browser; good for small inserts |
| GSAP | timelines inside HTML engines | free including commercial use, but its terms bar tools that compete with Webflow's no-code builder | fine as a library inside an adapter |

Skip for now: Rive (agents cannot author its files), Theatre.js (dormant), Motion Canvas (no
CLI render), Godot (niche for this). Real-time capture (Playwright video, MediaRecorder,
screen recording) is not frame-exact: use it only as the WebM last resort in `delivery.md`.
