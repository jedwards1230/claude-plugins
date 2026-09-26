#!/usr/bin/env python3
"""Write the delivery report from the film's own records: python3 report.py --film <dir> [--round N] [--out F]

out/report.md (or --out) is assembled from data, so it does not depend on the agent being allowed to write
a report file: film.json (what was made), out/export.json (deliverables and measurements), the final
round's gates.json (gates, counted defects, the ones the fix pass fixed or left unverified, defects still
to confirm, a stale director gate; the latest round, the fix pass when there is one, unless --round names
another), that round's persona and comparer reviews (how each persona restated the message),
work/research/claims.json (hard truths and what was decided), accepted_claims.json, ledger.jsonl and the
last reconcile (spend, account delta, models), work/state.json (pinned choices, calibration), film.json
credits (a model whose output is in the film and that the credits do not name is flagged: the pinned voice
and image models, the aligner in work/vo/words-detail.json, the music candidate work/music/edit.json uses;
other ledger models the credits do not name are only listed), work/takes/check.json (pronunciation left
unverified) and the latest creative-direction originality check.
The agent adds what only it knows in work/report-notes.json: {"open_decisions": [...], "not_verified":
[...], "notes": [...]} (all optional lists of strings). Exit 0 when written, 2 when the film is missing.
"""

import datetime
import re
from pathlib import Path

from common import add_film_arg, is_fiction, load_film, parser, read_json, run_main, slug, usd
from providers.base import UsageError
from providers.ledger import Ledger
from review import ROUND, round_dir, round_label, round_parts


def latest_round(film_dir):
    """The label of the latest round with a gates.json (a fix pass wins over its round), or None."""
    best = None
    for g in (Path(film_dir) / "work" / "reviews").glob("r*/gates.json"):
        m = ROUND.match(g.parent.name[1:])
        if m and g.parent.name != "r0":
            key = round_parts(g.parent.name[1:])
            best = max(best or key, key)
    return None if best is None else f"{best[0]}{'-fix' if best[1] else ''}"


