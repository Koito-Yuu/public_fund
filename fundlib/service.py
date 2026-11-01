"""Response builders that combine datasource and analytics for the web UI."""

from __future__ import annotations

import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

from . import analytics as an
from . import datasource as ds
from . import store
from . import top10


def _num(value, digits=2):
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return round(out, digits)


def _fmt_ts(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def _pct_change(now, prev):
    if now is None or prev in (None, 0):
        return None
    return (now / prev - 1) * 100


def _rank_map(rows: list[dict]) -> dict[str, int]:
    ranked = sorted(rows, key=lambda r: r.get("fund_count") or 0, reverse=True)
    return {r["code"]: i + 1 for i, r in enumerate(ranked)}


def _parse_scale(pingzhong: dict):
    scale = pingzhong.get("scale") or {}
    categories = scale.get("categories") or []
    raw_series = scale.get("series") or []
    if raw_series and isinstance(raw_series[0], dict) and "y" in raw_series[0]:
        values = [item.get("y") for item in raw_series]
        moms = [item.get("mom") for item in raw_series]
    else:
        series = raw_series[0] if raw_series else {}
        values = series.get("y") or []
        moms = series.get("mom") or []
    latest = values[-1] if values else None
    change = None
    if moms:
        raw = str(moms[-1]).replace("%", "")
        try:
            change = float(raw)
        except ValueError:
            change = None
    return {
        "dates": categories,
        "values": values,
        "mom": change,
        "latest": latest,
        "latest_date": categories[-1] if categories else None,
    }


def _parse_holders(pingzhong: dict):
    holders = pingzhong.get("holders") or {}
    categories = holders.get("categories") or []
    series = holders.get("series") or []
    latest = {}
    for item in series:
        values = item.get("data") or []
        name = item.get("name") or ""
        latest[name] = values[-1] if values else None
    return {
        "dates": categories,
        "series": series,
        "latest": latest,
        "latest_date": categories[-1] if categories else None,
    }


def _parse_asset(pingzhong: dict):
    asset = pingzhong.get("asset") or {}
    categories = asset.get("categories") or []
    series = asset.get("series") or []
    latest = {}
    for item in series:
        values = item.get("data") or []
        latest[item.get("name") or ""] = values[-1] if values else None
    return {
        "dates": categories,
        "series": series,
        "latest": latest,
        "latest_date": categories[-1] if categories else None,
    }


def _parse_radar(pingzhong: dict):
    evaluation = pingzhong.get("evaluation") or {}
    if not evaluation.get("categories"):
        return None
    return {
        "categories": evaluation.get("categories"),
        "data": evaluation.get("data"),
        "avg": evaluation.get("avr"),
        "descriptions": evaluation.get("dsc"),
    }


def _parse_managers(pingzhong: dict):
    out = []
    for item in pingzhong.get("managers") or []:
        power = item.get("power") or {}
        out.append(
            {
                "name": item.get("name"),
                "star": item.get("star"),
                "work_time": item.get("workTime"),
                "fund_size": item.get("fundSize"),
                "power": {
                    "categories": power.get("categories") or [],
                    "data": power.get("data") or [],
                    "avg": power.get("avr"),
                }
                if power
                else None,
            }
        )
    return out


def _find_rank_1y(achievement: list[dict]):
    for row in achievement:
        period = str(row.get("period") or "")
        if "近1年" in period or "近一年" in period:
            return an.rank_parse(row.get("rank_text"))
    return (None, None, None)


def _enrich_holdings(stocks: list[dict], quotes: dict, actions: dict | None = None) -> list[dict]:
    out = []
    for stock in stocks:
        quote = quotes.get(stock["code"]) or {}
        item = {
            **stock,
            "industry": quote.get("industry_l2") or quote.get("industry") or "未分类",
            "industry_l1": quote.get("industry") or "未分类",
            "price": quote.get("price"),
            "pct": quote.get("pct"),
            "pe": quote.get("pe"),
            "pb": quote.get("pb"),
            "mktcap": quote.get("mktcap"),
            "action": (actions or {}).get(stock["code"]),
        }
        out.append(item)
    return out


def _industry_from_stocks(stocks: list[dict], quotes: dict, weight_key: str = "weight") -> list[dict]:
    return an.industry_distribution(stocks, quotes, weight_key)


def _industry_share_map(rows: list[dict], quotes: dict) -> tuple[dict[str, float], float, float]:
    buckets: dict[str, float] = {}
    total = 0.0
    mapped = 0.0
    for row in rows:
        value = row.get("hold_value") or 0
        total += value
        quote = quotes.get(row["code"]) or {}
        industry = quote.get("industry")
        if not industry or industry == "其他":
            industry = "未分类"
        else:
            mapped += value
        buckets[industry] = buckets.get(industry, 0) + value
    return (
        {
            k: (v / mapped * 100 if mapped else 0)
            for k, v in buckets.items()
            if k != "未分类"
        },
        total,
        mapped,
    )


def _industry_items(current: dict[str, float], previous: dict[str, float] | None = None, limit: int = 12):
    items = sorted(current.items(), key=lambda x: x[1], reverse=True)
    top = items[:limit]
    rest = sum(v for _, v in items[limit:])
    out = []
    for name, share in top:
        if name == "未分类" and share < 0.5:
            continue
        out.append(
            {
                "name": name,
                "share": _num(share, 2),
                "delta": _num(share - (previous or {}).get(name, 0), 2) if previous else None,
            }
        )
    if rest > 0.05:
        out.append(
            {
                "name": "其他",
                "share": _num(rest, 2),
                "delta": None,
            }
        )
    return out


# ------------------------------------------------------------------ market ---

_market_cache: dict[str, tuple[float, float, dict]] = {}


def market_payload(quarter: str) -> dict:
    ts = store.market_quarter_ts(quarter) or 0
    cached = _market_cache.get(quarter)
    if cached and time.time() - cached[0] < 300 and cached[1] == ts:
        return cached[2]
    cache_key = f"payload:market:v4:{quarter}:{int(ts)}"
    stored = store.cache_get(cache_key, 6 * 3600)
    if not stored and store.OFFLINE:
        stored = store.cache_get_prefix(f"payload:market:v4:{quarter}:")
    if stored:
        _market_cache[quarter] = (time.time(), ts, stored)
        return stored

    rows = ds.market_quarter(quarter)
    if not rows:
        raise ds.DataError(f"{quarter} 暂无全市场持仓数据")

    prev_q = ds.prev_year_quarter(quarter)
    try:
        prev_rows = ds.market_quarter(prev_q, max_age=24 * 3600)
    except Exception:
        prev_rows = []
    prev_map = {r["code"]: r for r in prev_rows}

    universe = ds.fund_universe()
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_companies = pool.submit(ds.company_aum)
        f_holder = pool.submit(ds.market_holder_structure)
        companies = f_companies.result()
        holder_market = f_holder.result()

    trend_quarters = sorted([q for q in store.market_quarters() if q <= quarter])[-6:]
    if quarter not in trend_quarters:
        trend_quarters = sorted(set(trend_quarters + [quarter]))[-6:]

    quote_codes = set()
    for row in sorted(rows, key=lambda r: r.get("hold_value") or 0, reverse=True)[:600]:
        quote_codes.add(row["code"])
    for row in rows[:200]:
        quote_codes.add(row["code"])
    for row in prev_rows[:300]:
        quote_codes.add(row["code"])
    for q in trend_quarters:
        for row in store.market_rows(q)[:200]:
            quote_codes.add(row["code"])
    quotes = ds.stock_quotes(list(quote_codes))

    current_share, total_value, mapped_value = _industry_share_map(rows, quotes)
    prev_share = _industry_share_map(prev_rows, quotes)[0] if prev_rows else None
    industry = _industry_items(current_share, prev_share, limit=12)

    trend_series = []
    top_names = [i["name"] for i in industry if i["name"] not in ("其他", "未分类")][:8]
    for name in top_names:
        series_values = []
        for q in trend_quarters:
            q_rows = store.market_rows(q)
            if not q_rows:
                series_values.append(None)
                continue
            share = _industry_share_map(q_rows, quotes)[0].get(name)
            series_values.append(_num(share, 2))
        trend_series.append({"name": name, "values": series_values})

    bubble = []
    candidates = {r["code"]: r for r in sorted(rows, key=lambda x: x.get("hold_value") or 0, reverse=True)[:120]}
    for r in rows[:70]:
        candidates.setdefault(r["code"], r)
    for code, row in candidates.items():
        quote = quotes.get(code) or {}
        prev = prev_map.get(code)
        bubble.append(
            {
                "code": code,
                "name": row["name"],
                "fund_count": row.get("fund_count"),
                "value": _num((row.get("hold_value") or 0) / 1e8, 2),
                "free_ratio": _num(row.get("free_ratio"), 2),
                "industry": quote.get("industry") or "未分类",
                "pe": _num(quote.get("pe"), 1),
                "mktcap": _num((quote.get("mktcap") or 0) / 1e8, 0) if quote.get("mktcap") else None,
                "fund_count_yoy": _num(
                    _pct_change(row.get("fund_count"), prev.get("fund_count")) if prev else None, 1
                ),
                "fund_count_delta": (
                    (row.get("fund_count") or 0) - (prev.get("fund_count") or 0)
                    if prev
                    else None
                ),
                "value_yoy": _num(
                    _pct_change(row.get("hold_value"), prev.get("hold_value")) if prev else None, 1
                ),
            }
        )
    bubble.sort(key=lambda x: x.get("fund_count") or 0, reverse=True)

    top_holdings = []
    for row in sorted(rows, key=lambda x: x.get("fund_count") or 0, reverse=True)[:25]:
        quote = quotes.get(row["code"]) or {}
        prev = prev_map.get(row["code"])
        top_holdings.append(
            {
                "code": row["code"],
                "name": row["name"],
                "fund_count": row.get("fund_count"),
                "value": _num((row.get("hold_value") or 0) / 1e8, 2),
                "free_ratio": _num(row.get("free_ratio"), 2),
                "industry": quote.get("industry") or "未分类",
                "fund_count_yoy": _num(
                    _pct_change(row.get("fund_count"), prev.get("fund_count")) if prev else None, 1
                ),
                "value_yoy": _num(
                    _pct_change(row.get("hold_value"), prev.get("hold_value")) if prev else None, 1
                ),
            }
        )

    # 共识榜：统一前十大口径，与上一报告期做真实环比（Q2/Q4 已逐基金还原）
    rank_prev_q = ds.prev_quarter(quarter)
    try:
        cur_top = {r["code"]: r for r in top10.quarter_rows(quarter)}
        prev_top = {r["code"]: r for r in top10.quarter_rows(rank_prev_q)} if rank_prev_q else {}
    except Exception:
        cur_top, prev_top = {}, {}
    movers_up, movers_down = [], []
    if prev_top:
        candidates = []
        for code, row in cur_top.items():
            prev = prev_top.get(code)
            if not prev or (prev.get("fund_count") or 0) < 15 or (row.get("fund_count") or 0) < 20:
                continue
            pct = _pct_change(row.get("fund_count"), prev.get("fund_count"))
            if pct is None:
                continue
            candidates.append(
                {
                    "code": code,
                    "name": row.get("name"),
                    "fund_count": row.get("fund_count"),
                    "prev_count": prev.get("fund_count"),
                    "delta": (row.get("fund_count") or 0) - (prev.get("fund_count") or 0),
                    "change": _num(pct, 1),
                    "value": _num(row.get("hold_value"), 2),
                    "industry": "未分类",
                }
            )
        candidates.sort(key=lambda x: x["delta"], reverse=True)
        movers_up = [c for c in candidates if c["delta"] > 0][:8]
        movers_down = sorted(
            [c for c in candidates if c["delta"] < 0], key=lambda x: x["delta"]
        )[:8]
        if movers_up or movers_down:
            extra_quotes = ds.stock_quotes([c["code"] for c in movers_up + movers_down])
            for c in movers_up + movers_down:
                quote = extra_quotes.get(c["code"]) or {}
                c["industry"] = quote.get("industry_l2") or quote.get("industry") or "未分类"

    big_count = sum(1 for r in rows if (r.get("hold_value") or 0) >= 10e9)
    hundred_count = sum(1 for r in rows if (r.get("hold_value") or 0) >= 100e9)
    latest_q = ds.recent_quarters(1)[0]
    kind = ds.disclosure_kind(quarter)
    partial = quarter == latest_q and kind == "top10"
    disclosure = "中报 / 年报为全量持仓披露，一季报 / 三季报仅披露前十大重仓股；跨季计数对比默认采用同比口径。"
    if kind == "full":
        disclosure += " 当前所选报告期为全量披露口径。"
    if partial:
        disclosure += " 当前报告期处于披露窗口，数据仍在持续更新。"

    payload = {
        "quarter": quarter,
        "quarter_label": ds.quarter_label(quarter),
        "as_of": ds.quarter_to_date(quarter),
        "fetched_at": _fmt_ts(ts),
        "disclosure": disclosure,
        "partial": partial,
        "kpis": {
            "fund_total": len(universe),
            "stock_count": len(rows),
            "total_value": _num(total_value / 1e8, 1),
            "fund_mentions": sum((r.get("fund_count") or 0) for r in rows),
            "big_count": big_count,
            "hundred_count": hundred_count,
            "industry_coverage": _num(mapped_value / total_value * 100, 1) if total_value else None,
        },
        "top_holdings": top_holdings,
        "industry": industry,
        "industry_trend": {
            "quarters": [ds.quarter_label(q) for q in trend_quarters],
            "series": trend_series,
        },
        "bubble": bubble,
        "movers": {
            "up": movers_up,
            "down": movers_down,
            "basis": "top10_qoq",
            "available": bool(prev_top),
            "prev_quarter": rank_prev_q,
            "prev_quarter_label": ds.quarter_label(rank_prev_q),
        },
        "companies": companies[:12],
        "holder_market": holder_market,
        "prev_quarter": prev_q if prev_rows else None,
        "updated_at": _fmt_ts(time.time()),
    }
    _market_cache[quarter] = (time.time(), ts, payload)
    store.cache_set(cache_key, payload)
    return payload


# -------------------------------------------------------------------- fund ---

_fund_cache: dict[str, tuple[float, dict]] = {}


def _manager_tenures(history: list[dict], nav_points: list[list], benchmark: dict) -> list[dict]:
    if not history or len(nav_points) < 2:
        return []
    nav_dates = [point[0] for point in nav_points]
    nav_values = {point[0]: point[1] for point in nav_points}
    bm_values = benchmark.get("values") or []
    bm_dates = [item[0] for item in bm_values]
    bm_map = {item[0]: item[1] for item in bm_values}

    def first_on_or_after(dates: list[str], target: str) -> str | None:
        for day in dates:
            if day >= target:
                return day
        return None

    def last_on_or_before(dates: list[str], target: str) -> str | None:
        found = None
        for day in dates:
            if day <= target:
                found = day
            else:
                break
        return found

    out = []
    for item in history:
        start = item.get("start")
        if not start:
            continue
        end = item.get("end") or nav_dates[-1]
        if end < nav_dates[0] or start > nav_dates[-1]:
            continue
        fund_start = first_on_or_after(nav_dates, start)
        fund_end = last_on_or_before(nav_dates, end)
        if not fund_start or not fund_end or fund_start >= fund_end:
            continue
        fund_return = (nav_values[fund_end] / nav_values[fund_start] - 1) * 100
        bm_return = None
        if bm_dates:
            bm_start = first_on_or_after(bm_dates, start)
            bm_end = last_on_or_before(bm_dates, end)
            if bm_start and bm_end and bm_start < bm_end:
                bm_return = (bm_map[bm_end] / bm_map[bm_start] - 1) * 100
        excess = fund_return - bm_return if bm_return is not None else None
        months = round((date.fromisoformat(fund_end) - date.fromisoformat(fund_start)).days / 30.44, 1)
        annualized = None
        if months >= 1 and fund_return > -100:
            annualized = ((1 + fund_return / 100) ** (12 / months) - 1) * 100
        out.append(
            {
                "manager": item.get("manager"),
                "start": start,
                "end": item.get("end"),
                "current": bool(item.get("current")),
                "months": months,
                "return": _num(fund_return, 2),
                "annualized": _num(annualized, 2),
                "reported_return": item.get("return"),
                "benchmark_return": _num(bm_return, 2),
                "excess": _num(excess, 2),
            }
        )
    out.sort(key=lambda x: x["start"], reverse=True)
    return out


def _holder_analysis(holders: dict, flows: list[dict], market: dict | None) -> dict | None:
    dates = holders.get("dates") or []
    series = holders.get("series") or []
    if not dates or not series:
        return None

    def values_for(needle: str) -> list:
        for item in series:
            if needle in str(item.get("name") or ""):
                values = item.get("data") or []
                return values[-len(dates) :]
        return [None] * len(dates)

    institution = values_for("机构")
    individual = values_for("个人")
    internal = values_for("内部")

    def latest_of(values):
        return values[-1] if values and values[-1] is not None else None

    latest = {
        "institution": _num(latest_of(institution), 2),
        "individual": _num(latest_of(individual), 2),
        "internal": _num(latest_of(internal), 3),
    }
    prev = {
        "institution": _num(institution[-2], 2) if len(institution) > 1 else None,
        "individual": _num(individual[-2], 2) if len(individual) > 1 else None,
        "internal": _num(internal[-2], 3) if len(internal) > 1 else None,
    }
    changes = {
        key: _num(latest[key] - prev[key], 2)
        if latest.get(key) is not None and prev.get(key) is not None
        else None
        for key in ("institution", "individual", "internal")
    }

    market_latest = (market or {}).get("latest") or {}
    market_institution = market_latest.get("institution")
    market_gap = (
        _num(latest["institution"] - market_institution, 2)
        if latest.get("institution") is not None and market_institution is not None
        else None
    )

    latest_date = dates[-1]
    flow = next((f for f in flows if f.get("date") and f["date"] <= latest_date), None)
    signals = []
    internal_ratio = latest.get("internal")
    if internal_ratio is not None:
        if internal_ratio >= 5:
            signals.append({"level": "good", "title": "内部自购信号强", "text": f"内部持有比例 {internal_ratio:.2f}%，在公募基金中属于较高水平，通常反映基金公司员工/管理层较大比例持有。"})
        elif internal_ratio >= 1:
            signals.append({"level": "info", "title": "存在内部持有", "text": f"内部持有比例 {internal_ratio:.2f}%，可作为员工/管理层自购的代理观察指标。"})
        else:
            signals.append({"level": "info", "title": "内部持有较低", "text": f"内部持有比例 {internal_ratio:.2f}%，公开披露口径下内部自购信号较弱。"})

    inst_change = changes.get("institution")
    if inst_change is not None:
        if inst_change >= 5:
            signals.append({"level": "info", "title": "机构占比抬升", "text": f"最新披露期机构持有比例较上期上升 {inst_change:.2f} 个百分点。"})
        elif inst_change <= -5:
            signals.append({"level": "warn", "title": "机构占比下降", "text": f"最新披露期机构持有比例较上期下降 {abs(inst_change):.2f} 个百分点，关注机构赎回或份额结构调整。"})

    if flow and inst_change is not None:
        net = flow.get("net")
        if net is not None and inst_change > 0 and net < 0:
            signals.append({"level": "info", "title": "机构占比与份额背离", "text": "机构占比上升但同期份额净赎回，可能来自存量结构调整或场内份额转移，不宜直接解读为机构新增申购。"})
        elif net is not None and inst_change > 0 and net > 0:
            signals.append({"level": "good", "title": "机构资金流入", "text": f"机构占比与份额同步上升，同期净申购约 {net:.2f} 亿份。"})

    if latest.get("individual") is not None and latest["individual"] >= 95:
        signals.append({"level": "info", "title": "零售主导", "text": f"个人持有比例 {latest['individual']:.2f}%，负债端以零售资金为主，需关注情绪化申赎。"})

    if market_institution is not None:
        direction = "高于" if (latest.get("institution") or 0) >= market_institution else "低于"
        signals.append({"level": "info", "title": "与全市场对比", "text": f"全市场机构持有比例 {market_institution:.2f}%，本基金{direction}全市场 {abs(market_gap or 0):.2f} 个百分点。"})

    return {
        "dates": dates,
        "institution": [ _num(v, 2) for v in institution ],
        "individual": [ _num(v, 2) for v in individual ],
        "internal": [ _num(v, 3) for v in internal ],
        "latest": latest,
        "prev": prev,
        "prev_date": dates[-2] if len(dates) > 1 else None,
        "latest_date": latest_date,
        "changes": changes,
        "market": {
            "date": market_latest.get("date"),
            "institution": _num(market_institution, 2),
            "individual": _num(market_latest.get("individual"), 2),
            "internal": _num(market_latest.get("internal"), 3),
            "gap": market_gap,
        },
        "flow": flow,
        "signals": signals,
        "caveat": "内部持有为基金公司员工/管理层持有本基金份额，是公开披露中接近“自购”的代理指标，不等同于基金公司自有资金自购；机构占比变化也可能来自场内交易或份额锁定，不必然是申购赎回。",
    }


def _related_funds(meta: dict, code: str) -> list[dict]:
    manager_names = {
        name for name in re.split(r"[,，/、\s]+", meta.get("manager") or "") if name
    }
    company = meta.get("company")
    if not manager_names or not company:
        return []
    out = []
    for row in ds.fund_universe():
        if row["code"] == code or row.get("company") != company:
            continue
        row_names = {
            name for name in re.split(r"[,，/、\s]+", row.get("manager") or "") if name
        }
        if not (manager_names & row_names):
            continue
        out.append(
            {
                "code": row["code"],
                "name": row.get("name"),
                "type": row.get("type"),
                "r1y": row.get("r1y"),
                "r3y": row.get("r3y"),
                "fee": row.get("fee"),
                "manager": row.get("manager"),
            }
        )
    out.sort(key=lambda x: x.get("r1y") if x.get("r1y") is not None else -999, reverse=True)
    return out[:6]


def fund_payload(code: str) -> dict:
    code = str(code).zfill(6)
    cached = _fund_cache.get(code)
    if cached and time.time() - cached[0] < 1800:
        return cached[1]
    stored = store.cache_get(f"payload:fund:v8:{code}", 6 * 3600)
    if stored:
        _fund_cache[code] = (time.time(), stored)
        return stored

    universe = ds.universe_map()
    if code not in universe:
        raise ds.NotFoundError(f"未找到基金 {code}")
    meta = universe[code]
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_pz = pool.submit(ds.fund_pingzhong, code)
        f_hold = pool.submit(ds.fund_holdings, code)
        f_ind = pool.submit(ds.fund_industry_alloc, code)
        f_extra = pool.submit(ds.fund_extra, code)
        f_flows = pool.submit(ds.fund_share_flows, code)
        f_market_holder = pool.submit(ds.market_holder_structure)
        f_mhist = pool.submit(ds.fund_manager_history, code)
        pingzhong = f_pz.result()
        history = f_hold.result()
        official = f_ind.result()
        extra = f_extra.result()
        flows = f_flows.result()
        market_holder = f_market_holder.result()
        manager_history = f_mhist.result()

    is_money = meta.get("category") == "货币型"
    series = [] if is_money else an.nav_series(pingzhong)
    unit = [] if is_money else an.unit_nav(pingzhong)
    has_nav = bool(series)
    metrics = an.metrics_bundle(series) if has_nav else an.metrics_bundle([])
    periods = an.period_returns(series) if has_nav else {}

    latest = history[0] if history else None
    prev = history[1] if len(history) > 1 else None
    change = an.holding_change(latest["stocks"] if latest else [], prev["stocks"] if prev else [])
    action_map = {c["code"]: c["action"] for c in change["items"]}

    quote_codes = []
    for item in history[:4]:
        quote_codes.extend(s["code"] for s in item["stocks"])
    if latest and prev:
        quote_codes.extend(s["code"] for s in prev["stocks"])
    quotes = ds.stock_quotes(list(dict.fromkeys(quote_codes)))

    latest_stocks = _enrich_holdings(latest["stocks"], quotes, action_map) if latest else []
    prev_stocks = _enrich_holdings(prev["stocks"], quotes) if prev else []
    industries = _industry_from_stocks(latest_stocks, quotes)
    prev_industries = _industry_from_stocks(prev_stocks, quotes) if prev_stocks else []
    prev_share = {i["name"]: i["share"] for i in prev_industries}
    for item in industries:
        item["delta"] = _num(item["share"] - prev_share.get(item["name"], 0), 2) if prev_stocks else None
    caps = an.cap_distribution(latest_stocks, quotes)
    top10_weight = _num(sum(s["weight"] for s in latest["stocks"]), 2) if latest else None

    scale = _parse_scale(pingzhong)
    holders = _parse_holders(pingzhong)
    asset = _parse_asset(pingzhong)
    radar = _parse_radar(pingzhong)
    managers = _parse_managers(pingzhong)
    holder_analysis = _holder_analysis(holders, flows, market_holder)
    related_funds = _related_funds(meta, code)
    achievement = extra.get("achievement") or []
    analysis = extra.get("analysis") or []
    basic = extra.get("basic") or {}
    rank_1y = _find_rank_1y(achievement)
    rank_tuple = rank_1y if rank_1y[0] else None

    manager_years = None
    if managers:
        years = [an.manager_years(m.get("work_time")) for m in managers]
        years = [y for y in years if y is not None]
        manager_years = max(years) if years else None

    institution = (holder_analysis or {}).get("latest", {}).get("institution")
    insights = an.fund_insights(
        {
            "top10_weight": top10_weight,
            "industries": industries,
            "metrics_1y": metrics["1y"],
            "metrics_3y": metrics["3y"],
            "change": change,
            "scale": scale.get("latest"),
            "scale_change": scale.get("mom"),
            "holders": {"institution": institution},
            "internal_ratio": (holder_analysis or {}).get("latest", {}).get("internal"),
            "fee": meta.get("fee"),
            "manager_years": manager_years,
            "rank_1y": rank_tuple,
        }
    )
    data_note = None
    if not has_nav:
        insights.insert(0, {
            "level": "info",
            "title": "暂无累计净值数据" if not is_money else "货币基金口径",
            "text": "货币基金以万份收益 / 七日年化为准，没有累计净值序列；规模、持有人与经理信息仍可参考。" if is_money else "该基金暂无累计净值序列（可能为新成立基金），净值与风险指标不适用。",
        })
        data_note = "货币基金采用万份收益 / 七日年化，不适用累计净值口径；本页展示基础档案、规模与持有人信息。" if is_money else "该基金暂无累计净值序列（新成立基金），净值与风险指标不适用。"

    latest_unit = unit[-1][1] if unit else None
    latest_unit_date = unit[-1][0] if unit else None
    nav_dates = [p[0] for p in series]
    nav_values = [p[1] for p in series]
    drawdown = an.drawdown_series(series)
    sampled = an.downsample([[d, v] for d, v in zip(nav_dates, nav_values)], 1200)
    sampled_dd = dict(drawdown)
    benchmark = ds.benchmark_series()
    manager_tenures = _manager_tenures(manager_history, series, benchmark)
    if manager_tenures:
        current = next((item for item in manager_tenures if item["current"]), None)
        if current and current.get("excess") is not None:
            level = "good" if current["excess"] >= 10 else "warn" if current["excess"] <= -10 else "info"
            direction = "跑赢" if current["excess"] >= 0 else "跑输"
            insights.append({
                "level": level,
                "title": "现任经理任期超额",
                "text": f"现任经理任期内基金收益 {current['return']:.2f}%，同期沪深300 {current['benchmark_return']:.2f}%，{direction} {abs(current['excess']):.2f} 个百分点。",
            })

    official_latest = official[0] if official else None
    official_trend = list(reversed(official[:4]))
    official_top = [x["name"] for x in (official_latest["items"] if official_latest else [])][:6]
    official_series = []
    for name in official_top:
        values = []
        for q in official_trend:
            found = next((x for x in q["items"] if x["name"] == name), None)
            values.append(found["weight"] if found else None)
        official_series.append({"name": name, "values": values})

    payload = {
        "code": code,
        "meta": {
            "code": code,
            "name": meta.get("name") or pingzhong.get("name"),
            "type": meta.get("type"),
            "category": meta.get("category"),
            "company": meta.get("company") or basic.get("基金公司"),
            "manager": meta.get("manager") or basic.get("基金经理"),
            "fee": meta.get("fee"),
            "rating_max": meta.get("rating_max"),
            "rating_ms": meta.get("rating_ms"),
            "rating_sh": meta.get("rating_sh"),
            "rating_cms": meta.get("rating_cms"),
            "rating_jax": meta.get("rating_jax"),
            "five_star": meta.get("five_star"),
            "established": basic.get("成立时间"),
            "full_name": basic.get("基金全称"),
            "custodian": basic.get("托管银行"),
            "fund_type_xq": basic.get("基金类型"),
            "benchmark": basic.get("业绩比较基准"),
            "objectives": basic.get("投资目标"),
            "nav": latest_unit,
            "nav_date": latest_unit_date,
            "day_pct": meta.get("day_pct"),
            "scale": scale.get("latest"),
            "scale_date": scale.get("latest_date"),
        },
        "nav": {
            "dates": [p[0] for p in sampled],
            "values": [p[1] for p in sampled],
            "drawdown": [sampled_dd.get(p[0]) for p in sampled],
            "benchmark": benchmark,
        },
        "metrics": metrics,
        "periods": periods,
        "holdings": {
            "latest": {
                "quarter": latest["quarter"] if latest else None,
                "date": latest["date"] if latest else None,
                "stocks": latest_stocks,
                "top10_weight": top10_weight,
                "count": len(latest_stocks),
            },
            "previous": {
                "quarter": prev["quarter"] if prev else None,
                "date": prev["date"] if prev else None,
            },
            "change": change,
            "history": [
                {
                    "quarter": item["quarter"],
                    "date": item["date"],
                    "stocks": item["stocks"],
                }
                for item in history[:4]
            ],
            "industry": industries,
            "cap": caps,
        },
        "official_industry": {
            "latest": official_latest,
            "trend": {
                "dates": [q["date"] for q in official_trend],
                "series": official_series,
            },
            "note": "证监会行业分类，覆盖基金全部股票持仓（季报仅披露行业汇总）",
        },
        "scale": scale,
        "holders": holders,
        "holder_analysis": holder_analysis,
        "flows": flows[:8],
        "related_funds": related_funds,
        "manager_history": manager_history,
        "manager_tenures": manager_tenures,
        "asset": asset,
        "radar": radar,
        "managers": managers,
        "achievement": achievement,
        "analysis": analysis,
        "insights": insights,
        "fee": {
            "default": meta.get("fee"),
            "source_rate": _num(pingzhong.get("source_rate")),
            "rate": _num(pingzhong.get("rate")),
        },
        "data_note": data_note,
        "updated_at": str(latest_unit_date) if latest_unit_date else _fmt_ts(time.time()),
    }
    _fund_cache[code] = (time.time(), payload)
    store.cache_set(f"payload:fund:v8:{code}", payload)
    return payload


# ------------------------------------------------------------------ screen ---

_screen_flags_cache: dict[str, object] = {"ts": 0, "flags": {}}
_screen_rows_cache: dict[str, object] = {"ts": 0, "sig": None, "rows": None, "types": None}
_holder_map_cache: dict[str, object] = {"ts": 0, "data": {}}


def _holders_latest() -> dict[str, dict]:
    now = time.time()
    if _holder_map_cache["data"] and now - float(_holder_map_cache["ts"]) < 300:
        return _holder_map_cache["data"]
    data = store.holders_latest_map()
    _holder_map_cache["ts"] = now
    _holder_map_cache["data"] = data
    return data


def _screen_rows() -> list[dict]:
    """把基金列表与经理/规模/持有人/4433 标记合并一次，按数据源规模做指纹缓存。"""
    universe = ds.fund_universe()
    manager_map = ds.manager_universe().get("fund_map", {})
    scale_map = ds.fund_scale_map()
    holder_map = _holders_latest()
    flags = _four_flags(universe)
    sig = (len(universe), len(manager_map), len(scale_map), len(holder_map))
    now = time.time()
    if (
        _screen_rows_cache["rows"] is not None
        and _screen_rows_cache["sig"] == sig
        and now - float(_screen_rows_cache["ts"]) < 300
    ):
        return _screen_rows_cache["rows"]

    today = date.today()
    rows = []
    for base in universe:
        code = base["code"]
        manager = manager_map.get(code) or {}
        scale_info = scale_map.get(code) or {}
        holder = holder_map.get(code) or {}
        est = scale_info.get("established")
        est_years = None
        if est and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(est)):
            est_years = round((today - date.fromisoformat(str(est))).days / 365.25, 1)
        rows.append(
            {
                **base,
                "manager_years": manager.get("manager_years"),
                "manager_aum": manager.get("manager_aum"),
                "managers": manager.get("managers") or [],
                "scale": scale_info.get("scale"),
                "established": est,
                "established_years": est_years,
                "institution": holder.get("institution"),
                "internal": holder.get("internal"),
                "holder_date": holder.get("date"),
                "holder_covered": bool(holder),
                "four": bool(flags.get(code)),
            }
        )
    type_counts: dict[str, int] = {}
    for row in universe:
        key = row.get("type") or "其他"
        type_counts[key] = type_counts.get(key, 0) + 1
    _screen_rows_cache.update(
        ts=now,
        sig=sig,
        rows=rows,
        types=sorted(type_counts.items(), key=lambda x: x[1], reverse=True)[:40],
    )
    return rows


