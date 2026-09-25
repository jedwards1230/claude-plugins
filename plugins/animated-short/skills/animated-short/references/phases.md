# Phases: from request to delivered film

Work through the phases in order. Each lists its inputs, the exact commands, what it produces,
its gate, and what to do when the gate fails. Conventions:

- `$SKILL` is the skill's base directory (SKILL.md gives the absolute path) and `$FILM` the
  film directory, as an absolute path. Shell variables do not survive between tool calls:
  write both out in every command.
- `python3` is a Python 3.10+ with `$SKILL/scripts/requirements.txt` installed.
- `[P]` stands for the provider options: `--key-file <path>` (omit it when
  `OPENROUTER_API_KEY` is set in the environment) and `--account-ceiling <usd>` (optional).
  Never print or echo the key.
- `<slug>` is the output file stem (the title in lower case, words joined by hyphens); read it
  from `out/export.json` (`"slug"`), or `work/animatic/export.json` for the animatic.
- Time lists are comma-separated without spaces (`stills 1.5,4,9.2`); `qa.mjs strip` and `crop`
  take one time per call (repeat the command per moment).
- A $0 film (`budget_usd` 0) skips everything that needs the key: preflight tier 1,
  `ledger.py reconcile`, `critic.py ask`, `review.py run` and the sign-off pass. Its judging
  and reviews are fresh Claude subagents (`review-prompts.md`), stored with `review.py ingest`.
- Every Python tool exits 0 ok, 1 gate or validation failure, 2 usage or environment error,
  3 budget refusal, 4 provider unavailable. On exit 3 stop spending: quote, cut scope, or ask
  the user. On exit 4 with a sticky failure, stop and report; do not switch voice or art model.
- Under `autonomy: approve_each_phase`, end every phase with a short summary and one
  AskUserQuestion (continue / change something); under `approve_animatic`, only phase 7.

| # | Phase | Main artifacts | Gate |
| --- | --- | --- | --- |
| 1 | Preflight | `work/preflight.json` | every needed role has a provider; a delivery mode exists; glyph test ok |
| 2 | Intake | `film.json`, scaffolded film, quote | required inputs set; quote fits the budget |
| 3 | Research | `work/research/claims.json`, `notes.md` | every planned fact sourced; hard truths decided |
| 4 | Creative direction | `work/direction/{concept,style-bible,intent-notes}.md`, film.json `style` | originality >= 7, no banned pattern planned |
| 5 | Script and reads | `src/script.json`, `work/direction/quiz.json`, `work/reviews/r0/` | persona script gate |
| 6 | Voice first | `web/audio/vo_*`, `src/words.json` | a verified clean take per line; narration fits |
| 7 | Animatic | `work/animatic/`, draft art | critic GO (and user approval if autonomy asks) |
| 8 | Assets | `web/img/`, `web/audio/music.*`, `src/beats.json`, `sfx` list | clean cutouts; music ends after the last word |
| 9 | Build | `src/storyboard.json`, `web/film/shots/*.js` | resolve --strict, purity, ascii, glyph clean |
| 10 | Frame QA | `work/qa/*`, frame_qa review | no text, read or polish defect left |
| 11 | Film review | `work/reviews/r1..r4/`, `gates.json` | every ship gate, then the sign-off director |
| 12 | Deliver | `out/`, `out/report.md` | technical check ships; report written |

## 1. Preflight

Inputs: the machine; the key (if any).

```bash
python3 -m pip install -r "$SKILL/scripts/requirements.txt"
python3 "$SKILL/scripts/preflight.py" --film "$FILM" [P]
```

If pip refuses to install into the system Python (an "externally managed" error), create a
virtual environment outside the film directory and use its `python` for every command.
Before the film exists, preflight judges the providers with default inputs and skips the
Chromium check; it runs again in full after scaffolding (phase 2).

Gate: Node 18+ and npm present; the key works (GET /key) unless the film will cost $0; each
role has a candidate. ffmpeg is optional (MP4s then come from the in-browser encoder).

On failure: no key or no credit -> offer the $0 film at intake (budget 0, voice `none` or
captions only, music `synth`, art `code`, reviews by Claude subagents). Missing Python
packages -> install them. Everything else is reported in the preflight output with its fix.

## 2. Intake

Inputs: the user's request, the preflight result.

1. Run the intake questions from SKILL.md (skip when the user gave a film.json with topic,
   goal and message). Offer only options preflight says work.
2. Write the answers as a film.json (fields and defaults: `inputs.md`) to a file outside the
   film directory, then scaffold and install:

