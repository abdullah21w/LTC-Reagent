// Edit Lot rules (pure; no database access) and the Edit Lot save path
// (saveLotEdit — the only part that talks to the database, through the client
// passed in).
//
// A lot's stored quantities (quantity_received, current_quantity,
// low_stock_threshold) are always in the lot's own `unit`. For a lot with
// packaging (units_per_carton set) that unit is the one inside each box:
// receiving stores boxes × units per box, and Log use subtracts those units.
// units_per_carton only changes how boxes are displayed.
//
// So editing a lot never multiplies or divides a quantity. What an edit can do
// is change what the stored numbers MEAN: a different unit, packaging turned
// on/off, or a different box size (units_per_carton — which changes how the
// lot's past amounts read as boxes; Stock Count lines keep no box size of
// their own). Each of these is refused once the lot has usage logs or Stock
// Count lines (or while that can't be confirmed), and otherwise needs an
// explicit confirmation. Correcting the packaging of a lot with history is
// left to a separate, audited workflow (not built yet).
//
// The package name (pack_unit: box, carton, kit …) follows the same rule: it
// says what the stored amounts are packed in, so it can only be set or changed
// on a lot without history (and never just added to a lot with history — that
// is the database's packaging_locked guard too). A new name must be 1–40
// characters, a package rather than a measurement, different from the unit
// inside it, and needs a whole-number box size. Old values that predate these
// rules are left as they are and don't stop unrelated edits.

import { unitLabel as countLabel, validatePackUnit, PACK_UNIT_MAX_LENGTH } from "./units";
import { releaseRefusalMessage } from "./releaseGuard";

export const normUnit = (u) => String(u ?? "").trim().toLowerCase();

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
const num = (v) => (isBlank(v) ? NaN : Number(v));
const fmt = (n) => String(Math.round(Number(n) * 100) / 100);
const unitLabel = (u) => String(u ?? "").trim() || "units";

// Presentation only, never stored. A quantity in units with `perBox` units per
// package: with a package name "1 box + 3 bottles"; without one (legacy lots)
// neutral wording that names only the recorded size: "1 × 6-bottle pack + 3 bottles".
export function describeInBoxes(qty, perBox, unit, packName) {
  const q = Number(qty), p = Number(perBox);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q < 0) return null;
  const full = Math.floor(q / p + 1e-9);
  const loose = Math.round((q - full * p) * 100) / 100;
  const packs = isBlank(packName)
    ? `${full} × ${fmt(p)}-${countLabel(unit, 1)} pack${full === 1 ? "" : "s"}`
    : `${full} ${countLabel(packName, full)}`;
  return loose > 0 ? `${packs} + ${fmt(loose)} ${countLabel(unit, loose)}` : packs;
}

// Why a package name can't be used (null when it can). baseUnit = the lot's unit.
export function packNameProblem(name, baseUnit) {
  if (isBlank(name)) return "Choose a package name (for example Box), or type your own.";
  const v = validatePackUnit(name, baseUnit);
  if (v.ok) return null;
  if (v.reason === "too_long") return `The package name can be at most ${PACK_UNIT_MAX_LENGTH} characters.`;
  if (v.reason === "measured_unit") return `"${String(name).trim()}" is a measurement, not a package. Choose a package name such as Box.`;
  return `The package name can't be the same as the unit inside it ("${unitLabel(baseUnit)}"). Choose the name of the outer package, or turn packaging off.`;
}

// history: { logs, countLines } — counts of this lot's usage logs (any, incl.
// undone) and Stock Count lines (any count). null/undefined = not known.
export function hasHistory(history) {
  const logs = history?.logs, lines = history?.countLines;
  if (!Number.isInteger(logs) || !Number.isInteger(lines)) return null; // unknown
  return logs > 0 || lines > 0;
}