def _four_flags(universe: list[dict]) -> dict[str, bool]:
    now = time.time()
    if now - float(_screen_flags_cache["ts"]) < 3600 and _screen_flags_cache["flags"]:
        return _screen_flags_cache["flags"]
    by_type: dict[str, list[dict]] = {}
    for row in universe:
        by_type.setdefault(row.get("type") or "其他", []).append(row)
    flags: dict[str, bool] = {}
    for ftype, rows in by_type.items():
        if len(rows) < 30:
            continue
        thresholds = {}
        for key in ("r1y", "r2y", "r3y", "ytd"):
            values = [r[key] for r in rows if r.get(key) is not None]
            if len(values) < 20:
                thresholds[key] = None
            else:
                values.sort()
                thresholds[key] = values[int(len(values) * 0.75)]
        for row in rows:
            ok = True
            for key in ("r1y", "r2y", "r3y", "ytd"):
                threshold = thresholds.get(key)
                value = row.get(key)
                if threshold is None or value is None or value < threshold:
                    ok = False
                    break
            flags[row["code"]] = ok
    _screen_flags_cache["ts"] = now
    _screen_flags_cache["flags"] = flags
    return flags


_screen_payload_cache: dict[str, tuple[float, dict]] = {}


def _screen_cache_key(params: dict) -> str:
    return "|".join(f"{k}={v}" for k, v in sorted(params.items()))


