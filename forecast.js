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

// ─── Lot history (reagent detail page) ──────────────────────────────────────
// Everything below only READS lots and logs. Validity rules match the
// forecast: undone logs (deleted) and orphan logs (lot row gone) never count.
// There is no time window here — this is the full history.

export const STOCK_COUNT_CORRECTION_USER = "Unlogged (physical count)";

export function isStockCountCorrection(log) {
  return log.used_by === STOCK_COUNT_CORRECTION_USER;
}

// Why an ended (deleted) lot ended, from the fields already stored on it.
function lotEndReason(lot) {
  if (lot.discard_reason) return { kind: "discarded", detail: lot.discard_reason };
  if (/^(Auto|Maintenance)/.test(lot.deleted_by || "")) return { kind: "ran_out", detail: null };
  return { kind: "removed", detail: lot.deleted_by || null };
}

// Lifecycle status, in priority order:
//   ended  → discarded / ran_out / removed
//   active → empty (qty ≤ 0) → expired (expiry before today) → in_use (active
//            on device) → in_stock
// So an active lot with nothing left is "empty" even if it is also past expiry.
export function lotStatus(lot, todayISO) {
  if (lot.deleted) return lotEndReason(lot).kind;
  if (Number(lot.current_quantity) <= 0) return "empty";
  if (lot.expiry_date && lot.expiry_date < todayISO) return "expired";
  if (lot.active_on_device) return "in_use";
  return "in_stock";
}

const round2 = (n) => Math.round(n * 100) / 100;

// One entry per lot of the group (active and ended), newest received first
// (ties: active lot first). Dates are only ever stored values, or — for
// firstLoggedUse — the earliest date of the lot's normal usage logs; stock-
// count corrections are excluded there because their dates were chosen
// retroactively.
export function lotHistory(groupKey, reagents, logs, todayISO) {
  const all = reagents || [];
  const byId = {};
  for (const r of all) byId[r.id] = r;
  const lots = all.filter((r) => groupKeyOf(r) === groupKey);
  const lotIds = new Set(lots.map((l) => l.id));

  const validByLot = {};
  for (const l of logs || []) {
    if (l.deleted || !lotIds.has(l.reagent_id)) continue;
    (validByLot[l.reagent_id] ||= []).push(l);
  }
  const groupValidLogs = Object.values(validByLot).flat();

  const entries = lots.map((lot) => {
    const mine = validByLot[lot.id] || [];
    const normal = mine.filter((l) => !isStockCountCorrection(l));
    const corrections = mine.filter(isStockCountCorrection);
    const sum = (arr) => arr.reduce((s, l) => s + Number(l.amount || 0), 0);
    const normalAmount = sum(normal);
    const correctionAmount = sum(corrections);
    const logged = normalAmount + correctionAmount;

    const received = Number(lot.quantity_received || 0);
    const remaining = Number(lot.current_quantity || 0);
    // remaining − (received − logged usage). Non-zero means the stock moved by
    // an amount the usage logs don't account for; the cause isn't determined.
    const rawUnexplained = remaining - (received - logged);
    const unexplained = Math.abs(rawUnexplained) > 0.005 ? round2(rawUnexplained) : 0;

    const normalDates = normal.map((l) => l.date).filter(Boolean).sort();
    const firstLoggedUse = normalDates[0] || null;
    const firstLoggedUseNote = firstLoggedUse ? null : corrections.length ? "only_corrections" : "no_logs";

    const setActiveDates = mine.filter((l) => l.active_device_changed && l.date).map((l) => l.date).sort();
    const replaced = mine
      .filter((l) => l.previous_active_lot_id)
      .map((l) => ({ lotId: l.previous_active_lot_id, lotNumber: byId[l.previous_active_lot_id]?.lot_number ?? null, date: l.date }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const replacedBy = groupValidLogs
      .filter((l) => l.previous_active_lot_id === lot.id && l.reagent_id !== lot.id)
      .map((l) => ({ lotId: l.reagent_id, lotNumber: byId[l.reagent_id]?.lot_number ?? null, date: l.date }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      id: lot.id,
      lotNumber: lot.lot_number,
      active: !lot.deleted,
      status: lotStatus(lot, todayISO),
      ended: lot.deleted ? { at: lot.deleted_at || null, ...lotEndReason(lot) } : null,
      receivedDate: lot.date_added || null,
      receivedBy: lot.added_by || null,
      expiryDate: lot.expiry_date || null,
      received,
      remaining,
      usage: {
        total: round2(logged),
        normal: { amount: round2(normalAmount), count: normal.length },
        corrections: { amount: round2(correctionAmount), count: corrections.length },
      },
      unexplained,
      firstLoggedUse,
      firstLoggedUseNote,
      setActiveDates,
      replaced,
      replacedBy,
      edited: lot.edited_by ? { by: lot.edited_by, at: lot.edited_at || null } : null,
      _createdAt: lot.created_at || "",
    };
  });

  entries.sort((a, b) => {
    if (a.receivedDate !== b.receivedDate) return (b.receivedDate || "") < (a.receivedDate || "") ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b._createdAt < a._createdAt ? -1 : b._createdAt > a._createdAt ? 1 : 0;
  });
  return entries.map(({ _createdAt, ...e }) => e);
}

// Lot numbers are not unique in the data (two lots of one reagent can share a
// number). For each lot whose number repeats within the group, returns a short
// discriminator so the UI can tell them apart without showing internal ids:
// its status; plus its received date when duplicates share a status; plus an
// ordinal when they also share a received date. Unique numbers map to null.
// `entries` are lotHistory() entries (their order makes ordinals stable).
export function lotDiscriminators(entries) {
  const byNumber = {};
  for (const e of entries || []) (byNumber[e.lotNumber] ||= []).push(e);
  const out = {};
  for (const list of Object.values(byNumber)) {
    if (list.length === 1) { out[list[0].id] = null; continue; }
    for (const e of list) {
      const sameStatus = list.filter((x) => x.status === e.status);
      const d = { status: e.status, receivedDate: null, ordinal: null };
      if (sameStatus.length > 1) {
        d.receivedDate = e.receivedDate;
        const sameDate = sameStatus.filter((x) => x.receivedDate === e.receivedDate);
        if (sameDate.length > 1) d.ordinal = sameDate.indexOf(e) + 1;
      }
      out[e.id] = d;
    }
  }
  return out;
}

// The group's valid usage logs across ALL its lots (active and ended), each
// tagged with its lot. Newest first, using the same comparator the detail
// page's history list has always used. `lotActive` decides whether a row may
// show edit/delete — the same rows that had them before (logs on active lots).
export function groupLogsWithLots(groupKey, reagents, logs) {
  const lotById = {};
  for (const r of reagents || []) if (groupKeyOf(r) === groupKey) lotById[r.id] = r;
  const rows = [];
  for (const l of logs || []) {
    if (l.deleted) continue;
    const lot = lotById[l.reagent_id];
    if (!lot) continue;
    rows.push({ log: l, lot, lotActive: !lot.deleted, isCorrection: isStockCountCorrection(l) });
  }
  return rows.sort((a, b) => new Date(b.log.date) - new Date(a.log.date));
}
