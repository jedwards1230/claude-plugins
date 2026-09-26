"""Test helpers: import path, a fake OpenRouter server on 127.0.0.1, synthetic media and temp films.

Importing this module points OPENROUTER_BASE_URL at a closed local port and sets a fake key, so no
test can ever reach the real API; tests that need responses start FakeOpenRouter and point at it.
"""

import base64
import contextlib
import io
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import threading
import time
import unittest
import wave
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SCRIPTS = Path(__file__).resolve().parent.parent
SKILL_DIR = SCRIPTS.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

FAKE_KEY = "sk-or-v1-FAKE0123456789abcdefFAKE"
os.environ["OPENROUTER_BASE_URL"] = "http://127.0.0.1:9/api/v1"  # nothing listens there
os.environ["OPENROUTER_API_KEY"] = FAKE_KEY
os.environ["ANIMATED_SHORT_RETRY_BASE"] = "0.01"
os.environ.pop("ANIMATED_SHORT_ACCOUNT_CEILING", None)
os.environ.pop("ANIMATED_SHORT_HTTP_TIMEOUT", None)

MODALITY = {
    "speech": ["speech"],
    "transcription": ["transcription"],
    "audio": ["text", "audio"],
    "image": ["image", "text"],
    "text": ["text"],
    "video": ["video"],
}


# ---------------------------------------------------------------- synthetic media
def pcm_sine(seconds=0.6, rate=24000, freq=440.0, amp=0.3):
    n = int(seconds * rate)
    return b"".join(struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * freq * i / rate))) for i in range(n))


def wav_bytes(samples, rate=24000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, int(s * 32767)))) for s in samples))
    return buf.getvalue()


def write_wav(path, samples, rate=24000):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(wav_bytes(samples, rate))
    return Path(path)


def bursts(spans, total, rate=24000, freq=220.0):
    """Tone bursts at [(start, end)] seconds inside `total` seconds of silence."""
    out = [0.0] * int(total * rate)
    for a, b in spans:
        for i in range(int(a * rate), int(b * rate)):
            out[i] = 0.5 * math.sin(2 * math.pi * freq * i / rate)
    return out


