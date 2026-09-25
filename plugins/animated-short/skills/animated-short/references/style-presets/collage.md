# Style preset: collage

Cut paper on a work surface: torn edges, tape, grain, ink lines that boil, handwriting that
writes itself on, die-cut stickers that lift off the page. It is the only preset today, and
it has a problem: paper collage with image-model stickers, a Gemini narrator and a Lyria bed is
now the default look of agent-made explainers. Viewers can "pick out the next one blind". Use
the preset for its craft, then make every film its own: its own motif, palette, cast, texture
emphasis and a banned-pattern list, checked by the originality gate.

`$SKILL` is the skill's base directory and `$FILM` the film directory (see SKILL.md).

## Craft rules

- Paper: every surface is a paper piece with a torn rim and a soft offset shadow
  (`D.paperShape`, `D.card`, board panels). Grain is static; never animate a full-frame
  texture (it multiplies the file size and reads as noise).
- Torn edges: amplitude about 2% of the piece's short side (`amp`); keep rims light.
- Tape: a few strips where something is held down, not on every corner.
- Stop-motion: element animation steps at 15 fps; drawn things boil (about 1.3 px, 7.5 changes
  a second), text does not. Camera moves stay smooth (raw time) with a quarter-frame motion
  blur; zooms get their own zoom blur.
- Ink: lines wobble slightly (`wob`) and draw on along their length (`draw-on`). Arrows point
  at mechanisms, not at decorations.
- Handwriting: `heading` and `body` styles write on letter by letter; the engine measures
  letters with ligatures broken, so "fi" and "fl" never swallow a letter. Ship a real
  handwriting webfont (below) for a consistent hand across machines.
- Ransom letters (`title` style): one title per film at most. They are the most recognisable
  mark of the viral look.
- Stickers: generated on flat grey, cut out with soft alpha, composed and animated in code.
  Stickers act (see `acting-kit.md`); a sticker that pops in and freezes is a defect (CHAR-1).
- Type hierarchy: plain words first; a technical name, when the jargon policy allows it, goes
  faint and bracketed underneath (`sub`). Nothing under 28 px at 1080p.
- Colour: 4-6 colours plus paper and ink. Give the film a palette arc (for example cool and
  sparse at the start, warm and full at the payoff) instead of one flat palette throughout.

## Fonts

No webfont ships with the engine; renders fall back to system fonts, which differ between
machines (generic `cursive` maps oddly on Linux). For a handwritten look, add an OFL (SIL Open
Font License) or similarly licensed `.woff2` to `$FILM/web/fonts/` and declare it in
film.json:

```json
"style": {
  "fonts": {
    "hand": "My Hand",
    "body": "My Print",
    "faces": [
      { "family": "My Hand", "src": "fonts/my-hand.woff2", "weight": "400 700" },
      { "family": "My Print", "src": "fonts/my-print.woff2", "weight": 400 }
    ]
  }
}
```

Then `python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"` and
`node "$FILM/tools/render.mjs" glyph --film "$FILM"` (every letter must advance). Fonts load
from the film's own files; renders never fetch fonts from the network. Credit the font in
film.json `credits`.

## Sticker sheets

`art.py sheet` builds the prompt from three parts; only the item list comes from you.

1. Style block (automatic, from film.json): `STYLE: collage illustration, <style.texture>;
   hand-made, cut-paper look, confident slightly wobbly ink outlines; tone: <tone>.` plus
   `Limited palette: ...` (when `style.palette` is a list), `Recurring motif: ...` and
   `Avoid: <banned patterns>`. Pass `--no-style` when the prompt file carries the whole style.
2. Format block (automatic): each item a separate die-cut sticker with a thick, clean, solid
   WHITE border; a loose grid with lots of space; stickers never touch; ONE flat uniform grey
   `#8C8C8C` background with no texture, gradient, vignette, shadows, text, letters, numbers,
   logos, watermarks or frames; front-facing, flat even lighting.
3. `STICKERS ON THIS SHEET (draw each exactly once):` followed by your prompt file, then the
   reference wording when you pass `--refs` (match the reference sheet's style, line quality,
   palette and borders exactly, but draw only the new items) or `--likeness` (take only
   colours and markings from the photos).

Prompt-file template (6-10 stickers per sheet; one line each, `name: description`):

```text
chainring: a large bicycle chainring, 42 teeth, brushed steel with one teal paint chip
cog_small: a small rear cog, 14 teeth, same steel and line weight as the chainring
chain_loop: a short loop of bicycle chain, links clearly separated
pedal: a single flat pedal seen from above, worn grip pins
rider_calm: a rider in a mustard jacket, side view facing right, calm, both hands on the bars
rider_strain: the same rider, leaning forward, cheeks puffed, pushing hard
hill_sign: a triangular steep-hill road sign, blank of any text
water_bottle: a dented teal water bottle
```

Sheet rules:

- 6-10 stickers per sheet, grouped by scene or by character, never mixed styles.
- The first final sheet (usually the main character's model sheet) is the style reference:
  pass it with `--refs` to every later sheet so line weight, texture and palette stay
  consistent. The image model is pinned per tier after the first sheet (sticky).
- Real subjects: one crop per subject with `--likeness` (the tool adds "colours and markings
  only"); never pass a whole photo with several subjects, or the photo bleeds into the sheet.
- Real things stay real: logos, screenshots and product photos go into `web/img/` as they are
  (convert to WebP, add to `web/img/manifest.json`), never regenerated.
- No text in stickers: the engine draws every word (readable, checkable, translatable).
- Draft sheets (`--draft`, 1K) for the animatic use the same prompt files with a different
  `--name` (for example `cast-draft`) so the final cutouts replace them name for name.
- After every cutout, read `work/qa/cutout-<sheet>.jpg` and `art.py contact`: a missing border,
  a merged pair or a sticker with a grey halo is fixed with `--variant 1` (a fresh try) or
  `--min-area` / `--allow-extra`, not ignored.

Emotion and pose sheet prompts: `acting-kit.md` section 1.

## Default banned patterns

Copy these into film.json `style.banned_patterns` at creative direction, then add the film's
own. Each describes the viral default look; the originality reviewer reports any it sees.

- ransom-note letters on every title or card
- a paper-rip or page-tear transition between every scene
- tape on every corner of every panel
- a 3x3 scrapbook-board tour with a zoom-out finale as the film's whole structure
- the same warm, twee narrator voice with a breathy smile on every line
- a ukulele and glockenspiel bed
- stickers that pop in with a bounce and then sit still without acting
- on-screen text that repeats the narration
- every scene starting with a handwritten heading that writes itself on
- sparkles or doodled stars on every beat
- a sticker sheet look with no motif: generic objects in a row with no visual idea linking them
- a corporate-training palette of mustard, coral, teal and navy with no palette arc

## Originality check

Run it twice: on the concept and style bible at creative direction (text only, a fresh Claude
subagent, $0), and on the first full cut in film review (the `originality` reviewer through
`review.py run`, prompt in `review-prompts.md`).

Procedure at creative direction:

1. Write `work/direction/concept.md` (logline, central motif and how it escalates and pays
   off, echo ending, three reference images described in words) and
   `work/direction/style-bible.md` (palette with its arc, textures, type, cast, camera
   grammar, sound palette, banned patterns).
2. Spawn a fresh subagent with the originality prompt from `review-prompts.md` and both files.
   It answers: could this be mistaken for another film, which banned patterns or default
   choices are present, and three concrete changes that would make it unmistakably this film.
3. Gate: originality score >= 7 (film.json `review.originality_min`) and no banned pattern
   planned. Otherwise change the motif, palette, cast or structure and run it again.
