"""Package the dashboard and its offline forecast engine as one HTML file."""

import argparse
import io
import json
from pathlib import Path

from scripts.make_demo import write_demo
from serve import HORIZONS, RETAIL_SAMPLE, WEB, analyze


SCRIPTS = (
    ("csv.js", "offline-csv"),
    ("forecast-engine.js", "offline-engine"),
    ("stock-chart.js", "offline-stock-chart"),
    ("reorder.js", "offline-reorder"),
    ("reorder-view.js", "offline-reorder-view"),
    ("replay.js", "offline-replay"),
    ("replay-view.js", "offline-replay-view"),
    ("app.js", "offline-app"),
)


def build_preview():
    demo = io.StringIO(newline="")
    write_demo(demo)
    retail = io.StringIO(RETAIL_SAMPLE.read_text(encoding="utf-8"), newline="")
    forecasts = {}
    for name, history in (("demo", demo), ("retail", retail)):
        forecasts[name] = {}
        for horizon in sorted(HORIZONS):
            history.seek(0)
            forecasts[name][horizon] = analyze(history, horizon)
    data = json.dumps(forecasts, allow_nan=False, separators=(",", ":")).replace("<", "\\u003c")

    markup = (WEB / "index.html").read_text(encoding="utf-8")
    styles = (WEB / "styles.css").read_text(encoding="utf-8")
    license_text = (WEB.parent / "LICENSE").read_text(encoding="utf-8")
    markup = markup.replace("<!doctype html>", "<!doctype html>\n<!--\n" + license_text + "-->")
    scripts = []
    for filename, element_id in SCRIPTS:
        markup = markup.replace(f'  <script defer src="/{filename}"></script>\n', "")
        script = (WEB / filename).read_text(encoding="utf-8")
        scripts.append(f'<script id="{element_id}">\n{script}\n</script>\n')
    return (
        markup.replace('<link rel="stylesheet" href="/styles.css">', f"<style>{styles}</style>")
        .replace(
            "</body>",
            f'<script id="offline-demo-data" type="application/json">{data}</script>\n'
            + "".join(scripts) + "</body>",
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(build_preview(), encoding="utf-8")


if __name__ == "__main__":
    main()
