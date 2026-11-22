"use strict";

function createBalancePlot(canvas, caption, formatShortDate, onInspect = () => {}) {
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
    const style = getComputedStyle(canvas);
    const color = name => style.getPropertyValue("--plot-" + name).trim();
    ctx.scale(scale, scale);
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    plot = null;
    if (!chart?.dates.length) return;
    const { dates, opening, lines, lead, delay = 0, references = [], band, shortages, demand } = chart;
    const left = 47, right = width - 12, top = 29, bottom = height - (demand ? 61 : 24);
    const dateAxis = height - 9;
    const step = (right - left) / dates.length;
    const x = i => left + i * step;
    const peak = Math.max(1, opening, ...references.map(ref => ref.value), ...(band?.high ?? []),
      ...lines.flatMap(({ days }) => days.map((day, i) => (days[i - 1]?.balance ?? opening) + day.receipt)));
    const y = units => bottom - units / peak / 1.08 * (bottom - top);
    plot = { left, step };

    function line(x1, y1, x2, y2, ink) {
      ctx.strokeStyle = ink;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    for (let index = 0; index <= dates.length; index++) {
      line(x(index), top, x(index), bottom, color("grid"));
    }
    if (delay > 0) {
      const start = Math.min(dates.length, lead - delay);
      ctx.fillStyle = color("delay-fill");
      ctx.fillRect(x(start), top, x(Math.min(dates.length, lead)) - x(start), bottom - top);
    }

    for (const [index, short] of shortages.entries()) {
      if (!short) continue;
      ctx.fillStyle = color("risk");
      ctx.fillRect(x(index), bottom - 3, step, 3);
    }
    if (band) {
      ctx.fillStyle = color("band");
      band.low.forEach((value, index) => {
        const upper = y(band.high[index]);
        ctx.fillRect(x(index), upper, step, y(value) - upper);
      });
    }
    if (selected !== null) {
      ctx.fillStyle = color("focus");
      ctx.fillRect(x(selected), top, step, dateAxis - 15 - top);
      line(x(selected + .5), top, x(selected + .5), dateAxis - 15, color("axis"));
    }

    ctx.textAlign = "right";
    for (const tick of [0, peak / 4, peak / 2, peak * .75, peak]) {
      line(left, y(tick), right, y(tick), color("grid"));
      ctx.fillStyle = color("axis");
      ctx.fillText(compact.format(tick), left - 5, y(tick));
    }
    ctx.setLineDash([3, 4]);
    if (lead < dates.length) {
      const delivery = x(lead);
      line(delivery, top, delivery, bottom, color(delay ? "delay" : "axis"));
      const label = delay ? "Receipt +" + delay + "d" : "Receipt";
      ctx.fillStyle = color(delay ? "delay" : "axis");
      ctx.textAlign = delivery > right - 82 ? "right" : "left";
      ctx.fillText(label, delivery + (ctx.textAlign === "right" ? -4 : 4), 12);
    }
    ctx.textAlign = "right";
    let lastLabel = bottom + 12;
    for (const { value, label, tone } of [...references].sort((a, b) => a.value - b.value)) {
      const position = y(value);
      line(left, position, right, position, color(tone));
      lastLabel = Math.min(lastLabel - 13, position - 7);
      const text = label + " " + compact.format(value);
      ctx.fillStyle = color("surface");
      const labelWidth = ctx.measureText(text).width + 4;
      ctx.fillRect(right - labelWidth, lastLabel - 6, labelWidth, 12);
      ctx.fillStyle = color(tone);
      ctx.fillText(text, right, lastLabel);
    }
    for (const { days, dashed } of lines) {
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.strokeStyle = color(dashed ? "comparison" : "primary");
      ctx.lineWidth = dashed ? 1.5 : 2.5;
      ctx.beginPath();
      ctx.moveTo(left, y(opening));
      days.forEach(({ receipt, balance }, index) => {
        if (receipt) ctx.lineTo(x(index), y((days[index - 1]?.balance ?? opening) + receipt));
        const beforeSales = (days[index - 1]?.balance ?? opening) + receipt;
        ctx.lineTo(x(index + 1), y(beforeSales));
        ctx.lineTo(x(index + 1), y(balance));
      });
      ctx.stroke();
      if (selected !== null) {
        const marker = y(days[selected].balance);
        ctx.fillStyle = color(dashed ? "comparison" : "primary");
        ctx.fillRect(x(selected + 1) - 3, marker - 3, 6, 6);
      }
    }
    if (demand) {
      const base = dateAxis - 15;
      const maxDemand = Math.max(1, ...demand);
      line(left, base, right, base, color("grid"));
      ctx.fillStyle = color("axis");
      ctx.textAlign = "right";
      ctx.fillText("Demand", left - 5, base - 10);
      demand.forEach((units, index) => {
        const height = (units / maxDemand) * 27;
        ctx.fillStyle = color(index === selected ? "primary" : "demand");
        ctx.fillRect(x(index) + step * .19, base - height, step * .62, height);
      });
    }
    ctx.fillStyle = color("axis");
    ctx.textAlign = "left";
    ctx.fillText(formatShortDate(dates[0]), left, dateAxis);
    ctx.textAlign = "right";
    ctx.fillText(formatShortDate(dates.at(-1)), right, dateAxis);
  }

  function select(index) {
    if (index === selected) return;
    selected = index;
    caption.textContent = index === null ? chart.summary : chart.readDay(index);
    draw();
    onInspect(index);
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
  return {
    show(next) {
      chart = next;
      selected = next?.focusIndex >= 0 ? next.focusIndex : null;
      canvas.tabIndex = next?.dates.length ? 0 : -1;
      caption.textContent = selected === null ? next?.summary ?? "Opening stock is required." : next.readDay(selected);
      draw();
      onInspect(selected);
    },
    inspect: select,
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
  if (safety > 0 && safety !== reorderPoint) refs.push({ label: "Safety", value: safety, tone: "safety" });
  if (reorderPoint > 0) refs.push({ label: safety === reorderPoint ? "ROP / safety" : "ROP", value: reorderPoint, tone: "delay" });
  return refs;
}

function createStockTape({ formatDate, formatShortDate, formatNumber, onChoose }) {
  const body = document.getElementById("stock-tape-rows");
  const buttons = document.querySelectorAll(".tape-filters button");
  let lines = [];
  let mode = "events";
  let active = null;
  let visibleRows = [];

  function highlight(index) {
    active = index;
    for (const [day, row, button] of visibleRows) {
      row.dataset.selected = String(day === index);
      button.setAttribute("aria-pressed", String(day === index));
    }
  }

  function render() {
    body.replaceChildren();
    visibleRows = [];
    lines.forEach(({ date, demand, receipt, balance, short }, index) => {
      if (mode === "events" && !receipt && !(short > 1e-9)) return;
      const row = body.insertRow();
      row.dataset.kind = short > 1e-9 ? "short" : receipt > 0 ? "receipt" : "regular";
      const cell = row.insertCell();
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.className = "tape-date";
      inspect.textContent = formatShortDate(date);
      inspect.setAttribute("aria-label", "Inspect " + formatDate(date));
      inspect.addEventListener("click", () => onChoose(index));
      cell.append(inspect);
      row.insertCell().textContent = formatNumber(demand);
      row.insertCell().textContent = receipt ? "+" + formatNumber(receipt) : "—";
      row.insertCell().textContent = balance === null ? "—" : formatNumber(balance);
      row.insertCell().textContent = short === null ? "—" : formatNumber(short > 1e-9 ? short : 0);
      visibleRows.push([index, row, inspect]);
    });
    if (!visibleRows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = 5;
      cell.className = "empty-cell";
      cell.textContent = lines.length ? "No receipts or shortages in this window." : "Opening stock is required.";
    }
    highlight(active);
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      mode = button.dataset.tape;
      for (const sibling of buttons) sibling.setAttribute("aria-pressed", String(sibling === button));
      render();
    });
  }
  return {
    show(next) {
      lines = next;
      active = null;
      for (const button of buttons) button.disabled = !lines.length;
      render();
    },
    highlight,
  };
}

