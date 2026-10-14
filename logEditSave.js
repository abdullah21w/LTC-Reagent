// Edit and undo of a manual consumption log (atomic edit/undo): the only places a
// log is changed or undone.
//
// Each is ONE call to a database function (ADD_ATOMIC_LOG_EDIT.sql): log_edit /
// log_undo change the log, the stock (computed from the locked Lot row — never
// from the quantity this browser loaded), the existing Lot / device restoration
// (undo) and the activity entry in one transaction.
//
// Every operation carries a request id, generated once per Edit window / undo
// click and reused for every retry of it. The function writes the activity entry
// with that id, in the same transaction, so a lost response is RECOGNISED by
// reading that entry back — the operation itself is identified, never inferred
// from the log's values. A read-back that finds nothing proves nothing (the
// request may still arrive), so it is never reported as "not saved". The values
// the window showed are sent too: a log changed meanwhile is refused ("stale"),
// so an edit or undo can never be applied twice or on top of someone else's.
//
// Outcomes ({ ok, outcome, message? }):
//   saved / already_saved / recovered     done (by this request)
//   already_undone (undo)                 it was undone earlier by someone else — final, nothing restored again
//   unchanged (edit)                      nothing to save
//   stale, covered, unclassifiable, count_derived, undone, insufficient,
//   mismatch, log_not_found, lot_changed, reserved_user, invalid_input, rejected
//                                         refused — nothing written
//   not_confirmed / unknown               not known yet; repeating the same action is safe

import { newLogId, checkUseAmount } from "./logUseSave";
import { unitLabel } from "./units";
import { releaseRefusalMessage } from "./releaseGuard";

export const newRequestId = newLogId;

const fmt = (v) => String(Math.round(Number(v) * 100) / 100);

/**
 * The edited amount, checked from its text like Log use (more than 0, unit
 * precision, no exponent / Infinity / NaN, at most 1,000,000,000; never rounded),
 * and an increase no larger than what the Lot holds (as last loaded — the
 * database checks the current quantity again). → { ok, value } | { ok: false, error }
 */
export function checkEditAmount(raw, lot, oldAmount) {
  const r = checkUseAmount(raw, { unit: lot?.unit, current_quantity: Infinity });
  if (!r.ok) return r;
  const left = Number(lot?.current_quantity), old = Number(oldAmount);
  if (Number.isFinite(left) && Number.isFinite(old) && r.value - old > left) {
    return { ok: false, error: `This Lot has only ${fmt(left)} ${unitLabel(lot?.unit, left)} left, so this entry can be at most ${fmt(old + left)}. To record more, correct the Lot's quantity first (Edit Lot or Stock Count).` };
  }
  return r;
}

const isNetworkError = (e) => e?.name === "TypeError" || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|ECONNRE|aborted/i.test(String(e?.message || ""));

// "Spread over a range" is temporarily unavailable: the previous version deleted
// the original entry; its history-preserving replacement is being developed.
export const SPREAD_UNAVAILABLE = "Spreading an entry over a date range is temporarily unavailable while a version that keeps the original entry in the history is being developed. Use \"Exact date\" for now.";

export const STALE_MESSAGE = "This entry was changed by someone else since you opened it, so nothing was saved. Close this window, reload the page and try again with the current values.";
export const STALE_UNDO_MESSAGE = "This entry was changed by someone else since the page loaded, so it was not undone. Reload the page and try again.";
export const COVERED_MESSAGE = (r) => `This entry belongs to a period already covered by a completed Stock Count of this Lot${r?.count_start_day ? ` (started ${r.count_start_day})` : ""}. Its amount and date can't be changed and it can't be undone, because the count already set this Lot's stock. You can still correct who used it, the note and the QC flag.`;
export const UNCLASSIFIABLE_MESSAGE = "This entry is missing the timestamps needed to tell whether a completed Stock Count already covers it, so its amount, date or undo can't be changed safely. Nothing was saved.";
export const COUNT_DERIVED_MESSAGE = "This is a stock-count correction. It can only be changed from Stock count (open the count and use Edit dates).";
const EDIT_UNKNOWN = "The connection failed before the database answered, so it isn't known yet whether this change was saved. Your entries are kept. Keep this window open and press \"Save\" again — it is safe: this change can only ever be applied once.";
const EDIT_NOT_CONFIRMED = "The save could not be confirmed: the connection failed and the change was not found yet (it may still arrive). Your entries are kept. Keep this window open and press \"Save\" again — it is safe: this change can only ever be applied once.";
const UNDO_UNKNOWN = "The connection failed before the database answered, so it isn't known yet whether this entry was undone. Press Undo again — it is safe: an entry can only be undone once.";
const UNDO_NOT_CONFIRMED = "The undo could not be confirmed: the connection failed and it was not found yet (it may still arrive). Press Undo again — it is safe: an entry can only be undone once.";

