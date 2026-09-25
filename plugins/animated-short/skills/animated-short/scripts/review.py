#!/usr/bin/env python3
"""Review runner: every reviewer returns JSON valid against references/rubric.schema.json.

  run --round N --reviewer R --prompt-file P [--persona NAME] [--video F] [--audio F ...] [--images F ...]
      [--tier final|signoff] [--previous M]
        ask the critic (film context, intent notes and the schema are appended to the prompt), extract the
        first JSON object, validate it, retry once with the errors, save work/reviews/r<N>/<name>.json.
        --previous M appends the same reviewer's defects from round M and asks for each: fixed or still
        present (the "previous" field), then new defects. A sign-off (--tier signoff) always gets the
        round's counted defects (r<N>/gates.json) to confirm the same way.
  ingest --round N --file F [--persona NAME] [--force]
        validate and store a review written elsewhere (Claude subagents: fact_checker, frame_qa,
        script_persona, ...)
  technical --round N [--from DIR]
        the technical reviewer: node tools/qa.mjs check --json --cut r<N> (or an ffprobe/ebur128 fallback)
  gates --round N
        merge the round and compute every ship gate -> work/reviews/r<N>/gates.json; exit 0 ship, 1 iterate

Rounds are numbers; "<N>-fix" (work/reviews/r<N>-fix/) is the $0 fix pass after round N: it holds the new
technical review, frame QA of the changed frames and the sign-off; its gates read round N with those reviews
in place, and a counted defect of round N that a fix-pass review reports as fixed (and none as still
present) no longer counts.

Review names: <reviewer>[-<persona slug>][-signoff]. The gates read only files named that way in
work/reviews/r<N>/ (other files there are reported and ignored): Claude subagents write their JSON to
work/reviews/incoming/ and review.py ingest stores it under its name. A defect counts when it comes from a
measuring reviewer (technical, frame_qa, fact_checker), a still confirms it (work/reviews/r<N>/confirmed.json:
[{check, at?, still, note?}]), or a review of a different kind (not two personas) cites the same check id
within 2 s. maybe_intentional discounts a defect, except an ACC-* defect or a blocking one from a measuring
reviewer. The gates list unconfirmed blocking and major critic defects under to_confirm. Claims can be
accepted by the user in work/reviews/r<N>/accepted_claims.json (a list of claim texts). Explainer quiz scores
are out of the questions in work/direction/quiz.json. The technical gate needs the round's technical review
to ship.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import audiolib
import critic
import schema
from common import (
    add_film_arg,
    add_provider_args,
    context,
    is_fiction,
    load_film,
    load_schema,
    parser,
    read_json,
    run_main,
    script_lines,
    slug,
    write_json,
)
from providers.base import EXIT_GATE, UsageError

PERSONA_REVIEWERS = {"persona", "script_persona", "comparer"}
SELF_CONFIRMING = {"technical", "frame_qa", "fact_checker"}  # measuring reviewers: stills, text logs, sources
ROUND = re.compile(r"^([0-9]+)(-fix)?$")
TECH_GATES = [
    ("TECH-10", "every read held >= 1.2 s"),
    ("TECH-9", "text >= 28 px at 1080p"),
    ("TECH-11", "no on-screen sentence repeating the narration"),
    ("TECH-1", "duration within 1 s"),
    ("TECH-2", "loudness -14.5 +-0.5 LUFS"),
    ("TECH-3", "true peak <= -1 dBTP"),
    ("TECH-5", "captions (SRT + VTT)"),
    ("TECH-6", "transcript with every line"),
]
SPECIAL = {"gates.json", "confirmed.json", "accepted_claims.json"}


def round_label(value):
    """argparse type: "3" or "3-fix" (the fix pass after round 3) -> the label used in r<label>/."""
    m = ROUND.match(str(value).strip())
    if not m:
        raise argparse.ArgumentTypeError(f"{value!r}: a round number, or <N>-fix for the fix pass after round N")
    return f"{int(m.group(1))}{m.group(2) or ''}"


def round_parts(label):
    """-> (round number, is the fix pass)."""
    m = ROUND.match(str(label))
    return int(m.group(1)), bool(m.group(2))


def round_dir(film_dir, n):
    return Path(film_dir) / "work" / "reviews" / f"r{n}"


def persona_entry(film, name):
    """The film.json audience entry a name refers to: an exact (case-insensitive) match first, then a
    unique substring match either way; UsageError when the name is ambiguous or matches no persona."""
    low = str(name).strip().lower()
    people = film["audience"]
    exact = [p for p in people if p["name"].lower() == low]
    if exact:
        return exact[0]
    partial = [p for p in people if low and (low in p["name"].lower() or p["name"].lower() in low)]
    if len(partial) == 1:
        return partial[0]
    if partial:
        raise UsageError(
            f"persona {name!r} is ambiguous: it matches {', '.join(p['name'] for p in partial)}; pass the exact name"
        )
    raise UsageError(f"persona {name!r} is not in film.json audience ({', '.join(p['name'] for p in people)})")


def persona_slug(film, name):
    return slug(persona_entry(film, name)["name"])


def review_name(film, reviewer, persona=None, tier="final"):
    name = reviewer + (f"-{persona_slug(film, persona)}" if persona else "")
    return name + ("-signoff" if tier == "signoff" else "")


def review_names(film):
    """Every file stem review_name() can produce for this film -> the reviewer that file must hold."""
    reviewers = load_schema("rubric.schema.json")["properties"]["reviewer"]["enum"]
    names = {}
    for r in reviewers:
        stems = [f"{r}-{slug(p['name'])}" for p in film["audience"]] if r in PERSONA_REVIEWERS else [r]
        for stem in stems:
            names[stem] = names[stem + "-signoff"] = r
    return names


def extract_json(text):
    """First JSON object in a reply (fenced block first, then a balanced-brace scan)."""
    for m in re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S):
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


def check_review(doc, reviewer=None, cut=None):
    if not isinstance(doc, dict):
        return ["the reply holds no JSON object"]
    errs = schema.validate(load_schema("rubric.schema.json"), doc)
    if reviewer and doc.get("reviewer") != reviewer:
        errs.append(f"reviewer must be {reviewer!r}")
    if cut and doc.get("cut") != cut:
        errs.append(f"cut must be {cut!r}")
    return errs


def secs(at):
    m = re.match(r"^(\d{1,2}):(\d{2}(?:\.\d+)?)$", str(at or ""))
    return int(m.group(1)) * 60 + float(m.group(2)) if m else None


# ---------------------------------------------------------------- run
def fmt_defect(d, who=True):
    head = f"{d.get('review')} " if who and d.get("review") else ""
    return f"- {head}{d.get('at', '0:00')} {d.get('severity', '')} {d['check']}: {d.get('issue', '')}".rstrip()


ASK_PREVIOUS = (
    'For each one, look at the same moment in this cut and report it in "previous" as {"check", "at", '
    '"status": "fixed" or "still_present", "note"}. List every still-present one again in defects (same check '
    "id), then any NEW defect."
)


def previous_block(film, film_dir, n, reviewer, persona, tier, previous):
    """The same reviewer's defects (and scores) from round `previous`, to judge as fixed or still present."""
    names = [review_name(film, reviewer, persona, tier), review_name(film, reviewer, persona, "final")]
    d = round_dir(film_dir, previous)
    f = next((d / f"{x}.json" for x in names if (d / f"{x}.json").exists()), None)
    if f is None:
        print(f"review: no r{previous}/{names[-1]}.json to compare with; running without --previous", file=sys.stderr)
        return []
    doc = read_json(f)
    scores = ", ".join(f"{k} {v['value']}" for k, v in doc.get("scores", {}).items())
    defects = doc.get("defects") or []
    return [
        f"## Your review of the previous cut (r{previous})",
        f"Scores then: {scores or 'none'}. Score this cut on its own merits; keep the scale comparable.",
        "Defects you found then:" if defects else "You found no defects then.",
        *[fmt_defect(d, who=False) for d in defects],
        ASK_PREVIOUS if defects else "",
    ]


