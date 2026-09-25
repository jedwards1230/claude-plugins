"""OpenRouter client and the role providers that use it (tts, align, music, image, critic).

The key comes from --key-file <path> (KEY=VALUE lines or a bare key) or the OPENROUTER_API_KEY
environment variable. It is never printed, logged, written or put in an exception message.
OPENROUTER_BASE_URL overrides the API base (tests point it at a local fake server).
Request shapes follow what a finished film proved (see references/providers.md).
"""

import base64
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
import wave
from io import BytesIO
from pathlib import Path

from .base import (
    AvailabilityError,
    Provider,
    ProviderError,
    Result,
    UsageError,
    is_availability,
    sniff_audio,
    sniff_image,
)

DEFAULT_BASE = "https://openrouter.ai/api/v1"
KEY_VAR = "OPENROUTER_API_KEY"
TITLE = "animated-short"


class Secret:
    """Holds the API key; its repr and str never show it."""

    def __init__(self, value):
        self._v = value

    def reveal(self):
        return self._v

    def __repr__(self):
        return "<secret>"

    __str__ = __repr__


def read_key_file(path):
    """KEY=VALUE lines (optionally 'export', quoted) with OPENROUTER_API_KEY, or a single bare key."""
    p = Path(path).expanduser()
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        raise UsageError(f"cannot read the key file ({e.strerror})") from None
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    pairs = [ln for ln in lines if "=" in ln]
    for ln in pairs:
        k, v = ln.split("=", 1)
        k = k.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        if k == KEY_VAR:
            v = v.strip().strip('"').strip("'")
            if v:
                return v
    if not pairs and len(lines) == 1 and " " not in lines[0]:
        return lines[0]
    raise UsageError(f"the key file has no {KEY_VAR}=... line (or a single bare key)")


def load_key(key_file=None):
    """-> Secret or None. An explicit key file wins over the environment."""
    if key_file:
        return Secret(read_key_file(key_file))
    v = os.environ.get(KEY_VAR, "").strip()
    return Secret(v) if v else None


def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


