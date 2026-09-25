# Reviews: checklist, prompts, gates

Every reviewer returns one JSON object valid against `$SKILL/references/rubric.schema.json`
(the same shape for all, so rounds can be merged and compared). Defects cite checklist ids
from this file. `$SKILL` is the skill's base directory and `$FILM` the film directory.

## Who reviews what

| Reviewer (`reviewer`) | Runs as | Sees | Owns | How it gets into the round |
| --- | --- | --- | --- | --- |
| `script_persona` | Claude subagent (free), once per persona | script, reads sheet, planned labels, quiz questions | learned, confusions, worries, takeaway, quiz answers | `review.py ingest --round 0` |
| `fact_checker` | Claude subagent | script, on-screen text, claims ledger, film.json truth fields | accuracy, claims, off-screen violations | `review.py ingest --round N` |
| `frame_qa` | Claude subagent reading images | contact sheets, strips, crops, `text-check` output | readability, continuity, polish | `review.py ingest --round N` |
| `technical` | scripts | the deliverables | TECH-1..15 | `review.py technical --round N` |
| `director` | critic model (Gemini), video | the cut + intent notes | story, originality, sync, pacing, overall | `review.py run --reviewer director` (and `--tier signoff` before shipping) |
| `persona` | critic model, video, once per persona | the cut + prior knowledge + quiz questions | message, new knowledge, quiz answers | `review.py run --reviewer persona --persona NAME`, then graded and re-ingested |
| `comparer` | the critic model (text) in film-review rounds when `budget_usd` > 0; a fresh Claude subagent at round 0 and on $0 films | the message + one persona's takeaway | matches_message | `review.py run --reviewer comparer --persona NAME`, or `review.py ingest --persona NAME` for a subagent |
| `originality` | critic model, video | the cut + banned patterns | originality, banned_patterns_seen | `review.py run --reviewer originality` |
| `audio` | critic model, audio | the rendered mix (`work/mix.wav`) | audio, sync of sound | `review.py run --reviewer audio --audio "$FILM/work/mix.wav"` |

`review.py run` appends the film context (title, form, duration, aspect, goal, message), the
persona and what they know, the banned patterns (director, originality), the persona's
takeaway (comparer), the intent notes and the output schema to the prompt file. Write only
the reviewer-specific part (the templates below). Claude subagents get no such appendix: their
templates include the context, and the main agent passes file paths.

Every Claude subagent writes its JSON to `$FILM/work/reviews/incoming/<reviewer>[-<persona
slug>].json` and nothing else; `review.py ingest` validates it and stores it in
`work/reviews/r<N>/` under the name the gates read. Only those names count there: any other
file in a round directory is reported and ignored by `review.py gates`.

On a $0 film (SKILL.md, "$0 films") the director, persona, comparer, originality and audio
passes are fresh Claude subagents. Since nothing is appended for them, give each one the
`review.py run` template plus this block:

```text
The film: <title> (<form>, <duration> s, <aspect>). Goal: <goal>. Message (the one sentence
viewers should repeat): <message>. <Persona: <name>. Already knows: <knows>.> <Banned patterns
(director, originality): <list>.> <Persona takeaway to judge (comparer): <takeaway>.>
You cannot watch the video: judge it from these images and files: <contact sheets, strips,
crops, transcript, out/export.json>. Intent notes (deliberate choices, not defects):
<work/direction/intent-notes.md>.
Write ONLY one JSON object valid against $SKILL/references/rubric.schema.json to
$FILM/work/reviews/incoming/<reviewer>[-<persona slug>].json, with "reviewer":
"<director|persona|comparer|originality|audio>", "cut": "r<N>" and, for persona and comparer,
"persona": "<name exactly as in film.json>". Times are "m:ss" or "m:ss.s"; cite checklist ids.
```

## Files

