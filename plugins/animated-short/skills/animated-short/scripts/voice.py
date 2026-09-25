#!/usr/bin/env python3
"""Narration: auditions, takes, transcript checks, picks, processing, timing and export.

audition --voices a,b,c --line <id>   one take per voice of one line -> work/takes/audition/<voice>.wav; prints
                                      each voice's spoken span, words/s and the script's word budget at that pace
takes --n 3 [ids...]                  N takes per line (the line's `tts` spelling when present, film.json
                                      pronunciations applied) -> work/takes/<id>_<k>.wav; pins the voice
check [ids...] [--max-wer w]          align every take and compare it with the intended words -> work/takes/check.json
                                      (with ids, only those lines are replaced); lines served only by the coarse
                                      aligner are listed as unverified. Prints each take's spoken span and words/s
                                      and writes work/takes/check-summary.md (every take, stale ones marked) for
                                      the take-picks prompt (critic.py ask --append)
pick <id>=<k> ...                     copy chosen takes to work/vo/<id>.wav
process [ids...]                      trim, high-pass, gentle EQ, compression, loudness -16 LUFS per line
                                      -> work/vo/<id>_final.wav (ffmpeg two-pass loudnorm; numpy fallback)
tighten [--max-pause 0.24] [--tempo 1.0] [--exempt ids]
                                      cap internal pauses, optional tempo lift (original kept as <id>_loose.wav)
words [--lead-in s] [--gap s] [--keep-t] [--tail s]
                                      word timings -> src/words.json: lines laid out from the lead-in with a
                                      gap, word i of the script line = words[i]; the last line must end --tail
                                      s before the film does (default: end card seconds + 0.5, else 1.5)
export [--format mp3|wav]             work/vo/<id>_final.wav -> web/audio/vo_<id>.<fmt>; VO length vs budget
"""

import difflib
import json
import shutil
from pathlib import Path

import audiolib
from common import (
    add_film_arg,
    add_provider_args,
    context,
    load_film,
    norm_word,
    norm_words,
    parser,
    read_json,
    respell,
    run_main,
    script_lines,
    tts_text,
    usd,
    write_json,
)
from providers import run_role
from providers.base import EXIT_GATE, UsageError

WORDS_PER_SECOND = 2.5
PLAIN_ENDING = 1.5  # seconds after the last line when there is no end card


def ending_seconds(film):
    """Seconds the film needs after the last line: the end card plus 0.5 s when it is on, else 1.5 s."""
    d = film["disclosure"]
    return round(d["seconds"] + 0.5, 3) if d["end_card"] else PLAIN_ENDING


def speech_window(film):
    """Seconds the narration may fill: duration - lead-in - the ending."""
    return film["duration"] - film["voice"]["lead_in"] - ending_seconds(film)


def word_budget(film, n_lines, wps):
    """Words that fit: (speech window - (lines - 1) x gap) x the voice's measured words/s."""
    return max(0, int((speech_window(film) - max(0, n_lines - 1) * film["voice"]["gap"]) * wps))


def energy_span(wav):
    """Spoken span of a take from its level (first to last voiced moment), seconds; 0 when silent."""
    from providers.local import voiced_regions

    samples, sr = audiolib.read_wav_mono(wav)
    env = audiolib.envelope_db(samples, sr)
    regions = voiced_regions(env)
    if regions:
        return round(regions[-1][1] - regions[0][0], 2)
    return round(len(samples) / sr, 2) if env and max(env) > -60 else 0.0  # sound with no pause in it


def words_span(words):
    """Spoken span from aligner words (first start to last end), seconds, or None."""
    times = [(w["start"], w["end"]) for w in words or [] if "start" in w and "end" in w]
    return round(times[-1][1] - times[0][0], 2) if times else None


def pace(n_words, span):
    return round(n_words / span, 2) if span and span > 0 else None


def _lines(film_dir, ids):
    lines = script_lines(film_dir)
    if not lines:
        raise UsageError("src/script.json has no lines")
    if ids:
        known = {ln["id"] for ln in lines}
        missing = [i for i in ids if i not in known]
        if missing:
            raise UsageError(f"unknown line id(s): {', '.join(missing)}")
        lines = [ln for ln in lines if ln["id"] in ids]
    return lines


