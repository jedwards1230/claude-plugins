"""Audio helpers shared by the voice, music and alignment tools.

Stdlib: WAV read/write (8/16/24/32-bit PCM) and a frame-energy envelope. With numpy: arrays,
FFT filtering, BS.1770-4 integrated loudness (measurement only) and simple dynamics. Anything
that is not a PCM WAV is decoded with ffmpeg when present, else soundfile/librosa if installed.
"""

import array
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from providers.base import UsageError

HINT = "pip install -r {req}".format(req=os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements.txt"))


def need(module, why):
    """Import an optional dependency or stop with an install hint (exit 2)."""
    try:
        return __import__(module)
    except ImportError:
        raise UsageError(f"{why} needs the Python package '{module}': {HINT}") from None


def has(module):
    try:
        __import__(module)
        return True
    except ImportError:
        return False


def which(name):
    return shutil.which(name)


def has_ffmpeg():
    return bool(which("ffmpeg") and which("ffprobe"))


def run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise UsageError(f"{Path(cmd[0]).name} failed: {r.stderr.strip()[-400:]}")
    return r


# ---------------------------------------------------------------- stdlib WAV
def _decode_frames(raw, width):
    if width == 2:
        a = array.array("h")
        a.frombytes(raw)
        if sys.byteorder == "big":
            a.byteswap()
        return a, 32768.0
    if width == 1:
        return array.array("h", (b - 128 for b in raw)), 128.0
    if width == 3:
        vals = array.array("i", (int.from_bytes(raw[i : i + 3], "little", signed=True) for i in range(0, len(raw), 3)))
        return vals, 8388608.0
    if width == 4:
        a = array.array("i")
        a.frombytes(raw)
        if sys.byteorder == "big":
            a.byteswap()
        return a, 2147483648.0
    raise UsageError(f"unsupported WAV sample width {width}")


def read_wav_mono(path):
    """-> (list of floats in [-1, 1], sample rate). Channels are averaged. PCM WAV only."""
    try:
        with wave.open(str(path), "rb") as w:
            ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as e:
        raise UsageError(
            f"{path}: not a PCM WAV file ({e}); convert it first (ffmpeg -i in -c:a pcm_s16le out.wav)"
        ) from None
    vals, scale = _decode_frames(raw, width)
    if ch == 1:
        return [v / scale for v in vals], sr
    return [sum(vals[i : i + ch]) / (ch * scale) for i in range(0, len(vals), ch)], sr


def wav_duration(path):
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def envelope_db(samples, sr, hop=0.01):
    """RMS level per hop-second frame, in dBFS (-120 for silence)."""
    n = max(1, int(sr * hop))
    out = []
    for i in range(0, len(samples) - n + 1, n):
        frame = samples[i : i + n]
        ms = sum(s * s for s in frame) / n
        out.append(10 * math.log10(ms) if ms > 1e-12 else -120.0)
    return out


# ---------------------------------------------------------------- numpy
def read_audio(path, sr=None):
    """-> (numpy float32 array (n, channels), sample rate). WAV natively; other formats through ffmpeg,
    soundfile or librosa. With sr, resamples through ffmpeg or librosa."""
    np = need("numpy", "audio processing")
    path = Path(path)
    if not path.exists():
        raise UsageError(f"{path}: no such file")
    if path.suffix.lower() == ".wav" and sr is None:
        try:
            with wave.open(str(path), "rb") as w:
                ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                raw = w.readframes(n)
            vals, scale = _decode_frames(raw, width)
            x = np.asarray(vals, dtype=np.float32).reshape(-1, ch) / scale
            return x, rate
        except wave.Error:
            pass  # float WAV and friends: fall through to the decoders
    if has_ffmpeg():
        with tempfile.TemporaryDirectory() as td:
            tmp = os.path.join(td, "a.wav")
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-c:a", "pcm_s16le"]
            if sr:
                cmd += ["-ar", str(int(sr))]
            run(cmd + [tmp])
            return read_audio(tmp)
    if has("soundfile") and sr is None:
        import soundfile

        x, rate = soundfile.read(str(path), dtype="float32", always_2d=True)
        return x, rate
    if has("librosa"):
        import librosa

        y, rate = librosa.load(str(path), sr=sr, mono=False)
        y = np.atleast_2d(y).T.astype(np.float32)
        return y, rate
    raise UsageError(
        f"decoding {path.suffix} needs ffmpeg on PATH, or the optional package soundfile (pip install soundfile)"
    )


def write_wav(path, x, sr):
    """numpy float array (n,) or (n, channels) -> 16-bit PCM WAV."""
    np = need("numpy", "audio processing")
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    pcm = (np.clip(x, -1, 1) * 32767).round().astype("<i2")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def encode(src_wav, dst, bitrate="192k"):
    """WAV -> mp3/ogg/wav by extension (ffmpeg for compressed formats)."""
    dst = Path(dst)
    if dst.suffix.lower() == ".wav":
        shutil.copyfile(src_wav, dst)
        return dst
    if not has_ffmpeg():
        raise UsageError(f"writing {dst.suffix} needs ffmpeg; use --format wav instead")
    codec = {".mp3": ["-c:a", "libmp3lame", "-b:a", bitrate], ".ogg": ["-c:a", "libopus", "-b:a", "128k"]}.get(
        dst.suffix.lower()
    )
    if codec is None:
        raise UsageError(f"unsupported output format {dst.suffix}")
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src_wav)] + codec + [str(dst)])
    return dst


def fft_filter(x, sr, gain_fn):
    """Zero-phase filter: multiply the spectrum by gain_fn(freqs) (per channel)."""
    np = need("numpy", "audio processing")
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    size = 1 << max(1, (n - 1).bit_length())
    spec = np.fft.rfft(x, n=size, axis=0)
    g = gain_fn(np.fft.rfftfreq(size, 1.0 / sr))
    return np.fft.irfft(spec * g[:, None] if x.ndim == 2 else spec * g, n=size, axis=0)[:n]


def k_weight_gain(f):
    """Magnitude of the BS.1770 K-weighting (high shelf +4 dB near 1.7 kHz, then a 38 Hz high-pass)."""
    np = need("numpy", "loudness")
    f = np.maximum(f, 1e-6)
    shelf_db = 4.0 / (1 + (1681.97 / f) ** 2)
    hp = (f / 38.13) ** 2 / np.sqrt(1 + (f / 38.13) ** 4)
    return 10 ** (shelf_db / 20) * hp


def integrated_lufs(x, sr):
    """BS.1770-4 integrated loudness (gated), measured with a zero-phase K-weighting."""
    np = need("numpy", "loudness")
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    y = fft_filter(x, sr, k_weight_gain)
    block, step = int(0.4 * sr), int(0.1 * sr)
    if y.shape[0] < block:
        return -70.0
    starts = range(0, y.shape[0] - block + 1, step)
    power = np.array([float(np.mean(y[s : s + block] ** 2, axis=0).sum()) for s in starts])
    lk = -0.691 + 10 * np.log10(np.maximum(power, 1e-12))
    gated = power[lk > -70]
    if not len(gated):
        return -70.0
    rel = -0.691 + 10 * np.log10(gated.mean()) - 10
    final = power[(lk > -70) & (lk > rel)]
    return float(-0.691 + 10 * np.log10(final.mean())) if len(final) else -70.0
