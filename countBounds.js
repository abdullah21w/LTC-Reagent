// Date window for Stock Count usage corrections ("Unlogged (physical count)").
//
// A shortage found by a physical count happened somewhere between that exact
// lot's previous physical baseline and this count, so a correction may only be
// dated inside that window:
//   from = the later of
//            - the lot's received date (date_added), and
//            - the calendar day the lot's latest EARLIER completed count was
//              completed (an earlier session = completed before this one began)
//   to   = the calendar day this count STARTED (started_at) — the moment its
//          expected quantities were snapshotted. Fixed for the life of the
//          count: it does not move forward while a count stays open, and a
//          completed count keeps the same window for later date edits.
// Both ends are inclusive. Lookups are per exact lot (reagent_id), never by
// reagent name, device or group, so a replacement lot starts from its own
// received date.
//
// Calendar days are the browser's local days (the lab's clock), produced
// without toISOString() so a timestamp never shifts a day. "YYYY-MM-DD"
// strings compare correctly as plain text.

export function localDay(value) {
  const d = value instanceof Date ? value : new Date(value ?? NaN);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// lines: inventory_count_items rows ({ reagent_id, count_id }) with their
// count joined as `inventory_counts` ({ status, started_at, completed_at }).
// Returns { [reagent_id]: completed_at of that lot's latest completed count
// that finished before `session` started }. `session` itself, unfinished
// counts and later counts are ignored.
export function previousCompletedCounts(lines, session) {
  const cutoff = Date.parse(session?.started_at);
  const out = {};
  for (const l of lines || []) {
    const c = Array.isArray(l.inventory_counts) ? l.inventory_counts[0] : l.inventory_counts;
    if (!l.reagent_id || !c || l.count_id === session?.id || c.status !== "completed" || !c.completed_at) continue;
    const t = Date.parse(c.completed_at);
    if (!(t < cutoff)) continue;
    if (!out[l.reagent_id] || t > Date.parse(out[l.reagent_id])) out[l.reagent_id] = c.completed_at;
  }
  return out;
}

// { ok: true, from, to, fromSource: "previous_count" | "received" } or
// { ok: false, reason: "no_lot" | "unknown" | "empty", from?, to? }.
export function usageInterval({ lot, previousCompletedAt, session }) {
  if (!lot) return { ok: false, reason: "no_lot" };
  const received = /^\d{4}-\d{2}-\d{2}/.test(String(lot.date_added || "")) ? String(lot.date_added).slice(0, 10) : localDay(lot.created_at);
  const prev = previousCompletedAt ? localDay(previousCompletedAt) : null;
  const from = prev && (!received || prev > received) ? prev : received;
  const to = localDay(session?.started_at);
  if (!from || !to) return { ok: false, reason: "unknown" };
  if (from > to) return { ok: false, reason: "empty", from, to };
  return { ok: true, from, to, fromSource: prev && from === prev ? "previous_count" : "received" };
}

export const dateInInterval = (date, iv) =>
  !!(iv && iv.ok && /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) && date >= iv.from && date <= iv.to);

export const entriesInInterval = (entries, iv) =>
  Array.isArray(entries) && entries.length > 0 && entries.every((e) => dateInInterval(e.date, iv));
