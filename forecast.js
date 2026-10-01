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

function shiftISODate(iso, days) {
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
