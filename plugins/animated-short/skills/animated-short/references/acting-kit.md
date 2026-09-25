# Acting kit: characters that act instead of snap

Critics forgive simple drawings; they do not forgive stickers that pop in and sit still.
Acting means a character anticipates before it moves, stretches and squashes while it moves,
overshoots and settles when it stops, blinks on its own schedule, and changes expression
through a small "take" rather than a hard swap. The kit has two halves: sheets from the image
model (poses and expressions of one design) and pure-time helpers in
`engine/web/js/acting.js` that the storyboard and custom shots use.

`$SKILL` is the skill's base directory and `$FILM` the film directory (see SKILL.md).

## 1. Character, emotion and pose sheets

Write each recurring character into the style bible first (`work/direction/style-bible.md`):
silhouette, proportions, two or three fixed colours, one distinguishing prop, how it moves.
Then generate its sheets with `art.py sheet`, which adds the style block, the flat-grey sticker
format and the reference wording itself; the prompt file only lists the stickers, one per line
(see `style-presets/collage.md` for the full sheet template).

Model sheet (make it first, final tier; every later sheet passes it as `--refs`):

```text
work/sheets/robin-model.txt
robin_front: the character front view, neutral, arms relaxed
robin_side: the same character in side view facing right, neutral
robin_back: the same character from behind
robin_walk_a: side view facing right, mid-stride, left foot forward
robin_walk_b: side view facing right, mid-stride, right foot forward
robin_point: side view facing right, one arm pointing forward
```

Emotion sheet (same pose, only the face and body language change; this is what `take()` swaps
between):

```text
work/sheets/robin-emotions.txt
robin_calm: front view, relaxed, soft smile
robin_glad: front view, wide open smile, eyebrows up, shoulders lifted
robin_surprised: front view, eyes wide, mouth a small round O, leaning back slightly
robin_worried: front view, eyebrows tilted up in the middle, mouth a flat wavy line, hands together
robin_thinking: front view, eyes looking up and to one side, one hand at the chin
robin_sleepy: front view, eyelids half closed, head tilted, small yawn
robin_proud: front view, chin up, eyes closed, hands on hips
robin_blink: front view, relaxed, both eyes closed (used for blinks)
```

Commands (the model sheet is the style reference for everything after it; `[P]` is the key
file option from `phases.md`; use the sheet paths `art.py sheet` prints):

```bash
python3 "$SKILL/scripts/art.py" sheet --film "$FILM" [P] --name robin-model --prompt-file "$FILM/work/sheets/robin-model.txt"
python3 "$SKILL/scripts/art.py" cutout --film "$FILM" "$FILM/work/sheets/robin-model_0.png" --names robin_front,robin_side,robin_back,robin_walk_a,robin_walk_b,robin_point
python3 "$SKILL/scripts/art.py" sheet --film "$FILM" [P] --name robin-emotions --prompt-file "$FILM/work/sheets/robin-emotions.txt" --refs "$FILM/work/sheets/robin-model_0.png"
python3 "$SKILL/scripts/art.py" cutout --film "$FILM" "$FILM/work/sheets/robin-emotions_0.png" --names robin_calm,robin_glad,robin_surprised,robin_worried,robin_thinking,robin_sleepy,robin_proud,robin_blink
python3 "$SKILL/scripts/art.py" contact --film "$FILM"          # check every sticker before using it
```

Cutout names stickers in row-major order (left to right, top to bottom): read the sheet image
first and list the names in the order the stickers actually landed. For real people or pets
(with consent in film.json `subjects`), pass one photo crop per subject with
`--likeness crop.jpg`; the tool adds "take only colours and markings".

Code-drawn characters (art mode `code`) need no sheets: `ACT.face` draws five expressions
(`calm`, `glad`, `surprised`, `worried`, `sleepy`) on any paper shape.

## 2. Storyboard-level acting (no code)

- `pop` entrances overshoot (`k`, default 2.3) with a lift shadow; `spin` adds a turn.
- `move` with `arc` (px) hops: stretch in flight, squash on landing, settle.
- `scale` without `ease` springs with overshoot.
- `idle: true` (or `{bob, sway, breathe, rate}`) gives a resting element gentle life; phases
  are de-synced per element id, so siblings never bob in unison.
- `boil` (default 1 for drawn elements) is per-element stop-motion jitter seeded by the id.

These cover props. Anything with a face, or any action that must read as intent, belongs in
a custom shot with the helpers below.

## 3. Helpers (`api.ACT` in a shot, `FILM.ACT` elsewhere)

All are pure functions of time. Pass `api.ts` (stop-motion time, 15 fps) for the hand-made
feel or `t` for smooth motion. Distances are px of the 1080-line frame; angles are degrees.

