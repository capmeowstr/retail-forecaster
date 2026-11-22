"use strict";

function createReplayView({ dateRange, formatDate, formatShortDate, formatNumber, displayName }) {
  const ui = Object.fromEntries([
    "controls", "opening", "lead", "pack", "group", "period", "model", "rows", "status", "export", "credit",
    "summary", "impact", "impact-note", "impact-rows", "policy", "policy-note", "visuals", "stock", "chart", "caption",
  ].map(id => [id, document.getElementById("replay-" + id)]));
  const plot = createBalancePlot(ui.chart, ui.caption, formatShortDate);
  const sources = { demo: "Synthetic sales", retail: "UCI Online Retail · UK sales", upload: "Uploaded sales" };
  const metrics = [
    ["Units missed", "missed", -1],
    ["Item-days with missed sales", "missedDays", -1],
    ["Ending stock (units)", "endingStock", 0],
    ["Units ordered", "orderedUnits", 0],
    ["Sales fill rate", "fillRate", 1],
  ];
  let report = null;
  let replay = null;
  let settings = null;

  function hideResultDetails() {
    ui.summary.hidden = true;
    ui.summary.textContent = "";
    ui.visuals.hidden = true;
    ui.stock.hidden = true;
    plot(null);
    ui.visuals.replaceChildren();
    ui.impact.hidden = true;
    ui["impact-rows"].replaceChildren();
    ui["impact-note"].textContent = "";
  }

  function showEmpty(message) {
    hideResultDetails();
    ui.rows.replaceChildren();
    const cell = ui.rows.insertRow().insertCell();
    cell.colSpan = 4;
    cell.className = "empty-cell";
    cell.textContent = message;
  }

  function clear() {
    report = null;
    replay = null;
    settings = null;
    ui.controls.disabled = true;
    ui.export.disabled = true;
    ui.credit.hidden = true;
    ui.impact.open = false;
    ui.period.textContent = "Comparison on held-out sales";
    ui.model.textContent = "Selected forecast";
    ui.status.textContent = "";
    ui["policy-note"].textContent = "";
    showEmpty("Run a forecast to replay held-out sales.");
  }

  function outcomeText(value, key) {
    if (value === null) return "N/A";
    return key === "fillRate" ? formatNumber(value * 100) + "%" : formatNumber(value);
  }

  function differenceText(value, key) {
    if (value === null) return "—";
    const scale = key === "fillRate" ? 100 : 1;
    const scaled = value * scale;
    if (Math.abs(scaled) < 0.005) return "0";
    const sign = value > 0 ? "+" : "−";
    return sign + formatNumber(Math.abs(scaled)) + (key === "fillRate" ? " pp" : "");
  }

  function unitChange(delta) {
    if (Math.abs(delta) < 0.005) return "the same number of units";
    const amount = Math.abs(delta);
    return formatNumber(amount) + (delta > 0 ? " more " : " fewer ") +
      (amount === 1 ? "unit" : "units");
  }

  function renderSummary() {
    const missed = unitChange(replay.selected.missed - replay.baseline.missed);
    const ordered = unitChange(replay.selected.orderedUnits - replay.baseline.orderedUnits);
    ui.summary.textContent = "Compared with repeating last week, the selected plan missed " +
      missed + " and ordered " + ordered + ".";
    ui.summary.hidden = false;
    ui["policy-note"].textContent = replay.orderLimit === null
      ? "Each plan uses its own order quantities. Compare units ordered alongside missed sales."
      : "Each plan can order up to " + formatNumber(replay.orderLimit) +
        " units. Comparing spend requires actual purchase costs.";
  }

  function renderComparison() {
    const quantities = [
      ["Units missed", "missed"],
      ["Units ordered", "orderedUnits"],
      ["Ending stock", "endingStock"],
    ];
    const graphics = document.createDocumentFragment();
    for (const [label, key] of quantities) {
      const graphic = document.createElement("div");
      graphic.className = "replay-graphic";
      graphic.dataset.metric = key;
      const heading = document.createElement("h3");
      heading.textContent = label;
      graphic.append(heading);
      const peak = Math.max(replay.selected[key], replay.baseline[key], 1);
      for (const [plan, name] of [["selected", "Selected"], ["baseline", "Weekly"]]) {
        const value = replay[plan][key];
        const row = document.createElement("div");
        row.className = "comparison-row";
        row.dataset.plan = plan;
        const label = document.createElement("span");
        label.textContent = name;
        const track = document.createElement("div");
        track.className = "comparison-track";
        track.setAttribute("aria-hidden", "true");
        const fill = document.createElement("i");
        fill.style.width = (value / peak) * 100 + "%";
        track.append(fill);
        const total = document.createElement("span");
        total.className = "comparison-total";
        total.textContent = formatNumber(value);
        row.append(label, track, total);
        graphic.append(row);
      }
      graphics.append(graphic);
    }
    ui.visuals.replaceChildren(graphics);
    ui.visuals.hidden = false;
  }

  function renderStock() {
    const { dates, rows, selectedStock, baselineStock } = replay;
    const opening = rows.reduce((sum, row) => sum + row.openingStock, 0);
    ui.stock.hidden = false;
    plot({
      dates, opening, lead: settings.leadDays,
      lines: [
        { days: baselineStock, color: "#5c6168", dashed: true },
        { days: selectedStock, color: "#1e3a5f" },
      ],
      shortages: selectedStock.map((day, index) => day.missed > 0 || baselineStock[index].missed > 0),
      summary: "Opening " + formatNumber(opening) + " units · All eligible SKUs",
      readDay(index) {
        const selected = selectedStock[index];
        const weekly = baselineStock[index];
        return formatDate(dates[index]) + " · Selected " + formatNumber(selected.balance) +
          " left / " + formatNumber(selected.missed) + " missed · Weekly " + formatNumber(weekly.balance) +
          " left / " + formatNumber(weekly.missed) + " missed";
      },
    });
  }

  function renderImpact() {
    const items = replay.rows
      .map(({ id, selected, baseline }) => ({
        id,
        missed: selected.missed - baseline.missed,
        ordered: selected.orderedUnits - baseline.orderedUnits,
        ending: selected.endingStock - baseline.endingStock,
      }))
      .filter(item => [item.missed, item.ordered, item.ending].some(delta => Math.abs(delta) >= 0.005))
      .sort((a, b) => Math.abs(b.missed) - Math.abs(a.missed) ||
        Math.abs(b.ordered) - Math.abs(a.ordered) || a.id.localeCompare(b.id));
    const limit = 8;
    ui.impact.hidden = items.length === 0;
    ui["impact-rows"].replaceChildren();
    ui["impact-note"].textContent = "Selected plan minus weekly baseline. Showing " +
      formatNumber(Math.min(limit, items.length)) + " of " + formatNumber(items.length) + " items with changes.";
    const visible = items.slice(0, limit);
    const peak = Math.max(1, ...visible.map(item => Math.abs(item.missed)));
    for (const item of visible) {
      const row = ui["impact-rows"].insertRow();
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = item.id;
      row.append(heading);
      const missed = row.insertCell();
      missed.textContent = differenceText(item.missed, "missed");
      if (Math.abs(item.missed) >= 0.005) missed.dataset.change = item.missed < 0 ? "better" : "worse";
      const track = document.createElement("div");
      track.className = "impact-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("i");
      const width = Math.abs(item.missed) / peak * 50;
      fill.style.width = width + "%";
      fill.style.left = (item.missed < 0 ? 50 - width : 50) + "%";
      track.append(fill);
      missed.append(track);
      row.insertCell().textContent = differenceText(item.ordered, "orderedUnits");
      row.insertCell().textContent = differenceText(item.ending, "endingStock");
    }
  }

  function recalculate() {
    if (!report?.holdout?.replay?.length) return;
    settings = {
      openingDays: Number(ui.opening.value || 4),
      leadDays: Number(ui.lead.value || 2),
      packSize: Number(ui.pack.value || 12),
      group: ui.group.value || "all",
      orderPolicy: ui.policy.value || "matched",
    };
    replay = retailReplay.run(report.holdout, settings);
    ui.export.disabled = replay.rows.length === 0;
    if (!replay.rows.length) {
      showEmpty("No eligible sales series in this selection.");
      ui["policy-note"].textContent = "";
      ui.status.textContent = replay.excludedCount
        ? formatNumber(replay.excludedCount) + " series exceed supported stock quantities."
        : "";
      return;
    }
    renderSummary();
    renderComparison();
    renderStock();
    renderImpact();
    ui.rows.replaceChildren();
    for (const [label, key, direction] of metrics) {
      const row = ui.rows.insertRow();
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      const selected = replay.selected[key];
      const baseline = replay.baseline[key];
      const difference = selected === null || baseline === null ? null : selected - baseline;
      row.insertCell().textContent = outcomeText(selected, key);
      row.insertCell().textContent = outcomeText(baseline, key);
      const change = row.insertCell();
      change.textContent = differenceText(difference, key);
      const meaningfulChange = key === "fillRate" ? 0.00005 : 0.005;
      if (direction && Math.abs(difference) >= meaningfulChange) {
        change.dataset.change = difference * direction > 0 ? "better" : "worse";
      }
    }
    const skipped = replay.excludedCount ? formatNumber(replay.excludedCount) + " series outside quantity limits." : "";
    const tie = report.selected_model === report.baseline_model ? "Validation selected the weekly baseline." : "";
    const holdout = report.holdout;
    const conflictingResult = settings.group === "all" && holdout.selected.wape !== null && holdout.baseline.wape !== null &&
      holdout.selected.wape < holdout.baseline.wape && replay.selected.missed > replay.baseline.missed;
    const conflict = conflictingResult ? "The selected plan missed more units despite lower forecast error." : "";
    ui.status.textContent = [
      formatNumber(replay.rows.length) + " items · Delivery " + formatDate(replay.arrival) + ".",
      tie, conflict, skipped,
    ].filter(Boolean).join(" ");
  }

  function show(forecastReport, sourceKind) {
    report = forecastReport;
    ui.credit.hidden = sourceKind !== "retail";
    const holdout = report.holdout;
    if (!holdout?.replay?.length) {
      ui.period.textContent = sources[sourceKind];
      showEmpty(report.required_history_days
        ? "This horizon needs at least one series with " + report.required_history_days + " days to run a holdout."
        : "Holdout sales are unavailable.");
      return;
    }
    ui.controls.disabled = false;
    ui.period.textContent = sources[sourceKind] + " · " + dateRange(holdout.forecast_start, holdout.forecast_end);
    ui.model.textContent = report.selected_model === report.baseline_model
      ? "Selected forecast" : displayName(report.selected_model);
    recalculate();
  }

  for (const field of [ui.opening, ui.lead, ui.pack, ui.group, ui.policy]) {
    field.addEventListener("change", recalculate);
  }
  ui.export.addEventListener("click", () => {
    if (!replay?.rows.length) return;
    const { forecast_start: start, forecast_end: end } = report.holdout;
    const lines = [
      "series_id,sales_pattern,holdout_start,holdout_end,delivery_date,training_daily_mean," +
      "opening_stock_days,opening_stock,lead_days,pack_size,order_policy,order_unit_limit,observed_units," +
      "selected_model,baseline_model," +
      "selected_ordered_units,baseline_ordered_units,selected_missed_units,baseline_missed_units," +
      "selected_missed_days,baseline_missed_days,selected_first_missed_date,baseline_first_missed_date," +
      "selected_ending_stock,baseline_ending_stock",
    ];
    for (const row of replay.rows) {
      lines.push([
        retailCsv.textCell(row.id), row.group, start, end, replay.arrival, row.trainingMean,
        settings.openingDays, row.openingStock, settings.leadDays, settings.packSize,
        settings.orderPolicy, replay.orderLimit ?? "", row.selected.actualUnits,
        report.selected_model, report.baseline_model,
        row.selected.orderedUnits, row.baseline.orderedUnits, row.selected.missed, row.baseline.missed,
        row.selected.missedDays, row.baseline.missedDays,
        row.selected.firstMissedDate ?? "", row.baseline.firstMissedDate ?? "",
        row.selected.endingStock, row.baseline.endingStock,
      ].join(","));
    }
    retailCsv.download("inventory-replay-" + start + ".csv", lines);
  });

  return { clear, show };
}
