# Retail Forecaster methodology

## Inputs

Files are processed in the offline browser or by the server bound to localhost. Each input can be up to 10 MiB. Uploads are kept in memory for the current session.

```csv
series_id,date,units
store-a:item-123,2026-11-01,6
store-a:item-123,2026-11-02,0
```

Use one row per series and date. Dates are YYYY-MM-DD. Sales must be finite and nonnegative. Include a zero for each observed zero-sales day. Series can begin on different dates and must end on the same date.

```csv
series_id,on_hand,lead_days,cover_days,pack_size,supplier,stock_date,safety_stock
store-a:item-123,50,2,7,12,Example Supplier,2026-11-03,10
```

Inventory IDs match sales IDs. Opening stock is measured at the start of the first forecast day. If supplied, `stock_date` must match that day. A blank `on_hand` means stock is unknown. Lead time defaults to 0 days, coverage to 7 days, pack size to 1, and safety stock reference to 0. These inputs take whole numbers. A supplier name makes the SKU searchable by supplier.

## Forecasts

| Method | Computation |
| --- | --- |
| Weekly baseline (`seasonal-naive`) | Repeat the last seven days. Use their mean when fewer than seven days are available. |
| Recent mean (`recent-mean`) | Average the last 28 days, or all available days if shorter. |
| Item weekday mean (`weekday-mean`) | Over the last 56 days, each weekday estimate is (sum for weekday + 2 × item mean) / (weekday observation count + 2). |
| Pooled weekday (`pooled-weekday`) | Pool weekday totals over up to eight complete weeks per item and divide by the mean of those seven totals. Multiply the weekday factor by each item's mean over up to four complete weeks. With a zero pooled mean the factors are 1. An item with less than one week uses its available days for its mean. |

The dashboard uses three chronological selection windows of length H, followed by a reserved H-day holdout. Every fit uses data through the cutoff preceding its window. Series need at least 28 training days at the cutoff to enter the corresponding fold. The dashboard needs at least one series with 28 + 4H days to start model selection. For shorter histories it uses the weekly baseline with its short-history mean fallback.

Selection minimizes total absolute error across the three windows, with ties settled by model order in the table. MAE is total absolute error divided by item-days. WAPE is total absolute error divided by total observed units. Unit bias is (total forecast − total observed) / total observed. WAPE and bias are undefined when total observed units are zero. In the holdout report, a series is sparse when fewer than half of its last 56 available training days have positive sales. The final forward forecast uses all observations through the current cutoff.

[`forecast.py`](../forecast.py) defines the reference models. The local server calls it directly. [`web/forecast-engine.js`](../web/forecast-engine.js) supports uploads in the offline build. [`tests/test_browser_parity.py`](../tests/test_browser_parity.py) checks report keys, array order, discrete values, and floating-point values to `1e-12` absolute and relative tolerance. The offline build uses precomputed reference forecasts for the two bundled datasets.

### Synthetic holdout

The [evaluation fixture](../tests/fixtures/demo-evaluation.json) uses 5–18 October 2026 and selects the pooled weekday model.

| Series | Selected WAPE | Weekly WAPE |
| --- | ---: | ---: |
| All 24 | 18.12% | 25.36% |
| 8 regular | 12.01% | 17.96% |
| 16 sparse | 156.86% | 193.53% |

The sparse segment exceeds 100% WAPE under both methods. The weekly baseline also has smaller absolute error for demo-05 (44 vs 45.42 units over the holdout) and demo-14 (11 vs 16.71 units).

## Reorder

Let S be opening units, L be scheduled lead days plus the delay, C be post-delivery coverage days, and P be units per pack. Let Dlead be forecast units over days 1 through L and Dcover be forecast units over days L+1 through L+C.

