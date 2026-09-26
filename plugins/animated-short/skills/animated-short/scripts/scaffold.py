#!/usr/bin/env python3
"""Create a film project from the bundled engine; keep web/film/config.json in sync with film.json and the
film's engine copy in sync with the plugin.

  new <dir>      copy engine/ (web/, tools/, package.json) into <dir>, create src/ work/ out/ cache/,
                 write film.json (validated, defaults filled) and derive web/film/config.json from it.
                 <dir> must not exist, be empty, or hold only the film.json passed with --film-json
                 (write <dir>/film.json first, then scaffold it in place).
                 --from-example <name> overlays examples/<name>/ (its config.json is kept as is).
  sync-config    regenerate the film.json-owned keys of web/film/config.json (title, subtitle, size,
                 fps, duration, captions, palette, fonts, notes, credits, disclosure) and the size,
                 fps and duration in src/storyboard.json meta; other config keys are kept.
  sync-engine    bring the film's copy of the engine up to date after a plugin update: web/index.html,
                 web/js/*.js and tools/* that differ from engine/ are backed up to
                 work/engine-backup-<UTC time>/ and replaced (missing ones are added; film-only files
                 are kept), and engine/package.json's dependencies are merged into the film's
                 package.json. Never touches web/film/, web/img/, web/audio/, web/fonts/, src/, work/
                 (except the backup) or film.json. --dry-run lists the changes and writes nothing.
                 Afterwards: npm install when the dependencies changed, resolve --strict, and compare
                 stills rendered before and after (phases.md, "Updating a film's engine").

film.json -> config.json: aspect 16:9 -> [1920, 1080], 9:16 -> [1080, 1920], 1:1 -> [1080, 1080];
fps 30; style.palette (list: first colour = accent, the list colours panels and ransom letters;
object: engine palette keys as is); style.fonts {display, body, hand, faces} -> {hand, print, ui,
faces}; disclosure {card, end_card, seconds, title, lines, note} -> config.disclosure (card false
blanks the page note and credits). notes and credits are copied only when film.json has them.
"""

import datetime
import difflib
import json
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
    present = sorted(dst.iterdir()) if dst.is_dir() else []
    own_json = a.film_json and [p.resolve() for p in present] == [Path(a.film_json).resolve()]
    if present and not (a.force or own_json):
        raise UsageError(
            f"{dst} is not empty (a directory holding only the film.json given with --film-json is fine; "
            "use --force to copy the engine over other files, which are kept)"
        )
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


# the film's own content: sync-engine never writes there (work/ only for its backup)
FILM_OWNED = ("web/film/", "web/img/", "web/audio/", "web/fonts/", "src/", "work/", "out/", "cache/", "film.json")


def engine_files():
    """Relative paths of the engine code a film carries a copy of (package.json is merged instead)."""
    out = []
    for f in sorted(ENGINE.rglob("*")):
        rel = f.relative_to(ENGINE)
        if f.is_file() and not any(p in SKIP for p in rel.parts):
            if rel.as_posix() != "package.json" and not rel.as_posix().startswith(FILM_OWNED):
                out.append(rel.as_posix())
    return out


def line_counts(old, new):
    """(lines added, lines removed) from old to new text."""
    diff = difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0)
    plus = minus = 0
    for line in diff:
        if line.startswith("+") and not line.startswith("+++"):
            plus += 1
        elif line.startswith("-") and not line.startswith("---"):
            minus += 1
    return plus, minus


def merged_package(film_pkg, engine_pkg):
    """The film's package.json with the engine's dependencies merged in -> (package, changes)."""
    deps = dict(film_pkg.get("dependencies") or {})
    changes = []
    for name, version in (engine_pkg.get("dependencies") or {}).items():
        if deps.get(name) != version:
            changes.append(f"{name} {deps.get(name, '(none)')} -> {version}")
            deps[name] = version
    return dict(film_pkg, dependencies=deps), changes


def cmd_sync_engine(a):
    film_dir = Path(a.film)
    load_film(film_dir)  # a film directory with a valid film.json
    files, changed, added = engine_files(), [], []
    for rel in files:
        dst = film_dir / rel
        if not dst.exists():
            added.append(rel)
        elif dst.read_bytes() != (ENGINE / rel).read_bytes():
            changed.append(rel)
    ours = set(files)
    film_only = sorted(
        f.relative_to(film_dir).as_posix()
        for d in ("web/js", "tools")
        if (film_dir / d).is_dir()
        for f in (film_dir / d).rglob("*")
        if f.is_file() and f.relative_to(film_dir).as_posix() not in ours
    )
    engine_pkg = read_json(ENGINE / "package.json")
    pkg_path = film_dir / "package.json"
    film_pkg = read_json(pkg_path) if pkg_path.exists() else None
    base_pkg = film_pkg if film_pkg is not None else {k: v for k, v in engine_pkg.items() if k != "dependencies"}
    pkg, dep_changes = merged_package(base_pkg, engine_pkg)

    print(f"sync-engine: {film_dir} from {ENGINE}")
    for rel in changed:
        plus, minus = line_counts(
            (film_dir / rel).read_text(encoding="utf-8", errors="replace"),
            (ENGINE / rel).read_text(encoding="utf-8", errors="replace"),
        )
        print(f"  changed  {rel} (+{plus} -{minus} lines)")
    for rel in added:
        print(f"  new      {rel}")
    for rel in film_only:
        print(f"  kept     {rel} (the film's own file; not in the engine)")
    for c in dep_changes:
        print(f"  package.json dependency {c}")
    if not (changed or added or dep_changes):
        print("  the film's engine is up to date")
        return 0
    if a.dry_run:
        print("  dry run: nothing written")
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = film_dir / "work" / f"engine-backup-{stamp}"
    saved = changed + (["package.json"] if dep_changes and film_pkg is not None else [])
    for rel in saved:
        (backup / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(film_dir / rel, backup / rel)
    for rel in changed + added:
        (film_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ENGINE / rel, film_dir / rel)
    if dep_changes:
        pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")
    if saved:
        print(f"  backup: {backup.relative_to(film_dir)}/ ({len(saved)} files as they were)")
    steps = ([f"npm install --prefix {film_dir}"] if dep_changes else []) + [
        f"node {film_dir}/tools/resolve.mjs --film {film_dir} --strict",
        "render the same stills as before the sync and compare them (a change nobody wanted: restore the file "
        "from the backup, or adapt the shot)",
    ]
    print("  next: " + "; then ".join(steps))
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
    e = sub.add_parser("sync-engine", help="update the film's engine copy (web/js, index.html, tools, dependencies)")
    add_film_arg(e)
    e.add_argument("--dry-run", action="store_true", help="list what would change; write nothing")
    a = ap.parse_args(argv)
    return {"new": cmd_new, "sync-config": cmd_sync, "sync-engine": cmd_sync_engine}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
