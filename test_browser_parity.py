"""Check that offline reports and forecasts match the Python dashboard."""

import csv
import io
import json
import math
import subprocess
import unittest
from datetime import date, timedelta
from pathlib import Path

from make_demo import write_demo
from serve import analyze


WEB = Path(__file__).parent / "web"
RUN_BROWSER_ENGINE = """
const fs = require('node:fs');
const vm = require('node:vm');
const source = process.argv.slice(1).map(path => fs.readFileSync(path, 'utf8')).join('\\n');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const data = vm.runInNewContext(source + '\\nanalyzeRetailCsv(input.csv, input.horizon)', {input});
  process.stdout.write(JSON.stringify({data}));
} catch (error) {
  process.stdout.write(JSON.stringify({error: error.message}));
}
"""


def browser_result(history, horizon):
    run = subprocess.run(
        ["node", "-e", RUN_BROWSER_ENGINE, str(WEB / "csv.js"), str(WEB / "forecast-engine.js")],
        input=json.dumps({"csv": history, "horizon": horizon}),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(run.stdout)


class BrowserParity(unittest.TestCase):
    def assert_matching_values(self, expected, actual, path="forecast"):
        if isinstance(expected, dict):
            self.assertEqual(expected.keys(), actual.keys(), path)
            for key in expected:
                self.assert_matching_values(expected[key], actual[key], f"{path}.{key}")
        elif isinstance(expected, list):
            self.assertEqual(len(expected), len(actual), path)
            for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
                self.assert_matching_values(left, right, f"{path}[{index}]")
        elif isinstance(expected, float):
            self.assertTrue(math.isclose(expected, actual, rel_tol=1e-12, abs_tol=1e-12), path)
        else:
            self.assertEqual(expected, actual, path)

    def compare(self, history, horizon):
        server_result = analyze(io.StringIO(history.removeprefix("\ufeff"), newline=""), horizon)
        expected = json.loads(json.dumps(server_result, allow_nan=False))
        reply = browser_result(history, horizon)
        self.assertNotIn("error", reply)
        self.assert_matching_values(expected, reply["data"])
        return reply["data"]

    def test_bundled_sample_for_each_horizon(self):
        source = io.StringIO(newline="")
        write_demo(source)
        for horizon in (7, 14, 28):
            with self.subTest(horizon=horizon):
                self.compare(source.getvalue(), horizon)

    def test_quoted_ids_zero_sales_and_different_start_dates(self):
        end = date(2026, 11, 1)
        source = io.StringIO(newline="")
        writer = csv.writer(source)
        writer.writerow(["date", "series_id", "units", "ignored"])
        for series_id, length in [('Store, "A"\r\nItem 3', 140), ("__proto__", 52), ("小店", 5)]:
            for offset in range(length):
                writer.writerow([end - timedelta(days=offset), series_id, 0, "note"])
        data = self.compare("\ufeff" + source.getvalue(), 28)
        self.assertIsNone(data["report"]["holdout"]["selected"]["wape"])
        self.assertEqual(data["report"]["holdout"]["series_count"], 1)

    def test_short_history_produces_a_baseline(self):
        history = "series_id,date,units\nA,2026-11-01,2\nA,2026-11-02,0\n"
        data = self.compare(history, 14)
        self.assertEqual(data["series"][0]["forecast"], [1] * 14)
        self.assertEqual(data["report"]["required_history_days"], 84)
        self.assertIsNone(data["report"]["holdout"])

    def test_changing_reserved_sales_leaves_replay_forecasts_and_opening_inputs_fixed(self):
        def history(actual):
            source = io.StringIO(newline="")
            writer = csv.writer(source)
            writer.writerow(["series_id", "date", "units"])
            start = date(2026, 7, 1)
            for offset in range(84):
                units = 1 + offset % 7 if offset < 70 else actual
                writer.writerow(["One item", start + timedelta(days=offset), units])
            return source.getvalue()

        before = self.compare(history(5), 14)["report"]["holdout"]["replay"][0]
        after = self.compare(history(70), 14)["report"]["holdout"]["replay"][0]
        self.assertNotEqual(before["actual"], after["actual"])
        for field in ("group", "training_daily_mean", "selected", "baseline"):
            self.assertEqual(before[field], after[field], field)

    def test_invalid_rows_report_the_problem(self):
        cases = {
            "A,2026-02-31,1": "valid date",
            "A,2026-11-01,-2": "finite and nonnegative",
            "A,2026-11-01,": "finite and nonnegative",
            "A,2026-11-01,1\nA,2026-11-01,2": "duplicate observation",
            "A,2026-11-01,1\nA,2026-11-03,2": "missing 2026-11-02",
            "A,2026-11-01,1\nB,2026-11-02,2": "same date",
            '"A,2026-11-01,1': "closing quote",
        }
        for rows, issue in cases.items():
            with self.subTest(issue=issue):
                self.assertIn(issue, browser_result("series_id,date,units\n" + rows, 14)["error"])


if __name__ == "__main__":
    unittest.main()
