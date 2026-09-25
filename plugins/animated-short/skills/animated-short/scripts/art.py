#!/usr/bin/env python3
"""Artwork: sticker sheets from an image model, cut out into named stickers for the engine.

sheet --name N --prompt-file P [--refs a.png,b.png] [--likeness photo.jpg] [--draft]
      one sticker sheet on flat #8C8C8C with white die-cut borders -> work/sheets/<N>_0.png.
      Final tier = the 4K model; --draft = the cheap 1K model (animatic). The image model is pinned
      per tier on first use (sticky): later sheets match it.
cutout <sheet.png> --names a,b,c
      key out the flat grey (soft alpha, white-border decontamination), split connected stickers
      (row-major order), save web/img/<name>.webp and merge web/img/manifest.json; writes a labelled
      contact sheet to work/qa/cutout-<sheet>.jpg. numpy + pillow only.
contact [--out F]
      contact sheet of every sticker in web/img for review.
"""

from pathlib import Path

from audiolib import need
from common import add_film_arg, add_provider_args, context, load_film, parser, read_json, run_main, usd, write_json
from providers import run_role
from providers.base import EXIT_GATE, UsageError

SHEET_FORMAT = (
    "FORMAT: a sticker sheet. Every item is a separate die-cut sticker with a thick, clean, solid WHITE border all "
    "the way around its silhouette. Lay the stickers out in a loose grid with LOTS of empty space between them; "
    "stickers must never touch or overlap each other. The background is ONE perfectly flat, uniform, solid medium "
    "grey (#8C8C8C) with no texture, no gradient, no vignette. No drop shadows, no cast shadows, no text, no "
    "letters, no numbers, no logos, no watermarks, no frames. Front-facing, flat even lighting."
)
STYLE_REFS = (
    "Match the illustration style, line quality, palette and white sticker borders of the reference "
    "sheet(s) exactly, but draw ONLY the new items listed above."
)
LIKENESS = (
    "The photo(s) show real subjects. Take ONLY their colours and markings from the photos; draw them in "
    "this sheet's illustration style. Do not copy the photo's background, pose, lighting or framing."
)


def style_block(film):
    s = film["style"]
    parts = [
        f"STYLE: {s['preset']} illustration, {s['texture']}; hand-made, cut-paper look, confident slightly "
        f"wobbly ink outlines; tone: {film['tone']}."
    ]
    if isinstance(s.get("palette"), list):
        parts.append("Limited palette: " + ", ".join(s["palette"]) + ".")
    if s.get("motif"):
        parts.append(f"Recurring motif: {s['motif']}.")
    if s.get("banned_patterns"):
        parts.append("Avoid: " + "; ".join(s["banned_patterns"]) + ".")
    return " ".join(parts)


def cmd_sheet(a):
    film = load_film(a.film)
    ctx = context(a, film)
    items = Path(a.prompt_file).read_text(encoding="utf-8").strip()
    refs = [Path(p) for p in a.refs.split(",")] if a.refs else []
    likeness = [Path(p) for p in a.likeness.split(",")] if a.likeness else []
    for p in refs + likeness:
        if not p.exists():
            raise UsageError(f"{p}: no such file")
    prompt = "\n\n".join(
        filter(
            None,
            [
                None if a.no_style else style_block(film),
                SHEET_FORMAT,
                "STICKERS ON THIS SHEET (draw each exactly once):\n" + items,
                STYLE_REFS if refs else None,
                LIKENESS if likeness else None,
            ],
        )
    )
    tier = "draft" if a.draft else "final"
    res = run_role(
        ctx,
        "image",
        {
            "prompt": prompt,
            "refs": refs + likeness,
            "aspect": a.aspect,
            "variant": a.variant,
            "out_dir": Path(a.film) / "work" / "sheets",
            "stem": a.name,
        },
        stage="animatic" if a.draft else "assets",  # the quote.py stage this spend belongs to
        tier=tier,
        sticky=True,
        model=a.model,
    )
    meta = {
        "name": a.name,
        "tier": tier,
        "model": res.candidate["model"],
        "prompt": prompt,
        "refs": [str(p) for p in refs],
        "likeness": [str(p) for p in likeness],
        "files": [str(f) for f in res.files],
        "usd": res.usd,
        "basis": res.basis,
    }
    write_json(Path(a.film) / "work" / "sheets" / f"{a.name}.json", meta)
    cost = "cached" if res.basis == "cache" else (usd(res.usd) if res.usd is not None else "estimated")
    for f in res.files:
        print(f"sheet: {f}  {res.candidate['model']} ({tier})  {cost}")
    return 0


