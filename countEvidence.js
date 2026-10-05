// Evidence written by Stock Count (needs ADD_EVIDENCE_FOUNDATION.sql).
//
// Every value here is added to a write the count already makes — the log
// insert, the counted-quantity update, or the update that resolves the line —
// so recording evidence never adds a step that could fail on its own.
//
// date_provenance (per correction log row) says how that row's date was
// chosen; none of the count_* values is proof of when usage really happened:
//   count_exact          exact date picked, different from the default day
//   count_exact_default  exact date left on the default (the count's start day)
//   count_spread_window  unknown date, spread weekly across the lot's window
//   count_redated        replacement row written by Edit dates
//
// resolution_details (per count line) is a write-once snapshot of what was
// known and decided when the line was first resolved. It is never updated
// (Edit dates changes the current log rows only) and is not current truth.
// Shape v1 — every key always present:
//   { v: 1,
//     method: "usage_exact" | "usage_spread" | "corrected" | "kept",
//     discrepancy: { expected, counted, difference },   // difference = counted − expected
//     window: { from, to, source } | null,              // usage methods only
//     allocation: [{ date, amount }],                   // the rows chosen; [] when none
//     date_provenance: <value above> | null }           // usage methods only

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export const exactProvenance = (date, defaultDay) => (date === defaultDay ? "count_exact_default" : "count_exact");

export function resolutionDetails({ method, item, window = null, allocation = [], provenance = null }) {
  const expected = round2(item.expected_quantity);
  const counted = round2(item.counted_quantity);
  return {
    v: 1,
    method,
    discrepancy: { expected, counted, difference: round2(counted - expected) },
    window: window ? { from: window.from, to: window.to, source: window.fromSource } : null,
    allocation: allocation.map((a) => ({ date: a.date, amount: Number(a.amount) })),
    date_provenance: provenance,
  };
}

// The update for the line's resolution, all in one statement.
export const resolutionUpdate = (note, username, details, at = new Date().toISOString()) => ({
  resolved: true,
  resolution_note: note,
  resolved_at: at,
  resolved_by: username,
  resolution_details: details,
});

// counted_at / counted_by describe the latest saved physical observation:
// set when the quantity changes, cleared with it, untouched when re-saved as is.
const sameQty = (a, b) => (a == null || b == null ? a == null && b == null : Number(a) === Number(b));
export function countedFields(previous, next, username, at = new Date().toISOString()) {
  if (sameQty(previous, next)) return {};
  if (next == null) return { counted_at: null, counted_by: null };
  return { counted_at: at, counted_by: username };
}
