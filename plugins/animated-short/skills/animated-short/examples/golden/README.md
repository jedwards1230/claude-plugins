# Golden example: "Shapes Take Turns"

A 10-second conformance film for the canvas engine. It is neutral on purpose (three paper
shapes take turns hopping), uses only code-drawn art and synthesized sound, and costs $0: no
network, no image or audio files, no provider calls. Two narration lines have hand-written
word timings but no audio, so they appear as captions only.

Copy it over a fresh engine and it is a runnable film directory.

## What it exercises

| Feature | Where |
| --- | --- |
| `board` layout, 2x1 grid, board caption, gutter doodles | `layout` in `src/storyboard.json` |
| Camera auto-path: sine pan between panels (3.63-4.98 s) with quarter-shutter motion blur | scene `turns` starts at 4.6 s |
| Finale pull-back to the whole board with zoom blur and linking arrows (7.8-9.4 s) | `layout.finale.at = "vo:l2.end+0.2"` |
| Panel drop-in entrance | scene `stage`, `panel.enter = "drop"` |
| `type-on` (heading, label), heading underline after the write-on | `h1`, `label1`, `h2` |
| `draw-on` of an SVG path with a cubic curve and an arc, a floor line and a check mark | `loop`, `floor`, `tick` |
| `pop` entrances staggered with relative cues (`"+0.15"`) | `circle`, `square`, `triangle` |
| `count-up` in three steps, text with a paper card | `count` ("turns taken: {n}") |
| Per-element boil and de-synced idle motion (siblings never move as twins) | shapes with `"idle": true` |
| Custom shot using the acting kit: anticipation, leap (stretch and squash), `takes` (the face swaps at maximum squash), seeded blinks, per-character boil, gaze | `web/film/shots/turns.js` |
| Cue forms: absolute, `+s`, `vo:<line>.w<i>`, `vo:<line>.end+s`, `beat:<n>`, `bar:<n>`, `scene:<id>+s`, `end-s` | beats and `sfx` |
| Synthesized music bed (pad, pulse, kick) with a beat grid derived from its bpm, ducking under the (silent) voice lines, a tonic resolve after the last line | `music.synth` |
| Synthesized sound effects plus automatic whooshes on camera moves | `sfx`, `layout.whoosh` (default on) |
| Captions in the live player from the voice lines | `src/script.json`, `src/words.json` |

`web/film/storyboard.json` is the resolved output of `tools/resolve.mjs` for this source,
shipped so the overlay runs as-is; running resolve again must reproduce it. `film.json` holds
the inputs (budget 0, no voice, synthesized music, code-drawn art, no end card), so the Python
tools treat the example like any other film.

## Run it

Needs Node 18+, a Chromium (`npx playwright install chromium` if `tools/render.mjs` cannot
find one) and Python 3.10+. ffmpeg is optional. `SKILL` is the skill directory
(`${CLAUDE_SKILL_DIR}`, the same as `${CLAUDE_PLUGIN_ROOT}/skills/animated-short`); `FILM` is an
absolute path that does not exist yet.

The one-command conformance run (builds a fresh film, runs every check below, prints a
PASS/FAIL table, costs $0; `--no-ffmpeg` repeats it with the in-browser WebCodecs export):

```bash
bash "$SKILL/scripts/test-golden.sh" --scaffold-py --out /tmp/golden-test
```

Step by step:

```bash
python3 "$SKILL/scripts/scaffold.py" new "$FILM" --from-example golden
npm install --prefix "$FILM"
node "$FILM/tools/resolve.mjs" --film "$FILM" --strict             # web/film/storyboard.json + the plan
node "$FILM/tools/render.mjs" glyph --film "$FILM"                  # every font advances every letter
node "$FILM/tools/render.mjs" stills 0.5,2,5,8,9.5 --film "$FILM"   # -> work/qa/stills/
node "$FILM/tools/render.mjs" text 5 --film "$FILM"                 # JSON: texts at 5 s with px1080 and bbox
node "$FILM/tools/render.mjs" purity --film "$FILM"                 # same hash in order and shuffled
node "$FILM/tools/qa.mjs" text-check --film "$FILM"                 # size, dwell, repeats, late write-ons
node "$FILM/tools/qa.mjs" contact --film "$FILM"                    # -> work/qa/contact.jpg
node "$FILM/tools/export.mjs" --film "$FILM"                        # -> out/: MP4s, captions, transcript, page/
node "$FILM/tools/qa.mjs" check --film "$FILM"                      # technical gate; exit 0 = ship
```

To watch it live: `node "$FILM/tools/render.mjs" serve --film "$FILM"` and open the printed
URL (the page needs HTTP; it does not work from `file://`).

## What to expect

- `resolve.mjs` reports two camera moves (3.63-4.98 s pan, 7.80-9.40 s finale) and no warnings.
- Stills: 0.5 s heading writing on; 2 s three shapes on the first panel; 5 s the camera has
  arrived on the second panel; 8 s start of the pull-back; 9.5 s the whole board with its
  caption and the arrow between the panels.
- 300 frames at 30 fps; the offline mix peaks around -5 dBFS before loudness normalization.
- `export.mjs` with ffmpeg: `out/shapes-take-turns.mp4` (1920x1080), `-share.mp4` (1920x1080,
  a smaller file) and `-phone.mp4` (1280x720), each about -14.6 LUFS with true peak at or below
  -1.3 dBTP, plus `.srt`, `.vtt`, `transcript.md`, `page/` (its static `<title>` is "Shapes Take
  Turns") and `export.json`; with `--host artifact` also `page-artifact/`, the same 10 files with
  `index.html` as a fragment. `qa.mjs check` prints verdict ship.
