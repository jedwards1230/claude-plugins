"""art.py: connected components, cutout on synthetic sheets (flat, uneven, shadowed), and sheet generation
via the fake server."""

import json
import random
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool

# isort: split
import art
import audiolib

HAVE = audiolib.has("numpy") and audiolib.has("PIL")


def uneven_ground(size=900, shadow=None):
    """A sheet photographed rather than scanned: a lighting gradient (about 120-175 grey), a lighter band
    across the top, and optionally a soft drop shadow under the box (bbox) -> PIL image."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter

    y = np.linspace(0, 1, size)[:, None]
    x = np.linspace(0, 1, size)[None, :]
    g = 120 + 40 * y + 15 * x
    g = np.where(y < 0.075, g + 45, g)
    arr = np.dstack([g] * 3)
    if shadow:
        sh = Image.new("L", (size, size), 0)
        ImageDraw.Draw(sh).rectangle(shadow, fill=255)
        sh = np.asarray(sh.filter(ImageFilter.GaussianBlur(12)), dtype=np.float64)[..., None] / 255
        arr = arr * (1 - 0.45 * sh)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")


def ring_alpha(px, pad=12, slack=3):
    """Largest alpha in the frame of a cutout outside its sticker (the 12 px pad minus a little slack)."""
    h, w = px.shape[:2]
    a = px[..., 3].copy()
    a[pad - slack : h - pad + slack, pad - slack : w - pad + slack] = 0
    return int(a.max())


def synthetic_sheet(path, size=900, ground=None):
    """Grey #8C8C8C sheet (or the given ground image), three white-bordered stickers: two on the top row,
    one below."""
    from PIL import Image, ImageDraw

    im = ground or Image.new("RGB", (size, size), (140, 140, 140))
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
        self.assertIn("--skip", out)
        code, out, _ = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "a,b", "--allow-extra"])
        self.assertEqual(code, 0)
        self.assertIn("sheet_02", out)
        code, out, _ = run_tool(art, ["contact", "--film", str(film)])
        self.assertEqual(code, 0)
        self.assertIn("3 stickers", out)

    def test_label_can_be_4_connected(self):
        import numpy as np

        diagonal = np.array([[1, 0], [0, 1]], dtype=bool)
        self.assertEqual(art.label(diagonal)[1], 1)
        self.assertEqual(art.label(diagonal, conn=4)[1], 2)

    def test_uneven_ground_and_a_light_band_key_as_ground(self):
        import numpy as np
        from PIL import Image

        film = new_film(self.tmp)
        sheet = synthetic_sheet(self.tmp / "photo.png", ground=uneven_ground())
        code, out, err = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "sun,box,cone"])
        self.assertEqual(code, 0, out + err)  # three stickers, not the band or one sheet-wide region
        for name, size in (("sun", 260), ("box", 300), ("cone", 300)):
            px = np.asarray(Image.open(film / "web" / "img" / f"{name}.webp").convert("RGBA")).astype(int)
            self.assertAlmostEqual(px.shape[1], size + 24, delta=10, msg=name)  # the sticker plus the 12 px pad
            self.assertLess(ring_alpha(px), 32, name)  # no ground kept around the white border

    def test_cast_shadow_is_keyed_with_the_ground(self):
        import numpy as np
        from PIL import Image

        film = new_film(self.tmp)
        ground = uneven_ground(shadow=(545, 115, 845, 415))  # under the box, offset down and right
        sheet = synthetic_sheet(self.tmp / "shadow.png", ground=ground)
        code, out, err = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "sun,box,cone"])
        self.assertEqual(code, 0, out + err)
        px = np.asarray(Image.open(film / "web" / "img" / "box.webp").convert("RGBA")).astype(int)
        self.assertAlmostEqual(px.shape[1], 300 + 24, delta=10)  # the white square plus the pad, no shadow
        self.assertAlmostEqual(px.shape[0], 300 + 24, delta=10)
        self.assertLess(ring_alpha(px), 32)  # the shadow is not part of the sticker

    def test_edge_regions_are_dropped_and_skip_drops_by_index(self):
        from PIL import ImageDraw

        film = new_film(self.tmp)
        sheet = synthetic_sheet(self.tmp / "edge.png")
        from PIL import Image

        im = Image.open(sheet)
        ImageDraw.Draw(im).rectangle((820, 500, 900, 700), fill=(255, 255, 255))  # cut off by the right edge
        im.save(sheet)
        code, out, err = run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "sun,box,cone"])
        self.assertEqual(code, 0, out + err)
        self.assertIn("touches the sheet edge", out)
        code, out, err = run_tool(
            art, ["cutout", "--film", str(film), str(sheet), "--names", "sun,cone", "--skip", "1"]
        )
        self.assertEqual(code, 0, out + err)
        self.assertIn("--skip #1", out)
        manifest = json.loads((film / "web" / "img" / "manifest.json").read_text())
        self.assertLess(manifest["cone"][0], 340)  # the triangle, not the square
        self.assertEqual(
            run_tool(art, ["cutout", "--film", str(film), str(sheet), "--names", "a", "--skip", "7"])[0], 2
        )

    def test_strip_border_defringe_and_anchors(self):
        import numpy as np
        from PIL import Image

        film = new_film(self.tmp)
        sheet = synthetic_sheet(self.tmp / "sheet.png")
        args = ["cutout", "--film", str(film), str(sheet), "--names", "sun,box,cone"]
        code, out, err = run_tool(art, args + ["--strip-border", "--defringe", "--anchors", "sun=0.5,1; box=0,0.25"])
        self.assertEqual(code, 0, out + err)
        sun = np.asarray(Image.open(film / "web" / "img" / "sun.webp").convert("RGBA")).astype(int)
        self.assertLess(sun.shape[1], 260)  # the 20 px white border and the pad are gone
        white = (sun[..., :3].min(-1) > 235) & (sun[..., 3] > 128)
        self.assertEqual(int(white.sum()), 0)
        manifest = json.loads((film / "web" / "img" / "manifest.json").read_text())
        self.assertEqual(manifest["sun"]["anchor"], [0.5, 1.0])
        self.assertEqual(manifest["box"]["anchor"], [0.0, 0.25])
        self.assertEqual(manifest["sun"]["size"], [sun.shape[1], sun.shape[0]])
        self.assertIsInstance(manifest["cone"], list)  # no pivot: the plain [w, h] entry
        code, out, _ = run_tool(art, args)
        self.assertIn("anchor kept", out)  # a re-cut keeps the pivot stored earlier
        self.assertEqual(json.loads((film / "web" / "img" / "manifest.json").read_text())["sun"]["anchor"], [0.5, 1.0])
        for bad in ("sun=2,0", "moon=0.5,0.5", "sun"):
            self.assertEqual(run_tool(art, args + ["--anchors", bad])[0], 2, bad)


class PaletteTest(unittest.TestCase):
    def test_style_block_uses_list_and_object_palettes(self):
        film = {"style": {"preset": "collage", "texture": "paper"}, "tone": "warm"}
        listed = art.style_block(dict(film, style=dict(film["style"], palette=["#112233", "#445566"])))
        self.assertIn("Limited palette: #112233, #445566.", listed)
        obj = {
            "ground": "#EEEEEE",
            "accent": "#AA3322",
            "ink": "#222222",
            "paper": "#FBF7EE",
            "swatches": {"moss": "#335522", "straw": "#DDBB55", "dup": "#AA3322"},
        }
        block = art.style_block(dict(film, style=dict(film["style"], palette=obj)))
        self.assertIn("Limited palette: #AA3322, #222222, #FBF7EE, #335522, #DDBB55.", block)
        self.assertNotIn("#EEEEEE", block)  # grounds are not sticker colours


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
            self.assertIn("NOT a photo: no table", text)
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
