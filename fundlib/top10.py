"""Fund top-ten holding aggregation.

Eastmoney's market-wide aggregate only exposes top-ten holdings for Q1/Q3;
semi-annual and annual reports contain full portfolios.  This module rebuilds a
consistent top-ten series for every quarter from each fund's disclosed top-ten
stocks, using the light mobile endpoints (holdings + net assets), and stores the
stock-level aggregate in SQLite.
"""

from __future__ import annotations

import argparse
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

import requests

from . import datasource as ds
from . import store

HOLDINGS_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition"
ASSETS_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNAssetAllocation"
HEADERS = {
    "User-Agent": "EMProjJijin/6.4.0 (iPhone; iOS 16.0; Scale/3.00)",
    "Referer": "https://fund.eastmoney.com/",
    "Accept": "application/json",
}
API_BASE = {
    "deviceid": "1",
    "plat": "Iphone",
    "product": "EFund",
    "version": "6.4.0",
}

PORTFOLIO_CATEGORIES = ("股票型", "混合型", "指数型", "QDII", "债券型")
DEFAULT_QUARTERS = ("2026Q2", "2025Q4")

_CLASS_RE = re.compile(
    r"(?:A\d?|B\d?|C\d?|D|E|I|H|R|Y|O|F|OF|LOF|人民币|美元|现汇|现钞|份额|类)$",
    re.I,
)
_STOCK_RE = re.compile(r"\d{6}")


def is_a_share(code: str) -> bool:
    if not _STOCK_RE.fullmatch(code) or code == "000000":
        return False
    return not code.startswith(("1", "5", "200", "900"))


def portfolio_key(name: str | None) -> str:
    text = re.sub(r"\s+", "", name or "")
    for _ in range(3):
        trimmed = re.sub(r"[（(][^）)]*[）)]$", "", text)
        if trimmed == text:
            break
        text = trimmed
    for _ in range(3):
        trimmed = _CLASS_RE.sub("", text)
        if trimmed == text:
            break
        text = trimmed
    return text or (name or "")


def _pick_representative(rows: list[dict]) -> dict:
    def rank(row: dict):
        name = str(row.get("name") or "")
        return (
            0 if name.endswith(("A", "A类", "A1", "A2")) else 1,
            len(name),
            row.get("code") or "",
        )

    return sorted(rows, key=rank)[0]


def portfolio_universe() -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for row in ds.fund_universe():
        if row.get("category") not in PORTFOLIO_CATEGORIES:
            continue
        code = str(row.get("code") or "")
        if not _STOCK_RE.fullmatch(code):
            continue
        groups.setdefault(portfolio_key(row.get("name")), []).append(row)
    return [_pick_representative(rows) for rows in groups.values()]


class RateLimiter:
    def __init__(self, rate: float) -> None:
        self.interval = 1.0 / max(rate, 0.1)
        self.next_at = time.monotonic()
        self.lock = threading.Lock()

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            if self.next_at < now:
                self.next_at = now
            delay = self.next_at - now
            self.next_at += self.interval
        if delay > 0:
            time.sleep(delay)


_thread_local = threading.local()


def _session() -> requests.Session:
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers.update(HEADERS)
        _thread_local.session = session
    return session


def _request(url: str, params: dict, limiter: RateLimiter, tries: int = 3):
    last_error: Exception | None = None
    for attempt in range(tries):
        limiter.wait()
        try:
            resp = _session().get(url, params=params, timeout=15)
            if resp.status_code == 200:
                payload = resp.json()
                if payload.get("Success") is True or payload.get("ErrCode") in (0, "0"):
                    return payload
                last_error = RuntimeError(payload.get("ErrMsg") or "接口返回失败")
            else:
                last_error = RuntimeError(f"HTTP {resp.status_code}")
        except Exception as exc:  # network jitter / throttling
            last_error = exc
        time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(str(last_error or "请求失败"))


def fetch_holdings(code: str, quarter: str, limiter: RateLimiter) -> list[dict]:
    expected = ds.quarter_to_date(quarter)
    payload = _request(
        HOLDINGS_URL,
        {**API_BASE, "FCODE": code, "date": expected},
        limiter,
    )
    expansion = str(payload.get("Expansion") or "")[:10]
    if expansion and expansion != expected:
        return []
    stocks = (payload.get("Datas") or {}).get("fundStocks") or []
    rows: dict[str, dict] = {}
    for item in stocks:
        stock = str(item.get("GPDM") or "").strip()
        if not is_a_share(stock):
            continue
        weight = ds._num(item.get("JZBL"))
        if weight is None or weight <= 0:
            continue
        name = str(item.get("GPJC") or "").strip()
        current = rows.get(stock)
        if current is None or weight > current["weight"]:
            rows[stock] = {
                "quarter": quarter,
                "fund_code": code,
                "stock_code": stock,
                "stock_name": name,
                "weight": weight,
            }
    return list(rows.values())


