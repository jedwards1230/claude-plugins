# Storyboard: the film as data

`$SKILL` is the skill's base directory and `$FILM` the film directory (absolute paths; see
SKILL.md). The full field list is `$SKILL/references/storyboard.schema.json`; this file explains
how to use it.

## Files and flow

| File | Who writes it | What it holds |
| --- | --- | --- |
| `src/script.json` | the main agent | `{"lines": [{"id": "l1", "text": "...", "tts": "...", "reads": ["..."]}]}`. `text` is what captions and the transcript show; `tts` (optional) is the spelling the voice model reads. |
| `src/words.json` | `voice.py words` (or the main agent by hand, for voice `none`) | `{"l1": {"t": 0.6, "d": 3.2, "words": [{"w": "Pedals", "s": 0.0, "e": 0.41}]}}`: line start `t` and length `d` in film seconds, word times relative to the line start. Word `i` is the i-th space-separated word of the line's `text`. |
| `src/beats.json` | `music.py cut` | `{"bpm": 96, "beats": [...], "downbeats": [...]}` of the final music edit, film seconds. Absent: the grid comes from `music.synth.bpm`. |
| `src/storyboard.json` | the main agent | The SOURCE storyboard: scenes, elements, beats, camera, audio, all timed with cues. |
| `web/film/shots/<id>.js` | the main agent or build subagents, one writer per file | One custom canvas shot per file. |
| `web/film/storyboard.json` | `tools/resolve.mjs` | The RESOLVED storyboard (every cue turned into seconds). Never edit it by hand. |

After any change to `src/`, run:

```bash
node "$FILM/tools/resolve.mjs" --film "$FILM"            # writes web/film/storyboard.json, prints the plan
node "$FILM/tools/resolve.mjs" --film "$FILM" --strict   # before builds and reviews: warnings fail too
```

Errors (exit 1): bad shapes, unresolvable cues, unknown targets, missing shot files. Warnings:
a write-on ending less than 0.3 s before its scene's camera move, a beat outside its scene,
text under 28 px at zoom 1, reads shorter than 1.2 s each, overlapping pans, missing stickers,
config/meta mismatches, unknown fields. `--json` prints the plan (scenes, vo, moves, shots,
downgrades, warnings) for scripts.

## Units

- Reference frame: the short side is 1080 px (16:9 = 1920x1080, 9:16 = 1080x1920, 1:1 =
  1080x1080). Every size (`size`, `w`, `h`, `stroke_w`) is px of that frame at camera zoom 1.
- `pos`, `from`, `to`, `points`, `focus`: fractions (0..1) of the scene's box. The box is the
  whole frame on a `stage` layout, the panel on a `board`, the group's `w x h` inside a group.
- Colours: a palette key (`ground`, `board`, `paper`, `ink`, `pencil`, `accent`, `stain`,
  `tape`, ...), a swatch name from `config.palette.swatches` (defaults: teal, coral, gold,
  sage, rose, lilac, sky, cream, navy, white; a list palette in film.json adds c1, c2, ...),
  or any CSS colour.
- `meta.size`, `meta.fps` and `meta.duration` win over `web/film/config.json`;
  `scaffold.py sync-config` keeps both in line with film.json.

## Cues

Every `at` / `until` / camera key / sfx time is a cue:

| Cue | Means |
| --- | --- |
| `12.5` or `"12.5"` | absolute seconds |
| `"+0.8"` | 0.8 s after the previous cue in the same list (first beat of a scene: the scene start; a scene's `at`: the previous scene's `at`; a scene's `until`: its own `at`) |
| `"end"` | the film's end |
| `"vo:l3"` / `"vo:l3.end"` | line l3 starts / ends |
| `"vo:l3.w4"` / `"vo:l3.w4.end"` | word 4 of line l3 (0-based) starts / ends |
| `"beat:12"` / `"bar:3"` | beat 12 / downbeat 3 of the music grid (0-based) |
| `"scene:gears"` / `"scene:gears.end"` | a scene's start / end |

Any non-relative cue takes an offset: `"vo:l3.w4+0.2"`, `"end-1.5"`, `"bar:2-0.1"`.
Key picture beats to words and sound effects to the same cues, so re-timing a line moves
everything with it. Named cues in `cues` (top level or on an element) are readable from a
custom shot with `api.cue(name)`.

## Layouts

- `stage` (default): one full-frame scene at a time. A scene enters with `transition`: `cut`
  (default), `fade` or `slide` (`{"type": "slide", "dur": 0.5, "dir": "left"}`). `bg` sets the
  scene's background colour; `texture: false` drops the paper grain.
- `board`: a grid of panels with a camera that settles on each panel in scene order, pans to
  the next one around its start (quarter-shutter motion blur) and, unless `finale: false`,
  pulls back to the whole board at the end (zoom blur, ink arrows linking the panels).
  Parameters: `grid [cols, rows]`, `panel [w, h]`, `gutter [x, y]`, `caption`, `arrows`,
  `doodles`, `finale {at, dur}`, `whoosh`, `handheld` (0 = locked off). A scene may pick its
  `cell`; `panel.enter: "drop"` drops the panel in. A multi-panel scrapbook tour is the most
  copied look of this style: use a board only when the film's motif is a board (see
  `style-presets/collage.md`).