| Signature | Returns | Use |
| --- | --- | --- |
| `seed(id, base = 0)` | integer | stable seed for an element id |
| `anticip(t, t0, {lead = 0.18})` | 0 .. -1 .. 0 | wind-up before an action at `t0`; multiply by a pull-back distance opposite the action |
| `squash(k)` | `{sx, sy}`, `sx * sy = 1` | k > 0 squashes (wider, shorter), k < 0 stretches; volume-preserving |
| `settle(dt, {freq = 2.2, damp = 7})` | 0 -> 1 with ~20% overshoot | damped spring; `dt` = seconds since the start |
| `spring(t, t0, from, to, o)` | value | `from -> to` from `t0` with an overshoot settle |
| `blink(t, seed, {every = 3.4, dur = 0.2})` | lid closure 0..1 | seeded, irregular: one blink per slot, a fifth of them doubled |
| `blinkTimes(seed, t0, t1, o)` | `[t...]` | the scheduled blink starts (for tests or a blink sound) |
| `take(t, t0, {from, to, amt = 0.14, lead = 0.12, settle})` | `{pose, sx, sy, k}` | expression swap at `t0`: squash during `lead`, swap at maximum squash, spring back through a small stretch |
| `takes(t, [{pose}, {at, pose}, ...], o)` | as `take` | a sequence of takes; the first entry is the resting pose |
| `boil(id, t, amt = 1)` | `[dx, dy, dr]` | per-element jitter, 7.5 changes a second (about 1.3 px, 0.35 deg at amt 1) |
| `desync(id, i)` | `{phase, amp, rate}` | offsets that stop siblings moving as mirrored twins |
| `wave(t, id, freq = 0.5, amp = 1, i = 0)` | number | a de-synced sine for idle motion |
| `idle(t, id, {bob = 4, sway = 1.5, breathe = 0.015, rate = 1})` | `{dx, dy, r, sx, sy}` | resting life |
| `hop(a, b, u, h)` | `[x, y]` | point on a hop from `a` to `b` at progress `u`, arc height `h` |
| `leap(t, t0, dur, {h = 80, amt = 0.18, lead = 0.14})` | `{y, sx, sy}` | jump in place: anticipation squash, stretch in the air, landing squash that settles |
| `face(ctx, x, y, s, {pose, blink, look, c, t, seed})` | draws | ink face for code-drawn characters; `pose` calm, glad, surprised, worried, sleepy; `look [-1..1, -1..1]` |

Rules:

- Every major action gets anticipation (`anticip`, or the lead-in of `take` and `leap`).
- An expression never snaps: swap stickers or `face` poses only through `take` / `takes`.
- Squash and stretch pivot on the contact point (translate to the feet, scale, translate
  back), so a landing character stays planted.
- Give every character its own id for `boil`, `blink` seeds and `idle`; never share a seed
  between two characters, or they will blink and bob as twins.
- Blinks: 2-4 s apart and irregular (the default). A character that never blinks reads as
  a prop.
- Siblings: offset with `desync(id, i)` or distinct ids; stagger entrances (`"+0.15"` cues).
- Gaze leads action: turn the eyes (`look`) toward what happens next 0.2-0.3 s before it does.

## 4. Example: a sticker character that reacts

A sticker character idles, winds up, hops when its word is spoken, and changes from calm to
glad at the deepest landing squash. The expression stickers come from the emotion sheet above.

```js
// Shot "robin-cheer": Robin idles on the ground, hops on the cue "cheer" and turns glad at
// the landing; blinks on her own seed. Drawn in the element's box, origin at its centre.
FILM.shot('robin-cheer', function (ctx, t, api) {
  const { D, ACT, box } = api;
  const ts = api.ts, cheer = api.cue('cheer');
  const floor = box.h * 0.42, w = 320, h = w * D.aspect('robin_calm');
  const idle = ACT.idle(ts, api.id, { bob: 3, sway: 1, breathe: 0.02 });
  const hop = ACT.leap(ts, cheer, 0.5, { h: 110, amt: 0.16 });
  const face = ACT.takes(ts, [{ pose: 'calm' }, { at: cheer + 0.5, pose: 'glad' }], { amt: 0.1 });
  const [bx, by, br] = ACT.boil(api.id, t);
  const lid = ACT.blink(ts, api.seed);
  const name = lid > 0.6 && face.pose === 'calm' ? 'robin_blink' : 'robin_' + face.pose;
  ctx.save();
  ctx.translate(bx, floor + by + hop.y);                 // pivot on the feet
  ctx.rotate(api.U.deg(idle.r + br));
  ctx.scale(hop.sx * face.sx * idle.sx, hop.sy * face.sy * idle.sy);
  D.sticker(ctx, name, 0, -h / 2, { w, lift: Math.min(1, -hop.y / 110) });
  ctx.restore();
});
```

Storyboard element: `{"id": "robin", "kind": "custom", "shot": "robin-cheer", "pos": [0.3, 0.6],
"w": 500, "h": 600, "cues": {"cheer": "vo:l4.w2"}}`.

Check acting in `node "$FILM/tools/qa.mjs" strip <t> --film "$FILM" --span 0.8 --n 12` around
each take: the strip must show the wind-up, the stretch, the squash and the settle, with the
expression changing inside the squash.
