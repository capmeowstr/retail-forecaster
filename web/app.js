"use strict";

const ui = Object.fromEntries([
  "analysis-form", "demo-button", "retail-button", "history-file", "horizon", "run-button", "input-status",
  "notice", "export-button", "metric-selected", "metric-baseline", "metric-delta", "model-name",
  "source-name", "series-select", "forecast-chart", "chart-details", "model-rows", "holdout-details",
  "forecast-rows", "slice-rows", "forecast-total",
].map(id => [id, document.getElementById(id)]));
const modelNames = {
  "seasonal-naive": "Repeat last week",
  "recent-mean": "Recent average",
  "weekday-mean": "Item weekday average",
  "pooled-weekday": "Pooled weekday pattern",
};
const numbers = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 2 });
const percents = new Intl.NumberFormat("en-SG", {
  style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const signedPercents = new Intl.NumberFormat("en-SG", {
  style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero",
});
const shortDate = new Intl.DateTimeFormat("en-SG", {
  day: "numeric", month: "short", timeZone: "UTC",
});
const fullDate = new Intl.DateTimeFormat("en-SG", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});
const dayMs = 86_400_000;
const canvas = ui["forecast-chart"];
const samplePayload = document.getElementById("offline-demo-data");
const offlineSamples = samplePayload ? JSON.parse(samplePayload.textContent) : null;
const offlineEngine = document.getElementById("offline-engine");
const offlineCsv = document.getElementById("offline-csv");
const stockTolerance = 1e-9;
let result = null;
let upload = null;
let example = "demo";
let request = null;
let currentSource;
let currentSeries = null;
let chartIndex = null;
let chartFrame = null;
let defaultChartDetails = "";

const dateValue = day => Date.parse(day + "T00:00:00Z");
const percent = value => value === null ? "N/A" : percents.format(value);
const displayName = model => modelNames[model] ?? model;
const formatDate = day => fullDate.format(dateValue(day));
const formatShortDate = day => shortDate.format(dateValue(day));
const dateRange = (first, last) => formatShortDate(first) + " – " + formatDate(last);
const replayView = createReplayView({ dateRange, formatDate, formatShortDate, formatNumber: numbers.format, displayName });
const reorderView = createReorderView({
  formatDate,
  formatShortDate,
  formatNumber: numbers.format,
  unitsText,
  onSelect: id => {
    if (!result) return;
    const index = result.series.findIndex(series => series.id === id);
    if (index < 0) return;
    ui["series-select"].value = String(index);
    renderSeries();
  },
});

const navLinks = document.querySelectorAll(".desk-nav a");
function updateNavigation() {
  const section = [...navLinks].some(link => link.hash === location.hash) ? location.hash : "#reorder-board";
  for (const link of navLinks) {
    const active = link.hash === section;
    document.getElementById(link.hash.slice(1)).hidden = !active;
    if (active) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  if (section === "#forecast-evidence") drawChart();
}
for (const link of navLinks) {
  link.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (location.hash !== link.hash) history.pushState(null, "", link.hash);
    updateNavigation();
    window.scrollTo(0, 0);
  });
}
window.addEventListener("hashchange", updateNavigation);
updateNavigation();

function addRow(body, values) {
  const row = body.insertRow();
  for (const value of values) row.insertCell().textContent = value;
  return row;
}

function resetTable(id, columns, text) {
  const body = ui[id];
  body.replaceChildren();
  const cell = addRow(body, [text]).cells[0];
  cell.colSpan = columns;
  cell.className = "empty-cell";
}

function showNotice(text, kind = "info") {
  ui.notice.dataset.kind = kind;
  ui.notice.textContent = text;
}

function selectedSeries() {
  return result.series[Number(ui["series-select"].value)];
}

function unitsText(units) {
  if (units > 0 && units < 0.01) return "less than 0.01 units";
  return numbers.format(units) + (units === 1 ? " unit" : " units");
}

function holdoutEvidence(item) {
  const report = result.report;
  if (!report.holdout) return "Recent sales baseline. More history is needed for a holdout test.";
  const summaries = report.holdout.selected_by_series;
  if (!Object.hasOwn(summaries, item.id)) return "This series had too little history for the holdout test.";
  const {actual_units: actual, forecast_units: forecast} = summaries[item.id];
  const difference = forecast - actual;
  const period = report.horizon + "-day holdout";
  if (Math.abs(difference) <= stockTolerance) return "Forecast and recorded totals matched in the " + period + ".";
  return "The forecast was " + unitsText(Math.abs(difference)) + " " + (difference < 0 ? "below" : "above") +
    " recorded sales in the " + period + ".";
}

