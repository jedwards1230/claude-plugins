---
name: animated-short
description: This skill should be used when the user asks to "make an animated explainer", "make an animated short", "make an animated video", "make an explainer video about X", "make a cartoon that explains X", "animate a story", "make a promo video", "make a 60-second film", "turn this script into an animation", or otherwise wants a short (15-180 s) narrated animated film about any topic. It delivers a live web page, MP4s, captions and a transcript, built on a bundled canvas engine with spend-capped providers.
---

# Animated short films

Make short animated films (explainers, stories, promos) that teach or move a specific
audience, not just look polished. A deterministic canvas engine draws every frame as a pure
function of time; generated voice, music and sticker art are ingredients; reviewers from a
different model family watch the cut; a spend ledger caps every paid call.

This skill's base directory is `${CLAUDE_PLUGIN_ROOT}/skills/animated-short` (if that
placeholder appears unexpanded, use the base directory Claude Code printed when it loaded this
skill). The references call it `$SKILL`, and call the film's directory (an absolute path you
choose) `$FILM`. Shell variables do not persist between tool calls: write both paths out in
every command.

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
9. Be original. Paper collage with image-model stickers, a Gemini narrator and a generated bed
   is now the viral default look. Every film gets its own motif, palette arc, cast and
   banned-pattern list, and passes an originality gate.
10. Guard spend. Quote before every expensive stage, respect `budget_usd`, stop on exit 3
    (budget refused). The key comes from `OPENROUTER_API_KEY` or `--key-file <path>`; never
    print, echo, log or commit it, never guess or hard-code a key path.
11. Verify reviewers with stills. Critics invent timestamps and flag deliberate style. Send
    intent notes with every prompt; a defect counts only when a still confirms it or two
    reviewers report it; the critic is a different model family from the builder.
12. Frames are pure functions of time (no `Math.random`, clock or carried state), JavaScript
    is ASCII-only, and each shot lives in its own file with one writer.
13. Respect the inputs the user set: the offscreen list, the hard-truths and jargon policies,
    commercial-safe providers, the disclosure card.

## Phases and gates

Details, exact commands and failure handling for every phase: `references/phases.md`.

| # | Phase | Gate to pass before moving on |
| --- | --- | --- |
| 1 | Preflight: tools, key, credit, providers per role, delivery modes, glyph test | every needed role has a working provider; a delivery mode exists |
| 2 | Intake: one batched question round, film.json, scaffold, full preflight, quote | topic, goal, message set; quote fits the budget |
| 3 | Research: claims ledger (fact, source, date, local time, conflicts, sensitivity); fiction skips | every planned fact sourced; hard truths decided per policy |
| 4 | Creative direction: logline, escalating motif, echo ending, style bible, cast and emotion sheets, banned patterns, intent notes | originality >= 7 and no banned pattern planned |
| 5 | Script and reads sheet: ~2.5 words/s, a mechanism per beat, quiz drafted | persona script gate (takeaway = message, enough concrete learnings) |
| 6 | Voice first: audition, 3 takes per line, transcript check, picks, processing, word timings | a verified clean take per line; narration fits the duration |
| 7 | Animatic: keyframes + voice as a page, draft art | critic GO; user approval only if autonomy asks for it |
| 8 | Assets: final sticker sheets, music cut on downbeats, sound-effect list | clean cutouts; the music's final chord lands after the last word |
| 9 | Build: storyboard, one file per custom shot, cues on words and beats | `resolve --strict`, purity, ASCII and glyph checks clean |
| 10 | Frame QA: contact sheets, strips, crops, text-at-time assertions | text-check clean; no frame defect left |
| 11 | Film review: technical, director, personas + quiz, comparer, originality, audio, fact-checker, frame QA | every ship gate, then the stronger-model director sign-off; max 4 rounds |
| 12 | Deliver: page, MP4s, captions, transcript, credits, report, editable sources | technical check ships; report lists every open decision |

Ship gates (computed by `review.py gates`): director overall >= 8.5 and no counted blocking
defect; every persona takeaway judged equal to the message by the comparer; explainers: quiz
>= 80% and >= 5 concrete learnings per persona; originality >= 7 and no banned pattern seen;
claims verified or accepted by the user; reads held >= 1.2 s; text >= 28 px at 1080p; no
on-screen sentence repeating the narration; duration +-1 s; -14.5 +-0.5 LUFS integrated; true
peak <= -1 dBTP; captions and transcript present; and the round's technical review ships (no
TECH defect at all). At most 4 review rounds, then stop and report the open gates. Thresholds
come from film.json `review`; the authoritative gate table is in `references/review-prompts.md`.

