// Receive save path (U2d-1): the only place a received Lot is written.
//
// Retry safety rests on two things only: the receipt id, generated once when the
// Receive window opens (newReceiptId) and reused for every attempt in that window,
// and the Lot table's primary key. The insert sends the receipt id as the Lot's id,
// so the database itself refuses a second Lot for the same receipt — whatever any
// read-back said. A read-back is used only to RECOGNISE a success whose response
// was lost; a read-back that finds nothing proves nothing (the first request may
// still be on its way), so it is never reported as "not saved". Nothing is ever
// retried automatically.
//
// Outcomes ({ ok, outcome, id, message?, auditLogged?, warning? }):
//   saved          this request inserted the Lot and the database returned it
//   recovered      this request's response was lost, but the Lot was found by its id
//   already_saved  the database refused a second Lot for this receipt (primary key);
//                  the existing Lot was read back and matches this receipt
//   mismatch       a Lot with this receipt id exists but with other values (the form
//                  was changed after an earlier attempt went through) — NOT a success
//   rejected       the database refused the receipt; nothing was saved
//   not_confirmed  the request failed and the Lot was not found (yet) — it may still
//                  arrive; pressing "Add to inventory" again in the same window is safe
//   unknown        the request failed and the check failed too — same advice
//
// Activity entry: written only once the Lot is confirmed (saved / recovered /
// already_saved), and at most once per receipt id in this browser session — a receipt
// already recorded here is not recorded again on a later confirmation. If writing it
// fails, the Lot is still reported as saved (auditLogged: false + warning) and the
// insert is never repeated. Exactly-once across devices / sessions would need the
// entry to be written in the same database transaction as the Lot (a separate,
// gated database batch).

import { releaseRefusalMessage } from "./releaseGuard";
import { receiptChoicesProblem } from "./receivePlan";

export function newReceiptId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The columns the Receive screen has always written, plus the receipt id (U2d-1) and
// the package name (U2d-2). Quantities are the canonical base-unit total, computed by
// receivePlan.planReceipt; nothing here converts a quantity.
export function buildReceiptRow(entry, id) {
  return {
    id,
    name: (entry.name || "").replace(/[​-‏‪-‮﻿]/g, "").trim(),
    department: entry.department,
    item_type: entry.itemType,
    device: entry.device || "",
    device_choice: entry.deviceChoice ?? null,
    lot_number: entry.lotNumber,
    unit: entry.unit,
    quantity_received: entry.quantityReceived,
    current_quantity: entry.quantityReceived,
    expiry_date: entry.expiryDate || null,
    expiry_choice: entry.expiryChoice ?? null,
    date_added: entry.receivedDate,
    added_by: entry.receivedBy,
    low_stock_threshold: entry.lowStockThreshold,
    units_per_carton: entry.unitsPerCarton || null,
    pack_unit: entry.unitsPerCarton && entry.packUnit && String(entry.packUnit).trim() ? String(entry.packUnit).trim() : null,
    intact_container: entry.intact_container,
    complete_compound: entry.complete_compound,
    expiration_validity: entry.expiration_validity,
    lot_matches_kit: entry.lot_matches_kit,
    storage_condition_ok: entry.storage_condition_ok,
    receiving_notes: entry.receivingNotes,
    inspection_notes: entry.inspectionNotes,
  };
}

// The receipt's identity is its id (checked by the lookup itself); these submitted
// fields must also match before an existing Lot is accepted as this receipt.
const SAME_RECEIPT = ["name", "department", "item_type", "device", "device_choice", "expiry_choice", "lot_number", "unit", "quantity_received", "expiry_date", "date_added", "added_by", "units_per_carton", "pack_unit"];
const norm = (k, v) => (v === null || v === undefined || v === "" ? null : ["quantity_received", "units_per_carton"].includes(k) ? Number(v) : String(v));
export const sameReceipt = (row, saved) => !!saved && saved.id === row.id && SAME_RECEIPT.every((k) => norm(k, row[k]) === norm(k, saved[k]));

const isNetworkError = (e) => e?.name === "TypeError" || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|ECONNRE|aborted/i.test(String(e?.message || ""));
const isDuplicateReceipt = (e) => e?.code === "23505" && /reagents_pkey/.test(`${e?.message || ""} ${e?.details || ""}`);

// A clear sentence for a refused receipt. Every message says nothing was saved.
export function describeReceiveError(e) {
  // Maintenance / outdated build (ADD_RELEASE_CONTROL.sql): say so plainly.
  const rel = releaseRefusalMessage(e);
  if (rel) return rel;
  const msg = String(e?.message || "");
  if (e?.code === "42501" || /row-level security|permission denied/i.test(msg)) return "You don't have permission to receive stock, so nothing was saved. Ask the owner to check your account.";
  if (e?.code === "23514" && /reagents_receipt_choices/.test(msg)) return CHOICES_MESSAGE;
  if (e?.code === "23514") return `The database refused one of the values (${(msg.match(/constraint "([^"]+)"/) || [])[1] || "check failed"}). Nothing was saved — correct it and try again.`;
  if (e?.code === "23502") return `A required value is missing (${(msg.match(/column "([^"]+)"/) || [])[1] || "a field"}). Nothing was saved — complete it and try again.`;
  if (e?.code === "22P02" || e?.code === "22003" || e?.code === "22007" || e?.code === "22008") return `One of the values isn't in a valid format (${msg}). Nothing was saved — correct it and try again.`;
  return `The database refused the receipt${msg ? ` (${msg})` : ""}. Nothing was saved.`;
}