function clearResult(source, changedSource = false) {
  result = null;
  reorderView.clearForecast(changedSource);
  replayView.clear();
  chartIndex = null;
  chartFrame = null;
  ui["export-button"].disabled = true;
  ui["series-select"].disabled = true;
  ui["series-select"].replaceChildren(new Option("Choose a series", ""));
  for (const id of ["metric-selected", "metric-baseline", "metric-delta"]) ui[id].textContent = "—";
  delete ui["metric-delta"].dataset.direction;
  ui["model-name"].textContent = "Model pending";
  ui["source-name"].textContent = source;
  ui["holdout-details"].textContent = "WAPE is absolute forecast error divided by actual sales. Lower is better.";
  ui["chart-details"].textContent = "Daily observed sales and future estimates appear after a forecast run.";
  ui["forecast-total"].textContent = "Daily estimates for the selected series";
  resetTable("model-rows", 3, "Model scores will appear here after a forecast run.");
  resetTable("forecast-rows", 2, "Daily estimates will appear here after a forecast run.");
  resetTable("slice-rows", 5, "Segment scores will appear here after a forecast run.");
  drawChart();
}

function renderAccuracy(report) {
  const holdout = report.holdout;
  ui["model-name"].textContent = displayName(report.selected_model);
  if (!holdout) {
    ui["model-name"].textContent = "Recent sales baseline";
    ui["holdout-details"].textContent = "Comparing models for this horizon requires at least one series with " +
      report.required_history_days + " days of sales history.";
    resetTable("model-rows", 3, "More sales history needed to compare models.");
    resetTable("slice-rows", 5, "More sales history needed for a holdout test.");
    return;
  }
  ui["metric-selected"].textContent = percent(holdout.selected.wape);
  ui["metric-baseline"].textContent = percent(holdout.baseline.wape);
  if (holdout.selected.wape !== null && holdout.baseline.wape !== null) {
    const gap = (holdout.selected.wape - holdout.baseline.wape) * 100;
    const direction = Math.abs(gap) < 0.005 ? "equal" : gap > 0 ? "higher" : "lower";
    ui["metric-delta"].textContent = direction === "equal" ? "Even" : numbers.format(Math.abs(gap)) + " pp " + direction;
    ui["metric-delta"].dataset.direction = direction;
  } else {
    ui["metric-delta"].textContent = "N/A";
  }
  const period = dateRange(holdout.forecast_start, holdout.forecast_end);
  const reason = holdout.selected.wape === null
    ? "Actual sales total zero. See MAE below."
    : (holdout.series_count < holdout.total_series ? "Some series had too little history to score." : "Lower WAPE is better.");
  ui["holdout-details"].textContent =
    period + " · " + holdout.series_count + " of " + holdout.total_series + " series scored. " + reason;

  const modelRows = ui["model-rows"];
  modelRows.replaceChildren();
  const ranked = Object.entries(report.selection_scores).sort((a, b) => a[1].mae - b[1].mae);
  for (const [model, score] of ranked) {
    const selected = model === report.selected_model;
    const row = addRow(modelRows, [
      displayName(model) + (selected ? " · Selected" : ""),
      percent(score.wape), numbers.format(score.mae),
    ]);
    row.dataset.selected = selected;
  }

  const slices = ui["slice-rows"];
  slices.replaceChildren();
  for (const [name, metrics] of Object.entries(holdout.slices)) {
    addRow(slices, [
      name === "sparse" ? "Sparse" : "Regular",
      numbers.format(metrics.series_count),
      numbers.format(metrics.selected.mae),
      numbers.format(metrics.baseline.mae),
      metrics.selected.unit_bias === null ? "N/A" : signedPercents.format(metrics.selected.unit_bias),
    ]);
  }
}

function renderResult(data, sourceKind) {
  renderAccuracy(data.report);
  const picker = ui["series-select"];
  const options = document.createDocumentFragment();
  data.series.forEach((series, index) => options.append(new Option(series.id, index)));
  picker.replaceChildren(options);
  const previousIndex = data.series.findIndex(series => series.id === currentSeries);
  picker.value = String(Math.max(0, previousIndex));
  picker.disabled = false;
  ui["export-button"].disabled = false;
  const stockLabel = { demo: "Sample inventory", retail: "Illustrative inventory", upload: "" }[sourceKind];
  reorderView.showForecast(data, stockLabel, selectedSeries().id);
  replayView.show(data.report, sourceKind);
  renderSeries();
}

function renderSeries() {
  if (!result) return;
  chartIndex = null;
  const item = selectedSeries();
  currentSeries = item.id;
  const days = result.forecast_dates;
  const total = item.forecast.reduce((sum, units) => sum + units, 0);
  ui["forecast-total"].textContent = days.length + " days · " + numbers.format(total) + " estimated units";
  defaultChartDetails = item.id + " · Observations through " + fullDate.format(dateValue(result.cutoff)) +
    " · Forecast " + dateRange(days[0], days.at(-1));
  ui["chart-details"].textContent = defaultChartDetails;
  const rows = ui["forecast-rows"];
  rows.replaceChildren();
  for (const [index, day] of days.entries()) {
    addRow(rows, [fullDate.format(dateValue(day)), numbers.format(item.forecast[index])]);
  }
  reorderView.selectItem(item.id, holdoutEvidence(item));
  drawChart();
}

