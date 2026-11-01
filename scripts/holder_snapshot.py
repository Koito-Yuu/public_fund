"""Build a local snapshot of per-fund holder structure.

The public endpoint is per-fund, so this script fetches the largest open
funds first (by estimated scale) and stores results in SQLite. Re-run any time:

    python scripts/holder_snapshot.py --limit 2000 --workers 10
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fundlib import datasource as ds  # noqa: E402
from fundlib import store  # noqa: E402

POPULAR = ["110022", "510300", "512890", "588000", "161725", "003095", "001938", "163406"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=1500)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    store.init()
    scale_map = ds.fund_scale_map()
    if args.force:
        with store.connect() as conn:
            conn.execute("DELETE FROM fund_holders")

    ordered = sorted(
        ((code, item.get("scale") or 0) for code, item in scale_map.items()),
        key=lambda pair: pair[1],
        reverse=True,
    )
    existing = set() if args.force else set(store.holders_latest_map())
    codes = [code for code, _ in ordered[: args.limit] if code not in existing]
    for code in POPULAR:
        if code not in codes and code not in existing:
            codes.append(code)
    print(f"fetching holder structure for {len(codes)} new funds (limit {args.limit}) ...", flush=True)

    done = 0
    ok = 0
    t0 = time.time()

    def fetch(code: str):
        return code, ds.fund_holder_rows(code)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch, code): code for code in codes}
        for future in as_completed(futures):
            code = futures[future]
            try:
                _, rows = future.result()
                if rows:
                    store.holders_replace(code, rows)
                    ok += 1
            except Exception as exc:
                print(f"  {code} failed: {exc}", flush=True)
            done += 1
            if done % 100 == 0:
                print(
                    f"  {done}/{len(codes)} · {ok} stored · {time.time() - t0:.0f}s",
                    flush=True,
                )

    store.meta_set("holder_snapshot_at", str(int(time.time())))
    store.meta_set("holder_snapshot_count", str(store.holders_count()))
    print(
        f"done: {ok} funds stored, {store.holders_count()} total covered, {time.time() - t0:.0f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
