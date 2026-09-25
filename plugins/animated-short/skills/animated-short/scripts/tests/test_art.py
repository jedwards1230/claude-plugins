"""art.py: connected components, cutout on a synthetic sheet, and sheet generation via the fake server."""

import json
import random
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool

# isort: split
import art
import audiolib

HAVE = audiolib.has("numpy") and audiolib.has("PIL")


def synthetic_sheet(path, size=900):
    """Grey #8C8C8C sheet, three white-bordered stickers: two on the top row, one below."""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", (size, size), (140, 140, 140))
    d = ImageDraw.Draw(im)
    # (bbox, colour, shape): a circle and a square on row one, a triangle on row two
    d.ellipse((70, 90, 330, 350), fill=(255, 255, 255))
    d.ellipse((90, 110, 310, 330), fill=(220, 90, 70))
    d.rectangle((520, 80, 820, 380), fill=(255, 255, 255))
    d.rectangle((540, 100, 800, 360), fill=(40, 140, 140))
    d.rectangle((600, 170, 740, 290), fill=(140, 140, 140))  # a grey hole inside the square: must stay opaque
    d.polygon([(300, 820), (450, 520), (600, 820)], fill=(255, 255, 255))
    d.polygon([(330, 800), (450, 560), (570, 800)], fill=(230, 180, 60))
    d.point([(10, 10), (880, 880)], fill=(0, 0, 0))  # specks are ignored
    im.save(path)
    return path


@unittest.skipUnless(HAVE, "needs numpy and pillow")
class CutoutTest(TempDirTest):
    def test_label_matches_a_flood_fill(self):
        import numpy as np

        rng = random.Random(3)
        m = np.array([[rng.random() < 0.45 for _ in range(40)] for _ in range(30)])
        labels, n = art.label(m)
        # brute-force 8-connected flood fill
        seen, count = np.zeros_like(m, dtype=bool), 0
        for y in range(30):
            for x in range(40):
                if m[y, x] and not seen[y, x]:
                    count += 1
                    stack = [(y, x)]
                    seen[y, x] = True
                    ids = set()
                    while stack:
                        cy, cx = stack.pop()
                        ids.add(int(labels[cy, cx]))
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                ny, nx = cy + dy, cx + dx
                                if 0 <= ny < 30 and 0 <= nx < 40 and m[ny, nx] and not seen[ny, nx]:
                                    seen[ny, nx] = True
                                    stack.append((ny, nx))
                    self.assertEqual(len(ids), 1)
        self.assertEqual(n, count)

    def test_cutout_names_stickers_row_major(self):
        from PIL import Image

        film = new_film(self.tmp)
        sheet = synthetic_sheet(self.tmp / "sheet.png")
        code, out, err = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "sun,box,cone"])
        self.assertEqual(code, 0, out + err)
        manifest = json.loads((film / "web" / "img" / "manifest.json").read_text())
        self.assertEqual(sorted(manifest), ["box", "cone", "sun"])
        sun = Image.open(film / "web" / "img" / "sun.webp")
        box = Image.open(film / "web" / "img" / "box.webp")
        self.assertEqual(sun.mode, "RGBA")
        self.assertAlmostEqual(sun.size[0], 260 + 24, delta=8)  # sticker plus the 12 px pad each side
        r, g, b, a = sun.getpixel((sun.size[0] // 2, sun.size[1] // 2))
        self.assertEqual(a, 255)
        self.assertGreater(r, 180)  # the coral centre
        self.assertEqual(sun.getpixel((2, 2))[3], 0)  # the corner is transparent
        self.assertEqual(box.getpixel((box.size[0] // 2, box.size[1] // 2))[3], 255)  # the hole is filled
        self.assertTrue((film / "work" / "qa" / "cutout-sheet.jpg").exists())

    def test_wrong_name_count_fails_with_positions(self):
        film = new_film(self.tmp)
        sheet = synthetic_sheet(self.tmp / "sheet.png")
        code, out, _ = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "a,b"])
        self.assertEqual(code, 1)
        self.assertIn("found 3 stickers", out)
        code, out, _ = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "a,b", "--allow-extra"])
        self.assertEqual(code, 0)
        self.assertIn("sheet_02", out)
        code, out, _ = run_tool(art, ["contact", "--film", str(film)])
        self.assertEqual(code, 0)
        self.assertIn("3 stickers", out)


class SheetTest(TempDirTest):
    def test_sheet_prompt_refs_and_pinned_model(self):
        film = new_film(self.tmp, style={"palette": ["#E8B23A", "#2F8C8C"], "motif": "a paper boat"})
        (self.tmp / "items.txt").write_text("1. a kettle\n2. a cup\n")
        ref = self.tmp / "ref.png"
        from helpers import png_bytes

        ref.write_bytes(png_bytes())
        with FakeOpenRouter() as fake:
            code, out, err = run_tool(
                art,
                [
                    "sheet",
                    "--film",
                    str(film),
                    "--name",
                    "kitchen",
                    "--prompt-file",
                    str(self.tmp / "items.txt"),
                    "--refs",
                    str(ref),
                    "--draft",
                ],
            )
            self.assertEqual(code, 0, err)
            body = fake.calls("/chat/completions")[-1]["body"]
            self.assertEqual(body["model"], "google/gemini-3.1-flash-image")
            self.assertEqual(body["image_config"]["image_size"], "1K")
            text = body["messages"][0]["content"][0]["text"]
            self.assertIn("#8C8C8C", text)
            self.assertIn("#E8B23A, #2F8C8C", text)
            self.assertIn("a paper boat", text)
            self.assertIn("1. a kettle", text)
            self.assertIn("reference", text)
            self.assertTrue(body["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
            code, _, err = run_tool(
                art,
                [
                    "sheet",
                    "--film",
                    str(film),
                    "--name",
                    "k2",
                    "--prompt-file",
                    str(self.tmp / "items.txt"),
                    "--draft",
                    "--model",
                    "google/gemini-3.1-flash-image-preview",
                ],
            )
            self.assertEqual(code, 2)
            self.assertIn("pinned", err)
        self.assertTrue((film / "work" / "sheets" / "kitchen_0.png").exists())
        self.assertEqual(json.loads((film / "work" / "sheets" / "kitchen.json").read_text())["tier"], "draft")
        records = [json.loads(x) for x in (film / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual({e["stage"] for e in records if e["op"] == "record"}, {"animatic"})  # draft art = animatic


if __name__ == "__main__":
    unittest.main()
