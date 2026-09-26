#!/usr/bin/env python3
"""Estimate what a film will cost before spending: python3 quote.py --film <dir> [--stage STAGE] [--json]

Stages (the same labels the tools write into ledger.jsonl): voice (auditions and the critic's pick,
takes per line, transcript checks, the critic's take picks, final alignment), animatic (draft sheets,
one critic pass), assets (final sheets, music candidates and the critic's pick), review (the review
rounds still to run: review.rounds minus the work/reviews/r<N>/ directories that exist, N >= 1;
director, personas, audio, comparers, originality per round, plus one sign-off pass), preflight (tier-1
probes), all. Counts come from film.json and src/script.json (the word count sets the take lengths;
without a script, duration x 2.5 words). Unit prices come from the registry, refined by catalog prices
when preflight has run, times the film's calibration factor once ledger.py reconcile has set one. A
film with budget_usd 0 quotes no critic calls (its reviews are Claude subagents). Prints a table,
writes work/quote.json, and exits 3 when the quote does not fit the film's remaining budget; it then
also prints what to change to fit: film.json knobs in order of least harm (draft art, music
candidates, sticker sheets, takes, review rounds, personas), each with the total after that change and
the ones above it.
"""

import copy
import json
import math
import re
from pathlib import Path

from common import add_film_arg, load_film, parser, run_main, script_lines, usd, validate_film, write_json
from providers import Context
from providers.base import EXIT_BUDGET

STAGES = ("preflight", "voice", "animatic", "assets", "review")
TAKE_PICK_LINES = 4  # lines judged per take-pick critic call (phases.md, phase 6)
REVIEW_PROMPT_CHARS = 6000  # a rubric prompt: template, film context, intent notes and the schema
JUDGE_PROMPT_CHARS = 1500  # a judging prompt for critic.py ask (audition, take picks, music, animatic)
# film.json knobs the "to fit" list may turn, least harmful first: (path, floor, label)
FIT_STEPS = (
    (("art", "draft_first"), False, "animatic on the engine's placeholders instead of draft art"),
    (("music", "candidates"), 2, "fewer music candidates"),
    (("art", "sheets"), 3, "fewer final sticker sheets (more stickers per sheet)"),
    (("music", "candidates"), 1, "one music candidate"),
    (("voice", "takes"), 2, "fewer takes per line"),
    (("review", "rounds"), 3, "fewer review rounds"),
    (("art", "sheets"), 2, "fewer final sticker sheets"),
    (("audience",), 1, "one persona"),
)


def rounds_done(film_dir):
    """Film-review rounds already started: work/reviews/r<N>/ directories with N >= 1."""
    d = Path(film_dir) / "work" / "reviews"
    if not d.is_dir():
        return 0
    return sum(1 for p in d.iterdir() if p.is_dir() and re.fullmatch(r"r([1-9]\d*)", p.name))