## Intake

Skip intake entirely when the user supplies a film.json with `topic`, `goal` and `message`
(its `hard_truths`, default `ask`, then applies when research finds something). Otherwise run
the free preflight first (phase 1) so the options offered actually work, then:

1. State the full question list to the user, one line each, so the whole decision surface is
   visible.
2. Ask through AskUserQuestion, back to back, at most 4 questions per call and 2-4 options
   each, everything answerable asked in the first call. Draft concrete options from the
   request (the tool adds a free-text "Other"). Drop a question whose answer the request
   already gives; keep the hard-truths question unless film.json sets it.
3. Write film.json (fields: `references/inputs.md`), scaffold, and continue without further
   questions unless film.json `autonomy` or the `ask` hard-truths policy says otherwise.

Call 1: substance.

- Message: "Which sentence should viewers be able to repeat after watching?" Options: two or
  three candidate messages drafted from the request.
- Audience (multiSelect): "Who is this for, and what do they already know about <topic>?"
  Options: two to four personas with their prior knowledge, e.g. "Newcomer: knows nothing
  specific", "Practitioner: knows the basics, wants the details", "Kids 8-12". This sets
  `audience[].knows`.
- Hard truths: "If research turns up uncomfortable facts, what should the film do?" Options:
  "Include them plainly", "Soften them", "Leave them out and tell me", "Ask me each time".
- Form: "What kind of film, how long, what shape?" Options such as "Explainer, 60 s, 16:9
  (Recommended)", "Explainer, 90 s, 16:9", "Story, 60 s, 16:9", "Promo, 30 s, 9:16".

If the request leaves the topic or goal unclear, ask those first in this call instead of Form.

Call 2: look and sound.

- References (multiSelect): "Which cultural references fit this audience, and which must be
  avoided?" Options: two or three references that suit the audience and topic, plus "None:
  keep it literal". Record avoid-lists from "Other" answers.
- Tone: "warm (Recommended)", "whimsical", "calm, documentary", "wry".
- Voice: "Audition voices and pick the best (Recommended)", "Use a voice I name", "No
  narration: captions and music only".
- Music: "Generated bed, candidates judged (Recommended)", "My own track (I hold the rights)",
  "Synthesized pad ($0)", "No music".

Call 3: truth, money, control.

- Sources (multiSelect): "Where should the facts come from?" Options: "Web research
  (Recommended)", "Docs, repos or files I will point to", "Live read-only systems I will
  name", "None: it is fiction".
- Budget: "Spending cap for voice, art, music and AI reviews?" Options: "$5 (a typical film
  costs $2-4) (Recommended)", "$10", "$3 (fewer sheets and rounds)", "$0: code-drawn art, no
  narration, synthesized music". Say what the key is used for.
- Real subjects: "Should real people, pets, products or logos appear?" Options: "No",
  "Yes: I will provide photos or screenshots and consent", "Products or logos only, from files I
  provide".
- Autonomy: "After these questions, how involved do you want to be?" Options: "Not at all
  until delivery (Recommended)", "Approve the animatic", "Approve every phase". When preflight
  found no key and the budget is above $0, ask instead: "Where is the OpenRouter API key?"
  ("In OPENROUTER_API_KEY", "In a file: I will give the path", "No key: make a $0 film").

Defaults cover everything else (`references/inputs.md`): jargon in brackets, lived-in depth,
the standard offscreen list, commercial-safe providers, the credits card and end card on.

## Spend and keys

- Key: environment variable `OPENROUTER_API_KEY`, or `--key-file <path>` on every paid tool (a
  file of `KEY=VALUE` lines or just the key). Ask the user for the path; pass paths, never
  values.
- Caps: film.json `budget_usd` (hard cap across all providers, enforced by `ledger.jsonl`:
  estimate x 1.2 reserved before each call); optional `--account-ceiling <usd>` (or env
  `ANIMATED_SHORT_ACCOUNT_CEILING`) refuses any paid call that would push the account's
  reported usage past it.
- Before voice, the animatic, final assets and each review round:
  `python3 "${CLAUDE_PLUGIN_ROOT}/skills/animated-short/scripts/quote.py" --film "$FILM" --stage <stage>`.
  If it does not fit, cut scope (fewer sheets, candidates, takes, personas) before asking.