| Path (in `$FILM`) | What |
| --- | --- |
| `work/direction/intent-notes.md` | Deliberate choices; appended to every `review.py run` prompt (template below). |
| `work/direction/quiz.json` | `{"questions": [{"q": "...", "a": "...", "accept": ["..."]}]}`: drafted at script time; at least 5 questions for explainers. The answer key: the quiz gate is scored out of its questions. Answers never go to the personas. |
| `work/direction/originality.md` | The creative-direction originality check: the score alone on line 1, then the answer. |
| `work/reviews/prompts/<reviewer>.md` | The filled prompt templates passed as `--prompt-file`. |
| `work/reviews/incoming/<reviewer>[-<persona-slug>].json` | Where Claude subagents write; `review.py ingest --file` reads from here. |
| `work/reviews/r<N>/<reviewer>[-<persona-slug>][-signoff].json` | Stored reviews (`review.py` names them; the slug is the persona's film.json name in lower case with every run of other characters turned into one hyphen, e.g. `persona-a-home-baker.json`). Pass `--persona` the film.json name (an exact match wins; otherwise a unique part of it). Round 0 holds pre-production reviews. |
| `work/reviews/r<N>/confirmed.json` | `[{"check": "TEXT-3", "at": "0:41.5", "still": "work/qa/stills/t041.50.jpg", "note": "..."}]`: defects confirmed on a still. |
| `work/reviews/r<N>/accepted_claims.json` | `["claim text", ...]`: claims the user accepted as they are. |
| `work/reviews/r<N>/raw/` | Raw critic replies and validation errors. |
| `work/reviews/r<N>/gates.json` | `review.py gates` output. |

## The defect rule

Critics perceive well and invent details: timestamps drift, write-on text gets called a
truncation, deliberate darkness gets called a bug. A defect counts (`review.py gates`) only
when `maybe_intentional` is not true AND one of these holds:

1. A still confirms it: render the moment (`node "$FILM/tools/render.mjs" stills 41.5 --film "$FILM"`
   or a strip), look at it, and add an entry to `confirmed.json` with the same check id and a
   time within 2 s.
2. Another review in the same round cites the same check id within 2 s.
3. It comes from a measuring reviewer: `technical`, `frame_qa`, `fact_checker`.

Check every blocking and major defect against a still before acting on it; fix what is real,
and add a line to the intent notes for each false positive so the next round does not repeat it.

## Checklist

Severity: `blocking` = a viewer misunderstands, misses the message, is told something false,
or notices a broken frame or sound; `major` = clearly hurts clarity or quality, most viewers
notice; `minor` = a careful viewer notices; `nit` = polish.

| Id | Check |
| --- | --- |
| STORY-1 | The premise or question is clear within the first 10% of the film. |
| STORY-2 | One central image or motif recurs, escalates and pays off. |
| STORY-3 | The ending echoes the opening. |
| STORY-4 | No dead stretch: every scene moves the film forward; pacing breathes around the big reads. |
| MSG-1 | The message is shown or said unmistakably. |
| MSG-2 | The viewer's takeaway says the same thing as the message. |
| MSG-3 | Nothing in the film contradicts or dilutes the message. |
| LEARN-1 | Concrete new knowledge for this audience (explainers: at least 5 items per persona). |
| LEARN-2 | Nothing the audience already knows is belaboured. |
| LEARN-3 | Every quiz question is answerable from the film alone. |
| ORIG-1 | The film could not be mistaken for another film; it has its own motif, palette and cast. |
| ORIG-2 | No banned pattern appears. |
| ORIG-3 | References fit the audience; none from the avoid list. |
| MECH-1 | Each beat shows how the thing works, not stock imagery or a literal picture of the words. |
| MECH-2 | Metaphors map onto the real mechanism without teaching something false. |
| MECH-3 | No slide-deck transitions standing in for explanation. |
| CHAR-1 | Characters act: anticipation, squash and stretch, expressions change through a take, never a snap; no sticker pops in and freezes. |
| CHAR-2 | Cast continuity: same design, colours and props every time. |
| CHAR-3 | Siblings never move as mirrored twins; blinks are irregular. |
| CHAR-4 | Screen direction is consistent (who moves which way). |
| READ-1 | One read at a time: the eye knows where to look. |
| READ-2 | Every read is held at least 1.2 s after it is complete. |
| READ-3 | Key reads are held longer and not buried under motion or narration. |
| TEXT-1 | Text is at least 28 px at 1080p (camera finale pull-backs exempt). |
| TEXT-2 | No on-screen sentence repeats the narration. |
| TEXT-3 | Write-ons finish at least 0.3 s before the camera leaves. |
| TEXT-4 | No clipped, overlapping or mis-rendered glyphs (missing letters, mojibake). |
| TEXT-5 | Plain words first; technical names follow the jargon policy. |
| ACC-1 | Every number and fact on screen or in narration is in the claims ledger with a source. |
| ACC-2 | Times are in the viewer's local time zone, daylight saving included. |
| ACC-3 | No invented traits, quotes or behaviour of real people or pets. |
| ACC-4 | Real things are shown with real assets (screenshots, logos, photos), never generated fakes; no invented product UI. |
| ACC-5 | Nothing from the off-screen list appears. |
| ACC-6 | The hard-truths policy is followed. |
| SYNC-1 | A visual beat lands on the word it illustrates (within about 0.15 s). |
| SYNC-2 | Cuts and camera moves sit on the music's beats or bars where the music has a pulse. |
| SYNC-3 | Each sound effect lands on its action. |
| SYNC-4 | Captions match the speech. |
| AUDIO-1 | Narration is intelligible and every word is pronounced right. |
| AUDIO-2 | No audible splices, clicks, cut breaths or tempo artefacts. |
| AUDIO-3 | The music sits under the voice, ducks without pumping and breathes in long gaps. |
| AUDIO-4 | The music's ending lands just after the last line. |
| AUDIO-5 | Effects are restrained: no harsh, shrill or isolated loud hits. |
| AUDIO-6 | Level is consistent from line to line. |
| VIS-1 | Composition: nothing important cut by the frame edge; key content inside a safe margin. |
| VIS-2 | No unintended overlaps or collisions between elements. |
| VIS-3 | Palette, texture and line are consistent with the style bible. |
| VIS-4 | No ghosting, smearing or motion-blur artefacts. |
| VIS-5 | No flicker, popping or jumps between frames (except deliberate boil). |
| VIS-6 | No placeholder stickers or missing art in a final cut. |
| A11Y-1 | Captions are present and accurate. |
| A11Y-2 | Text contrast is sufficient against its background. |
| A11Y-3 | The film still makes sense with the sound off. |
| A11Y-4 | The transcript is complete. |
| A11Y-5 | No rapid flashing. |
| TECH-1 | Duration within 1 s of the film's duration. |
| TECH-2 | Integrated loudness -14.5 +- 0.5 LUFS. |
| TECH-3 | True peak at most -1 dBTP. |
| TECH-4 | Phone copy under 30 MiB. |
| TECH-5 | Captions: SRT and VTT (a missing soft track is minor). |
| TECH-6 | Transcript has every narration line. |
| TECH-7 | Frames are a pure function of time. |
| TECH-8 | Every font advances every letter of a write-on. |
| TECH-9 | Text at least 28 px at 1080p. |
| TECH-10 | Every text readable for at least 1.2 s. |
| TECH-11 | No on-screen text repeating the narration. |
| TECH-12 | Write-ons end at least 0.3 s before a camera move (major). |
| TECH-13 | Film JavaScript is ASCII-only (major). |
| TECH-14 | Expected streams and frame sizes. |
| TECH-15 | A hostable page bundle (major). |

TECH ids are measured by `tools/qa.mjs check`; all TECH defects are blocking unless marked.

## Intent notes (template)

Write `work/direction/intent-notes.md` at creative direction and extend it after every round.

```markdown
# Intent notes: deliberate choices, not defects

- Style: cut-paper collage. Edges are torn and uneven on purpose. Drawn elements jitter slightly
  ("boil") at 15 frames per second; text does not.
- Handwritten text writes itself on letter by letter. A half-written word during its write-on is
  not a truncation; judge text only once it is complete.
- Faint words in brackets under a label are the technical name, kept small and pale on purpose.
- Camera pans have motion blur; the closing pull-back shows the whole layout at a small size on
  purpose.
- The last <N> seconds are the AI-disclosure end card.
- <Film-specific: the deliberately dark scene at 0:31, the silent beat at 0:52, the motif
  changing colour at the payoff, a character who is meant to look worried at 0:20.>
```

## Quiz

Draft it with the script, before any art: at least 5 questions for explainers (film.json
`review.quiz_min` and `learnings_min` set the gates). Each question has one answer the film
states or shows clearly; test the mechanism and the message, not trivia. A persona's score is
its correct answers out of the questions in this file, so a skipped question counts as wrong;
`review.py gates` stops with an error when an explainer has no quiz file. Store it:

```json
{
  "questions": [
    { "q": "What does yeast give off that makes dough rise?", "a": "Carbon dioxide gas", "accept": ["gas", "CO2", "carbon dioxide"] },
    { "q": "What traps the gas inside the dough?", "a": "The gluten network", "accept": ["gluten", "stretchy protein net"] }
  ]
}
```

## Templates for `review.py run` (critic model)

Save each as `work/reviews/prompts/<name>.md`, fill the angle-bracket parts, and pass it with
`--prompt-file`. Keep the sentences that ask for honesty and for blocking-or-not: they separate
polish from real problems.

### director

```text
You are the director reviewing a cut of a short animated film. Watch the whole film with sound.
Judge it as a film, not a slideshow: does it have a premise, a central image that escalates and
pays off, an ending that echoes the opening, characters that act, one read at a time, sound
that lands on the picture?

Score each of these from 0 to 10 with a one-sentence why: story, originality, mechanism,
character, reads, sync, audio, visual_polish, accessibility, overall. Be strict: 8.5 or more
overall means you would show it to the audience today without changes.

List every defect with its time (m:ss.s), severity (blocking, major, minor, nit), a checklist
id (STORY-1..4, MSG-1..3, ORIG-1..3, MECH-1..3, CHAR-1..4, READ-1..3, TEXT-1..5, SYNC-1..4,
AUDIO-1..6, VIS-1..6, A11Y-1..5), the issue and a concrete fix. Say explicitly whether each one
is blocking. Only report what you saw or heard; if you are unsure of a time, give your best
estimate and say so in the issue. Mark maybe_intentional when it could be a deliberate style
choice. Report any banned pattern you see in banned_patterns_seen.

Verdict: ship (no blocking defects and overall >= 8.5), iterate, or rethink (the concept does
not work).
<Anything specific to this cut: what changed since the last round, what to look at closely.>
```

### persona (with quiz)

```text
Watch this film as the persona described below. You know only what the persona knows.

After watching:
1. learned: list every concrete thing you learned that you did not know before. Be picky:
   specific facts, numbers, steps, cause and effect. "It was interesting" is not a learning;
   repeats of what you already knew do not count.
2. confusions: moments (with times) where you lost the thread or could not read something.
3. worries: anything that made you uneasy or that you doubt is true.
4. takeaway: one sentence, in your own words, of what the film is saying.
5. quiz: answer each question below from what the film showed or said. If the film did not
   answer it, say "not in the film". Set "correct": false on every answer; a grader marks them.
6. scores (0-10 with why): message_landed, new_knowledge, reads, accessibility, overall.
7. defects that got in your way (checklist ids MSG, LEARN, READ, TEXT, A11Y), and a verdict.

Quiz questions:
<1. question one>
<2. question two>
<... at least five>
```

### comparer

```text
You are a strict, fair judge. Compare the film's message (above) with one viewer's takeaway
(above). Do they say the same thing? The same core claim must be there, nothing essential may
be missing, and nothing may contradict it; the wording can differ completely.

Set matches_message to true or false. Score message_landed (0-10) with a why that names what
is missing or wrong. If they do not match, add one defect at "0:00" with check MSG-2, severity
blocking, the gap as the issue and what the film must show more clearly as the fix. Verdict:
ship when they match, else iterate. Leave learned, quiz and other arrays empty.
```

### originality

```text
Short animated explainers made by AI agents have converged on one look: cut-paper collage with
image-model stickers, ransom-note titles, a scrapbook board, a warm AI narrator and a gentle
generated music bed. Viewers now say they can pick the next one out blind.

Watch this film and answer: could it be mistaken for another film? Describe the closest
look-alikes (the kind of film, not guessed titles). List every banned pattern from the list
above that appears, using the exact wording, in banned_patterns_seen. Name the default
choices it leans on (layout, transitions, titles, voice, music, palette) and what is
unmistakably its own (motif, cast, palette arc, structure, references).

Score originality (0-10 with why; 7 means a viewer would remember this film as itself) and
give three concrete changes that would make it more its own, as defects with check ORIG-1 or
ORIG-2, times where they apply ("0:00" for the whole film), severity major or minor.
Verdict: ship when originality >= 7 and no banned pattern appears, else iterate.
```

### audio

```text
Listen as a sound engineer to the film's full mix. Judge the narration (intelligibility, every
word pronounced right, natural rhythm, no audible splices, clicks or cut breaths, consistent
level from line to line), the music (sits 9-15 dB under the voice, ducks without pumping,
breathes in long gaps, its final chord lands just after the last line) and the effects (land on
their actions, restrained, nothing harsh or isolated and loud). The absolute loudness is
measured separately; judge the balance, not the level.

Score audio and sync (0-10 with why) and overall. List defects with times and checklist ids
AUDIO-1..6 and SYNC-3, severity, issue and fix; name the exact word for a pronunciation problem.
Verdict: ship, iterate or rethink.
```

## Templates for Claude subagents (free; stored with `review.py ingest`)

Spawn a fresh subagent (not the builder) for each. It writes the JSON to
`$FILM/work/reviews/incoming/<reviewer>[-<persona slug>].json` and nothing else; then run
`python3 "$SKILL/scripts/review.py" ingest --film "$FILM" --round <N> --file <that path>
[--persona "<name>"]` (`--force` replaces a review stored earlier in the round).

### script_persona (round 0, one per persona)

```text
You are <persona name>. You already know: <persona knows>. You want: <persona wants>.
Read the narration script ($FILM/src/script.json), the reads sheet (the "reads" of each line
and of each scene in $FILM/src/storyboard.json, if it exists yet) and the planned on-screen
labels (<list them, or point to the file>). Imagine watching the film they describe.

Write one JSON object valid against $SKILL/references/rubric.schema.json to
$FILM/work/reviews/incoming/script_persona-<persona slug>.json: reviewer "script_persona", cut
"r0", persona "<persona name>". Fill learned (every concrete new thing; be picky), confusions
and worries (objects with "what", starting with the line id; omit "at"), takeaway (one
sentence in your words), quiz (answer each question below from the script alone; "not in the
script" when it does not answer it; set "correct": false on every answer, a grader marks
them), scores message_landed and new_knowledge (0-10 with why), defects with checklist ids
MSG, LEARN, MECH, TEXT, ACC and at "0:00", and a verdict. The film's message is: "<message>".
Do not judge the art or sound; they do not exist yet.

Quiz questions:
<1. question one>
<... every question in work/direction/quiz.json, without the answers>
```

Then, per persona, two more fresh subagents: the quiz grader (below) on
`script_persona-<slug>.json`, and the comparer (the `review.py run` template plus the $0
context block, with that persona's takeaway, `cut` "r0") writing
`incoming/comparer-<slug>.json`. Ingest all of them with `--round 0`.

Gate: every persona's comparer says `matches_message: true`; explainers list at least
`learnings_min` concrete learnings and answer every quiz question correctly from the script;
no blocking confusion about the mechanism. Otherwise rewrite the script (or a question the
script was never meant to answer) and run the gate again.

### fact_checker

```text
You are the fact-checker for a short film. Read:
- $FILM/film.json (topic, sources, offscreen list, subjects and their consent, hard_truths,
  jargon policy),
- $FILM/work/research/claims.json (the claims ledger),
- $FILM/src/script.json (narration),
- every on-screen text: <run node $FILM/tools/render.mjs text <times> --film $FILM at the times
  listed in the resolved storyboard, or read the text elements in $FILM/src/storyboard.json>.

For every factual statement in narration or on screen (numbers, times, names, causes,
behaviour of real people or animals): find it in the ledger and give it a status: verified
(a source supports it and is recent enough), stale, conflict (sources disagree), unsourced, or
offscreen_violation (it shows something from the offscreen list). Check that times are in the
viewer's local zone with daylight saving handled, numbers match their sources exactly, nothing
invents traits, quotes or behaviour of real people or pets, real things are not generated
fakes, and the hard-truths policy is followed.

Write one JSON object valid against $SKILL/references/rubric.schema.json to
$FILM/work/reviews/incoming/fact_checker.json: reviewer "fact_checker", cut "r<N>",
scores.accuracy (0-10 with why), claims [{text, where (line id or label id), source (with
date), status}], defects with checklist ids ACC-1..6 (time of the line or label, severity
blocking for anything false or off-screen), and a verdict.
```

### frame_qa

```text
You are frame QA for a short animated film. Look at every image below with the Read tool:
<$FILM/work/qa/contact.jpg (or several contact sheets), strips around each camera move and
take, crops of every text block and face>. Also read the output of
node $FILM/tools/qa.mjs text-check --film $FILM --json: <paste or give the path>.

Check: text size and legibility, clipped or overlapping text, missing letters, write-ons still
running when the camera leaves, one read at a time, composition and safe margins, element
collisions, placeholder stickers, palette and style consistency, characters that act (the
strips show anticipation, squash and settle, and expressions change inside a squash), mirrored
twin motion, motion-blur artefacts.

Report only what an image shows. Each defect: the time from the image label (m:ss.s), severity,
checklist id (TEXT, READ, VIS, CHAR, A11Y-2), the issue naming the image file, and a fix. Write
one JSON object valid against $SKILL/references/rubric.schema.json to
$FILM/work/reviews/incoming/frame_qa.json: reviewer "frame_qa", cut "r<N>", scores reads,
visual_polish, character and accessibility (0-10 with why), defects, verdict. Intent notes (not
defects): <paste work/direction/intent-notes.md>.
```

### quiz grader (after each persona review)

```text
Grade one viewer's quiz. The answer key is $FILM/work/direction/quiz.json (q, a, accept). The
viewer's review is <$FILM/work/reviews/r<N>/persona-<slug>.json, or at round 0
$FILM/work/reviews/incoming/script_persona-<slug>.json>. For each quiz entry set "correct" to
true when the answer matches the key in substance (wording may differ; "not in the film" or
"not in the script" is false), false otherwise. For every question of the key that the viewer
did not answer, add {"q": "<the question>", "a": "not answered", "correct": false}. Change
nothing else. Write the full review JSON to
$FILM/work/reviews/incoming/<persona|script_persona>-<slug>.json.
```

Then store it over the ungraded one:
`python3 "$SKILL/scripts/review.py" ingest --film "$FILM" --round <N> --file <that path> --persona "<name>" --force`.

### originality (creative direction, before any art)

```text
Read $FILM/work/direction/concept.md and $FILM/work/direction/style-bible.md. Short animated
explainers made by AI agents have converged on one look: cut-paper collage with image-model
stickers, ransom-note titles, a scrapbook board tour, a warm AI narrator and a gentle
generated music bed. Could the film these files describe be mistaken for another film? Which
of these banned patterns does it plan to use: <film.json style.banned_patterns>? What default
choices does it lean on? Give a score from 0 to 10 (7 = a viewer would remember it as itself)
and three concrete changes to the motif, palette, cast, structure or sound that would make it
unmistakably its own. Write the answer in plain text to $FILM/work/direction/originality.md,
with the score alone (a number) on line 1.
```

## Judging prompts for `critic.py ask` (not rubric reviews)

`python3 "$SKILL/scripts/critic.py" ask --film "$FILM" --prompt-file <file> [--audio F ...]
[--video F] [--images F ...] [--tier draft|final|signoff] --stage <voice|animatic|assets> --name
<label>` prints the reply and saves it to `work/critic/`; `--stage` files the spend under the
matching quote stage (voice for auditions and take picks, animatic, assets for the music pick).

### voice audition

```text
These are auditions of the same line in different voices (file names are the voice names).
The film: <topic>, tone <tone>, for <audience>. Pick the one voice that fits best and will
carry <duration> seconds without tiring the listener; rank the rest. Note any mispronounced
word per voice. Avoid the over-familiar "warm AI narrator with a smile in every word" unless
the tone asks for it. Reply with the winning file name on the first line, then your reasons.
```

### take picks

```text
Each line of narration has several takes (file names <line>_<take>.wav). The transcript check
found: <paste the per-take summary printed by voice.py check>. For each line pick the take with
the clearest diction, correct pronunciation, natural rhythm and energy that matches the lines
around it. Reply with a JSON object {"picks": {"<line>": <take>, ...}, "notes": {"<line>": "..."}}.
```

### music pick

```text
These are candidate music beds for a <duration>-second film, tone <tone>. Pick the one that
leaves room for a voice (no vocals, no busy melody in the voice range), has a steady pulse, and
ends on a clear final chord. Rank the rest and say where each one's final chord is (m:ss).
Reply with the winning file name on the first line.
```

### animatic

```text
This is an animatic: draft art, placeholder stickers (a dashed outline with a name) and simple
motion are expected; judge only the film underneath. <Critic: Watch it with sound. | $0 film:
You see a contact sheet of the animatic (a frame every 2 s, labelled with its time) and read the
script with its line timings; judge picture and timing from them.> For each scene: is there
one read at a time, is each read held long enough, is the mechanism shown rather than
illustrated, does the voice line up with the picture? Where would a viewer get lost? Does the
message land by the end? List problems with times and a fix each, then answer GO or NO-GO on
the first line of a final paragraph.
```

## Ship gates

`python3 "$SKILL/scripts/review.py" gates --film "$FILM" --round <N>` computes every gate from
the round's reviews and writes `gates.json`; exit 0 = ship.

| Gate | Passes when | Fed by |
| --- | --- | --- |
| director | overall >= 8.5 (`review.director_min`); a `-signoff` director review, when present, is decisive | director |
| blocking | no counted blocking defect (defect rule above) | every review + `confirmed.json` |
| message | every persona's takeaway matches the message | comparer, one per persona |
| quiz | every persona >= 80% (`review.quiz_min`) of the questions in `work/direction/quiz.json`, explainers only | graded persona reviews |
| learned | every persona lists >= 5 concrete learnings (`review.learnings_min`), explainers only | persona |
| originality | originality >= 7 (`review.originality_min`) and no banned pattern seen by any reviewer | originality (else the director's score) |
| claims | every claim verified or in `accepted_claims.json`; no off-screen violation (fiction passes without a fact-checker: `sources: [{"kind": "none"}]`, or empty sources on a story or music video) | fact_checker |
| technical | the round's technical review ships: no TECH defect of any severity (this covers TECH-4, 7, 8 and 12-15, which have no gate of their own) | technical |
| tech-10, tech-9, tech-11 | reads held >= 1.2 s; text >= 28 px at 1080p; no on-screen sentence repeating the narration | technical |
| tech-1, tech-2, tech-3 | duration +- 1 s; -14.5 +- 0.5 LUFS; true peak <= -1 dBTP | technical |
| tech-5, tech-6 | captions (SRT + VTT) and transcript present | technical |

A round with an invalid review file also fails (`gates.json` `invalid`); files that are not
review names are listed under `ignored` and do not count.

Verdicts: `ship`; `iterate` (fix the counted defects and failed gates, re-export, run the next
round; a failed sign-off is an ordinary iterate); `stop` at round `review.rounds` (default 4)
without passing: stop iterating and report the open gates to the user in `out/report.md`. $0
films have no sign-off pass.
