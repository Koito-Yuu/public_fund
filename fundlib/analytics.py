"""Pure analytics: NAV metrics, holding changes, portfolio look-through."""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta, timezone

import numpy as np

RISK_FREE = 0.015


def _r(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    if not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def _date(value: str) -> date:
    return date.fromisoformat(value[:10])


def nav_series(pingzhong: dict) -> list[list]:
    ac = pingzhong.get("ac_worth") or []
    points: list[list] = []
    if ac:
        for item in ac:
            try:
                ts, value = item[0], item[1]
            except (TypeError, IndexError):
                continue
            if value is None:
                continue
            day = datetime.fromtimestamp(
                ts / 1000, tz=timezone(timedelta(hours=8))
            ).date().isoformat()
            points.append([day, float(value)])
    if not points:
        for item in pingzhong.get("net_worth") or []:
            try:
                ts, value = item["x"], item["y"]
            except (TypeError, KeyError):
                continue
            if value is None:
                continue
            day = datetime.fromtimestamp(
                ts / 1000, tz=timezone(timedelta(hours=8))
            ).date().isoformat()
            points.append([day, float(value)])
    dedup: dict[str, float] = {}
    for day, value in points:
        if value > 0:
            dedup[day] = value
    return [[d, dedup[d]] for d in sorted(dedup)]


def unit_nav(pingzhong: dict) -> list[list]:
    out = []
    for item in pingzhong.get("net_worth") or []:
        try:
            day = datetime.fromtimestamp(
                item["x"] / 1000, tz=timezone(timedelta(hours=8))
            ).date().isoformat()
            out.append([day, float(item["y"])])
        except (TypeError, KeyError, ValueError):
            continue
    return out


def slice_range(points: list[list], span: str = "all") -> list[list]:
    if not points:
        return []
    end = _date(points[-1][0])
    if span == "ytd":
        start = date(end.year, 1, 1)
    elif span.endswith("y") and span[:-1].isdigit():
        start = end.replace(year=end.year - int(span[:-1]))
    elif span.endswith("m") and span[:-1].isdigit():
        month = end.month - int(span[:-1])
        year = end.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        try:
            start = end.replace(year=year, month=month)
        except ValueError:
            start = date(year, month, 28)
    else:
        return points[:]
    return [p for p in points if _date(p[0]) >= start]


def drawdown_series(points: list[list]) -> list[list]:
    out = []
    peak = None
    for day, value in points:
        peak = value if peak is None or value > peak else peak
        out.append([day, _r((value / peak - 1) * 100, 2) if peak else 0.0])
    return out


def downsample(points: list[list], max_points: int = 1100) -> list[list]:
    if len(points) <= max_points:
        return points
    step = math.ceil(len(points) / max_points)
    sampled = points[::step]
    if sampled[-1] != points[-1]:
        sampled.append(points[-1])
    return sampled


def metrics(points: list[list]) -> dict:
    empty = {
        "total_return": None,
        "annual_return": None,
        "volatility": None,
        "sharpe": None,
        "max_drawdown": None,
        "calmar": None,
        "win_rate": None,
        "days": 0,
        "start": None,
        "end": None,
        "best_day": None,
        "worst_day": None,
    }
    if len(points) < 2:
        return empty
    values = np.array([p[1] for p in points], dtype=float)
    days = (_date(points[-1][0]) - _date(points[0][0])).days
    total = values[-1] / values[0] - 1
    years = max(days / 365.25, 1 / 365.25)
    annual = (values[-1] / values[0]) ** (1 / years) - 1
    returns = values[1:] / values[:-1] - 1
    vol = float(np.std(returns, ddof=1) * math.sqrt(252)) if len(returns) > 2 else None
    sharpe = (annual - RISK_FREE) / vol if vol and vol > 0 else None
    peak = np.maximum.accumulate(values)
    dd = values / peak - 1
    max_dd = float(dd.min())
    calmar = annual / abs(max_dd) if max_dd < 0 else None
    return {
        "total_return": _r(total * 100, 2),
        "annual_return": _r(annual * 100, 2),
        "volatility": _r(vol * 100, 2) if vol is not None else None,
        "sharpe": _r(sharpe, 2),
        "max_drawdown": _r(max_dd * 100, 2),
        "calmar": _r(calmar, 2),
        "win_rate": _r(float((returns > 0).mean()) * 100, 1) if len(returns) else None,
        "days": days,
        "start": points[0][0],
        "end": points[-1][0],
        "best_day": _r(float(returns.max()) * 100, 2) if len(returns) else None,
        "worst_day": _r(float(returns.min()) * 100, 2) if len(returns) else None,
    }


def metrics_bundle(points: list[list]) -> dict:
    return {
        "1y": metrics(slice_range(points, "1y")),
        "3y": metrics(slice_range(points, "3y")),
        "all": metrics(points),
    }


def period_returns(points: list[list]) -> dict:
    if not points:
        return {}
    end_day = _date(points[-1][0])
    end_value = points[-1][1]
    result = {}
    for span, days in (("1m", 30), ("3m", 91), ("6m", 182), ("1y", 365), ("2y", 730), ("3y", 1095)):
        cutoff = end_day - timedelta(days=days)
        candidates = [p for p in points if _date(p[0]) <= cutoff]
        if not candidates:
            result[span] = None
            continue
        base = candidates[-1][1]
        result[span] = _r((end_value / base - 1) * 100, 2)
    ytd = [p for p in points if _date(p[0]) <= date(end_day.year, 1, 1)]
    result["ytd"] = _r((end_value / (ytd[-1][1] if ytd else points[0][1]) - 1) * 100, 2)
    result["since"] = _r((end_value / points[0][1] - 1) * 100, 2)
    return result


def holding_change(latest: list[dict], previous: list[dict]) -> dict:
    now = {s["code"]: s for s in latest}
    old = {s["code"]: s for s in previous}

    def shares_pct(now_s, old_s):
        a = now_s.get("shares_wan")
        b = old_s.get("shares_wan")
        if a is None or b in (None, 0):
            return None
        return _r((a / b - 1) * 100, 2)

    changes = []
    for code in set(now) | set(old):
        a, b = now.get(code), old.get(code)
        wa = a["weight"] if a else 0.0
        wb = b["weight"] if b else 0.0
        if a and not b:
            action = "新进"
        elif b and not a:
            action = "清仓"
        else:
            delta = wa - wb
            action = "加仓" if delta > 0.05 else "减仓" if delta < -0.05 else "不变"
        changes.append(
            {
                "code": code,
                "name": (a or b)["name"],
                "action": action,
                "weight_now": _r(wa, 3),
                "weight_prev": _r(wb, 3),
                "weight_delta": _r(wa - wb, 3),
                "shares_delta_pct": shares_pct(a, b) if a and b else None,
                "value_wan": _r(a.get("value_wan"), 1) if a else None,
            }
        )
    order = {"新进": 0, "加仓": 1, "减仓": 2, "清仓": 3, "不变": 4}
    changes.sort(key=lambda x: (order[x["action"]], -abs(x["weight_delta"] or 0)))
    common = set(now) & set(old)
    prev_weight = sum(s["weight"] for s in old.values())
    kept_weight = sum(now[c]["weight"] for c in common)
    return {
        "items": changes,
        "new_count": sum(1 for c in changes if c["action"] == "新进"),
        "exit_count": sum(1 for c in changes if c["action"] == "清仓"),
        "retention": _r(len(common) / len(old) * 100, 1) if old else None,
        "retained_weight_share": _r(kept_weight / prev_weight * 100, 1) if prev_weight else None,
    }


def portfolio_holdings(items: list[dict]) -> dict:
    total_weight = sum(max(i.get("weight") or 0, 0) for i in items) or 100.0
    merged: dict[str, dict] = {}
    for item in items:
        fund_weight = max(item.get("weight") or 0, 0) / total_weight
        for stock in item.get("holdings") or []:
            row = merged.setdefault(
                stock["code"],
                {
                    "code": stock["code"],
                    "name": stock["name"],
                    "weight": 0.0,
                    "funds": [],
                },
            )
            row["weight"] += fund_weight * stock["weight"]
            row["funds"].append(item["name"])
    stocks = []
    for row in merged.values():
        row["weight"] = _r(row["weight"], 3)
        row["fund_count"] = len(row["funds"])
        stocks.append(row)
    stocks.sort(key=lambda x: x["weight"] or 0, reverse=True)
    return {"stocks": stocks[:30], "total_weight": _r(sum(s["weight"] for s in stocks), 2)}


def industry_distribution(stocks: list[dict], quotes: dict[str, dict], weight_key: str = "weight") -> list[dict]:
    buckets: dict[str, float] = {}
    for stock in stocks:
        quote = quotes.get(stock["code"]) or {}
        name = stock.get("industry") or quote.get("industry") or "未分类"
        buckets[name] = buckets.get(name, 0) + (stock.get(weight_key) or 0)
    total = sum(buckets.values()) or 1.0
    out = [
        {"name": name, "value": _r(value, 3), "share": _r(value / total * 100, 2)}
        for name, value in buckets.items()
    ]
    out.sort(key=lambda x: x["value"] or 0, reverse=True)
    return out


def cap_distribution(stocks: list[dict], quotes: dict[str, dict], weight_key: str = "weight") -> list[dict]:
    buckets = {"大盘（>1000亿）": 0.0, "中盘（300–1000亿）": 0.0, "小盘（<300亿）": 0.0, "未知": 0.0}
    for stock in stocks:
        cap = (quotes.get(stock["code"]) or {}).get("mktcap")
        weight = stock.get(weight_key) or 0
        if cap is None:
            buckets["未知"] += weight
        elif cap >= 1000e8:
            buckets["大盘（>1000亿）"] += weight
        elif cap >= 300e8:
            buckets["中盘（300–1000亿）"] += weight
        else:
            buckets["小盘（<300亿）"] += weight
    total = sum(buckets.values()) or 1.0
    return [
        {"name": k, "value": _r(v, 3), "share": _r(v / total * 100, 2)}
        for k, v in buckets.items()
        if v > 0
    ]


def correlation(nav_map: dict[str, list[list]], span: str = "3y") -> dict:
    codes = list(nav_map)
    series = {c: dict(slice_range(nav_map[c], span)) for c in codes}
    common = set(series[codes[0]]) if codes else set()
    for c in codes[1:]:
        common &= set(series[c])
    dates = sorted(common)
    if len(dates) < 30:
        return {"codes": codes, "matrix": [], "note": "共同交易日不足，无法计算相关性"}
    rets = {}
    for c in codes:
        values = [series[c][d] for d in dates]
        rets[c] = np.diff(values) / np.array(values[:-1])
    matrix = np.corrcoef(np.array([rets[c] for c in codes]))
    return {
        "codes": codes,
        "matrix": [[_r(v, 3) for v in row] for row in matrix],
        "note": None,
        "days": len(dates),
    }


def overlap_matrix(holdings_map: dict[str, list[dict]]) -> dict:
    codes = list(holdings_map)
    matrix = []
    for a in codes:
        row = []
        for b in codes:
            ma = {s["code"]: s["weight"] for s in holdings_map[a]}
            mb = {s["code"]: s["weight"] for s in holdings_map[b]}
            common = set(ma) & set(mb)
            score = sum(min(ma[c], mb[c]) for c in common)
            row.append(_r(score, 2))
        matrix.append(row)
    return {"codes": codes, "matrix": matrix}


def combined_series(nav_map: dict[str, list[list]], weights: dict[str, float], span: str = "3y") -> dict:
    codes = [c for c in nav_map if c in weights and weights[c] > 0]
    if not codes:
        return {"points": [], "metrics": metrics([])}
    series = {c: dict(slice_range(nav_map[c], span)) for c in codes}
    common = set(series[codes[0]])
    for c in codes[1:]:
        common &= set(series[c])
    dates = sorted(common)
    if len(dates) < 5:
        return {"points": [], "metrics": metrics([])}
    total = sum(weights[c] for c in codes)
    w = {c: weights[c] / total for c in codes}
    rets = []
    for c in codes:
        values = np.array([series[c][d] for d in dates])
        rets.append(np.diff(values) / values[:-1])
    combined_ret = np.zeros(len(dates) - 1)
    for i, c in enumerate(codes):
        combined_ret += w[c] * rets[i]
    values = np.concatenate([[100.0], 100.0 * np.cumprod(1 + combined_ret)])
    points = [[d, _r(v, 3)] for d, v in zip(dates, values)]
    return {"points": points, "metrics": metrics(points)}


def _period_key(day: str, frequency: str) -> tuple:
    d = _date(day)
    if frequency == "monthly":
        return (d.year, d.month)
    if frequency == "quarterly":
        return (d.year, (d.month - 1) // 3)
    if frequency == "annual":
        return (d.year,)
    return (d.year, d.month, d.day)


def _yearly_returns(points: list[list], benchmark_points: list[list] | None = None) -> list[dict]:
    if not points:
        return []
    groups: dict[str, dict] = {}
    for day, value in points:
        year = str(day)[:4]
        bucket = groups.setdefault(year, {"first": value, "last": value})
        bucket["last"] = value
    bench = {}
    for day, value in benchmark_points or []:
        year = str(day)[:4]
        bucket = bench.setdefault(year, {"first": value, "last": value})
        bucket["last"] = value
    out = []
    for year in sorted(groups):
        bucket = groups[year]
        portfolio_return = (bucket["last"] / bucket["first"] - 1) * 100 if bucket["first"] else None
        benchmark_return = None
        if year in bench and bench[year]["first"]:
            benchmark_return = (bench[year]["last"] / bench[year]["first"] - 1) * 100
        out.append(
            {
                "year": year,
                "portfolio": _r(portfolio_return, 2),
                "benchmark": _r(benchmark_return, 2),
                "excess": _r(portfolio_return - benchmark_return, 2)
                if portfolio_return is not None and benchmark_return is not None
                else None,
            }
        )
    return out


def risk_metrics(points: list[list], benchmark_points: list[list] | None = None) -> dict:
    empty = {
        "beta": None,
        "alpha": None,
        "tracking_error": None,
        "information_ratio": None,
        "downside_deviation": None,
        "sortino": None,
        "treynor": None,
        "correlation": None,
        "excess_annual": None,
        "benchmark_annual": None,
        "observations": 0,
    }
    if len(points) < 30 or not benchmark_points:
        return empty
    portfolio = dict(points)
    benchmark = dict(benchmark_points)
    dates = sorted(set(portfolio) & set(benchmark))
    if len(dates) < 30:
        return empty
    pv = np.array([portfolio[d] for d in dates], dtype=float)
    bv = np.array([benchmark[d] for d in dates], dtype=float)
    pr = np.diff(pv) / pv[:-1]
    br = np.diff(bv) / bv[:-1]
    if len(pr) < 30:
        return empty
    rf_daily = RISK_FREE / 252
    var_b = float(np.var(br, ddof=1))
    beta = float(np.cov(pr, br, ddof=1)[0, 1] / var_b) if var_b > 0 else None
    corr = (
        float(np.corrcoef(pr, br)[0, 1])
        if np.std(pr) > 0 and np.std(br) > 0
        else None
    )
    years = max((_date(dates[-1]) - _date(dates[0])).days / 365.25, 1 / 365.25)
    annual_p = float((pv[-1] / pv[0]) ** (1 / years) - 1) * 100
    annual_b = float((bv[-1] / bv[0]) ** (1 / years) - 1) * 100
    alpha = None
    treynor = None
    if beta is not None:
        alpha = (
            float(np.mean(pr)) - rf_daily - beta * (float(np.mean(br)) - rf_daily)
        ) * 252 * 100
        if beta > 0:
            treynor = _r((annual_p - RISK_FREE * 100) / beta, 3)
    diff = pr - br
    tracking_error = (
        float(np.std(diff, ddof=1) * math.sqrt(252) * 100) if len(diff) > 2 else None
    )
    information_ratio = (
        (annual_p - annual_b) / tracking_error
        if tracking_error and tracking_error > 0
        else None
    )
    downside = pr[pr < 0]
    downside_deviation = (
        float(np.std(downside, ddof=1) * math.sqrt(252) * 100)
        if len(downside) > 2
        else None
    )
    sortino = (
        (annual_p - RISK_FREE * 100) / downside_deviation
        if downside_deviation and downside_deviation > 0
        else None
    )
    return {
        "beta": _r(beta, 3),
        "alpha": _r(alpha, 2),
        "tracking_error": _r(tracking_error, 2),
        "information_ratio": _r(information_ratio, 2),
        "downside_deviation": _r(downside_deviation, 2),
        "sortino": _r(sortino, 2),
        "treynor": treynor,
        "correlation": _r(corr, 3),
        "excess_annual": _r(annual_p - annual_b, 2),
        "benchmark_annual": _r(annual_b, 2),
        "observations": len(pr),
    }


def _rebalanced_points(
    dates: list[str],
    prices: dict[str, np.ndarray],
    weights: dict[str, float],
    frequency: str,
    cost_bps: float,
):
    codes = list(weights)
    total = sum(weights[c] for c in codes)
    target = {c: weights[c] / total for c in codes}
    units = {c: target[c] * 100.0 / prices[c][0] for c in codes}
    points = []
    rebalances = 0
    previous_group = None
    for index, day in enumerate(dates):
        group = _period_key(day, frequency)
        if frequency != "none" and previous_group is not None and group != previous_group:
            current_value = sum(units[c] * prices[c][index] for c in codes)
            if current_value > 0:
                current_weights = {
                    c: units[c] * prices[c][index] / current_value for c in codes
                }
                turnover = 0.5 * sum(
                    abs(current_weights[c] - target[c]) for c in codes
                )
                current_value *= max(0.0, 1 - turnover * cost_bps / 10000)
                units = {
                    c: current_value * target[c] / prices[c][index] for c in codes
                }
                rebalances += 1
        value = sum(units[c] * prices[c][index] for c in codes)
        points.append([day, _r(value, 3)])
        previous_group = group
    return points, rebalances


def portfolio_backtest(
    nav_map: dict[str, list[list]],
    weights: dict[str, float],
    span: str = "3y",
    benchmark: dict | None = None,
    cost_bps: float = 5,
) -> dict:
    codes = [c for c in nav_map if weights.get(c, 0) > 0]
    if len(codes) == 0:
        return {
            "strategies": {},
            "benchmark": None,
            "contributions": [],
            "note": "没有可回测的净值序列",
        }
    sliced = {c: dict(slice_range(nav_map[c], span)) for c in codes}
    common = set(sliced[codes[0]])
    for c in codes[1:]:
        common &= set(sliced[c])
    bench_values = {
        str(item[0]): float(item[1])
        for item in (benchmark or {}).get("values") or []
    }
    if bench_values:
        common &= set(bench_values)
    dates = sorted(common)
    if len(dates) < 5:
        return {
            "strategies": {},
            "benchmark": None,
            "contributions": [],
            "note": "共同交易日不足，无法回测",
        }
    prices = {
        c: np.array([sliced[c][d] for d in dates], dtype=float) for c in codes
    }
    bench_prices = (
        np.array([bench_values[d] for d in dates], dtype=float)
        if bench_values
        else None
    )
    benchmark_points = (
        [[d, _r(v / bench_prices[0] * 100, 3)] for d, v in zip(dates, bench_prices)]
        if bench_prices is not None and len(bench_prices)
        else []
    )
    labels = {
        "none": "不再平衡",
        "monthly": "月度再平衡",
        "quarterly": "季度再平衡",
        "annual": "年度再平衡",
    }
    strategies = {}
    for key, label in labels.items():
        points, rebalances = _rebalanced_points(dates, prices, weights, key, cost_bps)
        strategies[key] = {
            "label": label,
            "points": downsample(points, 700),
            "drawdown": downsample(drawdown_series(points), 700),
            "metrics": metrics(points),
            "risk": risk_metrics(points, benchmark_points),
            "yearly": _yearly_returns(points, benchmark_points),
            "rebalances": rebalances,
        }
    total = sum(weights[c] for c in codes)
    target = {c: weights[c] / total for c in codes}
    fund_returns = {
        c: (prices[c][-1] / prices[c][0] - 1) * 100 if prices[c][0] else None
        for c in codes
    }
    contributions = [
        {
            "code": c,
            "weight": _r(target[c] * 100, 2),
            "return": _r(fund_returns[c], 2),
            "contribution": _r(target[c] * (fund_returns[c] or 0), 2),
        }
        for c in codes
    ]
    contributions.sort(key=lambda item: item["contribution"], reverse=True)
    return {
        "start": dates[0],
        "end": dates[-1],
        "days": len(dates),
        "cost_bps": cost_bps,
        "strategies": strategies,
        "benchmark": {
            "name": (benchmark or {}).get("name") or "沪深300",
            "points": downsample(benchmark_points, 700),
            "drawdown": downsample(drawdown_series(benchmark_points), 700),
            "metrics": metrics(benchmark_points),
            "yearly": _yearly_returns(benchmark_points),
        }
        if benchmark_points
        else None,
        "contributions": contributions,
        "note": "按区间起点买入；月度/季度/年度策略在周期切换时恢复目标权重，按单边成本估算。",
    }


def rank_parse(text: str | None) -> tuple[int | None, int | None, float | None]:
    if not text or "/" not in str(text):
        return None, None, None
    try:
        rank, total = str(text).split("/")[:2]
        rank_i, total_i = int(rank), int(total)
        return rank_i, total_i, rank_i / total_i * 100
    except (ValueError, ZeroDivisionError):
        return None, None, None


def manager_years(text: str | None) -> float | None:
    if not text:
        return None
    match = re.search(r"(\d+)\s*年", str(text))
    if not match:
        return None
    days = re.search(r"又\s*(\d+)\s*天", str(text))
    return int(match.group(1)) + (int(days.group(1)) / 365 if days else 0)


def _insight(level: str, title: str, text: str) -> dict:
    return {"level": level, "title": title, "text": text}


def fund_insights(ctx: dict) -> list[dict]:
    out: list[dict] = []
    top10 = ctx.get("top10_weight")
    if top10 is not None:
        if top10 >= 60:
            out.append(_insight("warn", "重仓集中度偏高", f"前十大重仓占净值 {top10:.1f}%，组合对少数个股依赖较强，需关注个股波动放大。"))
        elif top10 <= 25:
            out.append(_insight("info", "持仓相对分散", f"前十大重仓仅占净值 {top10:.1f}%，个股集中风险较低。"))

    industries = ctx.get("industries") or []
    if industries:
        top = industries[0]
        if top["share"] >= 40:
            out.append(_insight("warn", "行业暴露集中", f"第一大行业「{top['name']}」占前十大重仓的 {top['share']:.1f}%，行业景气度变化会显著影响净值。"))
        elif top["share"] >= 25:
            out.append(_insight("info", "行业偏向明显", f"「{top['name']}」为第一大重仓行业，占前十大权重的 {top['share']:.1f}%。"))

    m1 = ctx.get("metrics_1y") or {}
    if m1.get("max_drawdown") is not None and m1["max_drawdown"] <= -25:
        out.append(_insight("warn", "近一年回撤较深", f"近一年最大回撤 {m1['max_drawdown']:.1f}%，持有体验对风险偏好要求较高。"))
    if m1.get("sharpe") is not None:
        if m1["sharpe"] >= 1.2:
            out.append(_insight("good", "风险调整后收益突出", f"近一年夏普比率 {m1['sharpe']:.2f}，单位波动获取的回报较好。"))
        elif m1["sharpe"] < 0:
            out.append(_insight("warn", "风险收益比偏弱", f"近一年夏普比率为 {m1['sharpe']:.2f}，承担波动未获得正的风险补偿。"))

    chg = ctx.get("change") or {}
    if chg.get("new_count", 0) >= 4:
        out.append(_insight("info", "换仓较积极", f"最新季度前十大中出现 {chg['new_count']} 只新进个股，组合调整幅度较大。"))
    if chg.get("retention") is not None and chg["retention"] >= 80:
        out.append(_insight("good", "重仓股稳定性高", f"前十大重仓留存度 {chg['retention']:.0f}%，基金经理对核心持仓保持较高信心。"))

    scale = ctx.get("scale")
    scale_change = ctx.get("scale_change")
    if scale is not None and scale < 2:
        out.append(_insight("warn", "规模偏小", f"最新净资产约 {scale:.2f} 亿元，需留意清盘风险与流动性约束。"))
    elif scale_change is not None and scale_change <= -40:
        out.append(_insight("warn", "规模大幅缩水", f"最新报告期规模环比下降 {abs(scale_change):.0f}%，关注赎回压力。"))
    elif scale is not None and scale >= 200:
        out.append(_insight("info", "规模较大", f"最新净资产约 {scale:.0f} 亿元，策略容量与调仓成本值得关注。"))

    holders = ctx.get("holders") or {}
    if holders.get("institution") is not None:
        if holders["institution"] >= 60:
            out.append(_insight("info", "机构持有占比较高", f"机构持有比例 {holders['institution']:.1f}%，申赎行为可能更集中。"))
        elif holders["institution"] <= 5:
            out.append(_insight("info", "以个人投资者为主", f"机构持有比例仅 {holders['institution']:.1f}%，负债端稳定性相对依赖零售渠道。"))

    internal_ratio = ctx.get("internal_ratio")
    if internal_ratio is not None and internal_ratio >= 5:
        out.append(_insight("good", "内部自购信号强", f"内部持有比例 {internal_ratio:.2f}%，员工/管理层自购的公开代理指标较高。"))

    fee = ctx.get("fee")
    if fee is not None and fee >= 1.2:
        out.append(_insight("info", "申购费率偏高", f"默认申购费率 {fee:.2f}%，长期持有可通过 C 类份额或直销渠道降低成本。"))

    years = ctx.get("manager_years")
    if years is not None:
        if years < 1:
            out.append(_insight("warn", "现任经理任职较短", "现任基金经理管理本产品不足一年，历史业绩参考意义有限。"))
        elif years >= 8:
            out.append(_insight("good", "经理经验丰富", f"现任基金经理从业 {years:.0f} 年，穿越过多轮市场周期。"))

    rank_info = ctx.get("rank_1y")
    if rank_info:
        rank, total, pct = rank_info
        if pct is not None:
            if pct <= 25:
                out.append(_insight("good", "同类排名靠前", f"近一年同类排名 {rank}/{total}，位于前 25%。"))
            elif pct >= 75:
                out.append(_insight("warn", "同类排名靠后", f"近一年同类排名 {rank}/{total}，位于后 25%。"))

    priority = {"warn": 0, "good": 1, "info": 2}
    out.sort(key=lambda x: priority.get(x["level"], 3))
    return out[:7]


def portfolio_insights(pairs: list[dict], correlation_max: float | None, industry_top: dict | None, weighted_fee: float | None, coverage: float | None) -> list[dict]:
    out: list[dict] = []
    high_overlap = [p for p in pairs if p["score"] >= 20]
    if high_overlap:
        hardest = max(high_overlap, key=lambda x: x["score"])
        out.append(_insight("warn", "底层持仓重叠", f"{hardest['a_name']} 与 {hardest['b_name']} 的前十大重仓重叠度约 {hardest['score']:.1f}%，分散效果可能不及预期。"))
    if correlation_max is not None:
        if correlation_max >= 0.8:
            out.append(_insight("warn", "组合高相关", f"基金间最高相关系数 {correlation_max:.2f}，同涨同跌特征明显，分散化效果有限。"))
        elif correlation_max <= 0.5:
            out.append(_insight("good", "相关性较低", f"基金间最高相关系数 {correlation_max:.2f}，组合分散化效果较好。"))
    if industry_top and industry_top.get("share", 0) >= 40:
        out.append(_insight("warn", "穿透行业集中", f"穿透后「{industry_top['name']}」占已披露重仓敞口的 {industry_top['share']:.1f}%。"))
    if weighted_fee is not None and weighted_fee >= 1.0:
        out.append(_insight("info", "综合费率偏高", f"按权重加权的申购费率约 {weighted_fee:.2f}%。"))
    if coverage is not None and coverage < 50:
        out.append(_insight("info", "穿透覆盖有限", "季报仅披露前十大重仓股，组合穿透结果覆盖组合净值有限，请结合全持仓报告解读。"))
    if not out:
        out.append(_insight("good", "组合结构均衡", "未发现显著的持仓重叠或行业集中风险。"))
    return out[:6]
