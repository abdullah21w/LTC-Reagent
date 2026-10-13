// U1 — unit engine (units.js). Ported from the U1 review suite; Production fixtures
// replaced by synthetic Lots of the same shapes (tests/fixtures/lots.mjs).
import { readdirSync } from "node:fs";
import { suite, check, load, readSource, rootPath } from "../helpers/core.mjs";
import { LOTS, ALL_LOTS, UNIT_SPELLINGS } from "../fixtures/lots.mjs";

suite("U1 · unit engine (units.js)", async () => {

const U = await load("units.js");

// ── Business rules ──
const box5 = { unit: "bottle", units_per_carton: 5 };
check("rule 3: 3 boxes × 5 = 15", U.toBaseUnits({ boxes: 3, loose: 0 }, 5), { ok: true, value: 15, reason: null });
check("rule 4: consume 1 → 14", U.consume(15, 1, "bottle"), { ok: true, value: 14, reason: null });
check("rule 4: 14 → 2 full boxes + 4 loose", (({ fullBoxes, loose, partialBox }) => ({ fullBoxes, loose, partialBox }))(U.describeQuantity(14, box5)), { fullBoxes: 2, loose: 4, partialBox: true });
check("rule 4: text", U.describeQuantity(14, box5).text, "2 full boxes + 4 loose bottles (14 bottles)");
check("rule 5: consume 4 more → 10", U.consume(14, 4, "bottle").value, 10);
check("rule 5: 10 → 2 full boxes + 0 loose, no partial box", (({ fullBoxes, loose, partialBox, text }) => ({ fullBoxes, loose, partialBox, text }))(U.describeQuantity(10, box5)), { fullBoxes: 2, loose: 0, partialBox: false, text: "2 full boxes + 0 loose bottles (10 bottles)" });
check("rule 6: describe never names which box is open (no box identity fields)", Object.keys(U.describeQuantity(14, box5)).sort(), ["fullBoxes", "loose", "packUnit", "packUnitSource", "packaged", "partialBox", "text", "total", "unit"]);
check("rule 10: un-packaged lot whose base unit is box", U.describeQuantity(3, { unit: "BOX", units_per_carton: null }).text, "3 boxes");
check("rule 10: un-packaged single", U.describeQuantity(1, { unit: "box " }).text, "1 box");

// ── Normalization ──
check("every typical unit spelling is recognised", UNIT_SPELLINGS.filter((u) => !U.normalizeUnit(u).known), []);
check("typical spellings collapse to 6 base units", [...new Set(UNIT_SPELLINGS.map((u) => U.normalizeUnit(u).key))].sort(), ["bag", "bottle", "box", "cylinder", "piece", "roll"]);
check("case / spaces / plural", ["box", "BOX", "Box", "boxes", " Boxes "].map((u) => U.normalizeUnit(u).key), ["box", "box", "box", "box", "box"]);
check("bottle variants", ["bottle", "BOTTLE", "bottle ", "Bottle ", "Bottles", "btl"].map((u) => U.normalizeUnit(u).key), Array(6).fill("bottle"));
check("piece variants", ["pieces", "Piece ", "PIECES", "pieces ", "pcs", "pc"].map((u) => U.normalizeUnit(u).key), Array(6).fill("piece"));
check("bags / rolls", [U.normalizeUnit("BAGS").key, U.normalizeUnit("bags ").key, U.normalizeUnit("rolls").key], ["bag", "bag", "roll"]);
check("measured units", ["mL", "ml", "millilitres", "L", "µl", "g", "grams"].map((u) => [U.normalizeUnit(u).key, U.normalizeUnit(u).countable]), [["ml", false], ["ml", false], ["ml", false], ["l", false], ["ul", false], ["g", false], ["g", false]]);
check("unknown word not singularised ('gas' stays 'gas')", [U.normalizeUnit("gas").key, U.normalizeUnit("Gas").known], ["gas", false]);
check("unknown label keeps its spelling, treated as countable", (({ key, label, countable, known }) => ({ key, label, countable, known }))(U.normalizeUnit("  Test  Pack ")), { key: "test pack", label: "Test Pack", countable: true, known: false });
check("blank / null label", [U.normalizeUnit("").key, U.normalizeUnit(null).key, U.normalizeUnit(undefined).label], ["", "", ""]);
check("original text is kept untouched", U.normalizeUnit("Piece ").original, "Piece ");
check("unitLabel plurals", [U.unitLabel("box", 1), U.unitLabel("box", 2), U.unitLabel("bottle", 0), U.unitLabel("Piece ", 3), U.unitLabel("mL", 5), U.unitLabel("", 2)], ["box", "boxes", "bottles", "pieces", "mL", "units"]);

// ── Compatibility ──
check("compatible despite spelling", [U.unitsCompatible("BOX", "boxes"), U.unitsCompatible("Piece ", "pieces"), U.unitsCompatible("bottle ", "Bottle")], [true, true, true]);
check("incompatible", [U.unitsCompatible("box", "Piece "), U.unitsCompatible("bottle", "box"), U.unitsCompatible("", ""), U.unitsCompatible("ml", "g")], [false, false, false, false]);

// ── Quantity validation ──
const v = (x, u) => { const r = U.validateQuantity(x, u); return r.ok ? r.value : r.reason; };
check("countable: whole numbers only", [v(3, "box"), v("3", "box"), v(0, "bottle"), v(2.5, "bottle"), v(-1, "box"), v("", "box"), v("abc", "box"), v(NaN, "box"), v(Infinity, "box"), v(null, "box")], [3, 3, 0, "not_whole", "negative", "not_a_number", "not_a_number", "not_a_number", "not_a_number", "not_a_number"]);
check("float noise snaps to whole", [v(13.000000000000002, "piece"), v(0.1 + 0.2 + 0.7, "piece")], [13, 1]);
check("measured: up to 2 decimals", [v(2.5, "mL"), v("0.25", "mL"), v(0.125, "mL"), v(0.1 + 0.2, "mL")], [2.5, 0.25, "too_precise", 0.3]);
check("-0 becomes 0", Object.is(U.validateQuantity(-0, "box").value, 0), true);
check("unknown unit is validated as countable", v(1.5, "widget"), "not_whole");

// ── Packaging ──
const pk = (x) => { const p = U.parsePackaging(x); return p.packaged ? p.perBox : p.valid ? "none" : `invalid:${p.reason}`; };
check("parsePackaging", [pk(null), pk(undefined), pk(""), pk(6), pk("6"), pk(1), pk(0), pk(-2), pk(2.5), pk("x")], ["none", "none", "none", 6, 6, 1, "invalid:below_one", "invalid:below_one", "invalid:not_whole", "invalid:not_a_number"]);
check("invalid box size never splits a quantity", [U.splitIntoBoxes(12, 0), U.splitIntoBoxes(12, 2.5), U.describeQuantity(12, { unit: "bottle", units_per_carton: 0 }).text], [null, null, "12 bottles"]);
check("each lot keeps its own factor (Kit Q: 1/box and 6/box)", [U.lotUnits(LOTS.q1).perBox, U.lotUnits(LOTS.q6).perBox], [1, 6]);

// ── Conversions ──
const tb = (b, l, p) => { const r = U.toBaseUnits({ boxes: b, loose: l }, p); return r.ok ? r.value : r.reason; };
check("toBaseUnits", [tb(3, 0, 5), tb(2, 4, 5), tb(0, 0, 5), tb(0, 7, 5), tb("", "3", 5), tb(1, 0, 1)], [15, 14, 0, 7, 3, 1]);
check("toBaseUnits refuses bad input", [tb(1.5, 0, 5), tb(-1, 0, 5), tb(1, 0.5, 5), tb(1, 0, null), tb(1, 0, 0), tb("x", 0, 5)], ["boxes_not_whole", "boxes_negative", "loose_not_whole", "invalid_box_size", "invalid_box_size", "boxes_not_a_number"]);
const sb = (q, p) => { const r = U.splitIntoBoxes(q, p); return r && [r.fullBoxes, r.loose, r.exact]; };
check("splitIntoBoxes exact divisibility / zero / below one box", [sb(15, 5), sb(10, 5), sb(0, 5), sb(4, 5), sb(5, 5), sb(6, 1)], [[3, 0, true], [2, 0, true], [0, 0, true], [0, 4, true], [1, 0, true], [6, 0, true]]);
check("splitIntoBoxes historical fraction (7.5 at 5/box)", sb(7.5, 5), [1, 2.5, false]);
check("splitIntoBoxes refuses negative / NaN / no packaging", [sb(-1, 5), sb("x", 5), sb(5, null)], [null, null, null]);
check("round trip: split then rebuild = original (0..200 × sizes 1..13)", (() => { for (let p = 1; p <= 13; p++) for (let q = 0; q <= 200; q++) { const s = U.splitIntoBoxes(q, p); if (U.toBaseUnits({ boxes: s.fullBoxes, loose: s.loose }, p).value !== q || s.loose >= p) return [p, q]; } return true; })(), true);

// ── consume ──
const cs = (q, a, u) => { const r = U.consume(q, a, u); return r.ok ? r.value : r.reason; };
check("consume", [cs(15, 1, "bottle"), cs(1, 1, "bottle"), cs(2.5, 0.5, "mL"), cs(1, 2, "box"), cs(5, 1.5, "piece"), cs(5, -1, "box")], [14, 0, 2, "more_than_in_stock", "amount_not_whole", "amount_negative"]);
check("consume never reads or changes packaging", U.consume.length, 3);

// ── Totals: different units are never added together ──
const groupItems = (rows) => rows.map((r) => ({ unit: r.unit, qty: r.current_quantity, perBox: r.units_per_carton }));
check("mixed group (1 box + 15 Piece) is NOT summed", U.sumQuantities(groupItems([LOTS.pBox, LOTS.pPiece])), { ok: false, reason: "incompatible_units", byUnit: [{ key: "box", unit: "box", total: 1, lots: 1, perBox: null }, { key: "piece", unit: "piece", total: 15, lots: 1, perBox: 3 }] });
check("mixed group (2 box + 10 pieces) is NOT summed", U.sumQuantities(groupItems([LOTS.mBox, LOTS.mPiece])).ok, false);
check("same unit, different box sizes: 6 + 6 bottles summed, no common box size", U.sumQuantities(groupItems([LOTS.q1, LOTS.q6])), { ok: true, unit: "bottle", total: 12, perBox: null });
check("same unit and box size: 10 + 8 bottles, common box size 8", U.sumQuantities(groupItems([LOTS.l1, LOTS.l2])), { ok: true, unit: "bottle", total: 18, perBox: 8 });
check("spelling differences still sum ('bottle ' + 'Bottle')", U.sumQuantities([{ unit: "bottle ", qty: 2 }, { unit: "Bottle", qty: 3 }]).total, 5);
check("empty list → total 0", U.sumQuantities([]), { ok: true, unit: null, total: 0, perBox: null });
check("float noise in totals", U.totalsByUnit([{ unit: "piece", qty: 1.71 }, { unit: "piece", qty: 1.71 }, { unit: "piece", qty: 1.71 }])[0].total, 5.13);
check("non-numeric quantities are skipped, not counted as 0", U.totalsByUnit([{ unit: "box", qty: "x" }, { unit: "box", qty: 2 }])[0], { key: "box", unit: "box", total: 2, lots: 1, perBox: null });

// ── Displays (no stored value changes) ──
const d = (r) => U.describeQuantity(r.current_quantity, r).text;
check("9 at 6/box", d(LOTS.c6), "1 full box + 3 loose bottles (9 bottles)");
check("6 at 6/box", d(LOTS.q6), "1 full box + 0 loose bottles (6 bottles)");
check("6 at 1/box", d(LOTS.q1), "6 full boxes + 0 loose bottles (6 bottles)");
check("15 Piece at 3/box", d(LOTS.pPiece), "5 full boxes + 0 loose pieces (15 pieces)");
check("un-packaged box", d(LOTS.pBox), "1 box");
check("10 pieces at 2/box", d(LOTS.mPiece), "5 full boxes + 0 loose pieces (10 pieces)");
check("current 10 at 8/box (received 2 is shown as stored, not repaired)", [d(LOTS.l1), U.describeQuantity(LOTS.l1.quantity_received, LOTS.l1).text], ["1 full box + 2 loose bottles (10 bottles)", "0 full boxes + 2 loose bottles (2 bottles)"]);
check("historical fractional amount (1.5 Piece) is describable but not valid as a new countable entry", [U.describeQuantity(1.5, { unit: "Piece " }).text, U.validateQuantity(1.5, "Piece ").reason], ["1.5 pieces", "not_whole"]);
check("every synthetic lot describes without error", ALL_LOTS.filter((r) => U.describeQuantity(r.current_quantity, r).text === "—").length, 0);
check("all synthetic box sizes parse as valid packaging", ALL_LOTS.filter((r) => r.units_per_carton != null).every((r) => U.parsePackaging(r.units_per_carton).valid), true);
check("fixtures are not mutated by any call", (() => { const before = JSON.stringify(ALL_LOTS); for (const r of ALL_LOTS) { U.describeQuantity(r.current_quantity, r); U.lotUnits(r); } U.totalsByUnit(groupItems(ALL_LOTS)); return JSON.stringify(ALL_LOTS) === before; })(), true);

// ── Allocation ──
const ae = (t, n, u) => { const r = U.allocateEvenly(t, n, u); return r.ok ? r.parts : r.reason; };
check("allocateEvenly whole units", [ae(6, 4, "piece"), ae(8, 4, "box"), ae(2, 4, "bottle"), ae(0, 3, "box"), ae(5, 1, "box"), ae(19, 8, "Piece ")], [[1, 2, 1, 2], [2, 2, 2, 2], [0, 1, 0, 1], [0, 0, 0], [5], [2, 2, 3, 2, 2, 3, 2, 3]]);
check("allocateEvenly measured units (hundredths)", [ae(1, 3, "mL"), ae(0.1, 4, "mL")], [[0.33, 0.33, 0.34], [0.02, 0.03, 0.02, 0.03]]);
check("allocateEvenly refuses bad input", [ae(2.5, 2, "box"), ae(-1, 2, "box"), ae(3, 0, "box"), ae(3, 1.5, "box"), ae("x", 2, "box")], ["total_not_whole", "total_negative", "invalid_slots", "invalid_slots", "total_not_a_number"]);
const aw = (t, w, u) => { const r = U.allocateByWeights(t, w, u); return r.ok ? r.parts : r.reason; };
check("allocateByWeights", [aw(10, [7, 7, 7, 4], "piece"), aw(3, [1, 1, 1], "box"), aw(1, [1, 1], "box"), aw(5, [0, 1], "box"), aw(1, [3, 1], "mL")], [[3, 3, 3, 1], [1, 1, 1], [1, 0], [0, 5], [0.75, 0.25]]);
check("allocateByWeights refuses bad weights", [aw(3, [], "box"), aw(3, [0, 0], "box"), aw(3, [1, -1], "box"), aw(3, "x", "box"), aw(1.5, [1], "box")], ["invalid_weights", "invalid_weights", "invalid_weights", "invalid_weights", "total_not_whole"]);
check("property: allocations always sum exactly, non-negative, whole (countable)", (() => {
  for (let T = 0; T <= 60; T++) for (let n = 1; n <= 12; n++) {
    const e = U.allocateEvenly(T, n, "piece").parts;
    if (e.reduce((a, b) => a + b, 0) !== T || e.some((x) => x < 0 || !Number.isInteger(x)) || Math.max(...e) - Math.min(...e) > 1) return ["even", T, n];
    const w = Array.from({ length: n }, (_, i) => ((i * 7) % 5) + 1);
    const p = U.allocateByWeights(T, w, "piece").parts;
    if (p.reduce((a, b) => a + b, 0) !== T || p.some((x) => x < 0 || !Number.isInteger(x))) return ["weights", T, n];
  }
  return true;
})(), true);
check("property: measured allocations sum exactly to the hundredth", (() => { for (let c = 0; c <= 500; c += 7) for (let n = 1; n <= 9; n++) { const T = c / 100; const s = U.allocateEvenly(T, n, "mL").parts.reduce((a, b) => a + Math.round(b * 100), 0); if (s !== c) return [T, n]; } return true; })(), true);
check("a shortage of 19 Piece over 9 weeks → whole parts", ae(19, 9, "Piece "), [2, 2, 2, 2, 2, 2, 2, 2, 3]);

// ── Nested packaging labels ──
const s5 = LOTS.s5;
check("base unit box, 5 per outer pack: outer pack is a carton, never 'box'", d(s5), "1 full carton + 0 loose boxes (5 boxes)");
check("carton text for 0 / 1 / 2 cartons and loose boxes", [7, 10, 3, 0].map((q) => U.describeQuantity(q, { unit: "BOX", units_per_carton: 5 }).text), ["1 full carton + 2 loose boxes (7 boxes)", "2 full cartons + 0 loose boxes (10 boxes)", "0 full cartons + 3 loose boxes (3 boxes)", "0 full cartons + 0 loose boxes (0 boxes)"]);
check("never 'full box' when the base unit is a box (any spelling, 0..30 units)", ["box", "BOX", "Box ", "boxes"].every((u) => Array.from({ length: 31 }, (_, q) => U.describeQuantity(q, { unit: u, units_per_carton: 5 }).text).every((t) => !/full box/.test(t))), true);
check("legacyPackUnitFor", ["bottle", "Piece ", "box", "BOX ", "boxes", "carton", "Cartons", "", null, "widget"].map((u) => U.legacyPackUnitFor(u).singular), ["box", "box", "carton", "carton", "carton", "case", "case", "box", "box", "box"]);
check("legacyPackUnitFor plural", [U.legacyPackUnitFor("box").plural, U.legacyPackUnitFor("bottle").plural, U.legacyPackUnitFor("carton").plural], ["cartons", "boxes", "cases"]);
check("outer pack label never equals the base unit (every packaged fixture + vocabulary)", [...ALL_LOTS.filter((r) => r.units_per_carton != null).map((r) => r.unit), "box", "carton", "bottle", "piece", "bag", "kit"].filter((u) => U.legacyPackUnitFor(u).singular === U.normalizeUnit(u).key), []);
check("describeQuantity reports packUnit; null when not packaged", [U.describeQuantity(5, s5).packUnit, U.describeQuantity(9, LOTS.c6).packUnit, U.describeQuantity(1, LOTS.pBox).packUnit], ["carton", "box", null]);
check("lotUnits.packUnit for a box-in-carton lot (legacy fallback, no saved label)", U.lotUnits(s5).packUnit, { singular: "carton", plural: "cartons", source: "legacy_inferred", issue: null });
check("stored unit text is unchanged by the carton label", [s5.unit, U.normalizeUnit(s5.unit).original], ["box", "box"]);
check("other packaged fixtures keep 'box' as the outer pack", ALL_LOTS.filter((r) => r.units_per_carton != null && r !== s5).every((r) => U.lotUnits(r).packUnit.singular === "box"), true);

// ── Saved (Lot-level) outer labels take precedence ──
const lotOf = (unit, per, extra = {}) => ({ unit, units_per_carton: per, ...extra });
const dq = (q, l, o) => U.describeQuantity(q, l, o);
check("1 box = 5 bottles (saved 'box')", [dq(14, lotOf("bottle", 5), { packUnit: "box" }).text, dq(14, lotOf("bottle", 5), { packUnit: "box" }).packUnitSource], ["2 full boxes + 4 loose bottles (14 bottles)", "lot_setting"]);
check("1 box = 100 pieces (saved 'Box')", dq(250, lotOf("pieces", 100), { packUnit: "Box" }).text, "2 full boxes + 50 loose pieces (250 pieces)");
check("1 carton = 10 boxes (saved 'carton')", [dq(23, lotOf("box", 10), { packUnit: "carton" }).text, dq(23, lotOf("box", 10), { packUnit: "carton" }).packUnitSource], ["2 full cartons + 3 loose boxes (23 boxes)", "lot_setting"]);
check("1 pack = 6 vials (saved 'pack')", [dq(6, lotOf("vial", 6), { packUnit: "pack" }).text, dq(13, lotOf("vials", 6), { packUnit: "Packs" }).text], ["1 full pack + 0 loose vials (6 vials)", "2 full packs + 1 loose vial (13 vials)"]);
check("other saved labels: case of cartons, kit of tubes, unknown 'Crate' kept as typed", [dq(25, lotOf("carton", 12), { packUnit: "case" }).text, dq(9, lotOf("tube", 4), { packUnit: "kit" }).text, dq(5, lotOf("bottle", 2), { packUnit: " Crate " }).text], ["2 full cases + 1 loose carton (25 cartons)", "2 full kits + 1 loose tube (9 tubes)", "2 full Crate + 1 loose bottle (5 bottles)"]);
check("saved label overrides the legacy inference (base box: saved 'pack' beats inferred 'carton')", [dq(10, s5, { packUnit: "pack" }).text, dq(10, s5).text], ["2 full packs + 0 loose boxes (10 boxes)", "2 full cartons + 0 loose boxes (10 boxes)"]);
check("legacy fallback is labelled as such, saved label as lot_setting", [dq(10, s5).packUnitSource, dq(10, s5, { packUnit: "pack" }).packUnitSource], ["legacy_inferred", "lot_setting"]);
check("precedence: options.packUnit > lot.pack_unit > legacy", [U.resolvePackUnit(lotOf("bottle", 6, { pack_unit: "carton" }), { packUnit: "pack" }).singular, U.resolvePackUnit(lotOf("bottle", 6, { pack_unit: "carton" })).singular, U.resolvePackUnit(lotOf("bottle", 6)).singular], ["pack", "carton", "box"]);
check("blank saved labels are ignored (falls through to the next source)", [U.resolvePackUnit(lotOf("bottle", 6, { pack_unit: "carton" }), { packUnit: "  " }).singular, U.resolvePackUnit(lotOf("bottle", 6, { pack_unit: "" })).source], ["carton", "legacy_inferred"]);
check("ambiguity refused: saved 'box' on base unit box → fallback carton, issue reported", (() => { const r = U.resolvePackUnit(lotOf("BOX", 5), { packUnit: "Boxes" }); return [r.singular, r.source, r.issue]; })(), ["carton", "legacy_inferred", "same_as_base_unit"]);
check("ambiguity refused: same check for bottle / piece spellings", [U.validatePackUnit("Bottle ", "bottle").reason, U.validatePackUnit("pcs", "Piece ").reason], ["same_as_base_unit", "same_as_base_unit"]);
check("measured unit can't be an outer pack", U.validatePackUnit("mL", "bottle").reason, "measured_unit");
check("validatePackUnit: blank = nothing saved; valid label returns singular/plural", [U.validatePackUnit("", "bottle"), U.validatePackUnit("carton", "box")], [{ ok: true, label: null, reason: null }, { ok: true, label: { singular: "carton", plural: "cartons" }, reason: null }]);
check("validatePackUnit: 40 characters allowed, 41 refused (U2c-2)", [U.validatePackUnit("x".repeat(40), "bottle").ok, U.validatePackUnit("x".repeat(41), "bottle").reason], [true, "too_long"]);
check("never ambiguous: outer label ≠ base unit for every saved/base combination", (() => { const labels = ["box", "Box", "carton", "pack", "case", "kit", "bottle", "piece", "vial", "", null, "Crate"]; const bases = ["box", "BOX ", "bottle", "piece", "vial", "carton", "pack", "Crate", ""]; for (const b of bases) for (const l of labels) { const r = U.resolvePackUnit(lotOf(b, 5), { packUnit: l }); if (b && U.normalizeUnit(r.singular).key === U.normalizeUnit(b).key) return [b, l, r]; } return true; })(), true);
check("a saved label never changes quantities, box splits or totals", (() => { const l = lotOf("bottle", 6); const a = dq(9, l, { packUnit: "pack" }), b = dq(9, l); return [a.total, a.fullBoxes, a.loose, b.total, b.fullBoxes, b.loose]; })(), [9, 1, 3, 9, 1, 3]);
check("a saved label on an un-packaged lot has no effect (no box size)", [dq(3, lotOf("box", null), { packUnit: "carton" }).text, dq(3, lotOf("box", null), { packUnit: "carton" }).packUnit], ["3 boxes", null]);
check("the lot row is not modified by resolving labels", (() => { const l = Object.freeze(lotOf("bottle", 6, { pack_unit: "pack" })); U.describeQuantity(9, l, { packUnit: "box" }); return l.pack_unit; })(), "pack");
check("SUGGESTED_PACK_UNITS (U2c-2)", U.SUGGESTED_PACK_UNITS, ["box", "carton", "pack", "kit", "case", "bag", "tray", "rack"]);

// ── Allocation guarantees ──
check("results are marked as estimates with their method", [U.allocateEvenly(6, 4, "piece"), U.allocateByWeights(6, [1, 2], "piece")].map((r) => [r.estimate, r.method]), [[true, "even"], [true, "weighted"]]);
check("refusals carry no parts", [U.allocateEvenly(1.5, 2, "piece").parts, U.allocateByWeights(3, [0], "piece").parts], [null, null]);
check("deterministic: same input → same parts (200 repeats)", (() => { const a = JSON.stringify(U.allocateByWeights(19, [3, 1.5, 2.25, 7, 0, 4], "piece")), b = JSON.stringify(U.allocateEvenly(19, 7, "piece")); for (let i = 0; i < 200; i++) if (JSON.stringify(U.allocateByWeights(19, [3, 1.5, 2.25, 7, 0, 4], "piece")) !== a || JSON.stringify(U.allocateEvenly(19, 7, "piece")) !== b) return false; return true; })(), true);
check("inputs are never modified (frozen weights accepted)", (() => { const w = Object.freeze([2, 1, 1]); const r = U.allocateByWeights(5, w, "piece"); return [r.parts, [...w]]; })(), [[3, 1, 1], [2, 1, 1]]);
check("evidence weighting: usage logged per week [4, 0, 2, 2] spreads a shortage of 4 where usage was logged", U.allocateByWeights(4, [4, 0, 2, 2], "bottle").parts, [2, 0, 1, 1]);
check("zero-weight slots get nothing", U.allocateByWeights(7, [0, 3, 0, 4], "piece").parts, [0, 3, 0, 4]);
check("a historical fractional amount can't be re-split as countable (1.5 / 2.11 pieces refused)", [U.allocateEvenly(1.5, 2, "Piece ").reason, U.allocateByWeights(2.11, [1, 1], "Piece ").reason], ["total_not_whole", "total_not_whole"]);
check("property: weighted allocation with fractional, uneven and zero weights — whole, ≥0, exact", (() => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 3000; k++) {
    const n = 1 + Math.floor(rnd() * 12), T = Math.floor(rnd() * 80);
    const w = Array.from({ length: n }, () => (rnd() < 0.2 ? 0 : Math.round(rnd() * 1000) / 100));
    if (w.every((x) => x === 0)) w[0] = 1;
    const r = U.allocateByWeights(T, w, "piece");
    if (!r.ok || r.parts.reduce((a, b) => a + b, 0) !== T || r.parts.some((x) => x < 0 || !Number.isInteger(x)) || r.parts.some((x, i) => w[i] === 0 && x > 0)) return [T, w, r];
  }
  return true;
})(), true);
const fractionalLogs = [1.71, 2.11, 0.4, 1.5].map((amount, i) => ({ id: `f${i}`, amount, used_by: "Unlogged (physical count)" }));
check("historical fractional logs are left unchanged by allocating / validating / describing them", (() => { const before = JSON.stringify(fractionalLogs); for (const l of fractionalLogs) { U.allocateEvenly(Math.round(l.amount), 3, "piece"); U.validateQuantity(l.amount, "piece"); U.describeQuantity(l.amount, { unit: "piece" }); } return JSON.stringify(fractionalLogs) === before; })(), true);
check("historical fractional amounts still display as recorded", U.describeQuantity(2.11, { unit: "Piece " }).text, "2.11 pieces");