class OpenRouter:
    """Minimal HTTP client. Every error message is scrubbed of the key."""

    def __init__(self, key=None, base_url=None):
        self.key = key
        self.base = (base_url or os.environ.get("OPENROUTER_BASE_URL") or DEFAULT_BASE).rstrip("/")
        self.retry_base = _env_float("ANIMATED_SHORT_RETRY_BASE", 2.0)
        self.timeout_override = os.environ.get("ANIMATED_SHORT_HTTP_TIMEOUT")

    def _scrub(self, text):
        text = str(text)
        if self.key and self.key.reveal():
            text = text.replace(self.key.reveal(), "***")
        return re.sub(r"sk-or-[A-Za-z0-9_-]{8,}", "sk-or-***", text)

    def _headers(self, auth=True, json_body=True):
        h = {"X-Title": TITLE, "User-Agent": TITLE}
        if json_body:
            h["Content-Type"] = "application/json"
        if auth:
            if not self.key:
                raise UsageError(f"no OpenRouter key: set {KEY_VAR} or pass --key-file <path>")
            h["Authorization"] = "Bearer " + self.key.reveal()
        return h

    def _timeout(self, t):
        return float(self.timeout_override) if self.timeout_override else t

    def request(self, method, path, payload=None, timeout=120, auth=True, stream=False, retries_429=3, retries_5xx=1):
        """-> (status, headers, body bytes) or an open response when stream=True.
        Raises AvailabilityError (fallback allowed) or ProviderError."""
        url = self.base + path
        data = json.dumps(payload).encode() if payload is not None else None
        attempt_429 = attempt_5xx = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=self._headers(auth, data is not None))
            try:
                resp = urllib.request.urlopen(req, timeout=self._timeout(timeout))
                if stream:
                    return resp
                with resp:
                    return resp.status, dict(resp.headers), resp.read()
            except urllib.error.HTTPError as e:
                try:
                    body = self._scrub(e.read().decode("utf-8", "replace"))[:600]
                finally:
                    e.close()
                if e.code == 429 and attempt_429 < retries_429:
                    attempt_429 += 1
                    wait = self.retry_base * (2 ** (attempt_429 - 1))
                    ra = e.headers.get("Retry-After") if e.headers else None
                    if ra and ra.replace(".", "", 1).isdigit():
                        wait = max(wait, min(float(ra), 30.0))
                    time.sleep(wait)
                    continue
                if e.code >= 500 and attempt_5xx < retries_5xx:
                    attempt_5xx += 1
                    time.sleep(self.retry_base)
                    continue
                msg = f"HTTP {e.code} on {path}: {_short(body)}"
                if is_availability(e.code, body):
                    raise AvailabilityError(msg, status=e.code) from None
                raise ProviderError(msg) from None
            except (socket.timeout, TimeoutError) as e:
                raise AvailabilityError(
                    f"timeout on {path} ({e.__class__.__name__})", maybe_charged=data is not None
                ) from None
            except urllib.error.URLError as e:
                reason = e.reason
                if isinstance(reason, (socket.timeout, TimeoutError)):
                    raise AvailabilityError(f"timeout on {path}", maybe_charged=data is not None) from None
                raise AvailabilityError(f"cannot reach {self.base} ({self._scrub(reason)})") from None
            except (ConnectionError, OSError) as e:
                raise AvailabilityError(
                    f"connection error on {path} ({e.__class__.__name__})", maybe_charged=data is not None
                ) from None

    def json(self, method, path, payload=None, timeout=120, auth=True):
        _, _, body = self.request(method, path, payload, timeout=timeout, auth=auth)
        try:
            out = json.loads(body)
        except json.JSONDecodeError:
            raise ProviderError(f"non-JSON response from {path}: {_short(self._scrub(body[:200]))}") from None
        if isinstance(out, dict) and out.get("error") and not out.get("choices") and not out.get("data"):
            err = out["error"]
            code = err.get("code") if isinstance(err, dict) else None
            msg = self._scrub(json.dumps(err))[:400]
            if isinstance(code, int) and is_availability(code, msg):
                raise AvailabilityError(f"error {code} on {path}: {msg}", status=code)
            raise ProviderError(f"error on {path}: {msg}")
        return out

    # ---- free endpoints
    def key_info(self):
        """GET /key -> {usage, limit, limit_remaining, ...} (free)."""
        return self.json("GET", "/key", timeout=30).get("data", {})

    def usage(self):
        return float(self.key_info().get("usage") or 0.0)

    def models(self, query="output_modalities=all"):
        """GET /models?output_modalities=all -> list (free; the bare endpoint hides audio/image models)."""
        path = "/models" + (("?" + query) if query else "")
        return self.json("GET", path, timeout=60, auth=False).get("data", [])

    # ---- paid endpoints
    def speech(self, model, text, voice, style=None, fmt="pcm", provider_opts=None, timeout=180):
        payload = {"model": model, "input": text, "voice": voice, "response_format": fmt}
        if style and model.startswith("google/"):
            payload["provider"] = {"options": {"google-ai-studio": {"speech_metadata": {"style": style}}}}
        if provider_opts:
            payload["provider"] = {"options": provider_opts}
        status, headers, body = self.request("POST", "/audio/speech", payload, timeout=timeout)
        ctype = headers.get("Content-Type", "") or headers.get("content-type", "")
        if "json" in ctype:
            try:
                err = json.loads(body).get("error")
            except (json.JSONDecodeError, AttributeError):
                err = None
            if err:
                raise AvailabilityError(f"speech error: {self._scrub(json.dumps(err))[:300]}")
        if not body:
            raise AvailabilityError("empty audio from /audio/speech")
        return body, headers

    def transcribe(self, model, audio_bytes, fmt="wav", language="en", granularity=("word",), timeout=300):
        payload = {
            "model": model,
            "input_audio": {"data": base64.b64encode(audio_bytes).decode(), "format": fmt},
            "response_format": "verbose_json",
            "timestamp_granularities": list(granularity),
        }
        if language:
            payload["language"] = language
        return self.json("POST", "/audio/transcriptions", payload, timeout=timeout)

    def chat(self, model, messages, timeout=600, **extra):
        return self.json(
            "POST", "/chat/completions", dict({"model": model, "messages": messages}, **extra), timeout=timeout
        )

    def chat_stream_audio(self, model, messages, timeout=900, **extra):
        """Streaming chat that collects choices[0].delta.audio.data -> (audio bytes, text, usage)."""
        payload = dict({"model": model, "messages": messages, "stream": True}, **extra)
        resp = self.request("POST", "/chat/completions", payload, timeout=timeout, stream=True)
        chunks, text, usage = [], [], None
        try:
            with resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    d = line[5:].strip()
                    if d == "[DONE]":
                        break
                    try:
                        j = json.loads(d)
                    except json.JSONDecodeError:
                        continue
                    if j.get("error"):
                        err = self._scrub(json.dumps(j["error"]))[:400]
                        code = j["error"].get("code") if isinstance(j["error"], dict) else None
                        if isinstance(code, int) and is_availability(code, err):
                            raise AvailabilityError(f"stream error {code}: {err}", status=code)
                        raise ProviderError(f"stream error: {err}")
                    if j.get("usage"):
                        usage = j["usage"]
                    ch = (j.get("choices") or [{}])[0]
                    delta = ch.get("delta") or {}
                    audio = delta.get("audio") or {}
                    if audio.get("data"):
                        chunks.append(audio["data"])
                    if audio.get("transcript"):
                        text.append(audio["transcript"])
                    if delta.get("content"):
                        text.append(delta["content"])
        except (socket.timeout, TimeoutError):
            raise AvailabilityError("timeout while streaming audio", maybe_charged=True) from None
        audio = base64.b64decode("".join(chunks)) if chunks else b""
        return audio, "".join(text), usage

    def images(self, model, prompt, timeout=600, **params):
        payload = dict({"model": model, "prompt": prompt, "n": 1}, **params)
        return self.json("POST", "/images", payload, timeout=timeout)