def signoff_block(film_dir, n):
    """The round's counted defects (r<N>/gates.json of the base round) for the sign-off director to confirm."""
    base, _fix = round_parts(n)
    g = read_json(round_dir(film_dir, base) / "gates.json", default={})
    counted = g.get("counted_defects") or []
    if not counted:
        return []
    return [
        "## Defects the round's reviewers found (counted after checking)",
        *[fmt_defect(d) for d in counted],
        ASK_PREVIOUS,
    ]


def build_prompt(film, film_dir, n, reviewer, base, persona=None, intent_file=None, previous=None, tier="final"):
    parts = [
        base.strip(),
        "## Film",
        f"Title: {film['title']} ({film['form']}, {film['duration']} s, {film['aspect']}).",
        f"Goal: {film['goal']}",
        f"Message (the one sentence viewers should repeat): {film['message']}",
    ]
    if persona:
        p = persona_entry(film, persona)
        persona = p["name"]
        parts.append(
            f"Persona: {p['name']}. Already knows: {p['knows']}." + (f" Wants: {p['wants']}." if p.get("wants") else "")
        )
    if reviewer in ("originality", "director") and film["style"]["banned_patterns"]:
        parts.append(
            "Banned patterns (report any you see in banned_patterns_seen): "
            + "; ".join(film["style"]["banned_patterns"])
        )
    if reviewer == "comparer":
        pf = round_dir(film_dir, n) / f"persona-{persona_slug(film, persona)}.json"
        if not pf.exists():
            raise UsageError(f"comparer needs the persona review first ({pf})")
        parts.append(f"Persona takeaway to judge: {read_json(pf).get('takeaway', '')!r}")
    intent = Path(intent_file) if intent_file else Path(film_dir) / "work" / "direction" / "intent-notes.md"
    if intent.exists():
        parts += [
            "## Intent notes (deliberate choices; do not report them as defects)",
            intent.read_text(encoding="utf-8").strip(),
        ]
    if previous is not None:
        parts += previous_block(film, film_dir, n, reviewer, persona, tier, previous)
    if tier == "signoff":
        parts += signoff_block(film_dir, n)
    parts = [p for p in parts if p]
    who = f', "persona": "{persona}"' if persona else ""
    parts += [
        "## Output",
        f'Return ONLY one JSON object, no prose before or after, valid against the JSON Schema below. Set "reviewer": '
        f'"{reviewer}" and "cut": "r{n}"{who}. Times are "m:ss" or "m:ss.s". Cite checklist ids in defects[].check. '
        "Mark a defect maybe_intentional when it could be a deliberate style choice, never when something shown "
        "or said is false.",
        json.dumps(load_schema("rubric.schema.json"), separators=(",", ":")),
    ]
    return "\n\n".join(parts)


