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
                "seconds": 3.2,
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

    def test_a_directory_holding_only_its_film_json_is_scaffolded_in_place(self):
        d = self.tmp / "inplace"
        d.mkdir()
        (d / "film.json").write_text(json.dumps({"topic": "t", "goal": "g", "message": "m", "duration": 45}))
        code, out, err = run_tool(scaffold, ["new", str(d), "--film-json", str(d / "film.json")])
        self.assertEqual(code, 0, err)
        film = json.loads((d / "film.json").read_text())
        self.assertEqual((film["duration"], film["art"]["sheets"], film["budget_usd"]), (45, 3, 10))  # defaults filled
        self.assertTrue((d / "web" / "index.html").exists())
        e = self.tmp / "busy2"
        e.mkdir()
        (e / "film.json").write_text((d / "film.json").read_text())
        (e / "notes.txt").write_text("x")
        code, _, err = run_tool(scaffold, ["new", str(e), "--film-json", str(e / "film.json")])
        self.assertEqual(code, 2)
        self.assertIn("only the film.json", err)

    @unittest.skipUnless(audiolib.which("node"), "needs node")
    def test_resolve_warns_when_narration_runs_into_the_end_card(self):
        d = self.tmp / "card"
        run_tool(scaffold, ["new", str(d), "--duration", "12"] + REQ)  # end card on: the last 3.2 s (from 8.8 s)
        (d / "src" / "script.json").write_text(json.dumps({"lines": [{"id": "l1", "text": "Two words."}]}))
        sb = json.loads((d / "src" / "storyboard.json").read_text())
        sb["scenes"] = [{"id": "a", "elements": [], "custom": {"canvas": "a", "layer": "sideways"}}]
        (d / "src" / "storyboard.json").write_text(json.dumps(sb))
        (d / "web" / "film" / "shots").mkdir(parents=True, exist_ok=True)
        (d / "web" / "film" / "shots" / "a.js").write_text("FILM.shot('a', function () {});\n")

        def resolve(t, dur):
            (d / "src" / "words.json").write_text(json.dumps({"l1": {"t": t, "d": dur}}))
            r = subprocess.run(
                ["node", str(d / "tools" / "resolve.mjs"), "--film", str(d)], capture_output=True, text=True
            )
            return r.returncode, r.stdout + r.stderr

        code, out = resolve(0.6, 2.0)
        self.assertEqual(code, 1)
        self.assertIn('custom.layer: must be "over"', out)
        sb["scenes"][0]["custom"]["layer"] = "under"
        (d / "src" / "storyboard.json").write_text(json.dumps(sb))
        code, out = resolve(0.6, 2.0)
        self.assertEqual(code, 0, out)
        self.assertNotIn("end card", out)  # 3.2 - 0.4 - 0.25 = 2.55 s fully visible: no legibility warning
        code, out = resolve(6.0, 2.7)  # ends at 8.7 s, 0.1 s before the card
        self.assertIn("0.10 s before the end card starts at 8.80 s", out)
        code, out = resolve(6.0, 3.3)
        self.assertIn("0.50 s after the end card starts", out)
        # a 45 s film with the old 2.5 s card: 2.5 - 0.4 fade-in - 0.8 fade-out = 1.3 s to read it
        film = json.loads((d / "film.json").read_text())
        film.update(duration=45)
        film["disclosure"]["seconds"] = 2.5
        (d / "film.json").write_text(json.dumps(film))
        run_tool(scaffold, ["sync-config", "--film", str(d)])
        code, out = resolve(0.6, 2.0)
        self.assertIn("the end card is fully visible for 1.30 s", out)
        self.assertIn("raise disclosure.seconds in film.json to at least 3.2", out)
        film["disclosure"]["seconds"] = 3.2
        (d / "film.json").write_text(json.dumps(film))
        run_tool(scaffold, ["sync-config", "--film", str(d)])
        self.assertNotIn("end card", resolve(0.6, 2.0)[1])

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

    def test_sync_engine_updates_the_engine_copy_and_nothing_else(self):
        d = self.tmp / "old"
        run_tool(scaffold, ["new", str(d)] + REQ)
        engine = SKILL_DIR / "engine"
        # an older engine: a changed player script, a missing tool, an old dependency; plus the film's own files
        (d / "web" / "js" / "main.js").write_text("// an older player\n")
        (d / "tools" / "qa.mjs").unlink()
        (d / "tools" / "notes.mjs").write_text("// a film-only helper\n")
        pkg = json.loads((d / "package.json").read_text())
        pkg["dependencies"].update(mediabunny="^0.1.0", extra="^1.0.0")
        (d / "package.json").write_text(json.dumps(pkg))
        (d / "web" / "film" / "shots").mkdir(parents=True, exist_ok=True)
        (d / "web" / "film" / "shots" / "a.js").write_text("FILM.shot('a', function () {});\n")
        owned = {p: p.read_bytes() for sub in ("src", "web/film") for p in (d / sub).rglob("*") if p.is_file()}
        owned[d / "film.json"] = (d / "film.json").read_bytes()

        code, out, err = run_tool(scaffold, ["sync-engine", "--film", str(d), "--dry-run"])
        self.assertEqual(code, 0, err)
        self.assertIn("changed  web/js/main.js (+", out)
        self.assertIn("new      tools/qa.mjs", out)
        self.assertIn("kept     tools/notes.mjs", out)
        self.assertIn("package.json dependency mediabunny ^0.1.0 -> ", out)
        self.assertIn("dry run: nothing written", out)
        self.assertEqual((d / "web" / "js" / "main.js").read_text(), "// an older player\n")
        self.assertFalse((d / "tools" / "qa.mjs").exists())

        code, out, err = run_tool(scaffold, ["sync-engine", "--film", str(d)])
        self.assertEqual(code, 0, err)
        for rel in ("web/js/main.js", "tools/qa.mjs", "web/index.html"):
            self.assertTrue(filecmp.cmp(engine / rel, d / rel, shallow=False), rel)
        self.assertTrue((d / "tools" / "notes.mjs").exists())
        pkg = json.loads((d / "package.json").read_text())
        want = json.loads((engine / "package.json").read_text())["dependencies"]
        self.assertEqual(pkg["dependencies"], dict(want, extra="^1.0.0"))  # engine versions win, extras stay
        backups = list((d / "work").glob("engine-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "web" / "js" / "main.js").read_text(), "// an older player\n")
        self.assertIn("mediabunny", (backups[0] / "package.json").read_text())
        self.assertIn("npm install --prefix", out)
        self.assertIn("resolve.mjs", out)
        for p, b in owned.items():
            self.assertEqual(p.read_bytes(), b, p)  # film content untouched

        code, out, _ = run_tool(scaffold, ["sync-engine", "--film", str(d)])
        self.assertIn("up to date", out)
        self.assertEqual(len(list((d / "work").glob("engine-backup-*"))), 1)  # no empty backup
        self.assertEqual(run_tool(scaffold, ["sync-engine", "--film", str(self.tmp / "nothing")])[0], 2)

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
