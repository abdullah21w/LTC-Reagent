// Edit Lot rules (pure; no database access).
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

export const normUnit = (u) => String(u ?? "").trim().toLowerCase();

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
const num = (v) => (isBlank(v) ? NaN : Number(v));
const fmt = (n) => String(Math.round(Number(n) * 100) / 100);
const unitLabel = (u) => String(u ?? "").trim() || "units";

// "1 full box + 3 bottle" for a quantity in units with `perBox` units per box.
export function describeInBoxes(qty, perBox, unit) {
  const q = Number(qty), p = Number(perBox);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q < 0) return null;
  const full = Math.floor(q / p + 1e-9);
  const loose = Math.round((q - full * p) * 100) / 100;
  const u = unitLabel(unit);
  const boxes = `${full} full box${full === 1 ? "" : "es"}`;
  return loose > 0 ? `${boxes} + ${fmt(loose)} ${u}` : boxes;
}

// history: { logs, countLines } — counts of this lot's usage logs (any, incl.
// undone) and Stock Count lines (any count). null/undefined = not known.
export function hasHistory(history) {
  const logs = history?.logs, lines = history?.countLines;
  if (!Number.isInteger(logs) || !Number.isInteger(lines)) return null; // unknown
  return logs > 0 || lines > 0;
}

// original: the lot row as loaded. form: edited fields (strings from inputs).
// packagingEnabled / unitsPerBox: the packaging controls. confirmed: the
// confirmation checkbox. Returns
//   { status: "invalid" | "blocked" | "needs_confirmation" | "ok",
//     errors, blocks, confirmations, payload }
// payload is set only when status is "ok"; its quantities are exactly the
// numbers typed (never converted).
export function planLotEdit({ original, form, packagingEnabled, unitsPerBox, history, confirmed = false }) {
  const errors = [];
  const qr = num(form.quantity_received), cq = num(form.current_quantity), low = num(form.low_stock_threshold);
  if (!Number.isFinite(qr) || qr < 0) errors.push("Quantity received must be a number of 0 or more.");
  if (!Number.isFinite(cq) || cq < 0) errors.push("Current quantity must be a number of 0 or more.");
  if (!Number.isFinite(low) || low < 0) errors.push("Low stock alert must be a number of 0 or more.");
  if (isBlank(form.unit)) errors.push("Unit can't be blank.");
  if (isBlank(form.lot_number)) errors.push("Lot number can't be blank.");

  const wasPackaged = original.units_per_carton !== null && original.units_per_carton !== undefined;
  const oldPer = wasPackaged ? Number(original.units_per_carton) : null;
  let newPer = null;
  if (packagingEnabled) {
    const p = num(unitsPerBox);
    const unchanged = wasPackaged && p === oldPer;
    if (!Number.isFinite(p) || (!unchanged && (!Number.isInteger(p) || p < 1))) {
      errors.push(`Enter how many ${unitLabel(form.unit)} are in each box (a whole number of 1 or more), or turn packaging off.`);
    } else newPer = p;
  }

  const unitChanged = normUnit(form.unit) !== normUnit(original.unit);
  const packaging = !wasPackaged && packagingEnabled ? "enable"
    : wasPackaged && !packagingEnabled ? "disable"
    : wasPackaged && packagingEnabled && newPer !== null && newPer !== oldPer ? "change" : "none";

  if (errors.length) return { status: "invalid", errors, blocks: [], confirmations: [], payload: null };

  const u = unitLabel(form.unit), oldU = unitLabel(original.unit);
  const hist = hasHistory(history);
  const blocks = [];
  const confirmations = [];
  const reinterprets = unitChanged || packaging !== "none";

  if (reinterprets && hist !== false) {
    const why = hist === null
      ? "This lot's usage and Stock Count history couldn't be checked"
      : `This lot already has ${history.logs} usage log${history.logs === 1 ? "" : "s"} and ${history.countLines} Stock Count line${history.countLines === 1 ? "" : "s"} recorded in ${oldU}`;
    if (unitChanged) blocks.push(`${why}, so its unit can't be changed from "${oldU}" to "${u}" — that would change what those recorded amounts mean.`);
    if (packaging === "enable") blocks.push(`${why}, so packaging can't be turned on — that would change what those recorded amounts mean.`);
    if (packaging === "disable") blocks.push(`${why}, so packaging can't be turned off — that would change what those recorded amounts mean.`);
    if (packaging === "change") blocks.push(`${why}, so its box size can't be changed from ${fmt(oldPer)} to ${fmt(newPer)} ${u} per box — that would change how those recorded amounts read as boxes.`);
  }
  if (blocks.length) return { status: "blocked", errors: [], blocks, confirmations: [], payload: null };

  const amounts = `${fmt(qr)} ${u} received and ${fmt(cq)} ${u} current`;
  if (unitChanged) confirmations.push(`The unit changes from "${oldU}" to "${u}". Nothing is converted: the lot will read ${amounts}.`);
  if (packaging === "enable") {
    const inBoxes = describeInBoxes(cq, newPer, u);
    confirmations.push(`Packaging is turned on with ${fmt(newPer)} ${u} per box. Nothing is multiplied: the lot keeps ${amounts}${inBoxes ? ` (${inBoxes})` : ""}. Enter the quantities in ${u}, not in boxes.`);
  }
  if (packaging === "disable") confirmations.push(`Packaging is turned off. Nothing is divided: the lot keeps ${amounts}; boxes are no longer shown.`);
  if (packaging === "change") {
    const inBoxes = describeInBoxes(cq, newPer, u);
    confirmations.push(`The box size changes from ${fmt(oldPer)} to ${fmt(newPer)} ${u} per box. Nothing is converted: the lot keeps ${amounts}${inBoxes ? ` (${inBoxes})` : ""}.`);
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
  };
  return { status: "ok", errors: [], blocks: [], confirmations, payload };
}