// original: the lot row as loaded. form: edited fields (strings from inputs).
// packagingEnabled / unitsPerBox / packUnit: the packaging controls (packUnit
// undefined = keep the lot's saved package name). confirmed: the
// confirmation checkbox. Returns
//   { status: "invalid" | "blocked" | "needs_confirmation" | "ok",
//     errors, blocks, confirmations, payload }
// payload is set only when status is "ok"; its quantities are exactly the
// numbers typed (never converted).
export function planLotEdit({ original, form, packagingEnabled, unitsPerBox, packUnit, history, confirmed = false }) {
  const errors = [];
  const qr = num(form.quantity_received), cq = num(form.current_quantity), low = num(form.low_stock_threshold);
  if (!Number.isFinite(qr) || qr < 0) errors.push("Quantity received must be a number of 0 or more.");
  if (!Number.isFinite(cq) || cq < 0) errors.push("Current quantity must be a number of 0 or more.");
  if (!Number.isFinite(low) || low < 0) errors.push("Low stock alert must be a number of 0 or more.");
  if (isBlank(form.unit)) errors.push("Unit can't be blank.");
  if (isBlank(form.lot_number)) errors.push("Lot number can't be blank.");

  const wasPackaged = original.units_per_carton !== null && original.units_per_carton !== undefined;
  const oldPer = wasPackaged ? Number(original.units_per_carton) : null;
  // Package name: the saved one unless a different one was chosen; cleared with packaging.
  const oldPack = isBlank(original.pack_unit) ? null : original.pack_unit;
  const newPack = !packagingEnabled ? null
    : packUnit === undefined || (oldPack !== null && String(packUnit) === String(oldPack)) ? oldPack
    : isBlank(packUnit) ? null : String(packUnit).trim();
  const packNameChanged = packagingEnabled && newPack !== oldPack;
  const packWord = newPack !== null ? countLabel(newPack, 1) : "box";
  let newPer = null;
  if (packagingEnabled) {
    const p = num(unitsPerBox);
    const unchanged = wasPackaged && p === oldPer;
    if (!Number.isFinite(p) || (!unchanged && (!Number.isInteger(p) || p < 1))) {
      errors.push(`Enter how many ${unitLabel(form.unit)} are in each ${packWord} (a whole number of 1 or more), or turn packaging off.`);
    } else newPer = p;
  }

  const unitChanged = normUnit(form.unit) !== normUnit(original.unit);
  if (packagingEnabled) {
    // A name is needed when packaging is newly set up or a saved name is removed;
    // a legacy packaged lot without one stays as it is. A saved name is only
    // re-checked when it or the unit changes.
    if (newPack === null) {
      if (!wasPackaged || oldPack !== null) errors.push(packNameProblem(null, form.unit));
    } else if (packNameChanged || unitChanged) {
      const problem = packNameProblem(newPack, form.unit);
      if (problem) errors.push(problem);
    }
    if (newPack !== null && packNameChanged && newPer !== null && !Number.isInteger(newPer)) {
      errors.push(`This lot's box size (${fmt(newPer)}) isn't a whole number, so a package name can't be set. Enter a whole-number box size first.`);
    }
  }
  const packaging = !wasPackaged && packagingEnabled ? "enable"
    : wasPackaged && !packagingEnabled ? "disable"
    : wasPackaged && packagingEnabled && newPer !== null && newPer !== oldPer ? "change" : "none";

  if (errors.length) return { status: "invalid", errors, blocks: [], confirmations: [], payload: null };

  const u = unitLabel(form.unit), oldU = unitLabel(original.unit);
  const hist = hasHistory(history);
  const blocks = [];
  const confirmations = [];
  const reinterprets = unitChanged || packaging !== "none" || packNameChanged;

  if (reinterprets && hist !== false) {
    const why = hist === null
      ? "This lot's usage and Stock Count history couldn't be checked"
      : `This lot already has ${history.logs} usage log${history.logs === 1 ? "" : "s"} and ${history.countLines} Stock Count line${history.countLines === 1 ? "" : "s"} recorded in ${oldU}`;
    if (unitChanged) blocks.push(`${why}, so its unit can't be changed from "${oldU}" to "${u}" — that would change what those recorded amounts mean.`);
    if (packaging === "enable") blocks.push(`${why}, so packaging can't be turned on — that would change what those recorded amounts mean.`);
    if (packaging === "disable") blocks.push(`${why}, so packaging can't be turned off — that would change what those recorded amounts mean.`);
    if (packaging === "change") blocks.push(`${why}, so its box size can't be changed from ${fmt(oldPer)} to ${fmt(newPer)} ${u} per box — that would change how those recorded amounts read as boxes.`);
    if (packNameChanged && packaging !== "enable") {
      blocks.push(oldPack === null
        ? `${why}, so a package name can't be added now — it would relabel those recorded amounts.`
        : `${why}, so its package name can't be changed from "${oldPack}" to "${newPack}" — it would relabel those recorded amounts.`);
    }
  }
  if (blocks.length) return { status: "blocked", errors: [], blocks, confirmations: [], payload: null };

  const amounts = `${fmt(qr)} ${u} received and ${fmt(cq)} ${u} current`;
  if (unitChanged) confirmations.push(`The unit changes from "${oldU}" to "${u}". Nothing is converted: the lot will read ${amounts}.`);
  if (packaging === "enable") {
    const inBoxes = describeInBoxes(cq, newPer, u, newPack);
    confirmations.push(`Packaging is turned on: 1 ${packWord} = ${fmt(newPer)} ${countLabel(u, newPer)}. Nothing is multiplied: the lot keeps ${amounts}${inBoxes ? ` (${inBoxes})` : ""}. Enter the quantities in ${u}, not in ${countLabel(packWord, 2)}.`);
  }
  if (packaging === "disable") confirmations.push(`Packaging is turned off. Nothing is divided: the lot keeps ${amounts}; boxes are no longer shown.`);
  if (packaging === "change") {
    const inBoxes = describeInBoxes(cq, newPer, u, newPack);
    confirmations.push(`The box size changes from ${fmt(oldPer)} to ${fmt(newPer)} ${u} per ${packWord}. Nothing is converted: the lot keeps ${amounts}${inBoxes ? ` (${inBoxes})` : ""}.`);
  }
  if (packNameChanged && packaging !== "enable") {
    const inBoxes = describeInBoxes(cq, newPer, u, newPack);
    const what = oldPack === null ? `The package name is set to "${newPack}"` : `The package name changes from "${oldPack}" to "${newPack}"`;
    confirmations.push(`${what} (1 ${packWord} = ${fmt(newPer)} ${countLabel(u, newPer)}). Nothing is converted: the lot keeps ${amounts}${inBoxes ? ` (${inBoxes})` : ""}.`);
  }
  if (confirmations.length && !confirmed) return { status: "needs_confirmation", errors: [], blocks: [], confirmations, payload: null };

  const payload = {
    ...original,
    lot_number: form.lot_number,
    unit: form.unit,
    quantity_received: qr,
    current_quantity: cq,
    expiry_date: form.expiry_date || null,
    low_stock_threshold: low,
    units_per_carton: packagingEnabled ? newPer : null,
    pack_unit: newPack,
  };
  return { status: "ok", errors: [], blocks: [], confirmations, payload };
}

