"""SQLite cache for fund data. All external data is cached locally so the
dashboard stays usable when upstream endpoints are slow or temporarily down."""

from __future__ import annotations

import json
import math
import os
import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "fund.db"

# 云上只读缓存模式：忽略 TTL，始终使用已预热的 SQLite 快照，避免境外访问国内行情接口超时。
# 配置了预热库下载地址（FUND_DB_URL）时自动启用。
OFFLINE = (
    os.environ.get("FUND_OFFLINE", "").strip().lower() in {"1", "true", "yes", "on"}
    or bool(os.environ.get("FUND_DB_URL", "").strip())
)

_write_lock = threading.RLock()
_initialized = False
_pool: queue.LifoQueue[sqlite3.Connection] = queue.LifoQueue()
_POOL_SIZE = 8

_PAGE_CACHE_KB = -65536
_MMAP_BYTES = 268435456
_PRAGMAS = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=NORMAL",
    "PRAGMA temp_store=MEMORY",
    f"PRAGMA cache_size={_PAGE_CACHE_KB}",
    f"PRAGMA mmap_size={_MMAP_BYTES}",
    "PRAGMA busy_timeout=30000",
)


def _new_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    for pragma in _PRAGMAS:
        conn.execute(pragma)
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """复用连接，避免每次查询都重新打开文件并设置 PRAGMA。"""
    try:
        conn = _pool.get_nowait()
    except queue.Empty:
        conn = _new_connection()
    healthy = True
    try:
        yield conn
        conn.commit()
    except BaseException:
        try:
            conn.rollback()
        except sqlite3.Error:
            healthy = False
        raise
    finally:
        if healthy and conn.in_transaction:
            try:
                conn.rollback()
            except sqlite3.Error:
                healthy = False
        if healthy and _pool.qsize() < _POOL_SIZE:
            _pool.put(conn)
        else:
            conn.close()


