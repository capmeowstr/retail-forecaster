"""Serve the retail forecaster dashboard on this computer."""

import argparse
import csv
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from forecast import BASELINE, DAY, evaluate, parse_history, predict
from make_demo import write_demo


WEB = Path(__file__).resolve().parent / "web"
RETAIL_SAMPLE = WEB.parent / "sample-data" / "uci-retail.csv"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/styles.css": ("styles.css", "text/css"),
    "/csv.js": ("csv.js", "text/javascript"),
    "/reorder.js": ("reorder.js", "text/javascript"),
    "/reorder-view.js": ("reorder-view.js", "text/javascript"),
    "/replay.js": ("replay.js", "text/javascript"),
    "/replay-view.js": ("replay-view.js", "text/javascript"),
    "/app.js": ("app.js", "text/javascript"),
}
HORIZONS = {7, 14, 28}
MAX_UPLOAD = 10 * 1024 * 1024
CHART_HISTORY_DAYS = 42
SELECTION_FOLDS = 3
MIN_TRAINING_DAYS = 28


def analyze(source, horizon):
    history = parse_history(source)
    required_days = MIN_TRAINING_DAYS + horizon * (SELECTION_FOLDS + 1)
    if any(len(series.units) >= required_days for series in history.values()):
        report = evaluate(history, horizon, SELECTION_FOLDS, MIN_TRAINING_DAYS)
    else:
        report = {
            "horizon": horizon,
            "selected_model": BASELINE,
            "baseline_model": BASELINE,
            "selection_folds": [],
            "selection_scores": {},
            "holdout": None,
            "required_history_days": required_days,
        }
    predictions = predict(history, horizon, report["selected_model"])
    cutoff = next(iter(history.values())).end
    return {
        "report": report,
        "cutoff": cutoff.isoformat(),
        "forecast_dates": [(cutoff + offset * DAY).isoformat() for offset in range(1, horizon + 1)],
        "series": [
            {
                "id": series_id,
                "history": history[series_id].units[-CHART_HISTORY_DAYS:],
                "forecast": values,
            }
            for series_id, values in predictions.items()
        ],
    }


class DashboardHandler(BaseHTTPRequestHandler):
    def send_data(self, status, kind, data):
        self.send_response(status)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, value):
        data = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
        self.send_data(status, "application/json", data)

    def do_GET(self):
        asset = ASSETS.get(urlsplit(self.path).path)
        if asset is None:
            self.send_error(404)
            return
        name, kind = asset
        self.send_data(200, kind, (WEB / name).read_bytes())

    def do_POST(self):
        request = urlsplit(self.path)
        if request.path != "/api/analyze":
            self.send_error(404)
            return
        try:
            params = parse_qs(request.query)
            horizon = int(params.get("horizon", ["14"])[0])
            if horizon not in HORIZONS:
                raise ValueError("Choose a 7, 14, or 28 day forecast horizon.")
            source_type = params.get("source", ["upload"])[0]
            if source_type == "demo":
                source = io.StringIO(newline="")
                write_demo(source)
                source.seek(0)
            elif source_type == "retail":
                source = io.StringIO(RETAIL_SAMPLE.read_text(encoding="utf-8"), newline="")
            elif source_type == "upload":
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_UPLOAD:
                    raise ValueError("Choose a nonempty CSV file up to 10 MiB.")
                content = self.rfile.read(length)
                try:
                    source = io.StringIO(content.decode("utf-8-sig"), newline="")
                except UnicodeDecodeError as error:
                    raise ValueError("Save the CSV as UTF-8 and try again.") from error
            else:
                raise ValueError("Choose a sample dataset or upload a CSV.")
            self.send_json(200, analyze(source, horizon))
        except (ValueError, ArithmeticError, csv.Error) as error:
            self.send_json(400, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            # A new selection can cancel a previous browser request.
            return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), DashboardHandler) as server:
        print(f"Retail Forecaster is ready at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
