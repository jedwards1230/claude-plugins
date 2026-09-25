"""Local aligners: WhisperX when it is installed (BSD-2), and a $0 energy aligner that always works.

The energy aligner does not recognize speech: it finds voiced regions in the take and spreads the
intended script's words over them by syllable count, snapping word edges to pauses. Its output is
flagged coarse=True; it cannot catch a mispronounced or missing word.
"""

import importlib.util
import os
import re

from .base import Provider, ProviderError, Result


def syllables(word):
    """Rough English syllable count (at least 1); digits count about 1.3 each."""
    w = word.lower()
    digits = sum(c.isdigit() for c in w)
    letters = re.sub(r"[^a-z]", "", w)
    n = len(re.findall(r"[aeiouy]+", letters))
    if letters.endswith("e") and not letters.endswith(("le", "ee")) and n > 1:
        n -= 1
    return max(1, n + round(digits * 1.3))


def voiced_regions(env, hop=0.01, merge_gap=0.08, min_len=0.05):
    """Envelope (dBFS per hop) -> [(start s, end s)] of voiced audio."""
    if not env:
        return []
    ordered = sorted(env)
    floor = ordered[len(ordered) // 10]
    thr = max(floor + 10.0, max(env) - 35.0)
    regions, start = [], None
    for i, e in enumerate(env + [-999.0]):
        if e > thr and start is None:
            start = i
        elif e <= thr and start is not None:
            regions.append([start * hop, i * hop])
            start = None
    merged = []
    for r in regions:
        if merged and r[0] - merged[-1][1] < merge_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(round(a, 3), round(b, 3)) for a, b in merged if b - a >= min_len]


def energy_align(wav_path, text):
    """-> [{"word", "start", "end"}] spread over voiced regions (coarse)."""
    from audiolib import envelope_db, read_wav_mono  # scripts/audiolib.py imports this package: import late

    samples, sr = read_wav_mono(wav_path)
    regions = voiced_regions(envelope_db(samples, sr))
    words = str(text).split()
    if not words:
        return []
    if not regions:
        raise ProviderError(f"{wav_path}: no voiced audio found")
    total = sum(b - a for a, b in regions)
    weights = [syllables(w) + 0.3 for w in words]
    wsum = sum(weights)
    bounds, acc = [0.0], 0.0
    for w in weights:
        acc += w
        bounds.append(total * acc / wsum)
    # snap internal word edges to pauses (region ends in voiced time) when they are close
    edges, acc = [], 0.0
    for a, b in regions[:-1]:
        acc += b - a
        edges.append(acc)
    tol = 0.35 * total / len(words)
    for i in range(1, len(bounds) - 1):
        near = min(edges, key=lambda e: abs(e - bounds[i]), default=None)
        if near is not None and abs(near - bounds[i]) < tol:
            bounds[i] = near
        bounds[i] = max(bounds[i], bounds[i - 1])

    def to_time(u, starting):
        acc = 0.0
        for k, (a, b) in enumerate(regions):
            d = b - a
            if u < acc + d - 1e-9 or (not starting and u <= acc + d + 1e-9) or k == len(regions) - 1:
                return a + min(max(u - acc, 0.0), d)
            acc += d
        return regions[-1][1]

    out = []
    for i, w in enumerate(words):
        s, e = to_time(bounds[i], True), to_time(bounds[i + 1], False)
        out.append({"word": w, "start": round(s, 3), "end": round(max(e, s + 0.02), 3)})
    return out


class Energy(Provider):
    local = True

    def estimate(self, **job):
        return 0.0

    def run(self, audio, text="", **job):
        if not str(text).strip():
            raise ProviderError("the energy aligner needs the intended text of the take")
        words = energy_align(audio, text)
        return Result(usd=0.0, basis="local", data={"text": text, "words": words, "coarse": True, "model": "energy"})


class WhisperX(Provider):
    local = True

    def available(self):
        if importlib.util.find_spec("whisperx") is None:
            return False, "whisperx is not installed (pip install whisperx)"
        return True, ""

    def estimate(self, **job):
        return 0.0

    def run(self, audio, language="en", **job):
        import whisperx

        device = os.environ.get("ANIMATED_SHORT_WHISPERX_DEVICE")
        if not device:
            try:
                import torch

                device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                device = "cpu"
        compute = "float16" if device == "cuda" else "int8"
        model = whisperx.load_model(
            self.cand.get("params", {}).get("model_size", "small"), device, compute_type=compute, language=language
        )
        pcm = whisperx.load_audio(str(audio))
        res = model.transcribe(pcm, batch_size=8, language=language)
        amodel, meta = whisperx.load_align_model(language_code=language, device=device)
        aligned = whisperx.align(res["segments"], amodel, meta, pcm, device, return_char_alignments=False)
        words = [
            {"word": str(w["word"]).strip(), "start": float(w["start"]), "end": float(w["end"])}
            for w in aligned.get("word_segments", [])
            if "start" in w and "end" in w
        ]
        text = " ".join(seg.get("text", "").strip() for seg in res.get("segments", []))
        return Result(usd=0.0, basis="local", data={"text": text, "words": words, "coarse": False, "model": "whisperx"})


LOCAL_CLASSES = {"energy": Energy, "whisperx": WhisperX}