```bash
python3 "$SKILL/scripts/scaffold.py" new "$FILM" --film-json <answers.json>
npm install --prefix "$FILM"
python3 "$SKILL/scripts/preflight.py" --film "$FILM" [P]
python3 "$SKILL/scripts/preflight.py" --film "$FILM" [P] --tier 1      # when budget_usd > 0 (a few cents)
python3 "$SKILL/scripts/quote.py" --film "$FILM"
```

Artifacts: the film directory (`film.json`, `web/`, `tools/`, `src/` starters, `work/`,
`out/`, `cache/`, `.gitignore`), `work/preflight.json`, `work/quote.json`.

Gate: preflight exit 0; the quote fits `budget_usd` (quote exit 0).

On failure: a role with no working provider -> change the film (voice `none`, music `synth`,
art `code`) or pick another registry candidate in `providers.roles`; Chromium missing ->
`npx playwright install chromium` (or `--chromium <path>` on node tools); quote too high ->
fewer sheets (`art.sheets`), fewer music candidates, fewer takes, fewer personas, or ask the
user for more budget. After any film.json edit: `python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"`.

## 3. Research (skip for fiction: `sources: [{"kind": "none"}]`)

Inputs: film.json `topic`, `goal`, `audience`, `depth`, `sources`, `offscreen`, `subjects`.

Spawn one or more research subagents with read-only access to the sources (web, the docs or
repositories the user named, read-only queries of live systems). Brief them with the goal,
what each persona already knows, the depth (`lived-in`: follow one concrete thing through,
with its real routines, numbers and moments), the offscreen list, and the rule: every fact
with its source and date; never invent numbers; never characterise real people or pets.

They write `$FILM/work/research/claims.json`:

```json
{
  "claims": [
    {
      "id": "c1",
      "fact": "A typical dough doubles in 60-90 minutes at 24-27 C.",
      "source": "https://example.org/baking-science (read 2026-09-25)",
      "date": "2026-09-25",
      "local_time": null,
      "conflicts": ["another guide says 45-60 minutes; use 'about an hour'"],
      "sensitivity": "none",
      "status": "verified"
    }
  ]
}
```

`sensitivity`: `none`, `personal` (about a real person or pet), `hard_truth` (uncomfortable),
`offscreen` (must not appear). Convert every time to the viewer's local zone (with daylight
saving) in `local_time`. Also `work/research/notes.md`: the lived-in material ranked by how
new and concrete it is for each persona.

Hard truths: apply film.json `hard_truths`: `include` it plainly, `soften` it (true, calm,
without alarm), `omit` it (and list it in the report), or `ask`: collect every hard truth into
one AskUserQuestion round now (include / soften / omit per item).

Gate: every fact the film may use is in the ledger with a source; conflicts resolved to the
conservative wording; hard truths decided.

On failure: facts without a source are dropped or marked unsourced and kept off screen.

## 4. Creative direction

Inputs: research notes, film.json style fields, `style-presets/collage.md`, `acting-kit.md`.

Write:

- `work/direction/concept.md`: logline (one sentence); the central image or motif and how it
  escalates (three steps) and pays off; the ending that echoes the opening; the structure for
  the form (explainer: hook, question, mechanism in 3-5 beats, payoff, echo; story: premise,
  complication, turn, resolution; promo: problem, product in action, proof, call to action);
  the cultural references that fit (film.json `style.references_to_use`) and to avoid.
- `work/direction/style-bible.md`: palette with its arc, textures, fonts, layout (`stage` by
  default; a `board` only when the motif is a board), camera grammar, the cast with model and
  emotion sheet descriptions, sound palette (voice direction, music prompt, effect rules), and
  the banned patterns (the preset's defaults plus the film's own). Subagents are briefed from
  this file: make it specific enough that two builders would draw the same character.
- `work/direction/intent-notes.md` from the template in `review-prompts.md`.
- Copy palette, motif, texture, fonts and banned patterns into film.json `style`, then
  `python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"`.

Gate: the originality check (`style-presets/collage.md`, prompt in `review-prompts.md`, a fresh
Claude subagent, $0) scores >= 7 with no banned pattern planned.

On failure: change the motif, palette arc, cast or structure, not just the wording, and check
again.

## 5. Script, reads sheet and quiz

Inputs: concept, research ledger, personas.

