#!/usr/bin/env python3
"""Spend ledger CLI for one film (<film>/ledger.jsonl). The ledger itself is providers/ledger.py.

status     spent, open reservations, remaining budget, per role, per stage, per basis
reconcile  compare the account's usage delta (GET /key, free) since the film's first paid call
           with what the ledger recorded; warn on drift
release    close reservations left open by a crashed run (they hold budget until released)
"""

import json
import sys

from common import add_film_arg, add_provider_args, context, load_film, parser, run_main, usd, write_json
from providers.ledger import Ledger


def cmd_status(a):
    film = load_film(a.film)
    led = Ledger(f"{a.film}/ledger.jsonl", film["budget_usd"])
    t = led.status()
    if a.json:
        print(json.dumps(t, indent=1))
        return 0
    print(
        f"budget {usd(t['budget'])}  spent {usd(t['spent'])}  reserved {usd(t['reserved'])}  "
        f"remaining {usd(t['remaining'])}"
    )
    print(f"calls {t['calls']} (cache hits {t['cache_hits']}), released {t['released']}, open {len(t['open'])}")
    for bucket in ("by_role", "by_stage", "by_basis"):
        if t[bucket]:
            print(f"  {bucket[3:]:6}", "  ".join(f"{k} {usd(v)}" for k, v in sorted(t[bucket].items())))
    return 0


def cmd_reconcile(a):
    ctx = context(a)
    try:
        now = ctx.client().usage()
    except Exception as e:  # noqa: BLE001 -- report any failure to read usage as an env error
        print(f"ledger: cannot read account usage ({e})", file=sys.stderr)
        return 2
    r = ctx.ledger.reconcile(now)
    write_json(f"{a.film}/work/reconcile.json", r)
    if r["anchor"] is None:
        print(f"reconcile: {r['note']}")
        return 0
    print(
        f"reconcile: account delta {usd(r['delta'])} vs ledger {usd(r['ledger_spent'])}  drift {r['drift']:+.4f}"
        f"  {'ok' if r['ok'] else 'WARN'}{(' - ' + r['note']) if r['note'] else ''}"
    )
    return 0 if r["ok"] else 1


def cmd_release(a):
    film = load_film(a.film)
    led = Ledger(f"{a.film}/ledger.jsonl", film["budget_usd"])
    open_ids = set(led.status()["open"])
    ids = sorted(open_ids) if a.all_open else a.id
    if not ids:
        print("release: nothing to release")
        return 0
    for rid in ids:
        if rid not in open_ids:
            print(f"release: {rid} is not an open reservation", file=sys.stderr)
            return 2
        led.append({"op": "release", "id": rid, "reason": a.reason})
        print(f"released {rid}")
    return 0


def main(argv=None):
    ap = parser("ledger.py", __doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status", help="spent / reserved / remaining, per role and stage")
    add_film_arg(s)
    s.add_argument("--json", action="store_true", help="print JSON")
    r = sub.add_parser("reconcile", help="compare GET /key usage delta with the ledger (free call)")
    add_film_arg(r)
    add_provider_args(r)
    x = sub.add_parser("release", help="release reservations a crashed run left open")
    add_film_arg(x)
    x.add_argument("id", nargs="*", help="reservation ids (see status --json 'open')")
    x.add_argument("--all-open", action="store_true", help="release every open reservation")
    x.add_argument("--reason", default="released by hand (stale)", help="reason stored in the ledger")
    a = ap.parse_args(argv)
    return {"status": cmd_status, "reconcile": cmd_reconcile, "release": cmd_release}[a.cmd](a)


if __name__ == "__main__":
    run_main(main)