function strokeSeries(context, values, x, y, first, color, dashed = false) {
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = dashed ? 2.25 : 1.7;
  context.setLineDash(dashed ? [6, 4] : []);
  values.forEach((value, offset) => {
    if (offset === 0) context.moveTo(x(first), y(value));
    else context.lineTo(x(first + offset), y(value));
  });
  context.stroke();
  context.setLineDash([]);
}

function drawChart() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.font = "11px ui-monospace, monospace";
  context.textBaseline = "middle";
  context.lineJoin = "round";

  if (!result) {
    context.fillStyle = "#515b50";
    context.textAlign = "center";
    context.fillText(request ? "Reading sales history…" : "Forecast chart", width / 2, height / 2);
    return;
  }

  const item = selectedSeries();
  const values = [...item.history, ...item.forecast];
  const firstFuture = item.history.length;
  const max = Math.max(...values, 1);
  const rawStep = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) ?? 10) * magnitude;
  const peak = 4 * step;
  const left = max >= 1000 ? 45 : 36;
  const right = width - 12;
  const top = 23;
  const bottom = height - 27;
  const x = index => left + index * (right - left) / (values.length - 1);
  const y = value => bottom - value * (bottom - top) / peak;
  const boundary = (x(firstFuture - 1) + x(firstFuture)) / 2;
  const startDay = dateValue(result.cutoff) - (firstFuture - 1) * dayMs;
  chartFrame = { left, right, values };

  context.fillStyle = "#edf1df";
  context.fillRect(boundary, top, right - boundary, bottom - top);
  context.lineWidth = 1;
  context.textAlign = "right";
  for (let tick = 0; tick <= 4; tick++) {
    const value = tick * step;
    const line = y(value);
    context.strokeStyle = "#dddccf";
    context.beginPath();
    context.moveTo(left, line);
    context.lineTo(right, line);
    context.stroke();
    context.fillStyle = "#515b50";
    context.fillText(numbers.format(value), left - 7, line);
  }
  context.beginPath();
  context.strokeStyle = "#a4ab98";
  context.moveTo(boundary, top);
  context.lineTo(boundary, bottom);
  context.stroke();

  context.fillStyle = "#515b50";
  const ticks = width < 420 ? [0, firstFuture - 1, values.length - 1] :
    [0, Math.floor((firstFuture - 1) / 2), firstFuture - 1, values.length - 1];
  for (const index of new Set(ticks)) {
    context.textAlign = index === 0 ? "left" : index === values.length - 1 ? "right" : "center";
    context.fillText(shortDate.format(startDay + index * dayMs), x(index), bottom + 15);
  }
  strokeSeries(context, item.history, x, y, 0, "#515b50");
  if (item.history.length === 1) {
    context.fillStyle = "#515b50";
    context.beginPath();
    context.arc(x(0), y(item.history[0]), 2.5, 0, 2 * Math.PI);
    context.fill();
  }
  strokeSeries(context, [item.history.at(-1), ...item.forecast], x, y, firstFuture - 1, "#253b2d", true);
  if (chartIndex !== null) {
    const value = values[chartIndex];
    context.strokeStyle = "#515b50";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x(chartIndex), top);
    context.lineTo(x(chartIndex), bottom);
    context.stroke();
    context.fillStyle = "#253b2d";
    context.beginPath();
    context.arc(x(chartIndex), y(value), 3.5, 0, 2 * Math.PI);
    context.fill();
    const kind = chartIndex < firstFuture ? "Observed" : "Forecast";
    ui["chart-details"].textContent =
      fullDate.format(startDay + chartIndex * dayMs) + " · " + kind + " · " + unitsText(value);
  }
}

