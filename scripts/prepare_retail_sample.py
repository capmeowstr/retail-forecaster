"""Build the bundled daily sales sample from UCI Online Retail (CC BY 4.0)."""

import argparse
import csv
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zipfile import ZipFile


START = date(2010, 12, 1)
END = date(2011, 12, 8)
RANK_THROUGH = END - timedelta(days=28)
RECENT_START = RANK_THROUGH - timedelta(days=55)
ITEMS_PER_GROUP = 12
STOCK_CODE = re.compile(r"[0-9]{5}[A-Z]{0,2}")


def read_daily_sales(archive_path):
    from openpyxl import load_workbook

    daily = defaultdict(Counter)
    with ZipFile(archive_path) as archive, archive.open("Online Retail.xlsx") as source:
        book = load_workbook(source, read_only=True, data_only=True)
        try:
            rows = iter(book.active.values)
            columns = next(rows)
            indexes = [columns.index(name) for name in (
                "InvoiceNo", "StockCode", "Quantity", "InvoiceDate", "Country",
            )]
            for row in rows:
                invoice, stock, units, timestamp, country = (row[index] for index in indexes)
                if country != "United Kingdom" or str(invoice).upper().startswith("C"):
                    continue
                code = str(stock).strip().upper()
                if not STOCK_CODE.fullmatch(code) or not isinstance(timestamp, datetime):
                    continue
                day = timestamp.date()
                if START <= day <= END and isinstance(units, (int, float)) and units > 0:
                    daily[code][day] += int(units)
        finally:
            book.close()
    return daily


def choose_series(daily):
    regular, sparse = [], []
    for code, sales in daily.items():
        training_total = sum(units for day, units in sales.items() if day <= RANK_THROUGH)
        if training_total == 0:
            continue
        active_days = sum(RECENT_START <= day <= RANK_THROUGH for day in sales)
        group = regular if active_days >= 28 else sparse
        group.append((-training_total, code))
    chosen = sorted(regular)[:ITEMS_PER_GROUP] + sorted(sparse)[:ITEMS_PER_GROUP]
    if len(chosen) != 2 * ITEMS_PER_GROUP:
        raise ValueError("Expected 12 regular and 12 sparse products in the source workbook.")
    return sorted(code for _, code in chosen)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="UCI online+retail.zip")
    parser.add_argument("output", type=Path, help="Daily sales CSV destination")
    args = parser.parse_args()
    if args.archive.resolve() == args.output.resolve():
        parser.error("Choose an output path different from the source archive.")
    try:
        daily = read_daily_sales(args.archive)
    except ModuleNotFoundError as error:
        if error.name != "openpyxl":
            raise
        parser.exit(1, "Install openpyxl to rebuild the included retail sample.\n")
    days = [START + timedelta(days=offset) for offset in range((END - START).days + 1)]
    with args.output.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(["series_id", "date", "units"])
        for code in choose_series(daily):
            writer.writerows((code, day.isoformat(), daily[code][day]) for day in days)


if __name__ == "__main__":
    main()
