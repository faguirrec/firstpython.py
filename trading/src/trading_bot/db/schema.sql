-- Every decision the bot makes must be auditable after the fact, so the schema
-- keeps the inputs (news, sentiment, signals) next to the outputs (orders,
-- trades, metrics) and never overwrites history.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS news_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT    NOT NULL,
    external_id   TEXT,
    content_hash  TEXT    NOT NULL UNIQUE,
    headline      TEXT    NOT NULL,
    summary       TEXT,
    url           TEXT,
    author        TEXT,
    symbols       TEXT    NOT NULL DEFAULT '',
    published_at  TEXT,
    fetched_at    TEXT    NOT NULL,
    classified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at);
CREATE INDEX IF NOT EXISTS idx_news_classified ON news_items(classified);

CREATE TABLE IF NOT EXISTS sentiment_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    news_id         INTEGER NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
    symbol          TEXT    NOT NULL,
    sentiment_score REAL    NOT NULL,
    confidence      REAL    NOT NULL,
    horizon         TEXT    NOT NULL DEFAULT 'intraday',
    one_liner       TEXT,
    is_rumor        INTEGER NOT NULL DEFAULT 0,
    model           TEXT,
    published_at    TEXT,
    created_at      TEXT    NOT NULL,
    UNIQUE (news_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_sentiment_symbol_time ON sentiment_scores(symbol, published_at);

CREATE TABLE IF NOT EXISTS decisions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         TEXT    NOT NULL,
    trading_day        TEXT    NOT NULL,
    session            TEXT    NOT NULL,
    symbol             TEXT    NOT NULL,
    action             TEXT    NOT NULL,          -- buy | sell | hold
    fused_score        REAL    NOT NULL DEFAULT 0,
    confidence         REAL    NOT NULL DEFAULT 0,
    expected_move_bps  REAL    NOT NULL DEFAULT 0,
    reference_price    REAL,
    limit_price        REAL,
    quantity           REAL,
    signals_json       TEXT    NOT NULL DEFAULT '{}',
    ev_json            TEXT    NOT NULL DEFAULT '{}',
    approved           INTEGER NOT NULL DEFAULT 0,
    reason             TEXT    NOT NULL DEFAULT '',
    order_id           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_decisions_day ON decisions(trading_day);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol, created_at);

CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_order_id  TEXT UNIQUE,
    decision_id      INTEGER REFERENCES decisions(id),
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    trading_day      TEXT    NOT NULL,
    symbol           TEXT    NOT NULL,
    side             TEXT    NOT NULL,
    quantity         REAL    NOT NULL,
    notional         REAL,
    limit_price      REAL,
    order_type       TEXT    NOT NULL DEFAULT 'limit',
    time_in_force    TEXT    NOT NULL DEFAULT 'day',
    status           TEXT    NOT NULL DEFAULT 'new',
    filled_qty       REAL    NOT NULL DEFAULT 0,
    filled_avg_price REAL,
    intent           TEXT    NOT NULL DEFAULT 'entry',  -- entry | exit
    trade_id         INTEGER,
    raw              TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(trading_day);

CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'open',   -- open | closed
    quantity        REAL    NOT NULL,
    entry_price     REAL    NOT NULL,
    exit_price      REAL,
    opened_at       TEXT    NOT NULL,
    closed_at       TEXT,
    opened_day      TEXT    NOT NULL,
    closed_day      TEXT,
    entry_order_id  INTEGER REFERENCES orders(id),
    exit_order_id   INTEGER REFERENCES orders(id),
    decision_id     INTEGER REFERENCES decisions(id),
    gross_pnl       REAL,
    fees            REAL,
    net_pnl         REAL,
    return_pct      REAL,
    exit_reason     TEXT,
    signals_json    TEXT    NOT NULL DEFAULT '{}',
    expected_move_bps REAL,
    reviewed        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_reviewed ON trades(reviewed, status);

CREATE TABLE IF NOT EXISTS signal_weights (
    name         TEXT PRIMARY KEY,
    weight       REAL NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0,
    misses       INTEGER NOT NULL DEFAULT 0,
    ema_accuracy REAL NOT NULL DEFAULT 0.5,
    net_pnl      REAL NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,
    trading_day     TEXT NOT NULL,
    equity          REAL NOT NULL,
    cash            REAL,
    buying_power    REAL,
    position_value  REAL,
    benchmark_price REAL
);
CREATE INDEX IF NOT EXISTS idx_equity_day ON equity_snapshots(trading_day);

CREATE TABLE IF NOT EXISTS daily_metrics (
    trading_day     TEXT PRIMARY KEY,
    computed_at     TEXT NOT NULL,
    start_equity    REAL,
    end_equity      REAL,
    net_pnl         REAL,
    gross_pnl       REAL,
    fees            REAL,
    trades_closed   INTEGER NOT NULL DEFAULT 0,
    trades_opened   INTEGER NOT NULL DEFAULT 0,
    wins            INTEGER NOT NULL DEFAULT 0,
    losses          INTEGER NOT NULL DEFAULT 0,
    benchmark_price REAL,
    payload         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'info',
    message    TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, created_at);

CREATE TABLE IF NOT EXISTS state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