def _paths(film_dir):
    d = Path(film_dir)
    return d / "work" / "takes", d / "work" / "vo"


def _vo_file(vo_dir, lid):
    for name in (f"{lid}_final.wav", f"{lid}.wav"):
        if (vo_dir / name).exists():
            return vo_dir / name
    return None


def _say(res, label):
    extra = "".join(f" (after {cid} failed: {why[:120]})" for cid, why in res.fallbacks)
    cost = "cached" if res.basis == "cache" else (usd(res.usd) if res.usd is not None else "estimated")
    print(f"  {label}: {res.data.get('seconds', '-')} s  {res.candidate['model']}  {cost}{extra}")


# ---------------------------------------------------------------- audition / takes
def cmd_audition(a):
    film = load_film(a.film)
    ctx = context(a, film)
    line = _lines(a.film, [a.line])[0]
    voices = [v.strip() for v in a.voices.split(",") if v.strip()] if a.voices else None
    if not voices:
        chain, _ = ctx.chain("tts", model=a.model)
        voices = (chain[0].get("params", {}).get("audition_voices") or [])[:6] if chain else []
    if not voices:
        raise UsageError("no voices to audition: pass --voices a,b,c")
    takes_dir, _ = _paths(a.film)
    style = a.style or film["voice"].get("style")
    text = tts_text(line, film["pronunciations"])
    n_words, n_lines = len(norm_words(text)), len(script_lines(a.film))
    print(f"audition: line {line['id']} ({n_words} words) with {len(voices)} voices")
    paces = {}
    for v in voices:
        res = run_role(
            ctx,
            "tts",
            {"text": text, "voice": v, "style": style, "out_dir": takes_dir / "audition", "stem": v},
            stage="voice",
            model=a.model,
        )
        _say(res, v)
        span = energy_span(res.files[0])
        wps = pace(n_words, span)
        paces[v] = {"file": res.files[0].name, "spoken": span, "words_per_second": wps}
        if wps:
            paces[v]["budget_words"] = word_budget(film, n_lines, wps)
            print(
                f"    spoken {span:.2f} s, {wps:.2f} words/s -> the {n_lines}-line script fits about "
                f"{paces[v]['budget_words']} words at this pace"
            )
    write_json(takes_dir / "audition" / "spans.json", {"line": line["id"], "words": n_words, "voices": paces})
    gaps = max(0, n_lines - 1) * film["voice"]["gap"]
    print(
        f"  word budget = (speech window {speech_window(film):.2f} s - {max(0, n_lines - 1)} gaps x "
        f"{film['voice']['gap']} s = {gaps:.2f} s) x the chosen voice's words/s"
    )
    print(f"  -> {takes_dir / 'audition'} (judge with critic.py ask --audio ...)")
    return 0


def cmd_takes(a):
    film = load_film(a.film)
    ctx = context(a, film)
    pinned = ctx.get_sticky("tts/final") or {}
    voice = a.voice or film["voice"].get("name") or pinned.get("voice")
    if not voice:
        raise UsageError("no voice: pass --voice, set voice.name in film.json, or run audition first")
    style = a.style or film["voice"].get("style") or pinned.get("style")
    n = a.n or film["voice"]["takes"]
    takes_dir, _ = _paths(a.film)
    for line in _lines(a.film, a.ids):
        text = tts_text(line, film["pronunciations"])
        print(f"{line['id']}: {text}")
        for k in range(n):
            res = run_role(
                ctx,
                "tts",
                {
                    "text": text,
                    "voice": voice,
                    "style": style,
                    "take": k,
                    "out_dir": takes_dir,
                    "stem": f"{line['id']}_{k}",
                },
                stage="voice",
                sticky=True,
                model=a.model,
            )
            write_json(
                takes_dir / f"{line['id']}_{k}.json",
                {
                    "line": line["id"],
                    "take": k,
                    "text": text,
                    "voice": voice,
                    "style": style,
                    "model": res.candidate["model"],
                    "seconds": res.data.get("seconds"),
                },
            )
            _say(res, f"take {k}")
    return 0


