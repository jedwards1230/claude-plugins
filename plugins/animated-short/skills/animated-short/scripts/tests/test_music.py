"""music.py: beat grid of a synthetic click track, whole-bar cuts, and generation via the fake server."""

import json
import math
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool

# isort: split
import audiolib
import music

HAVE_NUMPY = audiolib.has("numpy")
SR = 22050


def click_track(path, bpm=120.0, bars=12, final_bar=10, tail=3.0):
    """4/4 clicks: accented low downbeats, a sustained final chord on bar `final_bar`, then silence."""
    import numpy as np

    beat = 60.0 / bpm
    total = final_bar * 4 * beat + tail
    t = np.arange(int(total * SR)) / SR
    y = np.zeros_like(t)
    for k in range(final_bar * 4):
        start = int(k * beat * SR)
        n = int(0.06 * SR)
        env = np.exp(-np.arange(n) / (0.012 * SR))
        freq, amp = (80.0, 0.9) if k % 4 == 0 else (1200.0, 0.35)
        y[start : start + n] += amp * env * np.sin(2 * math.pi * freq * np.arange(n) / SR)
    s = int(final_bar * 4 * beat * SR)
    n = int(2.5 * SR)
    chord = sum(np.sin(2 * math.pi * f * np.arange(n) / SR) for f in (110.0, 138.6, 164.8))
    y[s : s + n] += 0.3 * chord * np.exp(-np.arange(n) / (0.8 * SR))
    audiolib.write_wav(path, y, SR)
    return path, final_bar * 4 * beat


@unittest.skipUnless(HAVE_NUMPY, "needs numpy")
class BeatsAndCutTest(TempDirTest):
    def test_numpy_tracker_finds_tempo_beats_and_downbeats(self):
        import numpy as np

        path, final_at = click_track(self.tmp / "clicks.wav")
        x, sr = audiolib.read_audio(path)
        bpm, beats = music.track_beats_numpy(x.mean(axis=1), sr)
        self.assertAlmostEqual(bpm, 120, delta=2)
        grid = np.arange(0, final_at, 0.5)
        near = [min(abs(b - g) for b in beats) for g in grid]
        self.assertLess(max(near), 0.05)
        phase, _ = music.downbeat_phase(x.mean(axis=1), sr, beats)
        downs = beats[phase::4]
        self.assertLess(min(abs(downs[0] - k * 2.0) for k in range(10)), 0.05)
        self.assertLess(abs(downs[1] - downs[0] - 2.0), 0.05)

    def test_cut_lands_the_final_chord_after_the_last_word(self):
        film = new_film(self.tmp, duration=16)
        path, final_at = click_track(self.tmp / "clicks.wav")  # final chord at 20.0 s
        code, out, err = run_tool(music, ["beats", str(path)])
        self.assertEqual(code, 0, err)
        info = json.loads((self.tmp / "clicks.beats.json").read_text())
        self.assertAlmostEqual(info["bpm"], 120, delta=2)
        code, out, err = run_tool(
            music,
            ["cut", "--film", str(film), "--file", str(path), "--end-at", "13.3", "--to", "16", "--format", "wav"],
        )
        self.assertEqual(code, 0, out + err)
        edit = json.loads((film / "work" / "music" / "edit.json").read_text())
        self.assertAlmostEqual(edit["final_chord_raw"], final_at, delta=0.06)
        self.assertGreaterEqual(edit["final_chord_film"], 13.3 - 0.05)
        self.assertLess(edit["final_chord_film"], 13.3 + 2.0)  # within one bar after the target
        self.assertEqual(edit["plan"]["k"], 3)  # three whole bars removed
        self.assertAlmostEqual(audiolib.wav_duration(film / "web" / "audio" / "music.wav"), 16.0, delta=0.01)
        beats = json.loads((film / "src" / "beats.json").read_text())
        gaps = [b - a for a, b in zip(beats["downbeats"], beats["downbeats"][1:], strict=False)]
        self.assertTrue(all(abs(g - 2.0) < 0.06 for g in gaps), gaps)
        self.assertTrue(all(b <= 16 for b in beats["beats"]))

    def test_cut_extends_a_short_track_by_repeating_bars(self):
        film = new_film(self.tmp, duration=30)
        path, final_at = click_track(self.tmp / "short.wav", bars=6, final_bar=6)  # final chord at 12 s
        run_tool(music, ["beats", str(path)])
        code, out, err = run_tool(
            music, ["cut", "--film", str(film), "--file", str(path), "--end-at", "17", "--format", "wav"]
        )
        self.assertEqual(code, 0, out + err)
        edit = json.loads((film / "work" / "music" / "edit.json").read_text())
        self.assertLess(edit["plan"]["k"], 0)
        self.assertGreaterEqual(edit["final_chord_film"], 17 - 0.05)
        self.assertLess(edit["final_chord_film"], 17 + 2.0 + 0.05)

    def test_final_chord_is_never_a_re_attack_inside_the_fade(self):
        import numpy as np

        path, final_at = click_track(self.tmp / "clicks.wav", tail=8.0)
        x, sr = audiolib.read_audio(path)
        y = x[:, 0].astype(np.float64)
        # the final chord rings into a long fade-out with two faint re-attacks on later downbeats
        s, n = int(final_at * SR), int(7.5 * SR)
        chord = sum(np.sin(2 * math.pi * f * np.arange(n) / SR) for f in (110.0, 138.6, 164.8))
        y[s : s + n] += 0.3 * chord * np.linspace(1, 0, n) ** 2
        for tb in (final_at + 4, final_at + 6):
            b, m = int(tb * SR), int(0.3 * SR)
            y[b : b + m] += 0.08 * np.exp(-np.arange(m) / (0.05 * SR)) * np.sin(2 * math.pi * 220 * np.arange(m) / SR)
        bpm, beats = music.track_beats_numpy(y, SR)
        phase, _ = music.downbeat_phase(y, SR, beats)
        downs = music.extend_grid(beats[phase::4], len(y) / SR)
        t, how = music.final_chord(y, SR, downs)
        self.assertAlmostEqual(t, final_at, delta=0.06)
        self.assertIn("within 12 dB", how)

    def test_splice_is_equal_power(self):
        import numpy as np

        x = np.ones((1000, 1))
        y = music.splice((x, [(0, 500), (500, 1000)]), 1000, 0.1)
        self.assertEqual(len(y), 900)
        mid = y[400:500, 0]
        self.assertTrue(np.all(mid >= 0.99))  # cos + sin of equal signals peaks at sqrt(2), never dips


