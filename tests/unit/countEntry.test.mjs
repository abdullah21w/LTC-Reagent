// Stock Count package + loose entry rules (countEntry.js): packaging only from the
// line's own snapshot (never inferred) in three cases — named (packages + loose),
// unnamed (total by default, optional switch to packages), none (total only);
// exact base-unit totals, no silent rounding, 0 is a count, blank is "not
// counted"; switching modes carries the total over exactly and never replaces an
// invalid entry or a confirmed zero; reopening gives back the same quantity.
import { suite, check, load } from "../helpers/core.mjs";

suite("Stock Count package + loose entry (countEntry.js)", async () => {
const C = await load("countEntry.js");
const line = (over = {}) => ({ id: "l1", lot_number: "TC-001", unit: "piece", packaging_snapshot: 1, pack_unit: "box", units_per_carton: 5, ...over });
const unnamed = line({ pack_unit: null, units_per_carton: 10 });
const legacy = line({ packaging_snapshot: null, pack_unit: null, units_per_carton: null });
const ml = line({ unit: "mL", pack_unit: "bottle", units_per_carton: 500 });
const mlUnnamed = line({ unit: "mL", pack_unit: null, units_per_carton: 500 });
const plan = (e, l = line(), m) => C.planCount(e, l, m);
const val = (e, l, m) => { const r = plan(e, l, m); return r.status === "ok" ? r.value : r.status === "empty" ? "empty" : r.errors; };

// ── the three cases ──
const pk = (l) => { const p = C.linePackaging(l); return p.kind === "none" ? p.reason : [p.kind, p.perPackage, p.name, p.word(1), p.word(2)]; };
check("case 1 — box size and a valid name: 'named'", pk(line()), ["named", 5, "box", "box", "boxes"]);
check("case 2 — box size, no name recorded: 'unnamed', NO name invented ('package')", pk(unnamed), ["unnamed", 10, null, "package", "packages"]);
check("case 3 — no snapshot (line from before U2a), even with a box size stored: base units only", [pk(legacy), pk(line({ packaging_snapshot: null }))], ["no_snapshot", "no_snapshot"]);
check("case 3 — snapshot without a usable box size (none, 0, fractional, negative, text)", [null, 0, 2.5, -3, "abc"].map((u) => pk(line({ units_per_carton: u, pack_unit: null }))), ["no_box_size", "no_box_size", "no_box_size", "no_box_size", "no_box_size"]);
check("a saved name the shared rules refuse (measured, same as the base unit) counts as 'not recorded'", [pk(line({ pack_unit: "mL" }))[0], pk(line({ pack_unit: "Pieces" }))[0]], ["unnamed", "unnamed"]);
check("snapshot values as PostgREST returns them (numeric as text, smallint as text)", [pk(line({ units_per_carton: "6" })), pk(line({ packaging_snapshot: "1", units_per_carton: 6 }))], [["named", 6, "box", "box", "boxes"], ["named", 6, "box", "box", "boxes"]]);
check("default entry mode: named → packages; unnamed → total (packages only when chosen); none → total always", [C.entryMode(line()), C.entryMode(line(), "total"), C.entryMode(unnamed), C.entryMode(unnamed, "packages"), C.entryMode(legacy, "packages")], ["packages", "packages", "total", "packages", "total"]);

// ── packages + loose ──
check("3 boxes × 5 + 2 loose = 17 pieces, with the calculation shown", [plan({ packages: "3", loose: "2" }).value, plan({ packages: "3", loose: "2" }).text], [17, "3 boxes × 5 pieces + 2 pieces = 17 pieces"]);
check("zero vs blank: 0 + 4 = 4; 3 + 0 = 15; 0 + 0 = a real 0; blank packages = 0 packages", [val({ packages: "0", loose: "4" }), val({ packages: "3", loose: "0" }), plan({ packages: "0", loose: "0" }).status, val({ packages: "0", loose: "0" }), val({ packages: "", loose: "4" })], [4, 15, "ok", 0, 4]);
check("both fields blank = not counted", [plan({ packages: "", loose: "" }).status, plan({ packages: "  ", loose: "" }).value], ["empty", null]);
check("loose may exceed one package (opened boxes counted loose): 1 box + 7 = 12", val({ packages: "1", loose: "7" }), 12);
check("fractional package count refused with a clear reason", val({ packages: "1.5", loose: "" }), ["Full boxes must be a whole number (count opened ones as loose pieces)."]);
check("negative packages / loose refused; both problems reported together", [val({ packages: "-1", loose: "" }), val({ packages: "x", loose: "0.5" })], [["Full boxes can't be negative."], ["Full boxes must be a number.", "Loose pieces must be a whole number for this unit."]]);
check("measured base unit: 3 bottles × 500 mL + 0.1 mL = exactly 1500.1 (JSON 1500.1)", [JSON.stringify(val({ packages: "3", loose: "0.1" }, ml)), plan({ packages: "3", loose: "0.10" }, ml).text], ["1500.1", "3 bottles × 500 mL + 0.1 mL = 1500.1 mL"]);
check("measured loose: 3 decimals refused (never rounded); 0.100000001 refused", [val({ packages: "0", loose: "0.125" }, ml), val({ packages: "0", loose: "0.100000001" }, ml)], [["Loose mL can have at most 2 decimals."], ["Loose mL can have at most 2 decimals."]]);
check("exponent, Infinity, NaN refused; total over 1,000,000,000 refused, the limit accepted", [val({ packages: "1e2", loose: "" }), val({ packages: "Infinity", loose: "" }), val({ packages: "", loose: "NaN" }), val({ packages: "200000001", loose: "" }), val({ packages: "200000000", loose: "" })], [["Full boxes must be written as a plain number (for example 12 or 12.5)."], ["Full boxes must be a number."], ["Loose pieces must be a number."], ["The counted total can be at most 1,000,000,000 pieces."], 1000000000]);
let bad = 0;
for (let c = 0; c <= 100000; c += 7) { const t = val({ packages: "3", loose: (c / 100).toFixed(2) }, ml); if (JSON.stringify(t) !== String((150000 + c) / 100)) bad++; }
check("3 × 500 mL + every loose hundredth 0.00–1000.00 (step 0.07): always the exact decimal sum", bad, 0);
check("unnamed line in packages mode: wording uses 'package(s)'", plan({ packages: "2", loose: "1" }, unnamed, "packages").text, "2 packages × 10 pieces + 1 piece = 21 pieces");

// ── total (base units) ──
check("total mode: 12 → 12; 0 → a real 0; blank → not counted (cases 2 and 3)", [val({ quantity: "12" }, legacy), val({ quantity: "0" }, unnamed), plan({ quantity: "" }, unnamed).status], [12, 0, "empty"]);
check("total mode: negative, fractional countable, exponent refused", [val({ quantity: "-1" }, legacy), val({ quantity: "2.5" }, unnamed), val({ quantity: "1e3" }, legacy)], [["Counted quantity can't be negative."], ["Counted quantity must be a whole number for this unit."], ["Counted quantity must be written as a plain number (for example 12 or 12.5)."]]);
check("total mode, measured: 2.55 kept exactly, 2.555 refused, 0.10 = 0.1", [val({ quantity: "2.55" }, mlUnnamed), val({ quantity: "2.555" }, mlUnnamed), val({ quantity: "0.10" }, mlUnnamed)], [2.55, ["Counted quantity can have at most 2 decimals."], 0.1]);
check("only the fields of the mode count (packages typed but total mode → empty, and vice versa)", [plan({ packages: "3", loose: "2" }, unnamed, "total").status, plan({ quantity: "9" }, line()).status], ["empty", "empty"]);

// ── fields for a quantity (reopening a saved count, or switching) ──
check("17 at 5 per box → 3 + 2; 15 → 3 + 0; a confirmed 0 → '0' + '0' (never blank); not counted → blank", [C.entryFor(17, line()), C.entryFor(15, line()), C.entryFor(0, line()), C.entryFor(null, line())], [{ packages: "3", loose: "2", quantity: "" }, { packages: "3", loose: "0", quantity: "" }, { packages: "0", loose: "0", quantity: "" }, { packages: "", loose: "", quantity: "" }]);
check("exact split in hundredths: 1500.1 mL at 500 → 3 + 0.1; 0.3 → 0 + 0.3; numeric text from the database", [C.entryFor(1500.1, ml), C.entryFor("0.3", ml), C.entryFor("1000", ml)], [{ packages: "3", loose: "0.1", quantity: "" }, { packages: "0", loose: "0.3", quantity: "" }, { packages: "2", loose: "0", quantity: "" }]);
check("total mode shows the number itself ('12.5', '0'); a value that can't split exactly stays loose, unaltered (7.555 → 0 + 7.555)", [C.entryFor(12.5, mlUnnamed), C.entryFor(0, legacy), C.entryFor(7.555, ml)], [{ packages: "", loose: "", quantity: "12.5" }, { packages: "", loose: "", quantity: "0" }, { packages: "0", loose: "7.555", quantity: "" }]);
let roundTrip = 0;
for (let q = 0; q <= 400; q++) { if (val(C.entryFor(q, line())) !== q) roundTrip++; if (val(C.entryFor(q, unnamed, "packages"), unnamed, "packages") !== q) roundTrip++; if (val(C.entryFor(q, unnamed), unnamed) !== q) roundTrip++; }
for (let q = 0; q <= 3000; q += 1.37) { const v = Math.round(q * 100) / 100; if (val(C.entryFor(v, ml), ml) !== v) roundTrip++; if (val(C.entryFor(v, mlUnnamed, "packages"), mlUnnamed, "packages") !== v) roundTrip++; }
check("every count 0–400 pieces and 0–3000 mL (step 1.37), in every mode, rebuilds fields that give back exactly the same quantity", roundTrip, 0);

// ── switching modes (unnamed packaging) ──
const sw = (e, l, from, to) => C.switchEntry(e, l, from, to);
check("total → packages: 21 pieces at 10 per package → 2 + 1 (exact)", sw({ quantity: "21" }, unnamed, "total", "packages"), { ok: true, entry: { packages: "2", loose: "1", quantity: "" } });
check("packages → total: 2 + 1 → '21'; measured 3 + 0.1 at 500 → '1500.1'", [sw({ packages: "2", loose: "1" }, unnamed, "packages", "total").entry.quantity, sw({ packages: "3", loose: "0.1" }, mlUnnamed, "packages", "total").entry.quantity], ["21", "1500.1"]);
check("a confirmed zero survives both ways ('0' ↔ '0' + '0'); blank stays blank", [sw({ quantity: "0" }, unnamed, "total", "packages").entry, sw({ packages: "0", loose: "0" }, unnamed, "packages", "total").entry.quantity, sw({ quantity: "" }, unnamed, "total", "packages").entry], [{ packages: "0", loose: "0", quantity: "" }, "0", { packages: "", loose: "", quantity: "" }]);
check("an invalid entry is never converted or replaced: the switch is refused with the reason", [sw({ quantity: "2.5" }, unnamed, "total", "packages"), sw({ packages: "1.5", loose: "" }, unnamed, "packages", "total").ok], [{ ok: false, error: "Fix this first, then switch: Counted quantity must be a whole number for this unit." }, false]);
let swBad = 0;
for (let q = 0; q <= 3000; q += 0.73) { const v = (Math.round(q * 100) / 100).toFixed(2); const there = sw({ quantity: v }, mlUnnamed, "total", "packages"); const back = sw(there.entry, mlUnnamed, "packages", "total"); if (!there.ok || !back.ok || Number(back.entry.quantity) !== Number(v) || val(there.entry, mlUnnamed, "packages") !== Number(v)) swBad++; }
check("switching 0–3000 mL (step 0.73) to packages and back keeps the exact total every time", swBad, 0);
check("sameCount: 17 = '17'; null = null; 0 ≠ null", [C.sameCount(17, "17"), C.sameCount(null, undefined), C.sameCount(0, null)], [true, true, false]);
}, { expectedChecks: 32 });
