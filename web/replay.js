"use strict";

const retailReplay = (() => {
  const dayMs = 86_400_000;
  const tolerance = 1e-9;
  const wholeDays = value => Number.isSafeInteger(value) && value >= 0;

  function consume(actual, dates, openingStock, leadDays, orderedUnits) {
    let stock = openingStock;
    let missed = 0;
    let missedDays = 0;
    let firstMissedDate = null;
    let actualUnits = 0;

    actual.forEach((observed, day) => {
      if (day === leadDays) stock += orderedUnits;
      const shortfall = Math.max(0, observed - stock);
      if (shortfall > tolerance) {
        missed += shortfall;
        missedDays++;
        if (firstMissedDate === null) firstMissedDate = dates[day];
      }
      stock = Math.max(0, stock - observed);
      actualUnits += observed;
    });
    return { actualUnits, missed, missedDays, firstMissedDate, endingStock: stock, orderedUnits };
  }

  function totals(rows, variant) {
    const total = { actualUnits: 0, missed: 0, missedDays: 0, endingStock: 0, orderedUnits: 0 };
    for (const row of rows) {
      const outcome = row[variant];
      for (const key of Object.keys(total)) total[key] += outcome[key];
    }
    const fillRate = total.actualUnits ? (total.actualUnits - total.missed) / total.actualUnits : null;
    return { ...total, fillRate };
  }

  function packCount(series, plans) {
    return series.reduce((count, item) => count + BigInt(plans.get(item.id).orderPacks), 0n);
  }

  function allocatePacks(series, plans, variant, packSize, leadDays, limit) {
    const candidates = [];
    for (const item of series) {
      const plan = plans.get(item.id);
      if (!plan.orderPacks) continue;
      const needed = plan.postArrivalDemand - plan.remainingAtArrival;
      const fullPacks = Math.min(plan.orderPacks, Math.floor((needed + tolerance) / packSize));
      let demand = 0;
      let duePacks = 0;
      let partialDue = null;
      for (let day = leadDays; day < item[variant].length; day++) {
        demand += item[variant][day];
        const shortfall = demand - plan.remainingAtArrival;
        const due = Math.ceil(Math.max(0, shortfall - tolerance) / packSize);
        const dueFull = Math.min(due, fullPacks);
        if (dueFull > duePacks) {
          candidates.push({ id: item.id, day, packs: dueFull - duePacks, benefit: packSize });
          duePacks = dueFull;
        }
        if (due > fullPacks && partialDue === null) partialDue = day;
      }
      if (plan.orderPacks > fullPacks) {
        candidates.push({ id: item.id, day: partialDue, packs: 1, benefit: needed - fullPacks * packSize });
      }
    }

    // Full-pack demand comes first. Ties favor demand that would be missed sooner.
    candidates.sort((a, b) => b.benefit - a.benefit || a.day - b.day ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const allocated = new Map();
    let remaining = limit;
    for (const candidate of candidates) {
      if (remaining === 0n) break;
      const wanted = BigInt(candidate.packs);
      const packs = remaining < wanted ? remaining : wanted;
      allocated.set(candidate.id, (allocated.get(candidate.id) ?? 0) + Number(packs) * packSize);
      remaining -= packs;
    }
    return allocated;
  }

  function run(holdout, { leadDays, openingDays, packSize, group = "all", orderPolicy = "unrestricted" }) {
    const series = holdout.replay;
    const horizon = series[0].actual.length;
    if (!wholeDays(leadDays) || leadDays >= horizon || !wholeDays(openingDays) || !wholeDays(packSize) || packSize < 1) {
      throw new Error("Choose valid opening stock, delivery timing, and pack size.");
    }
    if (orderPolicy !== "matched" && orderPolicy !== "unrestricted") throw new Error("Choose a valid order policy.");
    const start = Date.parse(holdout.forecast_start + "T00:00:00Z");
    const dates = Array.from({ length: horizon }, (_, day) =>
      new Date(start + day * dayMs).toISOString().slice(0, 10));
    const selectedSeries = group === "all" ? series : series.filter(item => item.group === group);
    const inventory = new Map();
    for (const item of selectedSeries) {
      const openingStock = Math.max(0, Math.ceil(item.training_daily_mean * openingDays - tolerance));
      inventory.set(item.id, {
        onHand: openingStock, leadDays, coverDays: horizon - leadDays, packSize, supplier: "",
      });
    }

    function draft(variant) {
      const forecasts = selectedSeries.map(item => ({ id: item.id, forecast: item[variant] }));
      const plan = retailReorder.buildPlan(forecasts, dates, inventory);
      return new Map(plan.map(row => [row.id, row]));
    }

    const selectedPlan = draft("selected");
    const baselinePlan = draft("baseline");
    const eligible = selectedSeries.filter(item =>
      selectedPlan.get(item.id).orderUnits !== null && baselinePlan.get(item.id).orderUnits !== null);
    let orderLimit = null;
    let selectedOrders = null;
    let baselineOrders = null;
    if (orderPolicy === "matched") {
      const selectedPacks = packCount(eligible, selectedPlan);
      const baselinePacks = packCount(eligible, baselinePlan);
      const packLimit = selectedPacks < baselinePacks ? selectedPacks : baselinePacks;
      const limitUnits = packLimit * BigInt(packSize);
      orderLimit = limitUnits <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(limitUnits) : limitUnits;
      selectedOrders = allocatePacks(eligible, selectedPlan, "selected", packSize, leadDays, packLimit);
      baselineOrders = allocatePacks(eligible, baselinePlan, "baseline", packSize, leadDays, packLimit);
    }
    const rows = [];
    for (const item of eligible) {
      const selectedUnits = selectedOrders ? (selectedOrders.get(item.id) ?? 0) : selectedPlan.get(item.id).orderUnits;
      const baselineUnits = baselineOrders ? (baselineOrders.get(item.id) ?? 0) : baselinePlan.get(item.id).orderUnits;
      const stock = inventory.get(item.id).onHand;
      rows.push({
        id: item.id, group: item.group, openingStock: stock, trainingMean: item.training_daily_mean,
        selected: consume(item.actual, dates, stock, leadDays, selectedUnits),
        baseline: consume(item.actual, dates, stock, leadDays, baselineUnits),
      });
    }
    return {
      rows, dates, arrival: dates[leadDays], orderLimit, excludedCount: selectedSeries.length - rows.length,
      selected: totals(rows, "selected"), baseline: totals(rows, "baseline"),
    };
  }

  return { run };
})();
