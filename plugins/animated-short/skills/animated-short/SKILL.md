---
name: animated-short
description: This skill should be used when the user asks to "make an animated explainer", "make an animated short", "make an animated video", "make an explainer video about X", "make a cartoon that explains X", "animate a story", "make an animated promo", "make a promo video", "make a 60-second film", "turn this script into an animation", or otherwise wants a short (15-180 s) narrated animated film about any topic. It delivers a live web page, MP4s, captions and a transcript, built on a bundled canvas engine with spend-capped providers. Not for editing existing footage or live-action video.
---

# Animated short films

Make short animated films (explainers, stories, promos) that teach or move a specific
audience, not just look polished. A deterministic canvas engine draws every frame as a pure
function of time; generated voice, music and sticker art are ingredients; reviewers from a
different model family watch the cut; a spend ledger caps every paid call.

This skill's directory is `${CLAUDE_SKILL_DIR}`, the same directory as
`${CLAUDE_PLUGIN_ROOT}/skills/animated-short` (if neither placeholder is expanded, use the base
directory Claude Code printed when it loaded this skill). This file and the references call it
`$SKILL`, and call the film's directory `$FILM`: an absolute path that does not exist yet
(`scaffold.py new` refuses a non-empty directory). Shell variables do not persist between tool
calls: write both absolute paths out in every command.

Deliverables: a live web page (always), MP4s (master, share, and a phone copy under 30 MiB),
SRT and VTT captions, a transcript, a credits card with an AI-made note, the editable film
directory and a report.

## Rules that matter most

1. Substance first. A film that teaches its audience nothing new has failed, however
   polished. Ask what the audience already knows; follow one concrete thing through; gate on
   concrete learnings, the quiz and the comparer, never the director score alone.
2. The script is the product. Most of the quality comes from the facts and the rewrite:
   review the script with the personas before making any art.
3. Show the mechanism. Every beat shows how something works (what moves, what causes what),
   never stock imagery or a literal picture of the word being said.
4. One read at a time. Each read is held at least 1.2 s after it is complete; text is at least
   28 px at 1080p; no sentence of the narration appears on screen.
5. Audio drives timing. Voice first, then word timestamps; key every beat and sound effect to
   a word (`vo:l3.w4`) or a music beat (`beat:12`), so re-timing a line moves everything.
6. Code draws the motion; generated media are only ingredients (voice, music, stickers).
   Real things stay real: real screenshots, logos and photos, never generated fakes.
7. Characters act: anticipation, squash and stretch, expressions that change through a take.
   A sticker that pops in and freezes is a defect.
8. Never invent numbers, quotes or traits. Every fact is in `work/research/claims.json` with a
   source and a date; times are in the viewer's local zone; real people and pets appear only
   with consent and are never characterised beyond what the user said.
9. Be original. Every film gets its own motif, palette arc, cast and banned-pattern list, and
   passes an originality gate (why: `references/style-presets/collage.md`).
10. Guard spend. Quote before every expensive stage, respect `budget_usd`, stop on exit 3
    (budget refused). The key comes from `OPENROUTER_API_KEY` or `--key-file <path>`; never
    print, echo, log or commit it, never guess or hard-code a key path.
11. Verify reviewers with stills. Critics invent timestamps and flag deliberate style: send
    intent notes with every prompt and count a defect only under the defect rule
    (`references/review-prompts.md`). The critic is a different model family from the builder.
12. Frames are pure functions of time (no `Math.random`, clock or carried state), JavaScript
    is ASCII-only, and each shot lives in its own file with one writer.
13. Respect the inputs the user set: the offscreen list, the hard-truths and jargon policies,
    commercial-safe providers, the disclosure card.

## Phases and gates

Details, exact commands and failure handling for every phase: `references/phases.md`.

| # | Phase | Gate to pass before moving on |
| --- | --- | --- |
| 1 | Preflight (no film yet): tools, key, credit, providers per role, delivery modes | every needed role has a working provider; a delivery mode exists |
| 2 | Intake: one batched question round, film.json, scaffold, full preflight with the glyph test, quote | topic, goal, message set; glyph test ok; quote fits the budget |
| 3 | Research: claims ledger (fact, source, date, local time, conflicts, sensitivity); fiction skips | every planned fact sourced; hard truths decided per policy |
| 4 | Creative direction: logline, escalating motif, echo ending, style bible, cast and emotion-sheet descriptions, banned patterns, intent notes | originality >= 7 and no banned pattern planned |
| 5 | Script and reads sheet: ~2.5 words/s, a mechanism per beat, quiz drafted | persona script gate (takeaway = message, enough concrete learnings, quiz answerable) |
| 6 | Voice first: audition, takes per line, transcript check, picks, processing, word timings | a verified clean take per line; narration fits the duration |
| 7 | Animatic: keyframes + voice as a page, draft art | critic GO; user approval only if autonomy asks for it |
| 8 | Assets: final sticker sheets, music cut on downbeats, sound-effect list | clean cutouts; the music's final chord lands after the last word |
| 9 | Build: storyboard, one file per custom shot, cues on words and beats | `resolve --strict`, purity, ASCII and glyph checks clean |
| 10 | Frame QA: contact sheets, strips, crops, text-at-time assertions | text-check clean; no blocking or major frame defect left |
| 11 | Film review: technical, director, personas + quiz, comparer, originality, audio, fact-checker, frame QA | every ship gate, then the stronger-model director sign-off; at most `review.rounds` (4) rounds |
| 12 | Deliver: page, MP4s, captions, transcript, credits, report, editable sources | technical check ships; report lists every open decision |

