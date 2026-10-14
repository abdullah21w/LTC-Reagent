// Log Use save path (atomic Log Use): the only place a use of a Lot is recorded.
//
// One call to the database function log_use (ADD_ATOMIC_LOG_USE.sql) records the
// usage log and deducts the stock in ONE transaction, from the locked Lot row —
// never from the quantity this browser loaded — so two devices can't overwrite each
// other's deduction and a failure never leaves a log without its deduction (or the
// reverse). The function also applies the rules that follow from the use
// (auto-remove of a depleted Lot, device activation, Lot-to-Lot), as before.
//
// Retry safety: the log id is generated once per Log use window (newLogId) and
// reused for every attempt in that window; it becomes the log's primary key, so
// one submission can never be recorded twice. A read-back by that id is used only
// to RECOGNISE a success whose response was lost; finding nothing proves nothing
// (the request may still arrive), so it is never reported as "not saved". Nothing
// is retried automatically, and never with a new id.
//
// Outcomes ({ ok, outcome, logId, message?, autoRemoved?, lotToLotFlagged?, available? }):
//   saved          recorded by this request
//   already_saved  this submission was recorded by an earlier attempt (same id, same values)
//   recovered      this request's response was lost, but the log was found by its id
//                  with the same values
//   mismatch       a log with this id exists with other values — NOT a success
//   insufficient   more than the Lot holds now (available) — nothing recorded
//   lot_not_found / lot_removed / lot_changed / reserved_user / invalid_input
//                  refused by the database — nothing recorded
//   rejected       the database refused the call (e.g. permission, function missing)
//   not_confirmed  the request failed and the log was not found (yet) — it may still
//                  arrive; "Save log" again in the same window is safe
//   unknown        the request failed and the check failed too — same advice

import { normalizeUnit, unitLabel } from "./units";
import { releaseRefusalMessage } from "./releaseGuard";

export function newLogId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const USE_MAX = 1000000000;

/**
 * The typed amount, checked from its text (so nothing is ever rounded away):
 * more than 0; whole for countable units, at most 2 decimals for measured ones;
 * no exponent, Infinity or NaN; at most 1,000,000,000; and not more than the
 * Lot's quantity as last loaded (the database checks the current one again).
 * → { ok: true, value } | { ok: false, error }
 */
export function checkUseAmount(raw, lot) {
  const t = String(raw ?? "").trim();
  const units = unitLabel(lot?.unit, 2);
  if (!t) return { ok: false, error: `Enter the amount used in ${units}.` };
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) {
    return { ok: false, error: /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(t) ? "Amount used must be written as a plain number (for example 2 or 2.5)." : "Amount used must be a number." };
  }
  const decimals = (m[3] || "").replace(/0+$/, "").length;
  const value = Number(t);
  if (m[1] === "-" && value !== 0) return { ok: false, error: "Amount used can't be negative." };
  if (!(value > 0)) return { ok: false, error: "Amount used must be more than 0." };
  if (decimals > 0 && normalizeUnit(lot?.unit).countable) return { ok: false, error: `Amount used must be a whole number of ${units}.` };
  if (decimals > 2) return { ok: false, error: "Amount used can have at most 2 decimals." };
  if (value > USE_MAX) return { ok: false, error: "Amount used can be at most 1,000,000,000." };
  const left = Number(lot?.current_quantity);
  if (Number.isFinite(left) && value > left) return { ok: false, error: `Only ${fmt(left)} ${unitLabel(lot?.unit, left)} left in this Lot. Enter at most that — or, if more is really there, correct the Lot's quantity first (Edit Lot or Stock Count).` };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

const fmt = (v) => String(Math.round(Number(v) * 100) / 100);

/** The log_use arguments for one submission (entry from the Log use window). */
export function logUseArgs(entry, actor) {
  return {
    p_log_id: entry.logId,
    p_reagent_id: entry.reagentId,
    p_amount: entry.amount,
    p_date: entry.date,
    p_used_by: entry.usedBy,
    p_note: entry.note ?? "",
    p_tested_by_qc: !!entry.testedByQC,
    p_replace_on_device: entry.replaceOnDevice !== false,
    p_lot_to_lot: !!entry.lotToLot,
    p_confirm_ltl_id: entry.confirmLotToLotId || null,
    p_actor: actor,
  };
}

const isNetworkError = (e) => e?.name === "TypeError" || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|ECONNRE|aborted/i.test(String(e?.message || ""));

const SAME_WINDOW = "Keep this window open and press \"Save log\" again — in this same window it is safe: this use can only ever be recorded once. Don't log it again in a new window.";
export const UNKNOWN_MESSAGE = `The connection failed before the database answered, so it isn't known yet whether this use was recorded. Your entries are kept. ${SAME_WINDOW}`;
export const NOT_CONFIRMED_MESSAGE = `The save could not be confirmed: the connection failed and the use was not found in the history yet (it may still arrive). Your entries are kept. ${SAME_WINDOW}`;
export const MISMATCH_MESSAGE = "An earlier attempt from this window was already recorded, with the values entered at that time. Nothing new was recorded. Close this window and check the history (edit that entry there if needed).";

