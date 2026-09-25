"""providers/ledger.py and scripts/ledger.py: reserve, refuse, record, release, ceiling, locking, reconcile."""

import json
import multiprocessing
import unittest

from helpers import FakeOpenRouter, TempDirTest, new_film, run_tool

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


if __name__ == "__main__":
    unittest.main()