def build_quote(film, film_dir, ctx=None, stage="all"):
    film_dir = Path(film_dir)
    ctx = ctx or Context(film_dir, film)
    lines = script_lines(film_dir) if (film_dir / "src" / "script.json").exists() else []
    words = sum(len(str(ln.get("tts") or ln["text"]).split()) for ln in lines) or int(film["duration"] * 2.5)
    n_lines = len(lines) or max(1, math.ceil(words / 20))
    avg_words = max(1, round(words / n_lines))
    line_seconds = avg_words / 2.5
    items, notes = [], []

    def pick(role, tier="final"):
        chain, _ = ctx.chain(role, tier)
        chain = [c for c in chain if c["provider"] != "local" or c["model"] == "energy"]
        return chain[0] if chain else None

    def add(st, item, role, tier, units, unit=None, **job):
        cand = pick(role, tier)
        if cand is None:
            notes.append(f"{item}: no {role} candidate passes the filters")
            return
        if unit is None:
            unit, _raw = ctx.estimate(ctx.provider(cand), job)
        items.append(
            {
                "stage": st,
                "item": item,
                "model": cand["model"],
                "units": units,
                "unit_usd": round(unit, 5),
                "usd": round(unit * units, 4),
            }
        )

    def align_unit(minutes):
        cand = pick("align")
        if cand is None or cand["provider"] == "local":
            return 0.0
        return max(float(cand["cost"].get("usd") or 0.01) * minutes, cand["cost"].get("min_usd", 0.0))

    text = " ".join(["word"] * avg_words)
    wav_minutes = line_seconds / 60
    reviewers_video = 1 + len(film["audience"]) + 1  # director, personas, originality
    reviewers_text = len(film["audience"])  # comparers
    # a $0 film (budget 0) is reviewed by Claude subagents through review.py ingest, not the critic
    # (the same rule as preflight.required_roles)
    critic = film["budget_usd"] > 0
    if not critic:
        notes.append("budget 0: no critic calls quoted (reviews are Claude subagents via review.py ingest)")
    if film["voice"]["mode"] != "none":
        add("preflight", "tts probe", "tts", "final", 1, text="Testing one two three.")
        add("preflight", "align probe", "align", "final", 1, unit=align_unit(0.05))
        auditions = 6 if film["voice"]["mode"] == "audition" else 0
        n_takes = film["voice"]["takes"]
        takes = n_lines * n_takes
        if auditions:
            add("voice", f"auditions ({auditions} voices x 1 line)", "tts", "final", auditions, text=text)
            if critic:
                add(
                    "voice",
                    "audition pick (critic, 1 call)",
                    "critic",
                    "final",
                    1,
                    prompt="x" * JUDGE_PROMPT_CHARS,
                    audio=["takes"],
                    media_seconds=auditions * line_seconds,
                )
        add("voice", f"takes ({n_lines} lines x {n_takes})", "tts", "final", takes, text=text)
        n = takes + auditions + n_lines
        add(
            "voice",
            f"transcript checks + final alignment ({n} files)",
            "align",
            "final",
            n,
            unit=align_unit(wav_minutes),
        )
        if critic:
            calls = math.ceil(n_lines / TAKE_PICK_LINES)
            add(
                "voice",
                f"take picks (critic, {TAKE_PICK_LINES} lines per call)",
                "critic",
                "final",
                calls,
                prompt="x" * JUDGE_PROMPT_CHARS,
                audio=["takes"],
                media_seconds=min(n_lines, TAKE_PICK_LINES) * n_takes * line_seconds,
            )
    if critic:
        add("preflight", "critic probe", "critic", "final", 1, prompt="Reply with OK.")
    art = film["art"]
    if art["mode"] == "generated" and art["sheets"]:
        if art["draft_first"]:
            add("animatic", f"draft sheets ({art['sheets']} at 1K)", "image", "draft", art["sheets"])
        add("assets", f"final sheets ({art['sheets']})", "image", "final", art["sheets"])
    if critic:
        add(
            "animatic",
            "animatic critic pass",
            "critic",
            "draft",
            1,
            prompt="x" * JUDGE_PROMPT_CHARS,
            video=True,
            media_seconds=film["duration"],
        )
    if film["music"]["mode"] == "generated":
        n_music = film["music"]["candidates"]
        add("assets", f"music candidates ({n_music})", "music", "final", n_music)
        if critic:
            add(
                "assets",
                "music pick (critic, 1 call)",
                "critic",
                "final",
                1,
                prompt="x" * JUDGE_PROMPT_CHARS,
                audio=["candidates"],
                media_seconds=n_music * film["duration"],
            )
    done = rounds_done(film_dir)
    rounds = max(0, film["review"]["rounds"] - done)
    if critic and rounds:
        add(
            "review",
            f"video reviews ({rounds} rounds x {reviewers_video})",
            "critic",
            "final",
            rounds * reviewers_video,
            prompt="x" * REVIEW_PROMPT_CHARS,
            video=True,
            media_seconds=film["duration"],
        )
        add(
            "review",
            f"audio reviews ({rounds} rounds)",
            "critic",
            "final",
            rounds,
            prompt="x" * REVIEW_PROMPT_CHARS,
            audio=["mix"],
            media_seconds=film["duration"],
        )
        add(
            "review",
            f"comparer passes ({rounds} rounds x {reviewers_text})",
            "critic",
            "final",
            rounds * reviewers_text,
            prompt="x" * REVIEW_PROMPT_CHARS,
        )
        add(
            "review",
            "sign-off director pass",
            "critic",
            "signoff",
            1,
            prompt="x" * REVIEW_PROMPT_CHARS,
            video=True,
            media_seconds=film["duration"],
        )

    chosen = [i for i in items if stage == "all" or i["stage"] == stage]
    total = round(sum(i["usd"] for i in chosen), 4)
    status = ctx.ledger.status() if (film_dir / "ledger.jsonl").exists() else {"spent": 0.0, "reserved": 0.0}
    remaining = round(film["budget_usd"] - status["spent"] - status["reserved"], 4)
    return {
        "stage": stage,
        "items": chosen,
        "total": total,
        "budget": film["budget_usd"],
        "spent": status["spent"],
        "remaining": remaining,
        "fits": total <= remaining + 1e-9,
        "notes": notes,
        "assumptions": {
            "script_words": words,
            "lines": n_lines,
            "avg_line_seconds": round(line_seconds, 2),
            "review_rounds": rounds,
            "review_rounds_done": done,
            "personas": len(film["audience"]),
        },
    }


