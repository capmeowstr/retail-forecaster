"use strict";

function projectStock(row, forecast, dates) {
  if (!row?.stock || row.stock.onHand === null || row.status === "unavailable") return [];
  const end = Math.min(row.requiredDays, dates.length);
  let withoutOrder = row.stock.onHand;
  let withOrder = withoutOrder;
  return dates.slice(0, end).map((date, index) => {
    const demand = forecast[index];
    const receipt = index === row.effectiveLeadDays ? row.orderUnits ?? 0 : 0;
    const available = withOrder + receipt;
    const missed = Math.max(0, demand - available);
    withOrder = Math.max(0, available - demand);
    withoutOrder = Math.max(0, withoutOrder - demand);
    return { date, demand, receipt, withOrder, withoutOrder, missed };
  });
}

function createStockChart({ formatDate, formatShortDate, formatNumber }) {
  const canvas = document.getElementById("stock-chart");
  const caption = document.getElementById("stock-caption");
  const legend = document.getElementById("stock-legend");
  let plan = null;
  let days = [];
  let selectedDay = null;
  let plot = null;

  function describe() {
    if (!days.length) {
      caption.textContent = "Add a stock count to see the projected balance.";
      return;
    }
    if (selectedDay === null) {
      const arrival = plan.arrivalDate ? "Delivery " + formatShortDate(plan.arrivalDate) : "Delivery outside forecast";
      const end = formatShortDate(days.at(-1).date);
      caption.textContent = arrival + " · Daily stock through " + end +
        (plan.orderUnits === null ? " · Draft unavailable" : "");
      return;
    }
    const day = days[selectedDay];
    const readings = [
      formatDate(day.date),
      formatNumber(day.demand) + " forecast",
      formatNumber(day.withoutOrder) + " left from opening stock",
    ];
    if (plan.orderUnits > 0) readings.push(formatNumber(day.withOrder) + " left with draft");
    if (day.receipt) readings.push("+" + formatNumber(day.receipt) + " received");
    if (day.missed > 1e-9 && (plan.orderUnits !== null || selectedDay < plan.effectiveLeadDays)) {
      readings.push(formatNumber(day.missed) + " units short");
    }
    caption.textContent = readings.join(" · ");
  }

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const left = 36;
    const right = width - 10;
    const top = 23;
    const bottom = height - 26;
    if (!days.length) {
      plot = null;
      ctx.strokeStyle = "#d6dedb";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(left, top, right - left, bottom - top);
      return;
    }

    const peak = Math.max(1, plan.stock.onHand, ...days.map((day, index) => {
      const yesterday = index ? days[index - 1].withOrder : plan.stock.onHand;
      return yesterday + day.receipt;
    }));
    const step = (right - left) / days.length;
    const x = index => left + index * step;
    const y = units => bottom - (units / (peak * 1.08)) * (bottom - top);
    plot = { left, step };
    const hasDraft = plan.orderUnits > 0;

    days.forEach((day, index) => {
      if (index < plan.effectiveLeadDays && day.missed > 1e-9) {
        ctx.fillStyle = "#f9dfcb";
        ctx.fillRect(x(index), top, step, bottom - top);
      }
    });
    if (selectedDay !== null) {
      ctx.fillStyle = "#dbeae680";
      ctx.fillRect(x(selectedDay), top, step, bottom - top);
    }
    ctx.textAlign = "right";
    for (const tick of [0, peak / 2, peak]) {
      ctx.strokeStyle = "#d8e1de";
      ctx.beginPath();
      ctx.moveTo(left, y(tick));
      ctx.lineTo(right, y(tick));
      ctx.stroke();
      ctx.fillStyle = "#526167";
      const label = tick < 1000 ? String(Math.round(tick)) : (tick / 1000).toPrecision(2) + "k";
      ctx.fillText(label, left - 7, y(tick));
    }

    function balanceLine(key, color, showReceipt) {
      ctx.beginPath();
      ctx.moveTo(left, y(plan.stock.onHand));
      let opening = plan.stock.onHand;
      days.forEach((day, index) => {
        if (showReceipt && day.receipt) ctx.lineTo(x(index), y(opening + day.receipt));
        ctx.lineTo(x(index + 1), y(day[key]));
        opening = day[key];
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = showReceipt ? 2.5 : 1.8;
      ctx.setLineDash(showReceipt ? [] : [5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (plan.arrivalDate && plan.effectiveLeadDays < days.length) {
      const arrivalX = x(plan.effectiveLeadDays);
      ctx.strokeStyle = "#2d746a";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(arrivalX, top);
      ctx.lineTo(arrivalX, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#1d6359";
      ctx.textAlign = arrivalX > width - 85 ? "right" : "left";
      ctx.fillText("Delivery", arrivalX + (ctx.textAlign === "right" ? -4 : 4), 11);
    }
    balanceLine("withoutOrder", "#647782", false);
    if (hasDraft) balanceLine("withOrder", "#157165", true);

    ctx.fillStyle = "#526167";
    ctx.textAlign = "left";
    ctx.fillText(formatShortDate(days[0].date), left, bottom + 14);
    ctx.textAlign = "right";
    ctx.fillText(formatShortDate(days.at(-1).date), right, bottom + 14);
  }

  function select(index) {
    selectedDay = index === null ? null : Math.max(0, Math.min(index, days.length - 1));
    describe();
    draw();
  }

  function selectPointer(event) {
    if (!plot) return;
    const localX = event.clientX - canvas.getBoundingClientRect().left;
    const index = Math.max(0, Math.min(days.length - 1, Math.floor((localX - plot.left) / plot.step)));
    if (selectedDay !== index) select(index);
  }

  canvas.addEventListener("pointermove", selectPointer);
  canvas.addEventListener("pointerdown", selectPointer);
  canvas.addEventListener("keydown", event => {
    if (!days.length || !["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      select(null);
    } else {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      select(selectedDay === null ? 0 : selectedDay + direction);
    }
  });
  new ResizeObserver(draw).observe(canvas);

  return {
    show(row, forecast, dates) {
      plan = row;
      days = projectStock(row, forecast, dates);
      legend.hidden = !days.length;
      legend.children[0].hidden = !(row?.orderUnits > 0);
      canvas.tabIndex = days.length ? 0 : -1;
      select(null);
    },
  };
}