function createStockChart({ formatDate, formatShortDate, formatNumber }) {
  const canvas = document.getElementById("stock-chart");
  const caption = document.getElementById("stock-caption");
  const legend = document.getElementById("stock-legend");
  const tape = createStockTape({ formatDate, formatShortDate, formatNumber, onChoose: index => plot.inspect(index) });
  const plot = createBalancePlot(canvas, caption, formatShortDate, tape.highlight);
  return {
    show(row, forecast, dates, error, focusDate) {
      const usable = row?.stock?.onHand != null && row.status !== "unavailable";
      legend.hidden = !usable;
      if (!usable) {
        tape.show([]);
        plot.show(null);
        return;
      }
      const projection = forecast.slice(0, row.requiredDays);
      dates = dates.slice(0, projection.length);
      const opening = row.stock.onHand;
      const lead = row.effectiveLeadDays;
      const receipt = row.orderUnits ?? 0;
      const delay = lead - row.stock.leadDays;
      const draft = projectStock(opening, projection, lead, receipt);
      const lines = [{ days: projectStock(opening, projection, lead, 0), dashed: true }];
      if (receipt) lines.push({ days: draft });
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
      tape.show(draft.map(({ demand, receipt, balance, missed }, index) => {
        const known = row.orderUnits !== null || index < lead;
        return { date: dates[index], demand, receipt, balance: known ? balance : null, short: known ? missed : null };
      }));
      plot.show({ dates, opening, lines, lead, delay, demand: projection, references: stockReferences(row),
        band, summary, focusIndex: dates.indexOf(focusDate),
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
