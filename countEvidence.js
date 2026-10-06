// Evidence written by Stock Count (needs ADD_EVIDENCE_FOUNDATION.sql).
//
// counted_at / counted_by are written here, with the counted quantity itself
// (saveCount). Everything recorded when a discrepancy is resolved — each
// correction row's source_count_item_id and date_provenance, the line's
// resolved_at / resolved_by and its write-once resolution_details snapshot —
// is built by the database in the same transaction as the resolution
// (ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql), from what it actually writes.
//
// date_provenance outside Stock Count (App.jsx): 'manual' for Log use,
// 'manual_spread' for the rows the log editor spreads over a range.
// date_provenance values Stock Count produces (none is proof of when usage
// really happened):
//   count_exact          exact date picked, different from the default day
//   count_exact_default  exact date left on the default (the count's start day)
//   count_spread_window  unknown date, spread weekly across the lot's window
//   count_redated        replacement row written by Edit dates

import { STOCK_COUNT_CORRECTION_USER } from "./forecast";

// A consumption log created by Stock Count reconciliation: linked to its count
// line, or — rows written before links existed — recorded under the reserved
// Stock Count user. Such rows change only through Stock Count (its atomic
// functions, e.g. Edit dates); generic edit / undo / purge refuse them.
export const isCountDerivedLog = (log) =>
  !!log && (log.source_count_item_id != null || log.used_by === STOCK_COUNT_CORRECTION_USER);

// The Stock Count user name is reserved: a normal log can't be recorded or
// renamed under it.
export const isReservedUsedBy = (usedBy) =>
  String(usedBy ?? "").trim().toLowerCase() === STOCK_COUNT_CORRECTION_USER.toLowerCase();

export const COUNT_LOG_LOCKED_MSG =
  "This is a stock-count correction. It can only be changed from Stock count (open the count and use Edit dates).";

// counted_at / counted_by describe the latest saved physical observation:
// set when the quantity changes, cleared with it, untouched when re-saved as is.
const sameQty = (a, b) => (a == null || b == null ? a == null && b == null : Number(a) === Number(b));
export function countedFields(previous, next, username, at = new Date().toISOString()) {
  if (sameQty(previous, next)) return {};
  if (next == null) return { counted_at: null, counted_by: null };
  return { counted_at: at, counted_by: username };
}
