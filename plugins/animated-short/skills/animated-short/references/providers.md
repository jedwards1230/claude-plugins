# Providers: roles, keys, spend, fallbacks

Generated media are ingredients: narration, word timings, music, sticker sheets and a critic
that watches the cut. Code draws every frame and synthesizes every sound effect. Providers sit
behind one interface and one registry (`$SKILL/scripts/providers/registry.json`), so any role
can be swapped. `$SKILL` is the skill's base directory and `$FILM` the film directory.

## The key

- Every paid tool reads the OpenRouter key from the environment variable `OPENROUTER_API_KEY`,
  or from `--key-file <path>` (a file of `KEY=VALUE` lines containing `OPENROUTER_API_KEY=...`,
  `export` and quotes allowed, or a file holding only the key).
- Ask the user where the key is; never guess a path, never hard-code one in a film.
- Never print, echo, log or commit the key, and never put it on a command line. Pass the file
  path, not the value. The tools never print it either.
- For a hard stop on the whole account, also pass `--account-ceiling <usd>` (or set
  `ANIMATED_SHORT_ACCOUNT_CEILING`): a paid call is refused when the account's reported usage
  (GET /key) plus open reservations plus this call would pass it. A dedicated key with its own
  limit (set in the OpenRouter dashboard) is the strongest guard of all.

Tools that take the key (`[P]` = `--key-file F` and optionally `--account-ceiling USD`):
`preflight.py`, `ledger.py reconcile`, `voice.py audition|takes|check|words`, `music.py gen`,
`art.py sheet`, `critic.py ask`, `review.py run`. They also accept `--no-cache` (ignore the
cache and pay again; rarely wanted, see Cache below).

