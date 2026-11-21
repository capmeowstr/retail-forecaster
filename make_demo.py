"""Generate daily synthetic retail sales with sparse items and weekly seasonality."""

import argparse
import csv
import random
from datetime import date, timedelta
from pathlib import Path


def write_demo(target):
    random_source = random.Random(20261120)
    first_day = date(2026, 5, 4)
    weekday_multiplier = (0.84, 0.78, 0.88, 0.97, 1.12, 1.33, 1.08)
    writer = csv.writer(target)
    writer.writerow(["series_id", "date", "units"])
    for item in range(24):
        for offset in range(item % 4 * 7, 168):
            day = first_day + timedelta(days=offset)
            pattern = weekday_multiplier[day.weekday()]
            if item < 8:
                level = (12 + 3 * item + 0.04 * offset) * pattern
                units = max(0, round(random_source.gauss(level, 4)))
            else:
                units = random_source.randint(1, 6) if random_source.random() < 0.16 * pattern else 0
            writer.writerow([f"demo-{item + 1:02d}", day.isoformat(), units])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.output.open("w", newline="", encoding="utf-8") as target:
        write_demo(target)


if __name__ == "__main__":
    main()
