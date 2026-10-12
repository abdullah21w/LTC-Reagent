// Inventory unit engine (pure; no database access, no app imports).
//
// The model:
//   * Every lot has one base unit: its `unit`. All stored quantities of the
//     lot (received, current, threshold, log amounts, Stock Count expected /
//     counted) are in that base unit.
//   * A packaged lot (units_per_carton set) holds `perBox` base units in each
//     box: 3 boxes × 5 per box = 15 base units. Boxes are only a way to read
//     the base quantity: 14 = 2 full boxes + 4 loose. A partly used box is
//     reported as loose units; which physical box was opened is not tracked.
//   * An un-packaged lot is counted in its base unit directly — which may
//     itself be "box".
//   * The outer package's name (box, carton, pack …) is a Lot setting, kept
//     with the Lot like its unit and box size (1 box = 5 bottles, 1 carton =
//     10 boxes, 1 pack = 6 vials). Callers pass it as options.packUnit (or a
//     lot's pack_unit field, if one is ever stored); a saved label always wins.
//     Only when none is saved, legacyPackUnitFor() picks a display name —
//     "box", or "carton" when the base unit is itself a box, "case" for a
//     carton — reported as packUnitSource "legacy_inferred": a display
//     fallback, not a statement about the physical packaging.
//     The outer label can never equal the base unit ("1 box = 5 boxes"): such
//     a saved label is refused (same_as_base_unit) and the fallback is used.
//   * Each lot has its own perBox. Nothing here ever multiplies or divides a
//     stored quantity because packaging changed; conversions only run on
//     values a caller is about to store (e.g. boxes + loose typed at receiving).
//   * Quantities in different base units are never added together.
//   * Countable units (box, bottle, piece …) take whole numbers only; measured
//     units (mL, g …) take up to 2 decimals.
//
// Unit labels are normalized here, in code only; stored text is never changed.

const COUNTABLE = {
  box: "box", bottle: "bottle", piece: "piece", bag: "bag", roll: "roll", cylinder: "cylinder",
  kit: "kit", pack: "pack", vial: "vial", tube: "tube", cartridge: "cartridge", carton: "carton",
  strip: "strip", slide: "slide", cassette: "cassette", test: "test", rack: "rack", pair: "pair",
  sheet: "sheet", ream: "ream", can: "can", jar: "jar", tray: "tray", plate: "plate", cup: "cup",
  ampoule: "ampoule", syringe: "syringe", unit: "unit", case: "case",
};
const MEASURED = { ml: "mL", l: "L", ul: "µL", g: "g", mg: "mg", kg: "kg" };
const ALIASES = {
  boxes: "box", bx: "box", pcs: "piece", pc: "piece", pce: "piece", btl: "bottle", btls: "bottle",
  mls: "ml", millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  litre: "l", liter: "l", litres: "l", liters: "l", "µl": "ul", μl: "ul", microlitre: "ul", microliter: "ul",
  gram: "g", grams: "g", gm: "g", gms: "g", milligram: "mg", milligrams: "mg", kilogram: "kg", kilograms: "kg",
  units: "unit",
};
const PLURAL = { box: "boxes" };

const EPS = 1e-9;
const round2 = (v) => Math.round(v * 100) / 100;
// Snap float noise (13.000000000000002) to the nearest whole / hundredth.
const snap = (v) => (Math.abs(v - Math.round(v)) < EPS ? Math.round(v) : Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? round2(v) : v);

// ─── Labels ────────────────────────────────────────────────────────────────
// { key, label, countable, known, original }
//   key        comparison key ("box", "bottle", "ml" …; unknown labels: trimmed lowercase)
//   label      display spelling (singular)
//   countable  whole numbers only (unknown labels are treated as countable)
//   known      whether the label is in the vocabulary above
export function normalizeUnit(raw) {
  const original = raw == null ? "" : String(raw);
  const t = original.trim().replace(/\s+/g, " ").toLowerCase();
  if (!t) return { key: "", label: "", countable: true, known: false, original };
  let k = ALIASES[t] ?? t;
  if (!COUNTABLE[k] && !MEASURED[k]) {
    // Plural of a known word only ("bags" → bag); unknown words are left alone ("gas" stays "gas").
    if (k.endsWith("s") && COUNTABLE[k.slice(0, -1)]) k = k.slice(0, -1);
  }
  if (COUNTABLE[k]) return { key: k, label: COUNTABLE[k], countable: true, known: true, original };
  if (MEASURED[k]) return { key: k, label: MEASURED[k], countable: false, known: true, original };
  return { key: t, label: original.trim().replace(/\s+/g, " "), countable: true, known: false, original };
}