const SAME_WINDOW = "Keep this window open and press \"Add to inventory\" again — in this same window it is safe: this receipt can only ever be saved once. Don't start a new receipt for it.";
export const UNKNOWN_MESSAGE = `The connection failed before the database answered, so it isn't known yet whether this receipt was saved. Your entries are kept. ${SAME_WINDOW}`;
export const NOT_CONFIRMED_MESSAGE = `The save could not be confirmed: the connection failed and the receipt was not found in the inventory yet (it may still arrive). Your entries are kept. ${SAME_WINDOW}`;
export const MISMATCH_MESSAGE = "An earlier attempt of this receipt was already saved, with the values entered at that time. Nothing new was saved. Close this window and check the Lot in the inventory (edit it there if needed).";
export const CHOICES_MESSAGE = "Choose the device (a device from the list, or \"No device recorded\") and the expiry (the date, or \"No expiry date\") — both are required. Nothing was saved.";
export const AUDIT_WARNING = "The receipt was saved, but it could not be recorded in the activity log. Please tell the owner so the receipt can be noted manually.";

export function receiptDescription(row) {
  const qty = Number(row.quantity_received);
  const pack = row.units_per_carton ? ` (${Number(row.units_per_carton)} per ${row.pack_unit || "box"})` : "";
  return `${row.name} — Lot ${row.lot_number} — received ${Number.isFinite(qty) ? qty : row.quantity_received} ${String(row.unit ?? "").trim()}${pack}`.trim();
}

// Receipt ids whose activity entry was written in this browser session.
const activityRecorded = new Set();

// client: the app's Supabase client. entry: the Receive form (with receiptId).
// logActivity: (action, entity, description) => Promise<{ error }?>.
export async function saveReceipt({ client, entry, logActivity }) {
  const id = entry.receiptId;
  if (!id) return { ok: false, outcome: "rejected", id: null, message: "This receipt has no reference id, so it was not sent. Close the window and start again." };
  const row = buildReceiptRow(entry, id);
  // The device and expiry decisions must be explicit and match the data — checked
  // here before anything is sent, and again by the database (reagents_receipt_choices).
  if (receiptChoicesProblem(row)) return { ok: false, outcome: "rejected", id, message: CHOICES_MESSAGE };
  const readBack = async () => {
    try {
      const r = await client.from("reagents").select("*").eq("id", id);
      if (r?.error) return { known: false };
      return { known: true, row: (r?.data || [])[0] || null };
    } catch { return { known: false }; }
  };
  const confirmed = async (outcome) => {
    if (!logActivity) return { ok: true, outcome, id, auditLogged: null };
    if (activityRecorded.has(id)) return { ok: true, outcome, id, auditLogged: true, auditAlreadyRecorded: true };
    let auditLogged = false;
    try { const a = await logActivity("receive", "reagent", receiptDescription(row)); auditLogged = !(a && a.error); } catch { auditLogged = false; }
    if (auditLogged) { activityRecorded.add(id); return { ok: true, outcome, id, auditLogged: true }; }
    return { ok: true, outcome, id, auditLogged: false, warning: AUDIT_WARNING };
  };
  // Is there a Lot with this receipt id? Only a matching one counts as this receipt.
  const lookUp = async (foundOutcome, notFound) => {
    const rb = await readBack();
    if (!rb.known) return { ok: false, outcome: "unknown", id, message: UNKNOWN_MESSAGE };
    if (!rb.row) return notFound;
    return sameReceipt(row, rb.row) ? confirmed(foundOutcome) : { ok: false, outcome: "mismatch", id, message: MISMATCH_MESSAGE };
  };
  const notConfirmed = { ok: false, outcome: "not_confirmed", id, message: NOT_CONFIRMED_MESSAGE };

  let res;
  try { res = await client.from("reagents").insert(row).select("id"); }
  catch (e) {
    if (!isNetworkError(e)) return { ok: false, outcome: "rejected", id, message: describeReceiveError(e) };
    res = { data: null, error: { message: String(e?.message || e), network: true } };
  }
  const err = res?.error;
  if (err) {
    // The primary key refused a second Lot: a Lot with this receipt id exists.
    if (isDuplicateReceipt(err)) return lookUp("already_saved", { ok: false, outcome: "unknown", id, message: UNKNOWN_MESSAGE });
    if (err.network || isNetworkError(err)) return lookUp("recovered", notConfirmed);
    return { ok: false, outcome: "rejected", id, message: describeReceiveError(err) };
  }
  const data = Array.isArray(res?.data) ? res.data : null;
  if (data && data.length === 1 && data[0]?.id === id) return confirmed("saved");
  // No error but not exactly our one row: never treated as success without proof.
  return lookUp("saved", notConfirmed);
}