async function analyze() {
  request?.abort();
  const next = new AbortController();
  request = next;
  const file = upload;
  const sourceKind = file ? "upload" : example;
  const sourceKey = file ?? sourceKind;
  const changedSource = currentSource !== sourceKey;
  if (changedSource) {
    currentSource = sourceKey;
    currentSeries = null;
  }
  const source = file?.name ?? (sourceKind === "retail" ? "UCI Online Retail · UK sales" : "Sample data · Synthetic sales");
  const horizon = ui.horizon.value;
  ui["demo-button"].setAttribute("aria-pressed", String(sourceKind === "demo"));
  ui["retail-button"].setAttribute("aria-pressed", String(sourceKind === "retail"));
  clearResult(source, changedSource);
  ui["input-status"].textContent = source;
  ui["run-button"].disabled = true;
  ui["run-button"].textContent = "Running…";
  showNotice("");
  try {
    const data = await loadForecast(horizon, file, sourceKind, next.signal);
    if (request !== next) return;
    result = data;
    renderResult(data, sourceKind);
    ui["input-status"].textContent = source + " · " + numbers.format(data.series.length) + " series";
  } catch (error) {
    if (request !== next) return;
    if (error.name === "AbortError") return;
    clearResult(source);
    const message = !offlineEngine && error instanceof TypeError
      ? "Could not reach the forecast service. Check that serve.py is running."
      : error.message;
    showNotice(message, "error");
  } finally {
    if (request === next) {
      request = null;
      ui["run-button"].disabled = false;
      ui["run-button"].textContent = "Run forecast";
      if (!result) drawChart();
    }
  }
}

function runForecastWorker(text, horizon, signal) {
  return new Promise((resolve, reject) => {
    const receive = `
      self.onmessage = ({ data }) => {
        try {
          self.postMessage({ forecast: analyzeRetailCsv(data.text, data.horizon) });
        } catch (error) {
          self.postMessage({ error: error.message });
        }
      };
    `;
    const source = [offlineCsv.textContent, "\n", offlineEngine.textContent, receive];
    const url = URL.createObjectURL(new Blob(source, { type: "text/javascript" }));
    let worker;
    try {
      worker = new Worker(url);
    } catch {
      URL.revokeObjectURL(url);
      resolve(null);
      return;
    }

    function stop() {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      URL.revokeObjectURL(url);
    }
    function abort() {
      stop();
      reject(signal.reason);
    }
    worker.onmessage = ({ data }) => {
      stop();
      if (data.error) reject(new Error(data.error));
      else resolve(data.forecast);
    };
    worker.onerror = event => {
      event.preventDefault();
      stop();
      resolve(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.postMessage({ text, horizon });
  });
}

async function loadOfflineForecast(horizon, file, signal) {
  const text = await retailCsv.readFile(file);
  signal.throwIfAborted();
  const forecast = typeof Worker === "function" ? await runForecastWorker(text, horizon, signal) : null;
  signal.throwIfAborted();
  return forecast ?? analyzeRetailCsv(text, horizon);
}

async function loadForecast(horizon, file, sourceKind, signal) {
  if (offlineSamples) {
    return file ? loadOfflineForecast(Number(horizon), file, signal) : offlineSamples[sourceKind][horizon];
  }
  const params = new URLSearchParams({ horizon, source: sourceKind });
  const response = await fetch("/api/analyze?" + params, {
    method: "POST", body: file ?? null, signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Forecast failed. Check the CSV and try again.");
  return data;
}

ui["analysis-form"].addEventListener("submit", event => {
  event.preventDefault();
  analyze();
});
function useExample(name) {
  ui["history-file"].value = "";
  upload = null;
  example = name;
  analyze();
}
ui["demo-button"].addEventListener("click", () => useExample("demo"));
ui["retail-button"].addEventListener("click", () => useExample("retail"));
ui["history-file"].addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) {
    event.target.value = "";
    upload = file;
    analyze();
  }
});
ui.horizon.addEventListener("change", analyze);
ui["series-select"].addEventListener("change", renderSeries);
ui["export-button"].addEventListener("click", () => {
  if (!result) return;
  const rows = ["series_id,date,forecast_units"];
  for (const series of result.series) {
    const quotedId = retailCsv.textCell(series.id);
    series.forecast.forEach((units, index) => {
      rows.push([quotedId, result.forecast_dates[index], units].join(","));
    });
  }
  retailCsv.download("retail-forecast-" + result.forecast_dates[0] + ".csv", rows);
});

canvas.addEventListener("pointermove", event => {
  if (!chartFrame) return;
  const { left, right, values } = chartFrame;
  const position = (event.offsetX - left) / (right - left);
  const index = Math.max(0, Math.min(values.length - 1, Math.round(position * (values.length - 1))));
  if (index !== chartIndex) {
    chartIndex = index;
    drawChart();
  }
});
canvas.addEventListener("pointerleave", () => {
  if (!result) return;
  chartIndex = null;
  ui["chart-details"].textContent = defaultChartDetails;
  drawChart();
});
canvas.addEventListener("keydown", event => {
  if (!chartFrame || !["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Escape") {
    chartIndex = null;
    ui["chart-details"].textContent = defaultChartDetails;
  } else {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const last = chartFrame.values.length - 1;
    const previous = chartIndex ?? selectedSeries().history.length - 1;
    chartIndex = Math.max(0, Math.min(last, previous + direction));
  }
  drawChart();
});
new ResizeObserver(drawChart).observe(canvas);
analyze();