# ---------------------------------------------------------------- check / pick
def take_line(r):
    """One take's check result as text: WER, lengths, pace and the differences."""
    issues = [f"missing {' '.join(r['missing'])}"] if r["missing"] else []
    issues += [f"heard '{h}' for '{e}'" for e, h in r["subs"]]
    issues += [f"extra {' '.join(r['extra'])}"] if r["extra"] else []
    joined = f"  (joins, not errors: {', '.join(f'{h!r}' for _, h in r.get('joins') or [])})" if r.get("joins") else ""
    spoken = f"spoken {r['spoken']:.2f} s of {r['seconds']} s" if r.get("spoken") else f"{r['seconds']} s"
    wps = f", {r['words_per_second']:.2f} words/s" if r.get("words_per_second") else ""
    return f"wer {r['wer']:.2f}  {spoken}{wps}  {'; '.join(issues) or 'clean'}{joined}"


def write_summary(takes_dir, report):
    """work/takes/check-summary.md: every checked take of every line, for the take-picks prompt. A take
    whose file changed after its check is marked STALE, a take never checked is listed as such."""
    out = [
        "Transcript check of every take (voice.py check). Spoken: first word start to last word end as the",
        "aligner heard it (from the level for the coarse aligner); words/s: the line's words over that span.",
        "",
    ]
    for lid, r in report["lines"].items():
        out.append(
            f'{lid} "{r.get("expected", "")}"' + (f" (best by transcript: {r['best']})" if r.get("best") else "")
        )
        takes = r.get("takes") or {}
        on_disk = sorted(p.stem for p in takes_dir.glob(f"{lid}_*.wav") if p.stem[len(lid) + 1 :].isdigit())
        for stem in sorted(set(takes) | set(on_disk)):
            f = takes_dir / f"{stem}.wav"
            row = takes.get(stem)
            if row is None:
                out.append(f"  {stem}: not checked yet (run voice.py check {lid})")
            elif not f.exists():
                out.append(f"  {stem}: file removed since the check")
            elif row.get("file_mtime") is not None and f.stat().st_mtime > row["file_mtime"] + 1e-6:
                out.append(f"  {stem}: STALE (re-made after its check; run voice.py check {lid})")
            else:
                out.append(f"  {stem}: {take_line(row)}")
        out.append("")
    p = takes_dir / "check-summary.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(out), encoding="utf-8")
    return p


