"""scaffold.py: new films, the golden example, config derivation and sync-config."""

import filecmp
import json
import subprocess
import unittest

from helpers import SKILL_DIR, TempDirTest, run_tool

# isort: split
import audiolib
import scaffold

REQ = [
    "--topic",
    "Tides",
    "--goal",
    "See why the sea rises twice a day",
    "--message",
    "The moon pulls the ocean into two bulges.",
]


def tree(root):
    return sorted(
        p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and "node_modules" not in p.parts
    )


class ScaffoldTest(TempDirTest):
    def test_new_film_layout_and_config(self):
        d = self.tmp / "tides"
        code, out, err = run_tool(scaffold, ["new", str(d), "--aspect", "9:16", "--duration", "45"] + REQ)
        self.assertEqual(code, 0, err)
        for rel in (
            "package.json",
            "web/index.html",
            "web/js/main.js",
            "tools/render.mjs",
            "tools/resolve.mjs",
            "film.json",
            "src/storyboard.json",
            "src/script.json",
            "src/words.json",
            "web/film/config.json",
            ".gitignore",
        ):
            self.assertTrue((d / rel).is_file(), rel)
        for rel in ("work/reviews", "work/takes", "out", "cache"):
            self.assertTrue((d / rel).is_dir(), rel)
        film = json.loads((d / "film.json").read_text())
        self.assertEqual((film["aspect"], film["duration"], film["title"]), ("9:16", 45, "Tides"))
        cfg = json.loads((d / "web" / "film" / "config.json").read_text())
        self.assertEqual(
            (cfg["size"], cfg["fps"], cfg["duration"], cfg["title"], cfg["captions"]),
            ([1080, 1920], 30, 45, "Tides", True),
        )
        self.assertEqual(
            cfg["disclosure"],
            {
                "end_card": True,
                "seconds": 2.5,
                "title": "Made with AI",
                "note": "Made with AI. The credits list the models and tools used.",
            },
        )
        sb = json.loads((d / "src" / "storyboard.json").read_text())
        self.assertEqual(sb["meta"]["size"], [1080, 1920])
        ignored = (d / ".gitignore").read_text().split()
        for pattern in ("node_modules/", "cache/", "work/frames/", "work/export-frames/", "work/preflight.json"):
            self.assertIn(pattern, ignored)
        self.assertIn(".env", ignored)  # secrets never belong in a film, and are ignored if they land there
        self.assertIn("*.key", ignored)

    def test_refuses_non_empty_dir_and_invalid_film(self):
        d = self.tmp / "busy"
        d.mkdir()
        (d / "keep.txt").write_text("x")
        self.assertEqual(run_tool(scaffold, ["new", str(d)] + REQ)[0], 2)
        self.assertEqual(run_tool(scaffold, ["new", str(self.tmp / "x"), "--topic", "only"])[0], 2)
        bad = self.tmp / "bad.json"
        bad.write_text(json.dumps({"topic": "t", "goal": "g", "message": "m", "aspect": "4:3"}))
        code, _, err = run_tool(scaffold, ["new", str(self.tmp / "y"), "--film-json", str(bad)])
        self.assertEqual(code, 2)
        self.assertIn("aspect", err)
        code, _, _ = run_tool(scaffold, ["new", str(d), "--force"] + REQ)
        self.assertEqual(code, 0)
        self.assertTrue((d / "keep.txt").exists())

    def test_golden_matches_a_plain_copy(self):
        d = self.tmp / "golden"
        code, out, err = run_tool(scaffold, ["new", str(d), "--from-example", "golden"])
        self.assertEqual(code, 0, err)
        ref = self.tmp / "ref"
        ref.mkdir()
        scaffold.copy_tree(SKILL_DIR / "engine", ref)
        scaffold.copy_tree(SKILL_DIR / "examples" / "golden", ref)
        for rel in tree(ref):
            if rel == "film.json":
                continue  # scaffold writes it back validated, with the defaults filled in
            self.assertTrue(filecmp.cmp(ref / rel, d / rel, shallow=False), rel)
        self.assertEqual(set(tree(d)) - set(tree(ref)), {".gitignore"})
        film = json.loads((d / "film.json").read_text())
        self.assertEqual(
            (film["duration"], film["budget_usd"], film["voice"]["mode"], film["music"]["mode"]),
            (10, 0, "none", "synth"),
        )
        # syncing the derived film.json changes nothing that is drawn
        run_tool(scaffold, ["sync-config", "--film", str(d)])
        cfg = json.loads((d / "web" / "film" / "config.json").read_text())
        orig = json.loads((SKILL_DIR / "examples" / "golden" / "web" / "film" / "config.json").read_text())
        self.assertEqual({k: v for k, v in cfg.items() if k != "disclosure"}, orig)
        self.assertFalse(cfg["disclosure"]["end_card"])

    def test_sync_config_maps_style_and_disclosure(self):
        d = self.tmp / "f"
        run_tool(scaffold, ["new", str(d)] + REQ)
        film = json.loads((d / "film.json").read_text())
        film.update(
            aspect="1:1",
            duration=30,
            subtitle="A short tide table",
            credits=["Voice: a TTS model", {"role": "Music", "name": "a music model"}],
            notes=[{"title": "Sources", "text": "Tide tables."}],
        )
        film["style"].update(
            palette=["#123456", "#ABCDEF"],
            fonts={
                "display": "Fraunces",
                "body": "Inter, sans-serif",
                "faces": [{"family": "Fraunces", "src": "fonts/fraunces.woff2"}],
            },
        )
        film["disclosure"].update(card=False, end_card=True)
        (d / "film.json").write_text(json.dumps(film))
        code, out, err = run_tool(scaffold, ["sync-config", "--film", str(d)])
        self.assertEqual(code, 0, err)
        self.assertIn("meta.size", out)
        cfg = json.loads((d / "web" / "film" / "config.json").read_text())
        self.assertEqual((cfg["size"], cfg["duration"], cfg["subtitle"]), ([1080, 1080], 30, "A short tide table"))
        self.assertEqual(cfg["palette"]["accent"], "#123456")
        self.assertEqual(cfg["palette"]["panels"], ["#123456", "#ABCDEF"])
        self.assertEqual(cfg["fonts"]["hand"], '"Fraunces", sans-serif')
        self.assertEqual(cfg["fonts"]["print"], "Inter, sans-serif")
        self.assertEqual(cfg["fonts"]["faces"][0]["src"], "fonts/fraunces.woff2")
        self.assertEqual(cfg["credits"], [])  # card off: no page credits ...
        self.assertEqual(cfg["disclosure"]["note"], "")
        self.assertEqual(
            cfg["disclosure"]["lines"], ["Voice: a TTS model", "Music: a music model"]
        )  # ... but the end card keeps them
        self.assertEqual(cfg["notes"][0]["title"], "Sources")
        self.assertEqual(json.loads((d / "src" / "storyboard.json").read_text())["meta"]["size"], [1080, 1080])

    @unittest.skipUnless(audiolib.which("node"), "needs node")
    def test_new_film_resolves(self):
        d = self.tmp / "r"
        run_tool(scaffold, ["new", str(d)] + REQ)
        r = subprocess.run(
            ["node", str(d / "tools" / "resolve.mjs"), "--film", str(d), "--check"], capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
