#!/usr/bin/env python3
"""Check that this machine and key can make the film: python3 preflight.py [--film <dir>] [--tier 0|1]

Before the film exists (at intake), run it without --film: it judges the providers with default
inputs, skips the Chromium check and writes nothing. After scaffold.py new, run it with --film.

tier 0 (free): tools (node >= 18, npm, ffmpeg/ffprobe, Chromium via the film's glyph test, Python
packages), the key and its remaining limit (GET /key), the catalog entry and output modality of
every candidate per role (GET /models?output_modalities=all), the license filter, the delivery
capability probe (node tools/export.mjs --probe) and a cost quote.
tier 1 (sub-cent, needs a scaffolded film): one real call each for tts, align and critic through
the normal fallback walker (catalogs lie; a 402 there is how a model turns out to be unusable).
Reserved and recorded in the ledger like every paid call.

Writes work/preflight.json when the film is scaffolded (film.json exists; a directory without one is
left untouched, so scaffold.py new can still use it). Exit 1 when a role the film needs has no working
provider or no requested delivery mode is available.
"""

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from common import add_film_arg, add_provider_args, load_film, now_iso, parser, run_main, usd, validate_film, write_json
from providers import Context, run_role
from providers.base import ProviderError, ToolError, UsageError
from providers.openrouter import catalog_price
from quote import build_quote

PY_MIN = (3, 10)
PIP_NAMES = {"PIL": "pillow"}
PY_PACKAGES = {
    "numpy": "voice process/tighten fallback, music beats/cut, sticker cutout",
    "PIL": "sticker cutout and contact sheets (package: pillow)",
    "soundfile": "optional: decoding MP3/FLAC without ffmpeg",
    "librosa": "optional: better beat tracking in music.py beats; time-stretch without ffmpeg",
}


def _version(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return (r.stdout or r.stderr).strip().splitlines()[0] if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, IndexError):
        return None


def check_tools(film_dir):
    tools = {}
    node = shutil.which("node")
    nv = _version(["node", "--version"]) if node else None
    major = int(re.match(r"v?(\d+)", nv).group(1)) if nv and re.match(r"v?(\d+)", nv) else 0
    tools["node"] = {"ok": major >= 18, "detail": nv or "not found (install Node.js 18+)"}
    tools["npm"] = {"ok": bool(shutil.which("npm")), "detail": shutil.which("npm") or "not found"}
    for b in ("ffmpeg", "ffprobe"):
        v = _version([b, "-version"]) if shutil.which(b) else None
        tools[b] = {
            "ok": bool(v),
            "optional": True,
            "detail": (v or "not found (MP4 falls back to in-browser export)")[:80],
        }
    film_dir = Path(film_dir)
    render = film_dir / "tools" / "render.mjs"
    if not render.exists():
        tools["chromium"] = {"ok": None, "detail": "not checked: scaffold the film first (scaffold.py new)"}
    elif not (film_dir / "node_modules" / "playwright-core").exists():
        tools["chromium"] = {"ok": False, "detail": f"run: npm install --prefix {film_dir}"}
    elif not node:
        tools["chromium"] = {"ok": False, "detail": "node not found"}
    else:
        try:
            r = subprocess.run(
                ["node", str(render), "glyph", "--film", str(film_dir)], capture_output=True, text=True, timeout=180
            )
            try:
                g = json.loads(r.stdout)
                detail = f"glyph test {'ok' if g.get('ok') else 'FAILED'} ({len(g.get('details', []))} checks)"
            except json.JSONDecodeError:
                detail = (r.stderr.strip().splitlines() or ["glyph test failed"])[-1][:200]
            tools["chromium"] = {"ok": r.returncode == 0, "detail": detail}
        except subprocess.TimeoutExpired:
            tools["chromium"] = {"ok": False, "detail": "glyph test timed out"}
    py = {}
    for mod, why in PY_PACKAGES.items():
        py[mod] = {"ok": importlib.util.find_spec(mod) is not None, "for": why}
    tools["python"] = {"ok": sys.version_info >= PY_MIN, "detail": sys.version.split()[0], "packages": py}
    return tools


