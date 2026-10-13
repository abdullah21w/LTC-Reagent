// Stock Count entry rules: pure — no database access.
//
// What a person types for one count line → the counted quantity, always in the
// line's base unit (its `unit`). That number is the only thing saved
// (inventory_count_items.counted_quantity); reconciliation is unchanged.
//
// Packaging comes ONLY from the line's own snapshot, copied from the Lot when
// the count started (stock_count_start v2: packaging_snapshot = 1) and
// immutable afterwards. Three cases (linePackaging):
//   named    box size and a valid package name: full packages + loose units
//            are entered directly;
//   unnamed  box size but no package name recorded: the quantity is entered in
//            base units; "Calculate using packages" may switch to full
//            packages + loose units (no name is invented);
//   none     no snapshot (line created before U2a) or no whole box size ≥ 1:
//            base units only, nothing inferred.
// Entry modes: "packages" (count = packages × units per package + loose) or
// "total" (count = the quantity typed). Both blank = not counted (null); 0 is a
// real count. Amounts are checked as typed text, so nothing is rounded away.
import { normalizeUnit, unitLabel, validateQuantity, parsePackaging, validatePackUnit, toBaseUnits } from "./units";

// Largest amount accepted in any field and as the total (keeps every value and
// its hundredths exact as a JavaScript number).
export const COUNT_MAX = 1000000000;

const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const MSG = {
  not_a_number: "must be a number",
  not_plain: "must be written as a plain number (for example 12 or 12.5)",
  negative: "can't be negative",
  not_whole: "must be a whole number for this unit",
  too_precise: "can have at most 2 decimals",
  too_large: "can be at most 1,000,000,000",
};

// A typed amount, checked from its text: "0.10" is 0.1; "0.100000001" mL is too
// precise and "2.0000000001" pieces not whole (never snapped); "1e3" not plain.
function checkAmount(raw, unit) {
  const t = String(raw ?? "").trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) {
    return { ok: false, value: null, reason: /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(t) ? "not_plain" : "not_a_number" };
  }
  const decimals = (m[3] || "").replace(/0+$/, "").length;
  const q = validateQuantity(t, unit);
  if (!q.ok) return q;
  if (decimals > 0 && normalizeUnit(unit).countable) return { ok: false, value: null, reason: "not_whole" };
  if (decimals > 2) return { ok: false, value: null, reason: "too_precise" };
  if (q.value > COUNT_MAX) return { ok: false, value: null, reason: "too_large" };
  return q;
}

/**
 * The packaging a count line may be counted in.
 * → { kind: "none", reason: "no_snapshot" | "no_box_size" }
 *   { kind: "named" | "unnamed", perPackage, name (trimmed, or null), word(n) }
 */
export function linePackaging(line) {
  if (!line || Number(line.packaging_snapshot) !== 1) return { kind: "none", reason: "no_snapshot" };
  const p = parsePackaging(line.units_per_carton);
  if (!p.packaged) return { kind: "none", reason: "no_box_size" };
  const saved = blank(line.pack_unit) ? null : String(line.pack_unit).trim();
  const name = saved && validatePackUnit(saved, line.unit).ok ? saved : null;
  const word = (n) => (name ? unitLabel(name, n) : n === 1 ? "package" : "packages");
  return { kind: name ? "named" : "unnamed", perPackage: p.perBox, name, word };
}

/** The mode a line is entered in: named → packages, none → total, unnamed → as chosen (default total). */
export function entryMode(line, chosen) {
  const k = linePackaging(line).kind;
  return k === "named" ? "packages" : k === "none" ? "total" : chosen === "packages" ? "packages" : "total";
}

const num = (v) => String(Math.round(v * 100) / 100);

/**
 * entry: { packages, loose } in "packages" mode, { quantity } in "total" mode (text as typed).
 * mode defaults to entryMode(line) (the line's default).
 * → { status: "empty" | "ok" | "invalid", value (base units, or null), errors, text }
 */