def compare(expected, heard):
    """Word lists -> {wer, missing, extra, subs, joins}. Words the aligner joined or split without
    changing a letter ("the secret: salt" heard as "secretsalt", "every one" as "everyone") are joins, not
    errors."""
    sm = difflib.SequenceMatcher(None, expected, heard, autojunk=False)
    missing, extra, subs, joins = [], [], [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "delete":
            missing += expected[i1:i2]
        elif op == "insert":
            extra += heard[j1:j2]
        elif op == "replace":
            pair = [" ".join(expected[i1:i2]), " ".join(heard[j1:j2])]
            (joins if "".join(expected[i1:i2]) == "".join(heard[j1:j2]) else subs).append(pair)
    errors = len(missing) + len(extra) + sum(max(len(s[0].split()), len(s[1].split())) for s in subs)
    return {
        "wer": round(errors / max(1, len(expected)), 3),
        "missing": missing,
        "extra": extra,
        "subs": subs,
        "joins": joins,
    }


def cmd_check(a):
    film = load_film(a.film)
    ctx = context(a, film)
    takes_dir, _ = _paths(a.film)
    report = {}
    for line in _lines(a.film, a.ids):
        text = tts_text(line, film["pronunciations"])
        expected = norm_words(text)
        files = sorted(takes_dir.glob(f"{line['id']}_*.wav"), key=lambda p: p.stem)
        files = [f for f in files if f.stem[len(line["id"]) + 1 :].isdigit()]
        if not files:
            print(f"{line['id']}: no takes in {takes_dir}")
            report[line["id"]] = {"expected": text, "takes": {}, "best": None, "max_wer": a.max_wer, "clean": False}
            continue
        rows = {}
        for f in files:
            res = run_role(ctx, "align", {"audio": f, "text": text, "language": film["language"]}, stage="voice")
            heard_words = [w["word"] for w in res.data.get("words", [])]
            cmp = compare(expected, [n for n in (norm_word(w) for w in heard_words) if n])
            coarse = bool(res.data.get("coarse"))
            span = words_span(res.data.get("words")) or energy_span(f)
            rows[f.stem] = dict(
                cmp,
                heard=res.data.get("text") or " ".join(heard_words),
                coarse=coarse,
                seconds=round(audiolib.wav_duration(f), 2),
                spoken=span,
                words_per_second=pace(len(expected), span),
                model=res.candidate["model"],
                file_mtime=f.stat().st_mtime,
            )
            write_json(f.with_suffix(".words.json"), res.data)
        best = min(rows, key=lambda k: (rows[k]["wer"], k))
        clean = [k for k, r in rows.items() if r["wer"] <= a.max_wer and not r["coarse"]]
        unverified = not clean and all(r["coarse"] for r in rows.values())
        report[line["id"]] = {
            "expected": text,
            "takes": rows,
            "best": best,
            "max_wer": a.max_wer,
            "clean": bool(clean),
            "unverified": unverified,
        }
        flag = "" if clean else ("  UNVERIFIED (coarse aligner)" if unverified else "  NO CLEAN TAKE")
        print(f"{line['id']}: best {best} (wer {rows[best]['wer']}){flag}")
        for k, r in sorted(rows.items()):
            print(f"   {k}: {take_line(r)}")
    # a partial re-run (line ids given) replaces only those lines in check.json and keeps the others;
    # lines no longer in the script are dropped, lines never checked need work
    prev = (read_json(takes_dir / "check.json", default={}).get("lines") or {}) if a.ids else {}
    lines = {}
    for ln in script_lines(a.film):
        unchecked = {"expected": tts_text(ln, film["pronunciations"]), "takes": {}, "best": None, "clean": False}
        lines[ln["id"]] = report.get(ln["id"]) or prev.get(ln["id"]) or dict(unchecked, note="not checked yet")
    needs_work = [lid for lid, r in lines.items() if not r.get("clean")]
    unverified = [lid for lid in needs_work if lines[lid].get("unverified")]
    full = {"max_wer": a.max_wer, "lines": lines, "needs_work": needs_work, "unverified": unverified}
    write_json(takes_dir / "check.json", full)
    print(f"check: every take's result for the take-picks prompt -> {write_summary(takes_dir, full)}")
    now = [lid for lid in needs_work if lid in report]  # the exit code judges the lines checked in this run
    if [lid for lid in now if lid in unverified]:
        print(
            f"check: {', '.join(lid for lid in now if lid in unverified)} UNVERIFIED: only the coarse aligner "
            "served them, so no word was checked. Judge those takes by ear (critic.py ask --audio with the "
            "take-picks prompt), record the verdict in work/takes/check-override.md and go on; without a critic, "
            "report pronunciation as unverified"
        )
    rest = [lid for lid in now if lid not in unverified]
    if rest:
        print(f"check: no verified clean take for {', '.join(rest)} -> make more takes or respell (pronunciations)")
    older = [lid for lid in needs_work if lid not in report]
    if older:
        print(f"check: other lines still open in check.json: {', '.join(older)}")
    return EXIT_GATE if now else 0


def cmd_pick(a):
    takes_dir, vo_dir = _paths(a.film)
    known = {ln["id"] for ln in script_lines(a.film)}
    picks = read_json(vo_dir / "picks.json", default={})
    for spec in a.picks:
        if "=" not in spec:
            raise UsageError(f"expected <line>=<take>, got {spec!r}")
        lid, k = spec.split("=", 1)
        if lid not in known:
            raise UsageError(f"unknown line id {lid!r}")
        src = takes_dir / f"{lid}_{k}.wav"
        if not src.exists():
            raise UsageError(f"{src} does not exist")
        vo_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, vo_dir / f"{lid}.wav")
        for stale in (f"{lid}_final.wav", f"{lid}_loose.wav"):
            (vo_dir / stale).unlink(missing_ok=True)
        picks[lid] = {"take": k, "from": str(src.relative_to(Path(a.film)))}
        print(f"picked {lid} = take {k}")
    write_json(vo_dir / "picks.json", picks)
    return 0


