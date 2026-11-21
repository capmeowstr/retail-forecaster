"""Command-line retail demand forecasting for daily item or item-store histories."""

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path


DAY = timedelta(days=1)
MODELS = ("seasonal-naive", "recent-mean", "weekday-mean", "pooled-weekday")
BASELINE = MODELS[0]


@dataclass(frozen=True)
class Series:
    end: date
    units: tuple[float, ...]


def read_history(path):
    with path.open(newline="", encoding="utf-8-sig") as source:
        return parse_history(source)


def parse_history(source):
    observations = defaultdict(dict)
    rows = csv.DictReader(source)
    required = {"series_id", "date", "units"}
    if not required.issubset(rows.fieldnames or ()):
        raise ValueError("history must have series_id, date, and units columns")
    if len(set(rows.fieldnames)) != len(rows.fieldnames):
        raise ValueError("history contains duplicate column names")
    for row in rows:
        try:
            if None in row:
                raise ValueError("too many fields")
            series_id = (row["series_id"] or "").strip()
            if not series_id:
                raise ValueError("series_id is blank")
            day = date.fromisoformat(row["date"] or "")
            if day.isoformat() != row["date"]:
                raise ValueError("dates must use YYYY-MM-DD")
            units = float(row["units"] or "")
            if not math.isfinite(units) or units < 0:
                raise ValueError("units must be finite and nonnegative")
            if day in observations[series_id]:
                raise ValueError(f"duplicate observation for {series_id!r} on {day}")
        except ValueError as error:
            raise ValueError(f"CSV line {rows.line_num}: {error}") from error
        observations[series_id][day] = units

    if not observations:
        raise ValueError("history has no data rows")
    history = {}
    for series_id, entries in sorted(observations.items()):
        days = sorted(entries)
        for previous, current in zip(days, days[1:]):
            if current - previous != DAY:
                raise ValueError(f"{series_id!r} is missing {previous + DAY}; add a row for each day")
        history[series_id] = Series(days[-1], tuple(entries[day] for day in days))

    if len({series.end for series in history.values()}) != 1:
        raise ValueError("all series must end on the same date")
    return history


def average(values):
    return math.fsum(values) / len(values)


