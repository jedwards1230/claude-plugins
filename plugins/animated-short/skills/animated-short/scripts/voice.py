#!/usr/bin/env python3
"""Narration: auditions, takes, transcript checks, picks, processing, timing and export.

audition --voices a,b,c --line <id>   one take per voice of one line -> work/takes/audition/<voice>.wav
takes --n 3 [ids...]                  N takes per line (the line's `tts` spelling when present, film.json
                                      pronunciations applied) -> work/takes/<id>_<k>.wav; pins the voice
check [ids...]                        align every take and compare it with the intended words -> work/takes/check.json
pick <id>=<k> ...                     copy chosen takes to work/vo/<id>.wav
process [ids...]                      trim, high-pass, gentle EQ, compression, loudness -16 LUFS per line
                                      -> work/vo/<id>_final.wav (ffmpeg two-pass loudnorm; numpy fallback)
tighten [--max-pause 0.24] [--tempo 1.0] [--exempt ids]
                                      cap internal pauses, optional tempo lift (original kept as <id>_loose.wav)
words [--lead-in s] [--gap s] [--keep-t] [--tail s]
                                      word timings -> src/words.json: lines laid out from the lead-in with a
                                      gap, word i of the script line = words[i]; total checked against duration
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
    extra = f" (after {', '.join(i for i, _ in res.fallbacks)} failed)" if res.fallbacks else ""
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
    print(f"audition: line {line['id']} with {len(voices)} voices")
    for v in voices:
        res = run_role(
            ctx,
            "tts",
            {
                "text": tts_text(line, film["pronunciations"]),
                "voice": v,
                "style": style,
                "out_dir": takes_dir / "audition",
                "stem": v,
            },
            stage="voice",
            model=a.model,
        )
        _say(res, v)
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
def compare(expected, heard):
    """Word lists -> {wer, missing, extra, subs}."""
    sm = difflib.SequenceMatcher(None, expected, heard, autojunk=False)
    missing, extra, subs = [], [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "delete":
            missing += expected[i1:i2]
        elif op == "insert":
            extra += heard[j1:j2]
        elif op == "replace":
            subs.append([" ".join(expected[i1:i2]), " ".join(heard[j1:j2])])
    errors = len(missing) + len(extra) + sum(max(len(s[0].split()), len(s[1].split())) for s in subs)
    return {"wer": round(errors / max(1, len(expected)), 3), "missing": missing, "extra": extra, "subs": subs}


def cmd_check(a):
    film = load_film(a.film)
    ctx = context(a, film)
    takes_dir, _ = _paths(a.film)
    report, bad_lines = {}, []
    for line in _lines(a.film, a.ids):
        text = tts_text(line, film["pronunciations"])
        expected = norm_words(text)
        files = sorted(takes_dir.glob(f"{line['id']}_*.wav"), key=lambda p: p.stem)
        files = [f for f in files if f.stem[len(line["id"]) + 1 :].isdigit()]
        if not files:
            print(f"{line['id']}: no takes in {takes_dir}")
            bad_lines.append(line["id"])
            continue
        rows = {}
        for f in files:
            res = run_role(ctx, "align", {"audio": f, "text": text, "language": film["language"]}, stage="voice")
            heard_words = [w["word"] for w in res.data.get("words", [])]
            cmp = compare(expected, [n for n in (norm_word(w) for w in heard_words) if n])
            coarse = bool(res.data.get("coarse"))
            rows[f.stem] = dict(
                cmp,
                heard=res.data.get("text") or " ".join(heard_words),
                coarse=coarse,
                seconds=round(audiolib.wav_duration(f), 2),
                model=res.candidate["model"],
            )
            write_json(f.with_suffix(".words.json"), res.data)
        best = min(rows, key=lambda k: (rows[k]["wer"], k))
        report[line["id"]] = {"expected": text, "takes": rows, "best": best}
        clean = [k for k, r in rows.items() if r["wer"] <= a.max_wer and not r["coarse"]]
        flag = (
            ""
            if clean
            else ("  UNVERIFIED (coarse aligner)" if all(r["coarse"] for r in rows.values()) else "  NO CLEAN TAKE")
        )
        print(f"{line['id']}: best {best} (wer {rows[best]['wer']}){flag}")
        for k, r in sorted(rows.items()):
            issues = [f"missing {' '.join(r['missing'])}"] if r["missing"] else []
            issues += [f"heard '{h}' for '{e}'" for e, h in r["subs"]]
            issues += [f"extra {' '.join(r['extra'])}"] if r["extra"] else []
            print(f"   {k}: wer {r['wer']:.2f}  {r['seconds']} s  {'; '.join(issues) or 'clean'}")
        if not clean:
            bad_lines.append(line["id"])
    write_json(takes_dir / "check.json", {"max_wer": a.max_wer, "lines": report, "needs_work": bad_lines})
    if bad_lines:
        print(
            f"check: no verified clean take for {', '.join(bad_lines)} -> make more takes or respell (pronunciations)"
        )
        return EXIT_GATE
    return 0


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
            raise UsageError(f"--tempo needs ffmpeg or librosa ({audiolib.HINT})")
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
    print(
        f"words: narration ends at {end:.2f} s; film {film['duration']} s; {room:.2f} s left for the ending (need {a.tail})"
    )
    if room < a.tail:
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
    p.add_argument("--tail", type=float, default=1.5, help="seconds the ending needs after the last line")
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