- Pre-delivery shortage = max(0, Dlead − S). Stock at delivery = max(0, S − Dlead).
- Draft units = P × ceil(max(0, Dcover − stock at delivery − 1e-9) / P). A candidate draft needs L+C days. The receipt is available before sales on day L+1.
- The displayed reorder point is Dlead + safety stock. Safety stock is an optional user-entered reference, with a default of zero. Neither reference changes the draft. The reorder point is omitted when the receipt falls outside the plotted horizon.
- The calendar counts the first forecast shortage before delivery for each SKU. In the chart, each daily forecast consumes stock at the end of its day. A draft receipt adds stock at the beginning of the delivery day. The sensitivity band reruns the same draft at max(0, daily forecast ± SKU holdout MAE), with the receipt fixed. It is a scenario range, with no calibrated coverage level.

CSV exports include fractional expected units where relevant. Spreadsheet-formula-like names and IDs are prefixed with an apostrophe.

## Replay

Opening stock is ceil(mean sales over the 28 days preceding the holdout × opening days − 1e-9), floored at zero. Both forecasts use identical opening stock, delivery day, and pack size. Each receives one order. Simulated daily closing stock is max(0, opening + receipt − observed sales). Simulated missed units are max(0, observed sales − opening − receipt), with gaps up to 1e-9 ignored. Fill rate is (observed units − missed units) / observed units. The chart sums daily closing stock across eligible SKUs and marks days with any simulated shortage.

The shared unit cap is the smaller unrestricted draft across the two forecasts. Each plan allocates whole packs by expected sales covered per pack, then projected shortage day, then SKU. Unrestricted replay uses each plan's original draft. The impact view reports selected minus weekly baseline, sorted by absolute missed-unit change. The export includes every eligible SKU.

### Recorded sales replay

Each run uses 24 UCI products, four opening days, two lead days, and twelve units per pack. The two 14-day windows are disjoint. The 7- and 28-day windows overlap the later 14-day window.

| Holdout in 2011 | Ordered units per plan | Selected missed | Weekly missed | Selected end stock | Weekly end stock |
| --- | ---: | ---: | ---: | ---: | ---: |
| 11–24 Nov | 16,068 | 5,125 | 5,697 | 5,003 | 5,575 |
| 2–8 Dec | 3,144 | 4,550 | 5,118 | 912 | 1,480 |
| 25 Nov–8 Dec | 15,276 | 4,030 | 4,638 | 3,655 | 4,263 |
| 11 Nov–8 Dec | 38,400 | 10,696 | 10,162 | 10,282 | 9,748 |

The unrestricted version of the later 14-day replay missed 1,606 fewer units and ordered 2,244 more. These are simulated outcomes on sales from one shop. Equal units ordered can still imply different spend across SKUs.

## Data and license

The [UCI Online Retail dataset](https://doi.org/10.24432/C5BW33) by Daqing Chen includes wholesale customers and is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The sample groups positive UK invoice quantities by product and day. It drops cancellations, returns, and the partial final date. Product ranking uses data through 10 November 2011, with twelve regular and twelve sparse products. Only daily totals are distributed.

Wholesale bulk invoices can distort the daily pattern. True stockouts, lost orders, replenishment and purchase costs are unobserved. A zero in the sample means no recorded positive sale. The software is [MIT-licensed](../LICENSE).

## Reproduce

```sh
python3 -m scripts.make_demo history.csv
python3 forecast.py evaluate history.csv --horizon 14 --report evaluation.json
python3 forecast.py predict history.csv --horizon 14 --model pooled-weekday --output forecast.csv
```

The UCI fixture builder requires openpyxl 3.1.5 and the [source ZIP](https://archive.ics.uci.edu/static/public/352/online+retail.zip).

```sh
python3 -m scripts.prepare_retail_sample online+retail.zip sample-data/uci-retail.csv
```

To recapture the documentation images, install Pillow, Playwright, and Chromium in a development environment.

```sh
python3 -m pip install pillow playwright
python3 -m playwright install chromium
python3 -m scripts.capture_previews
```