def cmd_run(a):
    film = load_film(a.film)
    ctx = context(a, film)
    if a.reviewer in PERSONA_REVIEWERS and not a.persona:
        raise UsageError(f"--persona is required for {a.reviewer}")
    cut = f"r{a.round}"
    prompt = build_prompt(
        film,
        a.film,
        a.round,
        a.reviewer,
        Path(a.prompt_file).read_text(encoding="utf-8"),
        a.persona,
        a.intent_file,
        a.previous,
        a.tier,
    )
    name = review_name(film, a.reviewer, a.persona, a.tier)
    d = round_dir(a.film, a.round)
    (d / "raw").mkdir(parents=True, exist_ok=True)
    doc, errs, attempt_prompt = None, [], prompt
    for attempt in (1, 2):
        text, rec = critic.ask(
            ctx,
            attempt_prompt,
            a.video,
            a.audio or [],
            a.images or [],
            a.tier,
            a.model,
            f"{cut}-{name}-{attempt}",
            a.max_mib,
            stage="review",
            use_cache=not a.no_cache,
        )
        (d / "raw" / f"{name}-{attempt}.txt").write_text(text, encoding="utf-8")
        doc = extract_json(text)
        if isinstance(doc, dict) and a.persona and "persona" not in doc:
            doc["persona"] = persona_entry(film, a.persona)["name"]
        errs = check_review(doc, a.reviewer, cut)
        if not errs:
            break
        print(f"review: attempt {attempt} invalid ({len(errs)} errors)", file=sys.stderr)
        attempt_prompt = (
            prompt
            + "\n\n## Your previous reply was not valid\n"
            + "\n".join(f"- {e}" for e in errs[:20])
            + "\n\nPrevious reply (for reference):\n"
            + text[:3000]
            + "\n\nReturn ONLY the corrected JSON object."
        )
    if errs:
        write_json(d / "raw" / f"{name}.errors.json", errs)
        print(f"review: {name} still invalid after a retry; raw replies in {d / 'raw'}", file=sys.stderr)
        return EXIT_GATE
    write_json(d / f"{name}.json", doc)
    print_summary(name, doc)
    return 0


def print_summary(name, doc):
    sc = ", ".join(f"{k} {v['value']}" for k, v in doc.get("scores", {}).items())
    extra = []
    if "matches_message" in doc:
        extra.append(f"matches_message {doc['matches_message']}")
    if doc.get("quiz"):
        extra.append(f"quiz {sum(1 for q in doc['quiz'] if q['correct'])}/{len(doc['quiz'])}")
    if doc.get("learned"):
        extra.append(f"learned {len(doc['learned'])}")
    print(
        f"{name}: {doc['verdict']}; {sc or 'no scores'}; {len(doc.get('defects', []))} defects"
        + (f"; {'; '.join(extra)}" if extra else "")
    )


