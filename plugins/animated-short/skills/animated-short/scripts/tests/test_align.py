"""The $0 energy aligner and the display-word mapping used by voice.py words."""

import unittest

from helpers import TempDirTest, bursts, write_wav

import voice
from providers.local import energy_align, syllables, voiced_regions


class EnergyAlignerTest(TempDirTest):
    def test_tone_bursts_map_to_words(self):
        spans = [(0.20, 0.50), (0.80, 1.40), (1.70, 2.00)]
        wav = write_wav(self.tmp / "b.wav", bursts(spans, 2.4))
        words = energy_align(wav, "one amazing kite")
        self.assertEqual([w["word"] for w in words], ["one", "amazing", "kite"])
        for w, (a, b) in zip(words, spans):
            self.assertAlmostEqual(w["start"], a, delta=0.03)
            self.assertAlmostEqual(w["end"], b, delta=0.03)

    def test_more_words_than_regions_spread_by_syllables(self):
        wav = write_wav(self.tmp / "b.wav", bursts([(0.1, 1.1)], 1.3))
        words = energy_align(wav, "a wonderful day")
        durs = [w["end"] - w["start"] for w in words]
        self.assertEqual(len(words), 3)
        self.assertGreater(durs[1], durs[0] * 2)  # "wonderful" (3 syllables) outlasts "a"
        self.assertTrue(all(words[i]["end"] <= words[i + 1]["start"] + 1e-6 for i in range(2)))
        self.assertAlmostEqual(words[0]["start"], 0.1, delta=0.03)
        self.assertAlmostEqual(words[-1]["end"], 1.1, delta=0.03)

    def test_helpers(self):
        self.assertEqual([syllables(w) for w in ("kite", "table", "wonderful", "eye", "2026")], [1, 2, 3, 1, 5])
        self.assertEqual(
            voiced_regions([-120] * 5 + [-10] * 20 + [-120] * 3 + [-10] * 10 + [-120] * 5), [(0.05, 0.38)]
        )  # the 30 ms gap is merged


class DisplayMappingTest(unittest.TestCase):
    def test_respelled_word_maps_back_to_one_display_word(self):
        line = {"id": "l1", "text": "Meet Zyxo, our robot."}
        heard = [
            {"word": "Meet", "start": 0.0, "end": 0.3},
            {"word": "Zik", "start": 0.35, "end": 0.6},
            {"word": "so", "start": 0.6, "end": 0.8},
            {"word": "our", "start": 0.9, "end": 1.0},
            {"word": "robot.", "start": 1.05, "end": 1.5},
        ]
        out = voice.map_to_display(line, {"Zyxo": "Zik so"}, heard)
        self.assertEqual([w["w"] for w in out], ["Meet", "Zyxo,", "our", "robot."])
        self.assertEqual((out[1]["s"], out[1]["e"]), (0.35, 0.8))
        self.assertFalse(any(w.get("est") for w in out))

    def test_missing_word_is_interpolated(self):
        line = {"id": "l1", "text": "one two three four"}
        heard = [{"word": "one", "start": 0.0, "end": 0.2}, {"word": "four", "start": 0.9, "end": 1.1}]
        out = voice.map_to_display(line, {}, heard)
        self.assertEqual([w.get("est", False) for w in out], [False, True, True, False])
        self.assertTrue(0.2 <= out[1]["s"] < out[2]["s"] < 0.9)


if __name__ == "__main__":
    unittest.main()