Ship gates, in short: the director's overall score, no counted blocking defect, every persona's
takeaway matching the message, the quiz and concrete learnings (explainers), originality, the
claims, and the round's technical review (reads, text size, narration repeats, duration,
loudness, true peak, captions, transcript). `review.py gates` computes them from the round's
reviews with the thresholds in film.json `review`; the authoritative table is "Ship gates" in
`references/review-prompts.md`. After `review.rounds` rounds without passing, stop and report the
open gates.

## Intake

Skip it when the user supplies a film.json with `topic`, `goal` and `message`. Otherwise:
run the free preflight without a film (phase 1), state the full question list one line each,
then ask it through AskUserQuestion in back-to-back calls of at most 4 questions (2-4 options
each), with one follow-up call only for answers that need one (the key's location, source
paths, a named voice, a track). Write film.json, scaffold, and continue without further
questions unless `autonomy` or the `ask` hard-truths policy says otherwise. The questions, their
options, the follow-ups and what empty answers default to: `references/intake.md`.

## Spend and keys

- Key: environment variable `OPENROUTER_API_KEY`, or `--key-file <path>` on every paid tool (a
  file of `KEY=VALUE` lines or just the key). Ask the user for the path; pass paths, never
  values.
- Caps: film.json `budget_usd` (default 10; a hard cap across all providers, enforced by
  `ledger.jsonl`: estimate x 1.2 reserved before each call). Optional account ceiling: a paid
  call is refused when the account's reported usage would pass it; set it once in film.json
  `account_ceiling_usd`, or per command with `--account-ceiling <usd>` or env
  `ANIMATED_SHORT_ACCOUNT_CEILING` (flag, then env, then film.json).
- Before voice, the animatic, final assets and each review round:
  `python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage <voice|animatic|assets|review>`.
  If it does not fit, cut scope (fewer sheets, candidates, takes, personas) before asking.
- Draft tier for the animatic (`--draft` sticker sheets, `--tier draft` critic, the engine's
  synthesized music bed); final 4K art only for the build.
- After each stage: `python3 "$SKILL/scripts/ledger.py" reconcile --film "$FILM" [--key-file <path>]` (free).
- A typical 60-90 s film costs $2-4 at defaults. Provider details, fallbacks, licenses and
  deprecations: `references/providers.md`.

### $0 films

These rules are the single source for $0 films; the references point here. When there is no
key or the user picks $0, set `budget_usd: 0`, voice `none` (captions from a hand-written
`src/words.json`), music `synth`, art `code` (shapes, ink, `ACT.face` characters). Skip
everything that needs the key: preflight tier 1, `ledger.py reconcile`, `critic.py ask`,
`review.py run` and the sign-off pass. Every judgment and review is a fresh Claude subagent
working from stills, strips, contact sheets, the export's loudness figures (`out/export.json`)
and the transcript, written to `$FILM/work/reviews/incoming/` and stored with `review.py
ingest` (the extra context block it needs is in `references/review-prompts.md`). The quote is
$0 and every gate still applies; the report says that no model watched the video.
`$SKILL/examples/golden/` is a $0 film.

## Tools at a glance

Plugin scripts (`python3 "$SKILL/scripts/<tool>.py" --help`; `test-golden.sh` runs with `bash`
and also takes `--help`):

| Tool | Subcommands |
| --- | --- |
| `scaffold.py` | `new <dir> [--film-json F] [--from-example golden]`, `sync-config --film D` |
| `preflight.py` | `[--film D] [--tier 0/1]` (free / sub-cent; without `--film` before the film exists) |
| `quote.py`, `ledger.py` | cost quote per stage (`--stage`); `status`, `reconcile`, `release` |
| `voice.py` | `audition`, `takes`, `check`, `pick`, `process`, `tighten`, `words`, `export` |
| `music.py` | `gen`, `beats`, `cut` |
| `art.py` | `sheet`, `cutout`, `contact` |
| `critic.py` | `ask` (a free-form question to the critic with video, audio or images; `--stage` labels its spend) |
| `review.py` | `run` (critic reviews), `ingest` (Claude reviews; `--force` replaces), `technical`, `gates` |
| `schema.py` | `validate`, `defaults` (for film, storyboard and rubric JSON) |
| `test-golden.sh` | the $0 end-to-end conformance run |

Film tools, copied into every film (`node "$FILM/tools/<tool>.mjs" --help`; run
`npm install --prefix "$FILM"` first): `resolve.mjs` (cues to seconds, checks), `render.mjs`
(`stills`, `video`, `audio`, `text`, `glyph`, `purity`, `serve`), `qa.mjs` (`contact`, `strip`,
`crop`, `text-check`, `ascii`, `check`), `export.mjs` (every delivery mode; `--probe`).

