"""critic.py: media parts, the 720p proxy under a size cap, and the saved record."""

import base64
import json
import unittest

from helpers import FakeOpenRouter, TempDirTest, bursts, new_film, png_bytes, run_tool, write_wav

# isort: split
import audiolib
import common
import critic
from providers import Context


class CriticTest(TempDirTest):
    def test_ask_sends_images_and_audio_and_saves_the_reply(self):
        film = new_film(self.tmp)
        prompt = self.tmp / "p.md"
        prompt.write_text("Which take sounds warmer?")
        img = self.tmp / "still.png"
        img.write_bytes(png_bytes())
        wav = write_wav(self.tmp / "take.wav", bursts([(0.1, 0.5)], 0.6))
        with FakeOpenRouter() as fake:
            fake.replies = ["Take one is warmer."]
            code, out, err = run_tool(
                critic,
                ["ask", "--film", str(film), "--prompt-file", str(prompt), "--images", str(img), "--audio", str(wav)],
            )
            self.assertEqual(code, 0, err)
            parts = fake.calls("/chat/completions")[0]["body"]["messages"][0]["content"]
        self.assertIn("Take one is warmer.", out)
        kinds = [p["type"] for p in parts]
        self.assertEqual(kinds, ["text", "text", "image_url", "text", "input_audio"])
        self.assertEqual(parts[4]["input_audio"]["format"], "wav")
        self.assertEqual(base64.b64decode(parts[4]["input_audio"]["data"]), wav.read_bytes())
        saved = sorted((film / "work" / "critic").glob("*.json"))
        rec = json.loads(saved[-1].read_text())
        self.assertEqual((rec["model"], rec["text"]), ("google/gemini-3.8-flash", "Take one is warmer."))
        records = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual([e["stage"] for e in records if e["op"] == "record"], ["review"])  # the default stage

    def test_stage_labels_are_the_quote_stages(self):
        film = new_film(self.tmp)
        prompt = self.tmp / "p.md"
        prompt.write_text("Pick the take.")
        with FakeOpenRouter():
            code, _, err = run_tool(
                critic, ["ask", "--film", str(film), "--prompt-file", str(prompt), "--stage", "voice"]
            )
            self.assertEqual(code, 0, err)
            bad = run_tool(critic, ["ask", "--film", str(film), "--prompt-file", str(prompt), "--stage", "music"])
        self.assertEqual(bad[0], 2)
        records = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual([e["stage"] for e in records if e["op"] == "record"], ["voice"])

    @unittest.skipUnless(audiolib.has_ffmpeg(), "needs ffmpeg")
    def test_big_video_is_sent_as_a_720p_proxy_under_the_cap(self):
        film = new_film(self.tmp)
        src = self.tmp / "cut.mp4"
        audiolib.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3",
             "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-shortest", "-c:v", "libx264", "-crf", "12",
             "-c:a", "aac", str(src)]
        )  # fmt: skip
        sent, rec = critic.video_proxy(src, film / "work" / "critic", max_mib=0.25)
        self.assertNotEqual(sent, src)
        self.assertLessEqual(sent.stat().st_size, 0.25 * 1024 * 1024)
        self.assertEqual(critic.probe_media(sent)["height"], 720)
        self.assertEqual(rec["source"], str(src))
        with FakeOpenRouter() as fake:
            ctx = Context(film, common.load_film(film))
            text, record = critic.ask(ctx, "Director pass.", video=src, max_mib=0.25)
            url = fake.calls("/chat/completions")[0]["body"]["messages"][0]["content"][-1]["video_url"]["url"]
        self.assertTrue(url.startswith("data:video/mp4;base64,"))
        self.assertEqual(record["proxies"][0]["sent"], str(sent))


if __name__ == "__main__":
    unittest.main()
