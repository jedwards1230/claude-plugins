"""Registry integrity, key handling, the OpenRouter client and the fallback walker (fake server only)."""

import json
import os
import unittest
import wave

from helpers import FAKE_KEY, FakeOpenRouter, TempDirTest, bursts, new_film, write_wav

import common
from providers import Context, Registry, run_role
from providers.base import BudgetRefused, ProviderError, ProviderUnavailable, StickyFailure, UsageError, is_availability
from providers.openrouter import OpenRouter, Secret, catalog_price, load_key, read_key_file

# every model id the registry may use (the verified list)
VERIFIED = {
    "google/gemini-3.8-flash-tts",
    "google/gemini-3.8-flash-lite-tts",
    "google/gemini-3.1-flash-tts-preview",
    "hexgrad/kokoro-82m",
    "openai/whisper-1",
    "openai/whisper-large-v3",
    "google/lyria-3-pro-preview",
    "google/lyria-3-clip-preview",
    "google/gemini-3-pro-image-preview",
    "google/gemini-3-pro-image",
    "google/gemini-3.1-flash-image",
    "google/gemini-3.1-flash-image-preview",
    "google/gemini-2.5-flash-image",
    "openai/gpt-image-2",
    "recraft/recraft-v4.1",
    "black-forest-labs/flux.2-pro",
    "black-forest-labs/flux.2-klein-4b",
    "bytedance-seed/seedream-4.5",
    "google/gemini-3.8-flash",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro",
    "google/veo-3.1",
    "google/veo-3.1-fast",
    "google/veo-3.1-lite",
    "kwaivgi/kling-v3.0-pro",
    "kwaivgi/kling-v3.0-std",
    "kwaivgi/kling-video-o1",
    "whisperx",
    "energy",
}


class RegistryTest(unittest.TestCase):
    reg = Registry.load()

    def test_model_ids_are_verified_and_sora_is_absent(self):
        models = {c["model"] for cands in self.reg.roles.values() for c in cands}
        self.assertLessEqual(models, VERIFIED)
        self.assertFalse(any("sora" in m for m in models))
        self.assertTrue(self.reg.blocked("openai/sora-2-pro"))

    def test_defaults(self):
        want = {
            ("tts", "final"): "google/gemini-3.8-flash-tts",
            ("align", "final"): "openai/whisper-1",
            ("music", "final"): "google/lyria-3-pro-preview",
            ("music", "draft"): "google/lyria-3-clip-preview",
            ("image", "final"): "google/gemini-3-pro-image-preview",
            ("image", "draft"): "google/gemini-3.1-flash-image",
            ("critic", "final"): "google/gemini-3.8-flash",
            ("critic", "signoff"): "google/gemini-3.1-pro-preview",
        }
        for (role, tier), model in want.items():
            chain, _ = self.reg.chain(role, tier, today="2026-09-25")
            self.assertEqual(chain[0]["model"], model, (role, tier))
            self.assertTrue(chain[0]["default"], (role, tier))
        tts = [c["model"] for c in self.reg.chain("tts", today="2026-09-25")[0]]
        self.assertEqual(tts[:2], ["google/gemini-3.8-flash-tts", "google/gemini-3.1-flash-tts-preview"])
        align = [c["model"] for c in self.reg.chain("align", today="2026-09-25")[0]]
        self.assertEqual(align, ["openai/whisper-1", "openai/whisper-large-v3", "whisperx", "energy"])
        final = self.reg.chain("image", "final", today="2026-09-25")[0][0]
        self.assertEqual(final["params"]["image_size"], "4K")

    def test_video_is_opt_in_only(self):
        for c in self.reg.candidates("video"):
            self.assertTrue(c["opt_in"] and not c["default"] and c.get("implemented") is False, c["id"])
        self.assertEqual(self.reg.chain("video", today="2026-09-25")[0], [])

    def test_license_retire_and_override_filters(self):
        chain, skipped = self.reg.chain("image", "draft", commercial_safe=True, today="2026-09-25")
        self.assertNotIn("black-forest-labs/flux.2-klein-4b", [c["model"] for c in chain])
        with self.assertRaises(UsageError):
            self.reg.chain("image", "draft", commercial_safe=True, override="black-forest-labs/flux.2-klein-4b")
        chain, _ = self.reg.chain(
            "image", "draft", commercial_safe=False, override="black-forest-labs/flux.2-klein-4b", today="2026-09-25"
        )
        self.assertEqual(chain[0]["model"], "black-forest-labs/flux.2-klein-4b")
        chain, _ = self.reg.chain("image", "draft", override="google/gemini-2.5-flash-image", today="2026-09-25")
        self.assertEqual(chain[0]["model"], "google/gemini-2.5-flash-image")  # opt-in by name, before it retires
        with self.assertRaises(UsageError):
            self.reg.chain("image", "draft", override="google/gemini-2.5-flash-image", today="2026-10-03")
        with self.assertRaises(UsageError):
            self.reg.chain("video", override="openai/sora-2-pro")
        with self.assertRaises(UsageError):
            self.reg.chain("tts", override="made-up/model")
        _, skipped = self.reg.chain("align", today="2027-03-01")
        self.assertIn("openrouter:openai/whisper-1", [s["id"] for s in skipped])

    def test_terms_are_explicit(self):
        for role, cands in self.reg.roles.items():
            for c in cands:
                self.assertIn("commercial", c["terms"], c["id"])
                self.assertIn("consent_needed", c["terms"], c["id"])
                self.assertIn(c["role"], role)


