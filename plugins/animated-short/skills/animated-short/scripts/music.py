#!/usr/bin/env python3
"""Music: generate candidates, find the beat grid, and cut the chosen track to the film.

gen [--n 3] [--prompt P | --prompt-file F] [--draft]
      N candidates (Lyria via streaming chat audio) -> work/music/cand_<k>.<mp3|wav>
beats <file> [--out F]
      beats and downbeats -> JSON (librosa when installed, else a numpy onset + dynamic-programming
      tracker; downbeats = the beat phase with the strongest low-band onsets, 4/4 assumed)
cut --file F --end-at T [--to S] [--final-at R] [--at A] [--format mp3|wav]
      remove (or repeat) whole bars between two downbeats, with a 60 ms equal-power crossfade, so the
      track's final chord lands just after film time T (the last word's end plus a little pad). The
      final chord is the last strong onset that still sounds within 12 dB of the track's loud part (a
      re-attack inside the fade-out tail never counts); --final-at R names it in raw-track seconds.
      --at A starts the music at film time A (storyboard music.at; a late A puts music only under the
      ending); --to ends it at film time S (trimmed with a fade, or padded). Writes
      web/audio/music.<fmt>, src/beats.json (the edited grid) and work/music/edit.json.
"""

import math
from pathlib import Path

import audiolib
from common import add_film_arg, add_provider_args, context, load_film, parser, read_json, run_main, usd, write_json
from providers import run_role
from providers.base import EXIT_GATE, UsageError


# ---------------------------------------------------------------- generation
def cmd_gen(a):
    film = load_film(a.film)
    ctx = context(a, film)
    prompt = a.prompt or (Path(a.prompt_file).read_text() if a.prompt_file else None) or film["music"].get("prompt")
    if not prompt:
        raise UsageError("no music prompt: pass --prompt/--prompt-file or set music.prompt in film.json")
    out_dir = Path(a.film) / "work" / "music"
    n = a.n or film["music"]["candidates"]
    for k in range(n):
        res = run_role(
            ctx,
            "music",
            {"prompt": prompt, "candidate": k, "out_dir": out_dir, "stem": f"cand_{k}"},
            stage="assets",  # the quote.py stage this spend belongs to
            tier="draft" if a.draft else "final",
            model=a.model,
        )
        f = res.files[0]
        try:
            x, sr = audiolib.read_audio(f)
            secs = f"{len(x) / sr:.1f} s"
        except UsageError:
            secs = "? s (install ffmpeg to decode)"
        cost = "cached" if res.basis == "cache" else (usd(res.usd) if res.usd is not None else "estimated")
        after = "".join(f" (after {cid} failed: {why[:120]})" for cid, why in res.fallbacks)
        print(f"  {f.relative_to(Path(a.film))}: {secs}  {res.candidate['model']}  {cost}{after}")
    print("  next: judge the candidates (critic.py ask --audio ...), then music.py beats <file>")
    return 0


# ---------------------------------------------------------------- beat tracking
HOP, N_FFT = 256, 1024


