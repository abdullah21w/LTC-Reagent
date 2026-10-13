// Receive entry rules (U2d-2): pure — no database access.
//
// A new Lot is stored in ONE base unit (its `unit`). The person chooses it
// explicitly (no default). Then either
//   · no packaging: the quantity received is typed in the base unit, or
//   · packaged: package name (box, carton … or a custom name ≤ 40 characters),
//     base units per package (whole ≥ 1), packages received (whole ≥ 0) and loose
//     base units (≥ 0; whole for countable units, up to 2 decimals for measured).
//     total = packages × units per package + loose.
// Only the total in the base unit is stored as quantity_received and
// current_quantity; the package name and size go to pack_unit / units_per_carton.
// Nothing here touches an existing Lot.
import { normalizeUnit, unitLabel, validateQuantity, toBaseUnits } from "./units";
import { packNameProblem } from "./lotEdit";

// Base units offered as buttons (any other unit may be typed).
export const SUGGESTED_BASE_UNITS = ["piece", "bottle", "box", "vial", "kit", "test", "tube", "bag", "roll", "mL", "L", "g"];
export const DEFAULT_LOW_STOCK = 5;
// Largest amount Receive accepts in any field and as the total. Keeps every value
// (and its hundredths) far inside the range where JavaScript numbers are exact, so
// what is typed, reviewed, sent and stored is the same number.
export const RECEIPT_MAX = 1000000000;

const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const QTY_MSG = {
  not_a_number: "must be a number",
  negative: "can't be negative",
  not_whole: "must be a whole number for this unit",
  too_precise: "can have at most 2 decimals",
  not_plain: "must be written as a plain number (for example 12 or 12.5)",
  too_large: `can be at most 1,000,000,000`,
};

// Check a typed amount from its text, before it becomes a number, so nothing typed
// is ever rounded away: "0.10" and "1500.1" are kept; "0.100000001" mL is refused as
// too precise (units.js would snap it to 0.1), "2.0000000001" pieces as not whole,
// "1e3" as not plain, and anything above RECEIPT_MAX as too large.
// → { ok, value, reason }
function checkAmount(raw, unit) {
  const t = String(raw ?? "").trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) {
    // "1e3" is a number, but not as written on a delivery note; everything else isn't one
    return { ok: false, value: null, reason: /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(t) ? "not_plain" : "not_a_number" };
  }
  const decimals = (m[3] || "").replace(/0+$/, "").length;
  const q = validateQuantity(t, unit);
  if (!q.ok) return q;
  if (decimals > 0 && normalizeUnit(unit).countable) return { ok: false, value: null, reason: "not_whole" };
  if (decimals > 2) return { ok: false, value: null, reason: "too_precise" };
  if (q.value > RECEIPT_MAX) return { ok: false, value: null, reason: "too_large" };
  return q;
}

/**
 * form: { unit, packaged, packUnit, unitsPerPackage, packages, loose, quantity, lowStock }
 *       (strings as typed; packaged is a boolean)
 * defaultLowStock: the configured default, used only when lowStock is left blank.
 * → { status: "ok" | "invalid", errors: [ ... ], value: { unit, packaged, packUnit, perPackage,
 *      packages, loose, total, lowStock, lowStockIsDefault } | null }
 */