def originality_check(film_dir):
    """(score line, which check, file name) of the latest work/direction/originality-v<N>.md ("check N"),
    else of an unversioned originality.md ("latest check": it does not say which check it was), or None."""
    d = Path(film_dir) / "work" / "direction"
    files = sorted(d.glob("originality-v*.md"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
    if files:
        f, which = files[-1], f"check {int(re.sub(r'[^0-9]', '', files[-1].stem) or 0)}"
    elif (d / "originality.md").exists():
        f, which = d / "originality.md", "latest check"
    else:
        return None
    first = (f.read_text(encoding="utf-8").strip().splitlines() or [""])[0].strip()
    return first, which, f.name


def picked_models(film_dir, state):
    """Models whose output is in the film -> {model: what}: the pinned choices in work/state.json (voice,
    images), the aligner behind src/words.json (work/vo/words-detail.json) and the music candidate the
    cut uses (work/music/edit.json source, looked up in the work/music/candidates.json music.py gen writes)."""
    film_dir = Path(film_dir)
    out = {}
    for key, pin in (state.get("sticky") or {}).items():
        if pin.get("model"):
            out.setdefault(pin["model"], f"pinned {key}")
    for d in (read_json(film_dir / "work" / "vo" / "words-detail.json", default={}) or {}).values():
        if isinstance(d, dict) and d.get("model"):
            out.setdefault(d["model"], "the word timings")
    src = (read_json(film_dir / "work" / "music" / "edit.json", default={}) or {}).get("source")
    made = read_json(film_dir / "work" / "music" / "candidates.json", default={}) or {}
    if src and (made.get(Path(src).name) or {}).get("model"):
        out.setdefault(made[Path(src).name]["model"], f"the music ({Path(src).name})")
    return out


def model_mentioned(model, credits_text):
    """A loose check that the credits name a model: every part of its id (after the vendor, 'preview'
    aside) appears in the credits."""
    parts = [p for p in re.split(r"[-/]", model.split("/", 1)[-1].lower()) if p and p != "preview"]
    words = set(re.split(r"[^a-z0-9.]+", credits_text.lower().replace("-", " ")))
    return all(p in words for p in parts)


def credit_text(c):
    return c if isinstance(c, str) else f"{c.get('role', '')}: {c.get('name', '')}"


def defect_line(d):
    return f"- {d['severity']} {d['check']} at {d.get('at')} ({d.get('review')}): {d.get('issue')}"


def build(film, film_dir, label):
    film_dir = Path(film_dir)
    out = [f"# {film['title']}: report", ""]
    exp = read_json(film_dir / film["output_dir"] / "export.json", default={})
    gates = read_json(round_dir(film_dir, label) / "gates.json", default={}) if label else {}
    notes = read_json(film_dir / "work" / "report-notes.json", default={})
    state = read_json(film_dir / "work" / "state.json", default={})
    zero = film["budget_usd"] == 0
    today = datetime.date.today().isoformat()
    out += [
        f"Written {today} by report.py from the film's records. {film['form'].capitalize()}, {film['duration']} s, "
        f"{film['aspect']}.",
        "",
        "## What was made",
        "",
        f"- Topic: {film['topic']}",
        f"- Goal: {film['goal']}",
        f"- Message: {film['message']}",
        f"- Audience: {'; '.join(p['name'] + ' (knows: ' + p['knows'] + ')' for p in film['audience'])}",
    ]
    if exp:
        out.append(f"- Export: mode {exp.get('mode')} ({exp.get('reason', '')}); page `{exp.get('page', 'out/page')}/`")
        for f in exp.get("files", []):
            out.append(
                f"- `{f.get('path')}`: {f.get('width')}x{f.get('height')}, {f.get('duration')} s, "
                f"{(f.get('bytes') or 0) / 1048576:.1f} MiB, {f.get('lufs')} LUFS, true peak {f.get('true_peak')} dBTP"
            )
        cap = exp.get("captions") or {}
        out.append(
            f"- Captions `{cap.get('srt')}`, `{cap.get('vtt')}` ({cap.get('cues')} cues); `{exp.get('transcript')}`"
        )
        loud = exp.get("loudness") or {}
        if loud.get("mix_sha256"):
            out.append(f"- Mix `{loud.get('mix')}` SHA-256 {loud['mix_sha256']}")
    else:
        out.append(f"- No `{film['output_dir']}/export.json` yet: run tools/export.mjs before the report.")
    out += ["", "## Did the message land", ""]
    if label:
        rd = round_dir(film_dir, label)
        base = round_dir(film_dir, round_parts(label)[0])
        for p in film["audience"]:
            s = slug(p["name"])
            rev = read_json(rd / f"persona-{s}.json", default={}) or read_json(base / f"persona-{s}.json", default={})
            comp = read_json(rd / f"comparer-{s}.json", default={}) or read_json(
                base / f"comparer-{s}.json", default={}
            )
            quiz = rev.get("quiz") or []
            out.append(
                f'- {p["name"]}: "{rev.get("takeaway", "no persona review")}" (matches the message: '
                f"{comp.get('matches_message', 'not judged')}; quiz {sum(1 for q in quiz if q.get('correct'))}/"
                f"{len(quiz)}; {len(rev.get('learned') or [])} learnings)"
            )
    else:
        out.append("- No review round has gates yet.")
    out += ["", f"## Ship gates{f' (round {label})' if label else ''}", ""]
    if gates:
        out.append(f"Verdict: **{gates.get('verdict', '?')}**{(' - ' + gates['note']) if gates.get('note') else ''}.")
        out.append("")
        for g in gates.get("gates", []):
            out.append(f"- {'pass' if g['pass'] else 'FAIL'} {g['id']}: {g['name']} ({g['evidence']})")
        out += ["", "## Open defects", ""]
        counted = gates.get("counted_defects") or []
        if counted:
            out.append("Counted (the defect rule confirmed them) and not fixed:")
            out += [defect_line(d) for d in counted]
        else:
            out.append("- No counted defect is open.")
        for key, head in (
            ("fixed_defects", "Fixed in the fix pass (a fix-pass review reported each one fixed)"),
            (
                "unverified_fixes",
                "Fixes nobody confirmed (not counted: the fix pass re-ran their reviewer, whose review does not "
                "mention them)",
            ),
        ):
            if gates.get(key):
                out += ["", f"{head}:"] + [defect_line(d) for d in gates[key]]
        if gates.get("to_confirm"):
            out.append("")
        for d in gates.get("to_confirm") or []:
            out.append(
                f"- unconfirmed ({d.get('review')}): {d['severity']} {d['check']} at {d.get('at')}: {d.get('issue')}"
            )
    else:
        out.append("No gates.json: the film has not been through a review round.")
    out += ["", "## Facts", ""]
    claims = (read_json(film_dir / "work" / "research" / "claims.json", default={}) or {}).get("claims") or []
    if is_fiction(film):
        out.append("- Fiction: no fact sources, no research.")
    else:
        out.append(f"- Claims ledger: {len(claims)} claims (`work/research/claims.json`).")
    checked = [c for doc in _reviews(film_dir, label, "fact_checker") for c in doc.get("claims", [])]
    if checked:
        by = {}
        for c in checked:
            by[c["status"]] = by.get(c["status"], 0) + 1
        out.append("- Fact-checker: " + ", ".join(f"{v} {k}" for k, v in sorted(by.items())))
    accepted = []
    if label:
        for d in {round_dir(film_dir, label), round_dir(film_dir, round_parts(label)[0])}:
            accepted += read_json(d / "accepted_claims.json", default=[])
    for t in sorted(set(accepted)):
        out.append(f"- Accepted by the user as it is: {t}")
    hard = [c for c in claims if c.get("sensitivity") == "hard_truth"]
    for c in hard:
        decision = c.get("decision", "decision not recorded")
        out.append(f"- Hard truth ({decision}; policy {film['hard_truths']}): {c.get('fact')}")
    if not hard and claims:
        out.append("- No claim is marked hard_truth.")
    orig = originality_check(film_dir)
    if orig:
        out.append(f"- Creative-direction originality: score {orig[0]} (`work/direction/{orig[2]}`, {orig[1]})")
    out += ["", "## Spend", ""]
    led = Ledger(film_dir / "ledger.jsonl", film["budget_usd"])
    t = led.status()
    out.append(
        f"- Budget {usd(film['budget_usd'])}; ledger spent {usd(t['spent'])} in {t['calls']} calls "
        f"({t['cache_hits']} from the cache); open reservations {usd(t['reserved'])}."
    )
    if t["by_stage"]:
        out.append("- By stage: " + ", ".join(f"{k} {usd(v)}" for k, v in sorted(t["by_stage"].items())))
    if t["by_role"]:
        out.append("- By role: " + ", ".join(f"{k} {usd(v)}" for k, v in sorted(t["by_role"].items())))
    rec = [e for e in led.entries() if e.get("op") == "reconcile" and e.get("delta") is not None]
    if rec:
        r = rec[-1]
        out.append(
            f"- Account usage since the film's first paid call: {usd(r['delta'])} (drift {r['drift']:+.4f} "
            f"against the ledger, {r['ts']})."
        )
    for role, c in sorted((state.get("calibration") or {}).items()):
        out.append(f"- Estimated {role} costs calibrated x{c.get('factor')} by reconcile.")
    if zero:
        out.append("- A $0 film: no paid call was made.")
    models = sorted(
        {(e.get("role"), e.get("model")) for e in led.entries() if e.get("op") == "record" and e.get("model")}
    )
    out += ["", "## Models and credits", ""]
    for role, model in models:
        out.append(f"- {role}: {model}")
    for key, pin in sorted((state.get("sticky") or {}).items()):
        short = lambda v: v if len(str(v)) <= 60 else str(v)[:57] + "..."  # noqa: E731
        extra = ", ".join(f"{k} {short(v)}" for k, v in pin.items() if k not in ("candidate", "model", "since") and v)
        out.append(f"- Pinned {key}: {pin.get('model')}{(' (' + extra + ')') if extra else ''}")
    credits = film.get("credits") or []
    text = " ".join(credit_text(c) for c in credits)
    out += [f"- Credit: {credit_text(c)}" for c in credits] or ["- film.json has no credits."]
    # a model whose output is in the film must be credited; any other ledger model (a probe, a judge, a
    # candidate that lost the pick) may or may not be, so it is only listed
    picked = picked_models(film_dir, state)
    missing = sorted(m for m in {m for _, m in models} | set(picked) if not model_mentioned(m, text))
    for m in (m for m in missing if m in picked):
        out.append(f"- CHECK: the credits do not seem to name {m}, which made {picked[m]} (a word match; read them)")
    others = [m for m in missing if m not in picked]
    if others:
        out.append(
            "- Ledger models not named in the credits (fine if they were probes, judges or unused candidates; "
            "reviewers go under a reviewed-by credit): " + ", ".join(others)
        )
    out += ["", "## Not verified", ""]
    nv = list(notes.get("not_verified") or [])
    for g in (gates or {}).get("gates", []):
        if g.get("stale"):
            nv.insert(
                0,
                f"The {g['id']} gate rests on a review of the cut before the fix pass "
                f"({g['evidence'].split(' (stale:')[0]}): nobody signed off the fixed cut r{label}.",
            )
    if zero:
        nv.insert(0, "No model watched the video: every review was a fresh Claude subagent working from stills.")
    chk = read_json(film_dir / "work" / "takes" / "check.json", default={})
    override = (film_dir / "work" / "takes" / "check-override.md").exists()
    for lid in chk.get("unverified") or []:
        nv.append(
            f"Pronunciation of line {lid}: only the coarse aligner heard it"
            + (" (judged by ear: work/takes/check-override.md)" if override else "")
        )
    out += [f"- {x}" for x in nv] or ["- Nothing recorded."]
    out += ["", "## Open decisions for the user", ""]
    od = list(notes.get("open_decisions") or [])
    if gates and gates.get("verdict") != "ship":
        od.insert(0, "Failed gates: " + ", ".join(g["id"] for g in gates.get("gates", []) if not g["pass"]))
    out += [f"- {x}" for x in od] or ["- None recorded."]
    if notes.get("notes"):
        out += ["", "## Notes", ""] + [f"- {x}" for x in notes["notes"]]
    return "\n".join(out) + "\n"


def _reviews(film_dir, label, reviewer):
    """The reviewer's review of the report's round (the fix pass first, then its round)."""
    if not label:
        return []
    for d in (round_dir(film_dir, label), round_dir(film_dir, round_parts(label)[0])):
        doc = read_json(d / f"{reviewer}.json", default={})
        if doc:
            return [doc]
    return []


def main(argv=None):
    ap = parser("report.py", __doc__)
    add_film_arg(ap)
    ap.add_argument("--round", type=round_label, help="the review round to report (default: the latest with gates)")
    ap.add_argument("--out", help="output file (default: <film>/<output_dir>/report.md)")
    a = ap.parse_args(argv)
    film = load_film(a.film)
    label = a.round or latest_round(a.film)
    if a.round and not (round_dir(a.film, a.round) / "gates.json").exists():
        raise UsageError(f"work/reviews/r{a.round}/gates.json not found: run review.py gates --round {a.round}")
    dest = Path(a.out) if a.out else Path(a.film) / film["output_dir"] / "report.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(build(film, a.film, label), encoding="utf-8")
    print(f"report: {dest} (round {label or 'none'})")
    return 0


if __name__ == "__main__":
    run_main(main)