function refused(r, kind, unit) {
  switch (r.status) {
    case "stale": return kind === "undo" ? STALE_UNDO_MESSAGE : STALE_MESSAGE;
    case "covered": return COVERED_MESSAGE(r);
    case "unclassifiable": return UNCLASSIFIABLE_MESSAGE;
    case "count_derived": return COUNT_DERIVED_MESSAGE;
    case "undone": return "This entry has been undone, so it can't be edited. Nothing was saved.";
    case "insufficient": return `This Lot has only ${fmt(r.available)} ${unitLabel(unit, Number(r.available))} left now, so this entry can be at most ${fmt(r.max_amount)}. Nothing was saved. To record more, correct the Lot's quantity first (Edit Lot or Stock Count).`;
    case "mismatch": return "An earlier attempt from this window was already saved, with the values entered at that time. Nothing new was saved. Close this window and reload to see the entry.";
    case "log_not_found": return "This entry no longer exists. Nothing was saved. Reload the page.";
    case "lot_changed": return "This entry's Lot was changed while saving. Nothing was saved — try again.";
    case "reserved_user": return "That name is reserved for stock-count corrections. Enter who used it.";
    case "invalid_input": return `The database refused the entry (${r.reason === "amount_not_whole" ? "this unit needs a whole number" : r.reason || "invalid value"}). Nothing was saved — correct it and try again.`;
    default: return `The database refused the change (${r.status}). Nothing was saved.`;
  }
}

export function describeEditError(e, kind) {
  // Maintenance / outdated build (ADD_RELEASE_CONTROL.sql): say so plainly.
  const rel = releaseRefusalMessage(e);
  if (rel) return rel;
  const msg = String(e?.message || "");
  if (e?.code === "PGRST202" || /could not find the function|function .*log_(edit|undo).* does not exist/i.test(msg)) return `${kind === "undo" ? "Undo" : "Editing"} isn't available yet: the database update for it hasn't been applied. Nothing was saved. Please tell the owner.`;
  if (e?.code === "42501" || /row-level security|permission denied/i.test(msg)) return "You don't have permission to do this, so nothing was saved. Ask the owner to check your account.";
  return `The database refused the change${msg ? ` (${msg})` : ""}. Nothing was saved.`;
}

// Was this request done? Its activity entry carries the request id.
async function readBack(client, requestId) {
  try {
    const r = await client.from("audit_log").select("id").eq("id", requestId);
    if (r?.error) return { known: false };
    return { known: true, found: (r?.data || []).length > 0 };
  } catch { return { known: false }; }
}

async function call(client, fn, args, kind, unit) {
  const lookUp = async () => {
    const rb = await readBack(client, args.p_request_id);
    if (!rb.known) return { ok: false, outcome: "unknown", message: kind === "undo" ? UNDO_UNKNOWN : EDIT_UNKNOWN };
    if (!rb.found) return { ok: false, outcome: "not_confirmed", message: kind === "undo" ? UNDO_NOT_CONFIRMED : EDIT_NOT_CONFIRMED };
    return { ok: true, outcome: "recovered" };
  };
  let res;
  try { res = await client.rpc(fn, args); }
  catch (e) { return isNetworkError(e) ? lookUp() : { ok: false, outcome: "rejected", message: describeEditError(e, kind) }; }
  if (res?.error) return isNetworkError(res.error) ? lookUp() : { ok: false, outcome: "rejected", message: describeEditError(res.error, kind) };
  const r = res?.data;
  if (!r || typeof r !== "object" || !r.status) return lookUp();
  if (r.status === "ok") return { ok: true, outcome: "saved", deviceReverted: !!r.device_reverted };
  if (r.status === "already_saved") return { ok: true, outcome: "already_saved" };
  if (r.status === "already_undone") return { ok: true, outcome: "already_undone", message: `This entry had already been undone${r.deleted_by ? ` by ${r.deleted_by}` : ""}. Nothing was restored again.` };
  if (r.status === "unchanged") return { ok: true, outcome: "unchanged" };
  return { ok: false, outcome: r.status, message: refused(r, kind, unit) };
}

/**
 * request: { requestId, original (the log as the window showed it), amount, date, usedBy, note, testedByQC, unit }
 */
export function saveLogEdit({ client, request, actor }) {
  const o = request.original;
  if (!request.requestId) return Promise.resolve({ ok: false, outcome: "rejected", message: "This change has no reference id, so it was not sent. Close the window and try again." });
  return call(client, "log_edit", {
    p_request_id: request.requestId, p_log_id: o.id,
    p_seen_amount: o.amount, p_seen_date: o.date, p_seen_used_by: o.used_by, p_seen_note: o.note ?? "", p_seen_tested_by_qc: !!o.tested_by_qc,
    p_amount: request.amount, p_date: request.date, p_used_by: request.usedBy, p_note: request.note ?? "", p_tested_by_qc: !!request.testedByQC,
    p_actor: actor,
  }, "edit", request.unit);
}

/** request: { requestId, log (as the page showed it) } */
export function saveLogUndo({ client, request, actor }) {
  const l = request.log;
  if (!request.requestId) return Promise.resolve({ ok: false, outcome: "rejected", message: "This undo has no reference id, so it was not sent. Try again." });
  return call(client, "log_undo", { p_request_id: request.requestId, p_log_id: l.id, p_seen_amount: l.amount, p_seen_date: l.date, p_actor: actor }, "undo", null);
}