def _short(text):
    return re.sub(r"\s+", " ", str(text)).strip()[:300]


def usage_cost(obj):
    """usage.cost from a response or usage dict, or None."""
    u = obj.get("usage") if isinstance(obj, dict) and "usage" in obj else obj
    if isinstance(u, dict) and isinstance(u.get("cost"), (int, float)):
        return float(u["cost"])
    return None


def pcm_to_wav(pcm, rate=24000, channels=1, width=2):
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(pcm[: len(pcm) - len(pcm) % (channels * width)])
    return buf.getvalue()


def wav_seconds(data):
    with wave.open(BytesIO(data), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def data_url(path, mime=None):
    p = Path(path)
    ext = p.suffix.lower().lstrip(".")
    mime = mime or {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "mp4": "video/mp4",
        "webm": "video/webm",
    }.get(ext, "application/octet-stream")
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()


def catalog_price(entry):
    """Catalog entry -> {prompt, completion, image_output, per_generation} (floats or None)."""
    pr = entry.get("pricing") or {}

    def f(k):
        try:
            return float(pr[k])
        except (KeyError, TypeError, ValueError):
            return None

    out = {k: f(k) for k in ("prompt", "completion", "image_output")}
    m = re.search(r"\$(\d+(?:\.\d+)?) per (?:song|clip|image|video|generation)", entry.get("description") or "")
    out["per_generation"] = float(m.group(1)) if m else None
    return out


# ---------------------------------------------------------------- role providers
class OpenRouterProvider(Provider):
    def __init__(self, cand, ctx):
        super().__init__(cand, ctx)
        self.params = cand.get("params", {})

    @property
    def client(self):
        return self.ctx.client()

    def available(self):
        if self.cand.get("implemented") is False:
            return False, "not implemented (opt-in registry entry only)"
        if self.ctx.key() is None:
            return False, f"no key ({KEY_VAR} or --key-file)"
        return True, ""

    def pricing(self):
        """Catalog pricing refreshed by preflight when present, else the registry snapshot."""
        live = self.ctx.live_pricing().get(self.model)
        return live or self.cand.get("cost", {}).get("pricing") or {}

    def probe(self, tier=0):
        ok, why = self.available()
        if not ok:
            return {"ok": False, "reason": why, "usd": 0.0}
        entry = self.ctx.catalog().get(self.model)
        if entry is None:
            return {"ok": False, "reason": "not in the catalog", "usd": 0.0}
        outs = (entry.get("architecture") or {}).get("output_modalities") or []
        if self.cand.get("modality") and self.cand["modality"] not in outs:
            return {"ok": False, "reason": f"catalog output modalities {outs} lack {self.cand['modality']}", "usd": 0.0}
        exp = entry.get("expiration_date")
        return {"ok": True, "reason": "in the catalog" + (f"; expires {exp}" if exp else ""), "usd": 0.0}


class TTS(OpenRouterProvider):
    """job: text, voice, style, out_dir, stem -> <stem>.wav (PCM 24 kHz s16le mono converted in Python)."""

    def estimate(self, text="", **job):
        cost = self.cand.get("cost", {})
        pr = self.pricing()
        words = len(str(text).split())
        seconds = max(1.0, words / 2.5)
        tps = cost.get("tokens_per_second", 32)
        est = seconds * tps * float(pr.get("completion") or 0) + len(str(text)) / 4 * float(pr.get("prompt") or 0)
        return round(max(est, cost.get("min_usd", 0.0)) if pr else float(cost.get("usd") or 0.01), 6)

    def run(self, text, voice, style=None, out_dir=".", stem="take", **job):
        style = style if self.params.get("style", True) else None
        body, headers = self.client.speech(
            self.model, text, voice, style=style, fmt=self.params.get("response_format", "pcm")
        )
        ctype = (headers.get("Content-Type") or headers.get("content-type") or "").lower()
        if sniff_audio(body) == "wav":
            wav = body
        elif any(t in ctype for t in ("mpeg", "mp3", "ogg", "opus", "aac")):
            raise ProviderError(f"expected PCM from {self.model}, got {ctype}")
        else:  # raw PCM, as requested (never sniffed: noise can look like an MP3 sync word)
            wav = pcm_to_wav(body, rate=int(self.params.get("sample_rate", 24000)))
        seconds = wav_seconds(wav)
        if seconds < 0.2:
            raise AvailabilityError(f"{self.model} returned {seconds:.2f} s of audio")
        out = Path(out_dir) / f"{stem}.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(wav)
        # /audio/speech returns bare audio with no usage.cost: the ledger records the estimate and
        # ledger.py reconcile compares it with the account's usage
        return Result(files=[out], usd=None, basis="estimate", data={"seconds": round(seconds, 3), "voice": voice})


class Align(OpenRouterProvider):
    """job: audio (Path to wav/mp3), text (intended), language -> data {text, words:[{word,start,end}]}."""

    def estimate(self, audio=None, **job):
        cost = self.cand.get("cost", {})
        minutes = 0.25
        if audio is not None and Path(audio).suffix.lower() == ".wav" and Path(audio).exists():
            with wave.open(str(audio), "rb") as w:
                minutes = w.getnframes() / float(w.getframerate()) / 60
        return round(max(float(cost.get("usd") or 0.01) * minutes, cost.get("min_usd", 0.0)), 6)

    def run(self, audio, language="en", **job):
        p = Path(audio)
        fmt = p.suffix.lower().lstrip(".") or "wav"
        r = self.client.transcribe(self.model, p.read_bytes(), fmt=fmt, language=language)
        words = [
            {"word": str(w.get("word", "")).strip(), "start": float(w["start"]), "end": float(w["end"])}
            for w in (r.get("words") or [])
            if "start" in w and "end" in w
        ]
        if self.params.get("requires_words") and not words:
            raise AvailabilityError(f"{self.model} returned no word timestamps")
        cost = usage_cost(r)
        return Result(
            usd=cost,
            basis="usage.cost" if cost is not None else "estimate",
            data={"text": r.get("text", ""), "words": words, "coarse": False, "model": self.model},
        )


class Music(OpenRouterProvider):
    """job: prompt, out_dir, stem -> <stem>.<mp3|wav|...> from a streaming chat with audio output."""

    def estimate(self, **job):
        per = (self.ctx.live_pricing().get(self.model) or {}).get("per_generation")
        return float(per or self.cand.get("cost", {}).get("usd") or 0.1)

    def run(self, prompt, out_dir=".", stem="music", **job):
        audio, text, usage = self.client.chat_stream_audio(self.model, [{"role": "user", "content": prompt}])
        if not audio:
            raise AvailabilityError(f"{self.model} streamed no audio ({_short(text)[:120]})")
        ext = sniff_audio(audio)
        out = Path(out_dir) / f"{stem}.{ext if ext != 'bin' else 'mp3'}"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(audio)
        cost = usage_cost(usage or {})
        return Result(
            files=[out],
            usd=cost,
            basis="usage.cost" if cost is not None else "estimate",
            data={"text": text, "format": ext},
        )


class Image(OpenRouterProvider):
    """job: prompt, refs [Path], aspect, size, out_dir, stem -> <stem>_<i>.<png|jpg|webp>."""

    def estimate(self, size=None, **job):
        cost = self.cand.get("cost", {})
        size = size or self.params.get("image_size") or self.params.get("resolution")
        return float(cost.get("usd_by_size", {}).get(size) or cost.get("usd") or 0.3)

    def run(self, prompt, refs=(), aspect="1:1", size=None, out_dir=".", stem="sheet", **job):
        size = size or self.params.get("image_size") or self.params.get("resolution")
        if self.cand.get("endpoint") == "/images":
            if refs:
                raise ProviderError(
                    f"{self.model} uses POST /images here, which takes no reference images; pick a chat image model"
                )
            extra = {k: v for k, v in self.params.items() if k in ("background", "output_format", "seed")}
            r = self.client.images(self.model, prompt, aspect_ratio=aspect, resolution=size, **extra)
            blobs = [base64.b64decode(d["b64_json"]) for d in r.get("data", []) if d.get("b64_json")]
            text = ""
        else:
            content = [{"type": "text", "text": prompt}] + [
                {"type": "image_url", "image_url": {"url": data_url(p)}} for p in refs
            ]
            cfg = {"aspect_ratio": aspect}
            if size:
                cfg["image_size"] = size
            r = self.client.chat(
                self.model, [{"role": "user", "content": content}], modalities=["image", "text"], image_config=cfg
            )
            msg = (r.get("choices") or [{}])[0].get("message") or {}
            blobs = []
            for im in msg.get("images") or []:
                url = (im.get("image_url") or {}).get("url", "")
                if "," in url:
                    blobs.append(base64.b64decode(url.split(",", 1)[1]))
            text = msg.get("content") or ""
        if not blobs:
            raise AvailabilityError(f"{self.model} returned no image ({_short(text)[:160]})")
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for i, b in enumerate(blobs):
            ext = sniff_image(b)
            f = out_dir / f"{stem}_{i}.{ext if ext != 'bin' else 'png'}"
            f.write_bytes(b)
            files.append(f)
        cost = usage_cost(r)
        return Result(
            files=files,
            usd=cost,
            basis="usage.cost" if cost is not None else "estimate",
            data={"text": text, "size": size, "aspect": aspect},
        )


class Critic(OpenRouterProvider):
    """job: prompt (text), video (Path), audio [Path], images [Path], media_seconds -> data {text}."""

    def estimate(self, prompt="", video=None, audio=(), images=(), media_seconds=None, **job):
        cost = self.cand.get("cost", {})
        pr = self.pricing()
        if not pr:
            return float(cost.get("usd") or 0.05)
        secs = float(media_seconds or (90 if video else 0))
        tokens_in = len(str(prompt)) / 4 + (300 * secs if video else 0) + 32 * secs * (1 if audio and not video else 0)
        tokens_in += 1300 * len(images or ())
        tokens_out = 6000
        est = tokens_in * float(pr.get("prompt") or 0) + tokens_out * float(pr.get("completion") or 0)
        return round(max(est * 1.5, cost.get("min_usd", 0.0)), 6)

    def run(self, prompt, video=None, audio=(), images=(), **job):
        content = [{"type": "text", "text": prompt}]
        for p in images or ():
            content.append({"type": "text", "text": f"--- image: {Path(p).name} ---"})
            content.append({"type": "image_url", "image_url": {"url": data_url(p)}})
        for p in audio or ():
            p = Path(p)
            content.append({"type": "text", "text": f"--- audio: {p.name} ---"})
            content.append(
                {
                    "type": "input_audio",
                    "input_audio": {
                        "data": base64.b64encode(p.read_bytes()).decode(),
                        "format": p.suffix.lower().lstrip("."),
                    },
                }
            )
        if video:
            content.append({"type": "video_url", "video_url": {"url": data_url(video)}})
        r = self.client.chat(self.model, [{"role": "user", "content": content}])
        msg = (r.get("choices") or [{}])[0].get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        if not text.strip():
            raise AvailabilityError(f"{self.model} returned an empty reply")
        cost = usage_cost(r)
        return Result(
            usd=cost, basis="usage.cost" if cost is not None else "estimate", data={"text": text, "model": self.model}
        )


class Video(OpenRouterProvider):
    cacheable = False

    def run(self, **job):
        raise UsageError("the video role is opt-in and not implemented by these tools")


ROLE_CLASSES = {"tts": TTS, "align": Align, "music": Music, "image": Image, "critic": Critic, "video": Video}
