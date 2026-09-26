#!/usr/bin/env python3
"""Artwork: sticker sheets from an image model, cut out into named stickers for the engine.

sheet --name N --prompt-file P [--refs a.png,b.png] [--likeness photo.jpg] [--draft]
      one sticker sheet on flat #8C8C8C with white die-cut borders -> work/sheets/<N>_0.png.
      Final tier = the 4K model; --draft = the cheap 1K model (animatic). The image model is pinned
      per tier on first use (sticky): later sheets match it.
cutout <sheet.png> --names a,b,c [--skip i,j] [--strip-border] [--defringe] [--anchors "a=0.5,0.9;b=..."]
      flat-field the grey ground (a large-cell estimate, so uneven lighting, a lighter band or a
      gradient keys cleanly), key it out together with grey cast shadows (soft alpha, white-border
      decontamination), drop regions touching the sheet edge, split the stickers (row-major order),
      save web/img/<name>.webp and merge web/img/manifest.json; writes a labelled contact sheet to
      work/qa/cutout-<sheet>.jpg. --skip drops regions by their index (#i on that contact sheet);
      --strip-border removes the white die-cut border once the alpha exists; --defringe clears grey
      edge pixels and un-mixes the ground colour from semi-transparent ones; --anchors stores each
      sticker's pivot (fractions of its width and height) in the manifest. numpy + pillow only.
contact [--out F]
      contact sheet of every sticker in web/img for review.
"""

import re
from pathlib import Path

from audiolib import need
from common import add_film_arg, add_provider_args, context, load_film, parser, read_json, run_main, usd, write_json
from providers import run_role
from providers.base import EXIT_GATE, UsageError

SHEET_FORMAT = (
    "FORMAT: a flat digital sticker sheet, like a flat scan, NOT a photo: no table, no desk, no surface, no "
    "perspective, no shadows, evenly lit. Every item is a separate die-cut sticker with a thick, clean, solid WHITE "
    "border all the way around its silhouette. Lay the stickers out in a loose grid with LOTS of empty space between "
    "them and around the sheet's edges; stickers must never touch or overlap each other or the edge. The background "
    "is ONE perfectly flat, uniform, solid medium grey (#8C8C8C) with no texture, no gradient, no vignette, no "
    "lighter band. No drop shadows, no cast shadows, no text, no letters, no numbers, no logos, no watermarks, no "
    "frames. Front-facing, flat even lighting."
)
STYLE_REFS = (
    "Match the illustration style, line quality, palette and white sticker borders of the reference "
    "sheet(s) exactly, but draw ONLY the new items listed above."
)
LIKENESS = (
    "The photo(s) show real subjects. Take ONLY their colours and markings from the photos; draw them in "
    "this sheet's illustration style. Do not copy the photo's background, pose, lighting or framing."
)


PALETTE_KEYS = ("accent", "ink", "paper")  # engine palette keys that colour stickers (grounds do not)
PALETTE_MAX = 12
COLOUR = re.compile(r"^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$")


def palette_colours(palette):
    """style.palette (a list of colours, or an engine palette object) -> the colours a sticker may use:
    a list as is; an object's accent, ink and paper, then its swatches, de-duplicated, at most 12."""
    if isinstance(palette, list):
        return list(palette)
    if not isinstance(palette, dict):
        return []
    values = [palette.get(k) for k in PALETTE_KEYS] + list((palette.get("swatches") or {}).values())
    out = []
    for v in values:
        if isinstance(v, str) and COLOUR.match(v.strip()) and v not in out:
            out.append(v)
    return out[:PALETTE_MAX]


def style_block(film):
    s = film["style"]
    parts = [
        f"STYLE: {s['preset']} illustration, {s['texture']}; hand-made, cut-paper look, confident slightly "
        f"wobbly ink outlines; tone: {film['tone']}."
    ]
    colours = palette_colours(s.get("palette"))
    if colours:
        parts.append("Limited palette: " + ", ".join(colours) + ".")
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
def label(mask, conn=8):
    """Connected components (8- or 4-connected) of a boolean mask by row runs + union-find
    -> (labels int32, count)."""
    np = need("numpy", "cutout")
    H, W = mask.shape
    parent = []
    diag = 1 if conn == 8 else 0  # runs [s, e) touch diagonally when one ends where the other starts

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
            while j < len(prev) and prev[j][1] + diag <= s:
                j += 1
            k = j
            while k < len(prev) and prev[k][0] < e + diag:
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


GROUND_CELLS = 40  # the ground estimate works on about this many cells along the sheet's long side
KEY_NEAR = 38  # colour distance from the ground estimate that still counts as ground
SHADOW_CHROMA = 28  # grey (max - min channel) that a cast shadow keeps
SHADOW_DEPTH = 110  # a shadow is at most this much darker than the ground; ink is darker still


