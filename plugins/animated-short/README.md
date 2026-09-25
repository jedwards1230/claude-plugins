# animated-short

A Claude Code skill for making short animated films (15-180 s) about any topic: explainers,
stories, promos. It asks one batched round of questions, then runs the whole production:
research with a claims ledger, a script reviewed by audience personas, generated narration,
music and sticker art, a build on a bundled deterministic canvas engine, frame QA, a
multi-reviewer ship gate, and delivery.

What you get for each film:

- a live web page (canvas plus Web Audio) with captions, notes and a credits card;
- MP4s: a 1080-line master, a smaller share copy and a 720-line phone copy under 30 MiB;
- SRT and VTT captions, a transcript, an AI-made note and credits naming the models used;
- the editable film directory (inputs, script, storyboard, shots, art) and a report of spend,
  gate results and anything left for you to decide.

The skill optimizes for what the audience learns, not how polished it looks: intake asks what
the audience already knows, every fact goes through a claims ledger, and a film ships only when
persona reviewers restate the message, pass a comprehension quiz and list concrete things they
learned, alongside director, originality, audio, fact-check and technical gates.

## Requirements

- Node.js 18 or newer, with npm.
- Chromium for headless rendering. The tools find Playwright's own download, `~/.cache/ms-playwright`,
  a system Chromium or Chrome, or `--chromium <path>` / `CHROMIUM_PATH`. To install one:
  `npx playwright install chromium`.
- ffmpeg and ffprobe: optional. With them, MP4s are H.264 + AAC with measured two-pass
  loudness; without them, MP4s are encoded in the browser (H.264 + Opus via WebCodecs).
- Python 3.10 or newer with `skills/animated-short/scripts/requirements.txt` (numpy, pillow;
  librosa and soundfile optional).
- For generated voice, music, art and video reviews: an OpenRouter API key, read from the
  environment variable `OPENROUTER_API_KEY` or a key file passed with `--key-file`. Without a
  key the skill makes $0 films (code-drawn art, synthesized music, captions instead of voice,
  reviews by Claude subagents).

## Install

```bash
/plugin marketplace add jedwards1230/claude-plugins
/plugin install animated-short@jedwards1230-plugins
```

## Quick start

Ask for a film in plain words:

```
> Make a 60-second animated explainer about how a bicycle gear works, for kids who ride bikes
> Make a short animated story about a lighthouse keeper who adopts a seagull
> Make a 30-second vertical promo video for our note-taking app, using these screenshots
```

The skill runs a free preflight, asks its intake questions in one batch (message, audience
and what they already know, how to handle uncomfortable facts, length and shape, references,
tone, voice, music, sources, budget, autonomy), then works autonomously to delivery unless you
asked to approve the animatic or each phase.

## Cost

Every paid call goes through one spend ledger per film: it reserves an estimate before each
call, records the provider's reported cost, and refuses anything that would pass the film's
`budget_usd` (default $10) or an optional account ceiling. The skill quotes each stage before
spending. A typical 60-90 s film at the defaults costs about $2-4 (sticker sheets are most of
it); a draft tier keeps the animatic cheap; results are cached so retries are free. A film
with `budget_usd: 0` makes no paid calls at all.

## Providers and licensing

- Default provider preset: OpenRouter (Gemini TTS, Whisper word timing, Lyria music, Nano
  Banana sticker sheets, Gemini as the critic that watches the cut). Every role is swappable
  in `skills/animated-short/scripts/providers/registry.json`; preflight probes each role and
  falls back only on availability errors. Sound effects are synthesized in the engine.
- Commercial-safe by default: models and weights with non-commercial terms are filtered out
  unless a film opts out explicitly. Voice cloning of a real person needs their consent.
- Generated voice, music and images from Google models carry SynthID watermarks; the credits
  card says so.
- You are responsible for the rights to any track, photo, logo or screenshot you supply.

## Third-party software

The bundled engine installs two npm dependencies into each film directory (never vendored in
this repository):

- [playwright-core](https://github.com/microsoft/playwright) (Apache-2.0): drives headless
  Chromium for rendering.
- [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0): muxes the in-browser
  WebCodecs MP4 export. Used unmodified as an npm dependency; its license file ships with it.

Optional Python packages (numpy, pillow, librosa, soundfile, whisperx) keep their own licenses.

## Conformance test

A 10-second golden film exercises every engine feature at $0 (no network except
`npm install`, no provider calls):

```bash
bash plugins/animated-short/skills/animated-short/scripts/test-golden.sh --scaffold-py --out /tmp/golden-test
bash plugins/animated-short/skills/animated-short/scripts/test-golden.sh --scaffold-py --out /tmp/golden-test-wc --no-ffmpeg
```

Each run builds a fresh film from `examples/golden`, then resolves, renders stills, checks
glyphs, frame purity and text rules, makes QA images, exports every deliverable and runs the
technical gate; it prints a PASS/FAIL table. The Python tools have offline unit tests (a fake
provider server, $0):

```bash
cd plugins/animated-short/skills/animated-short/scripts/tests && python3 -m unittest discover -s .
```

## Layout

```
skills/animated-short/
  SKILL.md                 the workflow: rules, phases and gates, intake, spend, briefs
  references/              inputs, phases, storyboard, acting kit, style preset, reviews,
                           providers, engines, delivery, pitfalls, JSON schemas
  engine/                  the film template: player page, canvas engine, render/export/QA tools
  scripts/                 scaffold, preflight, quote, ledger, voice, music, art, critic, review
  examples/golden/         the 10-second conformance film
```
