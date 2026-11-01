"""Regenerate docs/screenshots for both themes.

Usage: python scripts/screenshots.py [--base http://127.0.0.1:8765] [--fund 002910]
Requires Playwright and a local Chrome install; the server must already be running.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

PAGES = (
    ("market", "#/market", True),
    ("screener", "#/screener", True),
    ("managers", "#/managers", False),
    ("portfolio", "#/portfolio", True),
    ("fund", "#/fund/{fund}", True),
    ("stocks", "#/stocks", True),
)
CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
)


def find_chrome() -> str | None:
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    return None


def settle_charts(page, height: int) -> None:
    """Scroll in steps so IntersectionObserver initializes below-the-fold charts."""
    for y in range(600, max(height, 700), 600):
        page.evaluate(f"window.scrollTo(0, {y})")
        page.wait_for_timeout(120)
    page.wait_for_timeout(500)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--fund", default="002910")
    parser.add_argument("--out", default="docs/screenshots")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()
    if not chrome:
        raise SystemExit("未找到 Chrome，可修改 CHROME_CANDIDATES")

    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=chrome, headless=True)
        for theme in ("dark", "light"):
            ctx = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
            if theme == "light":
                ctx.add_init_script("localStorage.setItem('fundscope.theme','light')")
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(m.text[:140]) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)[:140]))
            for name, route, full in PAGES:
                page.goto(f"{args.base}/{route.format(fund=args.fund)}", wait_until="networkidle")
                page.wait_for_timeout(900)
                if name == "portfolio":
                    page.locator("[data-preset]").first.click()
                    page.wait_for_timeout(2500)
                settle_charts(page, page.evaluate("document.body.scrollHeight"))
                page.evaluate("window.scrollTo(0, 0)")
                page.wait_for_timeout(400)
                suffix = "-light" if theme == "light" else ""
                target = out / f"{name}{suffix}.png"
                page.screenshot(path=str(target), full_page=full)
                print(f"{theme:5} {name:9} -> {target}")
            ctx.close()
        browser.close()

    print("console errors:", errors[:5] or "none")


if __name__ == "__main__":
    main()
