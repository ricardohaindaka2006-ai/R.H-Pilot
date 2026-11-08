#!/usr/bin/env python3
"""R.H Pilot outbound MT5 bridge. Monitor by default; DEMO orders only.

Run on your own Windows computer with an installed, logged-in MT5 terminal.
No incoming port, terminal password, browser-localhost connection, paid VPS,
keep-alive pinger or Render-side MT5 installation is required. The broker's
native SL/TP remain active if either application stops. Profit is not assured.
"""
from __future__ import annotations
import argparse
import concurrent.futures
from datetime import datetime, timezone
import getpass
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROTOCOL = 1
MAGIC = 52504850
MAX_RESPONSE = 256 * 1024
MAX_ROWS = 10000
REJECT_CODES = {10004, 10006, 10007, 10013, 10014, 10015, 10016, 10017,
                10018, 10019, 10020, 10021, 10022, 10026, 10027, 10030,
                10032, 10033, 10034, 10035, 10038, 10040, 10042, 10043,
                10044, 10045, 10046}


class AgentError(Exception):
    """Controlled diagnostic code only: never echo credentials/provider text."""


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def positive(value):
    return number(value) and value > 0


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,19}", value) is not None


def now_ms():
    return int(time.time() * 1000)


class ProcessLock:
    def __init__(self, path):
        self.file = open(path, "a+b")
        if self.file.seek(0, 2) == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise AgentError("journal-already-in-use") from None

    def close(self):
        self.file.close()