1. Write `$FILM/src/script.json`: `{"lines": [{"id": "l1", "text": "...", "tts": "...", "reads": ["..."]}]}`.
   Short lines (one idea each, 5-20 words), ids `l1`, `l2`, ... Word budget: about 2.5 words
   per second of (duration - 0.6 s lead-in - the ending: 1.5 s, or the end card's seconds + 0.5 s).
   Put a respelling in `tts` only when the model misreads a word the caption must keep.
2. Reads sheet: each line's `reads` lists what the viewer must understand while it plays, in
   order, one at a time. Every read shows a mechanism (what moves, what causes what), not a
   picture of the noun. Plan on-screen text per read: a few words, never the narration
   sentence. The scenes' `reads` in the storyboard (phase 9) come from here.
3. Draft `work/direction/quiz.json` (format in `review-prompts.md`), at least 5 questions for
   explainers, each answered clearly by the script.
4. Persona script gate: one fresh subagent per persona with the `script_persona` template;
   store each result:

```bash
python3 "$SKILL/scripts/review.py" ingest --film "$FILM" --round 0 --file <review.json> --persona "<persona name>"
python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage voice
```

Gate: every persona's takeaway says the same thing as the message; explainers list at least
`review.learnings_min` concrete learnings; no blocking confusion; the quiz is answerable from
the script alone; the voice quote fits.

On failure: rewrite the script (usually: fewer topics, one concrete thing followed through,
the mechanism shown step by step) and run the gate again.

## 6. Voice first (audio drives timing)

Inputs: `src/script.json`, film.json `voice`, `pronunciations`.

Voice `none`: write `$FILM/src/words.json` by hand (`{"l1": {"t": 0.6, "d": 3.2}}`; add
`"words": [{"w", "s", "e"}]` only if you cue picture to words), then go to phase 7.

The prompt files passed to `critic.py ask` here and in phases 7-8 are the judging prompts in
`review-prompts.md` (voice audition, take picks, music pick, animatic), filled in and saved
under `$FILM/work/direction/`.

```bash
python3 "$SKILL/scripts/voice.py" audition --film "$FILM" [P] --line l1            # one take per voice
python3 "$SKILL/scripts/critic.py" ask --film "$FILM" [P] --prompt-file "$FILM/work/direction/audition.md" --audio "$FILM"/work/takes/audition/*.wav --name audition
```

Pick the voice (the critic's choice, checked by listening to its reasoning against the tone),
set film.json `voice.mode` to `named`, `voice.name` and `voice.style`, then:

```bash
python3 "$SKILL/scripts/voice.py" takes --film "$FILM" [P]                         # voice.takes per line; pins the voice
python3 "$SKILL/scripts/voice.py" check --film "$FILM" [P]                         # transcript check of every take
python3 "$SKILL/scripts/critic.py" ask --film "$FILM" [P] --prompt-file "$FILM/work/direction/takes.md" --audio "$FILM"/work/takes/l*_*.wav --name takes
python3 "$SKILL/scripts/voice.py" pick --film "$FILM" l1=2 l2=0 l3=1               # one pick per line
python3 "$SKILL/scripts/voice.py" process --film "$FILM"                           # trim, EQ, compress, -16 LUFS per line
python3 "$SKILL/scripts/voice.py" words --film "$FILM" [P]                         # add --tail 3 when the end card is on
python3 "$SKILL/scripts/voice.py" export --film "$FILM"                            # web/audio/vo_<id>.mp3
node "$FILM/tools/resolve.mjs" --film "$FILM"
python3 "$SKILL/scripts/ledger.py" reconcile --film "$FILM" [P]
```

For a long script, judge the takes a few lines per call (`--audio` with only those lines'
files, for example `"$FILM"/work/takes/l1_*.wav "$FILM"/work/takes/l2_*.wav`); when the
critic is unavailable, `check.json` names the best take per line by word error rate.

Artifacts: `work/takes/` (takes, `check.json`, per-take word JSON), `work/vo/` (picks,
`_final.wav`, `picks.json`, `words-detail.json`), `web/audio/vo_<id>.mp3`, `src/words.json`.

Gate: `voice.py check` exit 0 (a clean take for every line; `UNVERIFIED` from the coarse
aligner means you must listen); `voice.py words` exit 0 (narration ends in time).

Reading the check: it compares what the aligner heard with the text the model was given (the
`tts` spelling with `pronunciations` applied), word by word, and by default accepts no
difference (`--max-wer 0`). Write numbers, units and symbols out in words in `tts` ("sixty to
ninety minutes", not "60-90 min"), so both sides spell them alike. A respelled word that the
aligner writes in normal spelling ("heard 'levain' for 'leh van'") is a correct reading, not a
defect: when the printed differences are only such harmless ones, re-run `check` for those
lines with `--max-wer 0.15` and note it; a missing, extra or wrong word is a real failure.

On failure: a line with no clean take -> add a respelling to `pronunciations` (or the line's
`tts`) and `voice.py takes --film "$FILM" [P] --n 5 l4` (takes 0-2 come from the cache free),
then `check`, `pick`, `process` for that line; narration too long -> shorten lines (new
`takes`, `check`, `pick`, `process` for the changed lines), then if still long
`voice.py tighten --film "$FILM" --max-pause 0.24` (add `--tempo 1.025` at most; it works on
the processed files), then `words` and `export` again. A sticky failure (exit 4) -> stop and
report: the voice cannot change mid-film.

## 7. Animatic

Inputs: script with timings, concept, style bible.

1. Draft art (when `art.draft_first` and art mode `generated`): write the sheet prompt files
   phase 8 uses (`work/sheets/<sheet>.txt`, format in `style-presets/collage.md`), then
   generate them with `--draft` and a `-draft` sheet name; cut out with the final sticker names
   so the final art replaces it name for name. Skip it to use the engine's visible placeholders.

```bash
python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage animatic
python3 "$SKILL/scripts/art.py" sheet --film "$FILM" [P] --name cast-draft --prompt-file "$FILM/work/sheets/cast.txt" --draft
python3 "$SKILL/scripts/art.py" cutout --film "$FILM" "$FILM/work/sheets/cast-draft_0.png" --names hero_calm,hero_glad,bike,hill_sign
```

   (Use the sheet path `art.py sheet` printed; `--names` is comma-separated, row-major.)

2. Write `src/storyboard.json` (`storyboard.md`) with every scene, its `reads`, the key
   elements and beats keyed to words, simple motion, and a temporary `music.synth` bed. No
   custom acting yet.
3. Render and review:

```bash
node "$FILM/tools/resolve.mjs" --film "$FILM" --strict
node "$FILM/tools/qa.mjs" contact --film "$FILM" --every 2
node "$FILM/tools/export.mjs" --film "$FILM" --out "$FILM/work/animatic" --variants phone
python3 "$SKILL/scripts/critic.py" ask --film "$FILM" [P] --prompt-file "$FILM/work/direction/animatic.md" --video "$FILM/work/animatic/<slug>-phone.mp4" --tier draft --name animatic
```

With budget 0, a fresh Claude subagent judges `work/qa/contact.jpg` and the script with the
same animatic prompt.

Gate: GO from the critic (every scene one read at a time, the message lands); the user's
approval when film.json `autonomy` is `approve_animatic` or `approve_each_phase` (show the
contact sheet and the phone MP4 path).

On failure: structural problems go back to phase 5 (script) or 4 (concept); pacing problems
to the storyboard timing.

## 8. Assets

Inputs: style bible, animatic notes.

```bash
python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage assets
```

Art (mode `generated`; prompts and rules in `style-presets/collage.md` and `acting-kit.md`):

First write one prompt file per sheet, `$FILM/work/sheets/<sheet>.txt`: 6-10 lines of
`name: description` (template in `style-presets/collage.md`; the tool adds the style and format
blocks). Sheet images land at `work/sheets/<sheet>_0.<ext>`: use the exact path `art.py sheet`
prints (the extension follows the image the model returned).

```bash
python3 "$SKILL/scripts/art.py" sheet --film "$FILM" [P] --name cast --prompt-file "$FILM/work/sheets/cast.txt"
python3 "$SKILL/scripts/art.py" cutout --film "$FILM" "$FILM/work/sheets/cast_0.png" --names hero_calm,hero_glad,bike,hill_sign
python3 "$SKILL/scripts/art.py" sheet --film "$FILM" [P] --name props --prompt-file "$FILM/work/sheets/props.txt" --refs "$FILM/work/sheets/cast_0.png"
python3 "$SKILL/scripts/art.py" cutout --film "$FILM" "$FILM/work/sheets/props_0.png" --names chainring,cog_small,chain_loop
python3 "$SKILL/scripts/art.py" contact --film "$FILM"
```

`--names` is comma-separated, in row-major order (left to right, top to bottom): read each
sheet image before naming its cutouts, then read `work/qa/cutout-<sheet>.jpg` and the contact
sheet. Real assets (screenshots, logos, photos):
copy the file into `$FILM/web/img/` and add `"<name>": {"file": "<file name>"}` to
`web/img/manifest.json`.

Music (mode `generated`):

```bash
python3 "$SKILL/scripts/music.py" gen --film "$FILM" [P]                                  # music.candidates, from music.prompt
python3 "$SKILL/scripts/critic.py" ask --film "$FILM" [P] --prompt-file "$FILM/work/direction/music.md" --audio "$FILM"/work/music/cand_*.mp3 --name music
python3 "$SKILL/scripts/music.py" beats "$FILM/work/music/cand_1.mp3"
python3 "$SKILL/scripts/music.py" cut --film "$FILM" --file "$FILM/work/music/cand_1.mp3" --end-at <last word end + 0.3> --to <duration>
```

`gen` prints each candidate's path; the extension follows the audio the model returned (MP3
in practice, possibly `.wav`): pass the printed paths to the critic, and the chosen one
(`cand_1` above is an example) to `beats` and `cut`. The last word's end is the largest
`t + d` in `src/words.json`. Then set the storyboard's
`"music": {"asset": "audio/music.mp3", "gain_db": -12}` (the extension `cut` printed). Mode
`file`: run `beats` and `cut` on the user's track. Mode `synth`: keep `music.synth`. Mode
`none`: remove `music`.

Sound effects: write the `sfx` list in the storyboard, each keyed to the same cue as its
action; sparse and quiet.

```bash
node "$FILM/tools/resolve.mjs" --film "$FILM"
python3 "$SKILL/scripts/ledger.py" reconcile --film "$FILM" [P]
```

Gate: every sticker cleanly cut and named as the storyboard uses it; `music.py cut` exit 0
(it prints where the final chord lands relative to `--end-at` and exits 1 when it misses by
more than a bar); spend reconciled.

On failure: a bad sheet -> `--variant 1` (a fresh try, same prompt) or a clearer prompt file;
bad cutouts -> `--min-area`, `--allow-extra`; a sticky image failure -> stop and report; a
missed final chord -> `--final-at <s>` when detection picked the wrong chord (read
`work/music/edit.json`), or the next-best candidate. If the storyboard starts the music later
than 0, pass the same time as `--at`.

## 9. Build

Inputs: style bible, final art, word timings, beat grid.

The main agent owns `src/storyboard.json`, `src/script.json` and film.json. Custom shots are
one file each (`web/film/shots/<id>.js`); build them with parallel subagents when there are
several, one writer per file (briefing in SKILL.md). Key every beat and effect to words
(`vo:<line>.w<i>`) or beats (`beat:`, `bar:`); give every character acting (`acting-kit.md`).

```bash
node "$FILM/tools/resolve.mjs" --film "$FILM" --strict
node "$FILM/tools/render.mjs" stills <t,t,... one time per read> --film "$FILM"
node "$FILM/tools/render.mjs" purity --film "$FILM" --n 24
node "$FILM/tools/qa.mjs" ascii --film "$FILM"
node "$FILM/tools/render.mjs" glyph --film "$FILM"
```

Gate: resolve `--strict` clean (no warnings); purity, ascii and glyph pass; no placeholder
sticker in the stills.

On failure: fix and rerun; a purity mismatch means a shot reads `Math.random`, the clock or
state from an earlier frame.

## 10. Frame QA (three zoom levels)

```bash
node "$FILM/tools/qa.mjs" contact --film "$FILM" --every 2 --cols 4
node "$FILM/tools/qa.mjs" strip <t> --film "$FILM" --span 0.8 --n 8          # once per camera move and take
node "$FILM/tools/qa.mjs" crop <t> <x,y,w,h> --film "$FILM"                    # once per text block and face, 1080-line pixels
node "$FILM/tools/qa.mjs" text-check --film "$FILM" --json > "$FILM/work/qa/text-check.json"
node "$FILM/tools/render.mjs" text <t,t,...> --film "$FILM"           # what is drawn at a moment, with px1080 and bbox
```

Camera move times are in the resolve output (`--json`: `moves`). Look at every image yourself
first and fix what you see; then spawn a fresh subagent with the `frame_qa` template for the
review that goes into the round (phase 11).

Gate: `text-check` exit 0 (size, dwell, narration repeats, late write-ons); no blocking or
major frame defect left.

## 11. Film review (rounds 1-4)

For round N (start at 1; film.json `review.rounds` caps it). Before round 1, fill film.json
`credits` (every model that made something: the `model` of each `record` entry in
`ledger.jsonl` and `work/state.json`; the engine; fonts and their licenses; the music source;
fact sources; a SynthID watermark note) and `notes`, then run
`python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"`: the end card draws the
credits, so the reviewed cut must already carry them.

```bash
python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage review
node "$FILM/tools/export.mjs" --film "$FILM"
python3 "$SKILL/scripts/review.py" technical --film "$FILM" --round N
```

Write the prompt files from `review-prompts.md` into `$FILM/work/reviews/prompts/` once
(`director.md`, `persona-<slug>.md` with the quiz questions, `comparer.md`, `originality.md`,
`audio.md`), update them each round with what changed. Use the phone copy for the critic (it
is 720-line; `critic.py` makes a proxy of anything bigger than 20 MiB anyway):

```bash
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer director --prompt-file "$FILM/work/reviews/prompts/director.md" --video "$FILM/out/<slug>-phone.mp4"
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer persona --persona "<name>" --prompt-file "$FILM/work/reviews/prompts/persona-<slug>.md" --video "$FILM/out/<slug>-phone.mp4"
```

Grade each persona's quiz with a fresh subagent (quiz grader template) and store it with
`python3 "$SKILL/scripts/review.py" ingest --film "$FILM" --round N --file <graded.json> --persona "<name>" --force`.
Then the comparer, once per persona (it reads that persona's stored takeaway), and the
originality and audio passes:

```bash
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer comparer --persona "<name>" --prompt-file "$FILM/work/reviews/prompts/comparer.md"
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer originality --prompt-file "$FILM/work/reviews/prompts/originality.md" --video "$FILM/out/<slug>-phone.mp4"
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer audio --prompt-file "$FILM/work/reviews/prompts/audio.md" --video "$FILM/out/<slug>.mp4"
```

Claude subagents (fresh, not the builder): `fact_checker` (skip for fiction) and `frame_qa`
(phase 10 images for this cut); store each with
`python3 "$SKILL/scripts/review.py" ingest --film "$FILM" --round N --file <review.json>`.

Confirm defects: for each blocking or major defect from the critic, render the moment
(`node "$FILM/tools/render.mjs" stills <t> --film "$FILM"` or a strip), look at it, and list the
real ones in `$FILM/work/reviews/rN/confirmed.json`; add false positives to the intent notes.
Claims the user accepted go in `accepted_claims.json`. Then:

```bash
python3 "$SKILL/scripts/review.py" gates --film "$FILM" --round N
```

- `ship`: first make sure `review.py technical` for this round exited 0 (verdict ship: no TECH
  defect of any severity, including the major TECH-12, TECH-13 and TECH-15 that the gates do not
  list); then escalate the director to the stronger model before signing off and run the gates
  again (the sign-off review is decisive; $0 films skip it):

```bash
python3 "$SKILL/scripts/review.py" run --film "$FILM" [P] --round N --reviewer director --tier signoff --prompt-file "$FILM/work/reviews/prompts/director.md" --video "$FILM/out/<slug>-phone.mp4"
python3 "$SKILL/scripts/review.py" gates --film "$FILM" --round N
```

- `iterate`: fix every counted defect (`gates.json` lists them with the review that found
  them), re-resolve, re-run frame QA, and start round N+1. Fix causes, not symptoms: a failed
  message gate is a script problem, not a caption problem.
- `stop` (the last round without passing): stop iterating; deliver the best cut and list every
  open gate in the report for the user to decide.

With budget 0, every review in the round is a Claude subagent working from stills, strips,
the transcript and the technical check, stored with `review.py ingest`.

## 12. Deliver

1. Check film.json `credits` still name every model used (add any used since round 1, then
   `scaffold.py sync-config`); nothing else changes after the sign-off.
2. Final render and checks:

```bash
node "$FILM/tools/resolve.mjs" --film "$FILM" --strict
node "$FILM/tools/export.mjs" --film "$FILM"                       # plus --mode webm / bundle if film.json delivery lists them
node "$FILM/tools/qa.mjs" check --film "$FILM"                     # exit 0 = ship
python3 "$SKILL/scripts/ledger.py" status --film "$FILM"
python3 "$SKILL/scripts/ledger.py" reconcile --film "$FILM" [P]                # skip on a $0 film
```

3. Write `$FILM/out/report.md` (contents in `delivery.md`) and hand over: the page
   (`out/page/`, published if the environment offers it), the MP4s (the phone copy for
   messages), captions, transcript, the report, and the film directory as editable source.

Gate: `qa.mjs check` exits 0; the report lists spend, models, gate results and every decision
left to the user.