class KeyTest(TempDirTest):
    def test_key_file_forms(self):
        forms = {
            f"OPENROUTER_API_KEY={FAKE_KEY}\n": FAKE_KEY,
            f'# c\nOTHER=1\nexport OPENROUTER_API_KEY="{FAKE_KEY}"\n': FAKE_KEY,
            f"{FAKE_KEY}\n": FAKE_KEY,
        }
        for text, want in forms.items():
            p = self.tmp / "k.env"
            p.write_text(text)
            self.assertEqual(read_key_file(p), want)
        p.write_text("OTHER=1\n")
        with self.assertRaises(UsageError) as cm:
            read_key_file(p)
        self.assertNotIn("OTHER", str(cm.exception))

    def test_key_file_wins_and_secret_never_prints(self):
        p = self.tmp / "k"
        p.write_text("OPENROUTER_API_KEY=sk-or-v1-FROMFILE000000000\n")
        k = load_key(str(p))
        self.assertEqual(k.reveal(), "sk-or-v1-FROMFILE000000000")
        self.assertNotIn("FROMFILE", repr(k) + str(k) + f"{k}")
        self.assertEqual(load_key(None).reveal(), FAKE_KEY)

    def test_scrub_and_classification(self):
        c = OpenRouter(Secret(FAKE_KEY))
        self.assertNotIn(FAKE_KEY, c._scrub(f"bad key {FAKE_KEY} and sk-or-v1-OTHERKEY12345678"))
        self.assertTrue(all(is_availability(s) for s in (401, 402, 403, 404, 429, 500, 503)))
        self.assertTrue(is_availability(400, "Parameter voice is not supported by this model"))
        self.assertFalse(is_availability(400, "invalid input"))

    def test_catalog_price(self):
        self.assertEqual(
            catalog_price({"pricing": {"prompt": "0.000001"}, "description": "Full songs are $0.08 per song."}),
            {"prompt": 1e-06, "completion": None, "image_output": None, "per_generation": 0.08},
        )


