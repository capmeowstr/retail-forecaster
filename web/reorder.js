"use strict";

const retailReorder = (() => {
  const stockTolerance = 1e-9;
  const statuses = { expedite: 0, order: 1, horizon: 2, unavailable: 3, missing: 4, covered: 5 };
  const isWhole = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
  const isDemand = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

  function readWhole(value, name, line, minimum, fallback) {
    if (value === "") return fallback;
    const amount = Number(value);
    if (!/^\d+$/u.test(value) || !isWhole(amount, minimum)) {
      throw new Error(`Inventory CSV line ${line}: ${name} must be a whole number of ${minimum} or more within the supported range.`);
    }
    return amount;
  }

  function parseInventory(csv, startDate) {
    const rows = retailCsv.rows(csv);
    const header = rows.next().value;
    if (!header) throw new Error("Inventory CSV is empty. Include series_id and on_hand columns.");
    const columns = header.fields.map(value => value.trim());
    const indexes = new Map(columns.map((name, index) => [name, index]));
    if (indexes.size !== columns.length) throw new Error("Inventory CSV contains duplicate column names.");
    if (!indexes.has("series_id") || !indexes.has("on_hand")) {
      throw new Error("Inventory CSV must include series_id and on_hand columns.");
    }

    const inventory = new Map();
    for (const { fields, line } of rows) {
      if (fields.length > columns.length) throw new Error(`Inventory CSV line ${line}: too many fields.`);
      const read = name => (fields[indexes.get(name)] ?? "").trim();
      const id = read("series_id");
      if (!id) throw new Error(`Inventory CSV line ${line}: series_id is blank.`);
      if (inventory.has(id)) {
        throw new Error(`Inventory CSV line ${line}: duplicate inventory row for ${JSON.stringify(id)}.`);
      }
      const stockDate = read("stock_date");
      if (stockDate && stockDate !== startDate) {
        throw new Error(`Inventory CSV line ${line}: stock_date must match the first forecast day (${startDate}).`);
      }
      inventory.set(id, {
        onHand: readWhole(read("on_hand"), "on_hand", line, 0, null),
        leadDays: readWhole(read("lead_days"), "lead_days", line, 0, 0),
        coverDays: readWhole(read("cover_days"), "cover_days", line, 1, 7),
        packSize: readWhole(read("pack_size"), "pack_size", line, 1, 1),
        supplier: read("supplier"),
      });
    }
    if (!inventory.size) throw new Error("Inventory CSV has no data rows. Add at least one item.");
    return inventory;
  }

  function sampleInventory(series) {
    const examples = new Map([
      ["demo-01", { onHand: 50, leadDays: 2, coverDays: 7, packSize: 12, supplier: "Harbour Wholesale" }],
      ["demo-02", { onHand: 20, leadDays: 2, coverDays: 7, packSize: 12, supplier: "Harbour Wholesale" }],
      ["demo-03", { onHand: 240, leadDays: 3, coverDays: 7, packSize: 12, supplier: "Northline Supply" }],
    ]);
    return new Map(series.map(({ id, history }, index) => {
      if (examples.has(id)) return [id, examples.get(id)];
      const recent = history.slice(-7);
      const rate = recent.reduce((total, units) => total + units, 0) / (recent.length || 1);
      const packSize = index % 2 === 0 ? 12 : 6;
      return [id, {
        onHand: Math.ceil(rate * 12 + packSize),
        leadDays: 1 + index % 3,
        coverDays: 4,
        packSize,
        supplier: index % 2 === 0 ? "Northline Supply" : "Market Street Foods",
      }];
    }));
  }

  function planItem({ id, forecast }, dates, stock, delayDays) {
    const row = {
      id, stock, status: "missing",
      requiredDays: null, effectiveLeadDays: null, arrivalDate: null, coverageEnd: null,
      firstShortageDate: null, preArrivalDemand: null, preArrivalShortfall: null,
      remainingAtArrival: null, postArrivalDemand: null, orderPacks: null, orderUnits: null,
    };
    if (!stock || stock.onHand === null) return row;

    row.status = "unavailable";
    if (!isWhole(delayDays, 0) || !isWhole(stock.onHand, 0) || !isWhole(stock.leadDays, 0) ||
        !isWhole(stock.coverDays, 1) || !isWhole(stock.packSize, 1)) return row;
    const effectiveLeadDays = stock.leadDays + delayDays;
    const requiredDays = effectiveLeadDays + stock.coverDays;
    if (!isWhole(requiredDays, 1)) return row;
    row.effectiveLeadDays = effectiveLeadDays;
    row.requiredDays = requiredDays;
    row.arrivalDate = dates[effectiveLeadDays] ?? null;

    let preArrivalDemand = 0;
    let postArrivalDemand = 0;
    let firstShortageDate = null;
    const availableDays = Math.min(requiredDays, dates.length);
    for (let day = 0; day < availableDays; day++) {
      const demand = forecast[day];
      if (!isDemand(demand)) return row;
      if (day < effectiveLeadDays) preArrivalDemand += demand;
      else postArrivalDemand += demand;
      const cumulativeDemand = preArrivalDemand + postArrivalDemand;
      if (!isDemand(cumulativeDemand)) return row;
      if (firstShortageDate === null && cumulativeDemand - stock.onHand > stockTolerance) {
        firstShortageDate = dates[day];
      }
    }

    // A delivery arrives before sales on its arrival date. Missed sales from
    // earlier days stay in the shortage figure and are excluded from the order.
    const arrivalBalance = stock.onHand - preArrivalDemand;
    const remainingAtArrival = Math.max(0, arrivalBalance);
    const preArrivalShortfall = arrivalBalance < -stockTolerance ? -arrivalBalance : 0;
    if (requiredDays > dates.length) {
      return {
        ...row, firstShortageDate, preArrivalDemand, preArrivalShortfall,
        remainingAtArrival: effectiveLeadDays <= dates.length ? remainingAtArrival : null,
        status: preArrivalShortfall ? "expedite" : "horizon",
      };
    }
    const orderPacks = Math.ceil(Math.max(0, postArrivalDemand - remainingAtArrival - stockTolerance) / stock.packSize);
    const orderUnits = orderPacks * stock.packSize;
    if (!isWhole(orderUnits, 0)) return row;

    return {
      ...row, coverageEnd: dates[requiredDays - 1], firstShortageDate, preArrivalDemand, preArrivalShortfall, remainingAtArrival,
      postArrivalDemand, orderPacks, orderUnits,
      status: preArrivalShortfall ? "expedite" : orderUnits ? "order" : "covered",
    };
  }

  function compareText(first, second) {
    if (first === second) return 0;
    return first < second ? -1 : 1;
  }

  function buildPlan(series, dates, inventory, delayDays = 0) {
    const rows = series.map(item => planItem(item, dates, inventory.get(item.id) ?? null, delayDays));
    return rows.sort((first, second) => (statuses[first.status] - statuses[second.status]) ||
      compareText(first.firstShortageDate ?? "", second.firstShortageDate ?? "") ||
      ((second.preArrivalShortfall ?? 0) - (first.preArrivalShortfall ?? 0)) ||
      ((second.orderUnits ?? 0) - (first.orderUnits ?? 0)) || compareText(first.id, second.id));
  }

  return { parseInventory, sampleInventory, buildPlan };
})();