export function unitsCompatible(a, b) {
  const x = normalizeUnit(a), y = normalizeUnit(b);
  return x.key !== "" && x.key === y.key;
}

// "1 bottle", "2 bottles", "1 box", "3 boxes", "15 mL" (measured units don't pluralize).
export function unitLabel(raw, qty) {
  const u = normalizeUnit(raw);
  if (!u.label) return "units";
  if (!u.countable || qty === 1) return u.label;
  if (u.known) return PLURAL[u.key] ?? `${u.label}s`;
  return u.label; // unknown spelling: shown as stored
}

// ─── Numbers ───────────────────────────────────────────────────────────────
function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v.trim())) return Number(v.trim());
  return NaN;
}

// { ok, value, reason } — reason: "not_a_number" | "negative" | "not_whole" | "too_precise"
export function validateQuantity(v, unit) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return { ok: false, value: null, reason: "not_a_number" };
  if (n < 0) return { ok: false, value: null, reason: "negative" };
  const s = snap(n) + 0; // + 0 turns -0 into 0
  if (normalizeUnit(unit).countable) {
    if (!Number.isInteger(s)) return { ok: false, value: null, reason: "not_whole" };
  } else if (Math.abs(s - round2(s)) > EPS) return { ok: false, value: null, reason: "too_precise" };
  return { ok: true, value: s, reason: null };
}

// ─── Packaging ─────────────────────────────────────────────────────────────
// units_per_carton → { packaged, perBox, valid, reason }
//   null / undefined / ""  → not packaged (valid)
//   whole number ≥ 1       → packaged
//   anything else          → invalid (0, negative, fraction, text): never used
//                            to split a quantity into boxes
export function parsePackaging(unitsPerCarton) {
  if (unitsPerCarton === null || unitsPerCarton === undefined || (typeof unitsPerCarton === "string" && unitsPerCarton.trim() === "")) {
    return { packaged: false, perBox: null, valid: true, reason: null };
  }
  const n = toNumber(unitsPerCarton);
  if (!Number.isFinite(n)) return { packaged: false, perBox: null, valid: false, reason: "not_a_number" };
  if (!Number.isInteger(n) || n < 1) return { packaged: false, perBox: null, valid: false, reason: n < 1 ? "below_one" : "not_whole" };
  return { packaged: true, perBox: n, valid: true, reason: null };
}

// ─── Outer package label ───────────────────────────────────────────────────
// Check a saved outer-package label against the lot's base unit.
// → { ok, label: { singular, plural } | null, reason }
//   blank            ok, label null (nothing saved)
//   over 40 chars    refused ("too_long"; the database allows at most 40)
//   measured unit    refused ("measured_unit": a pack can't be "mL")
//   same as base     refused ("same_as_base_unit": "1 box = 5 boxes")
export const PACK_UNIT_MAX_LENGTH = 40;
export function validatePackUnit(label, baseUnit) {
  if (label === null || label === undefined || String(label).trim() === "") return { ok: true, label: null, reason: null };
  if (String(label).trim().length > PACK_UNIT_MAX_LENGTH) return { ok: false, label: null, reason: "too_long" };
  const p = normalizeUnit(label), b = normalizeUnit(baseUnit);
  if (!p.countable) return { ok: false, label: null, reason: "measured_unit" };
  if (b.key !== "" && p.key === b.key) return { ok: false, label: null, reason: "same_as_base_unit" };
  return { ok: true, label: { singular: unitLabel(label, 1), plural: unitLabel(label, 2) }, reason: null };
}

// Package names offered when packaging is set up (any other name may be typed).
export const SUGGESTED_PACK_UNITS = ["box", "carton", "pack", "kit", "case", "bag", "tray", "rack"];

// Legacy display fallback, used only when no outer label is saved: "box",
// or "carton" when the base unit is a box, "case" when it is a carton. Never
// equal to the base unit; says nothing about the real packaging.
const LEGACY_PACK_FOR = { box: "carton", carton: "case" };
export function legacyPackUnitFor(baseUnit) {
  const key = LEGACY_PACK_FOR[normalizeUnit(baseUnit).key] ?? "box";
  return { singular: key, plural: unitLabel(key, 2) };
}

// The outer label to show for a lot.
// → { singular, plural, source: "lot_setting" | "legacy_inferred", issue }
//   issue: why a saved label was not used (e.g. "same_as_base_unit"), else null.
// Precedence: options.packUnit, then lot.pack_unit, then the legacy fallback.
export function resolvePackUnit(lot, options = {}) {
  const saved = [options?.packUnit, lot?.pack_unit].find((x) => x !== null && x !== undefined && String(x).trim() !== "");
  const v = validatePackUnit(saved, lot?.unit);
  if (v.ok && v.label) return { ...v.label, source: "lot_setting", issue: null };
  return { ...legacyPackUnitFor(lot?.unit), source: "legacy_inferred", issue: v.ok ? null : v.reason };
}

