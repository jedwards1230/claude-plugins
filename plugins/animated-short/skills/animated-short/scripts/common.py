"""Shared plumbing for the animated-short tools: paths, film.json loading, JSON I/O, CLI helpers.

Every tool is `python3 scripts/<tool>.py <subcommand> --film <dir> [...]` and exits
0 ok | 1 gate or validation failure | 2 usage or environment error | 3 budget refusal |
4 provider unavailable after fallbacks.
"""

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

import schema
from providers import Context
from providers.base import ToolError, UsageError

SCRIPTS = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS.parent
REFS = SKILL_DIR / "references"
ENGINE = SKILL_DIR / "engine"
EXAMPLES = SKILL_DIR / "examples"


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def read_json(path, default=None):
    p = Path(path)
    if not p.exists():
        if default is not None:
            return default
        raise UsageError(f"{p}: file not found")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise UsageError(f"{p}: invalid JSON ({e})") from None


def write_json(path, obj, ascii_only=True):
    """Atomic write, one-space indent, ASCII-only by default (the engine reads these files)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=ascii_only) + "\n", encoding="utf-8")
    os.replace(tmp, p)
    return p


def load_schema(name):
    return read_json(REFS / name)


def validate_film(raw):
    """-> (film with defaults, errors)."""
    sch = load_schema("film.schema.json")
    errors = schema.validate(sch, raw)
    film = schema.apply_defaults(sch, raw) if not errors else raw
    if not errors:
        film.setdefault("title", film["topic"])
        if film["voice"]["mode"] == "named" and not film["voice"].get("name"):
            errors.append("voice.name: required when voice.mode is named")
        if film["music"]["mode"] == "file" and not film["music"].get("file"):
            errors.append("music.file: required when music.mode is file")
    return film, errors


def load_film(film_dir, required=True):
    """film.json with defaults applied; UsageError (exit 2) listing every schema error."""
    p = Path(film_dir) / "film.json"
    if not p.exists():
        if not required:
            return None
        raise UsageError(f"{p} not found: run scripts/scaffold.py new <dir> first")
    film, errors = validate_film(read_json(p))
    if errors:
        raise UsageError(f"{p} is invalid:\n  " + "\n  ".join(errors))
    return film


def add_film_arg(p, required=True):
    p.add_argument("--film", required=required, help="film directory (holds film.json)")


def add_provider_args(p):
    p.add_argument("--key-file", help="file with OPENROUTER_API_KEY=... (or a bare key); default: the environment")
    p.add_argument(
        "--account-ceiling",
        type=float,
        help="refuse paid calls when the account's reported usage would pass this many USD "
        "(default: env ANIMATED_SHORT_ACCOUNT_CEILING)",
    )
    p.add_argument("--no-cache", action="store_true", help="ignore the provider cache (still writes it)")


def context(args, film=None):
    film = film or load_film(args.film)
    return Context(
        args.film,
        film,
        key_file=getattr(args, "key_file", None),
        account_ceiling=getattr(args, "account_ceiling", None),
        use_cache=not getattr(args, "no_cache", False),
    )


def run_main(fn, argv=None):
    """Run a tool's main(); map ToolError to its exit code with a one-line message."""
    name = Path(sys.argv[0]).stem
    try:
        code = fn(argv)
    except ToolError as e:
        print(f"{name}: {e}", file=sys.stderr)
        code = e.exit_code
    except KeyboardInterrupt:
        code = 130
    sys.exit(code or 0)


def parser(prog, description):
    return argparse.ArgumentParser(
        prog=prog, description=description, formatter_class=argparse.RawDescriptionHelpFormatter
    )


# ---------------------------------------------------------------- script text
def script_lines(film_dir):
    """src/script.json -> [{id, text, tts?, reads?}] ({lines: [...]} or a bare list)."""
    raw = read_json(Path(film_dir) / "src" / "script.json", default={"lines": []})
    lines = raw.get("lines", []) if isinstance(raw, dict) else raw
    bad = [i for i, ln in enumerate(lines) if not isinstance(ln, dict) or not ln.get("id") or "text" not in ln]
    if bad:
        raise UsageError(f"src/script.json: lines {bad} need an id and text")
    return lines


def respell(text, pronunciations):
    """Apply {word: respelling} with whole-word, case-insensitive matching."""
    for word, spoken in (pronunciations or {}).items():
        text = re.sub(r"(?<![\w'])" + re.escape(word) + r"(?![\w'])", spoken, text, flags=re.I)
    return text


def tts_text(line, pronunciations):
    return respell(line.get("tts") or line["text"], pronunciations)


RIGHT_QUOTE, DASHES = chr(0x2019), chr(0x2013) + chr(0x2014)


def norm_word(w):
    return re.sub(r"[^a-z0-9']", "", w.lower().replace(RIGHT_QUOTE, "'")).strip("'")


def norm_words(text):
    """Words of a sentence, lower-cased, punctuation stripped; dashes split words."""
    return [n for n in (norm_word(w) for w in re.split(r"[\s" + DASHES + r"-]+", str(text))) if n]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-") or "x"


def usd(x):
    return f"${x:,.4f}" if x < 1 else f"${x:,.2f}"
