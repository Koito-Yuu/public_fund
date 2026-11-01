"""Upstream data adapters for East Money / Tiantian Fund / Cninfo.

All network access lives here. Everything is cached in SQLite so repeated
dashboard requests never hammer upstream endpoints.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from io import StringIO
from typing import Any, Callable

import pandas as pd
import requests

from . import store

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

TTL_UNIVERSE = 12 * 3600
TTL_MARKET = 2 * 3600
TTL_HOLDINGS = 6 * 3600
TTL_PINGZHONG = 12 * 3600
TTL_QUOTE = 1800
TTL_INDUSTRY = 7 * 24 * 3600
TTL_AUM = 24 * 3600
TTL_BENCHMARK = 12 * 3600
TTL_EXTRA = 12 * 3600
TTL_HOLDER = 24 * 3600
TTL_FLOWS = 7 * 24 * 3600

_session = requests.Session()
_session.headers.update(BASE_HEADERS)

_fetch_locks: dict[str, threading.Lock] = {}
_fetch_locks_guard = threading.Lock()

_universe_mem: list = [0.0, None]
_quote_mem: dict[str, tuple[float, dict]] = {}
_industry_miss: dict[str, float] = {}
_holder_mem: list = [0.0, None]
_company_mem: list = [0.0, None]


class DataError(RuntimeError):
    pass


class NotFoundError(DataError):
    pass


def _lock_for(key: str) -> threading.Lock:
    with _fetch_locks_guard:
        if key not in _fetch_locks:
            _fetch_locks[key] = threading.Lock()
        return _fetch_locks[key]


def _req(
    url: str,
    params: dict | None = None,
    *,
    headers: dict | None = None,
    timeout: int = 20,
    tries: int = 3,
) -> requests.Response:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            resp = _session.get(url, params=params, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                return resp
            last = DataError(f"HTTP {resp.status_code} for {url}")
        except requests.RequestException as exc:  # network hiccup
            last = exc
        time.sleep(0.6 * (attempt + 1))
    raise DataError(str(last) if last else f"request failed: {url}")


def _ak(fn: Callable, *args, **kwargs):
    last: Exception | None = None
    for attempt in range(2):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # akshare wraps many upstream errors
            last = exc
            time.sleep(1.0 + attempt)
    raise DataError(f"{getattr(fn, '__name__', 'akshare call')} failed: {last}")


# ---------------------------------------------------------------- quarters ---

_QUARTER_END = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}


def quarter_to_date(quarter: str) -> str:
    year, q = quarter.split("Q")
    return f"{year}-{_QUARTER_END[int(q)]}"


def date_to_quarter(value: str) -> str:
    d = pd.Timestamp(value)
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def prev_year_quarter(quarter: str) -> str:
    year, q = quarter.split("Q")
    return f"{int(year) - 1}Q{q}"


def prev_quarter(quarter: str) -> str:
    year, q = quarter.split("Q")
    if int(q) == 1:
        return f"{int(year) - 1}Q4"
    return f"{year}Q{int(q) - 1}"


def recent_quarters(count: int = 9) -> list[str]:
    import calendar

    today = date.today()
    # The latest report period is the last *completed* quarter, plus a
    # disclosure lag: Q1/Q3 reports are due within ~15 days after quarter end.
    q = (today.month - 1) // 3 + 1
    year = today.year
    month = q * 3
    last_end = date(year, month, calendar.monthrange(year, month)[1])
    if today < last_end + pd.Timedelta(days=15):
        q -= 1
        if q == 0:
            q = 4
            year -= 1
    out = []
    for _ in range(count):
        out.append(f"{year}Q{q}")
        q -= 1
        if q == 0:
            q = 4
            year -= 1
    return out


def quarter_label(quarter: str) -> str:
    year, q = quarter.split("Q")
    return f"{year}年{'一二三四'[int(q) - 1]}季度"


def disclosure_kind(quarter: str) -> str:
    return "full" if quarter.endswith(("Q2", "Q4")) else "top10"


# ---------------------------------------------------------------- universe ---

_CATEGORY_RULES = (
    ("货币", "货币型"),
    ("FOF", "FOF"),
    ("REIT", "REITs"),
    ("QDII", "QDII"),
    ("海外", "QDII"),
    ("全球", "QDII"),
    ("债券", "债券型"),
    ("固收", "债券型"),
    ("指数", "指数型"),
    ("ETF", "指数型"),
    ("联接", "指数型"),
    ("股票", "股票型"),
    ("混合", "混合型"),
)


def category_of(fund_type: str | None) -> str:
    if not fund_type:
        return "其他"
    text = str(fund_type).upper()
    for needle, cat in _CATEGORY_RULES:
        if needle in text:
            return cat
    return "其他"


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        out = float(str(value).replace("%", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _int(value: Any) -> int | None:
    out = _num(value)
    return int(out) if out is not None else None


def _text(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and not math.isfinite(value)):
        return None
    text = str(value).strip()
    return text or None


def _build_universe() -> list[dict]:
    import akshare as ak

    name_df = _ak(ak.fund_name_em)
    name_df = name_df.rename(
        columns={
            "基金代码": "code",
            "基金简称": "name",
            "基金类型": "type",
            "拼音缩写": "pinyin",
            "拼音全称": "pinyin_full",
        }
    )
    name_df["code"] = name_df["code"].astype(str).str.zfill(6)

    try:
        rank_df = _ak(ak.fund_open_fund_rank_em, symbol="全部")
    except DataError:
        rank_df = pd.DataFrame()

    if not rank_df.empty:
        rank_df = rank_df.rename(
            columns={
                "基金代码": "code",
                "基金简称": "rank_name",
                "日期": "nav_date",
                "单位净值": "nav",
                "累计净值": "acc_nav",
                "日增长率": "day_pct",
                "近1周": "r1w",
                "近1月": "r1m",
                "近3月": "r3m",
                "近6月": "r6m",
                "近1年": "r1y",
                "近2年": "r2y",
                "近3年": "r3y",
                "今年来": "ytd",
                "成立来": "since",
                "手续费": "fee_raw",
            }
        )
        rank_df["code"] = rank_df["code"].astype(str).str.zfill(6)
        keep = [
            "code", "rank_name", "nav_date", "nav", "acc_nav", "day_pct",
            "r1w", "r1m", "r3m", "r6m", "r1y", "r2y", "r3y", "ytd", "since", "fee_raw",
        ]
        rank_df = rank_df[[c for c in keep if c in rank_df.columns]].drop_duplicates("code")
    else:
        rank_df = pd.DataFrame(columns=["code"])

    try:
        rating_df = _ak(ak.fund_rating_all)
    except DataError:
        rating_df = pd.DataFrame()

    if not rating_df.empty:
        rating_df = rating_df.rename(
            columns={
                "代码": "code",
                "简称": "rating_name",
                "基金经理": "manager",
                "基金公司": "company",
                "5星评级家数": "five_star",
                "上海证券": "rating_sh",
                "招商证券": "rating_cms",
                "济安金信": "rating_jax",
                "晨星评级": "rating_ms",
                "手续费": "fee_decimal",
                "类型": "rating_type",
            }
        )
        rating_df["code"] = rating_df["code"].astype(str).str.zfill(6)
        rating_df = rating_df.drop_duplicates("code")
        rating_df = rating_df[
            [
                "code", "rating_name", "manager", "company", "five_star",
                "rating_sh", "rating_cms", "rating_jax", "rating_ms",
                "fee_decimal", "rating_type",
            ]
        ]

    df = name_df[["code", "name", "type"]].merge(rank_df, on="code", how="outer")
    df = df.merge(rating_df, on="code", how="left")
    if "rating_name" in df:
        df["name"] = df["name"].fillna(df["rating_name"])
    df["name"] = df["name"].fillna(df["code"])
    if "rating_type" in df.columns:
        df["type"] = df["rating_type"].fillna(df["type"])

    records: list[dict] = []
    for row in df.to_dict("records"):
        code = str(row.get("code") or "").zfill(6)
        if not code or code == "000000":
            continue
        fee = _num(row.get("fee_raw"))
        if fee is None and _num(row.get("fee_decimal")) is not None:
            fee = round(float(_num(row.get("fee_decimal"))) * 100, 4)
        rating_values = [
            _num(row.get("rating_sh")),
            _num(row.get("rating_cms")),
            _num(row.get("rating_jax")),
            _num(row.get("rating_ms")),
        ]
        ratings = [x for x in rating_values if x is not None and x > 0]
        fund_type = str(row.get("type") or "其他")
        records.append(
            {
                "code": code,
                "name": _text(row.get("name")) or code,
                "type": fund_type,
                "category": category_of(fund_type),
                "company": _text(row.get("company")),
                "manager": _text(row.get("manager")),
                "fee": fee,
                "rating_max": max(ratings) if ratings else None,
                "rating_ms": _num(row.get("rating_ms")),
                "five_star": _int(row.get("five_star")),
                "rating_sh": _num(row.get("rating_sh")),
                "rating_cms": _num(row.get("rating_cms")),
                "rating_jax": _num(row.get("rating_jax")),
                "nav": _num(row.get("nav")),
                "acc_nav": _num(row.get("acc_nav")),
                "nav_date": str(row.get("nav_date")) if row.get("nav_date") else None,
                "day_pct": _num(row.get("day_pct")),
                "r1w": _num(row.get("r1w")),
                "r1m": _num(row.get("r1m")),
                "r3m": _num(row.get("r3m")),
                "r6m": _num(row.get("r6m")),
                "r1y": _num(row.get("r1y")),
                "r2y": _num(row.get("r2y")),
                "r3y": _num(row.get("r3y")),
                "ytd": _num(row.get("ytd")),
                "since": _num(row.get("since")),
            }
        )
    records.sort(key=lambda x: x["code"])
    return records


def fund_universe(force: bool = False) -> list[dict]:
    now = time.time()
    if not force and _universe_mem[1] is not None and now - _universe_mem[0] < 600:
        return _universe_mem[1]
    if not force:
        cached = store.cache_get("universe:v2", TTL_UNIVERSE)
        if cached:
            _universe_mem[0], _universe_mem[1] = now, cached
            return cached
    with _lock_for("universe"):
        if not force:
            cached = store.cache_get("universe:v2", TTL_UNIVERSE)
            if cached:
                _universe_mem[0], _universe_mem[1] = now, cached
                return cached
        records = _build_universe()
        if records:
            store.cache_set("universe:v2", records)
            _universe_mem[0], _universe_mem[1] = time.time(), records
        return records


def universe_map() -> dict[str, dict]:
    return {r["code"]: r for r in fund_universe()}


def search_funds(query: str, limit: int = 12) -> list[dict]:
    q = (query or "").strip().lower()
    if not q:
        return []
    rows = fund_universe()
    scored = []
    for r in rows:
        name = (r.get("name") or "").lower()
        code = r["code"]
        if code == q:
            score = 0
        elif code.startswith(q):
            score = 1
        elif q in name:
            score = 2
        else:
            continue
        scored.append((score, -(r.get("r1y") or -999), r))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [
        {
            "code": r["code"],
            "name": r.get("name"),
            "type": r.get("type"),
            "category": r.get("category"),
            "r1y": r.get("r1y"),
        }
        for _, _, r in scored[:limit]
    ]


# ------------------------------------------------------------- fund detail ---

def _js_var(text: str, name: str) -> Any | None:
    match = re.search(
        r"var\s+" + re.escape(name) + r"\s*=\s*(.*?);",
        text,
        re.S,
    )
    if not match:
        return None
    raw = match.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        if raw.startswith('"') and raw.endswith('"'):
            return raw[1:-1]
        return None


def fund_pingzhong(code: str) -> dict:
    key = f"pingzhong:v2:{code}"
    cached = store.cache_get(key, TTL_PINGZHONG)
    if cached:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, TTL_PINGZHONG)
        if cached:
            return cached
        resp = _req(
            f"https://fund.eastmoney.com/pingzhongdata/{code}.js",
            headers={"Referer": "https://fund.eastmoney.com/"},
            timeout=20,
        )
        text = resp.content.decode("utf-8", errors="ignore")
        payload = {
            "code": code,
            "name": _js_var(text, "fS_name"),
            "net_worth": _js_var(text, "Data_netWorthTrend") or [],
            "ac_worth": _js_var(text, "Data_ACWorthTrend") or [],
            "scale": _js_var(text, "Data_fluctuationScale"),
            "holders": _js_var(text, "Data_holderStructure"),
            "asset": _js_var(text, "Data_assetAllocation"),
            "evaluation": _js_var(text, "Data_performanceEvaluation"),
            "managers": _js_var(text, "Data_currentFundManager") or [],
            "grand_total": _js_var(text, "Data_grandTotal"),
            "source_rate": _js_var(text, "fund_sourceRate"),
            "rate": _js_var(text, "fund_Rate"),
            "raw_len": len(text),
        }
        if not payload["name"]:
            raise DataError(f"未找到基金 {code} 的净值数据")
        store.cache_set(key, payload)
        return payload


def _clean_holdings_tables(html: str) -> list[dict]:
    labels = re.findall(r"<h4[^>]*>(.*?)</h4>", html, re.S)
    try:
        tables = pd.read_html(StringIO(html), converters={"股票代码": str})
    except Exception:
        # New funds / bond funds sometimes return an empty content block.
        return []
    out: list[dict] = []
    for idx, table in enumerate(tables):
        label = labels[idx] if idx < len(labels) else ""
        match = re.search(r"(\d{4}-\d{2}-\d{2})", label)
        if not match:
            continue
        report_date = match.group(1)
        table = table.copy()
        table.columns = [re.sub(r"[\s\u00a0]+", "", str(c)) for c in table.columns]

        def col(*needles: str) -> str | None:
            for c in table.columns:
                if all(n in c for n in needles):
                    return c
            return None

        c_code = col("股票代码")
        c_name = col("股票名称")
        c_weight = col("占净值比例")
        c_shares = col("持股数")
        c_value = col("持仓市值")
        if not (c_code and c_name and c_weight):
            continue
        rows = []
        for row in table.to_dict("records"):
            code = str(row.get(c_code) or "").strip()
            if not re.fullmatch(r"[0-9A-Za-z]{4,6}", code):
                continue
            name = str(row.get(c_name) or "").strip()
            weight = _num(row.get(c_weight))
            if weight is None:
                continue
            rows.append(
                {
                    "code": code if len(code) == 6 else code.zfill(5 if len(code) == 5 else len(code)),
                    "name": name,
                    "weight": round(weight, 3),
                    "shares_wan": _num(row.get(c_shares)) if c_shares else None,
                    "value_wan": _num(row.get(c_value)) if c_value else None,
                }
            )
        if not rows:
            continue
        rows.sort(key=lambda x: x["weight"], reverse=True)
        rows = rows[:10]
        out.append(
            {
                "date": report_date,
                "quarter": date_to_quarter(report_date),
                "stocks": rows,
            }
        )
    dedup: dict[str, dict] = {}
    for item in out:
        dedup[item["quarter"]] = item
    return sorted(dedup.values(), key=lambda x: x["date"], reverse=True)


def fund_holdings(code: str, years: int = 3) -> list[dict]:
    key = f"holdings:{code}"
    cached = store.cache_get(key, TTL_HOLDINGS)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, TTL_HOLDINGS)
        if cached is not None:
            return cached
        this_year = date.today().year
        merged: dict[str, dict] = {}
        headers = {"Referer": f"https://fundf10.eastmoney.com/ccmx_{code}.html"}
        for year in range(this_year, this_year - years, -1):
            try:
                resp = _req(
                    "https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
                    {
                        "type": "jjcc",
                        "code": code,
                        "topline": "10000",
                        "year": str(year),
                        "month": "",
                        "rt": str(time.time()),
                    },
                    headers=headers,
                )
            except DataError:
                continue
            text = resp.text
            match = re.search(r'content:"(.*?)",arryear', text, re.S)
            if not match:
                continue
            html = (
                match.group(1)
                .replace("\\'", "'")
                .replace('\\"', '"')
                .replace("\\/", "/")
            )
            for item in _clean_holdings_tables(html):
                merged[item["quarter"]] = item
        result = sorted(merged.values(), key=lambda x: x["date"], reverse=True)
        store.cache_set(key, result)
        return result


def fund_industry_alloc(code: str, years: int = 2) -> list[dict]:
    key = f"industry:{code}"
    cached = store.cache_get(key, TTL_INDUSTRY)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, TTL_INDUSTRY)
        if cached is not None:
            return cached
        headers = {"Referer": "https://fundf10.eastmoney.com/"}
        by_date: dict[str, list[dict]] = {}
        this_year = date.today().year
        for year in range(this_year, this_year - years, -1):
            try:
                resp = _req(
                    "https://api.fund.eastmoney.com/f10/HYPZ/",
                    {
                        "fundCode": code,
                        "year": str(year),
                        "callback": f"jQuery1_{int(time.time())}",
                    },
                    headers=headers,
                )
            except DataError:
                continue
            text = resp.text
            start, end = text.find("("), text.rfind(")")
            if start < 0 or end <= start:
                continue
            try:
                payload = json.loads(text[start + 1 : end])
            except json.JSONDecodeError:
                continue
            data = payload.get("Data") or {}
            for quarter in data.get("QuarterInfos") or []:
                for item in quarter.get("HYPZInfo") or []:
                    report_date = item.get("FSRQ") or quarter.get("JZRQ")
                    name = item.get("HYMC")
                    weight = _num(item.get("ZJZBL"))
                    if not report_date or not name or weight is None:
                        continue
                    by_date.setdefault(report_date, []).append(
                        {
                            "name": name,
                            "weight": round(weight, 3),
                            "value_wan": _num(item.get("SZ")),
                        }
                    )
        result = [
            {
                "date": d,
                "quarter": date_to_quarter(d),
                "items": sorted(items, key=lambda x: x["weight"], reverse=True),
            }
            for d, items in by_date.items()
        ]
        result.sort(key=lambda x: x["date"], reverse=True)
        store.cache_set(key, result)
        return result


def fund_extra(code: str) -> dict:
    key = f"extra:{code}"
    cached = store.cache_get(key, TTL_EXTRA)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, TTL_EXTRA)
        if cached is not None:
            return cached
        import akshare as ak

        out: dict[str, Any] = {"basic": {}, "achievement": [], "analysis": []}
        try:
            basic_df = _ak(ak.fund_individual_basic_info_xq, symbol=code)
            basic = {}
            for row in basic_df.to_dict("records"):
                value = row.get("value")
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    value = None
                if value is not None and str(value) == "<NA>":
                    value = None
                basic[str(row.get("item"))] = value
            out["basic"] = basic
        except Exception:
            pass
        try:
            ach = _ak(ak.fund_individual_achievement_xq, symbol=code)
            rows = []
            for row in ach.to_dict("records"):
                rows.append(
                    {
                        "type": row.get("业绩类型"),
                        "period": row.get("周期"),
                        "return": _num(row.get("本产品区间收益")),
                        "drawdown": _num(row.get("本产品最大回撒")),
                        "rank_text": row.get("周期收益同类排名"),
                    }
                )
            out["achievement"] = rows
        except Exception:
            pass
        try:
            analysis = _ak(ak.fund_individual_analysis_xq, symbol=code)
            out["analysis"] = [
                {
                    "period": row.get("周期"),
                    "risk_return": _num(row.get("较同类风险收益比")),
                    "anti_risk": _num(row.get("较同类抗风险波动")),
                    "volatility": _num(row.get("年化波动率")),
                    "sharpe": _num(row.get("年化夏普比率")),
                    "drawdown": _num(row.get("最大回撤")),
                }
                for row in analysis.to_dict("records")
            ]
        except Exception:
            pass
        store.cache_set(key, out)
        return out


# --------------------------------------------------------- managers / scale ---

_manager_mem: list = [0.0, None]
_scale_mem: list = [0.0, None]


def manager_universe(force: bool = False) -> dict:
    now = time.time()
    if not force and _manager_mem[1] is not None and now - _manager_mem[0] < 600:
        return _manager_mem[1]
    cached = store.cache_get("manager_universe:v1", 24 * 3600)
    if cached and not force:
        _manager_mem[0], _manager_mem[1] = now, cached
        return cached
    with _lock_for("manager_universe"):
        cached = store.cache_get("manager_universe:v1", 24 * 3600)
        if cached and not force:
            _manager_mem[0], _manager_mem[1] = now, cached
            return cached
        import akshare as ak

        try:
            df = _ak(ak.fund_manager_em)
        except DataError:
            return {"managers": [], "fund_map": {}}
        managers: dict[tuple, dict] = {}
        fund_map: dict[str, dict] = {}
        for row in df.to_dict("records"):
            name = str(row.get("姓名") or "").strip()
            company = str(row.get("所属公司") or "").strip()
            code = str(row.get("现任基金代码") or "").strip().zfill(6)
            fund_name = str(row.get("现任基金") or "").strip()
            if not name or not company or not re.fullmatch(r"\d{6}", code):
                continue
            days = _num(row.get("累计从业时间")) or 0
            years = round(days / 365.25, 2)
            aum = _num(row.get("现任基金资产总规模"))
            best = _num(row.get("现任基金最佳回报"))
            key = (name, company)
            manager = managers.setdefault(
                key,
                {
                    "name": name,
                    "company": company,
                    "years": years,
                    "aum": aum or 0,
                    "best_return": best,
                    "fund_codes": [],
                    "fund_names": [],
                },
            )
            manager["years"] = max(manager["years"], years)
            manager["aum"] = max(manager["aum"], aum or 0)
            if best is not None:
                manager["best_return"] = (
                    best if manager["best_return"] is None else max(manager["best_return"], best)
                )
            if code not in manager["fund_codes"]:
                manager["fund_codes"].append(code)
                manager["fund_names"].append(fund_name)
            entry = fund_map.setdefault(
                code,
                {"manager_years": 0.0, "manager_aum": 0.0, "managers": []},
            )
            entry["manager_years"] = max(entry["manager_years"], years)
            entry["manager_aum"] = max(entry["manager_aum"], aum or 0)
            if name not in entry["managers"]:
                entry["managers"].append(name)
        manager_list = sorted(
            managers.values(), key=lambda x: x.get("aum") or 0, reverse=True
        )
        for manager in manager_list:
            manager["fund_count"] = len(manager["fund_codes"])
        payload = {"managers": manager_list, "fund_map": fund_map}
        store.cache_set("manager_universe:v1", payload)
        _manager_mem[0], _manager_mem[1] = time.time(), payload
        return payload


def fund_scale_map(force: bool = False) -> dict:
    now = time.time()
    if not force and _scale_mem[1] is not None and now - _scale_mem[0] < 600:
        return _scale_mem[1]
    cached = store.cache_get("fund_scale_map:v1", 24 * 3600)
    if cached and not force:
        _scale_mem[0], _scale_mem[1] = now, cached
        return cached
    with _lock_for("fund_scale_map"):
        cached = store.cache_get("fund_scale_map:v1", 24 * 3600)
        if cached and not force:
            _scale_mem[0], _scale_mem[1] = now, cached
            return cached
        import akshare as ak

        try:
            df = _ak(ak.fund_scale_open_sina)
        except DataError:
            return {}
        result = {}
        for row in df.to_dict("records"):
            code = str(row.get("基金代码") or "").strip().zfill(6)
            shares = _num(row.get("最近总份额"))
            nav = _num(row.get("单位净值"))
            if not re.fullmatch(r"\d{6}", code) or not shares or not nav:
                continue
            scale = shares * nav / 1e8
            if scale <= 0 or scale > 1e6:
                continue
            result[code] = {
                "scale": round(scale, 2),
                "established": str(row.get("成立日期"))[:10] if row.get("成立日期") else None,
                "shares": shares,
                "nav": nav,
            }
        store.cache_set("fund_scale_map:v1", result)
        _scale_mem[0], _scale_mem[1] = time.time(), result
        return result


def fund_holder_rows(code: str) -> list[dict]:
    try:
        resp = _req(
            "https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
            {"type": "cyrjg", "code": code, "rt": str(time.time())},
            headers={"Referer": f"https://fundf10.eastmoney.com/cyrjg_{code}.html"},
            timeout=20,
            tries=2,
        )
    except DataError:
        return []
    match = re.search(r'content:"(.*?)"\s*[,}]', resp.text, re.S)
    if not match:
        return []
    html = match.group(1).replace("\\'", "'").replace('\\"', '"')
    try:
        tables = pd.read_html(StringIO(html))
    except Exception:
        return []
    if not tables:
        return []
    df = tables[0].copy()
    df.columns = [re.sub(r"[\s\u00a0]+", "", str(c)) for c in df.columns]

    def col(*needles: str) -> str | None:
        for c in df.columns:
            if all(n in c for n in needles):
                return c
        return None

    c_date = col("公告日期") or col("日期")
    c_inst = col("机构")
    c_indiv = col("个人")
    c_internal = col("内部")
    c_shares = col("总份额")
    rows = []
    for row in df.to_dict("records"):
        day = str(row.get(c_date))[:10]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            continue
        rows.append(
            {
                "code": code,
                "date": day,
                "institution": _num(row.get(c_inst)) if c_inst else None,
                "individual": _num(row.get(c_indiv)) if c_indiv else None,
                "internal": _num(row.get(c_internal)) if c_internal else None,
                "total_shares": _num(row.get(c_shares)) if c_shares else None,
            }
        )
    rows.sort(key=lambda x: x["date"], reverse=True)
    return rows




def fund_manager_history(code: str) -> list[dict]:
    key = f"manager_history:v1:{code}"
    cached = store.cache_get(key, 7 * 24 * 3600)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, 7 * 24 * 3600)
        if cached is not None:
            return cached
        try:
            resp = _req(
                f"https://fundf10.eastmoney.com/jjjl_{code}.html",
                headers={"Referer": "https://fundf10.eastmoney.com/"},
                timeout=20,
                tries=2,
            )
            tables = pd.read_html(StringIO(resp.text))
        except (DataError, ValueError):
            return []
        table = None
        for candidate in tables:
            cols = [str(c) for c in candidate.columns]
            if "起始期" in cols and "基金经理" in cols:
                table = candidate
                break
        if table is None:
            return []
        rows = []
        for row in table.to_dict("records"):
            start = str(row.get("起始期") or "")[:10]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start):
                continue
            end = str(row.get("截止期") or "")[:10]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
                end = None
            rows.append(
                {
                    "start": start,
                    "end": end,
                    "manager": str(row.get("基金经理") or "").strip(),
                    "period": str(row.get("任职期间") or "").strip(),
                    "return": _num(row.get("任职回报")),
                    "current": end is None,
                }
            )
        rows.sort(key=lambda x: x["start"])
        store.cache_set(key, rows)
        return rows


# ---------------------------------------------------------- fund reports ---

def _notice_pages(art_code: str, max_pages: int = 20) -> str:
    try:
        resp = _req(
            "https://np-cnotice-fund.eastmoney.com/api/content/ann",
            {"art_code": art_code, "client_source": "web_fund", "show_all": "1"},
            headers={"Referer": "https://fund.eastmoney.com/"},
            timeout=30,
            tries=2,
        )
        payload = resp.json()
        text = (payload.get("data") or {}).get("notice_content") or ""
        if text:
            return text
    except (DataError, ValueError):
        pass

    chunks = []
    for page in range(1, max_pages + 1):
        try:
            resp = _req(
                "https://np-cnotice-stock.eastmoney.com/api/content/ann",
                {"art_code": art_code, "client_source": "web", "page_index": str(page)},
                headers={"Referer": "https://fund.eastmoney.com/"},
                timeout=25,
                tries=2,
            )
            payload = resp.json()
        except (DataError, ValueError):
            break
        text = (payload.get("data") or {}).get("notice_content") or ""
        if not text:
            break
        chunks.append(text)
        if len(text) < 5000:
            break
        time.sleep(0.03)
    return "\n".join(chunks)


def _clean_report(text: str) -> str:
    text = text.replace("\r", "\n").replace("\u3000", " ").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text)
    text = re.sub(r"(?<=[\u4e00-\u9fa5，。；：、）】])\n(?=[\u4e00-\u9fa5（【])", "", text)
    text = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])", "", text)
    return text.strip()


def _find_section_start(text: str, start_word: str):
    matches = list(re.finditer(re.escape(start_word), text))
    for match in matches:
        tail = text[match.end() : match.end() + 100]
        if "......" in tail or "…" in tail:
            continue
        return match
    return matches[0] if matches else None


def _report_section(text: str, starts: list[str], stops: list[str], limit: int = 4000) -> str:
    for start_word in starts:
        match = _find_section_start(text, start_word)
        if match is None:
            continue
        rest = text[match.end() :].lstrip("：: \n")
        end = len(rest)
        for stop in stops:
            pos = rest.find(stop, 0, limit * 2)
            if pos > 30:
                end = min(end, pos)
        stop_heading = re.search(
            r"(?:4\.\d(?:\.\d+)?|5\.\d)\s*(?:报告期内|管理人对|管理人内部|投资组合报告|§)",
            rest[: limit + 500],
        )
        if stop_heading:
            end = min(end, stop_heading.start())
        snippet = rest[: min(end, limit)].strip()
        if snippet:
            return snippet
    return ""


def fund_report(code: str, report_type: str = "latest") -> dict:
    key = f"report:v4:{report_type}:{code}"
    fail_key = f"report:fail:v2:{report_type}:{code}"
    cached = store.cache_get(key, 7 * 24 * 3600)
    if cached is not None:
        return cached
    failed = store.cache_get(fail_key, 900)
    if failed is not None:
        return failed
    with _lock_for(key):
        cached = store.cache_get(key, 7 * 24 * 3600)
        if cached is not None:
            return cached
        try:
            resp = _req(
                "https://api.fund.eastmoney.com/f10/JJGG",
                {"fundcode": code, "pageIndex": "1", "pageSize": "200", "type": "0"},
                headers={"Referer": f"https://fundf10.eastmoney.com/jjgg_{code}.html"},
            )
            items = (resp.json() or {}).get("Data") or []
        except (DataError, ValueError):
            return {"available": False, "reports": []}
        candidates = []
        for item in items:
            title = str(item.get("TITLE") or "")
            if "摘要" in title:
                continue
            if "季度报告" in title:
                kind = "季报"
            elif "半年度报告" in title:
                kind = "中报"
            elif "年度报告" in title:
                kind = "年报"
            else:
                continue
            candidates.append({**item, "kind": kind})
        if not candidates:
            result = {"available": False, "reports": []}
            store.cache_set(key, result)
            return result
        if report_type == "annual":
            annual = [item for item in candidates if item["kind"] == "年报"]
            semi = [item for item in candidates if item["kind"] == "中报"]
            candidates = annual or semi or candidates
        latest = candidates[0]
        is_annual = latest["kind"] in ("年报", "中报")
        text = _clean_report(_notice_pages(latest["ID"], 40 if is_annual else 15))
        strategy = _report_section(
            text,
            [
                "报告期内基金投资策略和运作分析",
                "投资策略和运作分析",
                "投资策略和业绩表现的说明",
                "投资策略和业绩表现",
            ],
            ["报告期内基金的业绩表现", "4.4.2", "4.5 管理人对", "4.5管理人对", "§5"],
            3200,
        )
        performance = _report_section(
            text,
            ["报告期内基金的业绩表现", "基金业绩表现"],
            ["4.5 管理人对", "4.5管理人对", "4.6", "5.1", "§5"],
            1400,
        )
        outlook = _report_section(
            text,
            [
                "管理人对宏观经济、证券市场及行业走势的简要展望",
                "宏观经济、证券市场及行业走势的简要展望",
                "市场展望",
                "后市展望",
            ],
            ["4.6", "5.1", "§5", "§6"],
            2600,
        )
        if not strategy:
            strategy = _report_section(text, ["4.4"], ["4.5", "4.6", "§5"], 1600)
        result = {
            "available": bool(text),
            "title": latest.get("TITLE"),
            "date": latest.get("PUBLISHDATEDesc"),
            "kind": latest.get("kind"),
            "id": latest.get("ID"),
            "requested_type": report_type,
            "source": f"https://fund.eastmoney.com/gonggao/{code},{latest.get('ID')}.html",
            "strategy": strategy,
            "performance": performance,
            "outlook": outlook,
            "text_length": len(text),
        }
        if result["available"]:
            store.cache_set(key, result)
        else:
            store.cache_set(fail_key, result)
        return result


# ------------------------------------------------------------------ quotes ---

def _tencent_symbol(code: str) -> str | None:
    if not re.fullmatch(r"\d{6}", code):
        return None
    if code.startswith("920"):
        return f"bj{code}"
    if code.startswith(("6", "9")):
        return f"sh{code}"
    if code.startswith(("0", "3")):
        return f"sz{code}"
    if code.startswith(("4", "8")):
        return f"bj{code}"
    return None


def _fetch_tencent_quotes(codes: list[str]) -> list[dict]:
    symbols = [_tencent_symbol(c) for c in codes]
    symbols = [s for s in symbols if s]
    if not symbols:
        return []
    resp = _req(
        "https://qt.gtimg.cn/q=" + ",".join(symbols),
        headers={"Referer": "https://finance.qq.com/"},
        timeout=20,
    )
    text = resp.content.decode("gbk", errors="ignore")
    out = []
    for line in text.splitlines():
        match = re.search(r'v_(?:sh|sz|bj)(\d{6})="(.*)";', line)
        if not match:
            continue
        code, body = match.group(1), match.group(2)
        parts = body.split("~")
        if len(parts) < 47:
            continue

        def num(idx: int) -> float | None:
            try:
                value = float(parts[idx])
            except (ValueError, IndexError):
                return None
            return value if math.isfinite(value) else None

        pe = num(39)
        pb = num(46)
        out.append(
            {
                "code": code,
                "name": parts[1],
                "price": num(3),
                "pct": num(32),
                "pe": pe if pe and pe > 0 else None,
                "pb": pb if pb and pb > 0 else None,
                "float_cap": (num(44) or 0) * 1e8 or None,
                "mktcap": (num(45) or 0) * 1e8 or None,
            }
        )
    return out


def _fetch_industry_one(code: str) -> dict | None:
    if not re.fullmatch(r"\d{6}", code):
        return None
    if code.startswith("920"):
        prefix = "BJ"
    elif code.startswith(("6", "9")):
        prefix = "SH"
    elif code.startswith(("4", "8")):
        prefix = "BJ"
    else:
        prefix = "SZ"
    try:
        resp = _req(
            "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
            {"code": f"{prefix}{code}"},
            headers={"Referer": "https://emweb.securities.eastmoney.com/"},
            timeout=15,
            tries=2,
        )
        boards = resp.json().get("ssbk") or []
    except Exception:
        return None
    ranked = sorted(
        [b for b in boards if b.get("BOARD_NAME") and b.get("BOARD_RANK")],
        key=lambda b: b.get("BOARD_RANK") or 99,
    )
    level1 = ranked[0]["BOARD_NAME"] if ranked else "其他"
    level2 = ranked[1]["BOARD_NAME"] if len(ranked) > 1 else level1
    return {"code": code, "industry": level1, "industry_l2": level2}


def stock_quotes_cached(codes: list[str]) -> dict[str, dict]:
    """Quote rows already present in SQLite, without any network refresh."""
    if not codes:
        return {}
    rows = store.stocks_get([c for c in dict.fromkeys(codes) if _tencent_symbol(c)])
    return {code: row for code, row in rows.items() if row}


def stock_quotes(codes: list[str], max_age: float = TTL_QUOTE) -> dict[str, dict]:
    codes = [c for c in dict.fromkeys(codes) if _tencent_symbol(c)]
    if not codes:
        return {}
    now = time.time()
    mem_rows = {
        c: _quote_mem[c][1]
        for c in codes
        if c in _quote_mem and now - _quote_mem[c][0] <= max_age
    }
    db_codes = [c for c in codes if c not in mem_rows]
    cached = store.stocks_get(db_codes)
    cached.update(mem_rows)
    stale = [
        c
        for c in codes
        if c not in cached or now - (cached[c].get("updated_at") or 0) > max_age
    ]
    if stale:
        fresh: list[dict] = []
        for i in range(0, len(stale), 60):
            try:
                fresh.extend(_fetch_tencent_quotes(stale[i : i + 60]))
            except DataError:
                continue
            time.sleep(0.08)
        if fresh:
            store.stocks_upsert(fresh)

    all_rows = store.stocks_get(codes)
    missing_industry = [
        c
        for c in codes
        if c in all_rows
        and (
            not all_rows[c].get("industry")
            or all_rows[c].get("industry") in ("其他", "未分类")
        )
        and now - _industry_miss.get(c, 0) > 7 * 24 * 3600
    ]
    if missing_industry:
        industries = []
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(_fetch_industry_one, missing_industry))
        for code, item in zip(missing_industry, results):
            if item:
                industries.append(item)
            else:
                _industry_miss[code] = now
        if industries:
            store.stocks_set_industry(industries)
            for item in industries:
                row = all_rows.get(item["code"])
                if row:
                    row["industry"] = item["industry"]
                    row["industry_l2"] = item["industry_l2"]
    for code, row in all_rows.items():
        _quote_mem[code] = (now, row)
    return {c: all_rows[c] for c in codes if c in all_rows}



# ------------------------------------------------------------------ market ---

def _fetch_market(quarter: str) -> list[dict]:
    report_date = quarter_to_date(quarter)
    rows: dict[str, dict] = {}
    headers = {"Referer": "https://data.eastmoney.com/"}
    page = 1
    pages = 1
    while page <= pages:
        resp = _req(
            "https://data.eastmoney.com/dataapi/zlsj/list",
            {
                "date": report_date,
                "type": "1",
                "zjc": "0",
                "sortField": "HOULD_NUM",
                "sortDirec": "1",
                "pageNum": str(page),
                "pageSize": "500",
                "p": str(page),
                "pageNo": str(page),
            },
            headers=headers,
        )
        try:
            payload = resp.json()
        except ValueError as exc:
            raise DataError(f"全市场持仓接口返回异常: {exc}") from exc
        if page == 1:
            pages = int(payload.get("pages") or 0)
        data = payload.get("data") or []
        if not data:
            break
        for item in data:
            code = str(item.get("SECURITY_CODE") or "")
            if not code:
                continue
            rows[code] = {
                "code": code,
                "name": item.get("SECURITY_NAME_ABBR"),
                "fund_count": _int(item.get("HOULD_NUM")) or 0,
                "total_shares": _num(item.get("TOTAL_SHARES")),
                "hold_value": _num(item.get("HOLD_VALUE")),
                "free_ratio": _num(item.get("FREESHARES_RATIO")),
                "change": item.get("HOLDCHA"),
                "change_shares": _num(item.get("HOLDCHA_NUM")),
                "change_ratio": _num(item.get("HOLDCHA_RATIO")),
                "change_value": _num(item.get("HOLDCHA_VALUE")),
            }
        page += 1
        time.sleep(0.12)
    return list(rows.values())


def market_quarter(quarter: str, force: bool = False, max_age: float | None = None) -> list[dict]:
    if max_age is None:
        max_age = 1800 if quarter >= recent_quarters(1)[0] else 7 * 24 * 3600
    ts = store.market_quarter_ts(quarter)
    if not force and ts and time.time() - ts < max_age:
        rows = store.market_rows(quarter)
        if rows:
            return rows
    with _lock_for(f"market:{quarter}"):
        ts = store.market_quarter_ts(quarter)
        if not force and ts and time.time() - ts < max_age:
            rows = store.market_rows(quarter)
            if rows:
                return rows
        try:
            rows = _fetch_market(quarter)
        except Exception:
            cached = store.market_rows(quarter)
            if cached:
                return cached
            raise
        if rows:
            store.market_replace(quarter, rows)
            store.meta_set(f"market_ts:{quarter}", str(time.time()))
        return store.market_rows(quarter)


def stock_extremes(quarter: str) -> dict[str, float | None]:
    rows = store.market_rows(quarter)
    values = [r["hold_value"] for r in rows if r.get("hold_value")]
    counts = [r["fund_count"] for r in rows if r.get("fund_count")]
    return {
        "max_value": max(values) if values else None,
        "max_count": max(counts) if counts else None,
        "total_value": sum(values) if values else 0,
        "total_count": sum(counts) if counts else 0,
    }


# -------------------------------------------------------------- other data ---

def company_aum() -> list[dict]:
    now = time.time()
    if _company_mem[1] is not None and now - _company_mem[0] < 3600:
        return _company_mem[1]
    cached = store.cache_get("company_aum", TTL_AUM)
    if cached:
        _company_mem[0], _company_mem[1] = now, cached
        return cached
    with _lock_for("company_aum"):
        cached = store.cache_get("company_aum", TTL_AUM)
        if cached:
            _company_mem[0], _company_mem[1] = now, cached
            return cached
        import akshare as ak

        try:
            df = _ak(ak.fund_aum_em)
        except DataError:
            return []
        rows = []
        for row in df.to_dict("records"):
            rows.append(
                {
                    "company": row.get("基金公司"),
                    "established": str(row.get("成立时间")) if row.get("成立时间") else None,
                    "aum": _num(row.get("全部管理规模")),
                    "fund_count": _int(row.get("全部基金数")),
                    "manager_count": _int(row.get("全部经理数")),
                    "updated": str(row.get("更新日期")) if row.get("更新日期") else None,
                }
            )
        rows.sort(key=lambda x: x.get("aum") or 0, reverse=True)
        store.cache_set("company_aum", rows)
        _company_mem[0], _company_mem[1] = time.time(), rows
        return rows


def market_holder_structure() -> dict:
    now = time.time()
    if _holder_mem[1] is not None and now - _holder_mem[0] < 600:
        return _holder_mem[1]
    cached = store.cache_get("holder_market:v1", TTL_HOLDER)
    if cached:
        _holder_mem[0], _holder_mem[1] = now, cached
        return cached
    with _lock_for("holder_market"):
        cached = store.cache_get("holder_market:v1", TTL_HOLDER)
        if cached:
            _holder_mem[0], _holder_mem[1] = now, cached
            return cached
        import akshare as ak

        try:
            df = _ak(ak.fund_hold_structure_em)
        except DataError:
            return {"dates": [], "institution": [], "individual": [], "internal": [], "latest": None}
        if df.empty:
            return {"dates": [], "institution": [], "individual": [], "internal": [], "latest": None}
        df = df.copy()
        # 天天基金当前列名存在“比列”错别字，按位置兼容更稳。
        cols = list(df.columns)
        date_col = next((c for c in cols if "日期" in str(c)), cols[1])
        count_col = next((c for c in cols if "家数" in str(c)), cols[2])
        inst_col = next((c for c in cols if "机构" in str(c)), cols[3])
        indiv_col = next((c for c in cols if "个人" in str(c)), cols[4])
        internal_col = next((c for c in cols if "内部" in str(c)), cols[5])
        share_col = next((c for c in cols if "总份额" in str(c)), cols[6] if len(cols) > 6 else None)
        rows = []
        for row in df.to_dict("records"):
            day = str(row.get(date_col))[:10]
            if not day or day == "NaT":
                continue
            rows.append(
                {
                    "date": day,
                    "fund_count": _int(row.get(count_col)),
                    "institution": _num(row.get(inst_col)),
                    "individual": _num(row.get(indiv_col)),
                    "internal": _num(row.get(internal_col)),
                    "total_shares": _num(row.get(share_col)) if share_col else None,
                }
            )
        rows.sort(key=lambda x: x["date"])
        if not rows:
            return {"dates": [], "institution": [], "individual": [], "internal": [], "latest": None}
        latest = rows[-1]
        prev = rows[-2] if len(rows) > 1 else None
        payload = {
            "dates": [r["date"] for r in rows],
            "fund_count": [r["fund_count"] for r in rows],
            "institution": [r["institution"] for r in rows],
            "individual": [r["individual"] for r in rows],
            "internal": [r["internal"] for r in rows],
            "total_shares": [r["total_shares"] for r in rows],
            "latest": latest,
            "prev": prev,
            "source": "天天基金 · 基金数据 · 持有人结构（全市场合计）",
        }
        store.cache_set("holder_market:v1", payload)
        _holder_mem[0], _holder_mem[1] = time.time(), payload
        return payload


def fund_share_flows(code: str) -> list[dict]:
    key = f"flows:{code}"
    cached = store.cache_get(key, TTL_FLOWS)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, TTL_FLOWS)
        if cached is not None:
            return cached
        try:
            resp = _req(
                "https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
                {"type": "gmbd", "code": code, "rt": str(time.time())},
                headers={"Referer": f"https://fundf10.eastmoney.com/gmbd_{code}.html"},
            )
        except DataError:
            return []
        text = resp.text
        match = re.search(r'content:"(.*?)"\s*[,}]', text, re.S)
        if not match:
            return []
        html = match.group(1).replace("\\'", "'").replace('\\"', '"')
        try:
            tables = pd.read_html(StringIO(html))
        except Exception:
            return []
        if not tables:
            return []
        df = tables[0].copy()
        df.columns = [re.sub(r"[\s\u00a0]+", "", str(c)) for c in df.columns]

        def col(*needles: str) -> str | None:
            for c in df.columns:
                if all(n in c for n in needles):
                    return c
            return None

        c_date = col("日期")
        c_sub = col("申购")
        c_red = col("赎回")
        c_shares = col("期末总份额")
        c_assets = col("期末净资产")
        c_change = col("净资产变动率")
        rows = []
        for row in df.to_dict("records"):
            day = str(row.get(c_date))[:10]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                continue
            sub = _num(row.get(c_sub)) if c_sub else None
            red = _num(row.get(c_red)) if c_red else None
            rows.append(
                {
                    "date": day,
                    "subscription": sub,
                    "redemption": red,
                    "net": round((sub or 0) - (red or 0), 4) if sub is not None or red is not None else None,
                    "total_shares": _num(row.get(c_shares)) if c_shares else None,
                    "net_assets": _num(row.get(c_assets)) if c_assets else None,
                    "asset_change": _num(row.get(c_change)) if c_change else None,
                }
            )
        rows.sort(key=lambda x: x["date"], reverse=True)
        store.cache_set(key, rows)
        return rows


def stock_kline(code: str, days: int = 320) -> list[list]:
    symbol = _tencent_symbol(code)
    if not symbol:
        return []
    key = f"stock:kline:v1:{code}:{days}"
    cached = store.cache_get(key, 3600)
    if cached is not None:
        return cached
    with _lock_for(key):
        cached = store.cache_get(key, 3600)
        if cached is not None:
            return cached
        try:
            resp = _req(
                "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                {"param": f"{symbol},day,,,{days},qfq"},
                headers={"Referer": "https://gu.qq.com/"},
                timeout=20,
            )
            payload = resp.json()
        except (DataError, ValueError):
            return []
        node = (payload.get("data") or {}).get(symbol) or {}
        klines = node.get("qfqday") or node.get("day") or []
        values = []
        for line in klines:
            if len(line) >= 3:
                close = _num(line[2])
                if close is not None:
                    values.append([line[0], close])
        if values:
            store.cache_set(key, values)
        return values


def benchmark_series() -> dict:
    cached = store.cache_get("benchmark:hs300:v2", TTL_BENCHMARK)
    if cached:
        return cached
    with _lock_for("benchmark"):
        cached = store.cache_get("benchmark:hs300:v2", TTL_BENCHMARK)
        if cached:
            return cached
        try:
            resp = _req(
                "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                {"param": "sh000300,day,,,1600,qfq"},
                headers={"Referer": "https://gu.qq.com/"},
            )
            payload = resp.json()
        except (DataError, ValueError):
            return {"name": "沪深300", "values": []}
        node = ((payload.get("data") or {}).get("sh000300") or {})
        klines = node.get("day") or node.get("qfqday") or []
        values = []
        for line in klines:
            if len(line) >= 3:
                close = _num(line[2])
                if close is not None:
                    values.append([line[0], close])
        result = {"name": "沪深300", "values": values}
        if values:
            store.cache_set("benchmark:hs300:v2", result)
        return result


def data_freshness_note() -> str:
    now = datetime.now(timezone.utc).astimezone()
    return now.strftime("%Y-%m-%d %H:%M")
