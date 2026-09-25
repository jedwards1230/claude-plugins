#!/usr/bin/env python3
"""Create a film project from the bundled engine, and keep web/film/config.json in sync with film.json.

  new <dir>      copy engine/ (web/, tools/, package.json) into <dir>, create src/ work/ out/ cache/,
                 write film.json (validated, defaults filled) and derive web/film/config.json from it.
                 --from-example <name> overlays examples/<name>/ (its config.json is kept as is).
  sync-config    regenerate the film.json-owned keys of web/film/config.json (title, subtitle, size,
                 fps, duration, captions, palette, fonts, notes, credits, disclosure) and the size,
                 fps and duration in src/storyboard.json meta; other config keys are kept.

film.json -> config.json: aspect 16:9 -> [1920, 1080], 9:16 -> [1080, 1920], 1:1 -> [1080, 1080];
fps 30; style.palette (list: first colour = accent, the list colours panels and ransom letters;
object: engine palette keys as is); style.fonts {display, body, hand, faces} -> {hand, print, ui,
faces}; disclosure {card, end_card, seconds, title, lines, note} -> config.disclosure (card false
blanks the page note and credits). notes and credits are copied only when film.json has them.
"""

import shutil
from pathlib import Path

from common import (
    ENGINE,
    EXAMPLES,
    add_film_arg,
    load_film,
    parser,
    read_json,
    run_main,
    script_lines,
    validate_film,
    write_json,
)
from providers.base import UsageError

SIZES = {"16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080]}
WORK_DIRS = ["research", "direction", "takes", "vo", "music", "sheets", "qa", "reviews", "critic"]
SKIP = {"node_modules", "__pycache__", ".DS_Store"}
# build output, provider cache and anything that may hold a secret or account details (preflight.json keeps
# the account's usage and limit); keep a key file outside the film directory anyway
GITIGNORE = "node_modules/\ncache/\nwork/frames/\nwork/export-frames/\nwork/preflight.json\n*.lock\n.env\n*.key\n"


def copy_tree(src, dst):
    n = 0
    for f in sorted(Path(src).rglob("*")):
        rel = f.relative_to(src)
        if any(part in SKIP for part in rel.parts) or f.is_dir():
            continue
        out = Path(dst) / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, out)
        n += 1
    return n


def font_stack(name):
    return name if "," in name else f'"{name.strip(chr(34))}", sans-serif'


def palette_cfg(p):
    if isinstance(p, dict):
        return p
    return {
        "accent": p[0],
        "panels": list(p),
        "ransom": list(p) + ["#FBF7EE"],
        "swatches": {f"c{i + 1}": c for i, c in enumerate(p)},
    }


def config_from_film(film, base):
    """base config.json + the keys film.json owns."""
    cfg = dict(base)
    cfg.update(
        title=film["title"],
        subtitle=film["subtitle"],
        size=SIZES[film["aspect"]],
        fps=30,
        duration=film["duration"],
        captions=film["captions"],
    )
    style = film["style"]
    if "palette" in style:
        cfg["palette"] = palette_cfg(style["palette"])
    if "fonts" in style:
        f, fonts = style["fonts"], dict(cfg.get("fonts") or {})
        hand = f.get("hand") or f.get("display")
        if hand:
            fonts["hand"] = font_stack(hand)
        if f.get("body"):
            fonts["print"] = fonts["ui"] = font_stack(f["body"])
        if "faces" in f:
            fonts["faces"] = f["faces"]
        cfg["fonts"] = fonts
    for k in ("notes", "credits"):
        if k in film:
            cfg[k] = film[k]
    d = film["disclosure"]
    disc = {
        "end_card": d["end_card"],
        "seconds": d["seconds"],
        "title": d["title"],
        "note": d["note"] if d["card"] else "",
    }
    if d["lines"]:
        disc["lines"] = d["lines"]
    if not d["card"]:
        credits = cfg.get("credits") or []
        if credits and "lines" not in disc:
            disc["lines"] = [c if isinstance(c, str) else f"{c['role']}: {c['name']}" for c in credits]
        cfg["credits"] = []
    cfg["disclosure"] = disc
    return cfg


def patch_storyboard_meta(film_dir, film):
    """Keep src/storyboard.json meta size/fps/duration in line with film.json; -> list of changes."""
    p = Path(film_dir) / "src" / "storyboard.json"
    if not p.exists():
        return []
    sb = read_json(p)
    meta = sb.setdefault("meta", {})
    want = {"size": SIZES[film["aspect"]], "fps": 30, "duration": film["duration"]}
    changes = [f"meta.{k} {meta.get(k)} -> {v}" for k, v in want.items() if meta.get(k) != v]
    if changes:
        meta.update(want)
        write_json(p, sb)
    return changes