Environment variables: `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (API base override, for
tests), `ANIMATED_SHORT_ACCOUNT_CEILING`, `ANIMATED_SHORT_RETRY_BASE` (retry backoff seconds),
`ANIMATED_SHORT_HTTP_TIMEOUT`, `ANIMATED_SHORT_REGISTRY` (an alternative registry file),
`ANIMATED_SHORT_WHISPERX_DEVICE` (`cpu` or `cuda`).

Exit codes of every Python tool: 0 ok, 1 gate or validation failure, 2 usage or environment
error, 3 budget refusal, 4 provider unavailable after fallbacks (including a sticky failure).

## Roles and defaults (preset `openrouter`)

| Role | Default chain (in order) | Draft tier | Notes |
| --- | --- | --- | --- |
| `tts` | google/gemini-3.8-flash-tts, google/gemini-3.1-flash-tts-preview, google/gemini-3.8-flash-lite-tts | same | PCM 24 kHz converted to WAV; style prompt per take; SynthID watermark (inaudible). hexgrad/kokoro-82m is opt-in (different voices, no style prompt). Cost is always an estimate (the endpoint reports none). |
| `align` | openai/whisper-1 (until 2027-02-26), openai/whisper-large-v3, local WhisperX (if installed), local energy aligner | same | Word timestamps; doubles as the pronunciation check. A reply without word times counts as unavailable. The energy aligner is $0 and coarse: it cannot catch mispronunciations. |
| `music` | google/lyria-3-pro-preview (~$0.08 per song) | google/lyria-3-clip-preview (~$0.04 per 30 s clip) | Length is not controllable: beat-track and cut on downbeats (`music.py cut`). |
| `image` | google/gemini-3-pro-image-preview (4K, ~$0.25-0.30 per sheet), google/gemini-3-pro-image (2K) | google/gemini-3.1-flash-image (1K), -preview | No alpha: sheets use flat grey and are cut out. Opt-in: gpt-image-2, recraft-v4.1, flux.2-pro, seedream-4.5 (no reference images through these), gemini-2.5-flash-image (until 2026-10-02). |
| `critic` | google/gemini-3.8-flash (~1 cent per 90 s film) | same | Watches video with audio, listens, looks at stills. A different model family from the builder. Sign-off tier: google/gemini-3.1-pro-preview, google/gemini-2.5-pro. |
| `video` | none | none | Opt-in registry entries only (Veo 3.1, Kling 3.0); no tool uses the role. |
| sound effects | synthesized in the engine | | 25 types from the storyboard's `sfx` list; $0. |

Override a role for one film with film.json `providers.roles.<role>` (a model id or registry
candidate id), or per command with `--model`. An override must pass the license filter.

## Preflight: probe, then plan

```bash
python3 "$SKILL/scripts/preflight.py" --film "$FILM" --key-file <path>            # tier 0, free
python3 "$SKILL/scripts/preflight.py" --film "$FILM" --key-file <path> --tier 1   # sub-cent real calls
```

- Tier 0 (free): tools (Node 18+, npm, ffmpeg/ffprobe, Chromium via the film's glyph test,
  Python packages), the key and its remaining limit (GET /key), each candidate's catalog entry
  and output modality (GET /models?output_modalities=all), the license filter, the delivery
  probe, and a quote. It works before the film exists (judged with default inputs); run it
  again after scaffolding and `npm install`.
- Tier 1 (a few cents at most, needs a scaffolded film): one real call each for tts, align and
  critic through the normal fallback walker. Catalogs lie: a model can be listed and still
  return 402 or 404 for a given key. Run it whenever `budget_usd > 0`, before planning.
- Report: `work/preflight.json`; exit 1 when a role the film needs has no working provider or
  no requested delivery mode is available. A `budget_usd` of 0 needs no critic: every review
  is then a Claude subagent (`review.py ingest`).

## Fallbacks and sticky choices

- The walker tries candidates in registry order after four filters: license (commercial_safe),
  opt-in, retirement date, block list (Sora is blocked: shut down though still listed).
- It moves to the next candidate only on availability errors: 401, 402, 403, 404, 408, 429
  after retries, 5xx, timeouts, unsupported-parameter replies, empty outputs. Anything else is
  a real failure and comes back to you; quality problems go to the review loop, not to a
  different model.
- Sticky choices never switch mid-film: the TTS model, voice and style, and the image model per
  tier, are pinned in `work/state.json` on first success. If a pinned choice fails, the tool
  stops (exit 4) instead of silently changing voice or art style. Report it to the user. To
  change a pinned choice, delete its entry and redo every asset made with it.

## License filter (commercial-safe by default)

film.json `providers.commercial_safe` is true by default: candidates whose `terms.commercial`
is not `true` are skipped before anything else, and an override that fails the filter is an
error. Known non-commercial or restricted terms (keep them out, or opt in knowingly with
`commercial_safe: false` for a private film):

- XTTS-v2 and F5-TTS weights: non-commercial.
- MusicGen weights: non-commercial.
- FLUX.2 klein and FLUX dev weights: non-commercial (the registry marks flux.2-klein-4b
  `commercial: false`).
- MMAudio and ThinkSound: upstream weights non-commercial, even when a host sells access.
- ElevenLabs Music: terms exclude film, TV and radio use without an enterprise license.
- Chatterbox TTS: adds an audio watermark.
- Kling video: output terms not verified (registry `commercial: null`, filtered).
- Suno has no public API; Udio downloads are disabled. Do not scrape either.
- Voice cloning of a real person needs that person's consent, always.

Watermarks: Gemini TTS, Lyria and Gemini images carry SynthID (invisible); say so in the
credits card.

## Cache

Every provider result is stored under `$FILM/cache/<sha256>/`, keyed by provider, model,
parameters and input content hashes. A repeat of the same call is free (recorded in the ledger
at $0, basis `cache`). Consequences: re-running a command after a crash costs nothing for the
finished parts; `voice.py takes --n 5` after `--n 3` pays only for takes 3 and 4;
`art.py sheet --variant 1` forces a fresh image; `--no-cache` ignores the cache (still writes).

## One ledger across providers

`$FILM/ledger.jsonl` is append-only and shared by every paid call:

1. Reserve: estimate x 1.2 under a file lock; refused (exit 3) when spent + open reservations
   + this reservation would pass `budget_usd`, or the account ceiling.
2. Record: the actual cost from `usage.cost` when the response carries it, else the estimate
   tagged `basis: "estimate"`. A call that failed before reaching the model releases its
   reservation.
3. Anchor: the account's usage at the film's first paid call; `ledger.py reconcile` compares
   the account's usage since then with what the ledger recorded (free call) and warns on drift.

```bash
python3 "$SKILL/scripts/ledger.py" status --film "$FILM"                       # spent / reserved / remaining, per role and stage
python3 "$SKILL/scripts/ledger.py" reconcile --film "$FILM" --key-file <path>  # at every stage boundary
python3 "$SKILL/scripts/ledger.py" release --film "$FILM" --all-open --reason "crashed run"
```

Reservations left open by a crash hold budget until released. Reconcile drift above the
tolerance usually means TTS estimates were low (the speech endpoint reports no cost) or
another job shares the key.

## Quote before spending

```bash
python3 "$SKILL/scripts/quote.py" --film "$FILM"                 # all stages
python3 "$SKILL/scripts/quote.py" --film "$FILM" --stage voice   # preflight | voice | animatic | assets | review | all
```

Counts come from film.json and `src/script.json` (without a script: duration x 2.5 words);
prices from the registry, refined by the catalog once preflight has run. Exit 3 when the
quote does not fit the remaining budget. Quote before voice, before the animatic, before
final assets and before each review round; if a stage does not fit, cut scope (fewer sheets,
fewer candidates, one persona) before asking the user for more budget.

Typical spend for a 60-90 s film at defaults: 5-8 final sheets (~$1.50-2.40), 3 music
candidates (~$0.24), 3 takes per line plus checks (~$0.30-0.60), 2-4 review rounds
(~$0.20-0.60): about $2-4. Draft art for the animatic adds ~$0.08 per sheet.

## Draft tier

`--draft` on `art.py sheet` (1K Nano Banana 2) and `--tier draft` on `critic.py ask` are for
the animatic: cheap enough to throw away. Draft and final image models are pinned separately.
The animatic uses the engine's synthesized bed, not generated music; `music.py gen --draft`
(30 s clips) is for short films or trial prompts and writes the same `cand_<k>` names as a
final run, so keep its files apart before generating final candidates.

## Deprecations to respect

- openai/whisper-1 retires 2027-02-26 and is the only OpenAI transcription model known to return
  word timestamps. The registry skips it after that date; alignment then falls to
  whisper-large-v3 (word times unverified), local WhisperX (`pip install whisperx`), then the
  coarse energy aligner.
- Sora is shut down (2026-09-24) though the catalog may still list it: blocked, never offered.
- google/gemini-3.1-flash-tts-preview is preview/legacy: 3.8 Flash TTS is probed first.
- google/gemini-2.5-flash-image retires 2026-10-02 (opt-in until then).
- The gpt-image-1 family retires 2026-12-01 and is not offered; Imagen 4 is shut down.

When a model disappears, preflight shows it as "not in the catalog" and the walker moves on;
update `registry.json` (`retires`, order, `checked` date) rather than patching tools.

## Adding a provider

1. Registry entry in `registry.json` under the role:

```json
{
  "id": "myhost:vendor/model-name",
  "provider": "openrouter",
  "model": "vendor/model-name",
  "endpoint": "/audio/speech",
  "modality": "speech",
  "tiers": ["final", "draft"],
  "default": false,
  "opt_in": true,
  "probe_tier1": true,
  "retires": "2027-06-30",
  "cost": { "unit": "take", "usd": 0.01, "min_usd": 0.002, "basis": "how the estimate was made" },
  "params": { "response_format": "pcm", "sample_rate": 24000, "audition_voices": ["a", "b"] },
  "terms": { "commercial": true, "watermark": false, "consent_needed": false, "license": "..." },
  "notes": "what is proven and what is not"
}
```

   Position in the list is the fallback order. `terms.commercial` must be `true` for the entry
   to run while commercial_safe is on. Leave new entries `opt_in: true` until a film proves them.
2. A model on OpenRouter with an existing request shape needs nothing more: the role class in
   `providers/openrouter.py` (`ROLE_CLASSES`) serves it.
3. A new host or request shape: subclass `Provider` (`providers/base.py`) and register it
   (`ROLE_CLASSES` for OpenRouter roles, `LOCAL_CLASSES` in `providers/local.py` for local
   tools keyed by `model`; another host needs its own module and a branch in
   `Context.provider()` in `providers/__init__.py`). The interface:
   - `available() -> (ok, why)`: installed and configured on this machine.
   - `estimate(**job) -> usd`: conservative cost of one run (the ledger reserves 1.2x this).
   - `probe(tier) -> {ok, reason, usd}`: tier 0 free, tier 1 a sub-cent real call.
   - `run(**job) -> Result(files, usd, basis, data)`: `usd` from the response when reported
     (`basis "usage.cost"`), else `None` (the ledger records the estimate).
   - Raise `AvailabilityError` (status, `maybe_charged`) for anything the walker may skip past;
     `ProviderError` for real failures. Set `local = True` for $0 local tools (no ledger) and
     `cacheable = False` for results that must never be cached.
   - Job shapes: tts `text, voice, style, take, out_dir, stem` -> `<stem>.wav`, data
     `{seconds}`; align `audio, text, language` -> data `{text, words: [{word, start, end}],
     coarse}`; music `prompt, candidate, out_dir, stem` -> `<stem>.<ext>`; image `prompt, refs,
     aspect, variant, out_dir, stem` -> `<stem>_<i>.<ext>`; critic `prompt, video, audio,
     images` -> data `{text}`.
4. Test with the fake server (`scripts/tests/helpers.py` points `OPENROUTER_BASE_URL` at a
   local port): `cd "$SKILL/scripts/tests" && python3 -m unittest discover -s .` runs every test
   offline at $0.

Alternates worth an adapter (none implemented): ElevenLabs v3 TTS and its forced alignment or
TTS-with-timestamps (a second word-timing source after whisper-1 retires), local Kokoro
(Apache-2.0 weights), Stable Audio 2.5 and local ACE-Step (MIT) for music, Freesound for
effects (CC0 and CC-BY only, with attribution in the credits).