export function planCount(entry, line, mode = entryMode(line)) {
  const unit = line?.unit;
  const pk = linePackaging(line);
  const units = (n) => unitLabel(unit, n);
  if (mode !== "packages" || pk.kind === "none") {
    if (blank(entry?.quantity)) return { status: "empty", value: null, errors: [], text: "" };
    const q = checkAmount(entry.quantity, unit);
    if (!q.ok) return { status: "invalid", value: null, errors: [`Counted quantity ${MSG[q.reason]}.`], text: "" };
    return { status: "ok", value: q.value, errors: [], text: `${num(q.value)} ${units(q.value)}` };
  }
  if (blank(entry?.packages) && blank(entry?.loose)) return { status: "empty", value: null, errors: [], text: "" };
  const errors = [];
  const b = checkAmount(blank(entry.packages) ? "0" : entry.packages, "box");
  if (!b.ok) errors.push(b.reason === "not_whole" ? `Full ${pk.word(2)} must be a whole number (count opened ones as loose ${units(2)}).` : `Full ${pk.word(2)} ${MSG[b.reason]}.`);
  const l = checkAmount(blank(entry.loose) ? "0" : entry.loose, unit);
  if (!l.ok) errors.push(`Loose ${units(2)} ${MSG[l.reason]}.`);
  // decided before the exact sum, so a huge product can never lose precision
  if (!errors.length && b.value * pk.perPackage + l.value > COUNT_MAX) errors.push(`The counted total can be at most 1,000,000,000 ${units(2)}.`);
  if (errors.length) return { status: "invalid", value: null, errors, text: "" };
  const t = toBaseUnits({ boxes: b.value, loose: l.value }, pk.perPackage, unit);
  if (!t.ok) return { status: "invalid", value: null, errors: ["The counted quantity couldn't be calculated."], text: "" };
  const parts = `${b.value} ${pk.word(b.value)} × ${pk.perPackage} ${units(pk.perPackage)}${l.value ? ` + ${num(l.value)} ${units(l.value)}` : ""}`;
  return { status: "ok", value: t.value, errors: [], text: `${parts} = ${num(t.value)} ${units(t.value)}` };
}

/**
 * The fields for a quantity (a saved count, or a total being switched) in a mode.
 * null → blank fields; 0 → "0" (a confirmed zero stays a zero). In "packages"
 * mode the split is done in whole hundredths — exact, nothing rounded:
 * 17 at 5 per box → 3 + 2; 1500.1 at 500 → 3 + 0.1. A value that can't be
 * represented that way (negative, more than 2 decimals) is not split: it stays
 * in loose units as it is, so it is shown, never altered.
 */
export function entryFor(value, line, mode = entryMode(line)) {
  if (value === null || value === undefined || value === "") return { packages: "", loose: "", quantity: "" };
  const n = Number(value);
  const pk = linePackaging(line);
  if (mode !== "packages" || pk.kind === "none") return { packages: "", loose: "", quantity: String(n) };
  const h = n * 100;
  if (!Number.isFinite(n) || n < 0 || Math.abs(h - Math.round(h)) > 1e-6) return { packages: "0", loose: String(n), quantity: "" };
  const hundredths = Math.round(h), perH = pk.perPackage * 100;
  const full = Math.floor(hundredths / perH);
  return { packages: String(full), loose: String((hundredths - full * perH) / 100), quantity: "" };
}

/**
 * Switch a line's entry between "total" and "packages" (unnamed packaging only).
 * Never writes and never rounds: the entered total is carried over exactly; an
 * invalid entry is not converted (it stays, with the reason).
 * → { ok: true, entry } | { ok: false, error }
 */
export function switchEntry(entry, line, from, to) {
  if (from === to) return { ok: true, entry };
  const plan = planCount(entry, line, from);
  if (plan.status === "invalid") return { ok: false, error: `Fix this first, then switch: ${plan.errors.join(" ")}` };
  return { ok: true, entry: entryFor(plan.status === "empty" ? null : plan.value, line, to) };
}

/** Same counted quantity (null = not counted). */
export const sameCount = (a, b) => (a == null || b == null ? a == null && b == null : Number(a) === Number(b));