# ---------------------------------------------------------------- ingest / technical
def cmd_ingest(a):
    film = load_film(a.film)
    doc = read_json(a.file)
    cut = f"r{a.round}"
    errs = check_review(doc, cut=cut)
    if errs:
        print("ingest: invalid review:\n  " + "\n  ".join(errs), file=sys.stderr)
        return EXIT_GATE
    persona = a.persona or (doc.get("persona") if doc["reviewer"] in PERSONA_REVIEWERS else None)
    if doc["reviewer"] in PERSONA_REVIEWERS and not persona:
        raise UsageError(f"{doc['reviewer']} reviews need --persona (or a persona field)")
    name = review_name(film, doc["reviewer"], persona, a.tier)
    out = round_dir(a.film, a.round) / f"{name}.json"
    if out.exists() and not a.force:
        raise UsageError(f"{out} exists (use --force to replace it)")
    write_json(out, doc)
    print_summary(name, doc)
    return 0


def technical_fallback(film, film_dir, n, out_dir):
    """Duration, loudness, true peak, captions and transcript with ffprobe/ffmpeg when qa.mjs is absent."""
    if not audiolib.has_ffmpeg():
        raise UsageError("no tools/qa.mjs in the film and no ffmpeg: cannot run technical checks")
    checks, defects = [], []

    def add(cid, name, ok, value, issue, fix):
        checks.append({"id": cid, "name": name, "ok": ok, "value": value})
        if not ok:
            defects.append({"at": "0:00", "severity": "blocking", "check": cid, "issue": issue, "fix": fix})

    vids = sorted(out_dir.glob("*.mp4"))
    durs, loud = [], []
    for v in vids:
        info = critic.probe_media(v)
        durs.append((v.name, info["duration"] or 0))
        r = audiolib.run(
            ["ffmpeg", "-nostats", "-i", str(v), "-af", "ebur128=peak=true", "-f", "null", "-"], check=False
        )
        tail = r.stderr[r.stderr.rfind("Summary:") :]
        i = re.search(r"I:\s+(-?[\d.]+) LUFS", tail)
        p = re.search(r"Peak:\s+(-?[\d.]+) dBFS", tail)
        loud.append((v.name, float(i.group(1)) if i else None, float(p.group(1)) if p else None))
    add(
        "TECH-1",
        "duration within 1 s of the film",
        bool(vids) and all(abs(d - film["duration"]) <= 1 for _, d in durs),
        ", ".join(f"{k} {d:.2f} s" for k, d in durs) or "no MP4",
        "duration off or no MP4",
        "export again",
    )
    add(
        "TECH-2",
        "integrated loudness -14.5 +-0.5 LUFS",
        bool(loud) and all(i is not None and abs(i + 14.5) <= 0.5 for _, i, _ in loud),
        ", ".join(f"{k} {i} LUFS" for k, i, _ in loud) or "nothing measured",
        "loudness off target",
        "export again",
    )
    add(
        "TECH-3",
        "true peak <= -1 dBTP",
        bool(loud) and all(p is not None and p <= -1 for _, _, p in loud),
        ", ".join(f"{k} {p} dBTP" for k, _, p in loud) or "nothing measured",
        "true peak too high",
        "export with a lower ceiling",
    )
    srt, vtt = list(out_dir.glob("*.srt")), list(out_dir.glob("*.vtt"))
    add(
        "TECH-5",
        "captions: SRT and VTT",
        bool(srt and vtt),
        f"{len(srt)} srt, {len(vtt)} vtt",
        "captions missing",
        "export again",
    )
    tr = out_dir / "transcript.md"
    text = re.sub(r"\s+", " ", tr.read_text(encoding="utf-8")) if tr.exists() else None
    missing = [
        ln["id"] for ln in script_lines(film_dir) if text is None or re.sub(r"\s+", " ", ln["text"]).strip() not in text
    ]
    add(
        "TECH-6",
        "transcript with every narration line",
        text is not None and not missing,
        "missing" if text is None else f"{len(missing)} lines missing",
        "transcript incomplete",
        "export again",
    )
    return {
        "reviewer": "technical",
        "cut": f"r{n}",
        "scores": {},
        "defects": defects,
        "verdict": "iterate" if defects else "ship",
        "checks": checks,
    }


