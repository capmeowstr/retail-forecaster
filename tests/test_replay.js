"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scripts = ["reorder.js", "replay.js"].map(name => fs.readFileSync(path.join(__dirname, "..", "web", name), "utf8"));
const { run } = vm.runInNewContext([...scripts, "retailReplay"].join("\n"));
const settings = { openingDays: 1, leadDays: 1, packSize: 6, group: "all" };
const item = {
  id: "item", group: "regular", training_daily_mean: 7,
  actual: [9, 4, 8, 4], selected: [8, 6, 5, 3], baseline: [4, 8, 8, 8],
};
const fixture = series => ({ forecast_start: "2020-02-28", replay: series });

test("replay applies one receipt before its day's sales and measures the stock trade-off", () => {
  const result = run(fixture([item]), settings);
  assert.equal(result.arrival, "2020-02-29");
  assert.equal(result.dates.at(-1), "2020-03-02");
  assert.equal(result.rows[0].openingStock, 7);
  assert.equal(result.selected.orderedUnits, 18);
  assert.equal(result.baseline.orderedUnits, 24);
  assert.equal(result.selected.missed, 2);
  assert.equal(result.baseline.missed, 2);
  assert.equal(result.selected.missedDays, 1);
  assert.equal(result.selected.fillRate, 0.92);
  assert.equal(result.selected.endingStock, 2);
  assert.equal(result.baseline.endingStock, 8);
  assert.deepEqual(Array.from(result.selectedStock, day => day.balance), [0, 14, 6, 2]);
  assert.equal(result.baselineStock[1].receipt, 24);
  assert.equal(result.selectedStock[0].missed, 2);
});

test("held-out sales cannot change the order or its simulated opening stock", () => {
  for (const orderPolicy of ["matched", "unrestricted"]) {
    const before = run(fixture([item]), { ...settings, orderPolicy });
    const after = run(fixture([{ ...item, actual: [70, 40, 80, 40] }]), { ...settings, orderPolicy });
    assert.equal(before.rows[0].openingStock, after.rows[0].openingStock);
    assert.equal(before.orderLimit, after.orderLimit);
    assert.equal(before.selected.orderedUnits, after.selected.orderedUnits);
    assert.equal(before.baseline.orderedUnits, after.baseline.orderedUnits);
    assert.ok(after.selected.missed > before.selected.missed);
  }
});

test("matched orders give full packs priority and use due dates to break ties", () => {
  const series = [
    { ...item, id: "a", selected: [50, 12, 0, 0], baseline: [0, 12, 0, 0] },
    { ...item, id: "b", selected: [0, 6, 0, 18], baseline: [0, 6, 0, 0] },
    { ...item, id: "partial", selected: [0, 5, 0, 0], baseline: [0, 0, 0, 0] },
  ];
  const result = run(fixture(series), { ...settings, openingDays: 0, orderPolicy: "matched" });
  assert.equal(result.orderLimit, 18);
  assert.equal(result.selected.orderedUnits, 18);
  assert.equal(result.baseline.orderedUnits, 18);
  assert.deepEqual(Array.from(result.rows, row => row.selected.orderedUnits), [12, 6, 0]);
});

test("an exact zero unit limit and partial-pack allocation are supported", () => {
  const small = { ...item, id: "small", selected: [0, 5.5, 0, 0], baseline: [0, 6, 0, 0] };
  const smaller = { ...item, id: "smaller", selected: [0, 4, 0, 0], baseline: [0, 0, 0, 0] };
  const replay = { ...settings, openingDays: 0, orderPolicy: "matched" };
  const partial = run(fixture([smaller, small]), replay);
  assert.equal(partial.orderLimit, 6);
  assert.deepEqual(Array.from(partial.rows, row => row.selected.orderedUnits), [0, 6]);
  const zero = run(fixture([smaller]), replay);
  assert.equal(zero.orderLimit, 0);
  assert.equal(zero.selected.orderedUnits, 0);
  assert.equal(zero.baseline.orderedUnits, 0);
});

test("group comparisons use identical items and show undefined fill rates for zero sales", () => {
  const sparse = { ...item, id: "sparse", group: "sparse", actual: [0, 0, 0, 0] };
  const result = run(fixture([item, sparse]), { ...settings, group: "sparse" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, "sparse");
  assert.equal(result.selected.missed, 0);
  assert.equal(result.selected.fillRate, null);
  assert.equal(result.baseline.fillRate, null);
});

test("invalid timing is rejected and unsupported quantities are omitted from both methods", () => {
  assert.throws(() => run(fixture([item]), { ...settings, leadDays: 4 }), /Choose valid/);
  const invalid = { ...item, id: "large", training_daily_mean: Number.MAX_SAFE_INTEGER };
  const result = run(fixture([item, invalid]), { ...settings, openingDays: 2 });
  assert.equal(result.excludedCount, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.selected.actualUnits, result.baseline.actualUnits);
});

test("public retail replay reproduces matched and unrestricted 14-day comparisons", () => {
  const analysisScripts = ["csv.js", "forecast-engine.js"].map(name =>
    fs.readFileSync(path.join(__dirname, "..", "web", name), "utf8"));
  const analyze = vm.runInNewContext([...analysisScripts, "analyzeRetailCsv"].join("\n"));
  const csv = fs.readFileSync(path.join(__dirname, "..", "sample-data", "uci-retail.csv"), "utf8");
  const [header, ...dailySales] = csv.trimEnd().split("\n");
  const windows = [
    ["2011-11-11", "2011-11-24", 5125, 5166, 5003, 7456, 16068, 5125, 5697],
    ["2011-11-25", "2011-12-08", 3032, 4638, 4901, 4263, 15276, 4030, 4638],
  ];
  for (const [first, last, missed, benchmarkMissed, ending, benchmarkEnding, limit, matchedMissed, matchedBaseline] of windows) {
    const history = [header, ...dailySales.filter(line => line.split(",")[1] <= last)].join("\n");
    const holdout = analyze(history, 14).report.holdout;
    assert.equal(holdout.forecast_start, first);
    assert.equal(holdout.forecast_end, last);
    const scenario = { openingDays: 4, leadDays: 2, packSize: 12 };
    const result = run(holdout, scenario);
    assert.equal(result.rows.length, 24);
    assert.equal(result.selected.missed, missed);
    assert.equal(result.baseline.missed, benchmarkMissed);
    assert.equal(result.selected.endingStock, ending);
    assert.equal(result.baseline.endingStock, benchmarkEnding);
    const matched = run(holdout, { ...scenario, orderPolicy: "matched" });
    assert.equal(matched.orderLimit, limit);
    assert.equal(matched.selected.orderedUnits, limit);
    assert.equal(matched.baseline.orderedUnits, limit);
    assert.equal(matched.selected.missed, matchedMissed);
    assert.equal(matched.baseline.missed, matchedBaseline);
  }
});
