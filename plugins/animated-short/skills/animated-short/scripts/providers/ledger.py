"""Append-only spend ledger for one film (<film>/ledger.jsonl), shared by every provider.

Before a paid call: reserve(est) books est x 1.2 under a file lock and refuses when the film's
budget_usd (or the optional account ceiling) would be exceeded. The budget check counts the larger
of the ledger's spend and the account's usage since the film's anchor (GET /key, when a key is
available), so estimates that run low cannot overspend the film. After the call: record the actual
cost (usage.cost when the provider reported it, else the estimate tagged basis "estimate"), or
release the reservation when the call failed before reaching the model. Cache hits are recorded at
$0. Entries: reserve | record | release | anchor (account usage at the film's first paid call) |
reconcile (account usage delta vs the ledger, plus the calibration factor for estimated costs).
"""

import contextlib
import datetime
import json
import os
import time
import uuid

from .base import BudgetRefused

RESERVE_FACTOR = 1.2
EPS = 1e-9
CALIBRATION_MAX = 3.0  # a larger drift is more likely other work sharing the key than a bad estimate
CALIBRATION_MIN_USD = 0.01  # estimated spend needed before a calibration factor means anything


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


@contextlib.contextmanager
def file_lock(path):
    """Exclusive lock on <path>.lock (fcntl on POSIX, an O_EXCL lock file elsewhere)."""
    lock = path + ".lock"
    try:
        import fcntl
    except ImportError:
        fcntl = None
    if fcntl:
        with open(lock, "a+") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
        return
    deadline = time.time() + 60
    while True:
        try:
            fd = os.open(lock + ".x", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.time() > deadline:
                raise TimeoutError(f"ledger lock {lock}.x held for 60 s; remove it if no tool is running") from None
            time.sleep(0.05)
    try:
        yield
    finally:
        os.close(fd)
        os.unlink(lock + ".x")


def totals(entries, budget=None):
    """Summarize ledger entries: spent, reserved (open reservations), per role/stage/basis."""
    closed = {e["id"] for e in entries if e.get("op") in ("record", "release") and e.get("id")}
    out = {
        "spent": 0.0,
        "reserved": 0.0,
        "calls": 0,
        "cache_hits": 0,
        "released": 0,
        "by_role": {},
        "by_stage": {},
        "by_basis": {},
        "open": [],
    }
    for e in entries:
        op = e.get("op")
        if op == "reserve" and e["id"] not in closed:
            out["reserved"] += e["usd"]
            out["open"].append(e["id"])
        elif op == "record":
            usd = float(e.get("usd") or 0.0)
            out["spent"] += usd
            out["calls"] += 1
            if e.get("basis") == "cache":
                out["cache_hits"] += 1
            for k, bucket in (("role", "by_role"), ("stage", "by_stage"), ("basis", "by_basis")):
                name = e.get(k) or "-"
                out[bucket][name] = round(out[bucket].get(name, 0.0) + usd, 6)
        elif op == "release":
            out["released"] += 1
    out["spent"], out["reserved"] = round(out["spent"], 6), round(out["reserved"], 6)
    if budget is not None:
        out["budget"] = budget
        out["remaining"] = round(budget - out["spent"] - out["reserved"], 6)
    return out


class Reservation:
    """One booked paid call. Use as a context manager: an exception releases it, a normal exit
    without record() records the estimate."""

    def __init__(self, ledger, entry):
        self.ledger, self.entry, self.done = ledger, entry, False

    def record(self, usd=None, basis="usage.cost", **extra):
        if self.done:
            return
        if usd is None:
            usd, basis = self.entry["est"], "estimate"
        e = {
            "op": "record",
            "id": self.entry["id"],
            "role": self.entry["role"],
            "stage": self.entry["stage"],
            "provider": self.entry["provider"],
            "model": self.entry["model"],
            "usd": round(float(usd), 6),
            "basis": basis,
            "reserved": self.entry["usd"],
        }
        if basis == "estimate" and "raw_est" in self.entry:
            e["raw_est"] = self.entry["raw_est"]  # the estimate before the film's calibration factor
        e.update(extra)
        self.ledger.append(e)
        self.done = True

    def release(self, reason):
        if self.done:
            return
        self.ledger.append(
            {
                "op": "release",
                "id": self.entry["id"],
                "role": self.entry["role"],
                "stage": self.entry["stage"],
                "reason": str(reason)[:300],
            }
        )
        self.done = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if not self.done:
            if exc_type:
                self.release(f"{exc_type.__name__}: {exc}")
            else:
                self.record(None)
        return False


class Ledger:
    """Ledger for one film. usage_fn() returns the account's reported usage in USD (GET /key); it is
    only called when an account ceiling is set, and for anchors and reconciliation."""

    def __init__(self, path, budget_usd, ceiling=None, usage_fn=None):
        self.path, self.budget = str(path), float(budget_usd)
        self.ceiling = None if ceiling in (None, "") else float(ceiling)
        self.usage_fn = usage_fn

    def entries(self):
        if not os.path.exists(self.path):
            return []
        out = []
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        return out

    def _write(self, entry):
        entry = dict({"ts": _now()}, **entry)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        return entry

    def append(self, entry):
        with file_lock(self.path):
            return self._write(entry)

    def status(self):
        return totals(self.entries(), self.budget)

    def _usage(self):
        """(account usage in USD or None, why it is None)."""
        if self.usage_fn is None:
            return None, "no usage source"
        try:
            return float(self.usage_fn()), ""
        except Exception as e:  # noqa: BLE001 -- a missing key or a network error: the caller decides
            return None, e.__class__.__name__

    def reserve(self, role, stage, est, provider, model, note="", raw_est=None):
        """Book est x 1.2. raw_est is the estimate before the film's calibration factor (kept for
        reconcile, which derives the factor from it)."""
        amount = round(max(0.0, float(est)) * RESERVE_FACTOR, 6)
        with file_lock(self.path):
            entries = self.entries()
            t = totals(entries, self.budget)
            anchor = next((e for e in entries if e.get("op") == "anchor"), None)
            usage, why = (None, "") if anchor is None and self.ceiling is None else self._usage()
            spent, basis = t["spent"], "ledger"
            if anchor is not None and usage is not None and usage - anchor["account_usage"] > spent:
                spent, basis = round(usage - anchor["account_usage"], 6), "account usage since the anchor"
            if spent + t["reserved"] + amount > self.budget + EPS:
                raise BudgetRefused(
                    f"budget refused: {role} via {model} needs ${amount:.4f} (estimate ${est:.4f} x {RESERVE_FACTOR}); "
                    f"spent ${spent:.4f} ({basis}) + reserved ${t['reserved']:.4f} of the film's ${self.budget:.2f}"
                )
            if self.ceiling is not None:
                if usage is None:  # cannot prove headroom
                    raise BudgetRefused(
                        f"account ceiling set but account usage is unreadable ({why}); refusing the paid call"
                    )
                if usage + t["reserved"] + amount > self.ceiling + EPS:
                    raise BudgetRefused(
                        f"account ceiling refused: usage ${usage:.4f} + reserved ${t['reserved']:.4f} + ${amount:.4f} "
                        f"> ceiling ${self.ceiling:.2f}"
                    )
            entry = {
                "op": "reserve",
                "id": uuid.uuid4().hex[:12],
                "role": role,
                "stage": stage,
                "provider": provider,
                "model": model,
                "est": round(float(est), 6),
                "usd": amount,
                "note": note,
            }
            if raw_est is not None and abs(float(raw_est) - float(est)) > EPS:
                entry["raw_est"] = round(float(raw_est), 6)
            entry = self._write(entry)
        return Reservation(self, entry)

    def cache_hit(self, role, stage, provider, model, key):
        return self.append(
            {
                "op": "record",
                "id": uuid.uuid4().hex[:12],
                "role": role,
                "stage": stage,
                "provider": provider,
                "model": model,
                "usd": 0.0,
                "basis": "cache",
                "key": key,
            }
        )

    def anchor(self):
        """The first anchor entry (account usage before this film's first paid call), or None."""
        return next((e for e in self.entries() if e.get("op") == "anchor"), None)

    def ensure_anchor(self):
        if self.anchor() is not None or self.usage_fn is None:
            return
        try:
            usage = float(self.usage_fn())
        except Exception:  # noqa: BLE001 -- anchors are best effort
            return
        with file_lock(self.path):
            if not any(e.get("op") == "anchor" for e in self.entries()):
                self._write({"op": "anchor", "account_usage": usage})

    def reconcile(self, usage_now=None):
        """Compare the account usage delta since the anchor with what the ledger recorded, and derive
        the calibration factor for estimated costs: every call recorded with basis "estimate" (TTS
        above all: the speech endpoint reports no cost) is assumed to carry the whole drift, so
        factor = (estimated spend + drift) / the same calls' uncalibrated estimates, clamped to
        1.0..CALIBRATION_MAX (never below 1.0: over-estimates stay as they are)."""
        entries = self.entries()
        anchor = next((e for e in entries if e.get("op") == "anchor"), None)
        t = totals(entries, self.budget)
        if usage_now is None:
            usage_now = float(self.usage_fn())
        res = {
            "account_usage": round(usage_now, 6),
            "ledger_spent": t["spent"],
            "anchor": None,
            "delta": None,
            "drift": None,
            "ok": True,
            "note": "",
            "calibration": None,
        }
        if anchor is None:
            res["note"] = "no anchor yet (no paid call has run); nothing to compare"
        else:
            delta = round(usage_now - anchor["account_usage"], 6)
            drift = round(delta - t["spent"], 6)
            tol = max(0.05, 0.1 * t["spent"])
            res.update(anchor=anchor["account_usage"], delta=delta, drift=drift, ok=abs(drift) <= tol)
            if drift > tol:
                res["note"] = (
                    "the account spent more than this ledger recorded: estimates were low, or other work shares the key"
                )
            elif drift < -tol:
                res["note"] = "the ledger recorded more than the account spent (estimates were conservative)"
            est = [e for e in entries if e.get("op") == "record" and e.get("basis") == "estimate"]
            recorded = sum(float(e.get("usd") or 0) for e in est)
            raw = sum(float(e.get("raw_est", e.get("usd")) or 0) for e in est)
            if recorded >= CALIBRATION_MIN_USD and raw > 0:
                factor = min(CALIBRATION_MAX, max(1.0, (recorded + drift) / raw))
                res["calibration"] = {
                    "factor": round(factor, 3),
                    "roles": sorted({e.get("role") or "-" for e in est}),
                    "estimated_usd": round(recorded, 6),
                    "uncalibrated_usd": round(raw, 6),
                    "capped": (recorded + drift) / raw > CALIBRATION_MAX,
                }
        self.append(dict({"op": "reconcile"}, **{k: v for k, v in res.items() if k != "ok"}, ok=res["ok"]))
        return res