def cmd_technical(a):
    film = load_film(a.film)
    film_dir = Path(a.film).resolve()
    qa = film_dir / "tools" / "qa.mjs"
    if qa.exists() and audiolib.which("node"):
        cmd = ["node", str(qa), "check", "--json", "--cut", f"r{a.round}", "--film", str(film_dir)]
        if a.from_dir:
            cmd += ["--from", str(Path(a.from_dir).resolve())]
        r = subprocess.run(cmd, cwd=film_dir, capture_output=True, text=True, timeout=3600)
        try:
            doc = json.loads(r.stdout)
        except json.JSONDecodeError:
            raise UsageError(
                f"qa.mjs check produced no JSON (exit {r.returncode}): {r.stderr.strip()[-400:]}"
            ) from None
    else:
        doc = technical_fallback(
            film, film_dir, a.round, Path(a.from_dir) if a.from_dir else film_dir / film["output_dir"]
        )
    errs = check_review(doc, "technical", f"r{a.round}")
    if errs:
        raise UsageError("technical review JSON does not match the rubric: " + "; ".join(errs[:5]))
    write_json(round_dir(film_dir, a.round) / "technical.json", doc)
    for c in doc.get("checks", []):
        print(f"  {'ok  ' if c['ok'] else 'FAIL'} {c['id']:8} {c.get('name', '')}: {c.get('value', '')}")
    print(f"technical (r{a.round}): {doc['verdict']}, {len(doc['defects'])} defects")
    return 0 if doc["verdict"] == "ship" else EXIT_GATE


# ---------------------------------------------------------------- gates
def load_round(film, film_dir, n):
    """-> (reviews by name, invalid files, ignored files). Only names review_name() produces are read."""
    d = round_dir(film_dir, n)
    if not d.is_dir():
        raise UsageError(f"{d} does not exist: run some reviews first")
    names = review_names(film)
    reviews, invalid, ignored = {}, [], []
    for f in sorted(d.glob("*.json")):
        if f.name in SPECIAL:
            continue
        if f.stem not in names:
            ignored.append(f.name)
            print(
                f"gates: ignoring {f.name}: not a review name (<reviewer>[-<persona slug>][-signoff]); "
                "store reviews with review.py ingest",
                file=sys.stderr,
            )
            continue
        doc = read_json(f)
        errs = check_review(doc)
        if not errs and doc["reviewer"] != names[f.stem]:
            errs = [f"the file name says {names[f.stem]!r} but the review's reviewer is {doc['reviewer']!r}"]
        if errs:
            invalid.append({"file": f.name, "errors": errs[:5]})
        else:
            reviews[f.stem] = doc
    return reviews, invalid, ignored


def never_intentional(reviewer, d):
    """An accuracy defect, or a blocking one from a measuring reviewer, is never waved through as a
    deliberate choice: an intent note must not launder a false claim or a broken frame."""
    return str(d["check"]).upper().startswith("ACC") or (reviewer in SELF_CONFIRMING and d["severity"] == "blocking")


def judge_defects(reviews, confirmed):
    counted, discounted = [], []
    flat = [(name, doc["reviewer"], d) for name, doc in reviews.items() for d in doc.get("defects", [])]
    for name, reviewer, d in flat:
        item = dict(d, review=name)
        t = secs(d.get("at"))
        if d.get("maybe_intentional") is True and not never_intentional(reviewer, d):
            discounted.append(dict(item, why="maybe intentional"))
            continue
        if reviewer in SELF_CONFIRMING:
            counted.append(dict(item, why=f"{reviewer} measures or checks stills"))
            continue
        still = next(
            (
                c
                for c in confirmed
                if c.get("check") == d["check"]
                and (c.get("at") is None or t is None or abs((secs(c["at"]) or 0) - t) <= 2)
            ),
            None,
        )
        if still:
            counted.append(dict(item, why=f"confirmed by still {still.get('still', '')}".strip()))
            continue
        # a second opinion must come from another kind of reviewer: two personas (or a director and its
        # sign-off) watching the same cut share the same blind spots
        twin = next(
            (
                o
                for o, orev, od in flat
                if orev != reviewer
                and od["check"] == d["check"]
                and (t is None or secs(od.get("at")) is None or abs(secs(od.get("at")) - t) <= 2)
            ),
            None,
        )
        if twin:
            counted.append(dict(item, why=f"also reported by {twin}"))
            continue
        discounted.append(dict(item, why="unconfirmed: needs a still (confirmed.json) or a reviewer of another kind"))
    return counted, discounted