def fetch_assets(code: str, limiter: RateLimiter) -> list[dict]:
    payload = _request(ASSETS_URL, {**API_BASE, "FCODE": code}, limiter)
    rows = []
    for item in payload.get("Datas") or []:
        raw_date = str(item.get("FSRQ") or "").strip()[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date):
            continue
        quarter = ds.date_to_quarter(raw_date)
        assets = ds._num(item.get("JZC"))
        if quarter and assets and assets > 0:
            rows.append(
                {"fund_code": code, "quarter": quarter, "net_assets": assets}
            )
    return rows


def _fetch_fund(
    code: str, quarters: list[str], need_assets: bool, limiter: RateLimiter
):
    holdings: dict[str, list[dict]] = {}
    errors: dict[str, str] = {}
    for quarter in quarters:
        try:
            holdings[quarter] = fetch_holdings(code, quarter, limiter)
        except Exception as exc:
            errors[quarter] = str(exc)[:120]
    assets: list[dict] = []
    if need_assets and any(holdings.get(q) for q in quarters):
        try:
            assets = fetch_assets(code, limiter)
        except Exception:
            assets = []
    return code, holdings, assets, errors


def build_quarters(
    quarters: list[str],
    workers: int = 16,
    rate: float = 13.0,
    limit: int | None = None,
    refresh: bool = False,
    log: Callable[[str], None] = print,
) -> None:
    store.init()
    funds = portfolio_universe()
    expected_total = len(funds)
    if limit:
        funds = funds[:limit]
    for quarter in quarters:
        store.meta_set(f"top10_expected:{quarter}", str(expected_total))
    pending_by_quarter = {
        q: (set() if refresh else store.top10_progress(q)) for q in quarters
    }
    asset_index = store.top10_asset_index()
    targets = []
    for fund in funds:
        code = fund["code"]
        fund_quarters = [q for q in quarters if code not in pending_by_quarter[q]]
        if not fund_quarters:
            continue
        need_assets = not all(q in asset_index.get(code, set()) for q in fund_quarters)
        targets.append((fund, fund_quarters, need_assets))
    log(
        f"[top10] 基金组合 {len(funds)} 只，待处理 {len(targets)} 只，"
        f"季度 {', '.join(quarters)}"
    )
    if not targets:
        return
    limiter = RateLimiter(rate)
    started = time.time()
    done = 0
    failures: Counter[str] = Counter()
    batch_holdings: list[dict] = []
    batch_assets: list[dict] = []
    batch_progress: list[dict] = []

    def flush() -> None:
        if batch_holdings or batch_assets or batch_progress:
            store.top10_batch_save(
                list(batch_holdings), list(batch_assets), list(batch_progress)
            )
            batch_holdings.clear()
            batch_assets.clear()
            batch_progress.clear()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                _fetch_fund, fund["code"], fund_quarters, need_assets, limiter
            ): (fund, fund_quarters)
            for fund, fund_quarters, need_assets in targets
        }
        for future in as_completed(futures):
            _, fund_quarters = futures[future]
            try:
                code, holdings, assets, errors = future.result()
            except Exception as exc:
                failures[str(exc)[:80]] += 1
                done += 1
                continue
            for quarter in fund_quarters:
                if quarter in errors:
                    failures[errors[quarter]] += 1
                    continue
                batch_holdings.extend(holdings.get(quarter) or [])
                batch_progress.append(
                    {
                        "quarter": quarter,
                        "fund_code": code,
                        "status": "ok" if holdings.get(quarter) else "empty",
                    }
                )
            batch_assets.extend(assets)
            done += 1
            if done % 40 == 0:
                flush()
            if done % 200 == 0 or done == len(targets):
                elapsed = time.time() - started
                speed = done / elapsed if elapsed else 0
                eta = (len(targets) - done) / speed if speed else 0
                log(
                    f"[top10] {done}/{len(targets)} · {speed:.1f} 只/秒 · "
                    f"已用 {elapsed/60:.1f} 分钟 · 预计剩余 {eta/60:.1f} 分钟"
                )
    flush()
    log(f"[top10] 抓取完成，失败 {sum(failures.values())} 次")
    for reason, count in failures.most_common(5):
        log(f"        {reason}: {count}")