def init() -> None:
    global _initialized
    with _write_lock:
        if _initialized:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    fetched_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS market_holdings (
                    quarter TEXT NOT NULL,
                    code TEXT NOT NULL,
                    name TEXT,
                    fund_count INTEGER,
                    total_shares REAL,
                    hold_value REAL,
                    free_ratio REAL,
                    change TEXT,
                    change_shares REAL,
                    change_ratio REAL,
                    change_value REAL,
                    PRIMARY KEY (quarter, code)
                );
                CREATE INDEX IF NOT EXISTS idx_market_quarter
                    ON market_holdings(quarter, fund_count DESC);
                CREATE TABLE IF NOT EXISTS stock_quotes (
                    code TEXT PRIMARY KEY,
                    name TEXT,
                    industry TEXT,
                    industry_l2 TEXT,
                    price REAL,
                    pct REAL,
                    pe REAL,
                    pb REAL,
                    mktcap REAL,
                    float_cap REAL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fund_holders (
                    code TEXT NOT NULL,
                    date TEXT NOT NULL,
                    institution REAL,
                    individual REAL,
                    internal REAL,
                    total_shares REAL,
                    PRIMARY KEY (code, date)
                );
                CREATE INDEX IF NOT EXISTS idx_fund_holders_code
                    ON fund_holders(code, date DESC);
                CREATE TABLE IF NOT EXISTS saved_portfolios (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    items TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fund_top10 (
                    quarter TEXT NOT NULL,
                    fund_code TEXT NOT NULL,
                    stock_code TEXT NOT NULL,
                    stock_name TEXT,
                    weight REAL,
                    PRIMARY KEY (quarter, fund_code, stock_code)
                );
                CREATE INDEX IF NOT EXISTS idx_fund_top10_stock
                    ON fund_top10(quarter, stock_code);
                CREATE TABLE IF NOT EXISTS fund_assets (
                    fund_code TEXT NOT NULL,
                    quarter TEXT NOT NULL,
                    net_assets REAL,
                    PRIMARY KEY (fund_code, quarter)
                );
                CREATE TABLE IF NOT EXISTS market_top10 (
                    quarter TEXT NOT NULL,
                    code TEXT NOT NULL,
                    name TEXT,
                    fund_count INTEGER,
                    hold_value REAL,
                    PRIMARY KEY (quarter, code)
                );
                CREATE INDEX IF NOT EXISTS idx_market_top10_quarter
                    ON market_top10(quarter, fund_count DESC);
                CREATE TABLE IF NOT EXISTS top10_progress (
                    quarter TEXT NOT NULL,
                    fund_code TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (quarter, fund_code)
                );
                """
            )
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(stock_quotes)").fetchall()
            }
            if "industry_l2" not in columns:
                conn.execute("ALTER TABLE stock_quotes ADD COLUMN industry_l2 TEXT")
        _initialized = True


def cache_get(key: str, ttl: float | None = None) -> Any | None:
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT value, fetched_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    if not row:
        return None
    if ttl is not None and not OFFLINE and time.time() - row["fetched_at"] > ttl:
        return None
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return None


def cache_get_prefix(prefix: str) -> Any | None:
    """取指定前缀下最新的一条缓存，供只读模式在精确键失效时兜底。"""
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT value FROM cache WHERE key LIKE ? ORDER BY fetched_at DESC LIMIT 1",
            (prefix + "%",),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return None


def cache_age(key: str) -> float | None:
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT fetched_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    return time.time() - row["fetched_at"] if row else None


def to_builtin(obj: Any) -> Any:
    """Recursively convert numpy/pandas values and non-finite floats for JSON."""
    if isinstance(obj, dict):
        return {str(k): to_builtin(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_builtin(v) for v in obj]
    if isinstance(obj, bool) or obj is None or isinstance(obj, (int, str)):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if hasattr(obj, "item"):
        try:
            return to_builtin(obj.item())
        except (ValueError, AttributeError):
            return None
    return obj


def cache_set(key: str, value: Any) -> None:
    init()
    payload = json.dumps(to_builtin(value), ensure_ascii=False, allow_nan=False)
    with _write_lock, connect() as conn:
        conn.execute(
            "INSERT INTO cache(key, value, fetched_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at",
            (key, payload, time.time()),
        )


def cache_delete_prefix(prefixes: list[str]) -> None:
    init()
    with _write_lock, connect() as conn:
        for prefix in prefixes:
            conn.execute("DELETE FROM cache WHERE key LIKE ?", (prefix + "%",))


def meta_get(key: str, default: str | None = None) -> str | None:
    init()
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_set(key: str, value: str) -> None:
    init()
    with _write_lock, connect() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def market_quarter_ts(quarter: str) -> float | None:
    raw = meta_get(f"market_ts:{quarter}")
    return float(raw) if raw else None


def market_available(quarter: str) -> bool:
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM market_holdings WHERE quarter = ? LIMIT 1", (quarter,)
        ).fetchone()
    return row is not None


def market_quarters() -> list[str]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT quarter FROM market_holdings ORDER BY quarter DESC"
        ).fetchall()
    return [r["quarter"] for r in rows]


def market_replace(quarter: str, rows: list[dict]) -> int:
    init()
    with _write_lock, connect() as conn:
        conn.execute("DELETE FROM market_holdings WHERE quarter = ?", (quarter,))
        conn.executemany(
            """
            INSERT INTO market_holdings(
                quarter, code, name, fund_count, total_shares, hold_value,
                free_ratio, change, change_shares, change_ratio, change_value
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    quarter,
                    r["code"],
                    r["name"],
                    r["fund_count"],
                    r["total_shares"],
                    r["hold_value"],
                    r["free_ratio"],
                    r["change"],
                    r["change_shares"],
                    r["change_ratio"],
                    r["change_value"],
                )
                for r in rows
            ],
        )
    return len(rows)


def market_rows(quarter: str) -> list[dict]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM market_holdings WHERE quarter = ? ORDER BY hold_value DESC",
            (quarter,),
        ).fetchall()
    return [dict(r) for r in rows]