def to_confirm(discounted):
    """Unconfirmed blocking and major critic defects: each needs a still (confirmed.json) or a dismissal."""
    return [
        {k: d.get(k) for k in ("review", "at", "severity", "check", "issue")}
        for d in discounted
        if d["why"].startswith("unconfirmed") and d["severity"] in ("blocking", "major")
    ]


def fixed_in_pass(counted, fix_reviews):
    """Split round N's counted defects by the fix pass's verdicts: -> (still counted, fixed). A defect is
    fixed when a fix-pass review reports it fixed (same check, within 2 s) and none reports it present."""
    marks = [(name, p) for name, doc in fix_reviews.items() for p in doc.get("previous") or []]

    def match(p, d):
        t, pt = secs(d.get("at")), secs(p.get("at"))
        return p["check"] == d["check"] and (t is None or pt is None or abs(t - pt) <= 2)

    still, fixed = [], []
    for d in counted:
        hits = [(name, p) for name, p in marks if match(p, d)]
        if hits and all(p["status"] == "fixed" for _, p in hits):
            fixed.append(dict(d, why=f"fixed in the fix pass ({', '.join(sorted({n for n, _ in hits}))})"))
        else:
            still.append(d)
    return still, fixed


def quiz_questions(film_dir):
    """The number of questions in the answer key (work/direction/quiz.json); UsageError when missing or empty."""
    p = Path(film_dir) / "work" / "direction" / "quiz.json"
    if not p.exists():
        raise UsageError(
            f"{p} not found: an explainer's quiz gate is scored against its answer key "
            "(written at script time; review-prompts.md, Quiz)"
        )
    doc = read_json(p)
    questions = doc.get("questions") if isinstance(doc, dict) else None
    if not isinstance(questions, list) or not questions:
        raise UsageError(f'{p} must be {{"questions": [{{"q", "a", "accept"}}, ...]}} with at least one question')
    return len(questions)


def round_extras(d):
    """confirmed.json and accepted_claims.json of one round directory, checked."""
    confirmed = read_json(d / "confirmed.json", default=[])
    accepted = read_json(d / "accepted_claims.json", default=[])
    if not (isinstance(confirmed, list) and all(isinstance(c, dict) and c.get("check") for c in confirmed)):
        raise UsageError(f"{d / 'confirmed.json'} must be a list of {{check, at?, still, note?}}")
    if not (isinstance(accepted, list) and all(isinstance(t, str) for t in accepted)):
        raise UsageError(f"{d / 'accepted_claims.json'} must be a list of claim texts")
    return confirmed, accepted