- Draft tier for the animatic (`--draft` sticker sheets, `--tier draft` critic, the engine's
  synthesized music bed); final 4K art only for the build.
- After each stage: `ledger.py reconcile --film "$FILM" [--key-file <path>]` (free).
- A typical 60-90 s film costs $2-4 at defaults. Provider details, fallbacks, licenses and
  deprecations: `references/providers.md`.

### $0 films

When there is no key or the user picks $0, set `budget_usd: 0`, voice `none` (captions from a
hand-written `src/words.json`), music `synth`, art `code` (shapes, ink, `ACT.face` characters).
Skip everything that needs the key: preflight tier 1, `ledger.py reconcile`, `critic.py ask`,
`review.py run` and the sign-off pass. Every judgment and review is a fresh Claude subagent
working from stills, strips, contact sheets and the transcript, stored with `review.py ingest`
(the extra context block it needs is in `references/review-prompts.md`). The quote is $0 and the
gates still apply; the report says that no model watched the video. `examples/golden/` is a $0
film.

## Tools at a glance

Plugin scripts (`python3 "${CLAUDE_PLUGIN_ROOT}/skills/animated-short/scripts/<tool>.py" --help`;
`test-golden.sh` runs with `bash` and also takes `--help`):

| Tool | Subcommands |
| --- | --- |
| `scaffold.py` | `new <dir> [--film-json F] [--from-example golden]`, `sync-config --film D` |
| `preflight.py` | `--film D [--tier 0/1]` (free / sub-cent) |
| `quote.py`, `ledger.py` | cost quote per stage; `status`, `reconcile`, `release` |
| `voice.py` | `audition`, `takes`, `check`, `pick`, `process`, `tighten`, `words`, `export` |
| `music.py` | `gen`, `beats`, `cut` |
| `art.py` | `sheet`, `cutout`, `contact` |
| `critic.py` | `ask` (a free-form question to the critic with video, audio or images) |
| `review.py` | `run` (critic reviews), `ingest` (Claude reviews), `technical`, `gates` |
| `schema.py` | `validate`, `defaults` |
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
| script persona (round 0), fact-checker, frame QA, quiz grading | fresh Claude subagents | `review.py ingest --film "$FILM" --round N --file F [--persona NAME]` |
| director, persona (with quiz), comparer, originality, audio | the critic model (on $0 films: fresh Claude subagents, stored with `ingest`) | `review.py run --film "$FILM" --round N --reviewer R --prompt-file F ...` |
| technical | `tools/qa.mjs check` | `review.py technical --film "$FILM" --round N` |

Prompt templates, the checklist ids defects must cite, the intent-notes block, the quiz format
and the gate table: `references/review-prompts.md`. Before shipping (gates pass and the
technical review ships), re-run the director with `--tier signoff` (a stronger model) and
compute the gates again; $0 films skip the sign-off.

## Briefing build subagents

Parallel subagents speed up research, custom shots and reviews. The main agent owns
`film.json`, `src/storyboard.json`, `src/script.json` and the ledger; a subagent never edits
them. Brief every build subagent with:

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
`references/review-prompts.md` and are always fresh (never the agent that built the cut).
Research subagents get read-only access to the sources and write only the claims ledger.

## References

| File | Read it |
| --- | --- |
| `references/phases.md` | always, before phase 1: every phase's commands, artifacts, gates and failure handling |
| `references/inputs.md` | at intake: every film.json field, its default and an example |
| `references/storyboard.md` | before writing the storyboard or any custom shot (phase 7 and 9) |
| `references/acting-kit.md` | before designing characters (phase 4) and writing shots with faces or actions |
| `references/style-presets/collage.md` | at creative direction and before any sticker sheet: craft rules, sheet prompts, banned patterns, fonts, originality check |
| `references/review-prompts.md` | before any review (phases 5, 7, 10, 11): prompts, checklist ids, intent notes, quiz, gates |
| `references/providers.md` | at preflight, when a provider fails, or to change or add a model |
| `references/delivery.md` | before exporting and at delivery |
| `references/engines.md` | when asked about other engines (HyperFrames, Remotion, Manim) or the adapter contract |
| `references/pitfalls.md` | before phase 5 and whenever something looks wrong |
| `references/film.schema.json`, `storyboard.schema.json`, `rubric.schema.json` | exact field definitions (validate with `scripts/schema.py`) |
| `examples/golden/` | a 10 s complete film to copy patterns from; `scripts/test-golden.sh` proves the machine works |
