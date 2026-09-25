"""voice.py end to end against the fake server: takes, check, pick, process, tighten, words, export."""

import json
import unittest

from helpers import FakeOpenRouter, TempDirTest, bursts, new_film, run_tool, write_script, write_wav

# isort: split
import audiolib
import voice

LINES = [
    {"id": "l1", "text": "Meet Zyxo the kettle."},
    {"id": "l2", "text": "It sings when it boils.", "tts": "It sings when it boils!"},
]


class VoiceTest(TempDirTest):
    def setUp(self):
        super().setUp()
        self.film = new_film(
            self.tmp, pronunciations={"Zyxo": "Zik so"}, duration=15, voice={"mode": "named", "name": "Kore"}
        )
        write_script(self.film, LINES)

    def test_takes_apply_pronunciations_and_pin_the_voice(self):
        with FakeOpenRouter() as fake:
            code, out, err = run_tool(voice, ["takes", "--film", str(self.film), "--n", "2"])
            self.assertEqual(code, 0, err)
            inputs = [c["body"]["input"] for c in fake.calls("/audio/speech")]
            self.assertEqual(inputs, ["Meet Zik so the kettle."] * 2 + ["It sings when it boils!"] * 2)
            self.assertTrue(all(c["body"]["voice"] == "Kore" for c in fake.calls("/audio/speech")))
            code, _, err = run_tool(voice, ["takes", "--film", str(self.film), "--voice", "Puck", "l1"])
            self.assertEqual(code, 2)
            self.assertIn("pinned", err)
        self.assertEqual(
            sorted(p.name for p in (self.film / "work" / "takes").glob("*.wav")),
            ["l1_0.wav", "l1_1.wav", "l2_0.wav", "l2_1.wav"],
        )
        state = json.loads((self.film / "work" / "state.json").read_text())
        self.assertEqual(state["sticky"]["tts/final"]["voice"], "Kore")

    def test_check_flags_misheard_words_then_pick(self):
        with FakeOpenRouter() as fake:
            run_tool(voice, ["takes", "--film", str(self.film), "--n", "1", "l1"])
            fake.words = [
                ("Meet", 0.0, 0.2),
                ("little", 0.25, 0.4),
                ("so", 0.4, 0.5),
                ("the", 0.5, 0.6),
                ("kettle.", 0.6, 0.9),
            ]
            code, out, _ = run_tool(voice, ["check", "--film", str(self.film), "l1"])
            self.assertEqual(code, 1)
            self.assertIn("heard 'little' for 'zik'", out)
            fake.words = [
                ("Meet", 0.0, 0.2),
                ("Zik", 0.25, 0.4),
                ("so", 0.4, 0.5),
                ("the", 0.5, 0.6),
                ("kettle", 0.6, 0.9),
            ]
            code, out, _ = run_tool(voice, ["check", "--film", str(self.film), "l1", "--no-cache"])
            self.assertEqual(code, 0, out)
        report = json.loads((self.film / "work" / "takes" / "check.json").read_text())
        self.assertEqual(report["lines"]["l1"]["best"], "l1_0")
        code, out, _ = run_tool(voice, ["pick", "--film", str(self.film), "l1=0"])
        self.assertEqual(code, 0)
        self.assertTrue((self.film / "work" / "vo" / "l1.wav").exists())
        self.assertEqual(run_tool(voice, ["pick", "--film", str(self.film), "l9=0"])[0], 2)

    def test_partial_check_updates_only_those_lines(self):
        right = [("Meet", 0.0, 0.2), ("Zik", 0.25, 0.4), ("so", 0.4, 0.5), ("the", 0.5, 0.6), ("kettle", 0.6, 0.9)]
        with FakeOpenRouter() as fake:
            run_tool(voice, ["takes", "--film", str(self.film), "--n", "1"])
            fake.words = [("Meet", 0.0, 0.2), ("little", 0.25, 0.4), ("so", 0.4, 0.5), ("kettle", 0.6, 0.9)]
            code, out, _ = run_tool(voice, ["check", "--film", str(self.film)])
            self.assertEqual(code, 1)
            first = json.loads((self.film / "work" / "takes" / "check.json").read_text())
            self.assertEqual(first["needs_work"], ["l1", "l2"])
            fake.words = right
            code, out, _ = run_tool(voice, ["check", "--film", str(self.film), "l1", "--no-cache"])
            self.assertEqual(code, 0, out)  # l1 is clean now; l2 was not re-checked
            self.assertIn("still open in check.json: l2", out)
        report = json.loads((self.film / "work" / "takes" / "check.json").read_text())
        self.assertEqual(sorted(report["lines"]), ["l1", "l2"])  # l2 kept from the first run
        self.assertTrue(report["lines"]["l1"]["clean"])
        self.assertEqual(report["lines"]["l2"], first["lines"]["l2"])
        self.assertEqual(report["needs_work"], ["l2"])

    def test_coarse_only_takes_are_unverified(self):
        write_wav(self.film / "work" / "takes" / "l1_0.wav", bursts([(0.2, 0.7), (0.9, 1.6)], 2.0))
        with FakeOpenRouter() as fake:
            fake.plan["openai/whisper-1"] = [404]
            fake.plan["openai/whisper-large-v3"] = [404]
            code, out, _ = run_tool(voice, ["check", "--film", str(self.film), "l1"])
        self.assertEqual(code, 1)
        self.assertIn("UNVERIFIED", out)
        self.assertIn("check-override.md", out)
        report = json.loads((self.film / "work" / "takes" / "check.json").read_text())
        self.assertEqual(report["unverified"], ["l1"])
        self.assertTrue(report["lines"]["l1"]["takes"]["l1_0"]["coarse"])

    def test_words_tail_defaults_to_the_end_card(self):
        self.assertEqual(voice.ending_seconds({"disclosure": {"end_card": True, "seconds": 2.5}}), 3.0)
        self.assertEqual(voice.ending_seconds({"disclosure": {"end_card": False, "seconds": 2.5}}), 1.5)
        # 0.6 s lead-in + 6 s + 0.57 s gap + 6 s ends at 13.17 s of 15: 1.83 s left
        self._vo("l1", [(0.1, 5.9)], 6.0)
        self._vo("l2", [(0.1, 5.9)], 6.0)
        with FakeOpenRouter():
            code, out, _ = run_tool(voice, ["words", "--film", str(self.film)])
            self.assertEqual(code, 1, out)  # the end card is on by default: the ending needs 3.0 s
            self.assertIn("need 3.0", out)
            code, out, _ = run_tool(voice, ["words", "--film", str(self.film), "--tail", "1.5"])
            self.assertEqual(code, 0, out)
            f = json.loads((self.film / "film.json").read_text())
            f["disclosure"] = {"end_card": False}
            (self.film / "film.json").write_text(json.dumps(f))
            code, out, _ = run_tool(voice, ["words", "--film", str(self.film)])
            self.assertEqual(code, 0, out)
            self.assertIn("need 1.5", out)

    def _vo(self, lid, spans, total):
        write_wav(self.film / "work" / "vo" / f"{lid}.wav", bursts(spans, total, rate=24000))

    @unittest.skipUnless(audiolib.has("numpy"), "needs numpy")
    def test_process_numpy_tighten_words_export(self):
        self._vo("l1", [(0.3, 0.8), (0.9, 1.4), (2.6, 3.0)], 3.5)  # a 1.2 s internal pause
        self._vo("l2", [(0.2, 1.0)], 1.4)
        code, out, err = run_tool(voice, ["process", "--film", str(self.film), "--no-ffmpeg"])
        self.assertEqual(code, 0, err)
        final = self.film / "work" / "vo" / "l1_final.wav"
        x, sr = audiolib.read_audio(final)
        self.assertAlmostEqual(audiolib.integrated_lufs(x, sr), -16.0, delta=0.6)
        self.assertLess(audiolib.wav_duration(final), 3.5)  # leading and trailing silence trimmed
        before = audiolib.wav_duration(final)
        code, out, err = run_tool(voice, ["tighten", "--film", str(self.film), "--max-pause", "0.24"])
        self.assertEqual(code, 0, err)
        self.assertLess(audiolib.wav_duration(final), before - 0.8)
        self.assertTrue((self.film / "work" / "vo" / "l1_loose.wav").exists())
        with FakeOpenRouter() as fake:
            fake.words = [
                ("Meet", 0.05, 0.3),
                ("Zik", 0.35, 0.5),
                ("so", 0.5, 0.6),
                ("the", 0.6, 0.7),
                ("kettle.", 0.7, 1.0),
            ]
            code, out, err = run_tool(voice, ["words", "--film", str(self.film), "--lead-in", "0.5", "--gap", "0.4"])
            self.assertEqual(code, 0, out + err)
        words = json.loads((self.film / "src" / "words.json").read_text())
        self.assertEqual(words["l1"]["t"], 0.5)
        self.assertAlmostEqual(words["l2"]["t"], 0.5 + words["l1"]["d"] + 0.4, places=3)
        self.assertEqual([w["w"] for w in words["l1"]["words"]], ["Meet", "Zyxo", "the", "kettle."])
        self.assertEqual(len(words["l2"]["words"]), 5)
        code, out, _ = run_tool(voice, ["export", "--film", str(self.film), "--format", "wav"])
        self.assertEqual(code, 0)
        self.assertTrue((self.film / "web" / "audio" / "vo_l1.wav").exists())
        self.assertIn("2 lines", out)

    def test_words_fail_when_narration_overruns(self):
        self._vo("l1", [(0.1, 9.0)], 9.2)
        self._vo("l2", [(0.1, 6.0)], 6.2)
        with FakeOpenRouter():
            code, out, _ = run_tool(voice, ["words", "--film", str(self.film)])
        self.assertEqual(code, 1)
        self.assertIn("too long", out)

    @unittest.skipUnless(audiolib.has_ffmpeg() and audiolib.has("numpy"), "needs ffmpeg and numpy")
    def test_process_with_ffmpeg(self):
        self._vo("l1", [(0.3, 1.5)], 2.0)
        code, out, err = run_tool(voice, ["process", "--film", str(self.film), "l1"])
        self.assertEqual(code, 0, err)
        x, sr = audiolib.read_audio(self.film / "work" / "vo" / "l1_final.wav")
        self.assertEqual(sr, 48000)
        self.assertIn("ffmpeg", out)


if __name__ == "__main__":
    unittest.main()