def screen_payload(params: dict) -> dict:
    cache_key = _screen_cache_key(params)
    cached = _screen_payload_cache.get(cache_key)
    if cached and time.time() - cached[0] < 30:
        return cached[1]
    universe = ds.fund_universe()
    q = str(params.get("q") or "").strip().lower()
    ftype = str(params.get("type") or "").strip()
    category = str(params.get("category") or "").strip()
    company = str(params.get("company") or "").strip()
    rating_min = params.get("rating")
    fee_max = params.get("fee_max")
    r1y_min = params.get("r1y_min")
    r3y_min = params.get("r3y_min")
    ytd_min = params.get("ytd_min")
    inst_min = params.get("inst_min")
    inst_max = params.get("inst_max")
    internal_min = params.get("internal_min")
    scale_min = params.get("scale_min")
    scale_max = params.get("scale_max")
    manager_years_min = params.get("manager_years_min")
    manager_aum_min = params.get("manager_aum_min")
    established_years_min = params.get("established_years_min")
    only_4433 = str(params.get("four") or "") in ("1", "true", "on")
    holder_only = str(params.get("holder_only") or "") in ("1", "true", "on")

    manager_map = ds.manager_universe().get("fund_map", {})
    scale_map = ds.fund_scale_map()
    holder_map = _holders_latest()

    rows = []
    for row in _screen_rows():
        if q and q not in code and q not in str(row.get("name") or "").lower() and q not in str(row.get("manager") or "").lower() and q not in str(row.get("company") or "").lower():
            continue
        if ftype and row.get("type") != ftype:
            continue
        if category and row.get("category") != category:
            continue
        if company and company not in str(row.get("company") or ""):
            continue
        if rating_min not in (None, "") and (row.get("rating_max") or 0) < float(rating_min):
            continue
        if fee_max not in (None, "") and (row.get("fee") is None or row["fee"] > float(fee_max)):
            continue
        if r1y_min not in (None, "") and (row.get("r1y") is None or row["r1y"] < float(r1y_min)):
            continue
        if r3y_min not in (None, "") and (row.get("r3y") is None or row["r3y"] < float(r3y_min)):
            continue
        if ytd_min not in (None, "") and (row.get("ytd") is None or row["ytd"] < float(ytd_min)):
            continue
        if only_4433 and not row["four"]:
            continue
        if holder_only and not row["holder_covered"]:
            continue
        if inst_min not in (None, "") and (row.get("institution") is None or row["institution"] < float(inst_min)):
            continue
        if inst_max not in (None, "") and (row.get("institution") is None or row["institution"] > float(inst_max)):
            continue
        if internal_min not in (None, "") and (row.get("internal") is None or row["internal"] < float(internal_min)):
            continue
        if scale_min not in (None, "") and (row.get("scale") is None or row["scale"] < float(scale_min)):
            continue
        if scale_max not in (None, "") and (row.get("scale") is None or row["scale"] > float(scale_max)):
            continue
        if manager_years_min not in (None, "") and (row.get("manager_years") is None or row["manager_years"] < float(manager_years_min)):
            continue
        if manager_aum_min not in (None, "") and (row.get("manager_aum") is None or row["manager_aum"] < float(manager_aum_min)):
            continue
        if established_years_min not in (None, "") and (row.get("established_years") is None or row["established_years"] < float(established_years_min)):
            continue
        rows.append(row)

    sort_key = str(params.get("sort") or "r1y")
    allowed = {
        "r1y", "r2y", "r3y", "ytd", "r1m", "r3m", "r6m", "fee",
        "rating_max", "five_star", "day_pct", "code", "since",
        "institution", "internal", "scale", "manager_years", "manager_aum",
        "established_years",
    }
    if sort_key not in allowed:
        sort_key = "r1y"
    order = str(params.get("order") or "desc")
    if sort_key == "code":
        rows.sort(key=lambda x: x["code"], reverse=(order == "desc"))
    elif order == "asc":
        rows.sort(
            key=lambda x: (
                x.get(sort_key) is None,
                x.get(sort_key) if x.get(sort_key) is not None else 0,
            )
        )
    else:
        rows.sort(key=lambda x: (x.get(sort_key) is None, -(x.get(sort_key) or 0)))

    total = len(rows)
    page = max(int(params.get("page") or 1), 1)
    page_size = min(max(int(params.get("page_size") or 25), 1), 100)
    start = (page - 1) * page_size
    page_rows = rows[start : start + page_size]

    r1y_values = [r["r1y"] for r in rows if r.get("r1y") is not None]
    fee_values = [r["fee"] for r in rows if r.get("fee") is not None]
    scale_values = [r["scale"] for r in rows if r.get("scale") is not None]
    inst_values = [r["institution"] for r in rows if r.get("institution") is not None]
    types = _screen_rows_cache["types"] or []

    payload = {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": page_rows,
        "stats": {
            "median_r1y": _num(sorted(r1y_values)[len(r1y_values) // 2], 2) if r1y_values else None,
            "median_fee": _num(sorted(fee_values)[len(fee_values) // 2], 3) if fee_values else None,
            "rated": sum(1 for r in rows if (r.get("rating_max") or 0) >= 4),
            "four_count": sum(1 for r in rows if r.get("four")),
            "holder_filtered": sum(1 for r in rows if r.get("holder_covered")),
            "median_scale": _num(sorted(scale_values)[len(scale_values) // 2], 2) if scale_values else None,
            "median_institution": _num(sorted(inst_values)[len(inst_values) // 2], 2) if inst_values else None,
            "high_institution": sum(1 for r in rows if (r.get("institution") or 0) >= 30),
        },
        "coverage": {
            "universe": len(universe),
            "holders": len(holder_map),
            "scales": len(scale_map),
            "managers": len(manager_map),
        },
        "facets": {
            "types": [{"name": n, "count": c} for n, c in types],
        },
        "sort": sort_key,
        "order": order,
    }
    if len(_screen_payload_cache) > 64:
        _screen_payload_cache.clear()
    _screen_payload_cache[cache_key] = (time.time(), payload)
    return payload


# --------------------------------------------------------------- portfolio ---

def _load_fund_bundle(code: str) -> dict:
    pingzhong = ds.fund_pingzhong(code)
    series = an.nav_series(pingzhong)
    history = ds.fund_holdings(code)
    latest = history[0] if history else None
    meta = ds.universe_map().get(code) or {}
    return {
        "code": code,
        "name": meta.get("name") or pingzhong.get("name"),
        "type": meta.get("type"),
        "category": meta.get("category"),
        "fee": meta.get("fee"),
        "series": series,
        "holdings": latest,
    }


def portfolio_payload(items: list[dict], span: str = "3y") -> dict:
    if not items:
        raise ValueError("请至少选择一只基金")
    if len(items) > 8:
        raise ValueError("最多支持 8 只基金")
    weights: dict[str, float] = {}
    for item in items:
        code = str(item.get("code") or "").zfill(6)
        weight = float(item.get("weight") or 0)
        if not code or weight <= 0:
            continue
        weights[code] = weights.get(code, 0) + weight
    if not weights:
        raise ValueError("基金权重需大于 0")

    bundles = []
    warnings = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {code: pool.submit(_load_fund_bundle, code) for code in weights}
        for code, future in futures.items():
            try:
                bundle = future.result()
                bundle["weight"] = weights[code]
                bundles.append(bundle)
                if not bundle["holdings"]:
                    warnings.append(f"{bundle['name']} 暂无股票持仓数据（可能为债券 / 货币 / ETF 联接基金）")
            except Exception as exc:
                warnings.append(f"{code} 加载失败：{exc}")
    if not bundles:
        raise ValueError("所选基金均无法加载")

    total_w = sum(b["weight"] for b in bundles)
    for b in bundles:
        b["weight_norm"] = b["weight"] / total_w * 100

    nav_bundles = [b for b in bundles if b["series"]]
    if len(nav_bundles) < len(bundles):
        skipped = [b["name"] for b in bundles if not b["series"]]
        warnings.append(f"以下基金无累计净值序列，未计入组合曲线与相关性：{'、'.join(skipped)}")
    nav_map = {b["code"]: b["series"] for b in nav_bundles}
    corr = an.correlation(nav_map, span) if len(nav_map) >= 2 else {
        "codes": list(nav_map),
        "matrix": [],
        "note": "需要至少两只具有净值序列的基金才能计算相关性",
    }
    holdings_map = {
        b["code"]: (b["holdings"]["stocks"] if b["holdings"] else [])
        for b in bundles
        if b["holdings"]
    }
    overlap = an.overlap_matrix(holdings_map) if len(holdings_map) >= 2 else {"codes": [], "matrix": []}
    holdings_weighted = [
        {
            "code": b["code"],
            "name": b["name"],
            "weight": b["weight_norm"],
            "holdings": b["holdings"]["stocks"] if b["holdings"] else [],
        }
        for b in bundles
    ]
    merged = an.portfolio_holdings(holdings_weighted)
    quotes = ds.stock_quotes([s["code"] for s in merged["stocks"]])
    for stock in merged["stocks"]:
        quote = quotes.get(stock["code"]) or {}
        stock["industry"] = quote.get("industry_l2") or quote.get("industry") or "未分类"
        stock["industry_l1"] = quote.get("industry") or "未分类"
        stock["pe"] = _num(quote.get("pe"), 1)
        stock["mktcap"] = _num((quote.get("mktcap") or 0) / 1e8, 0) if quote.get("mktcap") else None

    industry = an.industry_distribution(merged["stocks"], quotes)
    caps = an.cap_distribution(merged["stocks"], quotes)
    combined = an.combined_series(
        nav_map,
        {b["code"]: b["weight"] for b in nav_bundles},
        span,
    ) if nav_map else {"points": [], "metrics": an.metrics([])}

    fund_rows = []
    for b in bundles:
        m = an.metrics(an.slice_range(b["series"], span))
        ranged = an.slice_range(b["series"], span)
        base = ranged[0][1] if ranged else 1
        curve = [
            [day, _num(value / base * 100, 2)]
            for day, value in an.downsample(ranged, 900)
        ] if ranged else []
        fund_rows.append(
            {
                "code": b["code"],
                "name": b["name"],
                "type": b["type"],
                "weight": _num(b["weight_norm"], 2),
                "fee": b["fee"],
                "return": m["total_return"],
                "annual_return": m["annual_return"],
                "sharpe": m["sharpe"],
                "max_drawdown": m["max_drawdown"],
                "calmar": m["calmar"],
                "volatility": m["volatility"],
                "holdings_quarter": b["holdings"]["quarter"] if b["holdings"] else None,
                "holdings_count": len(b["holdings"]["stocks"]) if b["holdings"] else 0,
                "series": curve,
            }
        )

    codes = corr.get("codes") or []
    name_by_code = {b["code"]: b["name"] for b in bundles}
    corr_names = [name_by_code.get(c, c) for c in codes]
    corr_max = None
    matrix = corr.get("matrix") or []
    for i in range(len(matrix)):
        for j in range(i + 1, len(matrix)):
            value = matrix[i][j]
            if value is not None:
                corr_max = value if corr_max is None else max(corr_max, value)

    overlap_pairs = []
    if overlap.get("matrix"):
        ocodes = overlap["codes"]
        for i in range(len(ocodes)):
            for j in range(i + 1, len(ocodes)):
                overlap_pairs.append(
                    {
                        "a": ocodes[i],
                        "b": ocodes[j],
                        "a_name": name_by_code.get(ocodes[i], ocodes[i]),
                        "b_name": name_by_code.get(ocodes[j], ocodes[j]),
                        "score": overlap["matrix"][i][j],
                    }
                )
        overlap_pairs.sort(key=lambda x: x["score"] or 0, reverse=True)

    weighted_fee = None
    fee_items = [b["fee"] for b in bundles if b.get("fee") is not None]
    if fee_items:
        weighted_fee = sum(
            (b.get("fee") or 0) * b["weight_norm"] / 100 for b in bundles if b.get("fee") is not None
        ) / max(sum(b["weight_norm"] for b in bundles if b.get("fee") is not None) / 100, 0.01)

    insights = an.portfolio_insights(
        overlap_pairs,
        corr_max,
        industry[0] if industry else None,
        weighted_fee,
        merged["total_weight"],
    )

    latest_quarters = {b["holdings"]["quarter"] for b in bundles if b["holdings"]}
    if len(latest_quarters) > 1:
        warnings.append("所选基金的最新持仓报告期不一致，穿透结果可能混用季度。")

    backtest = an.portfolio_backtest(
        nav_map,
        {b["code"]: b["weight"] for b in nav_bundles},
        span,
        ds.benchmark_series(),
    ) if nav_map else {
        "strategies": {},
        "benchmark": None,
        "contributions": [],
        "note": "所选基金没有可回测的累计净值序列",
    }

    return {
        "span": span,
        "funds": fund_rows,
        "combined": {
            "series": combined["points"],
            "metrics": combined["metrics"],
        },
        "correlation": {
            "codes": codes,
            "names": corr_names,
            "matrix": corr.get("matrix") or [],
            "note": corr.get("note"),
            "days": corr.get("days"),
            "max": corr_max,
        },
        "overlap": {
            "codes": overlap.get("codes") or [],
            "names": [name_by_code.get(c, c) for c in (overlap.get("codes") or [])],
            "matrix": overlap.get("matrix") or [],
            "pairs": overlap_pairs,
        },
        "holdings": merged,
        "industry": industry,
        "cap": caps,
        "weighted_fee": _num(weighted_fee, 3),
        "insights": insights,
        "warnings": warnings,
        "coverage_note": "穿透敞口基于各基金前十大重仓股，覆盖率有限。",
        "backtest": backtest,
    }


# ----------------------------------------------------------------- managers ---

_manager_payload_cache: dict[str, tuple[float, dict]] = {}


def _fund_base_name(name: str) -> str:
    text = str(name or "").strip()
    text = re.sub(r"[（(](?:LOF|QDII|FOF|ETF)[）)]", "", text, flags=re.I)
    text = re.sub(r"(?:A类|C类|D类|E类|I类|H类|[A-Z])$", "", text)
    return re.sub(r"\s+", "", text)


_managers_cache: dict[str, object] = {"ts": 0, "sig": None, "rows": []}


def _enriched_managers() -> list[dict]:
    managers = ds.manager_universe().get("managers") or []
    universe = ds.universe_map()
    scale_map = ds.fund_scale_map()
    sig = (len(managers), len(universe), len(scale_map))
    now = time.time()
    if (
        _managers_cache["rows"]
        and _managers_cache["sig"] == sig
        and now - float(_managers_cache["ts"]) < 300
    ):
        return _managers_cache["rows"]
    equity_categories = {"股票型", "混合型", "指数型", "QDII", "FOF"}
    enriched = []
    for manager in managers:
        equity_aum = 0.0
        equity_count = 0
        for code in manager.get("fund_codes") or []:
            meta = universe.get(code) or {}
            if meta.get("category") in equity_categories:
                equity_count += 1
                equity_aum += (scale_map.get(code) or {}).get("scale") or 0
        product_names = {
            _fund_base_name(name) for name in (manager.get("fund_names") or []) if name
        }
        enriched.append(
            {
                **manager,
                "equity_aum": round(equity_aum, 2),
                "equity_fund_count": equity_count,
                "product_count": len(product_names),
            }
        )
    _managers_cache.update(ts=now, sig=sig, rows=enriched)
    return enriched


def managers_payload(query: str = "", limit: int = 30, sort: str = "best") -> dict:
    managers = _enriched_managers()
    q = (query or "").strip().lower()
    if q:
        managers = [
            m
            for m in managers
            if q in str(m.get("name") or "").lower()
            or q in str(m.get("company") or "").lower()
        ]
    enriched = list(managers)
    if sort == "aum":
        enriched.sort(key=lambda m: (m.get("equity_aum") or 0, m.get("aum") or 0), reverse=True)
    elif sort == "years":
        enriched.sort(key=lambda m: (m.get("years") or 0, m.get("equity_aum") or 0), reverse=True)
    else:
        enriched.sort(
            key=lambda m: (
                m.get("best_return") is not None,
                m.get("best_return") or 0,
                m.get("equity_aum") or 0,
            ),
            reverse=True,
        )
    limit = min(max(int(limit or 30), 1), 100)
    rows = []
    for manager in enriched[:limit]:
        top = [
            {"code": code, "name": name}
            for code, name in list(zip(manager.get("fund_codes") or [], manager.get("fund_names") or []))[:3]
        ]
        rows.append(
            {
                "name": manager.get("name"),
                "company": manager.get("company"),
                "years": manager.get("years"),
                "aum": _num(manager.get("aum"), 2),
                "equity_aum": _num(manager.get("equity_aum"), 2),
                "equity_fund_count": manager.get("equity_fund_count"),
                "fund_count": manager.get("fund_count"),
                "product_count": manager.get("product_count"),
                "best_return": _num(manager.get("best_return"), 2),
                "top_funds": top,
            }
        )
    return {"managers": rows, "total": len(managers)}


def manager_payload(name: str, company: str | None = None) -> dict:
    cache_key = f"payload:manager:v5:{name}:{company or ''}"
    cached = _manager_payload_cache.get(cache_key)
    if cached and time.time() - cached[0] < 1800:
        return cached[1]
    stored = store.cache_get(cache_key, 3600)
    if stored:
        _manager_payload_cache[cache_key] = (time.time(), stored)
        return stored

    data = ds.manager_universe()
    matches = [
        m
        for m in data.get("managers") or []
        if m.get("name") == name and (not company or m.get("company") == company)
    ]
    if not matches:
        raise ds.NotFoundError(f"未找到基金经理 {name}")
    primary = max(matches, key=lambda m: m.get("aum") or 0)
    universe = ds.universe_map()
    scale_map = ds.fund_scale_map()

    funds = []
    seen = set()
    for code, fund_name in zip(primary.get("fund_codes") or [], primary.get("fund_names") or []):
        if code in seen:
            continue
        seen.add(code)
        meta = universe.get(code) or {}
        scale = (scale_map.get(code) or {}).get("scale")
        funds.append(
            {
                "code": code,
                "name": meta.get("name") or fund_name,
                "type": meta.get("type"),
                "r1y": meta.get("r1y"),
                "r3y": meta.get("r3y"),
                "fee": meta.get("fee"),
                "rating_max": meta.get("rating_max"),
                "scale": scale,
            }
        )
    funds.sort(
        key=lambda x: (x.get("scale") is None, -(x.get("scale") or 0), -(x.get("r1y") or -999))
    )
    deduped = {}
    for fund in funds:
        base = _fund_base_name(fund["name"])
        existing = deduped.get(base)
        if existing is None or (fund.get("scale") or 0) > (existing.get("scale") or 0):
            deduped[base] = fund
    funds = sorted(
        deduped.values(),
        key=lambda x: (x.get("scale") is None, -(x.get("scale") or 0), -(x.get("r1y") or -999)),
    )

    loaded = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            code: pool.submit(fund_payload, code)
            for code in [f["code"] for f in funds[:4]]
        }
        for code, future in futures.items():
            try:
                loaded.append(future.result())
            except Exception:
                continue

    holdings_map = {}
    for payload in loaded:
        if payload["holdings"]["latest"]:
            holdings_map[payload["code"]] = payload["holdings"]["latest"]["stocks"]

    full_series: dict[str, list] = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {p["code"]: pool.submit(ds.fund_pingzhong, p["code"]) for p in loaded}
        for code, future in futures.items():
            try:
                full_series[code] = an.nav_series(future.result())
            except Exception:
                continue
    nav_map = {code: points for code, points in full_series.items() if points}

    combined = an.combined_series(nav_map, {code: 1 for code in nav_map}, "3y") if nav_map else {
        "points": [],
        "metrics": an.metrics([]),
    }
    corr = an.correlation(nav_map, "3y") if len(nav_map) >= 2 else {
        "codes": list(nav_map),
        "matrix": [],
        "note": "需要至少两只具有净值序列的产品",
    }
    overlap = an.overlap_matrix(holdings_map) if len(holdings_map) >= 2 else {
        "codes": [],
        "matrix": [],
    }

    merged: dict[str, dict] = {}
    cap_quotes: dict[str, dict] = {}
    for payload in loaded:
        latest = payload["holdings"]["latest"]
        if not latest:
            continue
        weight = 1 / max(len(loaded), 1)
        for stock in latest["stocks"]:
            entry = merged.setdefault(
                stock["code"],
                {"code": stock["code"], "name": stock["name"], "industry": stock.get("industry"), "weight": 0.0},
            )
            entry["weight"] += weight * stock["weight"]
            cap_quotes[stock["code"]] = {"mktcap": stock.get("mktcap"), "industry": stock.get("industry")}
    merged_stocks = sorted(merged.values(), key=lambda x: x["weight"], reverse=True)
    industry = an.industry_distribution(merged_stocks, {}, "weight") if merged_stocks else []
    industry = [item for item in industry if item["name"] != "未分类"]
    industry_total = sum(item["share"] or 0 for item in industry)
    if industry_total:
        industry = [{**item, "share": _num((item["share"] or 0) / industry_total * 100, 2)} for item in industry]
    caps = an.cap_distribution(merged_stocks, cap_quotes, "weight") if merged_stocks else []

    def avg(values):
        clean = [v for v in values if v is not None]
        return _num(sum(clean) / len(clean), 2) if clean else None

    style = {
        "top10_weight": avg([
            p["holdings"]["latest"]["top10_weight"]
            for p in loaded
            if p["holdings"]["latest"]
        ]),
        "retention": avg([
            p["holdings"]["change"].get("retention")
            for p in loaded
            if p["holdings"]["change"]
        ]),
        "institution": avg([
            p["holder_analysis"]["latest"]["institution"]
            for p in loaded
            if p.get("holder_analysis")
        ]),
        "internal": avg([
            p["holder_analysis"]["latest"]["internal"]
            for p in loaded
            if p.get("holder_analysis")
        ]),
    }

    manager_rows = []
    by_code = {p["code"]: p for p in loaded}
    for fund in funds[:10]:
        payload = by_code.get(fund["code"])
        curve = []
        if payload and full_series.get(fund["code"]):
            ranged = an.slice_range(full_series[fund["code"]], "3y")
            base = ranged[0][1] if ranged else 1
            curve = [
                [day, _num(value / base * 100, 2)]
                for day, value in an.downsample(ranged, 700)
            ]
        manager_rows.append(
            {
                **fund,
                "loaded": payload is not None,
                "annual_return": payload["metrics"]["3y"]["annual_return"] if payload else None,
                "sharpe": payload["metrics"]["1y"]["sharpe"] if payload else None,
                "max_drawdown": payload["metrics"]["1y"]["max_drawdown"] if payload else None,
                "holdings_quarter": payload["holdings"]["latest"]["quarter"] if payload and payload["holdings"]["latest"] else None,
                "top10_weight": payload["holdings"]["latest"]["top10_weight"] if payload and payload["holdings"]["latest"] else None,
                "series": curve,
            }
        )

    name_by_code = {f["code"]: f["name"] for f in funds}
    pairs = []
    if overlap.get("matrix"):
        codes = overlap["codes"]
        for i in range(len(codes)):
            for j in range(i + 1, len(codes)):
                pairs.append(
                    {
                        "a_name": name_by_code.get(codes[i], codes[i]),
                        "b_name": name_by_code.get(codes[j], codes[j]),
                        "score": overlap["matrix"][i][j],
                    }
                )
        pairs.sort(key=lambda x: x["score"] or 0, reverse=True)

    insights = []
    returns = [f.get("r1y") for f in funds if f.get("r1y") is not None]
    if len(returns) >= 2:
        spread = max(returns) - min(returns)
        if spread >= 30:
            insights.append({"level": "info", "title": "在管产品业绩分化", "text": f"同经理在管产品近一年收益最大相差 {spread:.1f} 个百分点，需关注产品策略与仓位差异。"})
    if pairs and pairs[0]["score"] >= 20:
        insights.append({"level": "warn", "title": "在管产品重仓重叠", "text": f"{pairs[0]['a_name']} 与 {pairs[0]['b_name']} 的前十大重叠约 {pairs[0]['score']:.1f}%，产品间差异可能有限。"})
    if industry and industry[0]["share"] >= 40:
        insights.append({"level": "warn", "title": "行业暴露集中", "text": f"在管产品合并后第一大行业「{industry[0]['name']}」占已披露重仓敞口 {industry[0]['share']:.1f}%。"})
    if primary.get("years") is not None:
        insights.append({"level": "info", "title": "从业年限", "text": f"累计从业约 {primary['years']:.1f} 年，管理 {primary.get('fund_count')} 只基金，在管规模约 {primary.get('aum') or 0:.1f} 亿元。"})
    if style.get("top10_weight") is not None:
        insights.append({"level": "info", "title": "持仓集中度", "text": f"在管产品前十大重仓平均占净值 {style['top10_weight']:.1f}%，重仓留存度均值 {style.get('retention') if style.get('retention') is not None else '—'}%。"})

    power = None
    for payload in loaded:
        for manager in payload.get("managers") or []:
            if manager.get("name") == name:
                power = manager
                break
        if power:
            break

    report_fund = next((f for f in funds if f.get("scale")), funds[0] if funds else None)
    report_tenure = None
    if report_fund:
        report_payload = by_code.get(report_fund["code"])
        if report_payload:
            report_tenure = next(
                (
                    tenure
                    for tenure in report_payload.get("manager_tenures") or []
                    if tenure.get("current") and name in str(tenure.get("manager") or "").split()
                ),
                None,
            )
    payload = {
        "name": primary.get("name"),
        "company": primary.get("company"),
        "years": _num(primary.get("years"), 2),
        "aum": _num(primary.get("aum"), 2),
        "best_return": _num(primary.get("best_return"), 2),
        "fund_count": primary.get("fund_count"),
        "product_count": len(funds),
        "matches": [{"name": m["name"], "company": m["company"], "aum": m.get("aum")} for m in matches],
        "funds": manager_rows,
        "combined": {"series": combined["points"], "metrics": combined["metrics"]},
        "correlation": {**corr, "names": [name_by_code.get(c, c) for c in corr.get("codes") or []], "max": max([v for row in corr.get("matrix") or [] for v in row if v is not None and v < 1] or [None]) if corr.get("matrix") else None},
        "overlap": {**overlap, "names": [name_by_code.get(c, c) for c in overlap.get("codes") or []], "pairs": pairs},
        "industry": industry,
        "cap": caps,
        "style": style,
        "insights": insights,
        "power": power,
        "report_fund": {
            "code": report_fund["code"],
            "name": report_fund["name"],
            "tenure": report_tenure,
        } if report_fund else None,
        "updated_at": _fmt_ts(time.time()),
    }
    _manager_payload_cache[cache_key] = (time.time(), payload)
    store.cache_set(cache_key, payload)
    return payload


# ------------------------------------------------------------------ stocks ---

def stocks_payload(quarter: str, params: dict) -> dict:
    q = str(params.get("q") or "").strip().lower()
    industry_filter = str(params.get("industry") or "").strip()
    sort_key = str(params.get("sort") or "fund_count")
    order = str(params.get("order") or "desc").lower()
    if order not in ("asc", "desc"):
        order = "desc"
    try:
        limit = int(params.get("limit") or 200)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 应为整数") from exc
    limit = min(max(limit, 20), 500)
    cache_key = (
        f"payload:stocks:v15:{quarter}:{limit}:{q}:{industry_filter}:"
        f"{sort_key}:{order}"
    )
    cached = store.cache_get(cache_key, 1800)
    if cached:
        return cached

    rows = top10.quarter_rows(quarter)
    prev_q = ds.prev_quarter(quarter)
    prev_map = {r["code"]: r for r in top10.quarter_rows(prev_q)}
    prev_available = bool(prev_map)
    rank = _rank_map(rows)

    universe_codes = [r["code"] for r in rows[:900]]
    if q:
        matched_codes = [
            r["code"]
            for r in rows
            if q in r["code"] or q in (r.get("name") or "").lower()
        ][:200]
        universe_codes = list(dict.fromkeys(universe_codes + matched_codes))
    quotes = ds.stock_quotes(universe_codes)
    if industry_filter:
        cached = ds.stock_quotes_cached(
            [r["code"] for r in rows if r["code"] not in quotes]
        )
        quotes.update(cached)

    enriched = []
    industry_counts: dict[str, int] = {}
    for row in rows:
        quote = quotes.get(row["code"]) or {}
        item = {
            "code": row["code"],
            "name": row["name"],
            "fund_count": row.get("fund_count"),
            "value": _num(row.get("hold_value"), 2),
            "industry": quote.get("industry_l2") or quote.get("industry") or "未分类",
            "industry_l1": quote.get("industry") or "未分类",
            "industry_l2": quote.get("industry_l2") or quote.get("industry") or "未分类",
            "pct": _num(quote.get("pct"), 2),
            "pe": _num(quote.get("pe"), 1),
            "mktcap": _num((quote.get("mktcap") or 0) / 1e8, 0) if quote.get("mktcap") else None,
            "rank": rank.get(row["code"]),
            "fund_count_qoq": None,
            "value_qoq": None,
            "fund_count_delta": None,
            "value_delta": None,
            "fund_count_new": False,
            "value_new": False,
        }
        prev = prev_map.get(row["code"])
        if prev:
            prev_count = prev.get("fund_count")
            prev_value = prev.get("hold_value")
            if prev_count is not None and prev_count >= 10:
                item["fund_count_qoq"] = _num(
                    _pct_change(row.get("fund_count"), prev_count), 1
                )
            if prev_value is not None and prev_value >= 1:
                item["value_qoq"] = _num(
                    _pct_change(row.get("hold_value"), prev_value), 1
                )
            if row.get("fund_count") is not None and prev_count is not None:
                item["fund_count_delta"] = row.get("fund_count") - prev_count
            if row.get("hold_value") is not None and prev_value is not None:
                item["value_delta"] = _num(row.get("hold_value") - prev_value, 2)
        elif prev_available:
            item["fund_count_new"] = True
            item["value_new"] = True
            if row.get("fund_count") is not None:
                item["fund_count_delta"] = row.get("fund_count")
            if row.get("hold_value") is not None:
                item["value_delta"] = _num(row.get("hold_value"), 2)
        if q and q not in item["code"] and q not in (item["name"] or "").lower():
            continue
        industry_counts[item["industry"]] = industry_counts.get(item["industry"], 0) + 1
        if industry_filter and industry_filter not in (
            item["industry"],
            item["industry_l1"],
        ):
            continue
        enriched.append(item)

    metric = {
        "qoq": "fund_count_qoq",
        "fund_count_qoq": "fund_count_qoq",
        "value_qoq": "value_qoq",
        "fund_count_delta": "fund_count_delta",
        "value_delta": "value_delta",
        "value": "value",
        "fund_count": "fund_count",
    }.get(sort_key, "fund_count")

    def sort_value(item):
        value = item.get(metric)
        if value is None:
            return (1, 0)
        numeric = float(value)
        return (0, -numeric if order == "desc" else numeric)

    enriched.sort(key=sort_value)

    industry_list = [
        {"name": n, "count": c}
        for n, c in sorted(industry_counts.items(), key=lambda x: x[1], reverse=True)
        if n != "未分类"
    ][:24]

    payload = {
        "quarter": quarter,
        "as_of": ds.quarter_to_date(quarter),
        "prev_quarter": prev_q if prev_map else None,
        "prev_label": ds.quarter_label(prev_q) if prev_map else None,
        "change_basis": "top10_qoq",
        "disclosure": "top10",
        "sort": metric,
        "order": order,
        "rows": enriched[:limit],
        "total": len(enriched),
        "industries": industry_list,
        "top10_available": bool(rows),
    }
    store.cache_set(cache_key, payload)
    return payload


def stock_payload(code: str, quarter: str | None = None) -> dict:
    cache_key = f"payload:stock:v10:{code}:{quarter or ''}"
    cached = store.cache_get(cache_key, 1800)
    if cached:
        return cached
    requested = quarter or ds.recent_quarters(1)[0]
    quarter_list = [q for q in sorted(ds.recent_quarters(12)) if q <= requested]
    available_top10 = set(top10.available_quarters(12))
    history = []
    by_quarter = {}
    raw_values = {}
    for q in quarter_list:
        rows = top10.quarter_rows(q)
        row = next((r for r in rows if r["code"] == code), None)
        if not row:
            continue
        compare_q = ds.prev_quarter(q)
        previous = by_quarter.get(compare_q)
        previous_value = raw_values.get(compare_q)
        item = {
            "quarter": q,
            "label": ds.quarter_label(q),
            "compare_quarter": compare_q if previous else None,
            "fund_count": row.get("fund_count"),
            "value": _num(row.get("hold_value"), 2),
            "crowding": None,
            "fund_count_qoq": None,
            "value_qoq": None,
            "fund_count_delta": None,
            "value_delta": None,
            "fund_count_new": False,
            "value_new": False,
        }
        if previous:
            previous_count = previous.get("fund_count")
            if previous_count is not None and previous_count >= 10:
                item["fund_count_qoq"] = _num(
                    _pct_change(row.get("fund_count"), previous_count), 1
                )
            if previous_value is not None and previous_value >= 1:
                item["value_qoq"] = _num(
                    _pct_change(row.get("hold_value"), previous_value), 1
                )
            if row.get("fund_count") is not None and previous_count is not None:
                item["fund_count_delta"] = row.get("fund_count") - previous_count
            if row.get("hold_value") is not None and previous_value is not None:
                item["value_delta"] = _num(
                    row.get("hold_value") - previous_value, 2
                )
        elif compare_q in available_top10:
            item["fund_count_new"] = True
            item["value_new"] = True
            if row.get("fund_count") is not None:
                item["fund_count_delta"] = row.get("fund_count")
            if row.get("hold_value") is not None:
                item["value_delta"] = _num(row.get("hold_value"), 2)
        history.append(item)
        by_quarter[q] = item
        raw_values[q] = row.get("hold_value")
    if not history:
        raise ds.NotFoundError("未找到该股票的前十大重仓数据")
    latest_q = history[-1]["quarter"]
    rows = top10.quarter_rows(latest_q)
    total_value = sum((r.get("hold_value") or 0) for r in rows)
    rank_count = _rank_map(rows)
    rank_value = {
        r["code"]: i + 1
        for i, r in enumerate(
            sorted(rows, key=lambda x: x.get("hold_value") or 0, reverse=True)
        )
    }
    latest = next((r for r in rows if r["code"] == code), {})
    top_rows = sorted(rows, key=lambda x: x.get("fund_count") or 0, reverse=True)[:600]
    quotes = ds.stock_quotes(list({code} | {r["code"] for r in top_rows}))
    quote = quotes.get(code) or {}
    industry = quote.get("industry")
    float_cap = (quote.get("float_cap") or 0) / 1e8
    if float_cap > 0:
        for item in history:
            item["crowding"] = _num((item.get("value") or 0) / float_cap * 100, 2)
    prev_q = ds.prev_quarter(latest_q)
    prev_map = {r["code"]: r for r in top10.quarter_rows(prev_q)}
    peers = []
    for r in top_rows:
        peer_quote = quotes.get(r["code"]) or {}
        if industry and peer_quote.get("industry") == industry and r["code"] != code:
            prev = prev_map.get(r["code"]) or {}
            peers.append(
                {
                    "code": r["code"],
                    "name": r["name"],
                    "fund_count": r.get("fund_count"),
                    "fund_count_qoq": _num(
                        _pct_change(r.get("fund_count"), prev.get("fund_count")), 1
                    ) if prev else None,
                    "value": _num(r.get("hold_value"), 2),
                    "pe": _num(peer_quote.get("pe"), 1),
                    "pb": _num(peer_quote.get("pb"), 2),
                }
            )
        if len(peers) >= 6:
            break
    price_raw = an.slice_range(ds.stock_kline(code), "1y")
    price_risk = None
    if len(price_raw) >= 2:
        bench_raw = {str(item[0]): item[1] for item in ds.benchmark_series().get("values") or []}
        bench_dates = [day for day, _ in price_raw if day in bench_raw]
        if bench_dates:
            price_map = {day: value for day, value in price_raw}
            base_price = price_map[bench_dates[0]]
            base_bench = bench_raw[bench_dates[0]]
            stock_points = [
                [day, _num((price_map[day] / base_price - 1) * 100, 2)]
                for day in bench_dates
            ]
            benchmark_points = [
                [day, _num((bench_raw[day] / base_bench - 1) * 100, 2)]
                for day in bench_dates
            ]
        else:
            stock_points = [
                [day, _num((value / price_raw[0][1] - 1) * 100, 2)]
                for day, value in price_raw
            ]
            benchmark_points = []
        price_risk = {
            "start": stock_points[0][0] if stock_points else None,
            "end": stock_points[-1][0] if stock_points else None,
            "dates": [item[0] for item in stock_points],
            "stock": [item[1] for item in stock_points],
            "benchmark": [item[1] for item in benchmark_points],
            "benchmark_name": "沪深300",
            "metrics": an.metrics([[day, 100 + value] for day, value in stock_points]),
            "risk": an.risk_metrics(
                [[day, 100 + value] for day, value in stock_points],
                [[day, 100 + value] for day, value in benchmark_points],
            ) if benchmark_points else an.risk_metrics([], []),
        }
    latest_value = latest.get("hold_value") or 0
    market_share = latest_value / total_value * 100 if total_value else None
    rank_count_value = rank_count.get(code)
    rank_value_value = rank_value.get(code)
    fund_count_qoq = history[-1].get("fund_count_qoq")
    value_qoq = history[-1].get("value_qoq")
    crowding = history[-1].get("crowding")
    insights = []
    if fund_count_qoq is not None:
        if fund_count_qoq <= -20:
            insights.append({"level": "warn", "title": "基金数环比下降", "text": f"较上一季度，持有基金数下降 {abs(fund_count_qoq):.1f}%。"})
        elif fund_count_qoq >= 20:
            insights.append({"level": "good", "title": "基金数环比扩张", "text": f"较上一季度，持有基金数增长 {fund_count_qoq:.1f}%，公募共识仍在扩散。"})
    if value_qoq is not None and fund_count_qoq is not None:
        if fund_count_qoq < 0 and value_qoq > 0:
            insights.append({"level": "info", "title": "数量下降、市值上升", "text": f"前十大基金数环比 {fund_count_qoq:.1f}%，但前十大持仓市值环比 {value_qoq:.1f}%；可能由股价上涨或单只基金加仓驱动。"})
        elif fund_count_qoq > 0 and value_qoq < 0:
            insights.append({"level": "warn", "title": "数量增加、市值下降", "text": f"前十大基金数环比 {fund_count_qoq:.1f}%，但前十大持仓市值环比 {value_qoq:.1f}%；需关注持股分散化或单只基金减仓。"})
    year_start = by_quarter.get(f"{latest_q[:4]}Q1")
    if (
        year_start
        and year_start["quarter"] != latest_q
        and fund_count_qoq is not None
        and fund_count_qoq < 0
    ):
        ytd = _pct_change(latest.get("fund_count"), year_start.get("fund_count"))
        if ytd is not None and ytd > 0:
            insights.append({"level": "info", "title": "较上季度回落、较年初仍扩张", "text": f"前十大基金数环比 {fund_count_qoq:.1f}%，但较年初（Q1）仍增长 {ytd:.1f}%；季度波动不等于中期共识逆转。"})
    if crowding is not None:
        if crowding >= 20:
            insights.append({"level": "warn", "title": "前十大持仓占流通盘较高", "text": f"前十大公募持仓约占流通市值 {crowding:.2f}%（按当前流通市值估算），公募资金定价权较强，同时集中赎回时的流动性风险也更高。"})
        elif crowding <= 5:
            insights.append({"level": "info", "title": "公募定价权有限", "text": f"前十大公募持仓约占流通市值 {crowding:.2f}%（按当前流通市值估算），股价受公募资金进出的直接影响相对有限。"})
    if rank_count_value and rank_count_value <= 20:
        insights.append({"level": "good", "title": "公募重仓排名靠前", "text": f"按前十大持有基金数排名全市场第 {rank_count_value} 位，属于公募重仓核心资产。"})
    if market_share is not None and market_share >= 0.5:
        insights.append({"level": "info", "title": "前十大重仓市值占比高", "text": f"该股占全市场基金前十大重仓总市值的 {market_share:.2f}%，在公募重仓组合中具有较高权重。"})
    payload = {
        "code": code,
        "name": latest.get("name") or quote.get("name"),
        "disclosure": "top10",
        "change_basis": "top10_qoq",
        "requested_quarter": requested,
        "fallback": latest_q != requested,
        "industry": industry or "未分类",
        "industry_l2": quote.get("industry_l2") or industry or "未分类",
        "quote": {
            "price": _num(quote.get("price"), 2),
            "pct": _num(quote.get("pct"), 2),
            "pe": _num(quote.get("pe"), 1),
            "pb": _num(quote.get("pb"), 2),
            "mktcap": _num((quote.get("mktcap") or 0) / 1e8, 0) if quote.get("mktcap") else None,
            "float_cap": _num(float_cap, 0) if float_cap else None,
        },
        "history": history,
        "latest": {
            "quarter": latest_q,
            "fund_count": latest.get("fund_count"),
            "value": _num(latest_value, 2),
            "crowding": _num(crowding, 2),
            "market_share": _num(market_share, 2),
            "rank_count": rank_count_value,
            "rank_count_total": len(rows),
            "rank_count_pct": _num(rank_count_value / len(rows) * 100, 2) if rank_count_value else None,
            "rank_value": rank_value_value,
            "rank_value_total": len(rows),
            "rank_value_pct": _num(rank_value_value / len(rows) * 100, 2) if rank_value_value else None,
            "prev_quarter": history[-1].get("compare_quarter"),
            "prev_label": ds.quarter_label(history[-1].get("compare_quarter")) if history[-1].get("compare_quarter") else None,
            "fund_count_qoq": fund_count_qoq,
            "value_qoq": value_qoq,
            "fund_count_delta": history[-1].get("fund_count_delta") if history else None,
            "value_delta": history[-1].get("value_delta") if history else None,
            "fund_count_new": history[-1].get("fund_count_new") if history else False,
            "value_new": history[-1].get("value_new") if history else False,
        },
        "peers": peers,
        "insights": insights,
        "price_risk": price_risk,
        "total_value": _num(total_value, 2),
    }
    store.cache_set(cache_key, payload)
    return payload


# -------------------------------------------------------------------- meta ---

_meta_cache: dict[str, object] = {"ts": 0.0, "data": None}


def meta_payload() -> dict:
    now = time.time()
    cached = _meta_cache["data"]
    if cached is not None and now - float(_meta_cache["ts"]) < 30:
        return cached
    quarters = ds.recent_quarters(9)
    rows = []
    universe = ds.fund_universe()
    stamps: list[float] = []
    for q in quarters:
        fetched_ts = store.market_quarter_ts(q)
        if fetched_ts:
            stamps.append(fetched_ts)
        rows.append(
            {
                "quarter": q,
                "label": ds.quarter_label(q),
                "as_of": ds.quarter_to_date(q),
                "disclosure": ds.disclosure_kind(q),
                "available": store.market_available(q),
                "top10_available": (
                    ds.disclosure_kind(q) == "top10" and store.market_available(q)
                ) or store.top10_available(q),
                "fetched_at": _fmt_ts(fetched_ts),
            }
        )
    latest_available = next((r for r in rows if r["available"]), rows[0])
    payload = {
        "quarters": rows,
        "latest_quarter": latest_available["quarter"],
        "latest_label": latest_available["label"],
        "fund_total": len(universe),
        "sources": [
            "天天基金（净值 / 持仓 / 规模 / 持有人 / 行业配置 / 评级 / 经理）",
            "东方财富数据中心（全市场基金重仓股聚合）",
            "天天基金移动端（逐基金前十大持仓与季度净资产，用于还原 Q2/Q4 前十大口径）",
            "雪球基金（基金档案 / 业绩诊断）",
            "巨潮资讯（基金行业配置）",
        ],
        "updated_at": _fmt_ts(max(stamps) if stamps else None),
    }
    _meta_cache["ts"] = now
    _meta_cache["data"] = payload
    return payload


def search_payload(query: str) -> dict:
    funds = ds.search_funds(query, 10)
    q = (query or "").strip().lower()
    stocks = []
    if q:
        try:
            latest = top10.available_quarters(1)
            q_now = latest[0] if latest else ds.recent_quarters(1)[0]
            rows = top10.quarter_rows(q_now) if latest else ds.market_quarter(q_now)
            matches = [
                r
                for r in rows
                if q in r["code"] or q in (r.get("name") or "").lower()
            ]
            matches.sort(key=lambda r: r.get("fund_count") or 0, reverse=True)
            quotes = ds.stock_quotes([r["code"] for r in matches[:6]])
            stocks = [
                {
                    "code": r["code"],
                    "name": r["name"],
                    "industry": (quotes.get(r["code"]) or {}).get("industry_l2")
                    or (quotes.get(r["code"]) or {}).get("industry")
                    or "未分类",
                    "fund_count": r.get("fund_count"),
                    "quarter": q_now,
                }
                for r in matches[:6]
            ]
        except Exception:
            stocks = []
    return {"funds": funds, "stocks": stocks}
