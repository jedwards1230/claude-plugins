"""report.py: out/report.md written from the film's records (gates, claims, ledger, export, credits, notes)."""

import json

from helpers import FIXTURES, TempDirTest, new_film, run_tool

# isort: split
import common
import report
import review
from providers.ledger import Ledger


class ReportTest(TempDirTest):
    def ship_round(self, film, label="1"):
        d = film / "work" / "reviews" / f"r{label}"
        d.mkdir(parents=True, exist_ok=True)
        for f in (FIXTURES / "round-ship").glob("*.json"):
            doc = json.loads(f.read_text())
            doc["cut"] = f"r{label}"
            (d / f.name).write_text(json.dumps(doc))
        (film / "work" / "direction" / "quiz.json").write_text((FIXTURES / "quiz.json").read_text())
        return d

    def test_report_is_assembled_from_the_records(self):
        film = new_film(
            self.tmp,
            credits=[{"role": "Voice", "name": "Google Gemini 3.8 Flash TTS"}, "Script and code: the host model"],
        )
        d = self.ship_round(film)
        (d / "accepted_claims.json").write_text(json.dumps(["A kettle boils at 100 C at sea level"]))
        (d / "gates.json").write_text(json.dumps(review.compute_gates(common.load_film(film), film, 1)))
        claims = {
            "claims": [
                {"id": "c1", "fact": "Steam carries heat away.", "sensitivity": "none"},
                {
                    "id": "c2",
                    "fact": "Old kettles can hold limescale.",
                    "sensitivity": "hard_truth",
                    "decision": "omit",
                },
                {"id": "c3", "fact": "Kettles use a lot of power.", "sensitivity": "hard_truth"},
            ]
        }
        (film / "work" / "research" / "claims.json").write_text(json.dumps(claims))
        (film / "work" / "direction" / "originality-v1.md").write_text("5\nfirst look")
        (film / "work" / "direction" / "originality-v2.md").write_text("7\nbetter")
        led = Ledger(film / "ledger.jsonl", 10)
        led.append({"op": "anchor", "account_usage": 3.0})
        led.reserve("tts", "voice", 0.01, "openrouter", "google/gemini-3.8-flash-tts").record(None)
        led.reserve("critic", "review", 0.02, "openrouter", "google/gemini-3.8-flash").record(0.015)
        led.reserve("music", "assets", 0.08, "openrouter", "google/lyria-3-pro-preview").record(0.08)
        led.append({"op": "reconcile", "account_usage": 3.04, "delta": 0.04, "drift": 0.015, "ledger_spent": 0.025})
        (film / "out" / "export.json").write_text(
            json.dumps(
                {
                    "mode": "ffmpeg",
                    "reason": "ffmpeg found",
                    "page": "out/page",
                    "files": [
                        {
                            "path": "out/kettle.mp4",
                            "width": 1920,
                            "height": 1080,
                            "duration": 90,
                            "bytes": 2097152,
                            "lufs": -14.5,
                            "true_peak": -1.6,
                        }
                    ],
                    "captions": {"srt": "out/kettle.srt", "vtt": "out/kettle.vtt", "cues": 12},
                    "transcript": "out/transcript.md",
                    "loudness": {"mix": "work/mix_norm.wav", "mix_sha256": "ab" * 32},
                }
            )
        )
        (film / "work" / "takes" / "check.json").write_text(json.dumps({"unverified": ["l3"], "lines": {}}))
        (film / "work" / "report-notes.json").write_text(
            json.dumps({"open_decisions": ["Publish the page or keep it private"], "not_verified": ["The tide times"]})
        )
        code, out, err = run_tool(report, ["--film", str(film)])
        self.assertEqual(code, 0, err)
        self.assertIn("report: ", out)
        text = (film / "out" / "report.md").read_text()
        for want in (
            "# How a kettle boils: report",
            "- Message: Heat makes bubbles, and bubbles make the whistle.",
            '- curious non-expert: "',
            "(matches the message: True; quiz 4/5",
            "Verdict: **ship**",
            "- pass director",
            "- unconfirmed (director): blocking SYNC-3",  # still to confirm with a still
            "`out/kettle.mp4`: 1920x1080, 90 s, 2.0 MiB, -14.5 LUFS",
            "SHA-256 " + "ab" * 32,
            "- Accepted by the user as it is: A kettle boils at 100 C at sea level",
            "- Hard truth (omit; policy ask): Old kettles can hold limescale.",
            "- Hard truth (decision not recorded; policy ask): Kettles use a lot of power.",
            "score 7 (`work/direction/originality-v2.md`, check 2)",
            "ledger spent $0.1050 in 3 calls",
            "Account usage since the film's first paid call: $0.0400",
            "- tts: google/gemini-3.8-flash-tts",
            "- CHECK: the credits do not seem to name google/lyria-3-pro-preview",
            "Pronunciation of line l3: only the coarse aligner heard it",
            "- The tide times",
            "- Publish the page or keep it private",
        ):
            self.assertIn(want, text)
        self.assertNotIn("CHECK: the credits do not seem to name google/gemini", text)  # named in the voice credit
        self.assertTrue(text.isascii())

    def test_the_fix_pass_is_the_latest_round_and_a_film_without_rounds_still_gets_a_report(self):
        film = new_film(self.tmp, budget_usd=0)
        code, _, err = run_tool(report, ["--film", str(film)])
        self.assertEqual(code, 0, err)
        text = (film / "out" / "report.md").read_text()
        self.assertIn("has not been through a review round", text)
        self.assertIn("No model watched the video", text)
        for label in ("1", "2", "2-fix"):
            d = film / "work" / "reviews" / f"r{label}"
            d.mkdir(parents=True)
            (d / "gates.json").write_text(json.dumps({"verdict": "ship", "gates": []}))
        (film / "work" / "reviews" / "r0").mkdir()
        self.assertEqual(report.latest_round(film), "2-fix")
        self.assertEqual(run_tool(report, ["--film", str(film), "--round", "7"])[0], 2)
        code, out, _ = run_tool(report, ["--film", str(film), "--round", "1", "--out", str(self.tmp / "r.md")])
        self.assertEqual(code, 0)
        self.assertIn("round 1", out)
        self.assertTrue((self.tmp / "r.md").exists())
