# Delivery: page, MP4s, captions, credits

The film always plays live in a browser: canvas plus Web Audio, the same code the renders use.
An MP4 is needed only where JavaScript cannot go: messages, chat attachments, video sites, a
TV. `$SKILL` is the skill's base directory and `$FILM` the film directory.

## One command

```bash
node "$FILM/tools/export.mjs" --probe --film "$FILM"     # what this machine can do (JSON), no output files
node "$FILM/tools/export.mjs" --film "$FILM"             # --mode auto: the best available mode
```

Every mode writes into `$FILM/out/`: `<slug>.srt`, `<slug>.vtt`, `transcript.md`, `page/` (the
live player, ready to host) and `export.json` (mode, reason, loudness before and after, the
mix's SHA-256 and per-file measurements). Two renders of an unchanged film can differ in the
last bits of the sound (floating-point noise around -90 dBFS, far below hearing), so compare
mixes with the null test (`node "$FILM/tools/qa.mjs" null --film "$FILM"`, part of TECH-7:
under -60 dBFS passes), not by checksum. `<slug>` is the title in lower-case words joined by hyphens; read
`out/export.json` for the exact file names. Options: `--mode`, `--variants master,share,phone`,
`--lufs -14.5`, `--tp`, `--lra 11`, `--workers n`, `--keep-frames`, `--out <dir>` (use it for
the animatic, so `out/` holds only deliverables), `--chromium <path>`.

## Modes

`auto` picks the first that works, in this order:

| Mode | Needs | Result | Notes |
| --- | --- | --- | --- |
| `ffmpeg` (default when present) | Chromium + ffmpeg + ffprobe | `<slug>.mp4` (1080-line master), `<slug>-share.mp4` (same size, smaller file), `<slug>-phone.mp4` (720-line, under 30 MiB): H.264 high, yuv420p, AAC, faststart, soft `mov_text` subtitles, title and AI-note metadata | Frames rendered in parallel, two-pass loudnorm, then ebur128 verification; when loudnorm misses (short films), the mix is normalized with the bundled BS.1770-4 meter and a true-peak limiter instead, and codec overshoot is re-encoded under a lower ceiling. |
| `webcodecs` | Chromium only | the same three MP4s, H.264 + Opus, WebVTT subtitle track | Encoded frame-exactly in the page (WebCodecs needs the secure localhost page the tools serve) and muxed with Mediabunny; AAC is not available in Chromium's encoder. Opus-in-MP4 playback on older iPhones is unverified: when iPhones matter and ffmpeg is missing, test one file on a device first or send the bundle to someone with ffmpeg. |
| `webm` | a browser with MediaRecorder | `<slug>.webm`, 720-line, VP9/VP8 + Opus | Real-time capture: not frame-exact. Last resort; labelled as such in export.json. |
| `bundle` | nothing | `<slug>-bundle/` (JPEG frames, loudness-normalized `mix.wav`, captions, a README with the exact ffmpeg command) and `<slug>-bundle.tar` | For locked-down machines: someone else encodes it. |

Force a mode with `--mode ffmpeg|webcodecs|webm|bundle`; run export once per extra mode listed
in film.json `delivery` (for example `webm` or `bundle` in addition to the MP4s).

Targets checked by `qa.mjs check` (TECH ids): duration within 1 s (TECH-1), integrated
loudness -14.5 +- 0.5 LUFS (TECH-2), true peak <= -1 dBTP (TECH-3), phone copy under 30 MiB
(TECH-4), SRT and VTT present (TECH-5), transcript with every line (TECH-6), expected streams
and frame sizes (TECH-14), a hostable page (TECH-15).

## The live page

`out/page/` is `web/` without the render-only scripts: `index.html`, `js/`, `film/`, `img/`,
`audio/`, `fonts/`. It needs HTTP (it fetches its JSON and media); it does not work from
`file://`. To watch it: `node "$FILM/tools/render.mjs" serve --film "$FILM"` and open the
printed URL. To publish: copy `out/page/` to any static host, or hand it to whatever page
publishing the environment offers; if that target only accepts files from certain folders,
copy the page there first. The page has play/pause, restart, a scrubber, captions (key `c`),
full screen (`f`), keyboard seeking, a poster frame, the notes and the credits card.

## Captions and transcript

- Live captions in the player come from the narration lines and their timings (on by default:
  film.json `captions`).
- `out/<slug>.srt` and `.vtt` sidecars; the MP4s carry a soft subtitle track.
- `out/transcript.md`: title, subtitle, length, every narration line, the credits and the
  AI-made note. It is the text version of the film for anyone who cannot watch or hear it.
- A film with voice `none` still gets captions and a transcript from `src/words.json` timings.

## Credits and disclosure

- The page shows `credits` and `disclosure.note` (default "Made with AI. The credits list the
  models and tools used."). The same note goes into the transcript and the MP4 comment.
- The end card (film.json `disclosure.end_card`, default true) draws "Made with AI" and the
  credits over the last `disclosure.seconds` (3.2 s) of the film itself, inside the duration:
  end the story before it, and leave narration at least `seconds + 0.5` s clear of the end
  (`voice.py words` checks exactly that by default; `resolve.mjs` warns when the narration
  ends less than 0.3 s before the card). Set `end_card: false` to keep the disclosure on the
  page only.
- The card's legible window is shorter than `seconds`: the card fades in over 0.4 s and the
  film's fade-out (2% of the duration, 0.25-0.8 s) closes it, so it is fully visible for
  `seconds - 0.4 - fade-out`: 2.0 s at the default 3.2 s on a film of 40 s or more.
  `resolve.mjs` warns when that window is under 2.0 s (it names the `seconds` that fixes it).
  Keep the card short enough to read in its window (a slow reader included): the title and
  two or three short lines via `disclosure.lines`; the page, the transcript and the MP4
  comment carry the full credits.
- This section is where the credits are defined. Fill film.json `credits` before the first
  review round (the end card draws them, so every reviewed cut must carry them), complete from
  the start so no later round changes the end card:
  - every model whose output is in the film: the voice (model and voice name), the word
    timing, the music, the images, with the models that actually served them (the `model` of
    each `record` entry in `ledger.jsonl`, and the pins in `work/state.json`);
  - the model that builds the film (the host agent running this skill: name it, it is on
    record nowhere else) for the script, research, animation code and checks;
  - the reviewers under a "reviewed by" credit: the critic and the planned sign-off model
    (preflight's `roles.critic.tiers.signoff.chosen`, before it has run);
  - the engine, fonts with their licenses, the music source, the sources of facts;
  - provenance for watermarked media, worded as what the model does, not as a claim about the
    edited file: "Google Gemini TTS, which adds a SynthID watermark to what it makes".
  Candidates that were generated but not used (a music candidate that lost the pick, a
  discarded sheet) and preflight probes are not credited. Then
  `python3 "$SKILL/scripts/scaffold.py" sync-config --film "$FILM"`. `report.py` flags a model
  whose output is in the film that the credits do not seem to name (the pinned voice and image
  models in `work/state.json`, the aligner in `work/vo/words-detail.json`, the music candidate
  `work/music/edit.json` uses, per `work/music/candidates.json`), and only lists the other
  ledger models it does not find: fine when they were probes or unused candidates.

## The phone copy

Chat apps and messengers cap attachments (30 MiB is common). The phone variant is 720-line and
size-capped under 30 MiB in both the ffmpeg and WebCodecs paths. Send it, not the master, when a
file must travel by message.

## What to hand over

1. `out/page/` (or its published link), the MP4s, captions and `transcript.md`.
2. `out/report.md`, written by `python3 "$SKILL/scripts/report.py" --film "$FILM"` from the
   film's records (so it works inside a subagent that may not write report files itself):
   what was made and the deliverables with their measurements, how each persona restated the
   message, the final round's gate results (the fix pass when there is one), the counted
   defects left open, fixed and still to confirm, the claims the user accepted, every hard
   truth with its decision, the latest creative-direction originality score, spend (ledger,
   account delta, calibration), models used and a credits check, what was not verified (for a
   $0 film: that no model watched the video; an unverified pronunciation), and anything the
   user still has to decide. What only the agent knows goes into
   `work/report-notes.json` first: `{"open_decisions": [...], "not_verified": [...],
   "notes": [...]}`.
3. The editable sources: the film directory itself (`film.json`, `src/`, `web/film/`,
   `web/img/`, `work/direction/`). Exclude `node_modules/`, `cache/`, `work/frames/`,
   `work/export-frames/` and `work/preflight.json` (the film's `.gitignore` lists them) when
   copying it anywhere. A sequel or a vertical cut starts from this directory: change
   film.json, `scaffold.py sync-config`, re-resolve, re-export.
