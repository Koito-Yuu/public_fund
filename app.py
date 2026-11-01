"""FundScope — 中国公募基金持仓分析看板 (Flask API + SPA host)."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import re
import time

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from fundlib import datasource as ds
from fundlib import service, store


def _quarter_arg(value: str | None, default: str) -> str:
    quarter = value or default
    if not re.fullmatch(r"\d{4}Q[1-4]", quarter):
        raise ValueError("报告期格式应为 YYYYQ1–YYYYQ4")
    return quarter


def _portfolio_items(items) -> list[dict]:
    if not isinstance(items, list):
        raise ValueError("items 应为数组")
    cleaned = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("items 中每项应为对象")
        code = str(item.get("code") or "")
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("组合中的基金代码应为 6 位数字")
        try:
            weight = float(item.get("weight") or 0)
        except (TypeError, ValueError):
            raise ValueError("基金权重应为数字") from None
        if weight < 0:
            raise ValueError("基金权重不能为负数")
        cleaned.append(
            {
                "code": code,
                "name": str(item.get("name") or "").strip()[:60],
                "weight": weight,
            }
        )
    if len(cleaned) > 8:
        raise ValueError("最多支持 8 只基金")
    if cleaned and not any(item["weight"] > 0 for item in cleaned):
        raise ValueError("请至少设置一只基金的权重")
    return cleaned


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.json.ensure_ascii = False
    app.json.compact = True
    app.json.sort_keys = False
    store.init()

    @app.before_request
    def start_timer():
        g.started_at = time.time()

    @app.after_request
    def add_headers(response):
        gzip_ok = "gzip" in request.headers.get("Accept-Encoding", "").lower()

        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.path in ("/", "/index.html"):
            response.headers["Cache-Control"] = "no-cache"
        elif request.path.startswith("/static/"):
            if request.path.endswith((".js", ".css")):
                response.headers["Cache-Control"] = "no-cache"
            else:
                response.headers["Cache-Control"] = "public, max-age=86400"

        # 按内容生成 ETag：SPA 内往返时用 304 代替整段 JSON
        api_digest = ""
        if (
            request.method == "GET"
            and request.path.startswith("/api/")
            and request.path != "/api/health"
            and request.path != "/api/portfolios"
            and response.status_code == 200
            and response.mimetype == "application/json"
        ):
            api_digest = hashlib.blake2b(response.get_data(), digest_size=8).hexdigest()
            response.set_etag(api_digest)
            response.headers["Cache-Control"] = "private, max-age=30, must-revalidate"
            response = response.make_conditional(request)

        if (
            request.method == "GET"
            and request.path.startswith("/static/")
            and response.status_code == 200
            and response.mimetype in ("text/javascript", "text/css", "image/svg+xml", "application/json")
            and gzip_ok
            and not response.headers.get("Content-Encoding")
        ):
            response.direct_passthrough = False
            data = response.get_data()
            etag = response.headers.get("ETag") or ""
            cached = _static_gzip_cache.get(request.path) if etag else None
            if cached and cached[0] == etag:
                compressed = cached[1]
            else:
                compressed = gzip.compress(data, 6)
                if etag:
                    if len(_static_gzip_cache) > 64:
                        _static_gzip_cache.clear()
                    _static_gzip_cache[request.path] = (etag, compressed)
            if len(compressed) < len(data):
                response.set_data(compressed)
                response.headers["Content-Encoding"] = "gzip"
                response.headers["Vary"] = "Accept-Encoding"

        if (
            request.path.startswith("/api/")
            and gzip_ok
            and response.status_code == 200
            and not response.headers.get("Content-Encoding")
            and response.mimetype == "application/json"
        ):
            data = response.get_data()
            if len(data) > 1024:
                compressed = _api_gzip_cache.get(api_digest) if api_digest else None
                if compressed is None:
                    compressed = gzip.compress(data, 6)
                    if api_digest:
                        if len(_api_gzip_cache) > 128:
                            _api_gzip_cache.clear()
                        _api_gzip_cache[api_digest] = compressed
                if len(compressed) < len(data):
                    response.set_data(compressed)
                    response.headers["Content-Encoding"] = "gzip"
                    response.headers["Vary"] = "Accept-Encoding"

        response.headers["X-Content-Type-Options"] = "nosniff"
        started = getattr(g, "started_at", None)
        if started is not None:
            response.headers["X-Elapsed-Ms"] = str(int((time.time() - started) * 1000))
        return response

    @app.errorhandler(Exception)
    def handle_error(exc):
        if isinstance(exc, HTTPException):
            return jsonify({"error": exc.description}), exc.code
        if isinstance(exc, ds.NotFoundError):
            status = 404
        elif isinstance(exc, ds.DataError):
            status = 502
        elif isinstance(exc, ValueError):
            status = 400
        else:
            app.logger.exception("Unhandled error")
            return jsonify({"error": "服务内部错误，请查看 data/server.log"}), 500
        return jsonify({"error": str(exc)}), status

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "ts": int(time.time())})

    @app.get("/api/meta")
    def meta():
        return jsonify(service.meta_payload())

    @app.get("/api/market")
    def market():
        quarters = store.market_quarters()
        quarter = _quarter_arg(
            request.args.get("quarter"),
            quarters[0] if quarters else ds.recent_quarters(1)[0],
        )
        return jsonify(service.market_payload(quarter))

    @app.get("/api/screener")
    def screener():
        return jsonify(service.screen_payload(request.args.to_dict()))

    @app.get("/api/fund/<code>")
    def fund(code: str):
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("基金代码应为 6 位数字")
        return jsonify(service.fund_payload(code))

    @app.get("/api/fund/<code>/report")
    def fund_report(code: str):
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("基金代码应为 6 位数字")
        report_type = request.args.get("type") or "latest"
        if report_type not in ("latest", "annual"):
            raise ValueError("报告类型仅支持 latest 或 annual")
        return jsonify(ds.fund_report(code, report_type))

    @app.get("/api/managers")
    def managers():
        return jsonify(service.managers_payload(request.args.get("q") or "", request.args.get("limit") or 30, request.args.get("sort") or "best"))

    @app.get("/api/manager/<path:name>")
    def manager(name: str):
        return jsonify(service.manager_payload(name, request.args.get("company")))

    @app.post("/api/portfolio")
    def portfolio():
        payload = request.get_json(silent=True) or {}
        items = _portfolio_items(payload.get("items") or [])
        span = payload.get("span") or "3y"
        if span not in ("1y", "3y", "5y", "all"):
            span = "3y"
        return jsonify(service.portfolio_payload(items, span))

    @app.get("/api/portfolios")
    def portfolios():
        return jsonify({"items": store.portfolio_list()})

    @app.post("/api/portfolios")
    def save_portfolio():
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("组合名称不能为空")
        if len(name) > 40:
            raise ValueError("组合名称不能超过 40 个字符")
        items = _portfolio_items(payload.get("items") or [])
        if not items:
            raise ValueError("请至少选择一只基金")
        portfolio_id = store.portfolio_save(name, items)
        return jsonify({"id": portfolio_id, "name": name, "items": items, "saved": True})

    @app.delete("/api/portfolios/<int:portfolio_id>")
    def delete_portfolio(portfolio_id: int):
        if not store.portfolio_delete(portfolio_id):
            return jsonify({"error": "未找到该组合"}), 404
        return jsonify({"deleted": True})

    @app.get("/api/stocks")
    def stocks():
        quarters = store.market_quarters()
        quarter = _quarter_arg(
            request.args.get("quarter"),
            quarters[0] if quarters else ds.recent_quarters(1)[0],
        )
        return jsonify(service.stocks_payload(quarter, request.args.to_dict()))

    @app.get("/api/stock/<code>")
    def stock(code: str):
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("股票代码应为 6 位数字")
        quarter = request.args.get("quarter")
        if quarter and not re.fullmatch(r"\d{4}Q[1-4]", quarter):
            raise ValueError("报告期格式应为 YYYYQ1–YYYYQ4")
        return jsonify(service.stock_payload(code, quarter))

    @app.get("/api/search")
    def search():
        return jsonify(service.search_payload(request.args.get("q") or ""))

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/favicon.ico")
    def favicon():
        return send_from_directory(app.static_folder, "favicon.svg", mimetype="image/svg+xml")

    @app.get("/<path:path>")
    def static_files(path: str):
        return send_from_directory(app.static_folder, path)

    return app


app = create_app()
_static_gzip_cache: dict[str, tuple[str, bytes]] = {}
_api_gzip_cache: dict[str, bytes] = {}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FundScope dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    if args.debug:
        app.run(host=args.host, port=args.port, debug=True, threaded=True)
    else:
        print(f"FundScope → http://{args.host}:{args.port}", flush=True)
        try:
            from waitress import serve
        except ImportError:
            app.run(host=args.host, port=args.port, threaded=True)
        else:
            serve(app, host=args.host, port=args.port, threads=8, ident="FundScope")
