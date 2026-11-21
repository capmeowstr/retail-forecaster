# Retail Forecaster

Forecast daily sales, draft purchase quantities, and replay orders on held-out sales. Compare two forecasts under the same order-unit limit to see where they allocate stock differently and which sales each plan serves.

In the 14-day public retail example, both plans order 15,276 units. The selected plan misses 608 fewer simulated units. In the 28-day example, it misses 534 more. The dashboard shows both outcomes and the products behind them.

## Open the browser dashboard

Download the raw [Retail_Forecaster_Demo.html](Retail_Forecaster_Demo.html) file and open it in a browser. Start with the synthetic demo or select **Retail sample** for recorded UK retailer sales with illustrative stock. Choose your own UTF-8 sales and inventory CSVs up to 10 MiB each. Forecasts, reorder planning, inventory replay, and exports work offline. The app keeps data in the browser session.

The optional local Python dashboard uses Python 3.10 or newer and the standard library.

```sh
python3 serve.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765) on the same computer. The dashboard starts with synthetic data. The local Python process forecasts sales in memory. Inventory CSVs and the order plan stay in your browser.

Select an item in the reorder board or in the chart's series selector to inspect its forecast and settings. Hover over the chart or focus it and press the arrow keys to inspect a day. The forecast export includes every series and uses the forecast's full precision. The dashboard prefixes an apostrophe to spreadsheet-formula-like names and IDs in exported CSVs.

## Plan replenishment

1. Import daily sales and select a 7-, 14-, or 28-day horizon.
2. Import the opening inventory counted as of the first forecast date. Match each inventory `series_id` to a series in the sales file. You can also select an item and save its settings directly.
3. Review items sorted by action and first projected shortage date. Items marked **Expedite** have a projected shortage before scheduled delivery. **Order** shows stock needed for the days after delivery. Use **Simulate delivery delay** to see how later arrivals change the plan.
4. Download the order draft to review all positive quantities for the current scenario. A delay scenario includes the extra days in the filename and CSV.

```csv
series_id,on_hand,lead_days,cover_days,pack_size,supplier,stock_date
store-a:item-123,50,2,7,12,Example Supplier,2026-11-03
```

`series_id` and `on_hand` are required columns. Enter a whole count of zero or more. A blank count produces **Missing stock**. Optional values default to zero lead days, seven coverage days, and one unit per pack. Include `stock_date` in YYYY-MM-DD format to check that the count matches the first forecast day. Supplying an optional `supplier` adds the name to the board and export.

Lead time counts full days before delivery. For example, with a Monday forecast start and two lead days, delivery is available before Wednesday sales. The forecast needs to cover all lead days plus the coverage days starting on delivery to calculate an order. Shortages visible in the available days still appear if the order needs a longer forecast. The plan assumes one incoming order. The regular draft covers the post-delivery requirement, rounded up to whole packs.

The item holdout note compares forecast and observed sales totals for that item over a reserved period. Bias and WAPE are unavailable when the observed total is zero. Use the projections as estimates based on the recorded sales and the stock inputs.

## 75-second demo

Open the file with the default 14-day sample. Select `demo-01` and compare **No delay** with **2 days later**.

| Scenario | Arrival | Action | Short before arrival | Draft order |
|---|---|---|---|---:|
| No delay | 21 Oct 2026 | Order | 0 units | 9 packs / 108 units |
| Two-day delay | 23 Oct 2026 | Expedite | 11.27 units | 11 packs / 132 units |

Download the scenario CSV to show the supplier, delivery date, shortfall, and pack quantities. Scroll to Holdout performance to see how the synthetic sales forecast scored on reserved dates.

Select **Retail sample**, then **View inventory replay**. Both plans order 15,276 units under **Shared unit limit**. The selected forecast misses 4,030 units versus 4,638 for repeating last week. Open the item breakdown to see which products contributed to the difference. Switch to 28 days to see the weekly baseline serve more units under that horizon's shared limit.

## Inventory replay

The replay starts at the reserved historical window. The selected model uses earlier validation windows to choose a forecasting method. Both it and the weekly baseline generate their order forecasts using sales available before the first holdout date.

Both methods receive the same opening stock, calculated from the prior 28-day average times the chosen stock days, rounded up to a whole unit. They use the same lead time and pack size. The planner orders to cover the remaining days after one delivery. The replay then consumes recorded sales day by day, adding the order before sales on the delivery date. Sales beyond available stock count as missed units. The sales fill rate is the share of observed units the simulated stock covers.

**Shared unit limit** uses the smaller total of the two unrestricted orders. At that limit, both plans buy the same total number of units. Each forecast allocates its packs by the predicted sales a pack can cover after delivery, favoring earlier shortages when that estimate ties. Pack allocation uses forecasts only. **Unrestricted** allows each forecast to order to cover its full projected demand. Comparing purchasing spend requires supplier costs.

The settings can be applied across eligible items or to the regular and sparse groups. The replay shows the eight largest item changes, ordered by absolute difference in missed units. The CSV gives the policy, unit limit, and each product's opening stock, order quantities, missed units, and ending stock. Opening stock and delivery terms are simulated. The source data contains recorded sales and lacks actual inventory histories and unmet demand.

### Public retail results

These matched quantities use all 24 products with four days of opening stock, two days of lead time, and 12 units per pack. The 7-, 14-, and 28-day windows ending on 8 December overlap. The two 14-day periods are disjoint, with the forecasts refit before each period.

| Held-out dates, 2011 | Units ordered per plan | Selected missed units | Weekly missed units | Selected ending stock | Weekly ending stock |
|---|---:|---:|---:|---:|---:|
| 11–24 November | 16,068 | 5,125 | 5,697 | 5,003 | 5,575 |
| 2–8 December | 3,144 | 4,550 | 5,118 | 912 | 1,480 |
| 25 November–8 December | 15,276 | 4,030 | 4,638 | 3,655 | 4,263 |
| 11 November–8 December | 38,400 | 10,696 | 10,162 | 10,282 | 9,748 |

The unrestricted 25 November–8 December replay missed 1,606 fewer units while ordering 2,244 more units. With matched quantities it missed 608 fewer units. The test suite reproduces both policies on both 14-day windows.

Further validation needs additional retailers and actual inventory, receipt, and purchase cost histories.

The bundled `sample-data/uci-retail.csv` adapts *Online Retail* by Daqing Chen (2015), UCI Machine Learning Repository, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Dataset DOI](https://doi.org/10.24432/C5BW33)

The preparation script aggregates positive UK invoice quantities for five-digit merchandise codes with optional letters. It excludes cancellations and the final partial date and sets days without recorded sales to zero. Product selection uses data through 10 November 2011, before the longest reserved window. It ranks by units sold and takes 12 products with regular sales and 12 with sparse sales. Only daily product totals are distributed.

Rebuild the sample from the [UCI archive](https://archive.ics.uci.edu/static/public/352/online+retail.zip) with `python3 prepare_retail_sample.py online+retail.zip sample-data/uci-retail.csv`. This preparation step requires openpyxl.

## Run the command-line demo

```sh
python3 make_demo.py history.csv
python3 forecast.py evaluate history.csv --horizon 14 --report evaluation.json
python3 forecast.py predict history.csv --horizon 14 --model pooled-weekday --output forecast.csv
python3 make_preview.py Retail_Forecaster_Demo.html
```

With Node.js installed, run `python3 -m unittest test_browser_parity` to compare the offline and Python forecasts. Run `node --test test_reorder.js test_replay.js` to verify arrival timing, pack rounding, delay scenarios, and the replay's treatment of held-out sales.

The supplied demo creates 24 sales histories. With this seed, the pooled weekday model wins the three selection windows. On the reserved 14-day holdout from 5 to 18 October 2026, its WAPE is **18.12%**, compared with **25.36%** for the seasonal baseline. `demo-evaluation.json` contains the per-window scores and the breakdown by sales pattern. These figures measure the synthetic demo only.

## Use your own history

The input is a CSV with one row per series per day, ISO dates, and finite nonnegative sales. Series may have different start dates and must share a last observed date. Record observed zero sales as `0`. The program rejects gaps and duplicates so missing records cannot silently affect the estimates.

```csv
series_id,date,units
store-a:item-123,2026-11-01,6
store-a:item-123,2026-11-02,0
```

`evaluate` defaults to three model-selection windows followed by one reserved holdout. Each window lasts `--horizon` days. A series must have at least `--min-training-days` days available before each cutoff to be scored in that window. The default is 28. A fold with no eligible series is reported as an error. The model is selected by total absolute error over the selection windows, and the report gives both MAE and WAPE. WAPE is recorded as `null` if the actual sales total is zero.

The dashboard needs at least one series with 28 days of training plus four full forecast windows to compare models. That works out to 56 days of sales history for a 7-day forecast, 84 days for a 14-day forecast, and 140 days for a 28-day forecast. With less history, the dashboard uses the seasonal baseline and leaves accuracy metrics blank. The baseline repeats the latest seven observations or averages the available days if there are fewer than seven.

Holdout coverage shows how many series contributed to the reported accuracy. A series is classified as sparse if it records positive sales on fewer than half of the last 56 available training days before the holdout.

Use the report's `selected_model` as the `--model` argument to `predict`. The forecast is fit on all supplied history and written with `series_id,date,forecast_units` columns. Predictions are expected units and can be fractional.

The models estimate recorded sales. Estimating demand lost to stockouts requires inventory availability data.

## Forecast comparison

Both versions were evaluated on the same synthetic histories and the same reserved 14-day windows. Models were selected using earlier dates. The separate mixed-calendar fixture had 28 items, of which 24 had enough history for the holdout.

| Test and group | Previous WAPE | Current WAPE | Current unit bias |
|---|---:|---:|---:|
| Bundled sample, overall | 18.12% | 18.12% | −0.65% |
| Bundled sample, regular | 12.01% | 12.01% | +0.25% |
| Bundled sample, sparse | 156.86% | 156.86% | −21.22% |
| Mixed-calendar fixture, overall | 21.45% | 21.45% | −0.86% |
| Mixed-calendar fixture, regular | 15.37% | 15.37% | −1.61% |
| Mixed-calendar fixture, sparse | 132.75% | 132.75% | +12.80% |

The review tested two alternatives that select models by sales pattern, one with a separate estimate of sale frequency and sale size. Candidates were picked on three older windows and tested on three later windows, with the final holdout reserved. A candidate had to reduce absolute error by at least 5% across the later windows, win at least two windows, and keep signed bias within the predefined limits. None qualified across the four synthetic regimes with 12 seeds each, so this release retains the previous model selector. A separate positive control with exactly repeatable weekly sparse sales confirmed the rule could select a different model when the evidence supported it.

## Forecast methods

| Model | Estimate |
|---|---|
| `seasonal-naive` | Repeats the latest seven daily observations. Short histories use their average. |
| `recent-mean` | Uses average sales from the last 28 observed days. |
| `weekday-mean` | Estimates each item's weekdays from the last eight weeks, with sparse weekdays pulled toward that item's overall mean. |
| `pooled-weekday` | Learns a weekday pattern across all items over up to eight complete weeks and scales it to each item's recent sales level. |