// The unit model of one lot row (options.packUnit: the lot's saved outer label).
export function lotUnits(lot, options = {}) {
  const unit = normalizeUnit(lot?.unit);
  const pack = parsePackaging(lot?.units_per_carton);
  return { unit, packaged: pack.packaged, perBox: pack.perBox, packagingValid: pack.valid, packagingReason: pack.reason, packUnit: resolvePackUnit(lot, options) };
}

// boxes × perBox + loose → base units. Inputs are what a person typed; all
// must be whole numbers ≥ 0 and perBox a valid box size.
// → { ok, value, reason }
export function toBaseUnits({ boxes = 0, loose = 0 }, perBox) {
  const p = parsePackaging(perBox);
  if (!p.packaged) return { ok: false, value: null, reason: "invalid_box_size" };
  const b = validateQuantity(boxes === "" ? 0 : boxes, "box"), l = validateQuantity(loose === "" ? 0 : loose, "piece");
  if (!b.ok) return { ok: false, value: null, reason: `boxes_${b.reason}` };
  if (!l.ok) return { ok: false, value: null, reason: `loose_${l.reason}` };
  return { ok: true, value: b.value * p.perBox + l.value, reason: null };
}

// base units → { fullBoxes, loose, total, exact } for a valid box size; null
// otherwise. A historical non-whole quantity (e.g. 7.5) still splits: the
// remainder is kept to 2 decimals and `exact` is false.
export function splitIntoBoxes(qty, perBox) {
  const p = parsePackaging(perBox);
  const n = toNumber(qty);
  if (!p.packaged || !Number.isFinite(n) || n < 0) return null;
  const total = snap(n);
  const fullBoxes = Math.floor(total / p.perBox + EPS);
  const loose = snap(round2(total - fullBoxes * p.perBox));
  return { fullBoxes, loose, total, exact: Number.isInteger(total) };
}

// Describe a lot's quantity for display (options.packUnit: saved outer label).
// → { total, unit, packaged, packUnit, packUnitSource, fullBoxes, loose, partialBox, text }
// fullBoxes counts whole outer packages, named by packUnit; packUnitSource says
// whether that name is the lot's setting or the legacy fallback.
// partialBox: some units are outside full packages (no claim about which one).
export function describeQuantity(qty, lot, options = {}) {
  const { unit, packaged, perBox, packUnit } = lotUnits(lot, options);
  const n = toNumber(qty);
  const none = { packUnit: null, packUnitSource: null };
  if (!Number.isFinite(n)) return { total: null, unit: unit.label, packaged, ...(packaged ? { packUnit: packUnit.singular, packUnitSource: packUnit.source } : none), fullBoxes: null, loose: null, partialBox: false, text: "—" };
  const total = snap(n);
  const totalText = `${fmt(total)} ${unitLabel(lot?.unit, total)}`;
  if (!packaged || total < 0) return { total, unit: unit.label, packaged: false, ...none, fullBoxes: null, loose: null, partialBox: false, text: totalText };
  const s = splitIntoBoxes(total, perBox);
  const text = `${s.fullBoxes} full ${s.fullBoxes === 1 ? packUnit.singular : packUnit.plural} + ${fmt(s.loose)} loose ${unitLabel(lot?.unit, s.loose)} (${totalText})`;
  return { total, unit: unit.label, packaged: true, packUnit: packUnit.singular, packUnitSource: packUnit.source, fullBoxes: s.fullBoxes, loose: s.loose, partialBox: s.loose > 0, text };
}

const fmt = (v) => String(round2(v));

// Consume `amount` base units from `qty` (what Log use does): → { ok, value, reason }.
// Refuses rather than clamps, so a caller can decide; never touches packaging.
export function consume(qty, amount, unit) {
  const q = validateQuantity(qty, unit), a = validateQuantity(amount, unit);
  if (!q.ok) return { ok: false, value: null, reason: `stock_${q.reason}` };
  if (!a.ok) return { ok: false, value: null, reason: `amount_${a.reason}` };
  if (a.value > q.value + EPS) return { ok: false, value: null, reason: "more_than_in_stock" };
  return { ok: true, value: snap(round2(q.value - a.value)), reason: null };
}