class WalkerTest(TempDirTest):
    def ctx(self, film_dir, **kw):
        return Context(film_dir, common.load_film(film_dir), **kw)

    def tts_job(self, film, stem="t", **kw):
        return dict(
            {"text": "Hello world", "voice": "Kore", "style": "calm", "out_dir": film / "work" / "takes", "stem": stem},
            **kw,
        )

    def test_fallback_on_402_records_cost_and_headers(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash-tts"] = [402]
            res = run_role(self.ctx(film), "tts", self.tts_job(film), stage="voice")
            self.assertEqual(res.candidate["model"], "google/gemini-3.1-flash-tts-preview")
            self.assertEqual(res.fallbacks[0][0], "openrouter:google/gemini-3.8-flash-tts")
            body = fake.calls("/audio/speech")[-1]["body"]
            self.assertEqual(body["provider"]["options"]["google-ai-studio"]["speech_metadata"]["style"], "calm")
            self.assertEqual(body["response_format"], "pcm")
            self.assertTrue(all(r["auth"] and r["title"] == "animated-short" for r in fake.calls("/audio/speech")))
        with wave.open(str(res.files[0])) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (24000, 1, 2))
        entries = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual([e["op"] for e in entries], ["anchor", "reserve", "release", "reserve", "record"])
        self.assertEqual(entries[-1]["basis"], "estimate")  # /audio/speech reports no usage.cost

    def test_usage_cost_is_recorded_when_reported(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.cost = 0.0042
            res = run_role(self.ctx(film), "critic", {"prompt": "Reply OK"}, stage="review")
        self.assertEqual((res.usd, res.basis), (0.0042, "usage.cost"))
        self.assertEqual(self.ctx(film).ledger.status()["by_basis"], {"usage.cost": 0.0042})

    def test_non_availability_error_does_not_fall_back(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash-tts"] = [400]
            with self.assertRaises(ProviderError):
                run_role(self.ctx(film), "tts", self.tts_job(film), stage="voice")
            self.assertEqual(fake.calls("/audio/speech", "google/gemini-3.1-flash-tts-preview"), [])
        self.assertEqual(self.ctx(film).ledger.status()["reserved"], 0)

    def test_429_is_retried_then_succeeds(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash"] = [429, 429, 200]
            res = run_role(self.ctx(film), "critic", {"prompt": "x"}, stage="review")
            self.assertEqual(res.candidate["model"], "google/gemini-3.8-flash")
            self.assertEqual(len(fake.calls("/chat/completions", "google/gemini-3.8-flash")), 3)

    def test_5xx_and_timeout_fall_back(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash"] = [500]
            res = run_role(self.ctx(film), "critic", {"prompt": "x"}, stage="review")
            self.assertEqual(res.candidate["model"], "google/gemini-3.1-pro-preview")
            self.assertEqual(len(fake.calls("/chat/completions", "google/gemini-3.8-flash")), 2)  # one retry
            fake.plan.clear()
            fake.delay["google/gemini-3.8-flash"] = 1.0
            os.environ["ANIMATED_SHORT_HTTP_TIMEOUT"] = "0.3"
            try:
                res = run_role(self.ctx(film), "critic", {"prompt": "y"}, stage="review")
            finally:
                del os.environ["ANIMATED_SHORT_HTTP_TIMEOUT"]
            self.assertEqual(res.candidate["model"], "google/gemini-3.1-pro-preview")
            self.assertIn("timeout", res.fallbacks[0][1])
        # the timed-out call may have been charged: its estimate is recorded, not released
        notes = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertTrue(any(e.get("note", "").startswith("outcome unknown") for e in notes if e["op"] == "record"))

    def test_all_unavailable_is_exit_4(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            for m in ("google/gemini-3.8-flash", "google/gemini-3.1-pro-preview", "google/gemini-2.5-pro"):
                fake.plan[m] = [403]
            with self.assertRaises(ProviderUnavailable) as cm:
                run_role(self.ctx(film), "critic", {"prompt": "x"}, stage="review")
        self.assertEqual(cm.exception.exit_code, 4)
        self.assertEqual(len(cm.exception.attempts), 3)

    def test_key_never_leaks_into_errors(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.echo_key = True
            for m in ("google/gemini-3.8-flash", "google/gemini-3.1-pro-preview", "google/gemini-2.5-pro"):
                fake.plan[m] = [403]
            with self.assertRaises(ProviderUnavailable) as cm:
                run_role(self.ctx(film), "critic", {"prompt": "x"}, stage="review")
        self.assertNotIn(FAKE_KEY, str(cm.exception))
        self.assertIn("***", str(cm.exception))
        self.assertNotIn(FAKE_KEY, (film / "ledger.jsonl").read_text())

    def test_cache_hit_is_free_and_makes_no_request(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            ctx = self.ctx(film)
            a = run_role(ctx, "tts", self.tts_job(film, "a", take=0), stage="voice")
            b = run_role(ctx, "tts", self.tts_job(film, "b", take=0), stage="voice")
            c = run_role(ctx, "tts", self.tts_job(film, "c", take=1), stage="voice")
            self.assertEqual(len(fake.calls("/audio/speech")), 2)
        self.assertEqual((b.basis, b.usd), ("cache", 0.0))
        self.assertEqual(a.files[0].read_bytes(), b.files[0].read_bytes())
        self.assertNotEqual(c.basis, "cache")
        s = ctx.ledger.status()
        self.assertEqual((s["cache_hits"], s["calls"]), (1, 3))

    def test_sticky_voice_pins_and_refuses_to_switch(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            ctx = self.ctx(film)
            run_role(ctx, "tts", self.tts_job(film, take=0), stage="voice", sticky=True)
            pin = ctx.get_sticky("tts/final")
            self.assertEqual((pin["model"], pin["voice"]), ("google/gemini-3.8-flash-tts", "Kore"))
            with self.assertRaises(UsageError):
                run_role(ctx, "tts", self.tts_job(film, voice="Puck", take=1), stage="voice", sticky=True)
            fake.plan["google/gemini-3.8-flash-tts"] = [402]
            with self.assertRaises(StickyFailure) as cm:
                run_role(ctx, "tts", self.tts_job(film, take=2), stage="voice", sticky=True)
            self.assertEqual(cm.exception.exit_code, 4)
            self.assertEqual(fake.calls("/audio/speech", "google/gemini-3.1-flash-tts-preview"), [])

    def test_budget_refusal_is_exit_3_and_calls_nothing(self):
        film = new_film(self.tmp, budget_usd=0)
        with FakeOpenRouter() as fake:
            with self.assertRaises(BudgetRefused) as cm:
                run_role(self.ctx(film), "image", {"prompt": "p", "out_dir": film / "work", "stem": "s"}, stage="art")
            self.assertEqual(fake.calls("/chat/completions"), [])
        self.assertEqual(cm.exception.exit_code, 3)

    def test_account_ceiling_from_env(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.usage = 7.49
            os.environ["ANIMATED_SHORT_ACCOUNT_CEILING"] = "7.5"
            try:
                with self.assertRaises(BudgetRefused):
                    run_role(self.ctx(film), "critic", {"prompt": "x"}, stage="review")
            finally:
                del os.environ["ANIMATED_SHORT_ACCOUNT_CEILING"]
            self.assertEqual(fake.calls("/chat/completions"), [])

    def test_images_and_streamed_music(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            ctx = self.ctx(film)
            res = run_role(
                ctx,
                "image",
                {"prompt": "p", "refs": [], "aspect": "1:1", "out_dir": film / "work" / "sheets", "stem": "s1"},
                stage="art",
                sticky=True,
            )
            self.assertEqual(res.files[0].suffix, ".png")
            body = fake.calls("/chat/completions")[-1]["body"]
            self.assertEqual(body["image_config"], {"aspect_ratio": "1:1", "image_size": "4K"})
            self.assertEqual(body["modalities"], ["image", "text"])
            self.assertEqual(ctx.get_sticky("image/final")["model"], "google/gemini-3-pro-image-preview")
            m = run_role(
                ctx, "music", {"prompt": "calm", "out_dir": film / "work" / "music", "stem": "c0"}, stage="music"
            )
            self.assertEqual(m.files[0].suffix, ".wav")
            self.assertEqual(m.basis, "usage.cost")
            self.assertTrue(fake.calls("/chat/completions", "google/lyria-3-pro-preview")[0]["body"]["stream"])

    def test_align_without_words_falls_back(self):
        film = new_film(self.tmp)
        wav = write_wav(film / "work" / "a.wav", bursts([(0.1, 0.4), (0.6, 0.9)], 1.0))
        with FakeOpenRouter() as fake:
            fake.words = []
            res = run_role(
                self.ctx(film), "align", {"audio": wav, "text": "hello world", "language": "en"}, stage="voice"
            )
        self.assertEqual(res.candidate["model"], "energy")
        self.assertTrue(res.data["coarse"])
        self.assertEqual([w["word"] for w in res.data["words"]], ["hello", "world"])
        self.assertTrue(all("no word timestamps" in why or "not installed" in why for _, why in res.fallbacks))


if __name__ == "__main__":
    unittest.main()