def compute_gates(film, film_dir, n):
    base_n, fix = round_parts(n)
    reviews, invalid, ignored = load_round(film, film_dir, n)
    confirmed, accepted = round_extras(round_dir(film_dir, n))
    fix_reviews = {}
    if fix:  # the fix pass: round N's reviews, with the pass's own reviews in place of theirs
        base, base_invalid, base_ignored = load_round(film, film_dir, base_n)
        fix_reviews, reviews = reviews, dict(base, **reviews)
        invalid, ignored = base_invalid + invalid, base_ignored + ignored
        more_confirmed, more_accepted = round_extras(round_dir(film_dir, base_n))
        confirmed, accepted = more_confirmed + confirmed, more_accepted + accepted
    accepted = set(accepted)
    counted, discounted = judge_defects(reviews, confirmed)
    fixed = []
    if fix:
        still, fixed = fixed_in_pass([c for c in counted if c["review"] not in fix_reviews], fix_reviews)
        counted = still + [c for c in counted if c["review"] in fix_reviews]
    gates = []

    def gate(gid, name, ok, evidence):
        gates.append({"id": gid, "name": name, "pass": bool(ok), "evidence": evidence})

    rv = film["review"]
    directors = {k: v for k, v in reviews.items() if v["reviewer"] == "director"}
    decisive = {k: v for k, v in directors.items() if k.endswith("-signoff")} or directors
    overall = [(k, v.get("scores", {}).get("overall", {}).get("value")) for k, v in decisive.items()]
    gate(
        "director",
        f"director overall >= {rv['director_min']}",
        overall and all(o is not None and o >= rv["director_min"] for _, o in overall),
        ", ".join(f"{k} {o}" for k, o in overall) or "no director review",
    )
    blocking = [c for c in counted if c["severity"] == "blocking"]
    gate(
        "blocking",
        "no blocking defects (counted)",
        not blocking,
        "; ".join(f"{c['review']} {c['check']} {c['at']}: {c['issue']}" for c in blocking[:6]) or "none",
    )
    slugs = [slug(p["name"]) for p in film["audience"]]
    comp = {s: reviews.get(f"comparer-{s}") for s in slugs}
    gate(
        "message",
        "every persona takeaway matches the message (comparer)",
        all(c and c.get("matches_message") is True for c in comp.values()),
        ", ".join(f"{s}: {'missing' if c is None else c.get('matches_message')}" for s, c in comp.items()),
    )
    if film["form"] == "explainer":
        n_questions = quiz_questions(film_dir)
        ev_q, ev_l, ok_q, ok_l = [], [], True, True
        for s in slugs:
            p = reviews.get(f"persona-{s}")
            if p is None:
                ok_q = ok_l = False
                ev_q.append(f"{s}: missing")
                ev_l.append(f"{s}: missing")
                continue
            quiz = p.get("quiz", [])
            # scored out of the answer key, so a question the persona skipped counts as wrong
            right = min(sum(1 for q in quiz if q["correct"]), n_questions)
            frac = right / n_questions
            ok_q &= frac >= rv["quiz_min"]
            ok_l &= len(p.get("learned", [])) >= rv["learnings_min"]
            ev_q.append(f"{s}: {right}/{n_questions} ({frac:.0%}; {len(quiz)} answered)")
            ev_l.append(f"{s}: {len(p.get('learned', []))}")
        gate("quiz", f"quiz >= {rv['quiz_min']:.0%} per persona (explainer)", ok_q, ", ".join(ev_q))
        gate("learned", f">= {rv['learnings_min']} concrete learnings per persona (explainer)", ok_l, ", ".join(ev_l))
    orig = [v for v in reviews.values() if v["reviewer"] == "originality"] or list(decisive.values())
    o_scores = [v.get("scores", {}).get("originality", {}).get("value") for v in orig]
    o_scores = [s for s in o_scores if s is not None]
    seen = sorted({p for v in reviews.values() for p in v.get("banned_patterns_seen", [])})
    gate(
        "originality",
        f"originality >= {rv['originality_min']} and no banned pattern",
        bool(o_scores) and min(o_scores) >= rv["originality_min"] and not seen,
        f"scores {o_scores or 'missing'}; banned seen: {', '.join(seen) or 'none'}",
    )
    fiction = is_fiction(film)
    claims = [c for v in reviews.values() if v["reviewer"] == "fact_checker" for c in v.get("claims", [])]
    has_fc = any(v["reviewer"] == "fact_checker" for v in reviews.values())
    off = [c for c in claims if c["status"] == "offscreen_violation"]
    open_claims = [
        c for c in claims if c["status"] not in ("verified", "offscreen_violation") and c["text"] not in accepted
    ]
    if fiction and not has_fc:
        gate("claims", "claims verified or accepted; no off-screen violations", True, "fiction (no fact sources)")
    else:
        gate(
            "claims",
            "claims verified or accepted; no off-screen violations",
            has_fc and not off and not open_claims,
            "no fact_checker review"
            if not has_fc
            else f"{len(claims)} claims; open: {len(open_claims)}; off-screen violations: {len(off)}"
            + (f" (e.g. {open_claims[0]['text'][:60]!r})" if open_claims else ""),
        )
    tech = reviews.get("technical")
    tech_defects = sorted({x["check"] for x in (tech or {}).get("defects", [])})
    gate(
        "technical",
        "technical review ships (no TECH defect of any severity)",
        tech is not None and tech["verdict"] == "ship" and not tech_defects,
        "no technical review (review.py technical)"
        if tech is None
        else f"verdict {tech['verdict']}" + (f"; defects {', '.join(tech_defects)}" if tech_defects else ""),
    )
    checks = {c["id"]: c for c in (tech or {}).get("checks", [])}
    for cid, name in TECH_GATES:
        c = checks.get(cid)
        gate(
            cid.lower(),
            name,
            bool(c and c["ok"]),
            "no technical review (review.py technical)"
            if tech is None
            else (f"{c.get('value')}" if c else "check missing"),
        )
    ship = all(g["pass"] for g in gates) and not invalid
    last = base_n >= rv["rounds"]
    out = {
        "round": n if fix else base_n,
        "verdict": "ship" if ship else ("stop" if last else "iterate"),
        "gates": gates,
        "reviews": sorted(reviews),
        "invalid": invalid,
        "ignored": ignored,
        "counted_defects": counted,
        "discounted_defects": discounted,
        "to_confirm": to_confirm(discounted),
        "max_rounds_reached": last and not ship,
        "note": ("max review rounds reached: stop and report the open gates to the user" if last and not ship else ""),
    }
    if fix:
        out.update(base_round=base_n, fixed_defects=fixed, fix_pass_reviews=sorted(fix_reviews))
    return out


