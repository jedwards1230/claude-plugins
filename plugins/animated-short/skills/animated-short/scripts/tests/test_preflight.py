"""preflight.py and quote.py against the fake server (tier 0 free checks, tier 1 sub-cent calls)."""

import json
import os
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool, write_script

# isort: split
import preflight
import quote


class PreflightTest(TempDirTest):
    def test_tier0_chooses_defaults_and_spends_nothing(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash-tts"] = [402]  # tier 0 never calls it, so this cannot matter
            code, out, err = run_tool(preflight, ["--film", str(film), "--json"])
            paid = [c for c in fake.requests if c["method"] == "POST"]
            models_q = fake.calls("/models")[0]["query"]
        rep = json.loads(out)
        self.assertEqual(paid, [])
        self.assertEqual(models_q, {"output_modalities": ["all"]})
        self.assertEqual(rep["roles"]["tts"]["chosen"], "openrouter:google/gemini-3.8-flash-tts")
        self.assertEqual(rep["roles"]["image"]["tiers"]["draft"]["chosen"], "openrouter:google/gemini-3.1-flash-image")
        self.assertEqual(
            rep["roles"]["critic"]["tiers"]["signoff"]["chosen"], "openrouter:google/gemini-3.1-pro-preview"
        )
        self.assertEqual(rep["key"]["usage"], 3.0)
        self.assertIn("google/lyria-3-pro-preview", rep["pricing"])
        self.assertEqual(rep["pricing"]["google/lyria-3-pro-preview"]["per_generation"], 0.08)
        self.assertTrue((film / "work" / "preflight.json").exists())
        self.assertGreater(rep["quote"]["total"], 0)
        # chromium is only checked after npm install; the tools are otherwise reported
        self.assertIn("npm install", rep["tools"]["chromium"]["detail"])
        self.assertEqual(code, 1)
        self.assertIn("chromium", " ".join(rep["problems"]))

    def test_tier1_walks_fallbacks_and_records_spend(self):
        film = new_film(self.tmp)
        with FakeOpenRouter() as fake:
            fake.plan["google/gemini-3.8-flash-tts"] = [402]
            code, out, err = run_tool(preflight, ["--film", str(film), "--tier", "1", "--json"])
            speech = [c["body"]["model"] for c in fake.calls("/audio/speech")]
        rep = json.loads(out)
        self.assertEqual(speech, ["google/gemini-3.8-flash-tts", "google/gemini-3.1-flash-tts-preview"])
        t1 = rep["tier1"]
        self.assertEqual(t1["tts"]["served_by"], "openrouter:google/gemini-3.1-flash-tts-preview")
        self.assertEqual(t1["align"]["served_by"], "openrouter:openai/whisper-1")
        self.assertEqual(t1["critic"]["reply"], "OK")
        self.assertEqual(rep["roles"]["tts"]["chosen"], "openrouter:google/gemini-3.1-flash-tts-preview")
        entries = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual(sum(1 for e in entries if e["op"] == "record"), 3)
        self.assertEqual({e["stage"] for e in entries if e["op"] == "record"}, {"preflight"})

    def test_missing_key(self):
        film = new_film(self.tmp)
        key = os.environ.pop("OPENROUTER_API_KEY")
        try:
            with FakeOpenRouter():
                code, out, _ = run_tool(preflight, ["--film", str(film)])
        finally:
            os.environ["OPENROUTER_API_KEY"] = key
        self.assertEqual(code, 1)
        self.assertIn("key     missing", out)
        self.assertIn("critic: no working provider", out)
        self.assertIn("local:energy", out)  # the $0 aligner still works

    def test_tier1_needs_a_film(self):
        code, _, err = run_tool(preflight, ["--film", str(self.tmp / "nope"), "--tier", "1"])
        self.assertEqual(code, 2)
        self.assertEqual(run_tool(preflight, ["--tier", "1"])[0], 2)

    def test_before_the_film_exists_nothing_is_written(self):
        import scaffold

        empty = self.tmp / "film"
        empty.mkdir()
        with FakeOpenRouter() as fake:
            code, out, err = run_tool(preflight, ["--json"])
            rep = json.loads(out)
            self.assertIsNone(rep["film"])
            self.assertEqual(rep["roles"]["tts"]["chosen"], "openrouter:google/gemini-3.8-flash-tts")
            self.assertIn("scaffold", rep["tools"]["chromium"]["detail"])
            self.assertIn("no film yet", run_tool(preflight, [])[1])
            run_tool(preflight, ["--film", str(empty)])  # an existing directory without film.json stays empty
            self.assertEqual([p for p in fake.requests if p["method"] == "POST"], [])
        self.assertEqual(list(empty.iterdir()), [])
        fj = self.tmp / "in.json"
        fj.write_text(json.dumps({"topic": "t", "goal": "g", "message": "m"}))
        self.assertEqual(run_tool(scaffold, ["new", str(empty), "--film-json", str(fj)])[0], 0)

    def test_python_floor_is_3_10(self):
        self.assertEqual(preflight.PY_MIN, (3, 10))


class QuoteTest(TempDirTest):
    def test_quote_counts_and_budget(self):
        film = new_film(self.tmp, audience=[{"name": "a", "knows": "x"}, {"name": "b", "knows": "y"}])
        write_script(film, [{"id": f"l{i}", "text": " ".join(["word"] * 20)} for i in range(6)])
        code, out, _ = run_tool(quote, ["--film", str(film), "--json"])
        q = json.loads(out)
        self.assertEqual(code, 0)
        items = {i["item"]: i for i in q["items"]}
        self.assertEqual(items["takes (6 lines x 3)"]["units"], 18)
        self.assertEqual(items["video reviews (4 rounds x 4)"]["units"], 16)
        self.assertEqual(items["final sheets (6)"]["model"], "google/gemini-3-pro-image-preview")
        self.assertLess(q["total"], 10)
        code, out, _ = run_tool(quote, ["--film", str(film), "--stage", "assets", "--json"])
        self.assertEqual({i["stage"] for i in json.loads(out)["items"]}, {"assets"})
        f = json.loads((film / "film.json").read_text())
        f["budget_usd"] = 0.5
        (film / "film.json").write_text(json.dumps(f))
        self.assertEqual(run_tool(quote, ["--film", str(film)])[0], 3)

    def test_quote_covers_judging_calls_and_only_the_rounds_left(self):
        film = new_film(self.tmp)  # one persona, 4 review rounds, audition voice, generated music
        write_script(film, [{"id": f"l{i}", "text": " ".join(["word"] * 10)} for i in range(6)])
        code, out, _ = run_tool(quote, ["--film", str(film), "--json"])
        items = {i["item"]: i for i in json.loads(out)["items"]}
        self.assertEqual(items["audition pick (critic, 1 call)"]["stage"], "voice")
        self.assertEqual(items["take picks (critic, 4 lines per call)"]["units"], 2)  # 6 lines, 4 per call
        self.assertEqual(items["music pick (critic, 1 call)"]["stage"], "assets")
        self.assertEqual(items["video reviews (4 rounds x 3)"]["units"], 12)
        for n in (0, 1, 2):  # r0 is pre-production and does not count
            (film / "work" / "reviews" / f"r{n}").mkdir(parents=True, exist_ok=True)
        code, out, _ = run_tool(quote, ["--film", str(film), "--stage", "review", "--json"])
        q = json.loads(out)
        self.assertEqual((q["assumptions"]["review_rounds"], q["assumptions"]["review_rounds_done"]), (2, 2))
        self.assertIn("video reviews (2 rounds x 3)", [i["item"] for i in q["items"]])
        for n in (3, 4):
            (film / "work" / "reviews" / f"r{n}").mkdir()
        code, out, _ = run_tool(quote, ["--film", str(film), "--stage", "review", "--json"])
        self.assertEqual(json.loads(out)["items"], [])

    def test_zero_budget_film_quotes_nothing(self):
        # a $0 film: no voice, synthesized music, code-drawn art, Claude reviews -> no paid item
        film = new_film(self.tmp)
        f = json.loads((film / "film.json").read_text())
        f.update(budget_usd=0, voice={"mode": "none"}, music={"mode": "synth"}, art={"mode": "code"})
        (film / "film.json").write_text(json.dumps(f))
        code, out, _ = run_tool(quote, ["--film", str(film), "--json"])
        q = json.loads(out)
        self.assertEqual((code, q["items"], q["total"]), (0, [], 0))


if __name__ == "__main__":
    unittest.main()