- Overlay scenes (`"overlay": true`) draw in screen space above the camera from `at` to
  `until` (`hold` keeps them; `dim` darkens the picture behind): title cards, lower thirds.
- Every scene except the first needs `at`. `until` defaults to the next scene's start.

## Elements

Common fields: `id` (unique; also the element's boil seed), `kind`, `pos` (default centre),
`scale`, `r` (degrees), `alpha`, `flip`, `boil` (stop-motion jitter; default 1, text and custom
0), `idle` (`true` or `{bob, sway, breathe, rate}`: gentle motion, de-synced per element),
`cues`, `notes`.

| kind | Required | Main fields |
| --- | --- | --- |
| `text` | `text` | `style` (below), `size`, `font` (`hand`, `print`, `ui` or a CSS stack), `weight`, `color`, `align`, `w` (wrap width), `lh`, `sub` (a fainter second line, e.g. the technical name in brackets), `sub_color`, `card` (torn paper card behind; `{color, pad, tail, shadow}`), `underline`, `cps` (write-on speed). `{n}` in the text is replaced by a count-up. |
| `sprite` | `src` | A sticker name from `web/img/manifest.json`; `w`, `shadow`. A missing sticker draws a visible placeholder and warns. |
| `shape` | `shape` | Paper cut-outs `rect ellipse circle triangle diamond star heart blob` (`w`, `h`, `color`, `outline`, `amp`, `rim`, `spikes`, `inner`); ink marks `arrow` (`from`, `to`, `bend`, `head`), `line` (`points`), `ring` (`turns`), `check`, `sparkle` (`twinkle`, `rate`); `tape`. Ink takes `stroke`, `stroke_w`, `dash`, `wob`. |
| `svg-path` | `d` | SVG path data drawn as ink (`stroke`, `stroke_w`, `fill`, `size` = width px or `unit`). Best with `draw-on`. |
| `chart` | `data` | `chart` (`bar` or `line`), `labels`, `max`, `colors`, `values`, `label_size`, `axis`, `bar_w`, `w`, `h`. Bars grow with `draw-on`. |
| `equation` | `tex` or `text` | Downgraded to text on the canvas engine (simple TeX symbols become Unicode). |
| `clip` | `src` | Downgraded to its `poster` sticker on the canvas engine. |
| `group` | `children` | Children positioned in the group's `w x h` box; beats on the group move them together. |
| `custom` | `shot` | Draws `web/film/shots/<shot>.js` in a `w x h` box (default 400x400) centred on `pos`; `params` and `cues` reach the shot. |

Text styles (every field can be overridden on the element):

| style | Look | Size (px at 1080p) | Write-on speed |
| --- | --- | --- | --- |
| `title` | ransom letters on torn scraps | 110 | 14 chars/s |
| `heading` | hand, bold, ink, accent underline after the write-on | 80 | 30 |
| `body` (default) | hand, bold, ink | 48 | 26 |
| `label` | print, pencil | 32 | 40 |
| `caption` | print, ink | 40 | 40 |

Anything the viewer must read is at least 28 px at 1080p and stays fully written for at
least 1.2 s. Never put a sentence of the narration on screen; label the thing, do not caption
it.

## Beats

A beat changes one element (`target`) at `at` for `dur` seconds (or `until`), with `ease`
(`linear in out inOut sine back elastic spring cubic`). Beats run on stop-motion time (15 fps).
An element whose first beat on a channel is an entrance (fade in, pop, slide in, type-on,
draw-on, scale from 0) stays hidden until that beat.

| do | Default dur | Fields |
| --- | --- | --- |
| `fade` | 0.4 | `from`, `to` (alpha; default 0 -> 1) |
| `pop` | 0.3 | overshoot entrance with a lift shadow; `k` (overshoot, 2.3), `spin` (12 deg) |
| `slide` | 0.45 | enter from `from [dx, dy]` px (default [-240, 0]); or exit to `to [dx, dy]` |
| `move` | 0.6 | `to [x, y]` fractions or `by [dx, dy]` px; `arc` px adds a hop with stretch in flight and a landing squash (`squash: false` turns it off) |
| `scale` | 0.35 | `from`, `to` (default to 1.2); without `ease` it springs with overshoot |
| `type-on` | chars / cps | handwriting write-on letter by letter; `cps` |
| `draw-on` | 0.5 | ink strokes, paths, shapes (outline first, then the paper fills), chart bars |
| `count-up` | 1.0 | `from`, `to` (required), `decimals`; replaces `{n}` in the text |
| `morph` | 0.5 | `to`: the id of the element it becomes (canvas: a crossfade) |
| `camera` | 1.2 | no target needed; frames `focus [x, y]` of the scene (or the `target` element's position) at zoom `z` (1.3), roll `r` |

## Camera

On a board the automatic path is usually right. To direct the camera by hand, give
`"camera": {"keys": [{"at": cue, "scene": id, "focus": [x, y], "z": 1.1, "r": 0, "ease": "sine", "cut": false, "zoomTo": false}]}`
(explicit keys replace the automatic path; `x`/`y` world px instead of `scene`). Camera beats
layer on top either way. Every move gets a whoosh unless `layout.whoosh` is false. Write-ons
must finish at least 0.3 s before a move or cut leaves their scene (resolve warns;
`qa.mjs text-check` fails TECH-12).

## Audio in the storyboard

The mix is built outside the picture from the resolved storyboard (same code live and offline):

- `vo`: optional. Omit it and every script line with a words.json entry is placed at its `t`,
  with `web/audio/vo_<id>.(mp3|wav|ogg|m4a)` when the file exists (else captions only). List it
  to override a line's `at`, `asset` or `gain_db`.
- `music`: `{"asset": "audio/music.mp3"}` (from `music.py cut`) or
  `{"synth": {"bpm": 92, "key": "C", "mode": "major", "progression": [0, 5, 3, 4]}}` (a $0
  pad, pulse and kick bed). Levels: `gain_db` (-12, the bed between lines), `duck_db` (-8 more
  under the voice), `intro_db` (+5 before the first line), `outro_db` (+6 after the last),
  `duck_under` (`vo` | `none`), `at`, `offset`, `end_at`. Gaps under 0.8 s stay ducked; longer
  gaps breathe. A missing file is silence, never an error.
- `sfx`: `[{"at": cue, "type": "pop", "gain": 1, "pan": 0, "dur": 0.4, "pitch": 0, "note": 0}]`.
  Types: pop tap thud stamp rustle scribble whoosh swish twinkle sparkleburst ding chime tick
  click boing boink snooze whistle latch beep thunder buzz power-on ring rumble. Keep them
  sparse and quiet (gain 0.3-0.6): one sound per meaningful action, never a sound on every pop.
- `mix`: `{"master": 0.7, "vo_db": 0, "sfx_db": 0, "music_db": 0}`. Final loudness is set at
  export, not here.

## Custom shots

A shot is one file, `web/film/shots/<id>.js`, used by a `custom` element (`"shot": "<id>"`) or
a whole scene (`"custom": "<id>"`, drawn over the scene's elements in the scene box). The
file registers a pure function of time:

```js
// Shot "chainring": the chain wraps a large front ring and a small rear cog; one turn of the
// pedals turns the rear wheel several times. Drawn in the element's box, origin at its centre.
FILM.shot('chainring', function (ctx, t, api) {
  const { D, ACT, box } = api;
  const turn = api.cue('turn');                        // from the element's "cues" map
  const u = api.U.seg(api.ts, turn, turn + 2.0);       // 0..1 over two seconds, stop-motion time
  const front = u * Math.PI * 2, rear = front * (42 / 14);
  const gear = (x, r, a, color) => {
    ctx.save(); ctx.translate(x, 0); ctx.rotate(a);
    D.paperShape(ctx, 'star', r * 2, r * 2, color, api.seed % 1000, { spikes: Math.round(r / 6), inner: 0.86 });
    ctx.restore();
  };
  gear(-box.w * 0.25, 150, front, 'teal');
  gear(box.w * 0.28, 50, rear, 'coral');
  D.ink(ctx, [[-box.w * 0.25, -150], [box.w * 0.28, -50]], { w: 6, t, seed: 3 });
  D.ink(ctx, [[-box.w * 0.25, 150], [box.w * 0.28, 50]], { w: 6, t, seed: 4 });
  api.text(ctx, '1 turn', -box.w * 0.25, 230, { size: 40, font: 'print', weight: 400 });
  api.text(ctx, '3 turns', box.w * 0.28, 230, { size: 40, font: 'print', weight: 400, seed: 9 });
});
```

`api` gives: `D` (drawing), `ACT` (acting kit, `acting-kit.md`), `E` (easing), `U` (the
`FILM` namespace: `seg`, `lerp`, `clamp`, `rnd`, `srnd`, `noise`, `step`, `deg`), `t` (film
time), `ts` (stop-motion time, 15 fps), `step`, `id`, `seed` (stable per element), `el`,
`params`, `state` (the element's beat state: `alpha`, `p`, ...), `box {w, h}`,
`scene {id, at, until}`, `cue(name)` (element cues, then top-level cues, then any cue string
such as `"vo:l2.w3"`), `color`, `palette`, `text(ctx, str, x, y, o)` (logged for the text
checks).

Rules for shot code:

- A frame is a pure function of `t`: never `Math.random`, `Date`, `performance.now`, counters
  or anything kept from a previous frame. Use `api.U.rnd(key, ...)` for stable randomness.
  `render.mjs purity` catches violations.
- Animate acting on `api.ts` for the stop-motion feel; use raw `t` only for smooth motion.
- JavaScript source is ASCII-only: write the escape `\u00b7` for a middle dot (`qa.mjs ascii`, TECH-13).
- Draw all text through `api.text` or `D.text` so it reaches the size, dwell and repeat
  checks.
- Keep one shot per file so parallel builders never edit the same file.

Drawing helpers most shots need (`D.*`, all in reference px): `text(ctx, str, x, y, {size,
font, weight, c, align, p, t, seed, r, lh, id})` (write-on via `p`), `textWidth`, `wrap(ctx,
str, maxW, size, font, weight)`, `sticker(ctx, name, x, y, {w, r, a, lift, sx, sy, shadow})`,
`aspect(name)`, `paperShape(ctx, kind, w, h, color, seed, {lift, shadow, rim, amp, spikes,
inner})`, `card(ctx, w, h, {bg, seed, tail, shadow})`, `tape(ctx, x, y, w, r, seed, h)`,
`ink(ctx, pts, {w, c, p, seed, t, wob, dash, sharp})`, `arrow(ctx, pts, {..., head})`,
`arcPts(x0, y0, x1, y1, bend, n)`, `circlePts(cx, cy, rx, ry, seed, turns)`, `check`,
`sparkle`, `sparkleAt`, `heart`, `glow`, `ransom(ctx, str, x, y, {size, seed, t, t0, dt})`,
`color(name)`, `alpha(color, a)`, `sh(a)` (paper shadow colour).

## A complete small storyboard

A 12-second stage film about bicycle gears: two scenes, a heading, a label with its technical
name, a custom shot keyed to words, sound on the same cues.

```json
{
  "version": 1,
  "meta": { "duration": 12, "fps": 30, "size": [1920, 1080], "seed": 3, "title": "Why Gears Help" },
  "layout": { "type": "stage" },
  "music": { "synth": { "bpm": 90, "key": "G", "mode": "major" }, "gain_db": -12 },
  "scenes": [
    {
      "id": "hill",
      "reads": ["a steep hill", "every push is heavy"],
      "elements": [
        { "id": "h1", "kind": "text", "style": "heading", "text": "a steep hill", "pos": [0.08, 0.14], "align": "left" },
        { "id": "slope", "kind": "shape", "shape": "line", "points": [[0.1, 0.85], [0.9, 0.35]], "stroke_w": 8 },
        { "id": "heavy", "kind": "text", "style": "label", "text": "heavy", "size": 44, "pos": [0.62, 0.78] }
      ],
      "beats": [
        { "at": 0.3, "target": "h1", "do": "type-on" },
        { "at": "vo:l1.w2", "target": "slope", "do": "draw-on", "dur": 0.6 },
        { "at": "vo:l1.w7", "target": "heavy", "do": "pop" }
      ]
    },
    {
      "id": "gears",
      "at": "vo:l2-0.3",
      "transition": "fade",
      "reads": ["big ring front, small cog back", "one turn in, three turns out"],
      "elements": [
        { "id": "rings", "kind": "custom", "shot": "chainring", "pos": [0.5, 0.55], "w": 1300, "h": 620,
          "cues": { "turn": "vo:l2.w5" } },
        { "id": "name", "kind": "text", "style": "caption", "text": "gear ratio", "sub": "(42 teeth : 14 teeth)",
          "pos": [0.5, 0.1] }
      ],
      "beats": [
        { "at": "+0.3", "target": "rings", "do": "fade", "dur": 0.3 },
        { "at": "vo:l2.w9", "target": "name", "do": "type-on" }
      ]
    }
  ],
  "sfx": [
    { "at": 0.3, "type": "scribble", "dur": 0.4, "gain": 0.4 },
    { "at": "vo:l1.w2", "type": "scribble", "dur": 0.6, "gain": 0.35 },
    { "at": "vo:l1.w7", "type": "thud", "gain": 0.4 },
    { "at": "vo:l2.w5", "type": "tick", "gain": 0.4 }
  ]
}
```

With `src/script.json` lines `l1` ("On a steep hill the pedals feel heavy.") and `l2` ("Shift
down and each push turns a small cog three times.") and their `src/words.json` timings, this
resolves cleanly; `chainring.js` is the shot above. Word indexes count the displayed words:
`vo:l1.w7` is "heavy.", `vo:l2.w5` is "turns".