def onset_strength(x, sr, hop=HOP, n_fft=N_FFT, band=None):
    """Spectral flux of the log magnitude per hop (optionally within a frequency band). Frames are
    centred on k * hop and shifted by a quarter window, where a Hann window's flux peaks for an
    attack; computed in chunks so long tracks stay small in memory."""
    np = audiolib.need("numpy", "beat tracking")
    x = np.pad(np.asarray(x, dtype=np.float64), (n_fft // 2 + n_fft // 4, n_fft))
    n = max(1, 1 + (len(x) - n_fft) // hop - 1)
    win = np.hanning(n_fft)
    keep = None
    if band:
        f = np.fft.rfftfreq(n_fft, 1.0 / sr)
        keep = (f >= band[0]) & (f < band[1])
    flux, prev = np.zeros(n), None
    for c0 in range(0, n, 2048):
        k = np.arange(c0, min(n, c0 + 2048))
        frames = x[k[:, None] * hop + np.arange(n_fft)[None, :]] * win
        logm = np.log1p(100 * np.abs(np.fft.rfft(frames, axis=1)))
        if keep is not None:
            logm = logm[:, keep]
        stack = logm if prev is None else np.vstack([prev[None, :], logm])
        d = np.maximum(0, np.diff(stack, axis=0)).sum(axis=1)
        flux[k[1:] if prev is None else k] = d
        prev = logm[-1]
    return flux / (flux.max() + 1e-9)


def track_beats_numpy(x, sr, hop=HOP):
    """-> (bpm, beat times). Tempo by autocorrelation (log-normal prior around 110 BPM), beats by
    dynamic programming (Ellis 2007)."""
    np = audiolib.need("numpy", "beat tracking")
    env = onset_strength(x, sr, hop)
    fps = sr / hop
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1 :]
    lags = np.arange(len(ac))
    bpm_at = np.where(lags > 0, 60 * fps / np.maximum(lags, 1), 0)
    valid = (bpm_at >= 60) & (bpm_at <= 200)
    prior = np.exp(-0.5 * (np.log2(np.maximum(bpm_at, 1) / 110.0) / 0.9) ** 2)
    score = np.where(valid, ac * prior, -np.inf)
    lag = int(np.argmax(score))
    if 1 <= lag < len(ac) - 1:  # parabolic refinement
        y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
        denom = y0 - 2 * y1 + y2
        lag_f = lag + (0.5 * (y0 - y2) / denom if denom else 0.0)
    else:
        lag_f = float(lag)
    period = lag_f
    bpm = 60 * fps / period
    onset = np.maximum(env, 0)
    n = len(onset)
    best, back = onset.copy(), np.full(n, -1)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    for t in range(n):
        a, b = t - hi, t - lo
        if b < 0:
            continue
        prev = np.arange(max(0, a), b + 1)
        cost = best[prev] - 100 * (np.log((t - prev) / period)) ** 2
        k = int(np.argmax(cost))
        best[t] = onset[t] + cost[k]
        back[t] = prev[k]
    t = int(np.argmax(best[max(0, n - int(period) - 1) :]) + max(0, n - int(period) - 1))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    beats = np.array(beats[::-1]) * hop / sr
    return float(bpm), [float(b) for b in beats]


def downbeat_phase(x, sr, beats, hop=HOP):
    """Phase 0-3 whose beats carry the most low-band (below 200 Hz) onset energy."""
    np = audiolib.need("numpy", "beat tracking")
    low = onset_strength(x, sr, hop, band=(20, 200))
    full = onset_strength(x, sr, hop)
    w = max(1, int(round(0.04 * sr / hop)))  # beat trackers place beats a few frames off the attack

    def peak(env, t):
        k = int(round(t * sr / hop))
        return float(env[max(0, k - w) : k + w + 1].max()) if 0 <= k < len(env) else 0.0

    strength = np.array([peak(low, b) + 0.25 * peak(full, b) for b in beats])
    scores = [float(strength[p::4].mean()) if len(strength[p::4]) else 0.0 for p in range(4)]
    return int(np.argmax(scores)), scores


def analyze(path):
    np = audiolib.need("numpy", "beat tracking")
    x, sr = audiolib.read_audio(path)
    mono = x.mean(axis=1).astype(np.float64)
    method = "numpy onset autocorrelation + dynamic programming"
    if audiolib.has("librosa"):
        import librosa

        # a short hop: librosa's tempo is quantized to whole frames of autocorrelation lag
        tempo, frames = librosa.beat.beat_track(
            y=mono.astype(np.float32), sr=sr, hop_length=HOP, units="frames", trim=False
        )
        beats = [float(t) for t in librosa.frames_to_time(frames, sr=sr, hop_length=HOP)]
        bpm = 60.0 / float(np.median(np.diff(beats))) if len(beats) > 2 else float(np.atleast_1d(tempo)[0])
        method = "librosa beat_track"
    else:
        bpm, beats = track_beats_numpy(mono, sr)
    if len(beats) < 4:
        raise UsageError(f"{path}: found {len(beats)} beats; is it music?")
    phase, scores = downbeat_phase(mono, sr, beats)
    return {
        "file": str(path),
        "duration": round(len(mono) / sr, 3),
        "bpm": round(bpm, 2),
        "beats": [round(b, 3) for b in beats],
        "downbeats": [round(b, 3) for b in beats[phase::4]],
        "method": method + "; downbeats: 4/4 phase with the strongest low-band onsets",
        "phase_scores": [round(s, 4) for s in scores],
    }


def cmd_beats(a):
    info = analyze(Path(a.file))
    out = Path(a.out) if a.out else Path(a.file).with_suffix(".beats.json")
    write_json(out, info)
    print(
        f"beats: {info['bpm']} BPM, {len(info['beats'])} beats, {len(info['downbeats'])} bars, "
        f"{info['duration']} s ({info['method'].split(';')[0]}) -> {out}"
    )
    return 0


# ---------------------------------------------------------------- cut
LEVEL_WINDOW = 0.4  # seconds of level measured just after an onset
LEVEL_DROP_DB = 12.0  # an onset this far below the track's loud part is inside the fade-out tail
ONSET_FLOOR = 0.3  # a strong onset reaches this fraction of the track's 99th-percentile onset strength
SNAP = 0.15  # seconds: an onset this close to a downbeat is that downbeat


def final_chord(x, sr, downbeats):
    """The final chord: the last strong onset that still sounds within LEVEL_DROP_DB of the track's loud
    part (a re-attack inside the fade-out tail never counts), snapped to a downbeat within SNAP seconds.
    Falls back to the last downbeat with a real attack. -> (time, how it was found)."""
    np = audiolib.need("numpy", "music cut")
    x = np.asarray(x, dtype=np.float64)
    env = onset_strength(x, sr)
    k = np.arange(len(env)) * HOP
    sq = np.concatenate([[0.0], np.cumsum(x * x)])
    a, b = np.clip(k, 0, len(x)), np.clip(k + int(LEVEL_WINDOW * sr), 0, len(x))
    level = 10 * np.log10((sq[b] - sq[a]) / np.maximum(1, b - a) + 1e-12)
    sounding = level[level > -90]
    loud = float(np.percentile(sounding, 95)) if len(sounding) else 0.0
    floor = ONSET_FLOOR * float(np.percentile(env, 99))
    peaks = [
        i
        for i in range(1, len(env) - 1)
        if env[i] >= floor and env[i] >= env[i - 1] and env[i] >= env[i + 1] and level[i] >= loud - LEVEL_DROP_DB
    ]
    if peaks:
        t = peaks[-1] * HOP / sr
        near = min(downbeats, key=lambda d: abs(d - t)) if downbeats else None
        if near is not None and abs(near - t) <= SNAP:
            return near, f"last strong onset within {LEVEL_DROP_DB:g} dB of the loud part, on a downbeat"
        return round(t, 3), f"last strong onset within {LEVEL_DROP_DB:g} dB of the loud part (between downbeats)"
    vals = [float(env[max(0, int(d * sr / HOP) - 4) : int(d * sr / HOP) + 5].max()) for d in downbeats]
    med = float(np.median(vals)) if vals else 0.0
    for d, v in zip(reversed(downbeats), reversed(vals), strict=True):
        if v >= 0.3 * med:
            return d, "last downbeat with an attack (no onset stood out from the level)"
    return downbeats[-1], "last downbeat"


def extend_grid(times, duration):
    """Continue a regular grid at its median spacing up to the end of the track."""
    if len(times) < 2:
        return list(times)
    step = sorted(b - a for a, b in zip(times, times[1:], strict=False))[(len(times) - 1) // 2]
    out = list(times)
    while out[-1] + step < duration - 0.05:
        out.append(round(out[-1] + step, 3))
    return out


def splice(parts, sr, xfade):
    """Join (start, end) sample ranges of x with equal-power crossfades -> array."""
    np = audiolib.need("numpy", "music cut")
    x, ranges = parts
    n = max(1, int(xfade * sr))
    out = x[ranges[0][0] : ranges[0][1]]
    for s, e in ranges[1:]:
        seg = x[s:e]
        m = min(n, len(out), len(seg))
        if m == 0:
            out = np.concatenate([out, seg])
            continue
        t = np.linspace(0, np.pi / 2, m)[:, None]
        mid = out[-m:] * np.cos(t) + seg[:m] * np.sin(t)
        out = np.concatenate([out[:-m], mid, seg[m:]])
    return out


def plan_cut(downbeats, final_at, target, min_head=2, min_tail=1):
    """Whole bars to remove (k > 0) or repeat (k < 0) so the final chord lands at or just after target.
    -> dict(a, k, shift) using downbeat indexes, or raises UsageError."""
    idx_final = min(range(len(downbeats)), key=lambda i: abs(downbeats[i] - final_at))
    need = final_at - target
    bars = [downbeats[i + 1] - downbeats[i] for i in range(len(downbeats) - 1)]
    bar = sorted(bars)[len(bars) // 2] if bars else 0
    if bar <= 0:
        raise UsageError("cannot measure the bar length")
    if abs(need) < 1e-3 or (0 <= need < bar):
        return {"a": None, "k": 0, "shift": 0.0, "bar": bar, "idx_final": idx_final}
    if need > 0:
        k = int(math.floor(need / bar + 1e-6))
        options = [a for a in range(min_head, idx_final - min_tail - k + 1)]
        if not options:
            options = [a for a in range(0, idx_final - k + 1)]
        if not options:
            raise UsageError(
                f"the track has too few bars before its final chord to remove {k}; pick another "
                "candidate or move the ending"
            )
        a0 = min(options, key=lambda a: abs(a - (min_head + idx_final - min_tail - k) / 2))
        return {"a": a0, "k": k, "shift": -(downbeats[a0 + k] - downbeats[a0]), "bar": bar, "idx_final": idx_final}
    k = int(math.ceil(-need / bar - 1e-6))
    span = min(k, max(1, idx_final - min_head))
    a0 = max(0, idx_final - min_tail - span)
    if a0 + span > idx_final:
        raise UsageError("the track is too short to extend by repeating bars")
    reps = int(math.ceil(k / span))
    return {
        "a": a0,
        "k": -span,
        "repeat": reps,
        "shift": reps * (downbeats[a0 + span] - downbeats[a0]),
        "bar": bar,
        "idx_final": idx_final,
    }


def edit_times(ts, plan, downs):
    """Map raw-track times through the edit (removed bars vanish, repeated bars appear again)."""
    if plan["k"] == 0:
        return list(ts)
    if plan["k"] > 0:
        d0, d1 = downs[plan["a"]], downs[plan["a"] + plan["k"]]
        return [t if t < d0 else t - (d1 - d0) for t in ts if not (d0 <= t < d1)]
    d0, d1 = downs[plan["a"]], downs[plan["a"] - plan["k"]]
    seg, reps = d1 - d0, plan["repeat"]
    out = [t if t < d1 else t + reps * seg for t in ts]
    out += [t + (r + 1) * seg for r in range(reps) for t in ts if d0 <= t < d1]
    return sorted(out)


def cmd_cut(a):
    np = audiolib.need("numpy", "music.py cut")
    load_film(a.film)
    src = Path(a.file)
    x, sr = audiolib.read_audio(src)
    info = read_json(src.with_suffix(".beats.json"), default={}) or analyze(src)
    if info.get("file") and Path(info["file"]).name != src.name:
        info = analyze(src)
    duration = len(x) / sr
    downs = extend_grid(info["downbeats"], duration)  # trackers often drop the last, decaying bars
    info = dict(info, beats=extend_grid(info["beats"], duration))
    if a.final_at is not None:
        final_raw, found = a.final_at, "given with --final-at"
    else:
        final_raw, found = final_chord(x.mean(axis=1), sr, downs)
    plan = plan_cut(downs, final_raw, a.end_at - a.at)

    def sa(t):
        return int(round(t * sr))

    if plan["k"] > 0:
        d0, d1 = downs[plan["a"]], downs[plan["a"] + plan["k"]]
        y = splice((x, [(0, sa(d0)), (sa(d1), len(x))]), sr, a.xfade)
        what = f"removed bars {plan['a']}-{plan['a'] + plan['k']} ({d0:.2f}-{d1:.2f} s)"
    elif plan["k"] < 0:
        d0, d1 = downs[plan["a"]], downs[plan["a"] - plan["k"]]
        y = splice((x, [(0, sa(d1))] + [(sa(d0), sa(d1))] * plan["repeat"] + [(sa(d1), len(x))]), sr, a.xfade)
        what = f"repeated bars {plan['a']}-{plan['a'] - plan['k']} ({d0:.2f}-{d1:.2f} s) x{plan['repeat']}"
    else:
        y, what = x.copy(), "no bars moved (the final chord already lands just after the target)"
    final_new = edit_times([final_raw], plan, downs)[0]
    beats = edit_times(info["beats"], plan, downs)
    downs_new = edit_times(downs, plan, downs)
    if a.to:  # the music ends at film time --to, so the track lasts to - at
        n = int(round((a.to - a.at) * sr))
        if len(y) > n:
            fade = min(n, int(min(1.5, max(0.2, (a.to - a.at - final_new) / 2)) * sr))
            y = y[:n].copy()
            y[n - fade :] *= np.linspace(1, 0, fade)[:, None]
        elif len(y) < n:
            y = np.concatenate([y, np.zeros((n - len(y), y.shape[1]), dtype=y.dtype)])
    length = len(y) / sr
    beats = [round(b + a.at, 3) for b in beats if b < length]
    downs_new = [round(b + a.at, 3) for b in downs_new if b < length]
    film_dir = Path(a.film)
    tmp = film_dir / "work" / "music" / "music_edit.wav"
    audiolib.write_wav(tmp, y, sr)
    fmt = a.format or ("mp3" if audiolib.has_ffmpeg() else "wav")
    out = film_dir / "web" / "audio" / f"music.{fmt}"
    out.parent.mkdir(parents=True, exist_ok=True)
    for ext in ("mp3", "wav"):
        if ext != fmt:
            (out.parent / f"music.{ext}").unlink(missing_ok=True)
    audiolib.encode(tmp, out)
    write_json(film_dir / "src" / "beats.json", {"bpm": info["bpm"], "beats": beats, "downbeats": downs_new})
    edit = {
        "source": str(src),
        "final_chord_raw": round(final_raw, 3),
        "final_chord_found": found,
        "final_chord_film": round(final_new + a.at, 3),
        "end_at": a.end_at,
        "what": what,
        "plan": plan,
        "length": round(length, 3),
        "output": str(out.relative_to(film_dir)),
        "xfade": a.xfade,
    }
    write_json(film_dir / "work" / "music" / "edit.json", edit)
    late = final_new + a.at - a.end_at
    print(
        f"cut: {what}; final chord {final_raw:.2f} s ({found}) -> {final_new + a.at:.2f} s in the film "
        f"({late:+.2f} s after {a.end_at:.2f}); {length:.2f} s -> {edit['output']}"
    )
    print(
        f"  src/beats.json: {info['bpm']} BPM, {len(beats)} beats, {len(downs_new)} downbeats; "
        f'storyboard music.asset = "audio/music.{fmt}"'
    )
    if late < -0.05 or late > plan["bar"] + 0.05:
        return EXIT_GATE
    return 0


def main(argv=None):
    ap = parser("music.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen", help="generate music candidates")
    add_film_arg(g)
    add_provider_args(g)
    g.add_argument("--n", type=int, help="candidates (default: film.json music.candidates)")
    g.add_argument("--prompt")
    g.add_argument("--prompt-file")
    g.add_argument("--draft", action="store_true", help="draft tier (30 s clips)")
    g.add_argument("--model")
    b = sub.add_parser("beats", help="beat and downbeat grid of an audio file")
    b.add_argument("file")
    b.add_argument("--out", help="JSON path (default: <file>.beats.json)")
    c = sub.add_parser("cut", help="cut the chosen track on downbeats so its final chord lands after the last word")
    add_film_arg(c)
    c.add_argument("--file", required=True, help="chosen candidate (its .beats.json is reused when present)")
    c.add_argument(
        "--end-at", type=float, required=True, help="film time the final chord should land at (last word end + pad)"
    )
    c.add_argument(
        "--to", type=float, help="film time the music ends (trim with a fade or pad); usually the film duration"
    )
    c.add_argument("--final-at", type=float, help="the final chord's time in the raw track (default: detected)")
    c.add_argument("--at", type=float, default=0.0, help="film time where the music starts (storyboard music.at)")
    c.add_argument("--xfade", type=float, default=0.06, help="equal-power crossfade at each splice, seconds")
    c.add_argument("--format", choices=("mp3", "wav"), help="default mp3 when ffmpeg exists, else wav")
    a = ap.parse_args(argv)
    return {"gen": cmd_gen, "beats": cmd_beats, "cut": cmd_cut}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