def check_delivery(film_dir, film, tools):
    film_dir = Path(film_dir)
    probe, note = None, ""
    exp = film_dir / "tools" / "export.mjs"
    if exp.exists() and (film_dir / "node_modules").exists() and shutil.which("node"):
        try:
            r = subprocess.run(
                ["node", str(exp), "--probe", "--film", str(film_dir)], capture_output=True, text=True, timeout=180
            )
            probe = json.loads(r.stdout[r.stdout.index("{") :]) if "{" in r.stdout else None
        except (subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
            probe = None
    if probe is None:
        note = "export probe not run (scaffold + npm install first); judged from ffmpeg alone"
    browser = (probe or {}).get("browser") or {}
    ff = tools["ffmpeg"]["ok"] and tools["ffprobe"]["ok"]
    wc = bool(
        browser.get("webcodecs")
        and (browser.get("video") or {}).get("avc")
        and (browser.get("audio") or {}).get("opus")
    )
    rec = any("webm" in m for m in browser.get("mediaRecorder") or [])
    can = {"page": True, "bundle": True, "mp4": ff or wc, "webm": ff or rec}
    modes = {m: can.get(m, False) for m in film["delivery"]}
    auto = (probe or {}).get("auto") or ({"mode": "ffmpeg", "reason": "ffmpeg and ffprobe found"} if ff else None)
    return {"requested": modes, "ok": all(modes.values()), "auto": auto, "probe": probe, "note": note}


def required_roles(film):
    # a $0 film (budget 0) is reviewed by Claude subagents through review.py ingest, not the critic
    req = {"critic": film["budget_usd"] > 0}
    req["tts"] = film["voice"]["mode"] != "none"
    req["align"] = film["voice"]["mode"] != "none"
    req["music"] = film["music"]["mode"] == "generated"
    req["image"] = film["art"]["mode"] == "generated"
    return req


def probe_roles(ctx, film):
    roles, pricing = {}, {}
    catalog_error = None
    try:
        catalog = ctx.catalog()
    except ToolError as e:
        catalog, catalog_error = {}, str(e)
    except Exception as e:  # noqa: BLE001 -- AvailabilityError and network failures: report, do not crash
        catalog, catalog_error = {}, str(e)
    req = required_roles(film)
    for role in ("tts", "align", "music", "image", "critic"):
        tiers = ["final", "draft"] + (["signoff"] if role == "critic" else [])
        entry = {"required": req.get(role, False), "tiers": {}, "skipped": []}
        for tier_name in tiers:
            chain, skipped = ctx.chain(role, tier_name)
            if tier_name == "final":
                entry["skipped"] = skipped
            probes = []
            for cand in chain:
                prov = ctx.provider(cand)
                if cand["provider"] == "local":
                    ok, why = prov.available()
                    p = {"ok": ok, "reason": why or "available locally", "usd": 0.0}
                elif catalog_error:
                    p = {"ok": False, "reason": f"catalog unavailable: {catalog_error}", "usd": 0.0}
                else:
                    p = prov.probe(0)
                if cand.get("model") in catalog:
                    pricing[cand["model"]] = catalog_price(catalog[cand["model"]])
                probes.append({"id": cand["id"], "model": cand["model"], **p})
            chosen = next((p["id"] for p in probes if p["ok"]), None)
            entry["tiers"][tier_name] = {"chosen": chosen, "candidates": probes}
        entry["chosen"] = entry["tiers"]["final"]["chosen"]
        roles[role] = entry
    return roles, pricing, catalog_error


def tier1(ctx, film, roles):
    """Real sub-cent calls through the walker. -> {role: {...}}."""
    out = {}
    work = ctx.dir / "work" / "preflight"
    work.mkdir(parents=True, exist_ok=True)
    text = "Testing, one two three."
    wav = None
    if roles["tts"]["chosen"] or roles["tts"]["required"]:
        chain, _ = ctx.chain("tts")
        default_voice = (chain[0].get("params", {}).get("audition_voices") or ["Kore"])[0] if chain else "Kore"
        voice = film["voice"].get("name") or default_voice
        out["tts"] = _call(
            ctx, "tts", {"text": text, "voice": voice, "style": None, "out_dir": work, "stem": "tts-probe"}
        )
        if out["tts"].get("ok"):
            wav = work / "tts-probe.wav"
    if wav is not None:
        out["align"] = _call(ctx, "align", {"audio": wav, "text": text, "language": film["language"]})
        if out["align"].get("ok"):
            got = " ".join(w["word"] for w in out["align"]["data"].get("words", []))
            out["align"]["heard"] = got
            if out["align"]["data"].get("coarse"):
                out["align"]["warning"] = (
                    "served by the coarse energy aligner: word checks will not catch mispronunciations"
                )
        out["align"].pop("data", None)
    else:
        out["align"] = {"ok": None, "reason": "skipped: no TTS audio to transcribe"}
    out["critic"] = _call(ctx, "critic", {"prompt": "Reply with the single word OK."})
    if out["critic"].get("ok"):
        out["critic"]["reply"] = out["critic"]["data"].get("text", "")[:40]
    out["critic"].pop("data", None)
    out.get("tts", {}).pop("data", None)
    return out


def _call(ctx, role, job):
    try:  # registry order, not an earlier preference: tier 1 is where the preference is found
        res = run_role(ctx, role, job, stage="preflight", use_cache=False, prefer=False)
        return {
            "ok": True,
            "served_by": res.candidate["id"],
            "usd": res.usd,
            "basis": res.basis,
            "fallbacks": [{"id": i, "why": w} for i, w in res.fallbacks],
            "data": res.data,
        }
    except (ToolError, ProviderError) as e:
        return {"ok": False, "reason": str(e), "exit_code": e.exit_code}


def main(argv=None):
    ap = parser("preflight.py", __doc__)
    add_film_arg(ap, required=False)
    add_provider_args(ap)
    ap.add_argument(
        "--tier", type=int, choices=(0, 1), default=0, help="0 = free checks (default); 1 = also sub-cent real calls"
    )
    ap.add_argument("--json", action="store_true", help="print the full report as JSON")
    a = ap.parse_args(argv)
    if a.film:
        return preflight(a, Path(a.film))
    # no film yet: judge with default inputs in an empty scratch directory that is removed afterwards
    with tempfile.TemporaryDirectory(prefix="animated-short-preflight-") as scratch:
        return preflight(a, Path(scratch))


def preflight(a, film_dir):
    film = load_film(film_dir, required=False)
    # a directory holding only its film.json (written before scaffold.py new) is judged by that film.json
    # but left untouched, so scaffold.py new can still use it
    scaffolded = film is not None and (film_dir / "web" / "index.html").exists()
    if not scaffolded and a.tier == 1:
        raise UsageError("tier 1 spends (a sub-cent per role) and needs a film ledger: run scaffold.py new first")
    if film is None:
        film, _ = validate_film({"topic": "-", "goal": "-", "message": "-"})
    ctx = Context(film_dir, film, key_file=a.key_file, account_ceiling=a.account_ceiling, use_cache=False)
    report = {"ts": now_iso(), "tier": a.tier, "film": a.film, "problems": [], "warnings": []}
    report["tools"] = check_tools(film_dir)
    missing = [PIP_NAMES.get(m, m) for m in ("numpy", "PIL") if not report["tools"]["python"]["packages"][m]["ok"]]
    if missing:
        report["warnings"].append(
            f"python packages missing: install only these: python3 -m pip install {' '.join(missing)} (if pip "
            "refuses with 'externally managed' (PEP 668), make a virtual environment outside the film "
            "directory: python3 -m venv <dir>, then <dir>/bin/python for every tool)"
        )

    key = {"present": ctx.key() is not None}
    if key["present"]:
        try:
            info = ctx.client().key_info()
            key.update(
                ok=True, usage=info.get("usage"), limit=info.get("limit"), limit_remaining=info.get("limit_remaining")
            )
            if ctx.ledger.ceiling is not None and info.get("usage") is not None:
                key["ceiling"] = ctx.ledger.ceiling
                key["ceiling_headroom"] = round(ctx.ledger.ceiling - float(info["usage"]), 4)
            if scaffolded:
                ctx.ledger.ensure_anchor()
        except Exception as e:  # noqa: BLE001 -- any failure is reported, never raised
            key.update(ok=False, error=str(e))
    report["key"] = key

    roles, pricing, cat_err = probe_roles(ctx, film)
    report["roles"], report["pricing"] = roles, pricing
    if cat_err:
        report["warnings"].append(f"catalog: {cat_err}")
    if a.tier == 1:
        if not key.get("ok"):
            report["problems"].append("tier 1 needs a working key")
        else:
            report["tier1"] = tier1(ctx, film, roles)
            for role, r in report["tier1"].items():
                if r.get("ok") is False and roles[role]["required"]:
                    report["problems"].append(f"{role}: tier-1 call failed ({r.get('reason')})")
                elif r.get("ok"):
                    roles[role]["chosen"] = r["served_by"]
                    # later commands start with the candidate that worked for this key (work/state.json)
                    ctx.update_state(
                        "preferred",
                        f"{role}/final",
                        {"candidate": r["served_by"], "since": now_iso(), "skipped": r["fallbacks"]},
                    )
                    for fb in r["fallbacks"]:
                        report["warnings"].append(
                            f"{role}: {fb['id']} is not usable with this key ({fb['why'][:160]}); later {role} "
                            f"commands start with {r['served_by']}"
                        )
                if r.get("warning"):
                    report["warnings"].append(f"{role}: {r['warning']}")
    for role, r in roles.items():
        if r["required"] and not r["chosen"]:
            report["problems"].append(f"{role}: no working provider")
    report["delivery"] = check_delivery(film_dir, film, report["tools"])
    if not report["delivery"]["ok"]:
        report["problems"].append(
            "delivery: "
            + ", ".join(m for m, ok in report["delivery"]["requested"].items() if not ok)
            + " not available here"
        )
    if not report["tools"]["node"]["ok"]:
        report["problems"].append("node 18+ is required")
    if report["tools"]["chromium"]["ok"] is False:
        report["problems"].append(f"chromium: {report['tools']['chromium']['detail']}")
    # the report is written before the quote too, so the quote reads the catalog prices; never into a directory
    # that is not a film yet (scaffold.py new refuses non-empty directories); the no-film scratch dir is removed
    writable = scaffolded or not a.film
    if writable:
        write_json(film_dir / "work" / "preflight.json", report)
    try:
        report["quote"] = build_quote(film, film_dir, ctx)
    except ToolError as e:
        report["warnings"].append(f"quote: {e}")
    report["ok"] = not report["problems"]
    if writable:
        write_json(film_dir / "work" / "preflight.json", report)
    if a.json:
        print(json.dumps(report, indent=1))
    else:
        print_report(report)
    return 0 if report["ok"] else 1


def print_report(r):
    t = r["tools"]
    print(f"preflight (tier {r['tier']}) for {r['film'] or 'no film yet (default inputs)'}")
    print(
        "  tools   "
        + " | ".join(
            f"{k} {'ok' if v['ok'] else ('-' if v['ok'] is None else 'MISSING')}" for k, v in t.items() if k != "python"
        )
    )
    for k in ("node", "ffmpeg", "chromium"):
        print(f"          {k}: {t[k]['detail']}")
    pk = t["python"]["packages"]
    print(
        f"          python {t['python']['detail']}: "
        + ", ".join(f"{m} {'ok' if v['ok'] else 'missing'}" for m, v in pk.items())
    )
    k = r["key"]
    if not k["present"]:
        print("  key     missing (set OPENROUTER_API_KEY or pass --key-file)")
    elif k.get("ok"):
        lim = (
            "no limit"
            if k.get("limit") is None
            else f"limit {usd(float(k['limit']))}, remaining {usd(float(k.get('limit_remaining') or 0))}"
        )
        ceil = f"; ceiling headroom {usd(k['ceiling_headroom'])}" if "ceiling_headroom" in k else ""
        print(f"  key     ok; account usage {usd(float(k.get('usage') or 0))}; {lim}{ceil}")
    else:
        print(f"  key     present but GET /key failed: {k.get('error')}")
    for role, e in r["roles"].items():
        tiers = e["tiers"]
        final = tiers["final"]
        fails = [f"{c['model']} ({c['reason']})" for c in final["candidates"] if not c["ok"]]
        extra = (
            f"  [draft: {tiers['draft']['chosen'] or '-'}]"
            if tiers.get("draft", {}).get("chosen") != final["chosen"]
            else ""
        )
        if role == "critic":
            extra += f"  [signoff: {tiers['signoff']['chosen'] or '-'}]"
        print(f"  {role:7} {'(needed) ' if e['required'] else '(unused) '}{e['chosen'] or 'NONE'}{extra}")
        for f in fails[:3]:
            print(f"          not usable: {f}")
        if e["skipped"]:
            reasons = ", ".join(sorted({s["why"].split(" (")[0] for s in e["skipped"]}))
            print(f"          filtered: {len(e['skipped'])} ({reasons})")
    for role, x in (r.get("tier1") or {}).items():
        state = "ok" if x.get("ok") else ("skipped" if x.get("ok") is None else "FAILED")
        detail = x.get("served_by") or x.get("reason", "")
        print(f"  tier1   {role}: {state} {detail}" + (f" ${x['usd']}" if x.get("usd") is not None else ""))
    d = r["delivery"]
    modes = ", ".join(m + (" ok" if ok else " NO") for m, ok in d["requested"].items())
    auto = "; auto mode " + d["auto"]["mode"] if d.get("auto") else ""
    print(f"  deliver {modes}{auto}{('; ' + d['note']) if d['note'] else ''}")
    if r.get("quote"):
        q = r["quote"]
        print(
            f"  quote   {usd(q['total'])} for all stages; budget {usd(q['budget'])}, remaining {usd(q['remaining'])}"
            f" -> {'fits' if q['fits'] else 'DOES NOT FIT (quote.py lists what to change)'}"
        )
    for w in r["warnings"]:
        print(f"  warning {w}")
    print("  verdict " + ("OK" if not r["problems"] else "FAIL: " + "; ".join(r["problems"])))


if __name__ == "__main__":
    run_main(main)
