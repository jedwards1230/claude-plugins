"""review.py: JSON extraction, run with a retry, ingest, technical via qa.mjs, and the ship gates."""

import json
import unittest

from helpers import FIXTURES, FakeOpenRouter, TempDirTest, new_film, quiet, run_tool

# isort: split
import audiolib
import common
import review


def load(name):
    return json.loads((FIXTURES / "round-ship" / name).read_text())


class ExtractTest(unittest.TestCase):
    def test_extract_json(self):
        self.assertEqual(review.extract_json('Sure!\n```json\n{"a": 1}\n```\nbye'), {"a": 1})
        self.assertEqual(
            review.extract_json('x {"a": "}{", "b": {"c": [1, 2]}} y {"z": 0}'), {"a": "}{", "b": {"c": [1, 2]}}
        )
        self.assertIsNone(review.extract_json("no json here {oops"))


class RoundTest(TempDirTest):
    def film(self, **kw):
        return new_film(self.tmp, **kw)

    def ship_round(self, film, n=1):
        d = film / "work" / "reviews" / f"r{n}"
        d.mkdir(parents=True, exist_ok=True)
        for f in (FIXTURES / "round-ship").glob("*.json"):
            doc = json.loads(f.read_text())
            doc["cut"] = f"r{n}"
            (d / f.name).write_text(json.dumps(doc))
        (film / "work" / "direction" / "quiz.json").write_text((FIXTURES / "quiz.json").read_text())
        return d

    def gate(self, g, gid):
        return next(x for x in g["gates"] if x["id"] == gid)

    def test_only_review_names_are_read(self):
        film = self.film()
        d = self.ship_round(film)
        stray = load("director.json")
        stray["scores"]["overall"]["value"] = 2  # would fail the director gate if it were read
        (d / "director-draft.json").write_text(json.dumps(stray))
        (d / "notes.json").write_text("{}")
        code, out, err = run_tool(review, ["gates", "--film", str(film), "--round", "1"])
        self.assertEqual(code, 0, out)
        self.assertIn("ignoring director-draft.json", err)
        g = json.loads((d / "gates.json").read_text())
        self.assertEqual(g["ignored"], ["director-draft.json", "notes.json"])
        self.assertNotIn("director-draft", g["reviews"])
        wrong = load("director.json")
        wrong["cut"] = "r1"
        (d / "originality.json").write_text(json.dumps(wrong))  # a director review stored under another name
        with quiet():
            g = review.compute_gates(common.load_film(film), film, 1)
        self.assertEqual([i["file"] for i in g["invalid"]], ["originality.json"])
        self.assertEqual(g["verdict"], "iterate")

    def test_quiz_is_scored_out_of_the_answer_key(self):
        film = self.film()
        self.ship_round(film)
        key = json.loads((FIXTURES / "quiz.json").read_text())
        key["questions"].append({"q": "What stops the whistle?", "a": "Lifting the kettle off", "accept": []})
        (film / "work" / "direction" / "quiz.json").write_text(json.dumps(key))
        g = review.compute_gates(common.load_film(film), film, 1)
        quiz = self.gate(g, "quiz")
        self.assertFalse(quiz["pass"])  # 4 right of 6 questions, although 4 of the 5 answers were right
        self.assertIn("4/6", quiz["evidence"])
        (film / "work" / "direction" / "quiz.json").unlink()
        code, _, err = run_tool(review, ["gates", "--film", str(film), "--round", "1"])
        self.assertEqual(code, 2)
        self.assertIn("quiz.json not found", err)
        (self.tmp / "story").mkdir()
        story = new_film(self.tmp / "story", form="story", sources=[{"kind": "none"}])
        self.ship_round(story)
        (story / "work" / "direction" / "quiz.json").unlink()
        g = review.compute_gates(common.load_film(story), story, 1)
        self.assertNotIn("quiz", {x["id"] for x in g["gates"]})
        self.assertEqual(g["verdict"], "ship")

    def test_technical_gate_needs_a_shipping_technical_review(self):
        film = self.film()
        d = self.ship_round(film)
        tech = load("technical.json")
        tech["defects"] = [
            {"at": "0:04", "severity": "major", "check": "TECH-12", "issue": "write-on runs late", "fix": "earlier"}
        ]
        tech["verdict"] = "iterate"
        (d / "technical.json").write_text(json.dumps(tech))
        g = review.compute_gates(common.load_film(film), film, 1)
        t = self.gate(g, "technical")
        self.assertFalse(t["pass"])
        self.assertIn("TECH-12", t["evidence"])
        self.assertTrue(self.gate(g, "tech-1")["pass"])  # the listed TECH gates alone would have passed
        self.assertEqual(g["verdict"], "iterate")
        (d / "technical.json").unlink()
        g = review.compute_gates(common.load_film(film), film, 1)
        self.assertIn("no technical review", self.gate(g, "technical")["evidence"])

    def test_persona_names_resolve_exactly_then_uniquely(self):
        film = common.load_film(
            self.film(
                audience=[
                    {"name": "a baker", "knows": "recipes"},
                    {"name": "a baker's apprentice", "knows": "little"},
                    {"name": "a chemist", "knows": "reactions"},
                ]
            )
        )
        self.assertEqual(review.persona_slug(film, "A Baker"), "a-baker")  # exact beats substring
        self.assertEqual(review.persona_slug(film, "apprentice"), "a-baker-s-apprentice")
        self.assertEqual(review.persona_slug(film, "chemist"), "a-chemist")
        with self.assertRaises(common.UsageError):
            review.persona_slug(film, "baker")  # a substring of two names, exact for neither
        with self.assertRaises(common.UsageError):
            review.persona_slug(film, "a physicist")

    def test_empty_sources_follow_the_form(self):
        for form, fiction in (("story", True), ("music_video", True), ("explainer", False), ("promo", False)):
            with self.subTest(form):
                self.assertEqual(common.is_fiction({"form": form, "sources": []}), fiction)
        self.assertFalse(common.is_fiction({"form": "story", "sources": [{"kind": "docs", "ref": "a book"}]}))
        self.assertTrue(common.is_fiction({"form": "explainer", "sources": [{"kind": "none"}]}))
        film = self.film(form="story")  # sources default to []
        d = self.ship_round(film)
        (d / "fact_checker.json").unlink()
        g = review.compute_gates(common.load_film(film), film, 1)
        self.assertTrue(self.gate(g, "claims")["pass"])
        (self.tmp / "promo").mkdir()
        promo = new_film(self.tmp / "promo", form="promo")
        d = self.ship_round(promo)
        (d / "fact_checker.json").unlink()
        g = review.compute_gates(common.load_film(promo), promo, 1)
        self.assertEqual(self.gate(g, "claims")["evidence"], "no fact_checker review")

    def test_ship_round_passes_every_gate(self):
        film = self.film()
        self.ship_round(film)
        code, out, _ = run_tool(review, ["gates", "--film", str(film), "--round", "1"])
        self.assertEqual(code, 0, out)
        g = json.loads((film / "work" / "reviews" / "r1" / "gates.json").read_text())
        self.assertEqual(g["verdict"], "ship")
        why = {d["check"]: d["why"] for d in g["discounted_defects"]}
        self.assertEqual(why["TEXT-1"], "maybe intentional")
        self.assertIn("unconfirmed", why["SYNC-3"])  # a single reviewer, no still: does not block
        ids = {x["id"] for x in g["gates"]}
        self.assertTrue(
            {"director", "blocking", "message", "quiz", "learned", "originality", "claims", "technical", "tech-2"}
            <= ids
        )

    def test_defect_counts_when_confirmed_by_still_or_second_reviewer(self):
        film = self.film()
        d = self.ship_round(film)
        (d / "confirmed.json").write_text(
            json.dumps([{"check": "SYNC-3", "at": "0:10", "still": "work/qa/stills/t009.50.jpg"}])
        )
        code, out, _ = run_tool(review, ["gates", "--film", str(film), "--round", "1"])
        self.assertEqual(code, 1)
        self.assertIn("SYNC-3", out)
        (d / "confirmed.json").unlink()
        persona = load("persona-curious-non-expert.json")
        persona["defects"] = [
            {"at": "0:10.5", "severity": "blocking", "check": "SYNC-3", "issue": "late", "fix": "earlier"}
        ]
        (d / "persona-curious-non-expert.json").write_text(json.dumps(persona))
        g = review.compute_gates(common.load_film(film), film, 1)
        self.assertEqual(g["verdict"], "iterate")
        self.assertEqual(
            {c["review"] for c in g["counted_defects"] if c["check"] == "SYNC-3"},
            {"director", "persona-curious-non-expert"},
        )

    def test_failing_gates(self):
        film = self.film(review={"rounds": 2})
        d = self.ship_round(film, 2)
        comp = load("comparer-curious-non-expert.json")
        comp["matches_message"] = False
        comp["cut"] = "r2"
        (d / "comparer-curious-non-expert.json").write_text(json.dumps(comp))
        fc = load("fact_checker.json")
        fc["cut"] = "r2"
        fc["claims"].append({"text": "Kettles use 3 kW", "where": "l3", "status": "unsourced"})
        (d / "fact_checker.json").write_text(json.dumps(fc))
        tech = json.loads((FIXTURES / "qa-check-iterate.json").read_text())
        tech["cut"] = "r2"
        (d / "technical.json").write_text(json.dumps(tech))
        g = review.compute_gates(common.load_film(film), film, 2)
        failed = {x["id"] for x in g["gates"] if not x["pass"]}
        self.assertTrue({"message", "claims", "blocking", "tech-1", "tech-2"} <= failed, failed)
        self.assertEqual(g["verdict"], "stop")
        self.assertTrue(g["max_rounds_reached"])
        (d / "accepted_claims.json").write_text(json.dumps(["Kettles use 3 kW"]))
        g = review.compute_gates(common.load_film(film), film, 2)
        self.assertNotIn("claims", {x["id"] for x in g["gates"] if not x["pass"]})

    def test_ingest(self):
        film = self.film()
        good = self.tmp / "fc.json"
        doc = load("fact_checker.json")
        good.write_text(json.dumps(doc))
        code, out, _ = run_tool(review, ["ingest", "--film", str(film), "--round", "1", "--file", str(good)])
        self.assertEqual(code, 0, out)
        self.assertTrue((film / "work" / "reviews" / "r1" / "fact_checker.json").exists())
        self.assertEqual(run_tool(review, ["ingest", "--film", str(film), "--round", "1", "--file", str(good)])[0], 2)
        doc["claims"][0]["status"] = "probably"
        good.write_text(json.dumps(doc))
        code, _, err = run_tool(review, ["ingest", "--film", str(film), "--round", "1", "--file", str(good), "--force"])
        self.assertEqual(code, 1)
        self.assertIn("status", err)
        sp = load("persona-curious-non-expert.json")
        sp.update(reviewer="script_persona")
        sp.pop("persona")
        good.write_text(json.dumps(sp))
        self.assertEqual(run_tool(review, ["ingest", "--film", str(film), "--round", "1", "--file", str(good)])[0], 2)
        code, _, _ = run_tool(
            review,
            ["ingest", "--film", str(film), "--round", "1", "--file", str(good), "--persona", "curious non-expert"],
        )
        self.assertEqual(code, 0)
        self.assertTrue((film / "work" / "reviews" / "r1" / "script_persona-curious-non-expert.json").exists())

    def test_run_retries_once_with_the_validation_errors(self):
        film = self.film()
        prompt = self.tmp / "director.md"
        prompt.write_text("You are the director. Watch the cut.")
        (film / "work" / "direction" / "intent-notes.md").write_text("Handwriting writes on letter by letter.")
        good = load("director.json")
        with FakeOpenRouter() as fake:
            fake.replies = [
                'Here you go: {"reviewer": "director", "cut": "r1"}',
                "```json\n" + json.dumps(good) + "\n```",
            ]
            code, out, err = run_tool(
                review,
                ["run", "--film", str(film), "--round", "1", "--reviewer", "director", "--prompt-file", str(prompt)],
            )
            self.assertEqual(code, 0, err)
            first, second = [c["body"]["messages"][0]["content"][0]["text"] for c in fake.calls("/chat/completions")]
        self.assertIn("Handwriting writes on letter by letter.", first)
        self.assertIn('"reviewer": "director" and "cut": "r1"', first)
        self.assertIn("Heat makes bubbles", first)  # the film's message
        self.assertIn("missing required property 'scores'", second)
        saved = json.loads((film / "work" / "reviews" / "r1" / "director.json").read_text())
        self.assertEqual(saved["scores"]["overall"]["value"], 8.8)
        self.assertIn("director: ship", out)

    def test_run_gives_up_after_one_retry(self):
        film = self.film()
        prompt = self.tmp / "p.md"
        prompt.write_text("Judge.")
        with FakeOpenRouter() as fake:
            fake.replies = ["no json", "still none"]
            code, _, err = run_tool(
                review,
                ["run", "--film", str(film), "--round", "1", "--reviewer", "audio", "--prompt-file", str(prompt)],
            )
        self.assertEqual(code, 1)
        self.assertTrue((film / "work" / "reviews" / "r1" / "raw" / "audio-2.txt").exists())

    def test_comparer_needs_the_persona_takeaway(self):
        film = self.film()
        prompt = self.tmp / "p.md"
        prompt.write_text("Compare.")
        code, _, err = run_tool(
            review,
            [
                "run",
                "--film",
                str(film),
                "--round",
                "1",
                "--reviewer",
                "comparer",
                "--persona",
                "curious non-expert",
                "--prompt-file",
                str(prompt),
            ],
        )
        self.assertEqual(code, 2)
        self.ship_round(film)
        comp = load("comparer-curious-non-expert.json")
        with FakeOpenRouter() as fake:
            fake.replies = [json.dumps(comp)]
            code, _, err = run_tool(
                review,
                [
                    "run",
                    "--film",
                    str(film),
                    "--round",
                    "1",
                    "--reviewer",
                    "comparer",
                    "--persona",
                    "curious non-expert",
                    "--prompt-file",
                    str(prompt),
                    "--no-cache",
                ],
            )
            self.assertEqual(code, 0, err)
            text = fake.calls("/chat/completions")[0]["body"]["messages"][0]["content"][0]["text"]
        self.assertIn("Heat makes bubbles and the bubbles make the whistle.", text)

    @unittest.skipUnless(audiolib.which("node"), "needs node")
    def test_technical_runs_qa_mjs(self):
        film = self.film()
        stub = film / "tools" / "qa.mjs"
        fixture = load("technical.json")
        stub.write_text(
            "const i = process.argv.indexOf('--cut'); const r = "
            + json.dumps(fixture)
            + "; r.cut = process.argv[i + 1]; console.log(JSON.stringify(r)); process.exit(0);\n"
        )
        code, out, err = run_tool(review, ["technical", "--film", str(film), "--round", "3"])
        self.assertEqual(code, 0, err)
        saved = json.loads((film / "work" / "reviews" / "r3" / "technical.json").read_text())
        self.assertEqual(saved["cut"], "r3")
        self.assertEqual(len(saved["checks"]), 15)

    @unittest.skipUnless(audiolib.has_ffmpeg(), "needs ffmpeg")
    def test_technical_fallback_without_qa(self):
        film = self.film(duration=5)
        (film / "tools" / "qa.mjs").unlink()
        out_dir = film / "out"
        audiolib.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=30:duration=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-shortest",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                str(out_dir / "f.mp4"),
            ]
        )
        code, out, err = run_tool(review, ["technical", "--film", str(film), "--round", "1"])
        self.assertEqual(code, 1)  # no captions, no transcript, loudness not normalized
        saved = json.loads((film / "work" / "reviews" / "r1" / "technical.json").read_text())
        ok = {c["id"]: c["ok"] for c in saved["checks"]}
        self.assertTrue(ok["TECH-1"])
        self.assertFalse(ok["TECH-5"])


if __name__ == "__main__":
    unittest.main()
