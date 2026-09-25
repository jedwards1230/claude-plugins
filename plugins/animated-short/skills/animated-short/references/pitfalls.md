# Pitfalls: rules that prevent rework

Breaking any of these rules costs a rebuild, a re-render or a wrong fact. `$SKILL` is the
skill's base directory and `$FILM` the film directory.

## Substance and facts

- A 10/10 craft score can still miss the goal. A polished, broad film can teach its audience
  nothing new. Gate on the personas' concrete learnings, the quiz and the comparer, not the
  director score alone.
- Ask what the audience already knows. The success test is "what should they learn that they
  do not know yet", not "can anyone follow it".
- Never invent numbers. Every number on screen or in narration is in
  `work/research/claims.json` with a source and a date. When sources disagree, use the
  conservative wording and record the conflict.
- Convert every time to the viewer's local zone and account for daylight saving. A job logged
  at 02:00 UTC is not "2 a.m." for the viewer.
- Documentation lags reality. When a live read-only source exists, check it and record which
  one was used and when.
- Never invent traits, quotes or behaviour of real people or pets ("the office dog loves
  thunderstorms", a line the founder never said). Show them; do not characterise them beyond
  what the user said.
- Real things stay real: screenshots, logos, product photos and interfaces are used as they
  are. Never generate a fake UI or a look-alike logo.
- Uncomfortable truths follow the film's `hard_truths` policy. Under `ask`, stop and ask; do
  not decide alone, and list what was left out in the report.
- Technical names clutter labels for non-experts: plain words first, the real name faint and
  bracketed underneath (`sub`), or hidden, per the `jargon` policy.

## Script and reads

- The script is the product. Most quality comes from the fact sheet and the rewrite, not from
  animation; spend review effort there first.
- Budget about 2.5 spoken words per second of the speech window: the duration minus the
  lead-in and the ending (the end card plus 0.5 s when it is on). A 45 s film with the end card
  holds about 100 words; the formula and the worked example are in `phases.md`, phase 5.
- One read at a time, each held at least 1.2 s after it is complete; hold the big ones longer.
  Fast actions, slow meanings.
- Text that repeats the narration is noise: label the thing, do not caption the sentence.
- Every beat shows a mechanism (what moves, what causes what), not a stock picture of the noun
  being said.

## Voice and sound

- One-take narration hides pronunciation drift. Make 3 takes per line and transcript-check
  every take (`voice.py check`); respell tricky words in film.json `pronunciations` or the
  line's `tts` field, never in the caption text.
- The transcript check compares the aligner's words with the `tts` text exactly (`--max-wer 0`):
  write numbers, units and symbols out in words in `tts` ("sixty to ninety"), and read a
  respelled word heard in its normal spelling as a pass, not a failure (`phases.md`, phase 6).
- Aligners split and join words differently from the script (hyphens, numbers). The tools map
  word times by the displayed words of the line; cue words by their index in the displayed
  text and check the cue lands with a still.
- The energy aligner (the $0 fallback) is coarse: it cannot hear a wrong word. When `voice.py
  check` prints UNVERIFIED, judge those takes by ear with the critic and record the verdict
  (`phases.md`, phase 6); without a critic, report pronunciation as unverified.
- A compressor is not a brickwall: peaks still reach 0 dBFS. Loudness and true peak are set at
  export (two-pass loudnorm, verified with ebur128, with a JavaScript fallback for short
  films where loudnorm misses) and gated by TECH-2 and TECH-3.
- Short gaps must not make the bed pump: the engine derives the duck envelope from each gap
  (gaps under 0.8 s stay ducked; long gaps breathe). Do not hand-automate ducking.
- The music's final chord must land just after the last word. Generated music has no length
  control: beat-track it and cut whole bars on downbeats (`music.py cut --end-at`).
- Effects: sparse and quiet. A shrill effect on every write-on is the fastest way to lose a
  viewer.

## Visuals and the engine

- Ligatures swallow letters in letter-by-letter write-ons ("finds" drawn as "fnds"). The engine
  measures letters with ligatures broken; still run `render.mjs glyph` (preflight does) after
  adding any font.
- JavaScript source is ASCII-only: write non-ASCII characters as `\u` escapes. Raw UTF-8 in a
  script can render as mojibake ("A-with-circumflex" before a middle dot). `qa.mjs ascii`
  enforces it (TECH-13).
- Full-frame texture stays static. Grain that changes every frame multiplies the file size
  (a master can grow to hundreds of megabytes at over 30 Mbit/s) and reads as noise.
- Motion blur is a quarter-frame shutter on pans only, with a separate zoom blur; heavier blur
  ghosts and smears. The engine does this; shots add no blur of their own.
- Write-ons finish at least 0.3 s before the camera leaves (TECH-12); labels still writing as
  the camera pans read as broken.
- `[hidden]{display:none!important}` is in the page: an element with `hidden` (the poster, an
  overlay) must never cover the playing film.
- A frame is a pure function of time: no `Math.random`, `Date`, counters or state carried
  between frames in shots. `render.mjs purity` samples frames (raise `--n` before a final
  render); a shot that looks right in order can still be impure.
- A missing sticker draws a visible placeholder on purpose. Contact sheets catch it; never
  ship one (VIS-6).
- Generic `cursive` maps to odd fonts on some systems and fonts differ between machines. Ship
  an OFL `.woff2` for the hand and print faces (`style-presets/collage.md`).
- Captions or labels near the frame edge get cut on phones and TVs: keep text inside a safe
  margin of about 5% on every side.
- On a board layout, pull-back finales make text tiny by design; the text-size check skips
  finale windows, but everything else must meet 28 px at 1080p.

## Art

- A reference photo passed whole bleeds into the sheet (its background, pose and lighting).
  Pass one crop per subject with `--likeness`; the tool asks for colours and markings only.
- Pass an earlier final sheet as `--refs` to every later sheet, or the style drifts between
  sheets.
- Check every cutout (`work/qa/cutout-<sheet>.jpg`, `art.py contact`) before building: merged
  stickers, grey halos and missing borders are easier to fix at the sheet than in the film.
- The first image model that succeeds is pinned per tier; a sticky failure stops the tool
  rather than switching style mid-film.

## Reviews

- Critics invent timestamps and flag deliberate style (write-on text as "truncation"). Send
  intent notes with every prompt and confirm every blocking or major defect on a still before
  acting (`confirmed.json`).
- Ask for "blocking or not" explicitly; it separates polish from real problems.
- The reviewer that built the film is the worst judge of it: the critic is a different model
  family (Gemini watches; Claude builds), and Claude reviews are fresh subagents, not the
  builder.
- Reviewers that watch a whole cut miss small things, such as letters vanishing in a write-on;
  stills and crops catch them. The main agent reads the frame QA images too, not only the
  frame QA review.

## Cost and process

- Runaway cost is real: an unattended loop of paid calls can spend a large sum without
  producing a frame. Quote before every expensive stage, keep `budget_usd` honest, set an
  account ceiling (film.json `account_ceiling_usd`), and stop on exit 3 instead of retrying.
- TTS costs are estimates (the speech endpoint reports no cost). Reconcile the ledger with the
  account at each stage boundary (`ledger.py reconcile`).
- A crash can leave reservations open, holding budget: `ledger.py release --all-open` after
  checking nothing is running.
- Every node tool needs `npm install --prefix "$FILM"` first (playwright-core and Mediabunny).
  If Chromium is missing: `npx playwright install chromium` (or pass `--chromium <path>` / set
  `CHROMIUM_PATH`).
- The page needs HTTP: `file://` cannot load it, and WebCodecs export needs the secure
  localhost page the tools serve. Never render from `about:blank`.
- Chat attachments are capped (30 MiB is common): send the phone copy.
- Some page-publishing tools accept files only from certain folders: copy `out/page/` there
  first.
- Parallel builders editing one file overwrite each other: one writer per file, one file per
  shot.