def film_from_example(ex_dir):
    """A film.json for an example that ships none, mirroring its config so sync-config changes nothing visible."""
    cfg = read_json(ex_dir / "web" / "film" / "config.json", default={})
    sb = read_json(ex_dir / "src" / "storyboard.json", default={})
    size = cfg.get("size") or sb.get("meta", {}).get("size") or [1920, 1080]
    aspect = next((a for a, s in SIZES.items() if s == list(size)), None)
    if aspect is None:
        raise UsageError(f"example size {size} is not 16:9, 9:16 or 1:1")
    lines = script_lines(ex_dir)
    title = cfg.get("title") or sb.get("meta", {}).get("title") or ex_dir.name
    has_vo = any((ex_dir / "web" / "audio").glob("vo_*")) if (ex_dir / "web" / "audio").exists() else False
    music = sb.get("music") or {}
    return {
        "topic": title,
        "goal": cfg.get("subtitle") or title,
        "message": " ".join(ln["text"] for ln in lines) or title,
        "title": title,
        "subtitle": cfg.get("subtitle", ""),
        "duration": cfg.get("duration") or sb.get("meta", {}).get("duration", 90),
        "aspect": aspect,
        "captions": bool(cfg.get("captions", True)),
        "voice": {"mode": "audition" if has_vo else "none"},
        "music": {
            "mode": "synth" if music.get("synth") else ("file" if music.get("asset") else "none"),
            **({"file": music["asset"]} if music.get("asset") and not music.get("synth") else {}),
        },
        "art": {"mode": "generated" if (ex_dir / "web" / "img" / "manifest.json").exists() else "code"},
        "sources": [{"kind": "none"}],
        "budget_usd": 0,
        "disclosure": {"end_card": bool((cfg.get("disclosure") or {}).get("end_card", False))},
    }


def cmd_new(a):
    dst = Path(a.dir)
    if dst.exists() and any(dst.iterdir()) and not a.force:
        raise UsageError(f"{dst} is not empty (use --force to copy the engine over it; other files are kept)")
    ex_dir = None
    if a.from_example:
        ex_dir = EXAMPLES / a.from_example
        if not ex_dir.is_dir():
            names = ", ".join(sorted(p.name for p in EXAMPLES.iterdir() if p.is_dir()))
            raise UsageError(f"no example {a.from_example!r} (examples: {names})")
    if a.film_json:
        raw = read_json(a.film_json)
    elif ex_dir and (ex_dir / "film.json").exists():
        raw = read_json(ex_dir / "film.json")
    elif ex_dir:
        raw = film_from_example(ex_dir)
    elif a.topic and a.goal and a.message:
        raw = {"topic": a.topic, "goal": a.goal, "message": a.message}
    else:
        raise UsageError("film.json needs topic, goal and message: pass --film-json <path> or --topic/--goal/--message")
    if a.aspect is not None:
        raw["aspect"] = a.aspect
    if a.duration is not None:
        raw["duration"] = int(a.duration) if float(a.duration).is_integer() else a.duration
    film, errors = validate_film(raw)
    if errors:
        raise UsageError("film.json is invalid:\n  " + "\n  ".join(errors))

    dst.mkdir(parents=True, exist_ok=True)
    n = copy_tree(ENGINE, dst)
    if ex_dir:
        n += copy_tree(ex_dir, dst)
    for d in ["src", "out", "cache", "web/audio", "web/img"] + [f"work/{w}" for w in WORK_DIRS]:
        (dst / d).mkdir(parents=True, exist_ok=True)
    write_json(dst / "film.json", film)
    if not ex_dir:
        w, h = SIZES[film["aspect"]]
        starters = {
            "src/storyboard.json": {
                "version": 1,
                "meta": {"fps": 30, "size": [w, h], "duration": film["duration"], "seed": 1, "title": film["title"]},
                "layout": {"type": "stage"},
                "scenes": [],
            },
            "src/script.json": {"lines": []},
            "src/words.json": {},
        }
        for rel, obj in starters.items():
            if not (dst / rel).exists():
                write_json(dst / rel, obj)
    if not (dst / ".gitignore").exists():
        (dst / ".gitignore").write_text(GITIGNORE)
    cfg_path = dst / "web" / "film" / "config.json"
    if not ex_dir or a.film_json or a.aspect is not None or a.duration is not None:
        write_json(cfg_path, config_from_film(film, read_json(cfg_path, default={})))
        patch_storyboard_meta(dst, film)
    print(f"scaffold: {dst} ({n} files from the engine{' + examples/' + a.from_example if ex_dir else ''})")
    print(f"  film.json: {film['title']!r}, {film['aspect']}, {film['duration']} s, budget ${film['budget_usd']}")
    print(f"  next: npm install --prefix {dst}   then   python3 {Path(__file__).parent}/preflight.py --film {dst}")
    return 0


def cmd_sync(a):
    film = load_film(a.film)
    cfg_path = Path(a.film) / "web" / "film" / "config.json"
    before = read_json(cfg_path, default={})
    after = config_from_film(film, before)
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    write_json(cfg_path, after)
    meta = patch_storyboard_meta(a.film, film)
    print(f"sync-config: {cfg_path} ({', '.join(changed) if changed else 'no changes'})")
    for c in meta:
        print(f"  src/storyboard.json {c}  (run node tools/resolve.mjs again)")
    return 0


def main(argv=None):
    ap = parser("scaffold.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="create a film directory from the engine (and optionally an example)")
    n.add_argument("dir", help="film directory to create")
    n.add_argument("--from-example", metavar="NAME", help="overlay examples/NAME (e.g. golden)")
    n.add_argument("--film-json", metavar="PATH", help="film.json to validate and copy in")
    n.add_argument("--topic")
    n.add_argument("--goal")
    n.add_argument("--message")
    n.add_argument("--aspect", choices=sorted(SIZES))
    n.add_argument("--duration", type=float)
    n.add_argument("--force", action="store_true", help="copy over a non-empty directory (other files are kept)")
    s = sub.add_parser("sync-config", help="regenerate web/film/config.json from film.json")
    add_film_arg(s)
    a = ap.parse_args(argv)
    return {"new": cmd_new, "sync-config": cmd_sync}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