Film directory: `film.json`, `src/` (script, words, beats, source storyboard), `web/` (the
page: `film/config.json`, `film/storyboard.json` resolved, `film/shots/*.js`, `img/`, `audio/`,
`fonts/`), `tools/`, `work/` (research, direction, takes, vo, music, sheets, qa, reviews,
critic), `cache/`, `ledger.jsonl`, `out/` (deliverables).

## Reviews: who produces what

| Review | Produced by | Stored with |
| --- | --- | --- |
| script persona and its comparer (round 0), fact-checker, frame QA, quiz grading | fresh Claude subagents, writing to `$FILM/work/reviews/incoming/` | `review.py ingest --film "$FILM" --round N --file F [--persona NAME] [--force]` |
| director, persona (with quiz), comparer, originality, audio | the critic model (on $0 films: fresh Claude subagents, stored with `ingest`) | `review.py run --film "$FILM" --round N --reviewer R --prompt-file F ...` |
| technical | `tools/qa.mjs check` | `review.py technical --film "$FILM" --round N` |

The gates read only the review names `review.py` writes into `work/reviews/r<N>/`, so a
subagent never writes there. Prompt templates, the checklist ids defects must cite, the
intent-notes block, the quiz format, the per-round order and the gate table:
`references/review-prompts.md` and `references/phases.md` (phase 11). Before shipping, re-run
the director with `--tier signoff` (a stronger model) and compute the gates again; a failed
sign-off means another round.

## Briefing build subagents

Parallel subagents speed up research, custom shots and reviews. The main agent owns
`film.json`, `src/storyboard.json`, `src/script.json`, `work/research/claims.json` and the
ledger; a subagent never edits them. Brief every build subagent with:

- The film: title, message, audience, and the path of `work/direction/style-bible.md`
  (palette, textures, cast, camera grammar, banned patterns) and the concept.
- Its one file: `$FILM/web/film/shots/<id>.js`, the element entry that uses it (box `w x h`,
  `pos`, `params`, `cues`), the words it is keyed to (`src/words.json`), and what the shot must
  show (the read and the mechanism, second by second).
- The API: `references/storyboard.md` (custom shots) and `references/acting-kit.md`.
- The constraints, restated in full: the frame is a pure function of `t` (no `Math.random`,
  `Date`, `performance.now` or state kept between frames); animate acting on `api.ts`;
  ASCII-only source (`\u` escapes); all text through `api.text` or `D.text`, at least 28 px;
  never a narration sentence on screen; characters act (anticipation, squash, takes); write
  only its own file; no network, no new dependencies.
- The check before reporting back: `node "$FILM/tools/resolve.mjs" --film "$FILM" --strict`,
  `node "$FILM/tools/render.mjs" stills <t,t,...> --film "$FILM"`, `node "$FILM/tools/qa.mjs" strip <t> --film "$FILM"` around each action,
  `node "$FILM/tools/render.mjs" purity --film "$FILM"`, `node "$FILM/tools/qa.mjs" ascii --film "$FILM"`,
  then the image paths and one paragraph on what the shot shows.

Run one writer per file at a time. Review subagents get the templates in
`references/review-prompts.md`, are always fresh (never the agent that built the cut) and write
only to `$FILM/work/reviews/incoming/`. Research subagents get read-only access to the sources
and each writes only its own `$FILM/work/research/claims-<k>.json`; the main agent merges them
into `claims.json`.

## References

| File | Read it |
| --- | --- |
| `references/phases.md` | always, before phase 1: every phase's commands, artifacts, gates and failure handling |
| `references/intake.md` | at intake: the question round, its follow-ups and what unanswered questions default to |
| `references/inputs.md` | at intake: every film.json field, its default and an example |
| `references/storyboard.md` | before writing the storyboard or any custom shot (phase 7 and 9) |
| `references/acting-kit.md` | before designing characters (phase 4) and writing shots with faces or actions |
| `references/style-presets/collage.md` | at creative direction and before any sticker sheet: craft rules, sheet prompts, banned patterns, fonts, originality check |
| `references/review-prompts.md` | before any review or critic judgment (phases 4-8, 10, 11): prompts, checklist ids, intent notes, quiz, gates |
| `references/providers.md` | at preflight, when a provider fails, or to change or add a model |
| `references/delivery.md` | before exporting, when filling the credits, and at delivery |
| `references/engines.md` | when asked about other engines (HyperFrames, Remotion, Manim) or the adapter contract |
| `references/pitfalls.md` | before phase 5 and whenever something looks wrong |
| `references/film.schema.json`, `storyboard.schema.json`, `rubric.schema.json` | exact field definitions (validate with `$SKILL/scripts/schema.py validate <schema> <doc>`) |
| `$SKILL/examples/golden/` | a 10 s complete film to copy patterns from; `$SKILL/scripts/test-golden.sh` proves the machine works |
