# Intake: the one question round

Intake turns a request into `film.json` with as few questions as possible, all asked at once.
`$SKILL` is the skill's base directory and `$FILM` the film directory (SKILL.md defines both).

## When to skip it

Skip intake entirely when the user supplies a film.json with `topic`, `goal` and `message`: its
missing fields take their defaults (`inputs.md`), and its `hard_truths` (default `ask`) applies
when research finds something uncomfortable. If nobody can answer then (an unattended run),
`ask` falls back to `omit`: the hard truths are left out and the report lists them. Otherwise run the free preflight first, before any
film directory exists (`python3 "$SKILL/scripts/preflight.py"`, plus `--key-file <path>` when the
key is not in `OPENROUTER_API_KEY`; phase 1), so every option offered actually works on this
machine and key.

## Procedure

1. State the full question list to the user, one line each, so the whole decision surface is
   visible at once.
2. Ask through AskUserQuestion, back to back: at most 4 questions per call and 2-4 options each,
   everything answerable now in calls 1-3. Draft concrete options from the request (the tool adds
   a free-text "Other"). Drop a question whose answer the request already gives; keep the
   hard-truths question unless film.json sets it. Offer only options preflight says work.
3. Ask call 4 (follow-ups) only for the answers that need one: those questions depend on
   answers given in calls 1-3, so they cannot share a call with them.
4. Write the answers as `$FILM/film.json` (fields: `inputs.md`), scaffold it in place (phase 2)
   and continue without further questions unless film.json `autonomy` or the `ask` hard-truths
   policy says otherwise.

## Call 1: substance

- Message: "Which sentence should viewers be able to repeat after watching?" Options: two or
  three candidate messages drafted from the request. -> `message`
- Audience (multiSelect): "Who is this for, and what do they already know about <topic>?"
  Options: two to four personas with their prior knowledge, e.g. "Newcomer: knows nothing
  specific", "Practitioner: knows the basics, wants the details", "Kids 8-12". -> `audience[]`
  (`name`, `knows`)
- Hard truths: "If research turns up uncomfortable facts, what should the film do?" Options:
  "Include them plainly", "Soften them", "Leave them out and tell me", "Ask me each time".
  -> `hard_truths` (`include`, `soften`, `omit`, `ask`)
- Form: "What kind of film, how long, what shape?" Options such as "Explainer, 60 s, 16:9
  (Recommended)", "Explainer, 90 s, 16:9", "Story, 60 s, 16:9", "Promo, 30 s, 9:16". -> `form`,
  `duration`, `aspect`

If the request leaves the topic or goal unclear, ask those in this call instead of Form.

## Call 2: look and sound

- References (multiSelect): "Which cultural references fit this audience, and which must be
  avoided?" Options: two or three references that suit the audience and topic, plus "None: keep
  it literal". Avoid-lists come from "Other" answers. -> `style.references_to_use`,
  `style.references_to_avoid`
- Tone: "warm (Recommended)", "whimsical", "calm, documentary", "wry". -> `tone`
- Voice: "Audition voices and pick the best (Recommended)", "Use a voice I name", "No
  narration: captions and music only". -> `voice.mode` (`audition`, `named`, `none`)
- Music: "Generated bed, candidates judged (Recommended)", "My own track (I hold the rights)",
  "Synthesized pad ($0)", "No music". -> `music.mode` (`generated`, `file`, `synth`, `none`)

## Call 3: truth, money, control

- Sources (multiSelect): "Where should the facts come from?" Options: "Web research
  (Recommended)", "Docs, repos or files I will point to", "Live read-only systems I will name",
  "None: it is fiction". -> `sources[].kind` (`web`, `docs` or `repo`, `live`, `none`)
- Budget: "Spending cap for voice, art, music and AI reviews (the OpenRouter key pays for
  them)?" Options: "$10, the default (a typical film costs $2-4) (Recommended)", "$5", "$3
  (fewer sheets and review rounds)", "$0: code-drawn art, no narration, synthesized music".
  -> `budget_usd`
- Real subjects: "Should real people, pets, products or logos appear?" Options: "No", "Yes: I
  will provide photos or screenshots and consent", "Products or logos only, from files I
  provide". -> `subjects[]`, `real_assets[]`
- Autonomy: "After these questions, how involved do you want to be?" Options: "Not at all until
  delivery (Recommended)", "Approve the animatic", "Approve every phase". -> `autonomy`
  (`intake_once`, `approve_animatic`, `approve_each_phase`)

## Call 4: follow-ups (only when an earlier answer needs one)

- Key, when preflight found no key and the budget is above $0: "Where is the OpenRouter API
  key?" Options: "In OPENROUTER_API_KEY (I will set it)", "In a file: I will give the path",
  "No key: make a $0 film". Take a file path from "Other" or the next message and pass it as
  `--key-file`; never open, print or copy the key itself.
- Source locations, when Sources named docs, repos, files or live systems: "Which paths, URLs
  or systems, and which of them are read-only?" -> `sources[].ref`
- Voice name, when Voice is "Use a voice I name": options from the TTS model's
  `audition_voices` (`$SKILL/scripts/providers/registry.json`). -> `voice.name`
- Track, when Music is "My own track": the file path. -> `music.file`
- Real subjects, when Real subjects is yes: the photo or screenshot paths, and for each person
  or pet, consent. -> `subjects[].consent`, `real_assets[].path`

## Defaults for anything not asked

Everything else takes the film.json defaults (`inputs.md`): jargon in brackets, lived-in depth,
the standard offscreen list, commercial-safe providers, `budget_usd` 10, `autonomy`
`intake_once`, the credits card and the end card on. `sources` left empty (intake skipped, or
the question dropped) means web research for an explainer, promo or data story, and no research
(fiction) for a story or music video, unless the user named sources in the request.