class Journal:
    def __init__(self, path, identity):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = ProcessLock(str(self.path) + ".lock")
        try:
            self.db = sqlite3.connect(self.path, timeout=5)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=FULL")
            page_size = self.db.execute("PRAGMA page_size").fetchone()[0]
            self.db.execute("PRAGMA max_page_count=" + str(32 * 1024 * 1024 // page_size))
            if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise AgentError("journal-integrity-failed")
            with self.db:
                self.db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                self.db.execute("""CREATE TABLE IF NOT EXISTS intents (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL, phase TEXT NOT NULL,
                    result TEXT, version INTEGER NOT NULL DEFAULT 0,
                    acked_version INTEGER NOT NULL DEFAULT -1,
                    position_id TEXT, broker_order TEXT, last_tick INTEGER NOT NULL DEFAULT 0,
                    closing INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)""")
                stored = self.meta("identity")
                expected = json.dumps(identity, sort_keys=True)
                if stored and stored != expected:
                    raise AgentError("journal-account-or-origin-mismatch")
                self.set_meta("identity", expected)
                if not self.meta("instance"):
                    self.set_meta("instance", str(uuid.uuid4()))
                if not self.meta("sequence"):
                    self.set_meta("sequence", "0")
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass  # Windows uses the current user's filesystem ACL
        except Exception:
            if hasattr(self, "db"):
                self.db.close()
            self.lock.close()
            raise

    def meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)", (key, value))

    def sequence(self):
        with self.db:
            value = int(self.meta("sequence")) + 1
            if value > 2**53 - 1:
                raise AgentError("sequence-exhausted")
            self.set_meta("sequence", str(value))
        return value

    def get(self, key):
        return self.db.execute("SELECT * FROM intents WHERE id=?", (key,)).fetchone()

    def claim(self, command):
        text = json.dumps(command, sort_keys=True, separators=(",", ":"))
        existing = self.get(command["id"])
        if existing:
            if existing["payload"] != text:
                raise AgentError("command-id-collision")
            return False
        count = self.db.execute("SELECT count(*) FROM intents").fetchone()[0]
        if count >= 2000:
            # Keep 1,000 retired receipts plus every young/unacknowledged or
            # unresolved record. Aggregate risk metadata is never pruned.
            # Expired duplicate commands still fail preflight after retirement.
            with self.db:
                self.db.execute("""DELETE FROM intents WHERE id IN (
                    SELECT id FROM intents WHERE phase IN ('closed','rejected')
                    AND version=acked_version AND created_at<?
                    ORDER BY created_at DESC LIMIT -1 OFFSET 1000)""", (now_ms() - 60000,))
            count = self.db.execute("SELECT count(*) FROM intents").fetchone()[0]
        if len(text) > 8192 or count >= MAX_ROWS:
            raise AgentError("journal-capacity-review-required")
        with self.db:
            self.db.execute("INSERT INTO intents(id,payload,phase,created_at) VALUES (?,?,?,?)",
                            (command["id"], text, "preparing", now_ms()))
        return True

    def phase(self, key, phase, order=None):
        with self.db:
            self.db.execute("UPDATE intents SET phase=?, broker_order=coalesce(?,broker_order) WHERE id=?",
                            (phase, order, key))

    def result(self, key, value):
        text = json.dumps(value, sort_keys=True, separators=(",", ":"))
        row = self.get(key)
        if row["phase"] == "closed" and row["result"] != text:
            raise AgentError("settlement-rollback-refused")
        if row["result"] == text:
            return
        if row["phase"] == "filled" and value["status"] == "filled":
            previous = json.loads(row["result"])
            if all(previous.get(k) == value.get(k) for k in ("positionId", "volume", "entry")):
                return  # live SL changes are positions, not new settlement receipts
        with self.db:
            if value["status"] == "closed" and row["phase"] != "closed":
                self.record_outcome(value)
            self.db.execute("""UPDATE intents SET phase=?, result=?, version=version+1,
                            position_id=coalesce(?,position_id) WHERE id=?""",
                            (value["status"], text, value.get("positionId"), key))

    def active(self):
        rows = self.db.execute("SELECT * FROM intents WHERE phase NOT IN ('closed','rejected') ORDER BY created_at").fetchall()
        if len(rows) > 100:
            raise AgentError("journal-unresolved-capacity")
        return rows

    def pending(self):
        rows = self.db.execute("SELECT * FROM intents WHERE result IS NOT NULL AND version>acked_version ORDER BY created_at LIMIT 20").fetchall()
        return [json.loads(row["result"]) for row in rows], {row["id"]: row["version"] for row in rows}

    def acknowledge(self, ids, versions):
        with self.db:
            for key in ids:
                if key in versions:
                    self.db.execute("UPDATE intents SET acked_version=max(acked_version,?) WHERE id=?",
                                    (versions[key], key))

    def observe_risk(self, account):
        stored = self.meta("risk")
        if not stored:
            if self.db.execute("SELECT count(*) FROM intents").fetchone()[0]:
                raise AgentError("journal-risk-state-missing")
            risk = {"version": 1, "peak": max(0, account.balance), "drawdownLatched": False,
                    "day": datetime.now(timezone.utc).date().isoformat(),
                    "dayStartBalance": max(0, account.balance), "dayPnl": 0,
                    "consecutiveLosses": 0, "pauseUntil": 0}
        else:
            risk = json.loads(stored)
            if not isinstance(risk, dict) or risk.get("version") != 1 or not all(number(risk.get(k)) for k in ("peak", "dayStartBalance", "dayPnl", "consecutiveLosses", "pauseUntil")) or not isinstance(risk.get("drawdownLatched"), bool):
                raise AgentError("journal-risk-state-invalid")
        risk["peak"] = max(risk["peak"], account.balance)
        if risk["peak"] > 0 and account.equity <= risk["peak"] * 0.9:
            risk["drawdownLatched"] = True
        day = datetime.now(timezone.utc).date().isoformat()
        if day < risk["day"]:
            raise AgentError("clock-moved-backwards")
        if day > risk["day"] or (risk["dayStartBalance"] <= 0 and account.balance > 0):
            risk["day"], risk["dayStartBalance"], risk["dayPnl"] = day, account.balance, 0
        encoded = json.dumps(risk, sort_keys=True)
        if encoded != stored:
            with self.db:
                self.set_meta("risk", encoded)
        return risk

    def record_outcome(self, receipt):
        stored = self.meta("risk")
        if not stored:
            raise AgentError("journal-risk-state-missing")
        risk = json.loads(stored)
        pnl = receipt["pnl"]
        if pnl < -1e-9:
            risk["consecutiveLosses"] += 1
            if risk["consecutiveLosses"] >= 3:
                risk["pauseUntil"] = max(risk["pauseUntil"], now_ms() + 300000)
        elif pnl > 1e-9:
            risk["consecutiveLosses"] = 0
        if datetime.fromtimestamp(receipt["closedAt"] / 1000, timezone.utc).date().isoformat() == risk["day"]:
            risk["dayPnl"] += pnl
        self.set_meta("risk", json.dumps(risk, sort_keys=True))

    def allowed_risk(self, account):
        risk = self.observe_risk(account)
        if risk["drawdownLatched"] or risk["pauseUntil"] > now_ms():
            return 0
        return max(0, min(1, min(account.balance, account.equity) * 0.015,
            risk["dayStartBalance"] * 0.03 + risk["dayPnl"],
            account.equity - risk["peak"] * 0.9))

    def close(self):
        self.db.close()
        self.lock.close()


class BridgeHTTP:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise AgentError("bridge-redirect-refused")

    def __init__(self, origin, token, allow_http_loopback=False):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not parsed.hostname:
            raise AgentError("invalid-bridge-origin")
        if parsed.scheme != "https" and not (allow_http_loopback and parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise AgentError("https-bridge-origin-required")
        if not re.fullmatch(r"rhp5_[A-Za-z0-9_-]{43}", token):
            raise AgentError("invalid-bridge-token")
        self.origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self.endpoint = self.origin + "/api/mt5/agent/poll"
        self.token = token
        self.opener = urllib.request.build_opener(self.NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def exchange(self, payload):
        request = urllib.request.Request(self.endpoint, json.dumps(payload, allow_nan=False).encode(),
                    {"Content-Type": "application/json", "Authorization": "Bearer " + self.token}, method="POST")
        try:
            with self.opener.open(request, timeout=8) as response:
                data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise AgentError("bridge-response-too-large")
            result = json.loads(data)
            if (not isinstance(result, dict) or result.get("protocol") != PROTOCOL or result.get("liveEnabled") is not False
                    or not isinstance(result.get("ack"), list) or len(result["ack"]) > 20
                    or any(not isinstance(k, str) or not re.fullmatch(r"[a-f0-9]{24}", k) for k in result["ack"])
                    or not isinstance(result.get("reconcile"), list) or len(result["reconcile"]) > 20):
                raise AgentError("invalid-bridge-response")
            return result
        except urllib.error.HTTPError as error:
            raise AgentError("bridge-http-" + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise AgentError("bridge-unavailable") from None


class Agent:
    def __init__(self, mt5, journal, login, server, symbol, enable_demo=False):
        if not identifier(str(login)) or not server or not symbol or len(server) > 80 or len(symbol) > 80:
            raise AgentError("exact-terminal-account-required")
        self.mt5, self.journal = mt5, journal
        self.login, self.server, self.symbol = str(login), server, symbol
        self.enable_demo = enable_demo
        self.session = str(uuid.uuid4())

    def account(self):
        a, terminal = self.mt5.account_info(), self.mt5.terminal_info()
        if a is None or terminal is None or not terminal.connected:
            raise AgentError("terminal-disconnected")
        if str(a.login) != self.login or a.server != self.server or "deriv" not in a.company.lower():
            raise AgentError("terminal-account-mismatch")
        for value in (a.balance, a.equity, a.margin_free):
            if not number(value):
                raise AgentError("invalid-terminal-equity")
        self.journal.observe_risk(a)
        return a, terminal

    def require_demo(self):
        a, terminal = self.account()
        if not self.enable_demo or a.trade_mode != 0:
            raise AgentError("real-orders-disabled-demo-opt-in-required")
        if a.currency != "USD" or a.margin_mode != 2:
            raise AgentError("usd-hedging-demo-required")
        if not a.trade_allowed or not a.trade_expert or not terminal.trade_allowed or getattr(terminal, "tradeapi_disabled", True):
            raise AgentError("terminal-trading-disabled")
        return a

    def positions(self):
        positions, orders = self.mt5.positions_get(), self.mt5.orders_get()
        if positions is None or orders is None:
            raise AgentError("terminal-exposure-unknown")
        if len(positions) > 100 or len(orders) > 100:
            raise AgentError("terminal-exposure-capacity")
        return positions, orders

    def quote(self):
        if not self.mt5.symbol_select(self.symbol, True):
            raise AgentError("terminal-symbol-unavailable")
        q, tick = self.mt5.symbol_info(self.symbol), self.mt5.symbol_info_tick(self.symbol)
        if q is None or tick is None:
            raise AgentError("terminal-quote-unavailable")
        values = [q.point, q.trade_tick_size, q.trade_tick_value_loss, q.volume_min, q.volume_max, q.volume_step, tick.bid, tick.ask]
        if not all(positive(value) for value in values) or tick.ask < tick.bid:
            raise AgentError("terminal-symbol-specification-unavailable")
        return q, tick

    def snapshot(self):
        a, terminal = self.account()
        self.reconcile()
        a, terminal = self.account()  # reconciliation/closing can change cash
        q, tick = self.quote()
        positions, orders = self.positions()
        results, versions = self.journal.pending()
        payload = {"protocol": PROTOCOL, "instanceId": self.journal.meta("instance"),
            "sessionId": self.session, "sequence": self.journal.sequence(),
            "account": {"login": str(a.login), "server": a.server, "company": a.company,
                "tradeMode": a.trade_mode, "marginMode": a.margin_mode, "currency": a.currency,
                "balance": a.balance, "equity": a.equity, "freeMargin": a.margin_free,
                "tradeAllowed": bool(a.trade_allowed and terminal.trade_allowed),
                "expertAllowed": bool(a.trade_expert and not getattr(terminal, "tradeapi_disabled", True))},
            "quote": {"symbol": self.symbol, "bid": tick.bid, "ask": tick.ask,
                "timeMsc": int(tick.time_msc), "point": q.point, "digits": q.digits,
                "tickSize": q.trade_tick_size, "tickValueLoss": q.trade_tick_value_loss,
                "volumeMin": q.volume_min, "volumeMax": q.volume_max, "volumeStep": q.volume_step,
                "stopsLevel": q.trade_stops_level, "freezeLevel": q.trade_freeze_level, "tradeMode": q.trade_mode},
            "positions": [{"id": str(p.identifier), "symbol": p.symbol, "side": "BUY" if p.type == 0 else "SELL",
                "volume": p.volume, "entry": p.price_open, "sl": p.sl, "tp": p.tp} for p in positions],
            "pendingOrders": len(orders), "results": results}
        return payload, versions

    def filling(self, q):
        # Use only FOK or IOC: RETURN can leave a residual order active.
        if q.filling_mode & 1:
            return self.mt5.ORDER_FILLING_FOK
        if q.filling_mode & 2:
            return self.mt5.ORDER_FILLING_IOC
        raise AgentError("unsupported-filling-policy")

    def preflight(self, c):
        a = self.require_demo()
        if c.get("protocol") != PROTOCOL or c.get("demoOnly") is not True or c.get("action") != "open" or c.get("sessionId") != self.session:
            raise AgentError("invalid-demo-command")
        if c.get("login") != self.login or c.get("server") != self.server or c.get("symbol") != self.symbol:
            raise AgentError("command-account-mismatch")
        if not number(c.get("createdAt")) or not number(c.get("expiresAt")) or c["createdAt"] > now_ms() + 2000 or not 0 < c["expiresAt"] - c["createdAt"] <= 5000 or c["expiresAt"] < now_ms():
            raise AgentError("command-expired")
        if c.get("side") not in ("BUY", "SELL") or not all(positive(c.get(key)) for key in ("volume", "sl", "tp", "worstEntry", "maxRisk")) or not number(c.get("costBuffer")) or c["costBuffer"] < 0.10:
            raise AgentError("invalid-command-risk")
        if c["maxRisk"] > self.journal.allowed_risk(a) + 1e-9:
            raise AgentError("command-risk-ceiling")
        s = c.get("exitSettings")
        if not isinstance(s, dict) or not all(positive(s.get(k)) for k in ("lockAfterR", "trailAfterR", "trailByR")) or s["trailAfterR"] <= s["lockAfterR"] or not isinstance(s.get("lockInProfit"), bool) or not isinstance(s.get("trailing"), bool):
            raise AgentError("invalid-profit-protection")
        if not 0.1 <= s["lockAfterR"] <= 1 or not 0.2 <= s["trailAfterR"] <= 3 or not 0.1 <= s["trailByR"] <= 2:
            raise AgentError("invalid-profit-protection")
        if not number(c.get("maxHoldSeconds")) or not 30 <= c["maxHoldSeconds"] <= 600 or not isinstance(c.get("deviationPoints"), int) or not 0 <= c["deviationPoints"] <= 20:
            raise AgentError("invalid-command-limits")
        positions, orders = self.positions()
        if positions or orders or any(row["id"] != c["id"] for row in self.journal.active()):
            raise AgentError("existing-account-exposure")
        q, tick = self.quote()
        if not -2000 <= now_ms() - int(tick.time_msc) <= 8000 or q.trade_mode != 4:
            raise AgentError("stale-or-untradeable-quote")
        volume = c["volume"]
        if volume < q.volume_min - 1e-10 or volume > q.volume_max + 1e-10 or abs(volume / q.volume_step - round(volume / q.volume_step)) > 1e-7:
            raise AgentError("invalid-broker-volume")
        side = self.mt5.ORDER_TYPE_BUY if c["side"] == "BUY" else self.mt5.ORDER_TYPE_SELL
        direction = 1 if c["side"] == "BUY" else -1
        price = tick.ask if direction == 1 else tick.bid
        if (price - c["sl"]) * direction <= 0 or (c["tp"] - price) * direction <= 0 or (price - c["worstEntry"]) * direction > 1e-9:
            raise AgentError("price-moved-outside-command")
        distance = max(q.trade_stops_level, q.trade_freeze_level) * q.point
        if (tick.bid - c["sl"] if direction == 1 else c["sl"] - tick.ask) < distance or (c["tp"] - tick.ask if direction == 1 else tick.bid - c["tp"]) < distance:
            raise AgentError("invalid-broker-stop-distance")
        for value in (c["sl"], c["tp"]):
            if abs(value / q.trade_tick_size - round(value / q.trade_tick_size)) > 1e-6:
                raise AgentError("invalid-broker-price-step")
        pnl = self.mt5.order_calc_profit(side, self.symbol, volume, c["worstEntry"], c["sl"])
        margin = self.mt5.order_calc_margin(side, self.symbol, volume, price)
        if not number(pnl) or pnl >= 0 or abs(pnl) + c["costBuffer"] > c["maxRisk"] + 1e-8 or not positive(margin) or margin * 1.10 > a.margin_free:
            raise AgentError("broker-risk-or-margin-check-failed")
        request = {"action": self.mt5.TRADE_ACTION_DEAL, "symbol": self.symbol,
            "volume": volume, "type": side, "price": price, "sl": c["sl"], "tp": c["tp"],
            "deviation": c["deviationPoints"], "magic": MAGIC, "comment": "RHP" + c["id"],
            "type_time": self.mt5.ORDER_TIME_GTC, "type_filling": self.filling(q)}
        if getattr(q, "trade_exemode", None) == 2:
            request.pop("price")  # market-execution DEAL does not set request.price
        check = self.mt5.order_check(request)
        if check is None or check.retcode != 0:
            raise AgentError("broker-order-check-rejected")
        self.require_demo()  # recheck immediately before the caller can submit
        if c["expiresAt"] < now_ms():
            raise AgentError("command-expired")
        return request

    def execute(self, command):
        if not isinstance(command, dict) or not isinstance(command.get("id"), str) or not re.fullmatch(r"[a-f0-9]{24}", command["id"]):
            raise AgentError("invalid-command-id")
        if not self.journal.claim(command):
            return  # NEVER resend a claimed intent, even after restart/timeout
        key = command["id"]
        try:
            request = self.preflight(command)
        except AgentError:
            self.journal.result(key, {"id": key, "status": "rejected"})
            return
        self.journal.phase(key, "submitting")  # fsync BEFORE the non-idempotent call
        try:
            result = self.mt5.order_send(request)
        except Exception:
            result = None
        if result is not None and result.retcode in REJECT_CODES:
            self.journal.result(key, {"id": key, "status": "rejected"})
            return
        order = str(result.order) if result is not None and getattr(result, "order", 0) > 0 else None
        self.journal.phase(key, "uncertain", order)
        self.journal.result(key, {"id": key, "status": "uncertain"})
        self.reconcile()  # use positions/deal history, not an invented local fill

    def recover(self, command):
        # This is evidence gathering, NEVER an instruction to order_send.
        # Same pinned journal: no local intent proves the mandatory pre-send
        # transaction never occurred. Existing ambiguous intents stay reserved.
        if (not isinstance(command, dict) or not isinstance(command.get("id"), str)
                or not re.fullmatch(r"[a-f0-9]{24}", command["id"]) or command.get("protocol") != PROTOCOL
                or command.get("login") != self.login or command.get("server") != self.server
                or command.get("symbol") != self.symbol or command.get("demoOnly") is not True):
            raise AgentError("recovery-account-mismatch")
        if self.journal.claim(command):
            self.journal.result(command["id"], {"id": command["id"], "status": "rejected"})

    def deals_for(self, row):
        if row["position_id"]:
            deals = self.mt5.history_deals_get(position=int(row["position_id"]))
        elif row["broker_order"]:
            deals = self.mt5.history_deals_get(ticket=int(row["broker_order"]))
        else:
            start = datetime.fromtimestamp((row["created_at"] - 60000) / 1000, timezone.utc)
            end = datetime.fromtimestamp(min(now_ms(), row["created_at"] + 900000) / 1000, timezone.utc)
            deals = self.mt5.history_deals_get(start, end)
            if deals is not None:
                deals = tuple(d for d in deals if d.comment == "RHP" + row["id"] and d.magic == MAGIC)
        if deals is None:
            raise AgentError("broker-history-unavailable")
        if len(deals) > 1000:
            raise AgentError("broker-history-capacity")
        ids = {d.position_id for d in deals if d.position_id > 0}
        if len(ids) > 1:
            raise AgentError("ambiguous-broker-position")
        if not ids:
            return None, ()
        position_id = next(iter(ids))
        complete = self.mt5.history_deals_get(position=position_id)
        if complete is None or len(complete) > 1000:
            raise AgentError("broker-history-unavailable")
        return position_id, complete

    def reconcile(self):
        self.account()
        positions, _ = self.positions()
        for row in self.journal.active():
            key = row["id"]
            if row["phase"] == "preparing":
                self.journal.result(key, {"id": key, "status": "rejected"})
                continue  # a crash before 'submitting' cannot have sent this intent
            position_id, deals = self.deals_for(row)
            if position_id is None:
                self.journal.result(key, {"id": key, "status": "uncertain"})
                continue  # absence from a statement is NOT permission to retry
            entries = [d for d in deals if d.entry == 0]
            exits = [d for d in deals if d.entry in (1, 3)]
            if not entries or any(d.entry not in (0, 1, 3) for d in deals):
                raise AgentError("unrecognised-deal-lifecycle")
            owned = [p for p in positions if p.identifier == position_id]
            if owned:
                if len(owned) != 1:
                    raise AgentError("ambiguous-broker-position")
                p = owned[0]
                if p.magic != MAGIC or p.symbol != self.symbol:
                    self.journal.result(key, {"id": key, "status": "uncertain", "positionId": str(position_id)})
                    continue
                c = json.loads(row["payload"])
                stop_pnl = self.mt5.order_calc_profit(p.type, self.symbol, p.volume, p.price_open, p.sl) if p.sl > 0 else None
                breached = (p.sl <= 0 or p.tp <= 0 or p.volume > c["volume"] + 1e-8
                    or not number(stop_pnl) or max(0, -stop_pnl) + c["costBuffer"] > c["maxRisk"] + 1e-8)
                if breached:
                    self.journal.result(key, {"id": key, "status": "uncertain", "positionId": str(position_id)})
                    self.protect(self.journal.get(key), p, urgent=True)
                    continue
                self.journal.result(key, {"id": key, "status": "filled", "positionId": str(position_id),
                    "volume": p.volume, "entry": p.price_open, "sl": p.sl, "tp": p.tp})
                self.protect(self.journal.get(key), p)
            else:
                entry_volume = sum(d.volume for d in entries)
                exit_volume = sum(d.volume for d in exits)
                if not exits or abs(entry_volume - exit_volume) > 1e-8:
                    self.journal.result(key, {"id": key, "status": "uncertain", "positionId": str(position_id)})
                    continue
                gross, commission, swap, fee = [sum(getattr(d, k) for d in deals) for k in ("profit", "commission", "swap", "fee")]
                if not all(number(v) for v in (gross, commission, swap, fee)):
                    raise AgentError("invalid-broker-settlement")
                self.journal.result(key, {"id": key, "status": "closed", "positionId": str(position_id),
                    "grossProfit": gross, "commission": commission, "swap": swap, "fee": fee,
                    "pnl": gross + commission + swap + fee, "entryVolume": entry_volume,
                    "exitVolume": exit_volume, "dealCount": len(deals), "closedAt": max(int(d.time_msc) for d in exits)})

    def protect(self, row, position, urgent=False):
        if not self.enable_demo:
            return
        try:
            self.require_demo()
        except AgentError:
            return  # a real/changed terminal can NEVER reach order_send, including SLTP
        c = json.loads(row["payload"])
        q, tick = self.quote()
        if not -2000 <= now_ms() - int(tick.time_msc) <= 8000 or (not urgent and int(tick.time_msc) <= row["last_tick"]):
            return
        with self.journal.db:
            self.journal.db.execute("UPDATE intents SET last_tick=? WHERE id=?", (int(tick.time_msc), row["id"]))
        if urgent or now_ms() - row["created_at"] > c["maxHoldSeconds"] * 1000:
            if row["closing"]:
                return
            # One close submission, never retry an ambiguous market close. A
            # confirmed broker SL/TP continues protecting residual exposure.
            with self.journal.db:
                self.journal.db.execute("UPDATE intents SET closing=1 WHERE id=?", (row["id"],))
            close = {"action": self.mt5.TRADE_ACTION_DEAL, "symbol": self.symbol,
                "position": position.ticket, "volume": position.volume,
                "type": self.mt5.ORDER_TYPE_SELL if position.type == 0 else self.mt5.ORDER_TYPE_BUY,
                "price": tick.bid if position.type == 0 else tick.ask, "deviation": 20,
                "magic": MAGIC, "comment": "RHPC" + row["id"],
                "type_time": self.mt5.ORDER_TIME_GTC, "type_filling": self.filling(q)}
            self.require_demo()
            if getattr(q, "trade_exemode", None) == 2:
                close.pop("price")
            try:
                self.mt5.order_send(close)
            except Exception:
                pass
            return
        settings = c["exitSettings"]
        if not settings["lockInProfit"]:
            return
        direction = 1 if position.type == 0 else -1
        price = tick.bid if direction == 1 else tick.ask
        initial_distance = abs(position.price_open - c["sl"])
        if initial_distance <= 0:
            return
        gain_r = (price - position.price_open) * direction / initial_distance
        if gain_r < settings["lockAfterR"]:
            return
        candidate = position.price_open
        if settings["trailing"] and gain_r >= settings["trailAfterR"]:
            candidate = price - direction * initial_distance * settings["trailByR"]
        distance = (max(q.trade_stops_level, q.trade_freeze_level) + 2) * q.point
        candidate = min(candidate, tick.bid - distance) if direction == 1 else max(candidate, tick.ask + distance)
        candidate = (math.floor(candidate / q.trade_tick_size) if direction == 1 else math.ceil(candidate / q.trade_tick_size)) * q.trade_tick_size
        candidate = round(candidate, q.digits)
        if candidate <= 0 or (candidate - position.sl) * direction <= q.trade_tick_size / 2:
            return
        self.require_demo()
        try:
            self.mt5.order_send({"action": self.mt5.TRADE_ACTION_SLTP, "symbol": self.symbol,
                "position": position.ticket, "sl": candidate, "tp": position.tp})
        except Exception:
            pass  # reread broker SL next tick; amendment cannot open a new position


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable-demo", action="store_true", help="Explicit local opt-in; real orders remain impossible")
    parser.add_argument("--check", action="store_true", help="Read-only terminal diagnostic; makes no HTTP request")
    parser.add_argument("--allow-http-loopback", action="store_true", help="Local fixture testing only")
    args = parser.parse_args()
    journal = None
    mt5 = None
    try:
        login = os.environ.get("MT5_LOGIN", "")
        server = os.environ.get("MT5_SERVER", "")
        symbol = os.environ.get("MT5_SYMBOL", "XAUUSD")
        origin = os.environ.get("RHP_URL", "https://r-h-pilot-3.onrender.com")
        if not identifier(login) or not server:
            raise AgentError("set-exact-MT5_LOGIN-and-MT5_SERVER-locally")
        token = os.environ.get("RHP_BRIDGE_TOKEN") or ("rhp5_" + "a" * 43 if args.check else getpass.getpass("Private one-time bridge token: "))
        http = BridgeHTTP(origin, token, args.allow_http_loopback)
        import MetaTrader5 as mt5  # Windows-only optional dependency, NEVER installed on Render
        terminal_path = os.environ.get("MT5_TERMINAL_PATH")
        if not (mt5.initialize(terminal_path) if terminal_path else mt5.initialize()):
            raise AgentError("terminal-initialize-failed")
        data = Path(os.environ.get("RHP_AGENT_DATA", str(Path.home() / ".rhpilot-mt5")))
        journal = Journal(data / "journal.sqlite3", {"origin": http.origin, "login": login, "server": server, "symbol": symbol})
        agent = Agent(mt5, journal, login, server, symbol, args.enable_demo)
        if args.check:
            agent.account()
            agent.quote()
            agent.positions()
            print("Terminal/account/symbol confirmed. Read-only check; no orders or login credentials sent.")
            return 0
        print("R.H Pilot MT5 agent: DEMO opt-in enabled." if args.enable_demo else "R.H Pilot MT5 agent: MONITOR ONLY.")
        print("Real-money orders are disabled in every mode. Keep this computer and terminal running.")
        future, versions, next_exchange, backoff = None, {}, 0.0, 1.0
        last_status = None
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as worker:
            while True:
                # Terminal protection is independent of the HTTP worker: an
                # asleep/unreachable Render service cannot block this loop.
                try:
                    agent.reconcile()
                except AgentError as error:
                    if str(error) != last_status:
                        print("Terminal hold:", str(error), flush=True)
                        last_status = str(error)
                    time.sleep(1)
                    continue
                if future is not None and future.done():
                    try:
                        reply = future.result()
                        journal.acknowledge(reply["ack"], versions)
                        for command in reply["reconcile"]:
                            agent.recover(command)
                        if reply.get("command") is not None:
                            agent.execute(reply["command"])
                        backoff = 1.0
                        last_status = None
                    except (AgentError, OSError, sqlite3.Error) as error:
                        code = str(error) if isinstance(error, AgentError) else "journal-unavailable"
                        if code != last_status:
                            print("Entries held:", code, flush=True)
                            last_status = code
                        backoff = min(30.0, backoff * 2)
                    future = None
                    next_exchange = time.monotonic() + backoff
                if future is None and time.monotonic() >= next_exchange:
                    try:
                        payload, versions = agent.snapshot()
                        future = worker.submit(http.exchange, payload)
                    except AgentError as error:
                        if str(error) != last_status:
                            print("Terminal hold:", str(error), flush=True)
                            last_status = str(error)
                        next_exchange = time.monotonic() + 1.0
                time.sleep(0.25)
    except KeyboardInterrupt:
        print("Agent stopped. Manage any open exposure in MT5; broker SL/TP are not cancelled.")
        return 0
    except (AgentError, ImportError, OSError, sqlite3.Error) as error:
        code = str(error) if isinstance(error, AgentError) else "agent-dependency-or-journal-unavailable"
        print("Agent could not continue:", code, file=sys.stderr)
        return 1
    finally:
        if journal:
            journal.close()
        if mt5:
            mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