def _knob(film, path):
    if path == ("audience",):
        return len(film["audience"])
    return film[path[0]].get(path[1])


def _turn(film, path, value):
    out = copy.deepcopy(film)
    if path == ("audience",):
        out["audience"] = out["audience"][:value]
    else:
        out[path[0]][path[1]] = value
    return out


def fit_plan(film, film_dir, ctx=None, stage="all"):
    """What to change so the quote fits: FIT_STEPS in order, each applied on top of the ones before,
    a numeric knob lowered only as far as needed. -> [{change, from, to, why, saves, total, fits}]."""
    ctx = ctx or Context(Path(film_dir), film)
    first = build_quote(film, film_dir, ctx, stage)
    remaining, base, cur, steps = first["remaining"], first["total"], film, []
    if first["fits"]:
        return steps
    for path, floor, why in FIT_STEPS:
        before = _knob(cur, path)
        if before is None or (before is floor if isinstance(floor, bool) else before <= floor):
            continue
        values = [floor] if isinstance(floor, bool) else list(range(before - 1, floor - 1, -1))
        best = None
        for v in values:  # the smallest change that fits, else the floor
            q = build_quote(_turn(cur, path, v), film_dir, ctx, stage)
            best = (v, q["total"])
            if q["total"] <= remaining + 1e-9:
                break
        v, total = best
        if total >= base - 1e-9:
            continue  # this knob costs nothing in this stage
        steps.append(
            {
                "change": "audience" if path == ("audience",) else ".".join(path),
                "from": before,
                "to": v,
                "why": why,
                "saves": round(base - total, 4),
                "total": total,
                "fits": total <= remaining + 1e-9,
            }
        )
        cur, base = _turn(cur, path, v), total
        if steps[-1]["fits"]:
            break
    return steps


def print_quote(q):
    s = q["assumptions"]
    print(
        f"quote ({q['stage']}): {s['script_words']} words in {s['lines']} lines, {s['review_rounds']} review "
        f"rounds to go ({s['review_rounds_done']} done), {s['personas']} persona(s)"
    )
    print(f"  {'stage':10} {'item':52} {'model':36} {'units':>5} {'each':>9} {'total':>9}")
    for i in q["items"]:
        each, total = usd(i["unit_usd"]), usd(i["usd"])
        print(f"  {i['stage']:10} {i['item'][:52]:52} {i['model'][:36]:36} {i['units']:>5} {each:>9} {total:>9}")
    for n in q["notes"]:
        print(f"  note: {n}")
    print(
        f"  total {usd(q['total'])}  budget {usd(q['budget'])}  spent {usd(q['spent'])}  "
        f"remaining {usd(q['remaining'])}  -> {'fits' if q['fits'] else 'DOES NOT FIT'}"
    )
    if q.get("to_fit") is not None:
        if not q["to_fit"]:
            print("  to fit: no film.json knob is left to turn; raise budget_usd or cut the film (art.mode code)")
            return
        print(f"  to fit {usd(q['remaining'])}, change in film.json (least harm first; totals include the ones above):")
        for k, s_ in enumerate(q["to_fit"], 1):
            print(
                f"    {k}. {s_['change']} {s_['from']} -> {s_['to']}  ({s_['why']})  saves {usd(s_['saves'])}  "
                f"-> {usd(s_['total'])}{'  fits' if s_['fits'] else ''}"
            )
        if not q["to_fit"][-1]["fits"]:
            print("    still over: raise budget_usd, or make the art in code (art.mode code, $0)")


def main(argv=None):
    ap = parser("quote.py", __doc__)
    add_film_arg(ap)
    ap.add_argument("--stage", default="all", choices=("all",) + STAGES)
    ap.add_argument("--json", action="store_true", help="print JSON instead of the table")
    a = ap.parse_args(argv)
    film = load_film(a.film, required=False)
    if film is None:
        film, _ = validate_film({"topic": "-", "goal": "-", "message": "-"})
    q = build_quote(film, a.film, stage=a.stage)
    if not q["fits"]:
        q["to_fit"] = fit_plan(film, a.film, stage=a.stage)
    if Path(a.film).is_dir():
        write_json(Path(a.film) / "work" / "quote.json", q)
    if a.json:
        print(json.dumps(q, indent=1))
    else:
        print_quote(q)
    return 0 if q["fits"] else EXIT_BUDGET


if __name__ == "__main__":
    run_main(main)