# ---------------------------------------------------------------- cutout (numpy + pillow)
def label(mask):
    """8-connected components of a boolean mask by row runs + union-find -> (labels int32, count)."""
    np = need("numpy", "cutout")
    H, W = mask.shape
    parent = []

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    rows, prev = [], []
    padded = np.zeros((H, W + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    d = np.diff(padded, axis=1)
    for y in range(H):
        starts, ends = np.nonzero(d[y] == 1)[0], np.nonzero(d[y] == -1)[0]
        cur, j = [], 0
        for s, e in zip(starts.tolist(), ends.tolist(), strict=True):
            rid = len(parent)
            parent.append(rid)
            while j < len(prev) and prev[j][1] < s:
                j += 1
            k = j
            while k < len(prev) and prev[k][0] <= e:
                ra, rb = find(rid), find(prev[k][2])
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
                k += 1
            cur.append((s, e, rid))
        rows.append(cur)
        prev = cur
    labels = np.zeros((H, W), dtype=np.int32)
    compact = {}
    for y, cur in enumerate(rows):
        for s, e, rid in cur:
            root = find(rid)
            labels[y, s:e] = compact.setdefault(root, len(compact) + 1)
    return labels, len(compact)


def _shift_stack(m, cross):
    np = need("numpy", "cutout")
    p = np.pad(m, 1, mode="edge")
    views = [p[1:-1, 1:-1], p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]]
    if not cross:
        views += [p[:-2, :-2], p[:-2, 2:], p[2:, :-2], p[2:, 2:]]
    return views


def dilate(m, it=1, cross=True):
    np = need("numpy", "cutout")
    for _ in range(it):
        m = np.logical_or.reduce(_shift_stack(m, cross))
    return m


def erode(m, it=1, cross=True):
    np = need("numpy", "cutout")
    for _ in range(it):
        m = np.logical_and.reduce(_shift_stack(m, cross))
    return m


def grey_erode3(a):
    np = need("numpy", "cutout")
    return np.minimum.reduce(_shift_stack(a, cross=False))


def border_labels(labels):
    np = need("numpy", "cutout")
    return set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}


