# Retail Forecaster

Retail Forecaster drafts SKU orders from daily sales and opening stock, and shows which items may run short when a supplier delivery slips. It also replays orders on held-out sales and runs through a local Python server or as a standalone browser file.

![Inventory desk with a SKU watchlist, stock chart and activity tape, and order ticket under a two-day delay](docs/reorder-workspace.png)

## Quick start

Use Python 3.10 or later and a recent browser.

```sh
git clone https://github.com/capmeowstr/retail-forecaster.git
cd retail-forecaster
python3 serve.py
```

Open <http://127.0.0.1:8765>. Select **+2 days** to see what a late receipt changes on the order ticket. Click a date in the stock tape to inspect projected demand, the receipt, and closing stock for that day. Press **/** to search by SKU or supplier. Pin SKUs to build a watchlist for the current session and dataset. [CSV columns and examples](docs/methodology.md#inputs)

For a single file you can open offline, run the preview builder or download `retail-forecaster-offline` from a successful [CI run](https://github.com/capmeowstr/retail-forecaster/actions).

```sh
python3 -m scripts.make_preview Retail_Forecaster_Demo.html
```

Run the tests with Node.js 20 or later installed.

```sh
python3 -m unittest discover -s tests
npm test
```

## How it works

[forecast.py](forecast.py) is the reference implementation for the CLI and local server. [web/forecast-engine.js](web/forecast-engine.js) runs the same models on CSV uploads in the standalone browser, where Python is unavailable.
The parity suite checks report structure and compares floats with absolute and relative tolerances of `1e-12`.
The order draft uses forecast demand, stock, fixed lead time, and pack size. The replay uses the same observed sales and inventory settings for each plan. [Models, formulas and evaluation](docs/methodology.md)

![Inventory replay for the UCI sample with a simulated daily stock chart and outcomes for both plans](docs/inventory-replay.png)

At 15,276 units ordered per plan, the selected model missed 608 fewer units in the later 14-day replay. In the 28-day replay it missed 534 more. [Replay settings and results](docs/methodology.md#recorded-sales-replay)

## Assumptions and limitations

- The UCI sample is a public test fixture from one retailer. Wholesale orders can inflate daily totals. The preparation script drops cancellations and negative quantities, so returns do not replenish stock.
- Recorded sales are a censored proxy for demand during real stockouts. The dataset has no stock or lost-sales log. The replay simulates both.
- Lead time is fixed for each scenario. Each plan gets one receipt before sales on the delivery date. The model has no purchase costs, promotions, or existing open orders.
- The demand sensitivity band shows the effect of adding or subtracting the SKU's holdout MAE each day. It has no probability coverage guarantee.

## Repository layout

| Path | Contents |
| --- | --- |
| `forecast.py`, `serve.py` | Forecast CLI, reference model, and local server |
| `web/` | Browser dashboard, CSV tools, stock planning and replay |
| `scripts/` | Sample preparation and preview builders |
| `tests/` | Python/browser parity, reorder and replay tests, evaluation fixture |
| `sample-data/` | UCI daily sales fixture |
| `docs/` | Methodology and browser captures, including the [delay walkthrough](docs/delivery-delay.gif) |

The code is [MIT-licensed](LICENSE). The adapted UCI sample is [CC BY 4.0](docs/methodology.md#data-and-license).