def png_bytes(w=8, h=8, rgb=(200, 80, 60)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------- fake OpenRouter
class FakeOpenRouter:
    """Serves /key, /models, /audio/speech, /audio/transcriptions, /chat/completions (text, images,
    streamed audio) and /images. plan[model] = [status, ...] makes calls fail (the last entry repeats);
    200 means success. Every paid success adds `cost` to usage and reports usage.cost."""

    def __init__(self):
        from providers import Registry

        self.registry = Registry.load()
        self.requests, self.plan, self.replies, self.delay = [], {}, [], {}
        self.usage, self.limit, self.cost = 3.0, 10.0, 0.0012
        self.words = [("hello", 0.1, 0.4), ("world", 0.5, 0.9)]
        self.echo_key = False
        self.hide_cost = False
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client gave up (timeout tests)

            def do_GET(self):
                fake._handle(self, "GET", None)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                fake._handle(self, "POST", json.loads(self.rfile.read(n) or b"{}"))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self._old = os.environ.get("OPENROUTER_BASE_URL")
        os.environ["OPENROUTER_BASE_URL"] = self.url
        return self

    def __exit__(self, *exc):
        os.environ["OPENROUTER_BASE_URL"] = self._old
        self.server.shutdown()
        self.server.server_close()

    def calls(self, path=None, model=None):
        return [
            r
            for r in self.requests
            if (path is None or r["path"].endswith(path)) and (model is None or (r["body"] or {}).get("model") == model)
        ]

    def catalog(self, all_modalities=True):
        out = []
        for role, cands in self.registry.roles.items():
            for c in cands:
                if c["provider"] != "openrouter":
                    continue
                outs = MODALITY[c["modality"]]
                if not all_modalities and outs != ["text"]:
                    continue
                pr = c.get("cost", {}).get("pricing") or {}
                out.append(
                    {
                        "id": c["model"],
                        "architecture": {"output_modalities": outs},
                        "pricing": {k: str(v) for k, v in pr.items()},
                        "description": f"Priced at ${c['cost']['usd']} per song." if role == "music" else "model",
                    }
                )
        return out

    def _status(self, model):
        with self.lock:
            seq = self.plan.get(model)
            if not seq:
                return 200
            return seq.pop(0) if len(seq) > 1 else seq[0]

    def _usage(self):
        return None if self.hide_cost else {"prompt_tokens": 10, "completion_tokens": 10, "cost": self.cost}

    def _handle(self, h, method, body):
        u = urlparse(h.path)
        path = u.path[len("/api/v1") :] if u.path.startswith("/api/v1") else u.path
        auth = h.headers.get("Authorization", "")
        self.requests.append(
            {
                "method": method,
                "path": path,
                "query": parse_qs(u.query),
                "body": body,
                "auth": auth == "Bearer " + FAKE_KEY,
                "title": h.headers.get("X-Title"),
            }
        )
        if path == "/models":
            return h._send(200, {"data": self.catalog("output_modalities=all" in u.query)})
        if path == "/key":
            if not auth:
                return h._send(401, {"error": {"code": 401, "message": "no auth"}})
            return h._send(
                200,
                {
                    "data": {
                        "label": "test",
                        "usage": round(self.usage, 6),
                        "limit": self.limit,
                        "limit_remaining": round(self.limit - self.usage, 6),
                    }
                },
            )
        model = (body or {}).get("model")
        if model in self.delay:
            time.sleep(self.delay[model])
        status = self._status(model)
        if status != 200:
            msg = f"failure {status} for {model}" + (f" key={auth}" if self.echo_key else "")
            if status == 400:
                msg = "invalid input: the text field is malformed"
            return h._send(status, {"error": {"code": status, "message": msg}})
        self.usage += self.cost
        if path == "/audio/speech":
            return h._send(200, pcm_sine(), "audio/pcm")
        if path == "/audio/transcriptions":
            words = [{"word": w, "start": s, "end": e} for w, s, e in self.words]
            return h._send(200, {"text": " ".join(w for w, _, _ in self.words), "words": words, "usage": self._usage()})
        if path == "/images":
            return h._send(
                200, {"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}], "usage": self._usage()}
            )
        if path == "/chat/completions":
            if body.get("stream"):
                audio = base64.b64encode(wav_bytes([0.2 * math.sin(i / 5) for i in range(24000)])).decode()
                parts = [audio[i : i + 20000] for i in range(0, len(audio), 20000)]
                lines = [{"choices": [{"delta": {"audio": {"data": p}}}]} for p in parts]
                lines.append({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": self._usage()})
                data = "".join(f"data: {json.dumps(x)}\n\n" for x in lines) + "data: [DONE]\n\n"
                return h._send(200, data.encode(), "text/event-stream")
            if "image" in (body.get("modalities") or []):
                url = "data:image/png;base64," + base64.b64encode(png_bytes()).decode()
                msg = {
                    "role": "assistant",
                    "content": "here",
                    "images": [{"type": "image_url", "image_url": {"url": url}}],
                }
                return h._send(200, {"choices": [{"message": msg}], "usage": self._usage()})
            with self.lock:
                text = self.replies.pop(0) if self.replies else "OK"
            return h._send(
                200, {"choices": [{"message": {"role": "assistant", "content": text}}], "usage": self._usage()}
            )
        return h._send(404, {"error": {"code": 404, "message": "not found"}})


# ---------------------------------------------------------------- films
def new_film(root, **overrides):
    """Scaffold a film with scaffold.py (engine copied) and film.json overrides; -> Path."""
    import scaffold

    film = {
        "topic": "How a kettle boils",
        "goal": "Know what happens inside a kettle",
        "message": "Heat makes bubbles, and bubbles make the whistle.",
    }
    film.update(overrides)
    fj = Path(root) / "input-film.json"
    fj.write_text(json.dumps(film))
    d = Path(root) / "film"
    with quiet():
        rc = scaffold.main(["new", str(d), "--film-json", str(fj)])
    assert rc == 0
    return d


def fix_pass_film(root, **overrides):
    """A film at the fix pass after its last round (fixtures/round-fix): round 4 holds the shipping reviews
    of fixtures/round-ship plus frame QA with 7 counted defects, a fact-check with 3 and a sign-off; r4-fix
    holds a new technical review, frame QA and fact-check whose "previous" lists judge those defects."""
    film = new_film(root, **overrides)
    reviews = film / "work" / "reviews"
    for label in ("4", "4-fix"):
        (reviews / f"r{label}").mkdir(parents=True, exist_ok=True)
    for f in (FIXTURES / "round-ship").glob("*.json"):
        doc = json.loads(f.read_text())
        doc["cut"] = "r4"
        (reviews / "r4" / f.name).write_text(json.dumps(doc))
    tech = json.loads((FIXTURES / "round-ship" / "technical.json").read_text())
    tech["cut"] = "r4-fix"
    (reviews / "r4-fix" / "technical.json").write_text(json.dumps(tech))
    for label in ("4", "4-fix"):
        for f in (FIXTURES / "round-fix" / f"r{label}").glob("*.json"):
            shutil.copy(f, reviews / f"r{label}" / f.name)
    (film / "work" / "direction" / "quiz.json").write_text((FIXTURES / "quiz.json").read_text())
    return film


def write_script(film_dir, lines):
    (Path(film_dir) / "src").mkdir(parents=True, exist_ok=True)
    (Path(film_dir) / "src" / "script.json").write_text(json.dumps({"lines": lines}))


@contextlib.contextmanager
def quiet():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


def run_tool(module, argv):
    """Run a tool's main() in-process; -> (exit code, stdout, stderr). ToolErrors map to exit codes."""
    from providers.base import ToolError

    with quiet() as (out, err):
        try:
            code = module.main(argv)
        except ToolError as e:
            print(f"{module.__name__}: {e}", file=sys.stderr)
            code = e.exit_code
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 2
    return code, out.getvalue(), err.getvalue()


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="animated-short-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
