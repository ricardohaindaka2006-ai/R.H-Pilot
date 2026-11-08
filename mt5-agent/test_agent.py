"""Offline contract tests. FakeMT5 never opens a broker connection or real order."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as N
import unittest
import uuid

spec = importlib.util.spec_from_file_location("rh_agent", Path(__file__).with_name("agent.py"))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)


class FakeMT5:
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6

    def __init__(self):
        self.a = N(login=1234567, server="Deriv-Demo", company="Deriv fixture", trade_mode=0,
                   margin_mode=2, currency="USD", balance=100.0, equity=100.0, margin_free=100.0,
                   trade_allowed=True, trade_expert=True)
        self.terminal = N(connected=True, trade_allowed=True, tradeapi_disabled=False)
        self.q = N(point=0.01, digits=2, trade_tick_size=0.01, trade_tick_value_loss=1.0,
                   volume_min=0.01, volume_max=10, volume_step=0.01, trade_stops_level=0,
                   trade_freeze_level=0, trade_mode=4, filling_mode=1, trade_exemode=0)
        self.tick = N(bid=100.0, ask=100.02, time_msc=A.now_ms())
        self.live_positions = []
        self.pending_orders = []
        self.deals = []
        self.calls = []
        self.reject_check = False
        self.reject_send = False
        self.lose_ack = False
        self.no_history = False
        self.unknown_positions = False
        self.bad_profit = False
        self.bad_margin = False
        self.partial = False
        self.counter = 0

    def account_info(self):
        return self.a

    def terminal_info(self):
        return self.terminal

    def positions_get(self):
        return None if self.unknown_positions else tuple(self.live_positions)

    def orders_get(self):
        return tuple(self.pending_orders)

    def symbol_select(self, symbol, selected):
        return symbol == "XAUUSD"

    def symbol_info(self, symbol):
        return self.q

    def symbol_info_tick(self, symbol):
        return self.tick

    def order_calc_profit(self, side, symbol, volume, entry, exit_price):
        return None if self.bad_profit else (exit_price - entry) * volume * 100 * (1 if side == 0 else -1)

    def order_calc_margin(self, *args):
        return None if self.bad_margin else 1.0

    def order_check(self, request):
        self.calls.append(("check", dict(request)))
        return N(retcode=10016 if self.reject_check else 0)

    def order_send(self, request):
        self.calls.append(("send", dict(request)))
        if self.reject_send:
            return N(retcode=10016, order=0)
        if request["action"] == self.TRADE_ACTION_SLTP:
            p = next(p for p in self.live_positions if p.ticket == request["position"])
            p.sl, p.tp = request["sl"], request["tp"]
            return N(retcode=10009, order=0)
        if "position" in request:
            p = next(p for p in self.live_positions if p.ticket == request["position"])
            self.close_position(p, request.get("price", self.tick.bid if p.type == 0 else self.tick.ask))
            return N(retcode=10009, order=9000)
        self.counter += 1
        request = dict(request)
        request.setdefault("price", self.tick.ask if request["type"] == 0 else self.tick.bid)
        volume = request["volume"] / 2 if self.partial else request["volume"]
        order, position_id, actual_ticket = 5000 + self.counter, 7000 + self.counter, 6000 + self.counter
        self.live_positions.append(N(identifier=position_id, ticket=actual_ticket, symbol="XAUUSD",
            type=request["type"], volume=volume, price_open=request["price"], sl=request["sl"], tp=request["tp"], magic=A.MAGIC))
        self.deals.append(N(position_id=position_id, order=order, ticket=8000 + self.counter, entry=0,
            volume=volume, price=request["price"], profit=0, commission=-0.01, swap=0, fee=0,
            time_msc=A.now_ms(), comment=request["comment"], magic=A.MAGIC))
        self.a.balance -= 0.01
        self.a.equity = self.a.balance
        if self.lose_ack:
            raise TimeoutError("broker reply lost after actual fake fill")
        return N(retcode=10010 if self.partial else 10009, order=order)

    def close_position(self, p, price, volume=None):
        volume = p.volume if volume is None else volume
        profit = (price - p.price_open) * volume * 100 * (1 if p.type == 0 else -1)
        self.deals.append(N(position_id=p.identifier, order=9000 + self.counter, ticket=10000 + len(self.deals),
            entry=1, volume=volume, price=price, profit=profit, commission=-0.01, swap=-0.02, fee=-0.03,
            time_msc=A.now_ms(), comment="[sl fixture]", magic=A.MAGIC))
        self.a.balance += profit - 0.06
        self.a.equity = self.a.balance
        p.volume -= volume
        if p.volume < 1e-9:
            self.live_positions.remove(p)

    def history_deals_get(self, *args, **kwargs):
        if self.no_history:
            return None
        if "position" in kwargs:
            return tuple(d for d in self.deals if d.position_id == kwargs["position"])
        if "ticket" in kwargs:
            return tuple(d for d in self.deals if d.order == kwargs["ticket"])
        return tuple(self.deals)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rhp-agent-test-")
        self.path = Path(self.temp.name) / "journal.sqlite3"
        self.identity = {"origin": "https://fixture.example", "login": "1234567", "server": "Deriv-Demo", "symbol": "XAUUSD"}
        self.journal = A.Journal(self.path, self.identity)
        self.mt5 = FakeMT5()
        self.agent = A.Agent(self.mt5, self.journal, "1234567", "Deriv-Demo", "XAUUSD", enable_demo=True)
        self.agent.account()

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def command(self, **changes):
        result = {"protocol": 1, "id": uuid.uuid4().hex[:24], "sessionId": self.agent.session,
            "demoOnly": True, "action": "open", "login": "1234567", "server": "Deriv-Demo", "symbol": "XAUUSD",
            "side": "BUY", "volume": 0.01, "sl": 99.8, "tp": 100.8, "worstEntry": 100.04,
            "maxRisk": 0.5, "costBuffer": 0.10, "deviationPoints": 2, "maxHoldSeconds": 60,
            "createdAt": A.now_ms(), "expiresAt": A.now_ms() + 5000,
            "exitSettings": {"lockInProfit": True, "lockAfterR": 0.5, "trailAfterR": 1.0, "trailByR": 0.35, "trailing": True}}
        result.update(changes)
        return result

    def sends(self):
        return [req for kind, req in self.mt5.calls if kind == "send"]

    def test_monitor_default_and_real_accounts_never_reach_order_send(self):
        for demo_opt_in, trade_mode in [(False, 0), (True, 2), (True, 1)]:
            self.agent.enable_demo = demo_opt_in
            self.mt5.a.trade_mode = trade_mode
            c = self.command()
            self.agent.execute(c)
            self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        self.assertEqual(self.sends(), [])

    def test_exact_account_permissions_and_consent_are_enforced_before_send(self):
        for changes in [{"demoOnly": False}, {"login": "7654321"}, {"sessionId": str(uuid.uuid4())},
                        {"expiresAt": A.now_ms() - 1}, {"maxRisk": 1.01}, {"volume": 0.001},
                        {"sl": 101}, {"symbol": "wrong"}, {"costBuffer": 0}, {"deviationPoints": 1000}]:
            c = self.command(**changes)
            self.agent.execute(c)
            self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        self.mt5.terminal.tradeapi_disabled = True
        self.agent.execute(self.command())
        self.assertEqual(self.sends(), [])

    def test_stale_quotes_unknown_exposure_and_unknown_risk_fail_closed(self):
        self.mt5.tick.time_msc = A.now_ms() - 9000
        self.agent.execute(self.command())
        self.mt5.tick.time_msc = A.now_ms()
        self.mt5.unknown_positions = True
        self.agent.execute(self.command())
        self.mt5.unknown_positions = False
        self.mt5.bad_profit = True
        self.agent.execute(self.command())
        self.mt5.bad_profit = False
        self.mt5.bad_margin = True
        self.agent.execute(self.command())
        self.assertEqual(self.sends(), [])

    def test_broker_check_rejection_never_submits_and_duplicate_ids_never_retry(self):
        self.mt5.reject_check = True
        c = self.command()
        self.agent.execute(c)
        self.mt5.reject_check = False
        self.agent.execute(c)
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        modified = dict(c, sl=99.7)
        with self.assertRaisesRegex(A.AgentError, "command-id-collision"):
            self.agent.execute(modified)

    def test_fill_is_reconciled_by_order_and_position_identifier_not_assumed_ticket(self):
        c = self.command()
        self.agent.execute(c)
        row = self.journal.get(c["id"])
        result = json.loads(row["result"])
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["positionId"], "7001")
        self.assertNotEqual(result["positionId"], row["broker_order"])
        self.agent.execute(c)
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.sends()[0]["sl"], c["sl"])
        self.assertEqual(self.sends()[0]["tp"], c["tp"])

    def test_partial_fill_keeps_actual_volume_and_original_risk_reservation(self):
        self.mt5.partial = True
        c = self.command()
        self.agent.execute(c)
        result = json.loads(self.journal.get(c["id"])["result"])
        self.assertEqual(result["volume"], c["volume"] / 2)
        self.assertEqual(result["status"], "filled")
        self.assertEqual(json.loads(self.journal.get(c["id"])["payload"])["maxRisk"], 0.5)

    def test_lost_ack_is_found_in_history_without_a_second_buy(self):
        self.mt5.lose_ack = True
        c = self.command()
        self.agent.execute(c)
        self.assertEqual(self.journal.get(c["id"])["phase"], "filled")
        self.agent.execute(c)
        self.assertEqual(len(self.sends()), 1)

    def test_unavailable_history_preserves_uncertainty_across_restart(self):
        self.mt5.no_history = True
        c = self.command()
        with self.assertRaisesRegex(A.AgentError, "broker-history-unavailable"):
            self.agent.execute(c)
        self.assertEqual(self.journal.get(c["id"])["phase"], "uncertain")
        self.journal.close()
        self.journal = A.Journal(self.path, self.identity)
        replacement = A.Agent(self.mt5, self.journal, "1234567", "Deriv-Demo", "XAUUSD", True)
        replacement.execute(c)
        self.assertEqual(len(self.sends()), 1)
        self.mt5.no_history = False
        replacement.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "filled")

    def test_history_empty_is_not_a_rejection_or_permission_to_resubmit(self):
        c = self.command()
        self.journal.claim(c)
        self.journal.phase(c["id"], "submitting")
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "uncertain")
        self.agent.execute(c)
        self.assertEqual(self.sends(), [])

    def test_preparing_crash_is_safe_to_reject_but_never_resubmit(self):
        c = self.command()
        self.journal.claim(c)
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        self.agent.execute(c)
        self.assertEqual(self.sends(), [])

    def test_closed_receipt_uses_all_realized_deal_costs_once(self):
        c = self.command()
        self.agent.execute(c)
        self.mt5.close_position(self.mt5.live_positions[0], 100.8)
        self.agent.reconcile()
        result = json.loads(self.journal.get(c["id"])["result"])
        self.assertEqual(result["status"], "closed")
        self.assertEqual(result["dealCount"], 2)
        self.assertAlmostEqual(result["pnl"], 0.78 - 0.02 - 0.02 - 0.03)
        self.assertAlmostEqual(self.mt5.a.balance, 100 + result["pnl"])
        before = self.journal.meta("risk")
        self.agent.reconcile()
        self.assertEqual(self.journal.meta("risk"), before)
        results, versions = self.journal.pending()
        self.journal.acknowledge([c["id"]], versions)
        self.assertEqual(self.journal.pending()[0], [])
        self.assertEqual(results[0]["status"], "closed")

    def test_partial_close_does_not_fake_a_full_settlement(self):
        c = self.command()
        self.agent.execute(c)
        p = self.mt5.live_positions[0]
        self.mt5.close_position(p, 100.4, volume=0.005)
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "filled")
        self.mt5.close_position(p, 100.6)
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "closed")

    def test_an_ack_of_filled_cannot_ack_a_newer_closure_receipt(self):
        c = self.command()
        self.agent.execute(c)
        _, old_versions = self.journal.pending()
        self.mt5.close_position(self.mt5.live_positions[0], 100.6)
        self.agent.reconcile()
        self.journal.acknowledge([c["id"]], old_versions)
        self.assertEqual(self.journal.pending()[0][0]["status"], "closed")

    def test_profit_lock_never_loosens_and_does_not_run_on_real_accounts(self):
        c = self.command()
        self.agent.execute(c)
        p = self.mt5.live_positions[0]
        self.mt5.tick = N(bid=100.5, ask=100.52, time_msc=A.now_ms() + 1)
        self.agent.reconcile()
        self.assertGreater(p.sl, p.price_open)
        tightened = p.sl
        self.mt5.tick = N(bid=100.4, ask=100.42, time_msc=A.now_ms() + 2)
        self.agent.reconcile()
        self.assertEqual(p.sl, tightened)
        self.mt5.a.trade_mode = 2
        before = len(self.sends())
        self.mt5.tick = N(bid=100.6, ask=100.62, time_msc=A.now_ms() + 3)
        self.agent.reconcile()
        self.assertEqual(len(self.sends()), before)

    def test_time_close_uses_actual_ticket_and_is_never_blindly_retried(self):
        c = self.command()
        self.agent.execute(c)
        with self.journal.db:
            self.journal.db.execute("UPDATE intents SET created_at=?, last_tick=0 WHERE id=?", (A.now_ms() - 61000, c["id"]))
        self.mt5.tick.time_msc += 1
        self.agent.reconcile()
        closes = [r for r in self.sends() if "position" in r]
        self.assertEqual(len(closes), 1)
        self.assertEqual(closes[0]["position"], 6001)
        self.agent.reconcile()
        self.assertEqual(len([r for r in self.sends() if "position" in r]), 1)
        self.assertEqual(self.journal.get(c["id"])["phase"], "closed")

    def test_independent_local_drawdown_daily_and_loss_streak_rails_survive_reopening(self):
        for _ in range(3):
            c = self.command()
            self.journal.claim(c)
            self.journal.result(c["id"], {"id": c["id"], "status": "closed", "pnl": -0.2, "closedAt": A.now_ms()})
        self.assertEqual(self.journal.allowed_risk(self.mt5.a), 0)
        self.journal.close()
        self.journal = A.Journal(self.path, self.identity)
        self.assertEqual(self.journal.allowed_risk(self.mt5.a), 0)
        risk = json.loads(self.journal.meta("risk"))
        risk["pauseUntil"] = 0
        risk["dayPnl"] = -3
        with self.journal.db:
            self.journal.set_meta("risk", json.dumps(risk))
        self.assertEqual(self.journal.allowed_risk(self.mt5.a), 0)
        self.mt5.a.balance = self.mt5.a.equity = 89
        self.journal.observe_risk(self.mt5.a)
        self.mt5.a.balance = self.mt5.a.equity = 100
        self.assertEqual(self.journal.allowed_risk(self.mt5.a), 0)
        self.assertTrue(json.loads(self.journal.meta("risk"))["drawdownLatched"])

    def test_missing_broker_stops_requests_one_demo_emergency_close_not_a_second_open(self):
        c = self.command()
        self.agent.execute(c)
        self.mt5.live_positions[0].sl = 0
        self.agent.reconcile()
        closes = [r for r in self.sends() if "position" in r]
        self.assertEqual(len(closes), 1)
        self.assertEqual(closes[0]["position"], 6001)
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "closed")
        self.assertEqual(len([r for r in self.sends() if "position" not in r and r["action"] == 1]), 1)

    def test_unprotected_real_account_is_never_modified_even_during_emergency_handling(self):
        c = self.command()
        self.agent.execute(c)
        self.mt5.a.trade_mode = 2
        self.mt5.live_positions[0].sl = 0
        self.agent.reconcile()
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.journal.get(c["id"])["phase"], "uncertain")

    def test_an_emergency_close_rejection_is_reserved_for_manual_review_not_blindly_retried(self):
        c = self.command()
        self.agent.execute(c)
        self.mt5.live_positions[0].sl = 0
        self.mt5.reject_send = True
        self.agent.reconcile()
        self.agent.reconcile()
        self.assertEqual(len([r for r in self.sends() if "position" in r]), 1)
        self.assertEqual(self.journal.get(c["id"])["phase"], "uncertain")

    def test_retention_prunes_only_final_acknowledged_receipts_not_exposure_or_risk(self):
        before = self.journal.meta("risk")
        with self.journal.db:
            self.journal.db.executemany("""INSERT INTO intents
                (id,payload,phase,result,version,acked_version,created_at)
                VALUES (?,?,?,?,?,?,?)""", [(f"{n:024x}", "{}", "rejected", "{}", 1, 1, A.now_ms() - 300000) for n in range(2005)])
        unresolved = self.command()
        self.journal.claim(unresolved)
        self.assertEqual(self.journal.get(unresolved["id"])["phase"], "preparing")
        self.assertLess(self.journal.db.execute("SELECT count(*) FROM intents").fetchone()[0], 1100)
        self.assertEqual(self.journal.meta("risk"), before)
        self.assertEqual(len(self.journal.active()), 1)

    def test_journal_lock_identity_and_corruption_refuse_resets(self):
        with self.assertRaisesRegex(A.AgentError, "journal-already-in-use"):
            A.Journal(self.path, self.identity)
        self.journal.close()
        with self.assertRaisesRegex(A.AgentError, "journal-account-or-origin-mismatch"):
            A.Journal(self.path, dict(self.identity, login="7654321"))
        self.journal = A.Journal(self.path, self.identity)
        self.assertEqual(self.journal.meta("identity"), json.dumps(self.identity, sort_keys=True))

    def test_a_lost_bridge_command_is_rejected_from_the_pinned_journal_without_any_native_retry(self):
        c = self.command()
        self.agent.recover(c)  # HTTP reply was lost before the agent saw this id
        self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        self.agent.execute(c)
        self.assertEqual(self.sends(), [])

    def test_recovery_keeps_an_ambiguous_send_reserved_and_never_sends_again(self):
        c = self.command()
        self.mt5.no_history = True
        with self.assertRaises(A.AgentError):
            self.agent.execute(c)
        before = len(self.sends())
        self.agent.recover(c)
        self.assertEqual(self.journal.get(c["id"])["phase"], "uncertain")
        self.assertEqual(len(self.sends()), before)
        self.mt5.no_history = False
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["phase"], "filled")

    def test_another_account_cannot_be_reconciled_into_this_journal(self):
        c = self.command()
        self.agent.execute(c)
        before = self.journal.get(c["id"])["result"]
        self.mt5.a.login = 7654321
        with self.assertRaisesRegex(A.AgentError, "terminal-account-mismatch"):
            self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["result"], before)
        with self.assertRaisesRegex(A.AgentError, "recovery-account-mismatch"):
            self.agent.recover(dict(self.command(), login="7654321"))

    def test_market_execution_omits_price_for_open_and_close_requests(self):
        self.mt5.q.trade_exemode = 2
        c = self.command()
        self.agent.execute(c)
        self.assertNotIn("price", self.sends()[0])
        with self.journal.db:
            self.journal.db.execute("UPDATE intents SET created_at=?, last_tick=0 WHERE id=?", (A.now_ms() - 61000, c["id"]))
        self.mt5.tick.time_msc += 1
        self.agent.reconcile()
        close = [r for r in self.sends() if "position" in r]
        self.assertEqual(len(close), 1)
        self.assertNotIn("price", close[0])

    def test_profit_protection_values_cannot_overflow_price_calculation(self):
        c = self.command(exitSettings={"lockInProfit": True, "lockAfterR": 0.5,
            "trailAfterR": 1, "trailByR": 1e300, "trailing": True})
        self.agent.execute(c)
        self.assertEqual(self.journal.get(c["id"])["phase"], "rejected")
        self.assertEqual(self.sends(), [])

    def test_sl_amendments_do_not_generate_endless_fill_receipts(self):
        c = self.command()
        self.agent.execute(c)
        original = self.journal.get(c["id"])["version"]
        self.mt5.tick = N(bid=100.5, ask=100.52, time_msc=A.now_ms() + 1)
        self.agent.reconcile()
        self.agent.reconcile()
        self.assertEqual(self.journal.get(c["id"])["version"], original)

    def test_bridge_https_origin_validation_and_no_password_in_payload(self):
        for origin in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x"]:
            with self.assertRaises(A.AgentError):
                A.BridgeHTTP(origin, "rhp5_" + "a" * 43)
        A.BridgeHTTP("http://127.0.0.1:1234", "rhp5_" + "a" * 43, True)
        payload, _ = self.agent.snapshot()
        self.assertNotIn("password", json.dumps(payload).lower())
        self.assertNotIn("token", json.dumps(payload).lower())
        self.assertEqual(payload["account"]["login"], "1234567")
        self.assertEqual(payload["quote"]["symbol"], "XAUUSD")


if __name__ == "__main__":
    unittest.main(verbosity=2)
