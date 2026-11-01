"""Pre-fetch market-wide data and a few popular fund profiles.

Usage: python scripts/warmup.py [--force] [--quarters 9] [--skip-funds]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fundlib import datasource as ds  # noqa: E402
from fundlib import service, store, top10  # noqa: E402

POPULAR_FUNDS = [
    "510300",  # 沪深300ETF
    "510500",  # 中证500ETF
    "159915",  # 创业板ETF
    "588000",  # 科创50ETF
    "512890",  # 红利低波ETF
    "110022",  # 易方达消费行业
    "161725",  # 招商中证白酒
    "003095",  # 中欧医疗健康A
    "001938",  # 中欧时代先锋A
    "163406",  # 兴全合润
]


def log(message: str) -> None:
    print(message, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="ignore cache TTL")
    parser.add_argument("--quarters", type=int, default=9)
    parser.add_argument("--skip-funds", action="store_true")
    args = parser.parse_args()

    store.init()
    t0 = time.time()

    log("[1/5] 基金列表与排行 ...")
    universe = ds.fund_universe(force=args.force)
    log(f"      {len(universe)} 只基金")

    log("[2/5] 全市场基金持仓聚合 ...")
    quarters = ds.recent_quarters(args.quarters)
    for quarter in reversed(quarters):
        try:
            rows = ds.market_quarter(quarter, force=args.force)
            log(f"      {quarter}: {len(rows)} 只重仓股")
        except Exception as exc:
            log(f"      {quarter}: 跳过 ({exc})")

    log("[2.2/5] 前十大持仓聚合 ...")
    for quarter in ("2026Q2", "2025Q4"):
        if not store.top10_progress_count(quarter):
            continue
        try:
            count = top10.rebuild_aggregate(quarter)
            if count:
                log(f"      {quarter}: {count} 只股票（前十大口径）")
            else:
                log(f"      {quarter}: 覆盖不足，跳过聚合")
        except Exception as exc:
            log(f"      {quarter}: 跳过 ({exc})")

    log("[2.5/5] 基金经理索引 / 规模映射 ...")
    try:
        managers = ds.manager_universe().get("managers", [])
        scales = ds.fund_scale_map()
        log(f"      {len(managers)} 位经理 · {len(scales)} 只基金规模")
    except Exception as exc:
        log(f"      经理索引失败: {exc}")

    log("[3/5] 基金公司规模 / 沪深300 ...")
    try:
        companies = ds.company_aum()
        log(f"      {len(companies)} 家基金公司")
    except Exception as exc:
        log(f"      基金公司数据失败: {exc}")
    try:
        bench = ds.benchmark_series()
        log(f"      沪深300 {len(bench['values'])} 个交易日")
    except Exception as exc:
        log(f"      基准数据失败: {exc}")

    log("[4/5] 重仓股行情与行业映射 ...")
    codes: set[str] = set()
    for quarter in quarters:
        try:
            rows = store.market_rows(quarter)
        except Exception:
            rows = []
        for row in rows[:350]:
            codes.add(row["code"])
    codes_list = list(codes)
    for i in range(0, len(codes_list), 80):
        try:
            ds.stock_quotes(codes_list[i : i + 80], max_age=3600)
        except Exception as exc:
            log(f"      行情批次失败: {exc}")
    log(f"      {len(codes_list)} 只股票")

    log("[4.5/5] 全市场持有人结构 / 市场快照 ...")
    try:
        holder = ds.market_holder_structure()
        log(f"      持有人结构 {len(holder.get('dates', []))} 期")
    except Exception as exc:
        log(f"      持有人结构失败: {exc}")
    for quarter in ds.recent_quarters(3):
        if not store.market_available(quarter):
            continue
        try:
            service.market_payload(quarter)
            service.stocks_payload(quarter, {"limit": "300"})
            log(f"      {quarter} 市场 / 重仓股快照 ok")
        except Exception as exc:
            log(f"      {quarter} 市场快照失败: {exc}")

    try:
        latest_q = ds.recent_quarters(1)[0]
        top_rows = sorted(store.market_rows(latest_q), key=lambda r: r.get("fund_count") or 0, reverse=True)[:8]
        for row in top_rows:
            service.stock_payload(row["code"], latest_q)
        log(f"      个股详情快照 {len(top_rows)} 只")
    except Exception as exc:
        log(f"      个股详情快照失败: {exc}")

    try:
        top_managers = service.managers_payload("", 3).get("managers", [])
        for manager in top_managers:
            profile = service.manager_payload(manager["name"], manager["company"])
            report_fund = (profile.get("report_fund") or {}).get("code")
            if report_fund:
                ds.fund_report(report_fund)
                ds.fund_report(report_fund, "annual")
        log(f"      经理快照 {len(top_managers)} 位")
    except Exception as exc:
        log(f"      经理快照失败: {exc}")

    if not args.skip_funds:
        log("[5/5] 预热热门基金档案 ...")
        for code in POPULAR_FUNDS:
            try:
                service.fund_payload(code)
                ds.fund_report(code)
                ds.fund_report(code, "annual")
                log(f"      {code} ok")
            except Exception as exc:
                log(f"      {code} 失败: {exc}")
    else:
        log("[5/5] 跳过基金档案预热")

    log(f"完成，用时 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