def weekly_profile(history):
    totals = [0.0] * 7
    for series in history.values():
        weeks = min(8, len(series.units) // 7)
        if weeks:
            first_weekday = (series.end.weekday() + 1) % 7
            for offset, units in enumerate(series.units[-7 * weeks :]):
                totals[(first_weekday + offset) % 7] += units
    level = average(totals)
    return [total / level for total in totals] if level else [1.0] * 7


def predict(history, horizon, model):
    if model not in MODELS:
        raise ValueError(f"unknown model {model!r}")
    pooled = weekly_profile(history) if model == "pooled-weekday" else None
    results = {}
    for series_id, series in history.items():
        units = series.units
        next_weekday = (series.end.weekday() + 1) % 7
        if model == "seasonal-naive" and len(units) >= 7:
            pattern = units[-7:]
        elif model == "weekday-mean":
            recent = units[-56:]
            level = average(recent)
            by_day = [recent[offset::7] for offset in range(7)]
            first_weekday = (next_weekday - len(recent)) % 7
            means = [
                (math.fsum(bucket) + 2 * level) / (len(bucket) + 2)
                for bucket in by_day
            ]
            pattern = [means[(next_weekday + offset - first_weekday) % 7] for offset in range(7)]
        elif model == "pooled-weekday":
            full_weeks = min(4, len(units) // 7)
            level = average(units[-7 * full_weeks :] if full_weeks else units)
            pattern = [level * pooled[(next_weekday + offset) % 7] for offset in range(7)]
        else:
            window = 7 if model == "seasonal-naive" else 28
            pattern = [average(units[-window:])] * 7
        results[series_id] = [pattern[offset % 7] for offset in range(horizon)]
    return results


@dataclass(frozen=True)
class Fold:
    training: dict[str, Series]
    actual: dict[str, tuple[float, ...]]
    cutoff: date
    horizon: int


def make_fold(history, horizon, windows_from_end, min_training_days):
    skipped = horizon * windows_from_end
    actual = {}
    training = {}
    cutoff = next(iter(history.values())).end - (skipped + horizon) * DAY
    for series_id, series in history.items():
        test_start = len(series.units) - skipped - horizon
        if test_start >= min_training_days:
            training[series_id] = Series(cutoff, series.units[:test_start])
            actual[series_id] = series.units[test_start : test_start + horizon]
    if not training:
        raise ValueError(
            f"no series has {min_training_days} training days at cutoff {cutoff}; "
            "use more history, a smaller horizon, or fewer folds"
        )
    return Fold(training, actual, cutoff, horizon)


@dataclass
class Errors:
    abs_error: float = 0.0
    actual_units: float = 0.0
    observations: int = 0
    forecast_units: float = 0.0

    def add(self, other):
        self.abs_error += other.abs_error
        self.actual_units += other.actual_units
        self.observations += other.observations
        self.forecast_units += other.forecast_units

    def metrics(self):
        return {
            "mae": self.abs_error / self.observations,
            "wape": self.abs_error / self.actual_units if self.actual_units else None,
            "observations": self.observations,
            "unit_bias": (
                (self.forecast_units - self.actual_units) / self.actual_units
                if self.actual_units
                else None
            ),
        }


def series_errors(fold, model, forecasts=None):
    if forecasts is None:
        forecasts = predict(fold.training, fold.horizon, model)
    for series_id, actual in fold.actual.items():
        pairs = zip(actual, forecasts[series_id], strict=True)
        yield series_id, Errors(
            math.fsum(abs(observed - predicted) for observed, predicted in pairs),
            math.fsum(actual),
            len(actual),
            math.fsum(forecasts[series_id]),
        )


def score(fold, model):
    errors = Errors()
    for _, item_errors in series_errors(fold, model):
        errors.add(item_errors)
    return errors


def summarize_holdout(fold, selected_model, total_series):
    groups = {}
    for series_id, series in fold.training.items():
        recent = series.units[-56:]
        positive_days = sum(units > 0 for units in recent)
        groups[series_id] = "sparse" if 2 * positive_days < len(recent) else "regular"

    counts = Counter(groups.values())
    slices = {group: {"series_count": counts[group]} for group in sorted(counts)}
    scored_models = {}
    holdout_forecasts = {}
    selected_by_series = {}
    for model in dict.fromkeys((selected_model, BASELINE)):
        forecasts = predict(fold.training, fold.horizon, model)
        holdout_forecasts[model] = forecasts
        overall = Errors()
        by_group = {group: Errors() for group in slices}
        for series_id, item_errors in series_errors(fold, model, forecasts):
            overall.add(item_errors)
            by_group[groups[series_id]].add(item_errors)
            if model == selected_model:
                selected_by_series[series_id] = {
                    "actual_units": item_errors.actual_units,
                    "forecast_units": item_errors.forecast_units,
                }
        scored_models[model] = (overall, by_group)

    summary = {
        "cutoff": fold.cutoff.isoformat(),
        "forecast_start": (fold.cutoff + DAY).isoformat(),
        "forecast_end": (fold.cutoff + fold.horizon * DAY).isoformat(),
        "series_count": len(fold.training),
        "total_series": total_series,
        "slices": slices,
        "selected_by_series": selected_by_series,
        "replay": [
            {
                "id": series_id,
                "group": groups[series_id],
                "training_daily_mean": average(series.units[-28:]),
                "actual": fold.actual[series_id],
                "selected": holdout_forecasts[selected_model][series_id],
                "baseline": holdout_forecasts[BASELINE][series_id],
            }
            for series_id, series in fold.training.items()
        ],
    }
    for label, model in (("selected", selected_model), ("baseline", BASELINE)):
        overall, by_group = scored_models[model]
        summary[label] = overall.metrics()
        for group, errors in by_group.items():
            slices[group][label] = errors.metrics()
    return summary


def evaluate(history, horizon, folds, min_training_days):
    totals = {model: Errors() for model in MODELS}
    fold_reports = []
    for windows_from_end in range(folds, 0, -1):
        fold = make_fold(history, horizon, windows_from_end, min_training_days)
        scores = {model: score(fold, model) for model in MODELS}
        for model, errors in scores.items():
            totals[model].add(errors)
        fold_reports.append({
            "cutoff": fold.cutoff.isoformat(),
            "series_count": len(fold.training),
            "scores": {model: errors.metrics() for model, errors in scores.items()},
        })

    # All models use identical rows. Minimizing total absolute error also minimizes
    # WAPE when demand is positive, and still ranks models on all-zero windows.
    best = min(MODELS, key=lambda model: totals[model].abs_error)
    holdout = make_fold(history, horizon, 0, min_training_days)
    return {
        "horizon": horizon,
        "selected_model": best,
        "baseline_model": BASELINE,
        "selection_folds": fold_reports,
        "selection_scores": {model: errors.metrics() for model, errors in totals.items()},
        "holdout": summarize_holdout(holdout, best, len(history)),
    }


def write_forecast(path, history, horizon, model):
    predictions = predict(history, horizon, model)
    first_day = next(iter(history.values())).end + DAY
    forecast_days = [first_day + offset * DAY for offset in range(horizon)]
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(["series_id", "date", "forecast_units"])
        for series_id, values in predictions.items():
            for day, value in zip(forecast_days, values, strict=True):
                writer.writerow([series_id, day.isoformat(), format(value, ".12g")])


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("evaluate", help="compare models with time-ordered backtests")
    generate = commands.add_parser("predict", help="forecast the days following the input history")
    for command in (validate, generate):
        command.add_argument("history", type=Path, help="CSV with series_id, date, and units")
        command.add_argument("--horizon", required=True, type=positive_int)
    validate.add_argument("--folds", type=positive_int, default=3, help="selection windows before the holdout")
    validate.add_argument("--min-training-days", type=positive_int, default=28)
    validate.add_argument("--report", type=Path, help="write JSON to this path instead of stdout")
    generate.add_argument("--model", choices=MODELS, required=True)
    generate.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        destination = args.report if args.command == "evaluate" else args.output
        if destination and destination.resolve() == args.history.resolve():
            raise ValueError("output path must differ from the input history path")
        history = read_history(args.history)
        if args.command == "evaluate":
            report = evaluate(history, args.horizon, args.folds, args.min_training_days)
            content = json.dumps(report, indent=2, allow_nan=False) + "\n"
            if args.report:
                args.report.write_text(content, encoding="utf-8")
            else:
                print(content, end="")
        else:
            write_forecast(args.output, history, args.horizon, args.model)
    except (OSError, ValueError, ArithmeticError, csv.Error) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    main()