def portfolio_list() -> list[dict]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, items, created_at, updated_at FROM saved_portfolios ORDER BY updated_at DESC"
        ).fetchall()
    out = []
    for row in rows:
        try:
            items = json.loads(row["items"])
        except json.JSONDecodeError:
            items = []
        out.append(
            {
                "id": row["id"],
                "name": row["name"],
                "items": items,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    return out


def portfolio_save(name: str, items: list[dict]) -> int:
    init()
    now = time.time()
    payload = json.dumps(items, ensure_ascii=False)
    with _write_lock, connect() as conn:
        conn.execute(
            "INSERT INTO saved_portfolios(name, items, created_at, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET items=excluded.items, updated_at=excluded.updated_at",
            (name, payload, now, now),
        )
        row = conn.execute(
            "SELECT id FROM saved_portfolios WHERE name = ?", (name,)
        ).fetchone()
    return int(row["id"]) if row else 0


def portfolio_delete(portfolio_id: int) -> bool:
    init()
    with _write_lock, connect() as conn:
        cursor = conn.execute(
            "DELETE FROM saved_portfolios WHERE id = ?", (portfolio_id,)
        )
    return cursor.rowcount > 0


def holders_replace(code: str, rows: list[dict]) -> None:
    init()
    with _write_lock, connect() as conn:
        conn.execute("DELETE FROM fund_holders WHERE code = ?", (code,))
        conn.executemany(
            """
            INSERT INTO fund_holders(code, date, institution, individual, internal, total_shares)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    code,
                    r.get("date"),
                    r.get("institution"),
                    r.get("individual"),
                    r.get("internal"),
                    r.get("total_shares"),
                )
                for r in rows
                if r.get("date")
            ],
        )


def holders_latest_map() -> dict[str, dict]:
    init()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT h.*
            FROM fund_holders h
            JOIN (
                SELECT code, MAX(date) AS max_date
                FROM fund_holders
                GROUP BY code
            ) m ON h.code = m.code AND h.date = m.max_date
            """
        ).fetchall()
    return {r["code"]: dict(r) for r in rows}


def holders_count() -> int:
    init()
    with connect() as conn:
        row = conn.execute("SELECT COUNT(DISTINCT code) AS n FROM fund_holders").fetchone()
    return int(row["n"]) if row else 0


def holders_dates(code: str) -> list[dict]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM fund_holders WHERE code = ? ORDER BY date DESC", (code,)
        ).fetchall()
    return [dict(r) for r in rows]


def stocks_get(codes: list[str]) -> dict[str, dict]:
    if not codes:
        return {}
    init()
    out: dict[str, dict] = {}
    with connect() as conn:
        for i in range(0, len(codes), 500):
            chunk = codes[i : i + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT * FROM stock_quotes WHERE code IN ({placeholders})", chunk
            ).fetchall()
            for r in rows:
                out[r["code"]] = dict(r)
    return out


def stocks_upsert(rows: list[dict]) -> None:
    if not rows:
        return
    init()
    now = time.time()
    with _write_lock, connect() as conn:
        conn.executemany(
            """
            INSERT INTO stock_quotes(
                code, name, industry, industry_l2, price, pct, pe, pb,
                mktcap, float_cap, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name=excluded.name,
                industry=COALESCE(excluded.industry, industry),
                industry_l2=COALESCE(excluded.industry_l2, industry_l2),
                price=COALESCE(excluded.price, price),
                pct=COALESCE(excluded.pct, pct),
                pe=excluded.pe, pb=excluded.pb,
                mktcap=COALESCE(excluded.mktcap, mktcap),
                float_cap=COALESCE(excluded.float_cap, float_cap),
                updated_at=excluded.updated_at
            """,
            [
                (
                    r["code"],
                    r.get("name"),
                    r.get("industry"),
                    r.get("industry_l2"),
                    r.get("price"),
                    r.get("pct"),
                    r.get("pe"),
                    r.get("pb"),
                    r.get("mktcap"),
                    r.get("float_cap"),
                    now,
                )
                for r in rows
            ],
        )


def top10_progress(quarter: str) -> set[str]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT fund_code FROM top10_progress WHERE quarter = ?", (quarter,)
        ).fetchall()
    return {r["fund_code"] for r in rows}


