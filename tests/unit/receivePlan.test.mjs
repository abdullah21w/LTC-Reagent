// U2d-2 — Receive entry rules (receivePlan.js): explicit base unit, packaged and unpackaged
// receipts, countable vs measured quantities, exact totals, package-name rules, low-stock
// threshold (blank = default, 0 kept), and the duplicate advisory (advisory only).
import { suite, check, load } from "../helpers/core.mjs";

suite("U2d-2 · Receive entry rules (receivePlan.js)", async () => {
const P = await load("receivePlan.js");
const plan = (f, d = 5) => P.planReceipt({ unit: "piece", packaged: false, quantity: "", packUnit: "", unitsPerPackage: "", packages: "", loose: "", lowStock: "", ...f }, d);
const val = (f, d) => { const r = plan(f, d); return r.status === "ok" ? r.value : r.errors; };
const pick = (r, ...k) => (Array.isArray(r) ? r : k.map((x) => r[x]));

// ── base unit ──
check("no base unit → invalid (no default, never mL)", plan({ unit: "", quantity: "3" }).errors, ["Choose the base unit (the unit you count and use, e.g. piece, bottle, mL)."]);
check("whitespace-only unit → invalid", plan({ unit: "   ", quantity: "3" }).status, "invalid");
check("unit stored trimmed, spelling kept", pick(val({ unit: "  Piece ", quantity: "3" }), "unit", "total"), ["Piece", 3]);
check("suggested base units (buttons)", P.SUGGESTED_BASE_UNITS, ["piece", "bottle", "box", "vial", "kit", "test", "tube", "bag", "roll", "mL", "L", "g"]);

// ── unpackaged ──
check("unpackaged countable: whole quantity stored as typed", pick(val({ quantity: "12" }), "packaged", "total", "perPackage", "packUnit"), [false, 12, null, null]);
check("unpackaged countable: decimals refused", plan({ quantity: "2.5" }).errors, ["Quantity received must be a whole number for this unit."]);
check("unpackaged measured: up to 2 decimals accepted, 3 refused", [pick(val({ unit: "mL", quantity: "12.55" }), "total")[0], plan({ unit: "mL", quantity: "12.555" }).errors], [12.55, ["Quantity received can have at most 2 decimals."]]);
check("unpackaged: blank, 0, negative, text, infinity refused", [plan({ quantity: "" }).errors[0], plan({ quantity: "0" }).errors[0], plan({ quantity: "-3" }).errors[0], plan({ quantity: "abc" }).errors[0], plan({ quantity: "Infinity" }).errors[0]], ["Enter the quantity received in pieces.", "The total received must be more than 0 pieces.", "Quantity received can't be negative.", "Quantity received must be a number.", "Quantity received must be a number."]);

// ── packaged ──
const pk = (f) => plan({ packaged: true, packUnit: "box", unitsPerPackage: "5", packages: "3", loose: "", ...f });
check("3 boxes × 5 pieces + 2 loose = 17 pieces; package name and size kept", pick(pk({ loose: "2" }).value, "total", "packUnit", "perPackage", "packages", "loose"), [17, "box", 5, 3, 2]);
check("loose left blank = 0: 3 × 5 = 15", pk({}).value.total, 15);
check("0 packages + loose only is allowed (4 pieces)", pk({ packages: "0", loose: "4" }).value.total, 4);
check("measured base unit: 3 bottles × 500 mL + 0.1 mL = exactly 1500.1 mL (no floating-point noise)", plan({ unit: "mL", packaged: true, packUnit: "bottle", unitsPerPackage: "500", packages: "3", loose: "0.1" }).value.total, 1500.1);
check("measured base unit: 0.1 + 0.2 loose sums are exact", plan({ unit: "mL", packaged: true, packUnit: "bottle", unitsPerPackage: "1", packages: "0", loose: "0.3" }).value.total, 0.3);
check("the size and package count must be whole; loose countable must be whole", [pk({ unitsPerPackage: "2.5" }).errors, pk({ packages: "1.5" }).errors, pk({ loose: "0.5" }).errors], [["Enter how many pieces are in each box (a whole number of 1 or more)."], ["Packages received must be a whole number (count full packages; put the rest in loose units)."], ["Loose pieces must be a whole number for this unit."]]);
check("size 0 / negative / blank refused", [pk({ unitsPerPackage: "0" }).status, pk({ unitsPerPackage: "-5" }).status, pk({ unitsPerPackage: "" }).status], ["invalid", "invalid", "invalid"]);
check("negative packages / loose refused", [pk({ packages: "-1" }).errors, pk({ loose: "-2" }).errors], [["Packages received can't be negative."], ["Loose pieces can't be negative."]]);
check("measured loose with 3 decimals refused", plan({ unit: "mL", packaged: true, packUnit: "bottle", unitsPerPackage: "500", packages: "1", loose: "0.125" }).errors, ["Loose mL can have at most 2 decimals."]);
check("total 0 (0 packages, no loose) refused", pk({ packages: "0", loose: "" }).errors, ["The total received must be more than 0 pieces."]);
check("non-finite values refused", [pk({ packages: "Infinity" }).status, pk({ unitsPerPackage: "NaN" }).status], ["invalid", "invalid"]);

// ── package name (same rules as Edit Lot) ──
check("package name required when packaged", pk({ packUnit: "" }).errors, ["Choose a package name (for example Box), or type your own."]);
check("custom name trimmed; 40 characters accepted, 41 refused", [pk({ packUnit: "  Sachet " }).value.packUnit, pk({ packUnit: "a".repeat(40) }).status, pk({ packUnit: "a".repeat(41) }).errors], ["Sachet", "ok", ["The package name can be at most 40 characters."]]);
check("measured package name refused; name equal to the base unit refused (incl. plural)", [pk({ packUnit: "mL" }).status, pk({ packUnit: "Pieces" }).errors[0].startsWith("The package name can't be the same as the unit inside it"), plan({ unit: "box", packaged: true, packUnit: "box", unitsPerPackage: "10", packages: "1" }).status], ["invalid", true, "invalid"]);
check("box inside an outer carton is fine (base unit box, package carton)", plan({ unit: "box", packaged: true, packUnit: "carton", unitsPerPackage: "10", packages: "2", loose: "3" }).value.total, 23);

// ── low-stock threshold ──
check("blank threshold → the configured default (flagged as default)", pick(val({ quantity: "3" }, 7), "lowStock", "lowStockIsDefault"), [7, true]);
check("explicit 0 is kept as 0 (not replaced by the default)", pick(val({ quantity: "3", lowStock: "0" }, 7), "lowStock", "lowStockIsDefault"), [0, false]);
check("threshold follows the base unit: countable whole, measured 2 decimals; negative refused", [plan({ quantity: "3", lowStock: "1.5" }).errors, val({ unit: "mL", quantity: "3", lowStock: "1.5" }).lowStock, plan({ quantity: "3", lowStock: "-1" }).errors], [["Low stock alert must be a whole number for this unit."], 1.5, ["Low stock alert can't be negative."]]);
check("no usable configured default → 5", [val({ quantity: "3" }, "").lowStock, val({ quantity: "3" }, undefined).lowStock, val({ quantity: "3" }, "abc").lowStock], [5, 5, 5]);

// ── precision: what is typed is what is stored (final review) ──
const tot = (f) => { const r = plan({ unit: "mL", ...f }); return r.status === "ok" ? r.value.total : r.errors; };
check("measured values kept exactly: 0.1, 0.10, 0.01, 1.25, 1500.1 (and their JSON is the same decimal)", ["0.1", "0.10", "0.01", "1.25", "1500.1"].map((q) => JSON.stringify(tot({ quantity: q }))), ["0.1", "0.1", "0.01", "1.25", "1500.1"]);
check("never silently rounded: 0.100000001 mL refused (not snapped to 0.1); 2.0000000001 pieces refused (not snapped to 2); 3.0 pieces is 3", [tot({ quantity: "0.100000001" }), plan({ quantity: "2.0000000001" }).errors, val({ quantity: "3.0" }).total], [["Quantity received can have at most 2 decimals."], ["Quantity received must be a whole number for this unit."], 3]);
check("exponent notation refused as not plain; Infinity / NaN not numbers", [tot({ quantity: "1e3" }), tot({ quantity: "Infinity" }), tot({ quantity: "NaN" })], [["Quantity received must be written as a plain number (for example 12 or 12.5)."], ["Quantity received must be a number."], ["Quantity received must be a number."]]);
check("overflow: at most 1,000,000,000 per field and in total (beyond that JavaScript numbers stop being exact)", [P.RECEIPT_MAX, tot({ quantity: "1000000000" }), tot({ quantity: "1000000000.01" }), tot({ quantity: "9007199254740993" }), tot({ packaged: true, packUnit: "bottle", unitsPerPackage: "1000000", packages: "1001" }), tot({ packaged: true, packUnit: "bottle", unitsPerPackage: "1000000", packages: "1000" })], [1000000000, 1000000000, ["Quantity received can be at most 1,000,000,000."], ["Quantity received can be at most 1,000,000,000."], ["The total received can be at most 1,000,000,000 mL."], 1000000000]);
let sweepBad = 0;
for (let c = 0; c <= 100000; c += 7) { const t = tot({ packaged: true, packUnit: "bottle", unitsPerPackage: "500", packages: "3", loose: (c / 100).toFixed(2) }); if (JSON.stringify(t) !== String((150000 + c) / 100)) sweepBad++; }
check("3 × 500 mL + every loose hundredth 0.00–1000.00 (step 0.07): the total always serializes as the exact decimal sum", sweepBad, 0);
check("threshold keeps its decimals exactly (0.10 mL → 0.1); pieces need whole", [val({ unit: "mL", quantity: "1", lowStock: "0.10" }).lowStock, plan({ quantity: "1", lowStock: "0.5" }).errors], [0.1, ["Low stock alert must be a whole number for this unit."]]);

// ── package names: Receive accepts exactly what Edit Lot accepts ──
const E = await load("lotEdit.js");
const bases = ["piece", "bottle", "box", "carton", "kit", "test", "mL", "L", "g", "Cassette"];
const names = ["box", "carton", "pack", "kit", "case", "bag", "tray", "rack", "Sachet", "  Pouch of 10 ", "BOXES", "Cartons", "bottles", "ml", "Litre", "a".repeat(40), "a".repeat(41)];
const recv = (b, n) => P.planReceipt({ unit: b, packaged: true, packUnit: n, unitsPerPackage: "4", packages: "1", loose: "", quantity: "", lowStock: "" }, 5).status === "ok";
const edit = (b, n) => E.planLotEdit({ original: { id: "x", lot_number: "TX-1", unit: b, quantity_received: 4, current_quantity: 4, low_stock_threshold: 0, units_per_carton: null, pack_unit: null, expiry_date: null }, form: { lot_number: "TX-1", unit: b, quantity_received: "4", current_quantity: "4", low_stock_threshold: "0", expiry_date: "" }, packagingEnabled: true, unitsPerBox: "4", packUnit: n, history: { logs: 0, countLines: 0 }, confirmed: true }).status === "ok";
const differ = [];
for (const b of bases) for (const n of names) if (recv(b, n) !== edit(b, n)) differ.push([b, n]);
const U = await load("units.js");
check("10 base units × 17 names (all 8 package presets + custom): Receive and Edit Lot agree on every pair", [names.slice(0, 8), differ], [U.SUGGESTED_PACK_UNITS, []]);
check("examples: presets accepted except the base unit itself; plurals/case caught; measured and 41-char names refused", [recv("box", "box"), recv("box", "BOXES"), recv("box", "carton"), recv("bottle", "bottles"), recv("piece", "ml"), recv("piece", "Litre"), recv("piece", "a".repeat(41)), recv("Cassette", "  Pouch of 10 ")], [false, false, true, false, false, false, false, true]);

// ── description ──
check("describeReceipt", [P.describeReceipt(pk({ loose: "2" }).value), P.describeReceipt(val({ quantity: "1" })), P.describeReceipt(plan({ unit: "mL", packaged: true, packUnit: "bottle", unitsPerPackage: "500", packages: "1", loose: "0" }).value)], ["3 boxes × 5 pieces + 2 pieces = 17 pieces", "1 piece", "1 bottle × 500 mL = 500 mL"]);

// ── duplicate advisory (advisory only; nothing merged or changed) ──
const rows = [
  { id: "a", lot_number: "TR-001", name: "Reagent R", department: "Chemistry", device: "Analyzer 1", unit: "piece", units_per_carton: 5, pack_unit: "box" },
  { id: "b", lot_number: "TR-001", name: "Reagent R", department: "Hematology", device: "", unit: "bottle", units_per_carton: 6, pack_unit: null },
  { id: "c", lot_number: "TR-001 ", name: "Reagent R", department: "Chemistry", device: "Analyzer 1 ", unit: "Pieces", units_per_carton: null, pack_unit: null },
  { id: "d", lot_number: "TR-002", name: "Other", department: "Chemistry", device: "Analyzer 1", unit: "piece", units_per_carton: 5, pack_unit: "box" },
];
const frozen = JSON.stringify(rows);
const d = P.findPossibleDuplicates(rows, { lotNumber: " TR-001 ", department: "Chemistry", device: "Analyzer 1", unit: "piece" });
check("same Lot number only (trimmed); same department+device listed first", d.map((m) => [m.lot.id, m.sameIdentity]), [["a", true], ["c", true], ["b", false]]);
check("packaging copy offered only when the base unit is compatible and a box size exists", d.map((m) => [m.lot.id, m.packagingCopyable, m.packagingNote]), [["a", true, null], ["c", false, null], ["b", false, "It is recorded in bottle, not piece, so its packaging can't be copied."]]);
check("no unit chosen yet → packaging of any packaged match may be copied (its unit comes with it)", P.findPossibleDuplicates(rows, { lotNumber: "TR-001", department: "X", device: "", unit: "" }).filter((m) => m.packagingCopyable).map((m) => m.lot.id), ["a", "b"]);
check("blank Lot number → no lookup result; inputs never modified", [P.findPossibleDuplicates(rows, { lotNumber: " ", department: "Chemistry" }), JSON.stringify(rows) === frozen], [[], true]);
check("a legacy box size that isn't whole is never offered for copying", P.findPossibleDuplicates([{ ...rows[0], units_per_carton: 2.5 }], { lotNumber: "TR-001", unit: "piece" })[0].packagingCopyable, false);
}, { expectedChecks: 41 });