// ─── Saving (U2c-1) ─────────────────────────────────────────────────────────
// The Edit Lot fields. Only the ones the user actually changed are written.
export const EDITABLE_FIELDS = ["lot_number", "unit", "quantity_received", "current_quantity", "expiry_date", "low_stock_threshold", "units_per_carton", "pack_unit"];
const NUMERIC_FIELDS = new Set(["quantity_received", "current_quantity", "low_stock_threshold", "units_per_carton"]);

// Comparable value: null for missing (and for a blank expiry date), a number
// for numeric fields, otherwise the exact stored text ("Bottle " ≠ "bottle" —
// a deliberate edit of the text is still an edit).
function comparable(field, v) {
  if (v === null || v === undefined) return null;
  if (field === "expiry_date" && String(v).trim() === "") return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
}

// What to write: { changes, expected, changed }
//   changes   field → new value, only for fields that differ from the original
//   expected  field → the original value, used as the concurrency condition
//   changed   the changed field names
export function buildLotUpdate(original, payload) {
  const changes = {}, expected = {};
  for (const f of EDITABLE_FIELDS) {
    if (!payload || !(f in payload)) continue;
    const before = comparable(f, original?.[f]), after = comparable(f, payload[f]);
    if (before !== after) { changes[f] = after; expected[f] = before; }
  }
  return { changes, expected, changed: Object.keys(changes) };
}

const FIELD_LABEL = { unit: "unit", units_per_carton: "box size", pack_unit: "package name" };
const isNetworkError = (e) => e?.name === "TypeError" || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|ECONNRE/i.test(String(e?.message || ""));