class GenTest(TempDirTest):
    def test_gen_streams_candidates(self):
        film = new_film(self.tmp, music={"mode": "generated", "prompt": "gentle marimba, 100 BPM"})
        with FakeOpenRouter() as fake:
            code, out, err = run_tool(music, ["gen", "--film", str(film), "--n", "2"])
            self.assertEqual(code, 0, err)
            bodies = [c["body"] for c in fake.calls("/chat/completions")]
        self.assertEqual([b["messages"][0]["content"] for b in bodies], ["gentle marimba, 100 BPM"] * 2)
        self.assertTrue(all(b["stream"] and b["model"] == "google/lyria-3-pro-preview" for b in bodies))
        self.assertEqual(sorted(p.name for p in (film / "work" / "music").glob("cand_*")), ["cand_0.wav", "cand_1.wav"])
        records = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual({e["stage"] for e in records if e["op"] == "record"}, {"assets"})
        made = json.loads((film / "work" / "music" / "candidates.json").read_text())  # which model made each one
        self.assertEqual(
            {k: v["model"] for k, v in made.items()}, dict.fromkeys(("cand_0.wav", "cand_1.wav"), bodies[0]["model"])
        )

    def test_gen_says_why_it_fell_back(self):
        film = new_film(self.tmp, music={"mode": "generated", "prompt": "a quiet solo piano"})
        with FakeOpenRouter() as fake:
            fake.plan["google/lyria-3-pro-preview"] = [402]
            code, out, err = run_tool(music, ["gen", "--film", str(film), "--n", "2"])
            self.assertEqual(code, 0, err)
            self.assertEqual(len(fake.calls("/chat/completions", "google/lyria-3-pro-preview")), 1)  # remembered
        self.assertIn("google/lyria-3-clip-preview", out)
        self.assertIn("after openrouter:google/lyria-3-pro-preview failed: HTTP 402", out)
        made = json.loads((film / "work" / "music" / "candidates.json").read_text())
        self.assertEqual({v["model"] for v in made.values()}, {"google/lyria-3-clip-preview"})  # the fallback made them


if __name__ == "__main__":
    unittest.main()
