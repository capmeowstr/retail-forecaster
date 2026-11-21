"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sources = ["csv.js", "reorder.js"].map(name => fs.readFileSync(path.join(__dirname, "web", name), "utf8"));
const { parseInventory, sampleInventory, buildPlan } = vm.runInNewContext([...sources, "retailReorder"].join("\n"));
const dates = Array.from({ length: 14 }, (_, index) => new Date(Date.UTC(2026, 9, 19 + index)).toISOString().slice(0, 10));
const unitForecast = [3, 4, 6, 4];
const stock = (onHand, leadDays = 2, coverDays = 2, packSize = 5) => ({
  onHand, leadDays, coverDays, packSize, supplier: "Supplier",
});

function itemPlan(inventory, forecast = unitForecast, delay = 0, calendar = dates) {
  return buildPlan([{ id: "item", forecast }], calendar, new Map([["item", inventory]]), delay)[0];
}

test("inventory accepts quoted fields, optional defaults, and explicit zero stock", () => {
  const csv = '\ufeffon_hand,series_id,stock_date,supplier,lead_days,cover_days,pack_size\r\n' +
    ' 0 ," Item, A ",2026-10-19,"Harbour, ""East""",2,5,12\r\n' +
    ",__proto__,,,,,\r\n";
  const inventory = parseInventory(csv, dates[0]);
  assert.deepEqual({ ...inventory.get("Item, A") }, {
    onHand: 0, leadDays: 2, coverDays: 5, packSize: 12, supplier: 'Harbour, "East"',
  });
  assert.deepEqual({ ...inventory.get("__proto__") }, {
    onHand: null, leadDays: 0, coverDays: 7, packSize: 1, supplier: "",
  });
});

test("inventory errors identify invalid rows, duplicate IDs, and stale snapshots", () => {
  const cases = [
    ["", /empty/],
    ["series_id,on_hand\n", /no data rows/],
    ["series_id,units\nitem,12", /include series_id and on_hand/],
    ["series_id,on_hand,on_hand\nitem,6,7", /duplicate column/],
    ["series_id,on_hand\nitem,6\n item ,7", /line 3: duplicate inventory row/],
    ["series_id,on_hand\n,6", /line 2: series_id is blank/],
    ["series_id,on_hand\nitem,6,7", /line 2: too many fields/],
    ["series_id,on_hand\nitem,0.5", /line 2: on_hand must be a whole number/],
    ["series_id,on_hand\nitem,9007199254740993", /supported range/],
    ["series_id,on_hand,lead_days\nitem,5,-1", /lead_days must be a whole number/],
    ["series_id,on_hand,cover_days\nitem,5,0", /cover_days must be a whole number of 1 or more/],
    ["series_id,on_hand,pack_size\nitem,5,0", /pack_size must be a whole number of 1 or more/],
    ["series_id,on_hand,stock_date\nitem,5,2026-10-18", /first forecast day \(2026-10-19\)/],
  ];
  for (const [csv, message] of cases) assert.throws(() => parseInventory(csv, dates[0]), message);
});

test("an order arrives before that day's sales and excludes earlier missed sales", () => {
  const row = itemPlan(stock(5));
  assert.equal(row.status, "expedite");
  assert.equal(row.requiredDays, 4);
  assert.equal(row.effectiveLeadDays, 2);
  assert.equal(row.arrivalDate, dates[2]);
  assert.equal(row.coverageEnd, dates[3]);
  assert.equal(row.firstShortageDate, dates[1]);
  assert.equal(row.preArrivalDemand, 7);
  assert.equal(row.preArrivalShortfall, 2);
  assert.equal(row.remainingAtArrival, 0);
  assert.equal(row.postArrivalDemand, 10);
  assert.equal(row.orderPacks, 2);
  assert.equal(row.orderUnits, 10);
});

test("same-day deliveries, exact depletion, and rounding use consistent boundaries", () => {
  const sameDay = itemPlan(stock(0, 0, 2, 7));
  assert.equal(sameDay.arrivalDate, dates[0]);
  assert.equal(sameDay.status, "order");
  assert.equal(sameDay.preArrivalShortfall, 0);
  assert.equal(sameDay.orderUnits, 7);

  const exact = itemPlan(stock(17));
  assert.equal(exact.status, "covered");
  assert.equal(exact.orderUnits, 0);
  assert.equal(exact.firstShortageDate, null);

  const rounded = itemPlan(stock(0, 0, 3, 1), [0.1, 0.2, 0.700000000000001]);
  assert.equal(rounded.orderPacks, 1);
  const over = itemPlan(stock(0, 0, 3, 1), [0.1, 0.2, 0.7001]);
  assert.equal(over.orderPacks, 2);

  const expediteOnly = itemPlan(stock(1, 2, 1, 5), [2, 0, 0]);
  assert.equal(expediteOnly.status, "expedite");
  assert.equal(expediteOnly.preArrivalShortfall, 1);
  assert.equal(expediteOnly.orderUnits, 0);
});

