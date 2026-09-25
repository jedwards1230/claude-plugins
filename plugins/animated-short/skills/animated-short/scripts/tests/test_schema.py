"""schema.py: the stdlib validator, defaults, and the film, storyboard and rubric schemas."""

import json
import unittest

from helpers import FIXTURES, SKILL_DIR, TempDirTest, new_film, run_tool

# isort: split
import schema

RUBRIC = json.loads((SKILL_DIR / "references" / "rubric.schema.json").read_text())
FILM = json.loads((SKILL_DIR / "references" / "film.schema.json").read_text())
STORYBOARD = json.loads((SKILL_DIR / "references" / "storyboard.schema.json").read_text())


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
            schema.validate({"type": "object", "propertyNames": {"pattern": "^a"}}, {})

    def test_pattern_properties_are_validated_and_exempt_from_additional(self):
        s = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"a": {"type": "integer"}},
            "patternProperties": {"^[$_]": {}, "^n_": {"type": "number"}},
        }
        self.assertEqual(schema.validate(s, {"a": 1, "_note": "free text", "$c": [1], "n_x": 2.5}), [])
        self.assertTrue(schema.validate(s, {"a": 1, "zz": 1}))  # neither declared nor matching a pattern
        self.assertTrue(schema.validate(s, {"n_x": "two"}))  # a matching key is validated against its pattern

    def test_prefix_items_not_and_if_then_else(self):
        pair = {"type": "array", "prefixItems": [{"type": "number"}, {"type": "string"}], "items": {"const": 0}}
        self.assertEqual(schema.validate(pair, [1, "a", 0, 0]), [])
        self.assertTrue(schema.validate(pair, ["a", "a"]))
        self.assertTrue(schema.validate(pair, [1, "a", 5]))  # items applies after the prefix
        self.assertTrue(schema.validate({"not": {"const": "camera"}}, "camera"))
        self.assertEqual(schema.validate({"not": {"const": "camera"}}, "fade"), [])
        cond = {
            "type": "object",
            "if": {"properties": {"kind": {"const": "text"}}, "required": ["kind"]},
            "then": {"required": ["text"]},
            "else": {"required": ["src"]},
        }
        self.assertEqual(schema.validate(cond, {"kind": "text", "text": "hi"}), [])
        self.assertTrue(schema.validate(cond, {"kind": "text"}))
        self.assertEqual(schema.validate(cond, {"kind": "sprite", "src": "a"}), [])
        self.assertTrue(schema.validate(cond, {"kind": "sprite"}))

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
        self.assertIsNone(f["account_ceiling_usd"])
        self.assertEqual(schema.validate(FILM, dict(f, account_ceiling_usd=7.5)), [])
        self.assertTrue(schema.validate(FILM, dict(f, account_ceiling_usd=-1)))

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


class StoryboardSchemaTest(TempDirTest):
    GOLDEN = SKILL_DIR / "examples" / "golden" / "src" / "storyboard.json"

    def test_shipped_storyboards_validate(self):
        for path in (self.GOLDEN, SKILL_DIR / "engine" / "web" / "film" / "storyboard.json"):
            with self.subTest(path.name):
                self.assertEqual(schema.validate(STORYBOARD, json.loads(path.read_text())), [])

    def test_scaffolded_starter_validates(self):
        film = new_film(self.tmp)
        self.assertEqual(schema.validate(STORYBOARD, json.loads((film / "src" / "storyboard.json").read_text())), [])

    def test_comment_keys_pass_and_mistakes_fail(self):
        sb = json.loads(self.GOLDEN.read_text())
        self.assertEqual(schema.validate(STORYBOARD, dict(sb, _note="comments are free", **{"$why": 1})), [])
        self.assertTrue(schema.validate(STORYBOARD, dict(sb, typo_field=1)))
        broken = json.loads(self.GOLDEN.read_text())
        el = next(e for sc in broken["scenes"] for e in sc.get("elements", []) if e.get("kind") == "text")
        el.pop("text")  # a text element needs its text (if/then)
        self.assertTrue(schema.validate(STORYBOARD, broken))

    def test_cli_validates_the_golden_storyboard(self):
        code, _, err = run_tool(
            schema, ["validate", str(SKILL_DIR / "references" / "storyboard.schema.json"), str(self.GOLDEN)]
        )
        self.assertEqual(code, 0, err)


class RubricSchemaTest(TempDirTest):
    def test_qa_check_outputs_validate(self):
        for path in (FIXTURES / "round-ship" / "technical.json", FIXTURES / "qa-check-iterate.json"):
            with self.subTest(path.name):
                doc = json.loads(path.read_text())
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
            [
                "validate",
                str(SKILL_DIR / "references" / "rubric.schema.json"),
                str(FIXTURES / "round-ship" / "technical.json"),
            ],
        )
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