def repair_assets(
    quarters: list[str],
    workers: int = 8,
    rate: float = 8.0,
    log: Callable[[str], None] = print,
) -> None:
    """Fetch net assets for funds that have top-ten rows but no asset row."""
    store.init()
    limiter = RateLimiter(rate)
    for quarter in quarters:
        with store.connect() as conn:
            codes = [
                r["fund_code"]
                for r in conn.execute(
                    """
                    SELECT DISTINCT t.fund_code
                    FROM fund_top10 t
                    LEFT JOIN fund_assets a
                      ON a.fund_code = t.fund_code AND a.quarter = t.quarter
                    WHERE t.quarter = ? AND a.fund_code IS NULL
                    """,
                    (quarter,),
                ).fetchall()
            ]
        if not codes:
            continue
        log(f"[top10] {quarter} 补抓净资产 {len(codes)} 只")

        def one(code: str):
            try:
                return fetch_assets(code, limiter)
            except Exception:
                return []

        saved = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for rows in pool.map(one, codes):
                if rows:
                    store.top10_assets_save(rows)
                    saved += 1
        log(f"[top10] {quarter} 净资产补抓完成 {saved}/{len(codes)}")


def aggregate(quarter: str) -> list[dict]:
    store.init()
    with store.connect() as conn:
        rows = conn.execute(
            """
            SELECT t.stock_code AS code,
                   MAX(t.stock_name) AS name,
                   COUNT(DISTINCT t.fund_code) AS fund_count,
                   SUM(
                       CASE WHEN a.net_assets > 0
                            THEN t.weight / 100.0 * a.net_assets
                            ELSE 0 END
                   ) AS hold_value
            FROM fund_top10 t
            LEFT JOIN fund_assets a
              ON a.fund_code = t.fund_code AND a.quarter = t.quarter
            WHERE t.quarter = ?
            GROUP BY t.stock_code
            HAVING COUNT(DISTINCT t.fund_code) > 0
            """,
            (quarter,),
        ).fetchall()
    out = [
        {
            "code": r["code"],
            "name": r["name"],
            "fund_count": int(r["fund_count"] or 0),
            "hold_value": float(r["hold_value"] or 0),
        }
        for r in rows
    ]
    out.sort(key=lambda x: x["fund_count"], reverse=True)
    return out


def sync_official(quarter: str) -> None:
    if ds.disclosure_kind(quarter) != "top10":
        return
    if store.top10_available(quarter):
        return
    rows = store.market_rows(quarter)
    if not rows:
        return
    store.top10_aggregate_replace(
        quarter,
        [
            {
                "code": r["code"],
                "name": r.get("name"),
                "fund_count": r.get("fund_count"),
                "hold_value": (r.get("hold_value") or 0) / 1e8,
            }
            for r in rows
            if is_a_share(str(r.get("code") or ""))
            and (r.get("hold_value") or 0) > 0
        ],
    )
    store.cache_delete_prefix(["payload:stocks:", "payload:stock:"])


def rebuild_aggregate(quarter: str) -> int:
    sync_official(quarter)
    if ds.disclosure_kind(quarter) == "top10":
        return len(store.top10_rows(quarter))
    expected_raw = store.meta_get(f"top10_expected:{quarter}")
    expected = int(expected_raw) if expected_raw else len(portfolio_universe())
    done = store.top10_progress_count(quarter)
    if done < expected:
        return 0
    rows = aggregate(quarter)
    if rows:
        store.top10_aggregate_replace(quarter, rows)
        store.cache_delete_prefix(["payload:stocks:", "payload:stock:"])
    return len(rows)


def quarter_rows(quarter: str, rebuild: bool = False) -> list[dict]:
    sync_official(quarter)
    if rebuild:
        rebuild_aggregate(quarter)
    return store.top10_rows(quarter)


def available_quarters(count: int = 12) -> list[str]:
    out = []
    for quarter in ds.recent_quarters(count):
        if ds.disclosure_kind(quarter) == "top10":
            if store.market_available(quarter):
                out.append(quarter)
        elif store.top10_available(quarter):
            out.append(quarter)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build fund top-ten aggregates")
    parser.add_argument(
        "--quarters", default=",".join(DEFAULT_QUARTERS), help="e.g. 2026Q2,2025Q4"
    )
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--rate", type=float, default=13.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()
    quarters = [q.strip() for q in args.quarters.split(",") if q.strip()]
    if not args.no_build:
        build_quarters(
            quarters,
            workers=args.workers,
            rate=args.rate,
            limit=args.limit or None,
            refresh=args.refresh,
        )
        repair_assets(quarters, log=print)
    for quarter in quarters:
        count = rebuild_aggregate(quarter)
        if count == 0:
            print(f"[top10] {quarter} 覆盖不足，未更新聚合")
            continue
        rows = store.top10_rows(quarter)
        print(f"[top10] {quarter} 聚合 {count} 只股票")
        for row in rows[:8]:
            print(
                f"        {row['code']} {row['name']} "
                f"{row['fund_count']} 只 · {row['hold_value']:.1f} 亿"
            )


if __name__ == "__main__":
    main()
