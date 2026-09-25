"""schema.py: the stdlib validator, defaults, and the film and rubric schemas."""

import json
import unittest

from helpers import FIXTURES, SKILL_DIR, TempDirTest, run_tool

import schema

RUBRIC = json.loads((SKILL_DIR / "references" / "rubric.schema.json").read_text())
FILM = json.loads((SKILL_DIR / "references" / "film.schema.json").read_text())


class ValidatorTest(unittest.TestCase):
    S = {
        "type": "object",
        "required": ["a"],
        "additionalProperties": False,
        "properties": {
            "a": {"type": "integer", "minimum": 1, "maximum": 5},
            "b": {"enum": ["x", "y"]},
            "c": {"type": "string", "pattern": "^\\d+:\\d\\d$", "minLength": 4},
            "d": {"type": "array", "items": {"$ref": "#/$defs/n"}, "minItems": 1},
            "e": {"anyOf": [{"type": "string"}, {"type": "number"}]},
            "f": {"oneOf": [{"type": "integer"}, {"type": "number", "minimum": 10}]},
            "g": {"type": ["string", "null"]},
            "h": {"const": 3},
        },
        "$defs": {"n": {"type": "number"}},
    }

    def test_accepts_valid(self):
        self.assertEqual(
            schema.validate(self.S, {"a": 2, "b": "x", "c": "1:05", "d": [1, 2.5], "e": 3, "f": 4, "g": None, "h": 3}),
            [],
        )

    def test_rejects_each_rule(self):
        cases = {
            "missing required": {},
            "type": {"a": "2"},
            "minimum": {"a": 0},
            "maximum": {"a": 9},
            "enum": {"a": 1, "b": "z"},
            "pattern": {"a": 1, "c": "12345"},
            "minLength": {"a": 1, "c": "1:5"},
            "additionalProperties": {"a": 1, "zz": 1},
            "$ref items": {"a": 1, "d": ["x"]},
            "minItems": {"a": 1, "d": []},
            "anyOf": {"a": 1, "e": []},
            "oneOf both match": {"a": 1, "f": 12},
            "const": {"a": 1, "h": 4},
            "bool is not integer": {"a": True},
            "type list": {"a": 1, "g": 3},
        }
        for name, doc in cases.items():
            with self.subTest(name):
                self.assertTrue(schema.validate(self.S, doc), name)

    def test_unsupported_keyword_raises(self):
        with self.assertRaises(schema.SchemaError):
            schema.validate({"type": "object", "patternProperties": {}}, {})

    def test_defaults_fill_nested(self):
        s = {
            "type": "object",
            "properties": {
                "x": {"type": "object", "default": {}, "properties": {"y": {"type": "integer", "default": 7}}},
                "z": {"$ref": "#/$defs/z"},
            },
            "$defs": {"z": {"type": "string", "default": "zed"}},
        }
        self.assertEqual(schema.apply_defaults(s, {}), {"x": {"y": 7}, "z": "zed"})
        self.assertEqual(schema.apply_defaults(s, {"x": {"y": 1}}), {"x": {"y": 1}, "z": "zed"})


class FilmSchemaTest(unittest.TestCase):
    def test_minimal_film_gets_every_default(self):
        f = schema.apply_defaults(FILM, {"topic": "t", "goal": "g", "message": "m"})
        self.assertEqual(schema.validate(FILM, f), [])
        self.assertEqual((f["form"], f["duration"], f["aspect"], f["budget_usd"]), ("explainer", 90, "16:9", 10))
        self.assertEqual(f["disclosure"]["end_card"], True)
        self.assertEqual(f["providers"], {"preset": "openrouter", "commercial_safe": True, "roles": {}})
        self.assertEqual(f["review"]["director_min"], 8.5)
        self.assertEqual(f["audience"][0]["name"], "curious non-expert")

    def test_every_property_has_a_description(self):
        missing = []

        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.get("properties", {}).items():
                    if isinstance(v, dict) and "description" not in v:
                        missing.append(f"{path}.{k}")
                    walk(v, f"{path}.{k}")
                for k, v in node.get("$defs", {}).items():
                    walk(v, f"$defs.{k}")
                if isinstance(node.get("items"), dict):
                    walk(node["items"], path + "[]")

        walk(FILM, "")
        self.assertEqual(missing, [])

    def test_rejects_bad_inputs(self):
        for bad in (
            {"goal": "g", "message": "m"},
            {"topic": "t", "goal": "g", "message": "m", "aspect": "4:3"},
            {"topic": "t", "goal": "g", "message": "m", "duration": 600},
            {"topic": "t", "goal": "g", "message": "m", "voice": {"mode": "robot"}},
            {"topic": "t", "goal": "g", "message": "m", "typo_field": 1},
        ):
            self.assertTrue(schema.validate(FILM, bad), bad)


class RubricSchemaTest(TempDirTest):
    def test_qa_check_outputs_validate(self):
        for name in ("qa-check-ship.json", "qa-check-iterate.json"):
            with self.subTest(name):
                doc = json.loads((FIXTURES / name).read_text())
                self.assertEqual(schema.validate(RUBRIC, doc), [])
                self.assertTrue(doc["checks"] and all("id" in c for c in doc["checks"]))

    def test_round_fixtures_validate(self):
        for f in sorted((FIXTURES / "round-ship").glob("*.json")):
            with self.subTest(f.name):
                self.assertEqual(schema.validate(RUBRIC, json.loads(f.read_text())), [])

    def test_rejects_invalid_reviews(self):
        base = json.loads((FIXTURES / "round-ship" / "director.json").read_text())
        for mutate in (
            lambda d: d.pop("verdict"),
            lambda d: d.update(reviewer="critic"),
            lambda d: d["defects"][0].update(at="4 s"),
            lambda d: d["scores"].update(vibes={"value": 3, "why": ""}),
            lambda d: d["scores"]["overall"].update(value=11),
            lambda d: d.update(matches_message="yes"),
        ):
            doc = json.loads(json.dumps(base))
            mutate(doc)
            self.assertTrue(schema.validate(RUBRIC, doc))

    def test_cli(self):
        bad = self.tmp / "bad.json"
        bad.write_text(json.dumps({"reviewer": "director"}))
        code, out, _ = run_tool(schema, ["validate", str(SKILL_DIR / "references" / "rubric.schema.json"), str(bad)])
        self.assertEqual(code, 1)
        self.assertIn("missing required property 'cut'", out)
        code, _, _ = run_tool(
            schema,
            ["validate", str(SKILL_DIR / "references" / "rubric.schema.json"), str(FIXTURES / "qa-check-ship.json")],
        )
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
