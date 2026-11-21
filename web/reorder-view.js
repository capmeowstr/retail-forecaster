"use strict";

function createReorderView({ onSelect, formatDate, formatNumber, unitsText }) {
  const ui = Object.fromEntries([
    "start", "file", "export", "template", "import-status", "import-error",
    "delay", "scenario-impact", "filter", "search", "risk-count", "order-count", "order-units", "rows",
    "page", "previous", "next", "selected", "form", "on-hand", "lead", "cover",
    "pack", "save", "detail", "item-evidence",
  ].map(id => [id, document.getElementById("reorder-" + id)]));
  const actions = {
    expedite: "Expedite",
    order: "Order",
    covered: "Covered",
    missing: "Missing stock",
    horizon: "Extend forecast",
    unavailable: "Review inputs",
  };
  const defaultSettings = { onHand: null, leadDays: 0, coverDays: 7, packSize: 1, supplier: "" };
  const editableFields = [
    ["on-hand", "onHand", 0], ["lead", "leadDays", 0], ["cover", "coverDays", 1], ["pack", "packSize", 1],
  ];
  const pageSize = 40;
  let data = null;
  let inventory = null;
  let inventoryName = "";
  let importRequest = null;
  let plan = [];
  let itemPlans = new Map();
  let orders = [];
  let selectedId = null;
  let holdoutEvidence = "";
  let page = 0;
  let visibleItems = [];

  const words = (count, name) => formatNumber(count) + " " + name + (count === 1 ? "" : "s");
  const isAction = row => row.status === "expedite" || row.status === "order";
  const needsLongerForecast = row => row.requiredDays > data.forecast_dates.length;
  const matchesFilter = (row, filter) => filter === "all" ||
    (filter === "action" && isAction(row)) ||
    (filter === "covered" && row.status === "covered") ||
    (filter === "needs-data" && (needsLongerForecast(row) || (!isAction(row) && row.status !== "covered")));

  function shortfallText(row) {
    const minimum = row.effectiveLeadDays > data.forecast_dates.length ? "at least " : "";
    return minimum + unitsText(row.preArrivalShortfall);
  }

  function setError(message) {
    ui["import-error"].textContent = message;
  }

  function addCellText(cell, label, name) {
    if (!label) return;
    const span = document.createElement("span");
    span.className = name;
    span.textContent = label;
    cell.append(span);
    return span;
  }

  function rowNote(row) {
    if (row.status === "expedite") {
      return shortfallText(row) + " short before arrival" +
        (row.firstShortageDate ? " · " + formatDate(row.firstShortageDate) : "");
    }
    if (row.status === "order" && row.firstShortageDate) {
      return "Short without an order " + formatDate(row.firstShortageDate);
    }
    if (row.status === "horizon") return "Needs " + words(row.requiredDays, "day");
    return "";
  }

  function highlightSelection() {
    for (const [id, tr, button] of visibleItems) {
      const selected = id === selectedId;
      tr.dataset.selected = String(selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function renderRows() {
    const query = ui.search.value.trim().toLocaleLowerCase();
    const filter = ui.filter.value || "all";
    const matches = plan.filter(row => matchesFilter(row, filter) &&
      (!query || row.id.toLocaleLowerCase().includes(query) ||
        row.stock?.supplier.toLocaleLowerCase().includes(query)));
    const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
    page = Math.min(page, lastPage);
    const start = page * pageSize;
    const visible = matches.slice(start, start + pageSize);
    ui.rows.replaceChildren();
    visibleItems = [];
    ui.previous.disabled = page === 0;
    ui.next.disabled = page === lastPage;
    ui.page.textContent = matches.length
      ? formatNumber(start + 1) + "–" + formatNumber(start + visible.length) + " of " + formatNumber(matches.length)
      : "";
    if (!visible.length) {
      const cell = ui.rows.insertRow().insertCell();
      cell.colSpan = 4;
      cell.className = "empty-cell";
      cell.textContent = data ? "No items match these filters." : "Load sales history to plan orders.";
      return;
    }

    for (const row of visible) {
      const tr = ui.rows.insertRow();
      const item = tr.insertCell();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plan-item";
      button.textContent = row.id;
      button.addEventListener("click", () => onSelect(row.id));
      item.append(button);
      addCellText(item, row.stock?.supplier, "plan-note");
      const action = tr.insertCell();
      const badge = addCellText(action, actions[row.status], "plan-status");
      badge.dataset.status = row.status;
      addCellText(action, rowNote(row), "plan-note");
      tr.insertCell().textContent = row.arrivalDate ? formatDate(row.arrivalDate) : "—";
      const quantity = tr.insertCell();
      if (row.orderUnits > 0) {
        addCellText(quantity, unitsText(row.orderUnits), "plan-quantity");
        addCellText(quantity, words(row.orderPacks, "pack"), "plan-note");
      } else if (row.status === "expedite" && needsLongerForecast(row)) {
        quantity.textContent = "Needs " + words(row.requiredDays, "day");
      } else {
        quantity.textContent = row.orderUnits === 0 ? "0 units" : "—";
      }
      visibleItems.push([row.id, tr, button]);
    }
    highlightSelection();
  }

  function renderDecision() {
    const row = itemPlans.get(selectedId);
    ui["item-evidence"].textContent = row ? holdoutEvidence : "";
    ui.detail.dataset.status = row?.status ?? "";
    if (!row) {
      ui.detail.textContent = "Select an item to check its order.";
      return;
    }
    if (row.status === "missing") {
      ui.detail.textContent = "Save an opening stock count for this item.";
      return;
    }
    const shortage = row.status === "expedite"
      ? "Projected shortage of " + shortfallText(row) + " before delivery. "
      : "";
    if (needsLongerForecast(row)) {
      ui.detail.textContent = shortage + "Choose at least " + words(row.requiredDays, "forecast day") +
        " or reduce the lead time or coverage to draft an order.";
      return;
    }
    if (row.status === "unavailable") {
      ui.detail.textContent = "The planned quantity exceeds the supported range. Check sales and stock units.";
      return;
    }
    if (row.status === "covered") {
      ui.detail.textContent = "Opening stock covers projected sales through " + formatDate(row.coverageEnd) + ".";
      return;
    }

    const demand = unitsText(row.postArrivalDemand) + " forecast through " + formatDate(row.coverageEnd) +
      ", with " + unitsText(row.remainingAtArrival) + " on hand at delivery. ";
    const draft = row.orderUnits > 0
      ? "Draft " + words(row.orderPacks, "pack") + " (" + unitsText(row.orderUnits) + ")."
      : "Regular draft quantity is zero.";
    ui.detail.textContent = shortage + demand + draft;
  }

  function populateEditor() {
    const stock = inventory?.get(selectedId) ?? defaultSettings;
    ui.selected.textContent = selectedId ?? "Choose a series";
    for (const [id, key] of editableFields) {
      ui[id].value = selectedId === null ? "" : stock[key] ?? "";
      ui[id].disabled = selectedId === null;
      ui[id].removeAttribute("aria-invalid");
    }
    ui.save.disabled = selectedId === null;
  }

  function describeDelay(delay) {
    if (!data || !delay) return "";
    const scheduled = retailReorder.buildPlan(data.series, data.forecast_dates, inventory);
    let newlyShort = 0;
    let newlyLimited = 0;
    for (const row of scheduled) {
      const scenario = itemPlans.get(row.id);
      if (scenario.status === "expedite" && row.status !== "expedite") newlyShort++;
      if (needsLongerForecast(scenario) && !needsLongerForecast(row)) newlyLimited++;
    }
    const changes = [];
    if (newlyShort) changes.push(words(newlyShort, "additional item") + " expected to run short before delivery.");
    if (newlyLimited) {
      changes.push(words(newlyLimited, "additional plan") +
        (newlyLimited === 1 ? " needs" : " need") + " a longer forecast.");
    }
    return changes.join(" ");
  }

  function refreshPlan() {
    const delay = Number(ui.delay.value || 0);
    plan = data ? retailReorder.buildPlan(data.series, data.forecast_dates, inventory, delay) : [];
    itemPlans = new Map(plan.map(row => [row.id, row]));
    orders = plan.filter(row => row.orderUnits > 0);
    ui["risk-count"].textContent = formatNumber(plan.filter(row => row.status === "expedite").length);
    ui["order-count"].textContent = formatNumber(orders.length);
    const orderUnits = orders.reduce((total, row) => total + BigInt(row.orderUnits), 0n);
    ui["order-units"].textContent = formatNumber(orderUnits);
    ui["scenario-impact"].textContent = describeDelay(delay);
    ui.export.disabled = !orders.length;
    ui.export.textContent = delay ? "Download scenario CSV" : "Download order draft";
    if (data) {
      const counts = plan.filter(row => row.stock?.onHand != null).length;
      const status = formatNumber(counts) + " of " + formatNumber(plan.length) + " items with opening stock";
      const unmatched = [...inventory.keys()].filter(id => !itemPlans.has(id)).length;
      const limited = plan.filter(needsLongerForecast).length;
      ui["import-status"].textContent = [
        inventoryName, status, unmatched ? words(unmatched, "unmatched ID") : "",
        limited ? words(limited, "item") + " beyond the forecast" : "",
      ]
        .filter(Boolean).join(" · ");
    } else {
      ui["import-status"].textContent = "Load sales history to add stock.";
    }
    renderRows();
    renderDecision();
  }

  function clearForecast(changedSource) {
    data = null;
    selectedId = null;
    holdoutEvidence = "";
    ui.start.textContent = "";
    ui.file.disabled = true;
    ui.template.disabled = true;
    if (changedSource) {
      inventory = null;
      inventoryName = "";
      importRequest = null;
      page = 0;
      ui.delay.value = "0";
      ui.filter.value = "all";
      ui.search.value = "";
      setError("");
    }
    populateEditor();
    refreshPlan();
  }

  function showForecast(forecast, sampleLabel, id) {
    data = forecast;
    selectedId = id;
    if (inventory === null) {
      inventory = sampleLabel ? retailReorder.sampleInventory(data.series) : new Map();
      inventoryName = sampleLabel;
    }
    ui.start.textContent = "Opening stock on " + formatDate(data.forecast_dates[0]);
    ui.file.disabled = false;
    ui.template.disabled = false;
    populateEditor();
    refreshPlan();
  }

  function selectItem(id, evidence) {
    holdoutEvidence = evidence;
    if (selectedId !== id) {
      selectedId = id;
      populateEditor();
      highlightSelection();
    }
    renderDecision();
  }

  async function importInventory(file) {
    if (!data) return;
    const forecast = data;
    const request = {};
    importRequest = request;
    setError("");
    try {
      const csv = await retailCsv.readFile(file);
      if (importRequest !== request) return;
      const parsed = retailReorder.parseInventory(csv, forecast.forecast_dates[0]);
      if (!forecast.series.some(item => parsed.has(item.id))) {
        throw new Error("Match at least one inventory series_id to the current sales file.");
      }
      inventory = parsed;
      inventoryName = file.name;
      page = 0;
      populateEditor();
      refreshPlan();
    } catch (error) {
      if (importRequest === request) setError(error.message);
    } finally {
      if (importRequest === request) importRequest = null;
    }
  }

  ui.file.addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) importInventory(file);
  });

  ui.form.addEventListener("submit", event => {
    event.preventDefault();
    if (!data || selectedId === null) return;
    const supplier = inventory.get(selectedId)?.supplier ?? "";
    const stock = { supplier };
    for (const [id, key, minimum] of editableFields) {
      const field = ui[id];
      field.removeAttribute("aria-invalid");
      const value = field.valueAsNumber;
      if (key === "onHand" && field.value === "" && !field.validity.badInput) {
        stock[key] = null;
      } else if (Number.isSafeInteger(value) && value >= minimum) {
        stock[key] = value;
      } else {
        field.setAttribute("aria-invalid", "true");
        ui.detail.dataset.status = "unavailable";
        ui.detail.textContent = "Use whole numbers within the supported range.";
        field.focus();
        return;
      }
    }
    importRequest = null;
    inventory.set(selectedId, stock);
    if (!inventoryName) inventoryName = "Manual inventory";
    setError("");
    refreshPlan();
  });

  ui.delay.addEventListener("change", () => {
    page = 0;
    refreshPlan();
  });
  for (const [node, event] of [[ui.filter, "change"], [ui.search, "input"]]) {
    node.addEventListener(event, () => {
      page = 0;
      renderRows();
    });
  }
  ui.previous.addEventListener("click", () => { page = Math.max(0, page - 1); renderRows(); });
  ui.next.addEventListener("click", () => { page++; renderRows(); });

  ui.template.addEventListener("click", () => {
    if (!data) return;
    retailCsv.download("inventory-template.csv", [
      "series_id,on_hand,lead_days,cover_days,pack_size,supplier,stock_date",
      "item-123,50,2,7,12,Example Supplier," + data.forecast_dates[0],
    ]);
  });
  ui.export.addEventListener("click", () => {
    if (!data || !orders.length) return;
    const start = data.forecast_dates[0];
    const delay = Number(ui.delay.value || 0);
    const lines = [
      "series_id,supplier,action,stock_date,on_hand,scheduled_lead_days,delay_days," +
      "arrival_date,coverage_end,first_shortage_date,projected_short_before_arrival," +
      "pack_size,order_packs,order_units",
    ];
    for (const row of orders) {
      lines.push([
        retailCsv.textCell(row.id), retailCsv.textCell(row.stock.supplier), row.status, start,
        row.stock.onHand, row.stock.leadDays, delay, row.arrivalDate, row.coverageEnd,
        row.firstShortageDate ?? "", row.preArrivalShortfall, row.stock.packSize,
        row.orderPacks, row.orderUnits,
      ].join(","));
    }
    const name = delay ? "reorder-scenario-plus-" + delay + "d-" : "reorder-draft-";
    retailCsv.download(name + start + ".csv", lines);
  });

  return { clearForecast, showForecast, selectItem };
}
