"""Capture the documented screens from the offline dashboard."""

import argparse
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image
from playwright.sync_api import expect, sync_playwright

from scripts.make_preview import build_preview
from serve import WEB


def indexed_png(data):
    with Image.open(BytesIO(data)) as source:
        return source.convert("RGB").quantize(colors=236, dither=Image.Dither.NONE)


def capture(page, docs):
    expect(page.locator("#reorder-order-units")).to_have_text("264")
    page.mouse.move(2, 2)
    item = page.locator(".reorder-item")
    before = indexed_png(item.screenshot(animations="disabled"))
    page.get_by_role("button", name="Two days late").click()
    expect(page.locator("#reorder-order-units")).to_have_text("342")
    after = indexed_png(item.screenshot(animations="disabled"))
    before.save(docs / "delivery-delay.gif", save_all=True, append_images=[after],
                duration=[2200, 2200], loop=0, optimize=True)
    page.evaluate("window.scrollTo(0, 0)")
    indexed_png(page.screenshot(animations="disabled", full_page=True)).save(docs / "reorder-workspace.png", optimize=True)

    page.get_by_role("button", name="Retail sample", exact=True).click()
    page.get_by_role("link", name="Inventory replay", exact=True).click()
    expect(page.locator("#replay-summary")).to_contain_text("608 fewer units")
    page.locator("#replay-impact summary").click()
    expect(page.locator("#replay-impact-rows tr")).to_have_count(8)
    page.evaluate("window.scrollTo(0, 0)")
    indexed_png(page.screenshot(animations="disabled", full_page=True)).save(docs / "inventory-replay.png", optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", help="Path to an existing Chromium executable")
    args = parser.parse_args()
    with TemporaryDirectory() as directory, sync_playwright() as playwright:
        demo = Path(directory) / "preview.html"
        demo.write_text(build_preview(), encoding="utf-8")
        browser = playwright.chromium.launch(executable_path=args.chromium, args=["--disable-gpu", "--no-zygote"])
        try:
            page = browser.new_page(viewport={"width": 1360, "height": 910}, offline=True)
            page.goto(demo.as_uri())
            capture(page, WEB.parent / "docs")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