# ---------------------------------------------------------------- process / tighten
FF_CHAIN = (
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04,areverse,"
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15,areverse,"
    "highpass=f=70,equalizer=f=250:t=q:w=1.2:g=-1.5,equalizer=f=3500:t=q:w=1:g=1.5,"
    "acompressor=threshold=-22dB:ratio=2.2:attack=6:release=90:makeup=1.5,afade=t=in:d=0.02"
)


def process_ffmpeg(src, dst, target):
    mid = dst.with_name(dst.stem + "_mid.wav")
    audiolib.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", FF_CHAIN, "-ar", "48000", str(mid)])
    r = audiolib.run(
        [
            "ffmpeg",
            "-v",
            "info",
            "-i",
            str(mid),
            "-af",
            f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ]
    )
    m = json.loads(r.stderr[r.stderr.rfind("{") : r.stderr.rfind("}") + 1])
    ln = (
        f"loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
        f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    audiolib.run(["ffmpeg", "-y", "-v", "error", "-i", str(mid), "-af", ln, "-ar", "48000", str(dst)])
    mid.unlink(missing_ok=True)
    return float(m["input_i"])


def process_numpy(src, dst, target):
    np = audiolib.need("numpy", "voice.py process without ffmpeg")
    x, sr = audiolib.read_audio(src)
    x = x.mean(axis=1).astype(np.float64)
    hop = max(1, int(sr * 0.01))
    frames = len(x) // hop
    env = np.array([np.sqrt(np.mean(x[i * hop : (i + 1) * hop] ** 2) + 1e-12) for i in range(frames)])
    loud = np.nonzero(20 * np.log10(env) > -50)[0]
    if len(loud):
        x = x[max(0, loud[0] * hop - int(0.04 * sr)) : min(len(x), (loud[-1] + 1) * hop + int(0.15 * sr))]

    def gains(f):
        """70 Hz 2nd-order high-pass, -1.5 dB around 250 Hz, +1.5 dB around 3.5 kHz (magnitudes)."""
        f = np.maximum(f, 1e-6)

        def bell(f0, g_db, q):
            return 10 ** (g_db / 20 * np.exp(-(np.log2(f / f0) ** 2) * q * 2))

        return 1 / np.sqrt(1 + (70 / f) ** 4) * bell(250, -1.5, 1.2) * bell(3500, 1.5, 1.0)

    x = audiolib.fft_filter(x, sr, gains)
    # gentle compression: 10 ms blocks, threshold -22 dBFS, ratio 2.2, smoothed gain
    n = len(x) // hop
    lvl = 20 * np.log10(np.array([np.sqrt(np.mean(x[i * hop : (i + 1) * hop] ** 2) + 1e-12) for i in range(n)]) + 1e-12)
    want = np.where(lvl > -22, (-22 + (lvl + 22) / 2.2) - lvl, 0.0)
    g, prev = np.zeros(n), 0.0
    for i, w in enumerate(want):
        prev = prev + (w - prev) * (0.6 if w < prev else 0.1)
        g[i] = prev
    gain = np.interp(np.arange(len(x)), np.arange(n) * hop + hop / 2, 10 ** (g / 20)) if n else np.ones(len(x))
    x = x * gain
    before = audiolib.integrated_lufs(x, sr)
    x = x * 10 ** ((target - before) / 20)
    peak = np.max(np.abs(x)) if len(x) else 0
    ceiling = 10 ** (-1.5 / 20)
    if peak > ceiling:
        x = x * (ceiling / peak)
    fade = min(len(x), int(0.02 * sr))
    x[:fade] *= np.linspace(0, 1, fade)
    audiolib.write_wav(dst, x, sr)
    return before


def cmd_process(a):
    _, vo_dir = _paths(a.film)
    lines = _lines(a.film, a.ids)
    use_ff = audiolib.has_ffmpeg() and not a.no_ffmpeg
    for line in lines:
        src = vo_dir / f"{line['id']}.wav"
        if not src.exists():
            print(f"{line['id']}: no {src.name} (pick a take first)")
            continue
        dst = vo_dir / f"{line['id']}_final.wav"
        (vo_dir / f"{line['id']}_loose.wav").unlink(missing_ok=True)
        before = process_ffmpeg(src, dst, a.lufs) if use_ff else process_numpy(src, dst, a.lufs)
        print(
            f"{line['id']}: {audiolib.wav_duration(dst):.2f} s  input {before:.1f} LUFS -> {a.lufs} "
            f"({'ffmpeg' if use_ff else 'numpy'})"
        )
    return 0


def tighten_file(src, dst, max_pause, tempo, threshold_db=-42.0):
    np = audiolib.need("numpy", "voice.py tighten")
    x, sr = audiolib.read_audio(src)
    fr = max(1, int(sr * 0.01))
    n = len(x) // fr
    env = np.abs(x[: n * fr]).reshape(n, fr, -1).max(axis=(1, 2)) if n else np.zeros(0)
    quiet = env < 10 ** (threshold_db / 20)
    out, last, i = [], 0, 0
    xf = max(1, int(0.01 * sr))
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if (j - i) * 0.01 > max_pause and i > 0 and j < n:
            cut_a, cut_b = i * fr + int(max_pause / 2 * sr), j * fr - int(max_pause / 2 * sr)
            ramp = np.linspace(0, 1, xf)[:, None]
            out.append(x[last:cut_a])
            out.append(x[cut_b : cut_b + xf] * ramp + x[cut_a : cut_a + xf] * (1 - ramp))
            last = cut_b + xf
        i = j
    out.append(x[last:])
    y = np.concatenate(out)
    before, cut = len(x) / sr, len(y) / sr
    if abs(tempo - 1.0) > 1e-6:
        if audiolib.has_ffmpeg():
            tmp = Path(dst).with_name(Path(dst).stem + "_tmp.wav")
            audiolib.write_wav(tmp, y, sr)
            audiolib.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(tmp), "-af", f"atempo={tempo}", "-ar", str(sr), str(dst)]
            )
            tmp.unlink(missing_ok=True)
            return before, cut, audiolib.wav_duration(dst)
        if not audiolib.has("librosa"):
            raise UsageError("--tempo needs ffmpeg, or the optional package librosa (pip install librosa)")
        import librosa

        y = np.stack(
            [librosa.effects.time_stretch(np.ascontiguousarray(y[:, c]), rate=tempo) for c in range(y.shape[1])], axis=1
        )
    audiolib.write_wav(dst, y, sr)
    return before, cut, len(y) / sr