export function planReceipt(form, defaultLowStock = DEFAULT_LOW_STOCK) {
  const errors = [];
  const unit = blank(form.unit) ? "" : String(form.unit).trim();
  if (!unit) errors.push("Choose the base unit (the unit you count and use, e.g. piece, bottle, mL).");
  const u = unit || "unit";
  const measured = unit && !normalizeUnit(unit).countable;
  let total = null, packUnit = null, perPackage = null, packages = null, loose = null;

  if (form.packaged) {
    const name = blank(form.packUnit) ? "" : String(form.packUnit).trim();
    const problem = unit ? packNameProblem(name, unit) : blank(name) ? packNameProblem(name, unit) : null;
    if (problem) errors.push(problem);
    else packUnit = name;
    const per = checkAmount(form.unitsPerPackage, "box");
    if (blank(form.unitsPerPackage) || !per.ok || per.value < 1) errors.push(`Enter how many ${unitLabel(u, 2)} are in each ${packUnit ? unitLabel(packUnit, 1) : "package"} (a whole number of 1 or more).`);
    else perPackage = per.value;
    const pk = checkAmount(blank(form.packages) ? "0" : form.packages, "box");
    if (!pk.ok) errors.push(pk.reason === "not_whole" ? "Packages received must be a whole number (count full packages; put the rest in loose units)." : `Packages received ${QTY_MSG[pk.reason]}.`);
    else packages = pk.value;
    if (unit) {
      const lv = checkAmount(blank(form.loose) ? "0" : form.loose, unit);
      if (!lv.ok) errors.push(`Loose ${unitLabel(u, 2)} ${QTY_MSG[lv.reason]}.`);
      else loose = lv.value;
    }
    if (perPackage !== null && packages !== null && loose !== null) {
      // decided before multiplying exactly, so a huge product can never lose precision
      if (packages * perPackage + loose > RECEIPT_MAX) errors.push(`The total received can be at most 1,000,000,000 ${unitLabel(u, 2)}.`);
      else {
        const t = toBaseUnits({ boxes: packages, loose }, perPackage, unit);
        if (!t.ok) errors.push("The packaged quantity couldn't be calculated.");
        else total = t.value;
      }
    }
  } else if (unit) {
    const q = checkAmount(form.quantity, unit);
    if (blank(form.quantity)) errors.push(`Enter the quantity received in ${unitLabel(u, 2)}.`);
    else if (!q.ok) errors.push(`Quantity received ${QTY_MSG[q.reason]}.`);
    else total = q.value;
  }
  if (total !== null && !(total > 0)) errors.push(`The total received must be more than 0 ${unitLabel(u, 2)}.`);

  let lowStock = null, lowStockIsDefault = false;
  if (blank(form.lowStock)) {
    // blank = use the configured default (an explicit 0 below is kept as 0)
    const d = Number(defaultLowStock);
    lowStock = !blank(defaultLowStock) && Number.isFinite(d) && d >= 0 ? d : DEFAULT_LOW_STOCK;
    lowStockIsDefault = true;
  }
  else {
    const l = checkAmount(form.lowStock, unit || "piece");
    if (!l.ok) errors.push(`Low stock alert ${QTY_MSG[l.reason]}.`);
    else lowStock = l.value;
  }
  if (errors.length) return { status: "invalid", errors, value: null };
  return { status: "ok", errors: [], value: { unit, measured: !!measured, packaged: !!form.packaged, packUnit, perPackage, packages, loose, total, lowStock, lowStockIsDefault } };
}

/** "3 boxes × 5 pieces + 2 pieces = 17 pieces" (or "17 pieces" without packaging). */
export function describeReceipt(v) {
  if (!v) return "";
  const t = `${v.total} ${unitLabel(v.unit, v.total)}`;
  if (!v.packaged) return t;
  const parts = [`${v.packages} ${unitLabel(v.packUnit, v.packages)} × ${v.perPackage} ${unitLabel(v.unit, v.perPackage)}`];
  if (v.loose) parts.push(`${v.loose} ${unitLabel(v.unit, v.loose)}`);
  return `${parts.join(" + ")} = ${t}`;
}

/**
 * Possible duplicates among existing Lots with the same Lot number (exact, trimmed).
 * Advisory only. → [{ lot, sameIdentity, packagingCopyable, packagingNote }]
 *   sameIdentity: same department and device (the receipt identity staff should check)
 *   packagingCopyable: the existing Lot has a box size, its base unit is compatible with
 *                      the chosen one (or none is chosen yet), and its name is valid here
 */
export function findPossibleDuplicates(rows, { lotNumber, department, device, unit }) {
  const lot = String(lotNumber ?? "").trim();
  if (!lot) return [];
  const sameUnit = (a, b) => !blank(a) && !blank(b) && normalizeUnit(a).key === normalizeUnit(b).key;
  return (rows || [])
    .filter((r) => String(r.lot_number ?? "").trim() === lot)
    .map((r) => {
      const sameIdentity = (r.department ?? "") === (department ?? "") && String(r.device ?? "").trim() === String(device ?? "").trim();
      const hasPack = r.units_per_carton !== null && r.units_per_carton !== undefined && Number.isInteger(Number(r.units_per_carton)) && Number(r.units_per_carton) >= 1;
      const unitOk = blank(unit) || sameUnit(r.unit, unit);
      const nameOk = blank(r.pack_unit) || !packNameProblem(r.pack_unit, r.unit);
      const packagingCopyable = hasPack && unitOk && nameOk;
      const packagingNote = !hasPack ? null : !unitOk ? `It is recorded in ${String(r.unit).trim()}, not ${String(unit).trim()}, so its packaging can't be copied.` : null;
      return { lot: r, sameIdentity, packagingCopyable, packagingNote };
    })
    .sort((a, b) => Number(b.sameIdentity) - Number(a.sameIdentity));
}