def top10_progress_count(quarter: str) -> int:
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM top10_progress WHERE quarter = ?", (quarter,)
        ).fetchone()
    return int(row["n"]) if row else 0


def top10_assets_save(items: list[dict]) -> None:
    if not items:
        return
    init()
    with _write_lock, connect() as conn:
        conn.executemany(
            """
            INSERT INTO fund_assets(fund_code, quarter, net_assets)
            VALUES (?, ?, ?)
            ON CONFLICT(fund_code, quarter) DO UPDATE SET net_assets=excluded.net_assets
            """,
            [(r["fund_code"], r["quarter"], r.get("net_assets")) for r in items],
        )


def top10_asset_index() -> dict[str, set[str]]:
    init()
    out: dict[str, set[str]] = {}
    with connect() as conn:
        rows = conn.execute(
            "SELECT fund_code, quarter FROM fund_assets WHERE net_assets > 0"
        ).fetchall()
    for row in rows:
        out.setdefault(row["fund_code"], set()).add(row["quarter"])
    return out


def top10_batch_save(
    holdings: list[dict], assets: list[dict], progress: list[dict]
) -> None:
    init()
    with _write_lock, connect() as conn:
        if progress:
            keys = [(r["quarter"], r["fund_code"]) for r in progress]
            conn.executemany(
                "DELETE FROM fund_top10 WHERE quarter = ? AND fund_code = ?", keys
            )
        if holdings:
            conn.executemany(
                """
                INSERT INTO fund_top10(quarter, fund_code, stock_code, stock_name, weight)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(quarter, fund_code, stock_code) DO UPDATE SET
                    stock_name=excluded.stock_name,
                    weight=excluded.weight
                """,
                [
                    (
                        r["quarter"],
                        r["fund_code"],
                        r["stock_code"],
                        r.get("stock_name"),
                        r.get("weight"),
                    )
                    for r in holdings
                ],
            )
        if assets:
            conn.executemany(
                """
                INSERT INTO fund_assets(fund_code, quarter, net_assets)
                VALUES (?, ?, ?)
                ON CONFLICT(fund_code, quarter) DO UPDATE SET net_assets=excluded.net_assets
                """,
                [(r["fund_code"], r["quarter"], r.get("net_assets")) for r in assets],
            )
        if progress:
            now = time.time()
            conn.executemany(
                """
                INSERT INTO top10_progress(quarter, fund_code, status, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(quarter, fund_code) DO UPDATE SET
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                [
                    (r["quarter"], r["fund_code"], r.get("status") or "ok", now)
                    for r in progress
                ],
            )


def top10_aggregate_replace(quarter: str, rows: list[dict]) -> int:
    init()
    with _write_lock, connect() as conn:
        conn.execute("DELETE FROM market_top10 WHERE quarter = ?", (quarter,))
        conn.executemany(
            """
            INSERT INTO market_top10(quarter, code, name, fund_count, hold_value)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    quarter,
                    r["code"],
                    r.get("name"),
                    r.get("fund_count"),
                    r.get("hold_value"),
                )
                for r in rows
            ],
        )
    return len(rows)


def top10_rows(quarter: str) -> list[dict]:
    init()
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM market_top10 WHERE quarter = ? ORDER BY hold_value DESC",
            (quarter,),
        ).fetchall()
    return [dict(r) for r in rows]


def top10_available(quarter: str) -> bool:
    init()
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM market_top10 WHERE quarter = ? LIMIT 1", (quarter,)
        ).fetchone()
    return row is not None


def stocks_set_industry(rows: list[dict]) -> None:
    if not rows:
        return
    init()
    with _write_lock, connect() as conn:
        conn.executemany(
            """
            INSERT INTO stock_quotes(code, industry, industry_l2, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                industry=excluded.industry,
                industry_l2=excluded.industry_l2
            """,
            [
                (r["code"], r.get("industry"), r.get("industry_l2"), time.time())
                for r in rows
            ],
        )