def cmd_tighten(a):
    _, vo_dir = _paths(a.film)
    exempt = set(a.exempt.split(",")) if a.exempt else set()
    for line in _lines(a.film, a.ids):
        final, loose = vo_dir / f"{line['id']}_final.wav", vo_dir / f"{line['id']}_loose.wav"
        if not final.exists():
            print(f"{line['id']}: no {final.name} (run process first)")
            continue
        if not loose.exists():
            shutil.copyfile(final, loose)
        pause = 1e9 if line["id"] in exempt else a.max_pause
        before, cut, after = tighten_file(loose, final, pause, a.tempo)
        print(
            f"{line['id']}: {before:.2f} s -> {cut:.2f} s (pauses) -> {after:.2f} s (tempo {a.tempo})"
            f"{'  pauses exempt' if line['id'] in exempt else ''}"
        )
    return 0


# ---------------------------------------------------------------- words / export
def map_to_display(line, pronunciations, heard):
    """Aligner words -> one {w, s, e} per display word of the line (word i = cue w<i>)."""
    display = str(line["text"]).split()
    if line.get("tts"):
        spoken = str(respell(line["tts"], pronunciations)).split()
        owner = [min(len(display) - 1, i * len(display) // max(1, len(spoken))) for i in range(len(spoken))]
    else:
        spoken, owner = [], []
        for di, w in enumerate(display):
            parts = respell(w, pronunciations).split() or [w]
            spoken += parts
            owner += [di] * len(parts)
    sm = difflib.SequenceMatcher(
        None, [norm_word(w) for w in spoken], [norm_word(h["word"]) for h in heard], autojunk=False
    )
    times = [None] * len(display)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            di, h = owner[blk.a + k], heard[blk.b + k]
            s, e = times[di] or (h["start"], h["end"])
            times[di] = (min(s, h["start"]), max(e, h["end"]))
    if not any(times) and heard:  # nothing matched: fall back to index order
        for i in range(min(len(display), len(heard))):
            times[i] = (heard[i]["start"], heard[i]["end"])
    out = []
    known = [i for i, t in enumerate(times) if t]
    for i, w in enumerate(display):
        if times[i]:
            out.append({"w": w, "s": round(times[i][0], 3), "e": round(times[i][1], 3)})
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        s = times[prev][1] if prev is not None else (heard[0]["start"] if heard else 0.0)
        e = times[nxt][0] if nxt is not None else (heard[-1]["end"] if heard else s + 0.3)
        span = [k for k in range(len(display)) if (prev is None or k > prev) and (nxt is None or k < nxt)]
        step = (e - s) / max(1, len(span))
        j = span.index(i)
        out.append({"w": w, "s": round(s + j * step, 3), "e": round(s + (j + 1) * step, 3), "est": True})
    return out


def cmd_words(a):
    film = load_film(a.film)
    if film["voice"]["mode"] == "none" and not a.force:
        raise UsageError("voice.mode is none: write src/words.json by hand (caption timings), or pass --force")
    ctx = context(a, film)
    _, vo_dir = _paths(a.film)
    lead = film["voice"]["lead_in"] if a.lead_in is None else a.lead_in
    gap = film["voice"]["gap"] if a.gap is None else a.gap
    old = read_json(Path(a.film) / "src" / "words.json", default={})
    out, detail, t = {}, {}, None
    for line in _lines(a.film, None):
        f = _vo_file(vo_dir, line["id"])
        if f is None:
            print(f"{line['id']}: no processed VO (work/vo/{line['id']}_final.wav); skipped")
            continue
        res = run_role(
            ctx,
            "align",
            {"audio": f, "text": tts_text(line, film["pronunciations"]), "language": film["language"]},
            stage="voice",
        )
        d = round(audiolib.wav_duration(f), 3)
        words = map_to_display(line, film["pronunciations"], res.data.get("words", []))
        if a.keep_t and line["id"] in old and isinstance(old[line["id"]].get("t"), (int, float)):
            start = float(old[line["id"]]["t"])
        else:
            start = lead if t is None else t + gap
        entry = {"t": round(start, 3), "d": d, "words": words}
        if res.data.get("coarse"):
            entry["coarse"] = True
        out[line["id"]] = entry
        detail[line["id"]] = {
            "file": str(f.relative_to(Path(a.film))),
            "model": res.candidate["model"],
            "heard": res.data.get("text"),
            "estimated_words": sum(1 for w in words if w.get("est")),
        }
        t = start + d
        est = detail[line["id"]]["estimated_words"]
        print(
            f"{line['id']}: {start:6.2f}-{start + d:6.2f} s  {len(words)} words"
            f"{f' ({est} interpolated)' if est else ''}{' COARSE' if entry.get('coarse') else ''}"
        )
    if not out:
        raise UsageError("no line has processed narration yet (pick, process)")
    write_json(Path(a.film) / "src" / "words.json", out)
    write_json(Path(a.film) / "work" / "vo" / "words-detail.json", detail)
    end = max(v["t"] + v["d"] for v in out.values())
    room = film["duration"] - end
    tail = ending_seconds(film) if a.tail is None else a.tail
    print(
        f"words: narration ends at {end:.2f} s; film {film['duration']} s; "
        f"{room:.2f} s left for the ending (need {tail})"
    )
    if room < tail:
        print("words: too long: cut words, tighten pauses (voice.py tighten), or lengthen the film")
        return EXIT_GATE
    return 0


def cmd_export(a):
    film = load_film(a.film)
    _, vo_dir = _paths(a.film)
    fmt = a.format or ("mp3" if audiolib.has_ffmpeg() else "wav")
    web_audio = Path(a.film) / "web" / "audio"
    web_audio.mkdir(parents=True, exist_ok=True)
    total, words, n = 0.0, 0, 0
    for line in _lines(a.film, None):
        f = _vo_file(vo_dir, line["id"])
        words += len(str(line["text"]).split())
        if f is None:
            print(f"{line['id']}: no narration file; skipped")
            continue
        dst = web_audio / f"vo_{line['id']}.{fmt}"
        for ext in ("mp3", "wav", "ogg", "m4a"):
            if ext != fmt:
                (web_audio / f"vo_{line['id']}.{ext}").unlink(missing_ok=True)
        audiolib.encode(f, dst)
        total += audiolib.wav_duration(f)
        n += 1
        print(f"{line['id']}: {dst.relative_to(Path(a.film))}")
    budget = words / WORDS_PER_SECOND
    print(
        f"export: {n} lines, {total:.1f} s of narration in a {film['duration']} s film "
        f"({words} words; at {WORDS_PER_SECOND} words/s the script needs about {budget:.0f} s)"
    )
    if n:
        print("  next: python3 voice.py words (if not yet), then node tools/resolve.mjs")
    return 0


def main(argv=None):
    ap = parser("voice.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def sp(name, help_text, provider=False):
        p = sub.add_parser(name, help=help_text)
        add_film_arg(p)
        if provider:
            add_provider_args(p)
        return p

    p = sp("audition", "one take per voice for one line", True)
    p.add_argument("--voices", help="comma-separated voice names (default: the model's audition list)")
    p.add_argument("--line", required=True, help="script line id")
    p.add_argument("--style", help="delivery direction (default: film.json voice.style)")
    p.add_argument("--model", help="TTS model to try first")
    p = sp("takes", "N takes per line", True)
    p.add_argument("ids", nargs="*", help="line ids (default: all)")
    p.add_argument("--n", type=int, help="takes per line (default: film.json voice.takes)")
    p.add_argument("--voice", help="voice name (default: film.json voice.name, then the pinned voice)")
    p.add_argument("--style")
    p.add_argument("--model")
    p = sp("check", "align every take and compare it with the intended text", True)
    p.add_argument("ids", nargs="*")
    p.add_argument(
        "--max-wer", type=float, default=0.0, help="word error rate a take may have and still count as clean"
    )
    p = sp("pick", "copy chosen takes to work/vo/<id>.wav")
    p.add_argument("picks", nargs="+", metavar="ID=TAKE")
    p = sp("process", "trim, EQ, compress, loudness-normalize each picked line")
    p.add_argument("ids", nargs="*")
    p.add_argument("--lufs", type=float, default=-16.0, help="per-line loudness target (default -16)")
    p.add_argument("--no-ffmpeg", action="store_true", help="use the numpy chain even when ffmpeg exists")
    p = sp("tighten", "cap internal pauses and optionally lift the tempo")
    p.add_argument("ids", nargs="*")
    p.add_argument("--max-pause", type=float, default=0.24, help="longest internal pause kept, seconds")
    p.add_argument("--tempo", type=float, default=1.0, help="tempo factor, e.g. 1.025 (inaudible up to ~3%%)")
    p.add_argument("--exempt", help="comma-separated line ids whose pauses are deliberate")
    p = sp("words", "word timings -> src/words.json", True)
    p.add_argument("--lead-in", type=float, help="first line start, s (default: film.json voice.lead_in)")
    p.add_argument("--gap", type=float, help="gap between lines, s (default: film.json voice.gap)")
    p.add_argument("--keep-t", action="store_true", help="keep line starts already in src/words.json")
    p.add_argument(
        "--tail",
        type=float,
        help="seconds the ending needs after the last line (default: disclosure.seconds + 0.5 when the end card "
        "is on, else 1.5)",
    )
    p.add_argument("--force", action="store_true", help="run even when voice.mode is none")
    p = sp("export", "processed lines -> web/audio/vo_<id>.<fmt>")
    p.add_argument("--format", choices=("mp3", "wav"), help="default mp3 when ffmpeg exists, else wav")
    a = ap.parse_args(argv)
    return {
        "audition": cmd_audition,
        "takes": cmd_takes,
        "check": cmd_check,
        "pick": cmd_pick,
        "process": cmd_process,
        "tighten": cmd_tighten,
        "words": cmd_words,
        "export": cmd_export,
    }[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