test("unknown stock, short horizons, and unsafe demand produce explicit statuses", () => {
  assert.equal(itemPlan(null).status, "missing");
  assert.equal(itemPlan(stock(null)).status, "missing");

  const short = itemPlan(stock(8), unitForecast, 0, dates.slice(0, 3));
  assert.equal(short.status, "horizon");
  assert.equal(short.requiredDays, 4);
  assert.equal(short.arrivalDate, dates[2]);
  assert.equal(short.coverageEnd, null);
  assert.equal(short.orderUnits, null);

  assert.equal(itemPlan(stock(5), [3, 4, 0, Infinity]).status, "unavailable");
  const huge = Number.MAX_SAFE_INTEGER;
  assert.equal(itemPlan(stock(0, 0, 2), [huge, huge]).status, "unavailable");
  assert.equal(itemPlan(stock(0, 0, 1, huge - 5), [huge - 1]).status, "unavailable");
});

test("known pre-delivery shortages stay visible beyond the draft order horizon", () => {
  const week = dates.slice(0, 7);
  const demand = Array(7).fill(5);
  const planned = itemPlan(stock(0, 2, 4), demand, 0, week);
  assert.equal(planned.status, "expedite");
  assert.equal(planned.preArrivalShortfall, 10);
  assert.equal(planned.orderUnits, 20);

  const delayed = itemPlan(stock(0, 2, 4), demand, 2, week);
  assert.equal(delayed.status, "expedite");
  assert.equal(delayed.requiredDays, 8);
  assert.equal(delayed.firstShortageDate, week[0]);
  assert.equal(delayed.preArrivalShortfall, 20);
  assert.equal(delayed.orderUnits, null);

  const beyondArrival = itemPlan(stock(4, 9, 4), demand, 0, week);
  assert.equal(beyondArrival.status, "expedite");
  assert.equal(beyondArrival.preArrivalShortfall, 31);
  assert.equal(beyondArrival.remainingAtArrival, null);
});

test("the queue puts earliest pre-delivery shortages first and breaks ties by ID", () => {
  const inventory = new Map([
    ["z", stock(10)], ["a", stock(10)], ["late", stock(5)],
    ["early", stock(0)], ["covered", stock(20)], ["too-long", stock(20, 6)],
  ]);
  const series = [...inventory.keys(), "missing"].map(id => ({ id, forecast: unitForecast }));
  const rows = buildPlan(series, dates.slice(0, 4), inventory, 0);
  assert.deepEqual(Array.from(rows, row => row.id), ["early", "late", "a", "z", "too-long", "missing", "covered"]);
});

test("a supplier delay changes the order, arrival date, and shortage status on the sample", () => {
  const series = [
    { id: "demo-01", history: [16], forecast: [15, 14, 15, 17, 20, 24, 20, 15, 14, 15, 17, 20, 24, 20] },
    { id: "demo-02", history: [19], forecast: [18, 17, 18, 20, 23, 29, 23, 18, 17, 18, 20, 23, 29, 23] },
    { id: "demo-03", history: [21], forecast: [20, 19, 21, 23, 27, 32, 27, 20, 19, 21, 23, 27, 32, 27] },
  ];
  const inventory = sampleInventory(series);
  const before = buildPlan(series, dates, inventory, 0);
  assert.deepEqual(Array.from(before, row => [row.id, row.status, row.orderUnits]), [
    ["demo-02", "expedite", 156], ["demo-01", "order", 108], ["demo-03", "covered", 0],
  ]);

  const delayed = buildPlan(series, dates, inventory, 2);
  assert.deepEqual(Array.from(delayed, row => [row.id, row.status, row.orderUnits]), [
    ["demo-02", "expedite", 156], ["demo-01", "expedite", 132], ["demo-03", "order", 48],
  ]);
  assert.equal(delayed[1].firstShortageDate, dates[3]);
  assert.equal(delayed[1].arrivalDate, dates[4]);
  assert.equal(delayed[1].preArrivalShortfall, 11);
  assert.equal(inventory.get("demo-01").leadDays, 2);
});