// A clear, user-facing sentence for a failed save. Every message says that
// nothing was saved.
//   { kind: "conflict" } — the update matched no row while the lot still exists
//   { kind: "missing" }  — the lot no longer exists
//   otherwise a Supabase/PostgREST error ({ message, code, details }) or a thrown error
export function describeSaveError(e) {
  // Maintenance / outdated build (ADD_RELEASE_CONTROL.sql): say so plainly.
  const rel = releaseRefusalMessage(e);
  if (rel) return rel;
  if (e?.kind === "conflict") return "This lot was changed elsewhere since you opened it (for example, usage was logged or someone else edited it). Nothing was saved — close this window and open the lot again to see the latest values.";
  if (e?.kind === "missing") return "This lot no longer exists, so nothing was saved.";
  if (e?.kind === "permission") return "You don't have permission to edit lots, so nothing was saved.";
  const msg = String(e?.message || "");
  if (msg === "packaging_locked") return `This lot now has usage or Stock Count records, so its ${FIELD_LABEL[e?.details] || "packaging"} can't be changed. Nothing was saved.`;
  if (e?.code === "23514" && /reagents_pack_unit_valid/.test(msg)) return `The database refused the package name (it must be 1–${PACK_UNIT_MAX_LENGTH} characters, needs a box size, and can't be the same as the unit). Nothing was saved.`;
  if (e?.code === "23514") return `The database refused one of the values (${(msg.match(/constraint "([^"]+)"/) || [])[1] || "check failed"}). Nothing was saved.`;
  if (isNetworkError(e)) return "Couldn't reach the database, so nothing was saved. Check the connection and try again.";
  return `The database refused the change${msg ? ` (${msg})` : ""}. Nothing was saved.`;
}

// Saves an Edit Lot change through `client` (the app's Supabase client).
//   original     the lot row as it was when the window opened
//   payload      planLotEdit(...).payload (status "ok")
//   logActivity  (action, entity, description) => Promise<{ error }?> — called
//                ONLY after the database confirmed the update
// Only changed fields are written, with edited_by / edited_at. Concurrency: the
// update only applies if every changed field still holds its original value
// (NULL compared with IS NULL), so a value changed elsewhere since the window
// opened — e.g. stock reduced by Log use while the quantity is being edited —
// makes it match no row; that is reported as a conflict and nothing is written.
// Unchanged fields are not sent, so newer values elsewhere are never overwritten.
// → { ok, unchanged?, changed, auditLogged?, warning?, message? }
export async function saveLotEdit({ client, original, payload, username, now, logActivity }) {
  const { changes, expected, changed } = buildLotUpdate(original, payload);
  if (changed.length === 0) return { ok: true, unchanged: true, changed };
  let q = client.from("reagents").update({ ...changes, edited_by: username, edited_at: now || new Date().toISOString() }).eq("id", original.id);
  for (const [f, v] of Object.entries(expected)) q = v === null ? q.is(f, null) : q.eq(f, v);
  let res;
  try { res = await q.select("id"); } catch (e) { return { ok: false, changed, message: describeSaveError(e) }; }
  if (res?.error) return { ok: false, changed, message: describeSaveError(res.error) };
  if (!Array.isArray(res?.data) || res.data.length === 0) {
    // Read-only follow-up: does the lot still exist? (unknown → treated as a conflict)
    let exists = null;
    try { const r = await client.from("reagents").select("id").eq("id", original.id); exists = r?.error ? null : (r?.data || []).length > 0; } catch {}
    return { ok: false, changed, message: describeSaveError({ kind: exists === false ? "missing" : "conflict" }) };
  }
  // The update is committed at this point. Logging it is a second, separate write:
  // if it fails (thrown, or an { error } result) the save is still reported as
  // saved — honestly flagged auditLogged: false with a warning — and the update is
  // never repeated.
  if (!logActivity) return { ok: true, changed, auditLogged: null };
  let auditLogged = false;
  try {
    const a = await logActivity("edit", "reagent", `${payload.name || original.name || ""} — Lot ${payload.lot_number ?? original.lot_number}`.trim());
    auditLogged = !(a && a.error);
  } catch { auditLogged = false; }
  if (!auditLogged) return { ok: true, changed, auditLogged: false, warning: "The change was saved, but it could not be recorded in the activity log. Please tell the owner so the edit can be noted manually." };
  return { ok: true, changed, auditLogged: true };
}