// Statuses the database decided before writing anything → messages (all say nothing was recorded).
function refusal(r, entry) {
  switch (r.status) {
    case "insufficient": return `Only ${fmt(r.available)} ${unitLabel(entry.unit, Number(r.available))} left in this Lot now (another use may have just been recorded). Nothing was recorded. Enter at most that — or, if more is really there, correct the Lot's quantity first (Edit Lot or Stock Count).`;
    case "lot_not_found": return "This Lot no longer exists. Nothing was recorded. Close this window and choose another Lot.";
    case "lot_removed": return "This Lot has been removed. Nothing was recorded. Close this window and choose another Lot.";
    case "lot_changed": return "This Lot was changed while saving. Nothing was recorded — press \"Save log\" again.";
    case "reserved_user": return "That name is reserved for stock-count corrections. Nothing was recorded.";
    case "invalid_input": return `The database refused the entry (${r.reason === "amount_not_whole" ? "this unit needs a whole number" : r.reason || "invalid value"}). Nothing was recorded — correct it and try again.`;
    default: return `The database refused the entry (${r.status}). Nothing was recorded.`;
  }
}

export function describeLogUseError(e) {
  // Maintenance / outdated build (ADD_RELEASE_CONTROL.sql): say so plainly.
  const rel = releaseRefusalMessage(e);
  if (rel) return rel;
  const msg = String(e?.message || "");
  if (e?.code === "PGRST202" || /could not find the function|function .*log_use.* does not exist/i.test(msg)) return "Log use can't be saved yet: the database update for it hasn't been applied. Nothing was recorded. Please tell the owner.";
  if (e?.code === "42501" || /row-level security|permission denied/i.test(msg)) return "You don't have permission to log use, so nothing was recorded. Ask the owner to check your account.";
  return `The database refused the entry${msg ? ` (${msg})` : ""}. Nothing was recorded.`;
}

// Is a log read back by id this same submission?
export const sameUse = (entry, row) => !!row && row.reagent_id === entry.reagentId && Number(row.amount) === Number(entry.amount)
  && String(row.date) === String(entry.date) && row.used_by === entry.usedBy && (row.note ?? "") === (entry.note ?? "")
  && !!row.tested_by_qc === !!entry.testedByQC && row.date_provenance === "manual" && row.source_count_item_id == null;

// client: the app's Supabase client. entry: the Log use window's submission (with logId).
export async function saveLogUse({ client, entry, actor }) {
  const logId = entry?.logId;
  if (!logId) return { ok: false, outcome: "rejected", logId: null, message: "This use has no reference id, so it was not sent. Close the window and start again." };
  const readBack = async () => {
    try {
      const r = await client.from("consumption_logs").select("id, reagent_id, amount, date, used_by, note, tested_by_qc, date_provenance, source_count_item_id, deleted").eq("id", logId);
      if (r?.error) return { known: false };
      return { known: true, row: (r?.data || [])[0] || null };
    } catch { return { known: false }; }
  };
  const lookUp = async () => {
    const rb = await readBack();
    if (!rb.known) return { ok: false, outcome: "unknown", logId, message: UNKNOWN_MESSAGE };
    if (!rb.row) return { ok: false, outcome: "not_confirmed", logId, message: NOT_CONFIRMED_MESSAGE };
    return sameUse(entry, rb.row) ? { ok: true, outcome: "recovered", logId } : { ok: false, outcome: "mismatch", logId, message: MISMATCH_MESSAGE };
  };

  let res;
  try { res = await client.rpc("log_use", logUseArgs(entry, actor)); }
  catch (e) {
    if (!isNetworkError(e)) return { ok: false, outcome: "rejected", logId, message: describeLogUseError(e) };
    return lookUp();
  }
  if (res?.error) return isNetworkError(res.error) ? lookUp() : { ok: false, outcome: "rejected", logId, message: describeLogUseError(res.error) };
  const r = res?.data;
  if (!r || typeof r !== "object" || !r.status) return lookUp(); // no usable answer: never assumed either way
  if (r.status === "ok") return { ok: true, outcome: "saved", logId, autoRemoved: !!r.auto_removed, lotToLotFlagged: !!r.lot_to_lot_flagged };
  if (r.status === "already_saved") return { ok: true, outcome: "already_saved", logId, logDeleted: !!r.log_deleted };
  if (r.status === "mismatch") return { ok: false, outcome: "mismatch", logId, message: MISMATCH_MESSAGE };
  return { ok: false, outcome: r.status, logId, available: r.available, message: refusal(r, entry) };
}