// ─── Totals across lots ────────────────────────────────────────────────────
// Totals per base unit; quantities in different units are never added.
// items: [{ unit, qty, perBox? }]
// → [{ key, unit, total, lots, perBox }] — perBox is the common box size when
//   every lot of that unit has the same valid one, else null (then a box
//   breakdown of the total isn't meaningful).
export function totalsByUnit(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const u = normalizeUnit(it.unit);
    const n = toNumber(it.qty);
    if (!Number.isFinite(n)) continue;
    if (!byKey.has(u.key)) byKey.set(u.key, { key: u.key, unit: u.label, total: 0, lots: 0, perBoxes: new Set() });
    const g = byKey.get(u.key);
    g.total += n;
    g.lots += 1;
    const p = parsePackaging(it.perBox);
    g.perBoxes.add(p.packaged ? p.perBox : null);
  }
  return [...byKey.values()].map((g) => ({ key: g.key, unit: g.unit, total: snap(round2(g.total)), lots: g.lots, perBox: g.perBoxes.size === 1 ? [...g.perBoxes][0] : null }));
}

// One total if all items share a base unit: → { ok: true, unit, total, perBox }
// or { ok: false, reason: "incompatible_units", byUnit }.
export function sumQuantities(items) {
  const byUnit = totalsByUnit(items);
  if (byUnit.length === 0) return { ok: true, unit: null, total: 0, perBox: null };
  if (byUnit.length > 1) return { ok: false, reason: "incompatible_units", byUnit };
  return { ok: true, unit: byUnit[0].unit, total: byUnit[0].total, perBox: byUnit[0].perBox };
}

// ─── Allocation (for future Stock Count shortage spreading; not used yet) ──
// These are ARITHMETIC splits only. They do not know when anything was used
// and must not be presented as the historical consumption: a split of a
// physical-count shortage is an estimate. Any future reconciliation that uses
// them must
//   * weight by evidence where it exists (e.g. the lot's own logged usage
//     pattern) with allocateByWeights, using allocateEvenly only when there is
//     no evidence, and say which was used;
//   * show the proposed parts for explicit review before anything is written;
//   * never re-split or rewrite existing logs (historical fractional amounts
//     such as 1.5 or 2.11 pieces stay exactly as recorded).
// Every result carries estimate: true and the method used.
// Parts are whole numbers ≥ 0 for countable units, hundredths for measured
// units; they always add up to exactly `total`; the same input always gives
// the same parts; inputs are never modified.
//
// Split `total` into `slots` parts. Parts are spread evenly through the slots
// (6 over 4 → [1, 2, 1, 2]); when total < slots some parts are 0 (callers may
// drop them). → { ok, parts, reason, estimate, method: "even" }
export function allocateEvenly(total, slots, unit) {
  const t = validateQuantity(total, unit);
  if (!t.ok) return { ok: false, parts: null, reason: `total_${t.reason}` };
  if (!Number.isInteger(slots) || slots < 1) return { ok: false, parts: null, reason: "invalid_slots" };
  const scale = normalizeUnit(unit).countable ? 1 : 100;
  const T = Math.round(t.value * scale);
  const parts = [];
  for (let i = 0; i < slots; i++) parts.push((Math.floor(((i + 1) * T) / slots) - Math.floor((i * T) / slots)) / scale);
  return { ok: true, parts, reason: null, estimate: true, method: "even" };
}

// Split `total` in proportion to non-negative `weights` (e.g. days per week
// bucket, or evidence such as usage logged in each period), largest remainder
// method; ties go to the earlier slot. → { ok, parts, reason, estimate, method: "weighted" }
export function allocateByWeights(total, weights, unit) {
  const t = validateQuantity(total, unit);
  if (!t.ok) return { ok: false, parts: null, reason: `total_${t.reason}` };
  if (!Array.isArray(weights) || weights.length === 0) return { ok: false, parts: null, reason: "invalid_weights" };
  const w = weights.map(toNumber);
  if (w.some((x) => !Number.isFinite(x) || x < 0)) return { ok: false, parts: null, reason: "invalid_weights" };
  const W = w.reduce((a, b) => a + b, 0);
  if (W <= 0) return { ok: false, parts: null, reason: "invalid_weights" };
  const scale = normalizeUnit(unit).countable ? 1 : 100;
  const T = Math.round(t.value * scale);
  const exact = w.map((x) => (T * x) / W);
  const base = exact.map((x) => Math.floor(x + EPS));
  let left = T - base.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x + EPS) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i] += 1;
  // Safety net: never return parts that don't add up exactly.
  if (left !== 0 || base.some((x) => x < 0) || base.reduce((a, b) => a + b, 0) !== T) return { ok: false, parts: null, reason: "rounding_failed" };
  return { ok: true, parts: base.map((x) => x / scale), reason: null, estimate: true, method: "weighted" };
}
