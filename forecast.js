// Recent consumption per reagent group (name + device), used for the
// run-out forecast (dailyRate / predictedDaysLeft) in App.jsx's `groups`.
//
// Usage is counted from the consumption log itself, not from whether its lot
// still exists: a lot that has since run out (auto-removed), been discarded,
// or been removed by hand was still physically used, so its logs inside the
// window must keep counting. Leaving them out made the rate collapse right at
// a lot changeover — exactly when the reagent is being used.
//
// A log counts when:
//   - it isn't undone (deleted !== true)
//   - its date is within the window: today and the 29 days before it
//     (30 calendar days); future-dated logs don't count
//   - its lot row still exists (deleted or not) — logs whose lot was purged
//     outright can't be placed in a group and are skipped
//
// Dates are compared as plain "YYYY-MM-DD" strings, the same format the
// consumption_logs.date column and the app's todayISO() use.

export const FORECAST_WINDOW_DAYS = 30;

export function groupKeyOf(lot) {
  return `${lot.name}::${lot.device || ""}`;
}

export function shiftISODate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function forecastWindowStart(todayISO) {
  return shiftISODate(todayISO, -(FORECAST_WINDOW_DAYS - 1));
}

// Returns { [groupKey]: total amount used in the window }.
// `reagents` must be ALL lot rows (including deleted ones).
export function recentUsageByGroup(reagents, logs, todayISO) {
  const windowStart = forecastWindowStart(todayISO);
  const keyByLotId = {};
  for (const r of reagents || []) keyByLotId[r.id] = groupKeyOf(r);

  const usage = {};
  for (const l of logs || []) {
    if (l.deleted) continue;
    if (!l.date || l.date < windowStart || l.date > todayISO) continue;
    const key = keyByLotId[l.reagent_id];
    if (!key) continue;
    usage[key] = (usage[key] || 0) + Number(l.amount || 0);
  }
  return usage;
}

// The date the current stock is projected to run out: today + the group's
// predictedDaysLeft (calendar days). null when there's no forecast (no usage
// in the window).
export function runOutDate(todayISO, predictedDaysLeft) {
  if (predictedDaysLeft === null || predictedDaysLeft === undefined) return null;
  return shiftISODate(todayISO, predictedDaysLeft);
}

// The same window usage as recentUsageByGroup, for ONE group, split by where
// it came from — used to explain the forecast. Uses identical inclusion rules,
// so `total` always equals recentUsageByGroup(...)[groupKey] (|| 0).
//   inStock      — logs on lots that are still active
//   ended        — logs on lots that have since run out / been discarded / removed
//   stockCount   — logs created by a stock-count correction (any lot); this is
//                  an overlapping share of the total, not a third bucket
export function usageBreakdown(groupKey, reagents, logs, todayISO) {
  const windowStart = forecastWindowStart(todayISO);
  const lotById = {};
  for (const r of reagents || []) if (groupKeyOf(r) === groupKey) lotById[r.id] = r;

  const out = {
    windowStart, windowEnd: todayISO,
    total: 0, logCount: 0,
    inStock: { amount: 0, count: 0 },
    ended: { amount: 0, count: 0 },
    stockCount: { amount: 0, count: 0 },
  };
  for (const l of logs || []) {
    if (l.deleted) continue;
    if (!l.date || l.date < windowStart || l.date > todayISO) continue;
    const lot = lotById[l.reagent_id];
    if (!lot) continue;
    const amt = Number(l.amount || 0);
    out.total += amt;
    out.logCount += 1;
    const bucket = lot.deleted ? out.ended : out.inStock;
    bucket.amount += amt;
    bucket.count += 1;
    if (l.used_by === "Unlogged (physical count)") {
      out.stockCount.amount += amt;
      out.stockCount.count += 1;
    }
  }
  return out;
}

// Reorder suggestion — the Reorder page's formula, shared so the reagent
// detail page shows the same number:
//   target    = ceil(dailyRate × coverageDays)
//   suggested = target − totalQty
// A suggestion is only made when there is usage (dailyRate > 0) and the
// target isn't already covered (suggested > 0).
export function reorderSuggestion(dailyRate, totalQty, coverageDays) {
  const target = Math.ceil((dailyRate || 0) * coverageDays);
  const suggestedQty = target - totalQty;
  return { target, suggestedQty, needed: dailyRate > 0 && suggestedQty > 0 };
}
