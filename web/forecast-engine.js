"use strict";

// Browser implementation of the daily models and time-ordered validation in forecast.py.
const analyzeRetailCsv = (() => {
  const dayMs = 86_400_000;
  const models = ["seasonal-naive", "recent-mean", "weekday-mean", "pooled-weekday"];
  const baseline = models[0];
  const selectionFolds = 3;
  const trainingDays = 28;
  const chartDays = 42;
  const numberPattern = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u;
  const dayValue = value => Date.parse(value + "T00:00:00Z") / dayMs;
  const dayLabel = day => new Date(day * dayMs).toISOString().slice(0, 10);
  const weekday = day => ((day + 3) % 7 + 7) % 7;
  const lastDay = dayValue("9999-12-31");

  function readHistory(csv) {
    const rows = retailCsv.rows(csv);
    const header = rows.next().value?.fields ?? [];
    const idColumn = header.indexOf("series_id");
    const dateColumn = header.indexOf("date");
    const unitsColumn = header.indexOf("units");
    if ([idColumn, dateColumn, unitsColumn].includes(-1)) {
      throw new Error("History must have series_id, date, and units columns.");
    }
    if (new Set(header).size !== header.length) throw new Error("History contains duplicate column names.");

    const observations = new Map();
    for (const { fields, line } of rows) {
      if (fields.length > header.length) throw new Error(`CSV line ${line}: too many fields.`);
      const id = (fields[idColumn] ?? "").trim();
      if (!id) throw new Error(`CSV line ${line}: series_id is blank.`);
      const date = fields[dateColumn];
      const day = dayValue(date);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date.startsWith("0000") ||
          !Number.isFinite(day) || dayLabel(day) !== date) {
        throw new Error(`CSV line ${line}: use a valid date in YYYY-MM-DD format.`);
      }
      const rawUnits = (fields[unitsColumn] ?? "").trim();
      const units = Number(rawUnits);
      if (!numberPattern.test(rawUnits) || !Number.isFinite(units) || units < 0) {
        throw new Error(`CSV line ${line}: units must be finite and nonnegative.`);
      }
      if (!observations.has(id)) observations.set(id, new Map());
      const item = observations.get(id);
      if (item.has(day)) throw new Error(`CSV line ${line}: duplicate observation for ${JSON.stringify(id)} on ${date}.`);
      item.set(day, units);
    }
    if (!observations.size) throw new Error("History has no data rows.");

    const history = new Map();
    let cutoff;
    for (const id of [...observations.keys()].sort()) {
      const records = [...observations.get(id)].sort((first, second) => first[0] - second[0]);
      for (let index = 1; index < records.length; index++) {
        const expected = records[index - 1][0] + 1;
        if (records[index][0] !== expected) {
          throw new Error(`${JSON.stringify(id)} is missing ${dayLabel(expected)}. Add a row for each day.`);
        }
      }
      const end = records.at(-1)[0];
      if (cutoff !== undefined && end !== cutoff) throw new Error("All series must end on the same date.");
      cutoff = end;
      history.set(id, records.map(record => record[1]));
    }
    return { history, cutoff };
  }

  function finite(value) {
    if (!Number.isFinite(value)) throw new Error("Sales values are too large or too small to score reliably.");
    return value;
  }

  function sum(values) {
    let total = 0;
    let remainder = 0;
    for (const value of values) {
      const next = total + value;
      remainder += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
      total = next;
    }
    return finite(total + remainder);
  }

  function pooledWeekdays(history, nextDay) {
    const totals = Array(7).fill(0);
    for (const units of history.values()) {
      const weeks = Math.min(8, Math.floor(units.length / 7));
      if (weeks) {
        units.slice(-7 * weeks).forEach((value, index) => {
          totals[(nextDay + index) % 7] += value;
        });
      }
    }
    const level = sum(totals) / 7;
    return level ? totals.map(total => total / level) : Array(7).fill(1);
  }

  function project(history, cutoff, horizon, model) {
    const nextDay = weekday(cutoff + 1);
    const pooled = model === "pooled-weekday" ? pooledWeekdays(history, nextDay) : null;
    const forecasts = new Map();
    for (const [id, units] of history) {
      let pattern;
      if (model === baseline && units.length >= 7) {
        pattern = units.slice(-7);
      } else if (model === "weekday-mean") {
        const recent = units.slice(-56);
        const level = sum(recent) / recent.length;
        const buckets = Array.from({ length: 7 }, () => []);
        recent.forEach((value, index) => buckets[index % 7].push(value));
        const means = buckets.map(bucket => (sum(bucket) + 2 * level) / (bucket.length + 2));
        pattern = means.map((_, index) => means[(recent.length + index) % 7]);
      } else if (pooled) {
        const weeks = Math.min(4, Math.floor(units.length / 7));
        const recent = weeks ? units.slice(-7 * weeks) : units;
        const level = sum(recent) / recent.length;
        pattern = pooled.map((_, index) => level * pooled[(nextDay + index) % 7]);
      } else {
        const recent = units.slice(model === baseline ? -7 : -28);
        pattern = Array(7).fill(sum(recent) / recent.length);
      }
      forecasts.set(id, Array.from({ length: horizon }, (_, index) => finite(pattern[index % 7])));
    }
    return forecasts;
  }

  function makeFold(history, cutoff, horizon, windowsFromEnd) {
    const removed = horizon * (windowsFromEnd + 1);
    const training = new Map();
    const observed = new Map();
    for (const [id, units] of history) {
      const boundary = units.length - removed;
      if (boundary >= trainingDays) {
        training.set(id, units.slice(0, boundary));
        observed.set(id, units.slice(boundary, boundary + horizon));
      }
    }
    return { training, observed, cutoff: cutoff - removed, horizon };
  }

  const emptyTotals = () => ({ error: 0, actual: 0, predicted: 0, count: 0 });

  function addTotals(target, source) {
    target.error += source.error;
    target.actual += source.actual;
    target.predicted += source.predicted;
    target.count += source.count;
  }

  function metrics(totals) {
    finite(totals.actual);
    finite(totals.predicted);
    return {
      mae: finite(totals.error / totals.count),
      wape: totals.actual ? finite(totals.error / totals.actual) : null,
      observations: totals.count,
      unit_bias: totals.actual ? finite((totals.predicted - totals.actual) / totals.actual) : null,
    };
  }

  function score(fold, model) {
    const forecast = project(fold.training, fold.cutoff, fold.horizon, model);
    const totals = emptyTotals();
    const bySeries = new Map();
    for (const [id, actual] of fold.observed) {
      const predicted = forecast.get(id);
      const errors = {
        error: sum(actual.map((value, index) => Math.abs(value - predicted[index]))),
        actual: sum(actual),
        predicted: sum(predicted),
        count: actual.length,
      };
      addTotals(totals, errors);
      bySeries.set(id, errors);
    }
    return { totals, bySeries, forecast };
  }

  function holdoutSummary(fold, selected, totalSeries) {
    const active = score(fold, selected);
    const reference = selected === baseline ? active : score(fold, baseline);
    const segments = new Map();
    const groups = new Map();
    for (const [id, units] of fold.training) {
      const recent = units.slice(-56);
      const positiveDays = recent.filter(value => value > 0).length;
      const group = 2 * positiveDays < recent.length ? "sparse" : "regular";
      groups.set(id, group);
      if (!segments.has(group)) segments.set(group, { count: 0, selected: emptyTotals(), baseline: emptyTotals() });
      const totals = segments.get(group);
      totals.count++;
      addTotals(totals.selected, active.bySeries.get(id));
      addTotals(totals.baseline, reference.bySeries.get(id));
    }
    const slices = Object.fromEntries([...segments.keys()].sort().map(group => {
      const totals = segments.get(group);
      return [group, {
        series_count: totals.count,
        selected: metrics(totals.selected),
        baseline: metrics(totals.baseline),
      }];
    }));
    return {
      cutoff: dayLabel(fold.cutoff),
      forecast_start: dayLabel(fold.cutoff + 1),
      forecast_end: dayLabel(fold.cutoff + fold.horizon),
      series_count: fold.training.size,
      total_series: totalSeries,
      slices,
      selected_by_series: Object.fromEntries([...active.bySeries].map(([id, errors]) => [id, {
        actual_units: errors.actual, forecast_units: errors.predicted,
      }])),
      replay: [...fold.training].map(([id, units]) => {
        const recent = units.slice(-28);
        return {
          id, group: groups.get(id),
          training_daily_mean: sum(recent) / recent.length,
          actual: fold.observed.get(id), selected: active.forecast.get(id), baseline: reference.forecast.get(id),
        };
      }),
      selected: metrics(active.totals),
      baseline: metrics(reference.totals),
    };
  }

  function evaluate(history, cutoff, horizon) {
    const report = {
      horizon,
      selected_model: baseline,
      baseline_model: baseline,
      selection_folds: [],
      selection_scores: {},
      holdout: null,
    };
    const required = trainingDays + (selectionFolds + 1) * horizon;
    if (![...history.values()].some(units => units.length >= required)) {
      report.required_history_days = required;
      return report;
    }
    const totals = Object.fromEntries(models.map(model => [model, emptyTotals()]));
    for (let window = selectionFolds; window > 0; window--) {
      const fold = makeFold(history, cutoff, horizon, window);
      const scores = {};
      for (const model of models) {
        const errors = score(fold, model).totals;
        addTotals(totals[model], errors);
        scores[model] = metrics(errors);
      }
      report.selection_folds.push({ cutoff: dayLabel(fold.cutoff), series_count: fold.training.size, scores });
    }
    for (const model of models) {
      if (totals[model].error < totals[report.selected_model].error) report.selected_model = model;
      report.selection_scores[model] = metrics(totals[model]);
    }
    report.holdout = holdoutSummary(makeFold(history, cutoff, horizon, 0), report.selected_model, history.size);
    return report;
  }

  return (csv, horizon) => {
    if (![7, 14, 28].includes(horizon)) throw new Error("Choose a 7, 14, or 28 day forecast horizon.");
    const { history, cutoff } = readHistory(csv);
    if (cutoff + horizon > lastDay) throw new Error("The forecast extends past 9999-12-31. Use an earlier end date.");
    const report = evaluate(history, cutoff, horizon);
    const forecasts = project(history, cutoff, horizon, report.selected_model);
    return {
      report,
      cutoff: dayLabel(cutoff),
      forecast_dates: Array.from({ length: horizon }, (_, index) => dayLabel(cutoff + index + 1)),
      series: [...forecasts].map(([id, forecast]) => ({ id, history: history.get(id).slice(-chartDays), forecast })),
    };
  };
})();