def cut_sheet(sheet, min_area=0.002, max_dim=1400):
    """-> list of (PIL RGBA image, info) in row-major order."""
    np = need("numpy", "cutout")
    need("PIL", "cutout (package: pillow)")
    from PIL import Image

    im = np.asarray(Image.open(sheet).convert("RGB")).astype(np.int32)
    H, W, _ = im.shape
    border = np.concatenate(
        [im[:8].reshape(-1, 3), im[-8:].reshape(-1, 3), im[:, :8].reshape(-1, 3), im[:, -8:].reshape(-1, 3)]
    )
    bg = np.median(border, 0)
    dist = np.sqrt(((im - bg) ** 2).sum(-1).astype(np.float32))
    near = dist < 38
    lab, _ = label(near)
    bgmask = np.isin(lab, list(border_labels(lab)))
    fg = erode(~bgmask, 2)
    fg = dilate(fg, 2)
    holes_lab, _ = label(~fg)
    fg = fg | (np.isin(holes_lab, list(set(np.unique(holes_lab)) - {0} - border_labels(holes_lab))))
    comps, n = label(fg)
    counts = np.bincount(comps.ravel())
    found = []
    for i in range(1, n + 1):
        if counts[i] < min_area * H * W:
            continue
        ys, xs = np.nonzero(comps == i)
        found.append((i, ys.min(), ys.max() + 1, xs.min(), xs.max() + 1))
    if not found:
        return []
    heights = sorted(f[2] - f[1] for f in found)
    tol = heights[len(heights) // 2] / 2
    found.sort(key=lambda f: (f[1] + f[2]) / 2)
    rows, row = [], []
    for f in found:
        cy = (f[1] + f[2]) / 2
        if row and abs(cy - (row[0][1] + row[0][2]) / 2) > tol:
            rows.append(row)
            row = []
        row.append(f)
    rows.append(row)
    ordered = [f for r in rows for f in sorted(r, key=lambda f: f[3])]
    ramp = np.clip((dist - 22) / (70 - 22), 0, 1)
    out = []
    for idx, y0, y1, x0, x1 in ordered:
        pad = 12
        y0, y1, x0, x1 = max(0, y0 - pad), min(H, y1 + pad), max(0, x0 - pad), min(W, x1 + pad)
        mask = comps[y0:y1, x0:x1] == idx
        grown = dilate(mask, 3)
        alpha = np.where(mask, 1.0, np.where(grown, ramp[y0:y1, x0:x1], 0.0))
        alpha = np.minimum(alpha, grey_erode3(alpha) * 0.5 + alpha * 0.5)
        rgb = im[y0:y1, x0:x1].astype(np.float32)
        edge = alpha < 0.999
        rgb[edge] = np.maximum(rgb[edge], 245)
        rgba = np.dstack([rgb, alpha * 255]).clip(0, 255).astype(np.uint8)
        img = Image.fromarray(rgba, "RGBA")
        s = max_dim / max(img.size)
        if s < 1:
            img = img.resize((round(img.size[0] * s), round(img.size[1] * s)), Image.LANCZOS)
        out.append(
            (
                img,
                {
                    "cx": round((x0 + x1) / 2 / W, 4),
                    "cy": round((y0 + y1) / 2 / H, 4),
                    "w": img.size[0],
                    "h": img.size[1],
                },
            )
        )
    return out


def contact_sheet(items, out, cols=6, cell=300):
    """items: [(PIL image, label)] -> labelled JPEG on a dark ground."""
    need("PIL", "contact sheets (package: pillow)")
    from PIL import Image, ImageDraw

    rows = max(1, (len(items) + cols - 1) // cols)
    sheet = Image.new("RGB", (cols * cell, rows * cell), (60, 70, 90))
    d = ImageDraw.Draw(sheet)
    for i, (im, name) in enumerate(items):
        t = im.copy()
        t.thumbnail((cell - 30, cell - 40))
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(t, (x + 15, y + 10), t if t.mode == "RGBA" else None)
        d.text((x + 8, y + cell - 24), name, fill=(255, 255, 0))
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=85)
    return out


def cmd_cutout(a):
    film_dir = Path(a.film)
    load_film(film_dir)
    names = [n.strip() for n in a.names.split(",") if n.strip()]
    if len(set(names)) != len(names):
        raise UsageError("--names has duplicates")
    stickers = cut_sheet(a.sheet, a.min_area, a.max_dim)
    if len(stickers) != len(names) and not (a.allow_extra and len(stickers) > len(names)):
        print(
            f"cutout: found {len(stickers)} stickers in row-major order but got {len(names)} names; "
            f"positions (cx, cy): {[(s[1]['cx'], s[1]['cy']) for s in stickers]}"
        )
        contact_sheet(
            [(im, f"#{i}") for i, (im, _) in enumerate(stickers)],
            film_dir / "work" / "qa" / f"cutout-{Path(a.sheet).stem}.jpg",
        )
        return EXIT_GATE
    img_dir = film_dir / "web" / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest = read_json(img_dir / "manifest.json", default={})
    base = Path(a.sheet).stem
    labelled = []
    for i, (im, info) in enumerate(stickers):
        name = names[i] if i < len(names) else f"{base}_{i:02d}"
        im.save(img_dir / f"{name}.webp", "WEBP", quality=90, method=6)
        manifest[name] = [info["w"], info["h"]]
        labelled.append((im, name))
        print(f"  {name}: {info['w']}x{info['h']}")
    write_json(img_dir / "manifest.json", manifest)
    cs = contact_sheet(labelled, film_dir / "work" / "qa" / f"cutout-{base}.jpg")
    print(f"cutout: {len(stickers)} stickers -> web/img/ (manifest updated); contact sheet {cs}")
    return 0


def cmd_contact(a):
    need("PIL", "contact sheets (package: pillow)")
    from PIL import Image

    film_dir = Path(a.film)
    img_dir = film_dir / "web" / "img"
    manifest = read_json(img_dir / "manifest.json", default={})
    items = []
    for name, v in sorted(manifest.items()):
        f = img_dir / ((v.get("file") if isinstance(v, dict) else None) or f"{name}.webp")
        if f.exists():
            items.append((Image.open(f).convert("RGBA"), name))
    if not items:
        raise UsageError("no stickers in web/img/manifest.json")
    out = Path(a.out) if a.out else film_dir / "work" / "qa" / "stickers.jpg"
    contact_sheet(items, out, cols=a.cols)
    print(f"contact: {len(items)} stickers -> {out}")
    return 0


def main(argv=None):
    ap = parser("art.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sheet", help="generate one sticker sheet")
    add_film_arg(s)
    add_provider_args(s)
    s.add_argument("--name", required=True, help="sheet name (file stem)")
    s.add_argument("--prompt-file", required=True, help="the stickers to draw, one per line, with any notes")
    s.add_argument("--refs", help="comma-separated earlier sheets to match (style references)")
    s.add_argument("--likeness", help="comma-separated photo crops of real subjects (colours and markings only)")
    s.add_argument("--draft", action="store_true", help="cheap 1K draft tier for the animatic")
    s.add_argument("--aspect", default="1:1", help="sheet aspect ratio (default 1:1)")
    s.add_argument("--variant", type=int, default=0, help="another try with the same prompt (new cache key)")
    s.add_argument("--no-style", action="store_true", help="the prompt file carries the whole style; skip the film's")
    s.add_argument("--model", help="image model to try first (it is pinned after the first sheet)")
    c = sub.add_parser("cutout", help="cut a sheet into named stickers")
    add_film_arg(c)
    c.add_argument("sheet")
    c.add_argument(
        "--names", required=True, help="comma-separated sticker names, row-major (left to right, top to bottom)"
    )
    c.add_argument("--min-area", type=float, default=0.002, help="smallest sticker as a fraction of the sheet")
    c.add_argument("--max-dim", type=int, default=1400, help="longest side of a saved sticker")
    c.add_argument("--allow-extra", action="store_true", help="name extra stickers <sheet>_<k> instead of failing")
    k = sub.add_parser("contact", help="contact sheet of all stickers")
    add_film_arg(k)
    k.add_argument("--out")
    k.add_argument("--cols", type=int, default=6)
    a = ap.parse_args(argv)
    return {"sheet": cmd_sheet, "cutout": cmd_cutout, "contact": cmd_contact}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
