# Inputs: film.json

Every film starts from `film.json` in the film directory, validated against
`$SKILL/references/film.schema.json` (`$SKILL` is the skill's base directory). Three fields are
required: `topic`, `goal`, `message`. Everything else has a default. Intake asks for what is
missing in one batched round (`intake.md`) and writes the file; `scaffold.py new --film-json`
validates it, fills the defaults and derives `web/film/config.json`. After editing film.json,
run `python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"` and resolve again.

Validate by hand: `python3 "$SKILL/scripts/schema.py" validate "$SKILL/references/film.schema.json" "$FILM/film.json"`.
Print it with defaults: `python3 "$SKILL/scripts/schema.py" defaults "$SKILL/references/film.schema.json" "$FILM/film.json"`.

## What and why

| Field | Default | What it controls | Example |
| --- | --- | --- | --- |
| `topic` | required | What the film is about, in a few words. | "How bread rises" |
| `goal` | required | What viewers should understand or do afterwards. | "Understand why dough needs time and warmth, and what yeast actually does." |
| `message` | required | The one sentence viewers should repeat back. The comparer scores every persona's takeaway against it. | "Yeast eats sugar and breathes out gas, and the gluten net traps it like a balloon." |
| `title` | the topic | Title on the page (its static `<title>` too), the poster and file metadata; also the output file slug. | "Why Bread Rises" |
| `subtitle` | `""` | One line under the title on the page; also the page's description tag (empty: the `message`). | "Ninety seconds inside a bowl of dough." |
| `form` | `explainer` | `explainer`, `story`, `promo`, `music_video`, `data_story`. Explainers must pass the quiz and learnings gates. | `promo` for a fictional app launch |
| `audience` | one "curious non-expert" who knows nothing specific | Personas: `[{name, knows, wants?}]`. Each becomes a persona reviewer and quiz-taker. `knows` is the prior knowledge: the film must teach them something new. | `[{"name": "a home baker", "knows": "Follows recipes; has never heard the word gluten.", "wants": "to stop making flat loaves"}]` |
| `depth` | `lived-in` | `overview` (broad tour) or `lived-in` (follow one concrete thing through, with real numbers and routines). Lived-in teaches more. | follow one loaf from mixing to oven |

## Look and sound

| Field | Default | What it controls | Example |
| --- | --- | --- | --- |
| `style.preset` | `collage` | The only preset (`style-presets/collage.md`). | `collage` |
| `style.palette` | engine defaults | A list of hex colours (first = accent; the list also colours board panels and ransom letters; swatch names c1, c2, ...) or an object of engine palette keys (`ground`, `board`, `paper`, `ink`, `pencil`, `accent`, `swatches`, `panels`, `ransom`, ...). Sticker-sheet prompts get the list, or an object's `accent`, `ink`, `paper` and `swatches` (grounds are left out). | `["#C8553D", "#F2D0A4", "#588B8B", "#2E2E3A"]` |
| `style.fonts` | engine stacks | `{display, body, hand, faces}`: families or CSS stacks; `faces` are local `.woff2` files under `web/fonts/` (`[{family, src, weight?, style?}]`); a face that fails to load fails the glyph test. Declare a single-weight hand font as `"weight": "400 700"` (the heading and body styles draw at 700). | see `style-presets/collage.md` |
| `style.texture` | `"paper grain, torn edges, tape"` | Surface words for art prompts and the style bible. | `"flour-dusted kraft paper, torn edges"` |
| `style.motif` | none | The one central image that escalates and pays off. | "a balloon that grows with every scene" |
| `style.banned_patterns` | `[]` | Looks and moves this film must not use; the originality reviewer checks them. Start from the preset's default list. | "ransom letters on every card" |
| `style.references_to_use` | `[]` | Cultural references or gags that fit the audience. | "the proofing drawer every baker forgets about" |
| `style.references_to_avoid` | `[]` | References that must not appear. | "diet culture jokes" |
| `tone` | `warm` | whimsical, warm, calm, wry, documentary, or any short description. | "wry and warm" |
| `duration` | 90 | Seconds; 15-180 for a real film (5 is allowed for tests). Sets the word budget: about 2.5 words per second. | 60 |
| `aspect` | `16:9` | `16:9` (1920x1080), `9:16` (1080x1920), `1:1` (1080x1080). | `9:16` for phones |
| `language` | `en` | Narration language (ISO 639-1) for TTS checks and alignment. | `de` |
| `voice.mode` | `audition` | `audition` (try several voices on one line and judge), `named` (use `voice.name`), `none` (no narration; captions come from hand-written timings). A film has one narrator: the TTS model, voice and style are pinned at the first take, and on-screen characters do not get voices of their own. | `named` |
| `voice.name` | none | TTS voice name; required when mode is `named`. `voice.py audition` without `--voices` tries the model's default voice list (`audition_voices` in the provider registry). | a Gemini prebuilt voice name |
| `voice.style` | none | Delivery direction sent with every take. | "Unhurried, warm, a smile in the voice, crisp consonants." |
| `voice.takes` | 3 | Takes per line (1-8); each is transcript-checked. | 3 |
| `voice.lead_in` / `voice.gap` | 0.6 / 0.57 | Seconds before the first line / between lines when `voice.py words` lays lines out. | 0.8 / 0.5 |
| `pronunciations` | `{}` | Word -> respelling the TTS reads correctly (captions keep the real spelling). | `{"levain": "leh-VAN"}` |
| `music.mode` | `generated` | `generated` (model-made candidates), `file` (the user's track; the user must hold the rights), `synth` (the engine's $0 pad), `none`. | `synth` for a $0 draft |
| `music.prompt` | none | Mood and instrumentation for generated music. | "Gentle upright bass and brushed snare, 90 BPM, warm, no vocals, a clear final chord." |
| `music.file` | none | The user's track when mode is `file`. | `/path/to/track.mp3` |
| `music.candidates` | 3 | Generated candidates to judge (1-6). | 3 |
| `sfx` | `synthesized` | Engine-synthesized effects from the storyboard event list, or `none`. | `synthesized` |
| `art.mode` | `generated` | `generated` (image-model sticker sheets) or `code` (everything drawn in code, $0). | `code` |
| `art.sheets` | the duration / 15, rounded up, 2-8 (45 s: 3, 90 s: 6) | Expected final sheets (for the quote); scaffold fills it in. | 5 |
| `art.draft_first` | true | Cheap 1K draft sheets for the animatic before final art. | true |

## Truth and care

| Field | Default | What it controls | Example |
| --- | --- | --- | --- |
| `sources` | `[]` (asked at intake) | `[{kind, ref}]`, kind `web`, `docs`, `repo`, `live` (read-only systems), `none` (fiction: research is skipped). Left empty, it follows the form: web research for `explainer`, `promo` and `data_story`; none (fiction) for `story` and `music_video`. | `[{"kind": "web", "ref": "baking science references"}]` |
| `real_assets` | `[]` | `[{path, what}]`: screenshots, logos, photos used as they are or as references; never replaced with generated fakes. | `[{"path": "assets/app-home.png", "what": "real home screen of the app, show as is"}]` |
| `subjects` | `[]` | `[{name, kind, consent, notes?}]`: real people, pets or places. No consent = do not depict. Never invent their traits, quotes or behaviour. | `[{"name": "the founder", "kind": "person", "consent": true}]` |
| `offscreen` | street addresses, IP addresses, domain names, credentials, private names | Must never appear on screen or in narration; the fact-checker flags violations. | add "customer names" |
| `hard_truths` | `ask` | When research finds uncomfortable facts: `include`, `soften`, `omit`, or `ask` (stop and ask the user when one turns up). Always asked at intake unless film.json sets it. When nobody can be asked (a supplied film.json, an unattended run), `ask` falls back to `omit` and the report lists what was left out. | `soften` |
| `jargon` | `brackets` | Technical names `hide`, faint and bracketed under the plain words (`brackets`), or `show`. | `brackets` |
| `disclosure.card` | true | Credits and the AI-made note on the page. | true |
| `disclosure.end_card` | true | A disclosure card over the last `seconds` of the film itself (capped at 40% of the film). Finish the story before it. | false for a promo |
| `disclosure.seconds` / `title` / `lines` | 3.2 / "Made with AI" / the credits | End card length, title, lines. The card is fully legible for `seconds` minus its 0.4 s fade-in and the film's fade-out (2% of the duration, 0.25-0.8 s): 2.0 s at 3.2 on a film of 40 s or more; `resolve.mjs` warns under 2.0 s. Short `lines` read in that window. | 3.5 |
| `disclosure.note` | "Made with AI. The credits list the models and tools used." | The note on the page, in the transcript and in the MP4 comment; `""` turns it off. | |
| `credits` | keep config.json's | Models and tools used, people, sources: strings or `{role, name}`. What to list and when: `delivery.md`, "Credits and disclosure". | `[{"role": "Voice", "name": "a Gemini TTS model"}]` |
| `notes` | keep config.json's | Short notes under the player: `[{title, text}]`. | `[{"title": "Sources", "text": "..."}]` |
| `captions` | true | Captions on by default in the live player. | true |

## Machinery and review

| Field | Default | What it controls |
| --- | --- | --- |
| `engine` | `canvas` | Rendering adapter (`engines.md`). |
| `providers.preset` | `openrouter` | Provider preset (`providers.md`). |
| `providers.commercial_safe` | true | Filter out models and weights whose terms are non-commercial before anything else. |
| `providers.roles.{tts, align, music, image, critic, video}` | null (registry order) | A model id or registry candidate id to try first for that role. `video` is opt-in and unused by the tools. |
| `budget_usd` | 10 | Hard cap across every paid call for this film (`ledger.jsonl`). 0 = no paid calls at all. |
| `account_ceiling_usd` | null (none) | Optional hard stop on the whole account: a paid call is refused when the account's reported usage (GET /key) plus open reservations plus the call would pass it. `--account-ceiling` and env `ANIMATED_SHORT_ACCOUNT_CEILING` win over it. |
| `delivery` | `["page", "mp4"]` | Any of `page`, `mp4`, `webm`, `bundle` (`delivery.md`). The page is always produced. |
| `autonomy` | `intake_once` | `intake_once` (one question round, then autonomous), `approve_animatic` (also stop at the animatic), `approve_each_phase`. |
| `review.rounds` | 4 | Maximum film-review rounds. |
| `review.director_min` | 8.5 | Director overall score needed to ship. |
| `review.quiz_min` | 0.8 | Fraction of quiz answers each persona must get right (explainers). |
| `review.learnings_min` | 5 | Concrete new learnings each persona must list (explainers). |
| `review.originality_min` | 7 | Originality score needed to ship. |
| `output_dir` | `out` | Deliverables directory, relative to the film. Keep `out`: `export.mjs` writes there unless given `--out`. |

## A complete film.json

```json
{
  "topic": "How bread rises",
  "goal": "Understand why dough needs time and warmth, and what yeast actually does.",
  "message": "Yeast eats sugar and breathes out gas, and the gluten net traps it like a balloon.",
  "title": "Why Bread Rises",
  "form": "explainer",
  "audience": [
    { "name": "a home baker", "knows": "Follows recipes; has never heard the word gluten.", "wants": "to stop making flat loaves" },
    { "name": "a curious twelve-year-old", "knows": "Knows bread has yeast in it, nothing more." }
  ],
  "depth": "lived-in",
  "style": {
    "palette": ["#C8553D", "#F2D0A4", "#588B8B", "#2E2E3A", "#FFD5C2"],
    "motif": "a balloon that grows with every scene and finally becomes the loaf",
    "banned_patterns": ["ransom-note letters on every card", "a paper-rip transition between scenes"],
    "references_to_use": ["the proofing drawer every baker forgets about"]
  },
  "tone": "wry and warm",
  "duration": 75,
  "aspect": "16:9",
  "voice": { "mode": "audition", "style": "Unhurried and warm, crisp consonants." },
  "music": { "mode": "generated", "prompt": "Brushed snare and upright bass, 90 BPM, cosy, no vocals, a clear final chord." },
  "sources": [{ "kind": "web", "ref": "food-science references and university extension pages" }],
  "hard_truths": "soften",
  "budget_usd": 5,
  "autonomy": "intake_once"
}
```