def ground_field(img, border_bg):
    """Estimate the sheet's ground colour at every pixel -> uint8 (H, W, 3).

    Median colour per coarse cell (about 1/40 of the long side); cells that look like ground (most
    of the cell within 12 of that median, grey, within 70 of the border's median colour) keep their
    colour, the rest are filled from ground neighbours; a light blur, then a bilinear upsample.
    Uneven lighting, a lighter band or a gradient therefore keys as ground. A sheet without enough
    grey cells (a coloured ground) falls back to the border median everywhere."""
    np = need("numpy", "cutout")
    from PIL import Image

    W, H = img.size
    scale = min(1.0, 1024 / max(W, H))
    small = img.resize((max(1, round(W * scale)), max(1, round(H * scale))), Image.BOX)
    arr = np.asarray(small, dtype=np.float32)
    sh, sw = arr.shape[:2]
    c = max(4, round(max(sw, sh) / GROUND_CELLS))
    gh, gw = max(1, sh // c), max(1, sw // c)
    blocks = arr[: gh * c, : gw * c].reshape(gh, c, gw, c, 3).transpose(0, 2, 1, 3, 4).reshape(gh, gw, c * c, 3)
    med = np.median(blocks, axis=2)
    flat = (np.abs(blocks - med[:, :, None, :]).max(-1) <= 12).mean(-1)
    chroma = med.max(-1) - med.min(-1)
    near = np.sqrt(((med - border_bg) ** 2).sum(-1)) < 70
    ground = (flat >= 0.7) & (chroma < 30) & near
    if ground.sum() < 0.1 * ground.size:
        return np.broadcast_to(np.clip(np.asarray(border_bg), 0, 255).astype(np.uint8), (H, W, 3))
    field = np.where(ground[..., None], med, np.nan)
    while np.isnan(field[..., 0]).any():  # fill from ground neighbours, ring by ring
        p = np.pad(field, ((1, 1), (1, 1), (0, 0)), mode="edge")
        nb = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        cnt = (~np.isnan(nb[..., 0])).sum(0)
        avg = np.nansum(nb, axis=0) / np.maximum(cnt, 1)[..., None]
        grow = np.isnan(field[..., 0]) & (cnt > 0)
        if not grow.any():
            break
        field[grow] = avg[grow]
    field = np.nan_to_num(field, nan=0.0) + np.isnan(field) * np.asarray(border_bg, dtype=np.float32)
    for _ in range(2):  # 3x3 box blur on the cell grid
        p = np.pad(field, ((1, 1), (1, 1), (0, 0)), mode="edge")
        field = sum(p[dy : dy + gh, dx : dx + gw] for dy in range(3) for dx in range(3)) / 9
    up = Image.fromarray(np.clip(field, 0, 255).astype(np.uint8), "RGB").resize((W, H), Image.BILINEAR)
    return np.asarray(up)


def strip_border(rgb, alpha):
    """Remove the white die-cut border once the alpha exists: flood from the outside (4-connected)
    through transparent and near-white pixels, clear them, keep the pieces at least 5% the size of the
    largest (thin leftover arcs go), and soften the new edge by a pixel. -> new alpha (float 0..1)."""
    np = need("numpy", "cutout")
    from PIL import Image, ImageFilter

    mx, mn = rgb.max(-1), rgb.min(-1)
    passable = (alpha < 0.98) | ((mn > 200) & (mx - mn < 40))
    lab, _ = label(passable, conn=4)
    outside = np.isin(lab, list(border_labels(lab)))
    a = np.where(outside, 0.0, alpha)
    pieces, n = label(a > 0.15)
    if n:
        sizes = np.bincount(pieces.ravel())[1:]
        keep = [i + 1 for i, s_ in enumerate(sizes) if s_ >= 0.05 * sizes.max()]
        a = np.where(np.isin(pieces, keep), a, 0.0)
    a8 = Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
    soft = np.asarray(a8.filter(ImageFilter.GaussianBlur(0.8)), dtype=np.float32) / 255
    return np.minimum(a, soft)


def defringe(rgb, alpha, ground, reach=3):
    """Clear grey pixels within `reach` px of transparency (a cast shadow or the ground showing through)
    and un-mix the ground colour from the semi-transparent edge: rgb = (rgb - (1 - a) x ground) / a.
    -> (rgb, alpha)."""
    np = need("numpy", "cutout")
    edge = dilate(alpha < 0.5, reach) & (alpha > 0)
    mx, mn = rgb.max(-1), rgb.min(-1)
    lum = rgb.mean(-1)
    grey = ((mx - mn) / np.maximum(mx, 1) < 0.12) & (lum > 70) & (lum < 225)
    alpha = np.where(edge & grey, 0.0, alpha)
    semi = (alpha > 0.2) & (alpha < 0.95)
    a = alpha[semi][:, None]
    rgb = rgb.copy()
    rgb[semi] = np.clip((rgb[semi] - (1 - a) * np.asarray(ground, dtype=np.float32)) / a, 0, 255)
    return rgb, alpha


def _frac(v, n):
    return round(float(v) / n, 4)


def cut_sheet(sheet, min_area=0.002, max_dim=1400, skip=(), strip=False, fringe=False):
    """-> (list of (PIL RGBA image, info) in row-major order, list of dropped regions)."""
    np = need("numpy", "cutout")
    need("PIL", "cutout (package: pillow)")
    from PIL import Image

    img = Image.open(sheet).convert("RGB")
    im = np.asarray(img).astype(np.int32)
    H, W, _ = im.shape
    border = np.concatenate(
        [im[:8].reshape(-1, 3), im[-8:].reshape(-1, 3), im[:, :8].reshape(-1, 3), im[:, -8:].reshape(-1, 3)]
    )
    bg = np.median(border, 0)
    field = ground_field(img, bg)
    dist, shadow = np.empty((H, W), np.float32), np.empty((H, W), bool)
    for y in range(0, H, 256):  # in bands: a 4K sheet stays a few hundred MB
        px, gr = im[y : y + 256].astype(np.float32), field[y : y + 256].astype(np.float32)
        dist[y : y + 256] = np.sqrt(((px - gr) ** 2).sum(-1))
        # cast shadows: grey and darker than the ground (ink is darker still, and sits inside the white border)
        lum, glum = px.mean(-1), gr.mean(-1)
        grey = (px.max(-1) - px.min(-1)) < SHADOW_CHROMA
        shadow[y : y + 256] = grey & (lum < glum - 6) & (lum > glum - SHADOW_DEPTH)
    lab, _ = label((dist < KEY_NEAR) | shadow)
    bgmask = np.isin(lab, list(border_labels(lab)))
    fg = erode(~bgmask, 2)
    fg = dilate(fg, 2)
    holes_lab, _ = label(~fg)
    fg = fg | (np.isin(holes_lab, list(set(np.unique(holes_lab)) - {0} - border_labels(holes_lab))))
    comps, n = label(fg)
    counts = np.bincount(comps.ravel())
    found, dropped = [], []
    for i in range(1, n + 1):
        if counts[i] < min_area * H * W:
            continue
        ys, xs = np.nonzero(comps == i)
        box = (i, ys.min(), ys.max() + 1, xs.min(), xs.max() + 1)
        if box[1] <= 1 or box[3] <= 1 or box[2] >= H - 1 or box[4] >= W - 1:
            dropped.append(
                {
                    "why": "touches the sheet edge",
                    "cx": _frac(box[3] + box[4], 2 * W),
                    "cy": _frac(box[1] + box[2], 2 * H),
                }
            )
            continue
        found.append(box)
    if not found:
        return [], dropped
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
    for k in sorted(set(skip)):
        if not 0 <= k < len(ordered):
            raise UsageError(f"--skip {k}: there are {len(ordered)} regions (#0-#{len(ordered) - 1})")
    dropped += [
        {"why": "--skip", "index": k, "cx": _frac(f[3] + f[4], 2 * W), "cy": _frac(f[1] + f[2], 2 * H)}
        for k, f in enumerate(ordered)
        if k in set(skip)
    ]
    ordered = [f for k, f in enumerate(ordered) if k not in set(skip)]
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
        if strip:
            alpha = strip_border(rgb, alpha)
        if fringe:
            rgb, alpha = defringe(rgb, alpha, field[y0:y1, x0:x1].reshape(-1, 3).mean(0).astype(np.float32))
        rgba = np.dstack([rgb, alpha * 255]).clip(0, 255).astype(np.uint8)
        img_s = Image.fromarray(rgba, "RGBA")
        if strip:  # the border was margin: crop to what is left, with a 2 px pad
            bb = img_s.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
            if bb:
                img_s = img_s.crop((max(0, bb[0] - 2), max(0, bb[1] - 2), bb[2] + 2, bb[3] + 2))
        s = max_dim / max(img_s.size)
        if s < 1:
            img_s = img_s.resize((round(img_s.size[0] * s), round(img_s.size[1] * s)), Image.LANCZOS)
        out.append(
            (
                img_s,
                {
                    "cx": _frac(x0 + x1, 2 * W),
                    "cy": _frac(y0 + y1, 2 * H),
                    "w": img_s.size[0],
                    "h": img_s.size[1],
                },
            )
        )
    return out, dropped


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


def parse_anchors(spec, names):
    """'a=0.5,0.9;b=0.1,0.5' -> {name: [ax, ay]} (fractions of the sticker's width and height)."""
    out = {}
    for part in filter(None, (p.strip() for p in (spec or "").split(";"))):
        m = re.fullmatch(r"([^=\s]+)\s*=\s*([0-9.]+)\s*,\s*([0-9.]+)", part)
        if not m:
            raise UsageError(f"--anchors: expected name=ax,ay, got {part!r}")
        name, ax, ay = m.group(1), float(m.group(2)), float(m.group(3))
        if name not in names:
            raise UsageError(f"--anchors: {name!r} is not one of --names")
        if not (0 <= ax <= 1 and 0 <= ay <= 1):
            raise UsageError(f"--anchors: {name} needs fractions between 0 and 1")
        out[name] = [ax, ay]
    return out


def manifest_entry(old, info, anchor):
    """-> (manifest value, whether an earlier anchor was kept): [w, h] as before, or
    {"size": [w, h], "anchor": [ax, ay]} when the sticker has a pivot. An anchor stored earlier
    survives a re-cut unless a new one is given (the file is always the new <name>.webp)."""
    earlier = old.get("anchor") if isinstance(old, dict) else None
    if anchor is None and earlier is None:
        return [info["w"], info["h"]], False
    return {"size": [info["w"], info["h"]], "anchor": anchor or earlier}, anchor is None


def cmd_cutout(a):
    film_dir = Path(a.film)
    load_film(film_dir)
    names = [n.strip() for n in a.names.split(",") if n.strip()]
    if len(set(names)) != len(names):
        raise UsageError("--names has duplicates")
    anchors = parse_anchors(a.anchors, names)
    skip = [int(k) for k in a.skip.split(",") if k.strip()] if a.skip else []
    stickers, dropped = cut_sheet(a.sheet, a.min_area, a.max_dim, skip, a.strip_border, a.defringe)
    for d in dropped:
        where = f"at ({d['cx']}, {d['cy']})"
        print(f"cutout: dropped the region {where}: {d['why']}" + (f" #{d['index']}" if "index" in d else ""))
    if len(stickers) != len(names) and not (a.allow_extra and len(stickers) > len(names)):
        print(
            f"cutout: found {len(stickers)} stickers in row-major order but got {len(names)} names; "
            f"positions (cx, cy): {[(s[1]['cx'], s[1]['cy']) for s in stickers]}"
        )
        contact_sheet(
            [(im, f"#{i}") for i, (im, _) in enumerate(stickers)],
            film_dir / "work" / "qa" / f"cutout-{Path(a.sheet).stem}.jpg",
        )
        print("  read the contact sheet: name the stickers, or drop extra regions with --skip <#i,#j>")
        return EXIT_GATE
    img_dir = film_dir / "web" / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest = read_json(img_dir / "manifest.json", default={})
    base = Path(a.sheet).stem
    labelled = []
    for i, (im, info) in enumerate(stickers):
        name = names[i] if i < len(names) else f"{base}_{i:02d}"
        im.save(img_dir / f"{name}.webp", "WEBP", quality=90, method=6)
        manifest[name], kept = manifest_entry(manifest.get(name), info, anchors.get(name))
        labelled.append((im, name))
        pivot = f"  anchor {manifest[name]['anchor']}" if isinstance(manifest[name], dict) else ""
        print(f"  {name}: {info['w']}x{info['h']}{pivot}" + ("  (anchor kept from before: check it)" if kept else ""))
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
    c.add_argument("--skip", help="comma-separated region indexes to drop (#i on the cutout contact sheet)")
    c.add_argument(
        "--strip-border", action="store_true", help="remove the white die-cut border after keying (cut-paper look)"
    )
    c.add_argument(
        "--defringe", action="store_true", help="clear grey edge pixels and un-mix the ground colour from the edge"
    )
    c.add_argument(
        "--anchors",
        help='pivots as fractions of each sticker: "name=ax,ay;name2=ax,ay" (0,0 top left); stored in the manifest',
    )
    k = sub.add_parser("contact", help="contact sheet of all stickers")
    add_film_arg(k)
    k.add_argument("--out")
    k.add_argument("--cols", type=int, default=6)
    a = ap.parse_args(argv)
    return {"sheet": cmd_sheet, "cutout": cmd_cutout, "contact": cmd_contact}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
