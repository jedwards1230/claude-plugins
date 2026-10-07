"""providers/ledger.py and scripts/ledger.py: reserve, refuse, record, release, ceiling, locking, reconcile."""

import json
import multiprocessing
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool

# isort: split
import common
import ledger as ledger_cli
from providers.base import BudgetRefused
from providers.ledger import Ledger


def _worker(path, n, q):
    led = Ledger(path, 10.0)
    ok = 0
    for _ in range(n):
        try:
            led.reserve("tts", "voice", 1.0, "openrouter", "m").record(1.0, "usage.cost")
            ok += 1
        except BudgetRefused:
            pass
    q.put(ok)


class LedgerTest(TempDirTest):
    def led(self, budget=1.0, **kw):
        return Ledger(self.tmp / "ledger.jsonl", budget, **kw)

    def test_reserve_record_and_status(self):
        led = self.led()
        with led.reserve("tts", "voice", 0.1, "openrouter", "m1") as r:
            r.record(0.08, "usage.cost")
        with led.reserve("image", "art", 0.2, "openrouter", "m2"):
            pass  # no record(): the estimate is recorded, tagged basis "estimate"
        s = led.status()
        self.assertAlmostEqual(s["spent"], 0.28)
        self.assertEqual(s["reserved"], 0)
        self.assertEqual(s["by_role"], {"tts": 0.08, "image": 0.2})
        self.assertEqual(s["by_basis"], {"usage.cost": 0.08, "estimate": 0.2})
        self.assertAlmostEqual(s["remaining"], 0.72)

    def test_reservation_is_estimate_times_1_2_and_refuses_over_budget(self):
        led = self.led(1.0)
        r = led.reserve("image", "art", 0.8, "openrouter", "m")  # holds 0.96
        self.assertAlmostEqual(led.status()["reserved"], 0.96)
        with self.assertRaises(BudgetRefused):
            led.reserve("tts", "voice", 0.1, "openrouter", "m")  # 0.96 + 0.12 > 1.0
        r.release("failed")
        self.assertEqual(led.status()["reserved"], 0)
        led.reserve("tts", "voice", 0.1, "openrouter", "m").record(0.05)

    def test_exception_releases(self):
        led = self.led()
        with self.assertRaises(RuntimeError):
            with led.reserve("tts", "voice", 0.1, "openrouter", "m"):
                raise RuntimeError("boom")
        s = led.status()
        self.assertEqual((s["spent"], s["reserved"], s["released"]), (0, 0, 1))

    def test_account_ceiling(self):
        usage = {"v": 7.0}
        led = self.led(10.0, ceiling=7.5, usage_fn=lambda: usage["v"])
        led.reserve("tts", "voice", 0.3, "openrouter", "m").record(0.3)  # 7.0 + 0.36 <= 7.5
        usage["v"] = 7.3
        with self.assertRaises(BudgetRefused) as cm:
            led.reserve("tts", "voice", 0.3, "openrouter", "m")
        self.assertIn("ceiling", str(cm.exception))

        def broken():
            raise OSError("offline")

        with self.assertRaises(BudgetRefused):
            self.led(10.0, ceiling=100, usage_fn=broken).reserve("tts", "voice", 0.01, "openrouter", "m")

    @unittest.skipUnless("fork" in multiprocessing.get_all_start_methods(), "needs fork")
    def test_concurrent_processes_never_overspend(self):
        path = str(self.tmp / "ledger.jsonl")
        q = multiprocessing.get_context("fork").Queue()
        procs = [multiprocessing.get_context("fork").Process(target=_worker, args=(path, 4, q)) for _ in range(4)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(30)
        total = sum(q.get(timeout=5) for _ in procs)
        # each call reserves $1.2 and records $1.0: the 9th fits (8 + 1.2), the 10th (9 + 1.2) does not
        self.assertEqual(total, 9)
        s = Ledger(path, 10.0).status()
        self.assertAlmostEqual(s["spent"], 9.0)
        self.assertEqual(s["reserved"], 0)

    def test_cache_hits_are_free_and_counted(self):
        led = self.led()
        led.cache_hit("tts", "voice", "openrouter", "m", "abc")
        s = led.status()
        self.assertEqual((s["spent"], s["cache_hits"], s["by_basis"]), (0, 1, {"cache": 0.0}))

    def test_reconcile_flags_drift(self):
        usage = {"v": 3.0}
        led = self.led(10.0, usage_fn=lambda: usage["v"])
        led.ensure_anchor()
        led.reserve("tts", "voice", 0.1, "openrouter", "m").record(0.1)
        usage["v"] = 3.1
        self.assertTrue(led.reconcile()["ok"])
        usage["v"] = 3.9
        r = led.reconcile()
        self.assertFalse(r["ok"])
        self.assertAlmostEqual(r["drift"], 0.8)
        self.assertIn("more than this ledger", r["note"])

    def test_budget_counts_the_account_delta_when_it_is_larger(self):
        usage = {"v": 3.0}
        led = self.led(1.0, usage_fn=lambda: usage["v"])
        led.ensure_anchor()
        led.reserve("tts", "voice", 0.1, "openrouter", "m").record(None)  # an estimate: $0.10 in the ledger
        usage["v"] = 3.9  # but the account paid $0.90 since the anchor
        with self.assertRaises(BudgetRefused) as cm:
            led.reserve("tts", "voice", 0.1, "openrouter", "m")  # 0.9 + 0.12 > 1.0, although 0.1 + 0.12 fits
        self.assertIn("account usage since the anchor", str(cm.exception))

        def offline():
            raise OSError("no network")

        led.usage_fn = offline  # without the account the ledger decides alone
        led.reserve("tts", "voice", 0.1, "openrouter", "m").record(0.1)

    def test_reconcile_derives_a_calibration_factor_for_estimates(self):
        usage = {"v": 3.0}
        led = self.led(10.0, usage_fn=lambda: usage["v"])
        led.ensure_anchor()
        for _ in range(4):
            led.reserve("tts", "voice", 0.05, "openrouter", "m").record(None)  # $0.20 of estimates
        led.reserve("critic", "review", 0.05, "openrouter", "c").record(0.03, "usage.cost")
        usage["v"] = 3.0 + 0.23 + 0.13  # the account paid 0.13 more than the ledger holds
        cal = led.reconcile()["calibration"]
        self.assertEqual(cal["roles"], ["tts"])
        self.assertAlmostEqual(cal["factor"], 1.65, places=3)  # (0.20 + 0.13) / 0.20
        # calibrated estimates keep their uncalibrated value, so the next factor is exact
        led.reserve("tts", "voice", 0.165, "openrouter", "m", raw_est=0.1).record(None)
        rec = [e for e in led.entries() if e["op"] == "record"][-1]
        self.assertEqual((rec["usd"], rec["raw_est"]), (0.165, 0.1))
        usage["v"] += 0.165
        self.assertAlmostEqual(led.reconcile()["calibration"]["factor"], 1.65, places=3)  # (0.365 + 0.13) / 0.3
        usage["v"] = 3.0  # the account paid less: estimates stay as they are, never below 1.0
        self.assertEqual(led.reconcile()["calibration"]["factor"], 1.0)
        usage["v"] = 13.0  # far more than the ledger: capped, and flagged
        cal = led.reconcile()["calibration"]
        self.assertEqual((cal["factor"], cal["capped"]), (3.0, True))


class LedgerCliTest(TempDirTest):
    def test_status_reconcile_release(self):
        film = new_film(self.tmp, budget_usd=2)
        led = Ledger(film / "ledger.jsonl", 2)
        led.reserve("tts", "voice", 0.1, "openrouter", "m").record(0.1)
        stale = led.reserve("image", "art", 0.2, "openrouter", "m")
        code, out, _ = run_tool(ledger_cli, ["status", "--film", str(film)])
        self.assertEqual(code, 0)
        self.assertIn("spent $0.1000", out)
        self.assertIn("reserved $0.2400", out)
        code, out, _ = run_tool(ledger_cli, ["release", "--film", str(film), "--all-open"])
        self.assertIn(stale.entry["id"], out)
        code, out, _ = run_tool(ledger_cli, ["status", "--film", str(film), "--json"])
        self.assertEqual(json.loads(out)["reserved"], 0)
        with FakeOpenRouter() as fake:
            led.append({"op": "anchor", "account_usage": fake.usage - 0.1})
            code, out, _ = run_tool(ledger_cli, ["reconcile", "--film", str(film)])
        self.assertEqual(code, 0, out)
        self.assertIn("ok", out)

    def test_reconcile_calibrates_later_tts_estimates_and_quotes(self):
        import quote
        from providers import Context, run_role

        film = new_film(self.tmp, budget_usd=5)
        job = {"text": "one two three four five six", "voice": "Kore", "out_dir": film / "work" / "takes"}
        with FakeOpenRouter() as fake:
            fake.cost = 0.02  # the account is charged more than the TTS estimate says
            ctx = Context(film, common.load_film(film))
            for k in range(6):  # six estimated takes: enough estimated spend for a factor
                run_role(ctx, "tts", dict(job, stem=f"t{k}", take=k), stage="voice")
            raw = [e for e in ctx.ledger.entries() if e["op"] == "record"][0]["usd"]
            before = quote.build_quote(common.load_film(film), film)["items"]
            code, out, _ = run_tool(ledger_cli, ["reconcile", "--film", str(film)])
            self.assertEqual(code, 1, out)  # drift beyond the tolerance: WARN
            self.assertIn("calibration x", out)
            factor = json.loads((film / "work" / "state.json").read_text())["calibration"]["tts"]["factor"]
            self.assertGreater(factor, 1.5)
            ctx = Context(film, common.load_film(film))
            run_role(ctx, "tts", dict(job, stem="t9", take=9), stage="voice")
            rsv = [e for e in ctx.ledger.entries() if e["op"] == "reserve"][-1]
            self.assertAlmostEqual(rsv["est"], round(raw * factor, 6), places=5)
            self.assertAlmostEqual(rsv["raw_est"], raw, places=6)
            after = quote.build_quote(common.load_film(film), film)["items"]
        takes = lambda items: next(i for i in items if i["item"].startswith("takes"))  # noqa: E731
        self.assertAlmostEqual(takes(after)["unit_usd"], round(takes(before)["unit_usd"] * factor, 5), places=4)
        code, out, _ = run_tool(ledger_cli, ["status", "--film", str(film)])
        self.assertIn("calibration tts x", out)


if __name__ == "__main__":
    unittest.main()
