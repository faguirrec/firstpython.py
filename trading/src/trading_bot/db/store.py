"""SQLite persistence.

One class, ``Store``, wraps every read and write the agents need. Queries are
plain SQL so the same schema can move to Postgres with minimal changes if the
pilot scales past SQLite.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..clock import iso, parse_iso, trading_day, utcnow

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connect(database: str | Path, *, same_thread: bool = True) -> sqlite3.Connection:
    """Open a SQLite connection configured for concurrent agent access."""
    path = Path(database)
    in_memory = str(path) == ":memory:"
    if not in_memory:
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(path), timeout=30.0, isolation_level=None, check_same_thread=same_thread
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if not in_memory:
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def _json(value: Any) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def _loads(value: Any) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}


@dataclass(frozen=True)
class SignalWeight:
    name: str
    weight: float
    hits: int
    misses: int
    ema_accuracy: float
    net_pnl: float

    @property
    def samples(self) -> int:
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        return self.hits / self.samples if self.samples else 0.5


class Store:
    """Auditable storage for news, decisions, orders, trades and metrics.

    **Thread safety.** A SQLite connection belongs to the thread that opened it,
    and the production scheduler (APScheduler) runs every job on a worker thread
    from a pool. So a file-backed store hands each thread its own connection;
    WAL plus a 30s busy timeout lets them write concurrently.

    An in-memory database is the exception: it *is* the connection, so a
    per-thread connection would hand each thread a different empty database.
    Those share one connection with ``check_same_thread=False`` instead, which is
    safe because every write here is a single autocommit statement.
    """

    def __init__(self, database: str | Path = "trading_bot.db") -> None:
        self.database = str(database)
        self._in_memory = self.database == ":memory:"
        self._local = threading.local()
        self._connections: list[sqlite3.Connection] = []
        self._lock = threading.Lock()
        self._shared: sqlite3.Connection | None = (
            self._track(connect(self.database, same_thread=False)) if self._in_memory else None
        )
        self.migrate()

    def _track(self, conn: sqlite3.Connection) -> sqlite3.Connection:
        with self._lock:
            self._connections.append(conn)
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        """The connection this thread may use."""
        if self._shared is not None:
            return self._shared
        existing = getattr(self._local, "conn", None)
        if existing is None:
            existing = self._track(connect(self.database))
            self._local.conn = existing
        return existing

    # ---------------------------------------------------------------- lifecycle
    # Columns added after the first release; SQLite needs them backfilled by
    # hand because CREATE TABLE IF NOT EXISTS will not alter an existing table.
    _ADDED_COLUMNS = (
        ("orders", "client_order_id", "TEXT"),
        ("orders", "booked_qty", "REAL NOT NULL DEFAULT 0"),
    )

    def migrate(self) -> None:
        self.conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        for table, column, spec in self._ADDED_COLUMNS:
            existing = {row["name"] for row in self._rows(f"PRAGMA table_info({table})")}
            if column not in existing:
                self._exec(f"ALTER TABLE {table} ADD COLUMN {column} {spec}")

    def close(self) -> None:
        with self._lock:
            connections = list(self._connections)
            self._connections.clear()
        self._shared = None
        self._local = threading.local()
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                pass

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _exec(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, tuple(params))

    def _rows(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self._exec(sql, params).fetchall()]

    def _row(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        row = self._exec(sql, params).fetchone()
        return dict(row) if row is not None else None

    # -------------------------------------------------------------------- state
    def set_state(self, key: str, value: Any) -> None:
        self._exec(
            "INSERT INTO state(key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, _json(value), iso()),
        )

    def get_state(self, key: str, default: Any = None) -> Any:
        row = self._row("SELECT value FROM state WHERE key = ?", (key,))
        if row is None:
            return default
        return _loads(row["value"]) if row["value"] else default

    # --------------------------------------------------------------------- news
    def insert_news(self, item: dict[str, Any]) -> int | None:
        """Insert a news item; returns ``None`` when it is a duplicate."""
        cursor = self._exec(
            "INSERT OR IGNORE INTO news_items"
            "(source, external_id, content_hash, headline, summary, url, author,"
            " symbols, published_at, fetched_at, classified)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,0)",
            (
                item.get("source", "unknown"),
                item.get("external_id"),
                item["content_hash"],
                item.get("headline", ""),
                item.get("summary"),
                item.get("url"),
                item.get("author"),
                ",".join(item.get("symbols", []) or []),
                item.get("published_at"),
                item.get("fetched_at") or iso(),
            ),
        )
        if cursor.rowcount == 0:
            return None
        return int(cursor.lastrowid)

    def unclassified_news(self, limit: int = 25) -> list[dict[str, Any]]:
        rows = self._rows(
            "SELECT * FROM news_items WHERE classified = 0 ORDER BY published_at DESC LIMIT ?",
            (limit,),
        )
        for row in rows:
            row["symbols"] = [s for s in (row.get("symbols") or "").split(",") if s]
        return rows

    def mark_news_classified(self, news_id: int) -> None:
        self._exec("UPDATE news_items SET classified = 1 WHERE id = ?", (news_id,))

    def insert_sentiment(self, record: dict[str, Any]) -> int:
        cursor = self._exec(
            "INSERT INTO sentiment_scores"
            "(news_id, symbol, sentiment_score, confidence, horizon, one_liner, is_rumor,"
            " model, published_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(news_id, symbol) DO UPDATE SET"
            "  sentiment_score=excluded.sentiment_score, confidence=excluded.confidence,"
            "  horizon=excluded.horizon, one_liner=excluded.one_liner, is_rumor=excluded.is_rumor",
            (
                record["news_id"],
                record["symbol"].upper(),
                float(record["sentiment_score"]),
                float(record["confidence"]),
                record.get("horizon", "intraday"),
                record.get("one_liner"),
                int(bool(record.get("is_rumor", False))),
                record.get("model"),
                record.get("published_at"),
                iso(),
            ),
        )
        return int(cursor.lastrowid)

    def recent_sentiment(self, symbol: str, *, hours: float = 24.0) -> list[dict[str, Any]]:
        cutoff = iso(utcnow() - timedelta(hours=hours))
        return self._rows(
            "SELECT * FROM sentiment_scores WHERE symbol = ?"
            " AND COALESCE(published_at, created_at) >= ?"
            " ORDER BY COALESCE(published_at, created_at) DESC",
            (symbol.upper(), cutoff),
        )

    def sentiment_for_trade(self, symbol: str, opened_at: str, closed_at: str) -> list[dict[str, Any]]:
        return self._rows(
            "SELECT * FROM sentiment_scores WHERE symbol = ?"
            " AND COALESCE(published_at, created_at) BETWEEN ? AND ?",
            (symbol.upper(), opened_at, closed_at),
        )

    # ---------------------------------------------------------------- decisions
    def record_decision(self, decision: dict[str, Any]) -> int:
        cursor = self._exec(
            "INSERT INTO decisions"
            "(created_at, trading_day, session, symbol, action, fused_score, confidence,"
            " expected_move_bps, reference_price, limit_price, quantity, signals_json,"
            " ev_json, approved, reason)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                decision.get("created_at") or iso(),
                decision.get("trading_day") or trading_day().isoformat(),
                decision.get("session", "unknown"),
                decision["symbol"].upper(),
                decision.get("action", "hold"),
                float(decision.get("fused_score", 0.0)),
                float(decision.get("confidence", 0.0)),
                float(decision.get("expected_move_bps", 0.0)),
                decision.get("reference_price"),
                decision.get("limit_price"),
                decision.get("quantity"),
                _json(decision.get("signals", {})),
                _json(decision.get("ev", {})),
                int(bool(decision.get("approved", False))),
                decision.get("reason", ""),
            ),
        )
        return int(cursor.lastrowid)

    def decision_signals(self, decision_id: int) -> tuple[dict[str, Any], float | None]:
        """Signals and expected move recorded for a decision, for later grading."""
        row = self._row(
            "SELECT signals_json, expected_move_bps FROM decisions WHERE id = ?", (decision_id,)
        )
        if row is None:
            return {}, None
        return _loads(row.get("signals_json")), row.get("expected_move_bps")

    def attach_order_to_decision(self, decision_id: int, order_id: int) -> None:
        self._exec("UPDATE decisions SET order_id = ? WHERE id = ?", (order_id, decision_id))

    def decision_reason(self, decision_id: int) -> str:
        row = self._row("SELECT reason FROM decisions WHERE id = ?", (decision_id,))
        return str(row["reason"]) if row else ""

    def decisions_for_day(self, day: date | str | None = None) -> list[dict[str, Any]]:
        key = _day_key(day)
        rows = self._rows(
            "SELECT * FROM decisions WHERE trading_day = ? ORDER BY created_at", (key,)
        )
        for row in rows:
            row["signals"] = _loads(row.pop("signals_json", ""))
            row["ev"] = _loads(row.pop("ev_json", ""))
        return rows

    # ------------------------------------------------------------------- orders
    def record_order(self, order: dict[str, Any]) -> int:
        now = iso()
        cursor = self._exec(
            "INSERT INTO orders"
            "(broker_order_id, client_order_id, decision_id, created_at, updated_at, trading_day,"
            " symbol, side, quantity, notional, limit_price, order_type, time_in_force, status,"
            " filled_qty, filled_avg_price, intent, trade_id, raw)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                order.get("broker_order_id"),
                order.get("client_order_id"),
                order.get("decision_id"),
                order.get("created_at") or now,
                now,
                order.get("trading_day") or trading_day().isoformat(),
                order["symbol"].upper(),
                order["side"],
                float(order.get("quantity", 0.0)),
                order.get("notional"),
                order.get("limit_price"),
                order.get("order_type", "limit"),
                order.get("time_in_force", "day"),
                order.get("status", "new"),
                float(order.get("filled_qty", 0.0)),
                order.get("filled_avg_price"),
                order.get("intent", "entry"),
                order.get("trade_id"),
                _json(order.get("raw", {})),
            ),
        )
        return int(cursor.lastrowid)

    def update_order(self, order_id: int, **fields: Any) -> None:
        if not fields:
            return
        allowed = {
            "broker_order_id", "client_order_id", "status", "filled_qty", "booked_qty",
            "filled_avg_price", "limit_price", "quantity", "trade_id", "raw", "intent",
        }
        updates = {k: (_json(v) if k == "raw" else v) for k, v in fields.items() if k in allowed}
        if not updates:
            return
        assignments = ", ".join(f"{k} = ?" for k in updates)
        self._exec(
            f"UPDATE orders SET {assignments}, updated_at = ? WHERE id = ?",
            (*updates.values(), iso(), order_id),
        )

    def open_orders(self) -> list[dict[str, Any]]:
        """Orders that are still working at the broker."""
        placeholders = ",".join("?" * len(self.LIVE_ORDER_STATUSES))
        return self._rows(
            f"SELECT * FROM orders WHERE status IN ({placeholders}) ORDER BY created_at",
            self.LIVE_ORDER_STATUSES,
        )

    def get_order(self, order_id: int) -> dict[str, Any] | None:
        return self._row("SELECT * FROM orders WHERE id = ?", (order_id,))

    def unconfirmed_orders(self) -> list[dict[str, Any]]:
        """Rows written before the broker call returned an id.

        A crash between `record_order` and `submit_limit_order` leaves these. They
        must be recovered or retired, never ignored: an orphaned exit row makes
        `_has_open_exit` true forever and silently disables that trade's stop.
        """
        return self._rows(
            "SELECT * FROM orders WHERE broker_order_id IS NULL"
            " AND status NOT IN ('canceled','rejected','expired','unknown','filled')"
            " ORDER BY created_at"
        )

    def grow_trade(self, trade_id: int, *, quantity: float, price: float) -> None:
        """Add a later fill of the same order, blending the entry price."""
        trade = self.get_trade(trade_id)
        if trade is None or trade.get("status") == "closed":
            return
        held = float(trade["quantity"])
        entry = float(trade["entry_price"])
        total = held + quantity
        if total <= 0:
            return
        blended = (entry * held + price * quantity) / total
        self._exec(
            "UPDATE trades SET quantity = ?, entry_price = ? WHERE id = ?",
            (total, blended, trade_id),
        )

    def shrink_trade(self, trade_id: int, quantity: float) -> None:
        """Reduce an open trade's size after a partial exit."""
        self._exec(
            "UPDATE trades SET quantity = MAX(quantity - ?, 0) WHERE id = ?",
            (float(quantity), trade_id),
        )

    def order_by_broker_id(self, broker_order_id: str) -> dict[str, Any] | None:
        return self._row("SELECT * FROM orders WHERE broker_order_id = ?", (broker_order_id,))

    def orders_for_day(self, day: date | str | None = None) -> list[dict[str, Any]]:
        return self._rows("SELECT * FROM orders WHERE trading_day = ? ORDER BY created_at", (_day_key(day),))

    # Statuses that mean "this order can still consume buying power".
    LIVE_ORDER_STATUSES = (
        "new", "accepted", "partially_filled", "pending_new", "held", "accepted_for_bidding",
    )

    def count_entries_today(self, day: date | str | None = None) -> int:
        """Entries today that took risk: filled **or** still working.

        A resting limit order has already committed buying power, so counting
        only fills would let the daily budget be spent several times over.
        """
        placeholders = ",".join("?" * len(self.LIVE_ORDER_STATUSES))
        row = self._row(
            "SELECT COUNT(*) AS n FROM orders"
            f" WHERE trading_day = ? AND intent = 'entry'"
            f" AND (status = 'filled' OR status IN ({placeholders}))",
            (_day_key(day), *self.LIVE_ORDER_STATUSES),
        )
        return int(row["n"]) if row else 0

    # Kept for readers that specifically want completed entries.
    def count_filled_entries_today(self, day: date | str | None = None) -> int:
        """Filled *entries* today. Exits are not new risk and must not count."""
        row = self._row(
            "SELECT COUNT(*) AS n FROM orders"
            " WHERE trading_day = ? AND status = 'filled' AND intent = 'entry'",
            (_day_key(day),),
        )
        return int(row["n"]) if row else 0

    def symbols_with_live_orders(self) -> set[str]:
        """Symbols that already have a working order - pending exposure."""
        return {str(row["symbol"]).upper() for row in self.open_orders()}

    # ------------------------------------------------------------------- trades
    def open_trade(self, trade: dict[str, Any]) -> int:
        opened_at = trade.get("opened_at") or iso()
        cursor = self._exec(
            "INSERT INTO trades"
            "(symbol, status, quantity, entry_price, opened_at, opened_day, entry_order_id,"
            " decision_id, signals_json, expected_move_bps)"
            " VALUES (?, 'open', ?,?,?,?,?,?,?,?)",
            (
                trade["symbol"].upper(),
                float(trade["quantity"]),
                float(trade["entry_price"]),
                opened_at,
                trade.get("opened_day") or trading_day(parse_iso(opened_at)).isoformat(),
                trade.get("entry_order_id"),
                trade.get("decision_id"),
                _json(trade.get("signals", {})),
                trade.get("expected_move_bps"),
            ),
        )
        return int(cursor.lastrowid)

    def close_trade(self, trade_id: int, **fields: Any) -> None:
        closed_at = fields.get("closed_at") or iso()
        self._exec(
            "UPDATE trades SET status='closed', exit_price=?, closed_at=?, closed_day=?,"
            " exit_order_id=?, gross_pnl=?, fees=?, net_pnl=?, return_pct=?, exit_reason=?"
            " WHERE id = ?",
            (
                fields.get("exit_price"),
                closed_at,
                fields.get("closed_day") or trading_day(parse_iso(closed_at)).isoformat(),
                fields.get("exit_order_id"),
                fields.get("gross_pnl"),
                fields.get("fees"),
                fields.get("net_pnl"),
                fields.get("return_pct"),
                fields.get("exit_reason", "manual"),
                trade_id,
            ),
        )

    def get_trade(self, trade_id: int) -> dict[str, Any] | None:
        row = self._row("SELECT * FROM trades WHERE id = ?", (trade_id,))
        if row is not None:
            row["signals"] = _loads(row.get("signals_json"))
        return row

    def open_trades(self, symbol: str | None = None) -> list[dict[str, Any]]:
        if symbol:
            rows = self._rows(
                "SELECT * FROM trades WHERE status='open' AND symbol=? ORDER BY opened_at",
                (symbol.upper(),),
            )
        else:
            rows = self._rows("SELECT * FROM trades WHERE status='open' ORDER BY opened_at")
        for row in rows:
            row["signals"] = _loads(row.get("signals_json"))
        return rows

    def closed_trades(
        self, *, since: str | None = None, unreviewed_only: bool = False
    ) -> list[dict[str, Any]]:
        clauses = ["status = 'closed'"]
        params: list[Any] = []
        if since:
            clauses.append("closed_at >= ?")
            params.append(since)
        if unreviewed_only:
            clauses.append("reviewed = 0")
        rows = self._rows(
            f"SELECT * FROM trades WHERE {' AND '.join(clauses)} ORDER BY closed_at", params
        )
        for row in rows:
            row["signals"] = _loads(row.get("signals_json"))
        return rows

    def realized_hit_rate(self, *, limit: int = 200) -> tuple[int, int]:
        """``(wins, total)`` over the most recent closed trades.

        This is what the expected-value model should believe about its own hit
        rate. A win is a *net* win: a trade that made money after costs.
        """
        rows = self._rows(
            "SELECT net_pnl FROM trades WHERE status='closed' AND net_pnl IS NOT NULL"
            " ORDER BY closed_at DESC LIMIT ?",
            (limit,),
        )
        wins = sum(1 for row in rows if float(row["net_pnl"]) > 0)
        return wins, len(rows)

    def mark_trade_reviewed(self, trade_id: int) -> None:
        self._exec("UPDATE trades SET reviewed = 1 WHERE id = ?", (trade_id,))

    def day_trades_in_window(
        self, business_days: int = 5, *, as_of: date | str | None = None
    ) -> int:
        """Count round trips opened and closed on the same session recently.

        This is the bot's own conservative tally; ``account.daytrade_count`` from
        the broker remains authoritative when available. ``as_of`` anchors the
        window to a historical date so the backtester sees the same rule.
        """
        reference = date.fromisoformat(_day_key(as_of))
        cutoff = (reference - timedelta(days=business_days * 2)).isoformat()
        row = self._row(
            "SELECT COUNT(*) AS n FROM trades WHERE status='closed'"
            " AND opened_day = closed_day AND closed_day >= ? AND closed_day <= ?",
            (cutoff, reference.isoformat()),
        )
        return int(row["n"]) if row else 0

    # ---------------------------------------------------------------- portfolio
    def record_equity(self, snapshot: dict[str, Any]) -> int:
        cursor = self._exec(
            "INSERT INTO equity_snapshots"
            "(created_at, trading_day, equity, cash, buying_power, position_value, benchmark_price)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                snapshot.get("created_at") or iso(),
                snapshot.get("trading_day") or trading_day().isoformat(),
                float(snapshot["equity"]),
                snapshot.get("cash"),
                snapshot.get("buying_power"),
                snapshot.get("position_value"),
                snapshot.get("benchmark_price"),
            ),
        )
        return int(cursor.lastrowid)

    def equity_series(self, *, since: str | None = None) -> list[dict[str, Any]]:
        if since:
            return self._rows(
                "SELECT * FROM equity_snapshots WHERE created_at >= ? ORDER BY created_at", (since,)
            )
        return self._rows("SELECT * FROM equity_snapshots ORDER BY created_at")

    def first_equity_of_day(self, day: date | str | None = None) -> dict[str, Any] | None:
        # `id` breaks ties: two snapshots can share a timestamp, and then
        # "first" and "last" would otherwise be whatever SQLite felt like.
        return self._row(
            "SELECT * FROM equity_snapshots WHERE trading_day = ?"
            " ORDER BY created_at, id LIMIT 1",
            (_day_key(day),),
        )

    def latest_equity(self) -> dict[str, Any] | None:
        return self._row("SELECT * FROM equity_snapshots ORDER BY created_at DESC, id DESC LIMIT 1")

    def peak_equity(self) -> float | None:
        row = self._row("SELECT MAX(equity) AS peak FROM equity_snapshots")
        return float(row["peak"]) if row and row["peak"] is not None else None

    def daily_equity_curve(self) -> list[dict[str, Any]]:
        """Last equity snapshot of each trading day, plus the benchmark price.

        Selected by `id` rather than `created_at`: same-timestamp snapshots would
        otherwise yield two rows for one day and corrupt the equity curve.
        """
        return self._rows(
            "SELECT trading_day, equity, benchmark_price, created_at FROM equity_snapshots e"
            " WHERE e.id = (SELECT x.id FROM equity_snapshots x"
            "               WHERE x.trading_day = e.trading_day"
            "               ORDER BY x.created_at DESC, x.id DESC LIMIT 1)"
            " ORDER BY trading_day"
        )

    def save_daily_metrics(self, day: date | str, metrics: dict[str, Any]) -> None:
        self._exec(
            "INSERT INTO daily_metrics"
            "(trading_day, computed_at, start_equity, end_equity, net_pnl, gross_pnl, fees,"
            " trades_closed, trades_opened, wins, losses, benchmark_price, payload)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(trading_day) DO UPDATE SET"
            "  computed_at=excluded.computed_at, start_equity=excluded.start_equity,"
            "  end_equity=excluded.end_equity, net_pnl=excluded.net_pnl,"
            "  gross_pnl=excluded.gross_pnl, fees=excluded.fees,"
            "  trades_closed=excluded.trades_closed, trades_opened=excluded.trades_opened,"
            "  wins=excluded.wins, losses=excluded.losses,"
            "  benchmark_price=excluded.benchmark_price, payload=excluded.payload",
            (
                _day_key(day), iso(),
                metrics.get("start_equity"), metrics.get("end_equity"),
                metrics.get("net_pnl"), metrics.get("gross_pnl"), metrics.get("fees"),
                int(metrics.get("trades_closed", 0)), int(metrics.get("trades_opened", 0)),
                int(metrics.get("wins", 0)), int(metrics.get("losses", 0)),
                metrics.get("benchmark_price"), _json(metrics),
            ),
        )

    def daily_metrics(self) -> list[dict[str, Any]]:
        rows = self._rows("SELECT * FROM daily_metrics ORDER BY trading_day")
        for row in rows:
            row["payload"] = _loads(row.get("payload"))
        return rows

    # ------------------------------------------------------------ signal weights
    def ensure_weights(self, seed: dict[str, float]) -> None:
        for name, weight in seed.items():
            self._exec(
                "INSERT OR IGNORE INTO signal_weights(name, weight, updated_at) VALUES (?,?,?)",
                (name, float(weight), iso()),
            )

    def signal_weights(self) -> dict[str, SignalWeight]:
        rows = self._rows("SELECT * FROM signal_weights")
        return {
            row["name"]: SignalWeight(
                name=row["name"],
                weight=float(row["weight"]),
                hits=int(row["hits"]),
                misses=int(row["misses"]),
                ema_accuracy=float(row["ema_accuracy"]),
                net_pnl=float(row["net_pnl"]),
            )
            for row in rows
        }

    def weight_values(self) -> dict[str, float]:
        return {name: w.weight for name, w in self.signal_weights().items()}

    def update_weight(
        self, name: str, *, weight: float, hit: bool | None = None,
        ema_accuracy: float | None = None, pnl_delta: float = 0.0,
    ) -> None:
        current = self.signal_weights().get(name)
        hits = current.hits if current else 0
        misses = current.misses if current else 0
        ema = current.ema_accuracy if current else 0.5
        pnl = current.net_pnl if current else 0.0
        if hit is True:
            hits += 1
        elif hit is False:
            misses += 1
        if ema_accuracy is not None:
            ema = ema_accuracy
        self._exec(
            "INSERT INTO signal_weights(name, weight, hits, misses, ema_accuracy, net_pnl, updated_at)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(name) DO UPDATE SET weight=excluded.weight, hits=excluded.hits,"
            "  misses=excluded.misses, ema_accuracy=excluded.ema_accuracy,"
            "  net_pnl=excluded.net_pnl, updated_at=excluded.updated_at",
            (name, float(weight), hits, misses, ema, pnl + pnl_delta, iso()),
        )

    # ------------------------------------------------------------------- events
    def record_event(
        self, kind: str, message: str = "", *, severity: str = "info", **payload: Any
    ) -> int:
        cursor = self._exec(
            "INSERT INTO events(created_at, kind, severity, message, payload) VALUES (?,?,?,?,?)",
            (iso(), kind, severity, message, _json(payload)),
        )
        return int(cursor.lastrowid)

    def recent_events(self, *, kind: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if kind:
            rows = self._rows(
                "SELECT * FROM events WHERE kind = ? ORDER BY created_at DESC LIMIT ?", (kind, limit)
            )
        else:
            rows = self._rows("SELECT * FROM events ORDER BY created_at DESC LIMIT ?", (limit,))
        for row in rows:
            row["payload"] = _loads(row.get("payload"))
        return rows


def _day_key(day: date | str | datetime | None) -> str:
    if day is None:
        return trading_day().isoformat()
    if isinstance(day, str):
        return day
    if isinstance(day, datetime):
        return trading_day(day).isoformat()
    return day.isoformat()


def content_hash(*parts: Iterable[str] | str | None) -> str:
    """Stable hash used to deduplicate the same story across news providers."""
    import hashlib
    import re

    chunks: list[str] = []
    for part in parts:
        if part is None:
            continue
        text = part if isinstance(part, str) else " ".join(part)
        normalized = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
        chunks.append(re.sub(r"\s+", " ", normalized).strip())
    return hashlib.sha256("|".join(chunks).encode("utf-8")).hexdigest()