def cmd_gates(a):
    film = load_film(a.film)
    res = compute_gates(film, a.film, a.round)
    write_json(round_dir(a.film, a.round) / "gates.json", res)
    if a.json:
        print(json.dumps(res, indent=1))
    else:
        for g in res["gates"]:
            print(f"  {'PASS' if g['pass'] else 'FAIL'} {g['id']:12} {g['name']}: {g['evidence']}")
        for i in res["invalid"]:
            print(f"  INVALID {i['file']}: {'; '.join(i['errors'])}")
        for name in res["ignored"]:
            print(f"  IGNORED {name} (not a review name)")
        if res.get("fixed_defects"):
            print(f"  fixed in the fix pass ({len(res['fixed_defects'])}):")
            for d in res["fixed_defects"]:
                print("    " + fmt_defect(d))
        if res["counted_defects"]:
            print(f"  counted defects ({len(res['counted_defects'])}): fix the blocking ones; fix majors when you can")
            for d in res["counted_defects"]:
                print("    " + fmt_defect(d))
        if res["to_confirm"]:
            print(
                f"  TO CONFIRM ({len(res['to_confirm'])} unconfirmed blocking or major critic defects): render the "
                "moment and add it to confirmed.json with its still, or dismiss it in the intent notes"
            )
            for d in res["to_confirm"]:
                print("    " + fmt_defect(d))
        print(
            f"gates r{a.round}: {res['verdict'].upper()} ({len(res['counted_defects'])} counted defects, "
            f"{len(res['discounted_defects'])} discounted){(' - ' + res['note']) if res['note'] else ''}"
        )
    return 0 if res["verdict"] == "ship" else EXIT_GATE


def main(argv=None):
    ap = parser("review.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rnd = {"type": round_label, "required": True, "help": "round number, or <N>-fix for the fix pass after round N"}
    r = sub.add_parser("run", help="run one critic review and validate it")
    add_film_arg(r)
    add_provider_args(r)
    r.add_argument("--round", **rnd)
    r.add_argument(
        "--reviewer",
        required=True,
        choices=[
            "director",
            "persona",
            "audio",
            "script_persona",
            "comparer",
            "originality",
            "frame_qa",
            "fact_checker",
        ],
    )
    r.add_argument("--prompt-file", required=True)
    r.add_argument("--persona", help="audience persona name (persona, script_persona, comparer)")
    r.add_argument("--video")
    r.add_argument("--audio", nargs="*")
    r.add_argument("--images", nargs="*")
    r.add_argument(
        "--tier", default="final", choices=("final", "signoff"), help="signoff escalates to the stronger model"
    )
    r.add_argument("--model")
    r.add_argument("--intent-file", help="intent notes (default: work/direction/intent-notes.md)")
    r.add_argument(
        "--previous",
        type=round_label,
        help="a round whose review by the same reviewer is appended: each earlier defect is judged fixed or still "
        "present, then new ones are listed (use the last round from round 2 on)",
    )
    r.add_argument("--max-mib", type=float, default=20.0)
    i = sub.add_parser("ingest", help="validate and store a review JSON produced elsewhere")
    add_film_arg(i)
    i.add_argument("--round", **rnd)
    i.add_argument("--file", required=True)
    i.add_argument("--persona")
    i.add_argument("--tier", default="final", choices=("final", "signoff"))
    i.add_argument("--force", action="store_true")
    t = sub.add_parser("technical", help="run the technical checks as a rubric review")
    add_film_arg(t)
    t.add_argument("--round", **rnd)
    t.add_argument("--from", dest="from_dir", help="deliverables directory (default: the film's output dir)")
    g = sub.add_parser("gates", help="compute the ship gates for a round")
    add_film_arg(g)
    g.add_argument("--round", **rnd)
    g.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    return {"run": cmd_run, "ingest": cmd_ingest, "technical": cmd_technical, "gates": cmd_gates}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
