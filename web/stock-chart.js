"use strict";

function createBalancePlot(canvas, caption, formatShortDate) {
  const compact = new Intl.NumberFormat("en-SG", { notation: "compact", maximumFractionDigits: 1 });
  let chart = null;
  let selected = null;
  let plot = null;

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    plot = null;
    if (!chart?.dates.length) return;
    const { dates, opening, lines, lead, delay = 0, references = [], band, shortages } = chart;
    const left = 37, right = width - 10, top = 27, bottom = height - 24;
    const step = (right - left) / dates.length;
    const x = i => left + i * step;
    const peak = Math.max(1, opening, ...references.map(ref => ref.value), ...(band?.high ?? []),
      ...lines.flatMap(({ days }) => days.map((day, i) => (days[i - 1]?.balance ?? opening) + day.receipt)));
    const y = units => bottom - units / peak / 1.08 * (bottom - top);
    plot = { left, step };

    if (delay > 0) {
      const start = Math.min(dates.length, lead - delay);
      ctx.fillStyle = "rgba(181, 71, 8, .1)";
      ctx.fillRect(x(start), top, x(Math.min(dates.length, lead)) - x(start), bottom - top);
    }

    for (const [index, short] of shortages.entries()) {
      if (!short) continue;
      ctx.fillStyle = "#b42318";
      ctx.fillRect(x(index), bottom - 3, step, 3);
    }
    if (band) {
      ctx.fillStyle = "rgba(30, 58, 95, .12)";
      band.low.forEach((value, index) => {
        const upper = y(band.high[index]);
        ctx.fillRect(x(index), upper, step, y(value) - upper);
      });
    }
    if (selected !== null) {
      ctx.fillStyle = "rgba(30, 58, 95, .09)";
      ctx.fillRect(x(selected), top, step, bottom - top);
    }

    function line(x1, y1, x2, y2, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.textAlign = "right";
    for (const tick of [0, peak / 2, peak]) {
      line(left, y(tick), right, y(tick), "#ece9e2");
      ctx.fillStyle = "#5c6168";
      ctx.fillText(compact.format(tick), left - 5, y(tick));
    }
    ctx.setLineDash([3, 4]);
    if (lead < dates.length) {
      const delivery = x(lead);
      line(delivery, top, delivery, bottom, delay ? "#b54708" : "#5c6168");
      const label = delay ? "Receipt +" + delay + "d" : "Receipt";
      ctx.fillStyle = delay ? "#b54708" : "#5c6168";
      ctx.textAlign = delivery > right - 82 ? "right" : "left";
      ctx.fillText(label, delivery + (ctx.textAlign === "right" ? -4 : 4), 12);
    }
    ctx.textAlign = "right";
    let lastLabel = bottom + 12;
    for (const { value, label, color } of [...references].sort((a, b) => a.value - b.value)) {
      const position = y(value);
      line(left, position, right, position, color);
      lastLabel = Math.min(lastLabel - 13, position - 7);
      const text = label + " " + compact.format(value);
      ctx.fillStyle = "#fff";
      const labelWidth = ctx.measureText(text).width + 4;
      ctx.fillRect(right - labelWidth, lastLabel - 6, labelWidth, 12);
      ctx.fillStyle = color;
      ctx.fillText(text, right, lastLabel);
    }
    for (const { days, color, dashed } of lines) {
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.5 : 2;
      ctx.beginPath();
      ctx.moveTo(left, y(opening));
      days.forEach(({ receipt, balance }, index) => {
        if (receipt) ctx.lineTo(x(index), y((days[index - 1]?.balance ?? opening) + receipt));
        const beforeSales = (days[index - 1]?.balance ?? opening) + receipt;
        ctx.lineTo(x(index + 1), y(beforeSales));
        ctx.lineTo(x(index + 1), y(balance));
      });
      ctx.stroke();
    }
    ctx.fillStyle = "#5c6168";
    ctx.textAlign = "left";
    ctx.fillText(formatShortDate(dates[0]), left, bottom + 14);
    ctx.textAlign = "right";
    ctx.fillText(formatShortDate(dates.at(-1)), right, bottom + 14);
  }

  function select(index) {
    if (index === selected) return;
    selected = index;
    caption.textContent = index === null ? chart.summary : chart.readDay(index);
    draw();
  }

  function selectPointer(event) {
    if (!plot) return;
    const localX = event.clientX - canvas.getBoundingClientRect().left;
    select(Math.min(chart.dates.length - 1, Math.max(0, Math.floor((localX - plot.left) / plot.step))));
  }

  canvas.addEventListener("pointermove", selectPointer);
  canvas.addEventListener("pointerdown", selectPointer);
  canvas.addEventListener("pointerleave", () => select(null));
  canvas.addEventListener("keydown", event => {
    if (!chart?.dates.length || !["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    select(event.key === "Escape" ? null : Math.min(chart.dates.length - 1, Math.max(0, (selected ?? -direction) + direction)));
  });
  new ResizeObserver(draw).observe(canvas);
  return next => {
    chart = next;
    selected = null;
    canvas.tabIndex = next?.dates.length ? 0 : -1;
    caption.textContent = next?.summary ?? "Opening stock is required.";
    draw();
  };
}

function projectStock(opening, forecast, lead, receipt, shift = 0) {
  let balance = opening;
  return forecast.map((value, day) => {
    const delivered = day === lead ? receipt : 0;
    const demand = Math.max(0, value + shift);
    const available = balance + delivered;
    balance = Math.max(0, available - demand);
    return { receipt: delivered, balance, demand, missed: Math.max(0, demand - available) };
  });
}

function stockReferences(row) {
  const safety = row.stock.safetyStock ?? 0;
  const reorderPoint = row.arrivalDate ? row.preArrivalDemand + safety : null;
  const refs = [];
  if (safety > 0 && safety !== reorderPoint) refs.push({ label: "Safety", value: safety, color: "#166534" });
  if (reorderPoint > 0) refs.push({ label: safety === reorderPoint ? "ROP / safety" : "ROP", value: reorderPoint, color: "#b54708" });
  return refs;
}

function createStockChart({ formatDate, formatShortDate, formatNumber }) {
  const canvas = document.getElementById("stock-chart");
  const caption = document.getElementById("stock-caption");
  const legend = document.getElementById("stock-legend");
  const plot = createBalancePlot(canvas, caption, formatShortDate);
  return {
    show(row, forecast, dates, error) {
      const usable = row?.stock?.onHand != null && row.status !== "unavailable";
      legend.hidden = !usable;
      if (!usable) {
        plot(null);
        return;
      }
      const projection = forecast.slice(0, row.requiredDays);
      dates = dates.slice(0, projection.length);
      const opening = row.stock.onHand;
      const lead = row.effectiveLeadDays;
      const receipt = row.orderUnits ?? 0;
      const delay = lead - row.stock.leadDays;
      const draft = projectStock(opening, projection, lead, receipt);
      const lines = [{ days: projectStock(opening, projection, lead, 0), color: "#5c6168", dashed: true }];
      if (receipt) lines.push({ days: draft, color: "#1e3a5f" });
      const band = error > 0 ? {
        low: projectStock(opening, projection, lead, receipt, error).map(day => day.balance),
        high: projectStock(opening, projection, lead, receipt, -error).map(day => day.balance),
      } : null;
      legend.children[0].hidden = !receipt;
      legend.querySelector(".legend-delay").hidden = !delay;
      legend.querySelector(".legend-band").hidden = !band;

      const arrival = row.arrivalDate ? "Delivery " + formatShortDate(row.arrivalDate) : "Delivery outside horizon";
      const summary = [arrival + (delay ? " (+" + delay + "d)" : ""),
        row.orderUnits === null ? "Draft unavailable" : "",
        band ? "Sensitivity ±" + formatNumber(error) + " units/day (holdout MAE)" : "",
      ].filter(Boolean).join(" · ");
      plot({ dates, opening, lines, lead, delay, references: stockReferences(row), band, summary,
        shortages: draft.map((day, i) => i < lead && day.missed > 1e-9),
        readDay(index) {
          const day = draft[index];
          const reading = [formatDate(dates[index]), formatNumber(day.demand) + " forecast",
            formatNumber(lines[0].days[index].balance) + " left from opening stock"];
          if (receipt) reading.push(formatNumber(day.balance) + " left with draft");
          if (day.receipt) reading.push("+" + formatNumber(day.receipt) + " draft receipt");
          if (day.missed > 1e-9 && (row.orderUnits !== null || index < lead)) reading.push(formatNumber(day.missed) + " units short");
          return reading.join(" · ");
        },
      });
    },
  };
}