// ── Purity / scope of units.js ──
const srcText = readSource("units.js");
const code = srcText.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
check("units.js has no imports, no database or network calls", [/^\s*import\s/m.test(srcText), /supabase|fetch\(|\.rpc\(|\.insert\(|\.update\(|\.delete\(/.test(code)], [false, false]);
const appFiles = [...readdirSync(rootPath()).filter((f) => /\.(jsx?|mjs)$/.test(f) && f !== "units.js"), ...readdirSync(rootPath("api")).filter((f) => /\.m?js$/.test(f)).map((f) => `api/${f}`)];
const importers = appFiles.filter((f) => /from\s+["'](\.\.?\/)+units(\.js)?["']/.test(readSource(f))).sort();
check("units.js is imported only by forecast.js, Charts.jsx, api/_reportBuilder.js, App.jsx and lotEdit.js", importers, ["App.jsx", "Charts.jsx", "api/_reportBuilder.js", "forecast.js", "lotEdit.js"]);
const namesFrom = (f) => ((readSource(f).match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/units["']/) || [])[1] || "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean).sort();
check("Edit Lot / Log use import only label and validation helpers from units.js — no quantity conversion", [namesFrom("App.jsx"), namesFrom("lotEdit.js")], [["SUGGESTED_PACK_UNITS", "normalizeUnit", "unitLabel"], ["PACK_UNIT_MAX_LENGTH", "unitLabel", "validatePackUnit"]]);
check("Receive and Stock Count don't import units.js (until U2d-2 deliberately does)", ["ReceiveWizard.jsx", "StockCount.jsx"].filter((f) => importers.includes(f)), []);
}, { expectedChecks: 109 });
