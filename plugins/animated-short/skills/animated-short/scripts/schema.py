#!/usr/bin/env python3
"""Stdlib-only JSON Schema validator for the subset the animated-short schemas use.

Supported keywords: type, required, properties, additionalProperties, items, enum, const,
minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern, minItems,
maxItems, $ref (to #/$defs/... or #/definitions/...), oneOf, anyOf, allOf. Annotations
(title, description, default, examples, $schema, $id, $comment, deprecated) are ignored.
Any other keyword raises SchemaError, so a schema can never silently outgrow this validator.

    python3 schema.py validate <schema.json> <doc.json> [--defaults]
    python3 schema.py defaults <schema.json> <doc.json>

Importable: validate(schema, doc) -> [error strings]; apply_defaults(schema, doc) -> new doc.
"""

import argparse
import copy
import json
import re
import sys

ANNOTATIONS = {"title", "description", "default", "examples", "$schema", "$id", "$comment", "deprecated"}
VALIDATION = {
    "type",
    "required",
    "properties",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "$ref",
    "oneOf",
    "anyOf",
    "allOf",
    "$defs",
    "definitions",
}


class SchemaError(Exception):
    """The schema itself uses something this validator does not support."""


def _type_ok(value, t):
    if t == "null":
        return value is None
    if t == "boolean":
        return isinstance(value, bool)
    if t == "integer":
        return (
            isinstance(value, int) and not isinstance(value, bool) or (isinstance(value, float) and value.is_integer())
        )
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "string":
        return isinstance(value, str)
    if t == "array":
        return isinstance(value, list)
    if t == "object":
        return isinstance(value, dict)
    raise SchemaError(f"unknown type {t!r}")


def _resolve(root, ref):
    if not ref.startswith("#/"):
        raise SchemaError(f"only local $ref is supported, got {ref!r}")
    node = root
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise SchemaError(f"$ref {ref!r} does not resolve")
        node = node[part]
    return node


def _fmt(path):
    return path or "$"


def _check(root, schema, value, path, errors):
    if schema is True or schema == {}:
        return
    if schema is False:
        errors.append(f"{_fmt(path)}: no value is allowed here")
        return
    unknown = set(schema) - ANNOTATIONS - VALIDATION
    if unknown:
        raise SchemaError(f"unsupported keyword(s) {sorted(unknown)} at schema for {_fmt(path)}")
    if "$ref" in schema:
        _check(root, _resolve(root, schema["$ref"]), value, path, errors)
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            errors.append(f"{_fmt(path)}: expected {' or '.join(types)}, got {type(value).__name__}")
            return
    if "const" in schema and value != schema["const"]:
        errors.append(f"{_fmt(path)}: must be {json.dumps(schema['const'])}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{_fmt(path)}: {json.dumps(value)} is not one of {json.dumps(schema['enum'])}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{_fmt(path)}: {value} is below the minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{_fmt(path)}: {value} is above the maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append(f"{_fmt(path)}: {value} must be greater than {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            errors.append(f"{_fmt(path)}: {value} must be less than {schema['exclusiveMaximum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{_fmt(path)}: shorter than {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{_fmt(path)}: longer than {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{_fmt(path)}: {json.dumps(value)} does not match {schema['pattern']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{_fmt(path)}: needs at least {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{_fmt(path)}: allows at most {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                _check(root, schema["items"], item, f"{path}[{i}]", errors)
    if isinstance(value, dict):
        for k in schema.get("required", []):
            if k not in value:
                errors.append(f"{_fmt(path)}: missing required property {k!r}")
        props = schema.get("properties", {})
        for k, v in value.items():
            sub = f"{path}.{k}" if path else k
            if k in props:
                _check(root, props[k], v, sub, errors)
            elif "additionalProperties" in schema:
                ap = schema["additionalProperties"]
                if ap is False:
                    errors.append(f"{_fmt(path)}: unknown property {k!r}")
                elif isinstance(ap, dict):
                    _check(root, ap, v, sub, errors)
    for key in ("anyOf", "oneOf"):
        if key in schema:
            passing, first = 0, None
            for option in schema[key]:
                errs = []
                _check(root, option, value, path, errs)
                if not errs:
                    passing += 1
                elif first is None:
                    first = errs
            if key == "anyOf" and not passing:
                errors.append(f"{_fmt(path)}: matches none of the allowed shapes ({'; '.join(first or [])})")
            if key == "oneOf" and passing != 1:
                errors.append(f"{_fmt(path)}: must match exactly one allowed shape, matched {passing}")
    for option in schema.get("allOf", []):
        _check(root, option, value, path, errors)


def validate(schema, doc):
    """Return a list of human-readable errors (empty when doc is valid)."""
    errors = []
    _check(schema, schema, doc, "", errors)
    return errors


def _deref(root, schema):
    """A $ref'd schema merged with its local keywords (a local default wins)."""
    if isinstance(schema, dict) and "$ref" in schema:
        target = _deref(root, _resolve(root, schema["$ref"]))
        return {**target, **{k: v for k, v in schema.items() if k != "$ref"}}
    return schema


def _fill(root, schema, value):
    schema = _deref(root, schema)
    if not isinstance(schema, dict):
        return value
    if isinstance(value, dict):
        for k, sub in schema.get("properties", {}).items():
            sub = _deref(root, sub)
            if k not in value and isinstance(sub, dict) and "default" in sub:
                value[k] = copy.deepcopy(sub["default"])
            if k in value:
                value[k] = _fill(root, sub, value[k])
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        value = [_fill(root, schema["items"], v) for v in value]
    return value


def apply_defaults(schema, doc):
    """Return a deep copy of doc with every missing property that has a default filled in,
    recursively (a default object is itself filled)."""
    return _fill(schema, schema, copy.deepcopy(doc))


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate JSON against the animated-short schemas (stdlib only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="validate a document; exit 1 with the errors if invalid")
    v.add_argument("schema")
    v.add_argument("doc")
    v.add_argument("--defaults", action="store_true", help="apply defaults before validating")
    d = sub.add_parser("defaults", help="print the document with defaults applied")
    d.add_argument("schema")
    d.add_argument("doc")
    a = ap.parse_args(argv)
    try:
        schema, doc = load(a.schema), load(a.doc)
    except (OSError, json.JSONDecodeError) as e:
        print(f"schema: {e}", file=sys.stderr)
        return 2
    try:
        if a.cmd == "defaults" or a.defaults:
            doc = apply_defaults(schema, doc)
        if a.cmd == "defaults":
            print(json.dumps(doc, indent=1))
            return 0
        errors = validate(schema, doc)
    except SchemaError as e:
        print(f"schema: unsupported schema: {e}", file=sys.stderr)
        return 2
    for e in errors:
        print(e)
    print(f"{a.doc}: {'valid' if not errors else f'{len(errors)} error(s)'}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
