// Edit Lot rules (lotEdit.js): U0 (meaning of quantities, history protection),
// U2c-1 (save path: changed fields only, optimistic concurrency, honest errors)
// and U2c-2 (package name). Ported from the review suites with synthetic Lots.
import { suite, check, load, src } from "../helpers/core.mjs";

suite("U0 · U2c-1 · U2c-2 · Edit Lot rules and save path (lotEdit.js)", async () => {

const E = await load({ contents: `export * from "${src("lotEdit.js")}"; export { validatePackUnit, SUGGESTED_PACK_UNITS, PACK_UNIT_MAX_LENGTH } from "${src("units.js")}";` });

const plain = { id: "p", name: "Enzyme A", lot_number: "TA-147", unit: "box", quantity_received: 3, current_quantity: 2, low_stock_threshold: 2, units_per_carton: null, expiry_date: "2027-01-01" };
const packed = { id: "k", name: "Reagent C", lot_number: "TC-006", unit: "bottle ", quantity_received: 12, current_quantity: 9, low_stock_threshold: 2, units_per_carton: 6, expiry_date: null };
const asForm = (r, over = {}) => ({ lot_number: r.lot_number, unit: r.unit, quantity_received: String(r.quantity_received), current_quantity: String(r.current_quantity), low_stock_threshold: String(r.low_stock_threshold), expiry_date: r.expiry_date || "", ...over });
const NONE = { logs: 0, countLines: 0 }, HIST = { logs: 5, countLines: 2 }, UNKNOWN = { logs: null, countLines: null };
const P = (original, over = {}, opts = {}) => E.planLotEdit({ original, form: asForm(original, over), packagingEnabled: opts.packagingEnabled ?? (original.units_per_carton != null), unitsPerBox: opts.unitsPerBox ?? (original.units_per_carton ?? ""), packUnit: opts.packUnit, history: opts.history ?? HIST, confirmed: opts.confirmed ?? false });
const q = (p) => p.payload && [p.payload.quantity_received, p.payload.current_quantity, p.payload.low_stock_threshold, p.payload.units_per_carton, p.payload.unit];

// ═══ U0 — no change of meaning: saves exactly what was typed ═══
check("plain lot, unchanged → ok, identical numbers", [P(plain).status, q(P(plain))], ["ok", [3, 2, 2, null, "box"]]);
check("packaged lot, unchanged → ok, stored units kept (no ×6, no ÷6)", [P(packed).status, q(P(packed))], ["ok", [12, 9, 2, 6, "bottle "]]);
check("packaged lot with history: editing current quantity → ok, typed value stored as-is", q(P(packed, { current_quantity: "7" })), [12, 7, 2, 6, "bottle "]);
check("packaged lot: editing quantity received → stored as-is (no conversion)", q(P(packed, { quantity_received: "2" })), [2, 9, 2, 6, "bottle "]);
check("plain lot with history: editing quantities, threshold, expiry, lot number → ok", (() => { const p = P(plain, { current_quantity: "1", low_stock_threshold: "3", expiry_date: "2027-02-02", lot_number: "TA-148" }); return [p.status, q(p), p.payload.expiry_date, p.payload.lot_number]; })(), ["ok", [3, 1, 3, null, "box"], "2027-02-02", "TA-148"]);
check("blank expiry → null", P(plain, { expiry_date: "" }).payload.expiry_date, null);
check("unit case/space-only change is not a change of meaning (history ok)", [P(packed, { unit: "Bottle" }).status, q(P(packed, { unit: "Bottle" }))], ["ok", [12, 9, 2, 6, "Bottle"]]);
check("payload keeps id and name for the save + activity log", [P(packed).payload.id, P(packed).payload.name], ["k", "Reagent C"]);
check("unknown history does not block ordinary edits", P(packed, { current_quantity: "8" }, { history: UNKNOWN }).status, "ok");

// ── Validation ──
check("blank current quantity → invalid", P(plain, { current_quantity: "" }).status, "invalid");
check("negative received → invalid", P(plain, { quantity_received: "-1" }).status, "invalid");
check("non-number threshold → invalid", P(plain, { low_stock_threshold: "abc" }).status, "invalid");
check("blank unit → invalid", P(plain, { unit: "  " }).status, "invalid");
check("blank lot number → invalid", P(plain, { lot_number: "" }).status, "invalid");
check("packaging on, box size cleared → invalid (never silently turns packaging off)", P(packed, {}, { unitsPerBox: "" }).status, "invalid");
check("packaging on, box size 0 → invalid", P(plain, {}, { packagingEnabled: true, unitsPerBox: "0", packUnit: "carton", history: NONE }).status, "invalid");
check("packaging on, box size 2.5 → invalid", P(plain, {}, { packagingEnabled: true, unitsPerBox: "2.5", packUnit: "carton", history: NONE }).status, "invalid");
check("existing non-standard box size kept unchanged is allowed", P({ ...packed, units_per_carton: 1 }, {}, { unitsPerBox: "1" }).status, "ok");
check("invalid plan has no payload", P(plain, { current_quantity: "" }).payload, null);

// ── Enabling packaging (a package name is required since U2c-2) ──
const enable = (extra = {}) => ({ packagingEnabled: true, unitsPerBox: "6", packUnit: "carton", ...extra });
check("enable, lot WITH history → blocked", P(plain, {}, enable()).status, "blocked");
check("enable, history UNKNOWN (lookup failed / loading) → blocked", P(plain, {}, enable({ history: UNKNOWN })).status, "blocked");
check("enable, no history, not confirmed → needs_confirmation", P(plain, {}, enable({ history: NONE })).status, "needs_confirmation");
check("enable, no history, confirmed → ok, quantities NOT multiplied", q(P(plain, {}, enable({ history: NONE, confirmed: true }))), [3, 2, 2, 6, "box"]);
check("enable confirmation text states nothing is multiplied", /Nothing is multiplied/.test(P(plain, {}, enable({ history: NONE })).confirmations[0]), true);

// ── Disabling packaging ──
check("disable, lot WITH history → blocked", P(packed, {}, { packagingEnabled: false }).status, "blocked");
check("disable, no history, not confirmed → needs_confirmation", P(packed, {}, { packagingEnabled: false, history: NONE }).status, "needs_confirmation");
check("disable, no history, confirmed → ok, quantities NOT divided, units_per_carton null", q(P(packed, {}, { packagingEnabled: false, history: NONE, confirmed: true })), [12, 9, 2, null, "bottle "]);

// ── Changing box size ──
check("change box size, WITH history → blocked", P(packed, {}, { unitsPerBox: "12" }).status, "blocked");
check("change box size, WITH history, even if 'confirmed' → still blocked, no payload", (() => { const p = P(packed, {}, { unitsPerBox: "12", confirmed: true }); return [p.status, p.payload]; })(), ["blocked", null]);
check("change box size, only logs → blocked", P(packed, {}, { unitsPerBox: "12", history: { logs: 1, countLines: 0 } }).status, "blocked");
check("change box size, only Stock Count lines → blocked", P(packed, {}, { unitsPerBox: "12", history: { logs: 0, countLines: 1 } }).status, "blocked");
check("change box size, history UNKNOWN → blocked", P(packed, {}, { unitsPerBox: "12", history: UNKNOWN }).status, "blocked");
check("change box size block message names old and new size", P(packed, {}, { unitsPerBox: "12" }).blocks[0].includes("box size can't be changed from 6 to 12 bottle per box"), true);
check("change box size together with a quantity edit, WITH history → blocked (nothing saved)", P(packed, { current_quantity: "7" }, { unitsPerBox: "12", confirmed: true }).status, "blocked");
check("box size retyped as the same value (6 / '6.0') WITH history → not a change → ok", [P(packed, {}, { unitsPerBox: "6" }).status, P(packed, {}, { unitsPerBox: "6.0" }).status], ["ok", "ok"]);
check("change box size, no history, not confirmed → needs_confirmation", P(packed, {}, { unitsPerBox: "12", history: NONE }).status, "needs_confirmation");
check("change box size, no history, confirmed → ok, stored units NOT converted", q(P(packed, {}, { unitsPerBox: "12", history: NONE, confirmed: true })), [12, 9, 2, 12, "bottle "]);
check("change box size confirmation (no history) shows the new breakdown, neutral wording", P(packed, {}, { unitsPerBox: "4", history: NONE }).confirmations[0].includes("2 × 4-bottle packs + 1 bottle"), true);
check("change box size, no history, invalid new size → invalid", P(packed, {}, { unitsPerBox: "0", history: NONE }).status, "invalid");

// ── Changing the unit ──
check("unit change, WITH history → blocked", P(packed, { unit: "box" }).status, "blocked");
check("unit change, history UNKNOWN → blocked", P(plain, { unit: "bottle" }, { history: UNKNOWN }).status, "blocked");
check("unit change, no history → needs_confirmation, then ok without conversion", [P(plain, { unit: "bottle" }, { history: NONE }).status, q(P(plain, { unit: "bottle" }, { history: NONE, confirmed: true }))], ["needs_confirmation", [3, 2, 2, null, "bottle"]]);
check("history with only Stock Count lines (no logs) still blocks", P(packed, { unit: "box" }, { history: { logs: 0, countLines: 1 } }).status, "blocked");
check("history with only logs still blocks", P(plain, {}, enable({ history: { logs: 1, countLines: 0 } })).status, "blocked");
check("block message names the recorded history", P(packed, { unit: "box" }).blocks[0].includes("5 usage logs and 2 Stock Count lines"), true);
check("combined unit + enable → two blocks", P(plain, { unit: "bottle" }, enable()).blocks.length, 2);

// ── A stored value that looks wrong is never auto-repaired ──
const odd = { ...packed, id: "o", quantity_received: 2, current_quantity: 10, low_stock_threshold: 1, units_per_carton: 8 };
check("current above received (2 / 10): unchanged edit leaves 2 / 10 exactly", q(P(odd)), [2, 10, 1, 8, "bottle "]);

// ── hasHistory / describeInBoxes ──
check("hasHistory", [E.hasHistory(NONE), E.hasHistory(HIST), E.hasHistory(UNKNOWN), E.hasHistory({ logs: 0, countLines: null }), E.hasHistory(undefined)], [false, true, null, null, null]);
check("describeInBoxes without a name: neutral wording", [E.describeInBoxes(9, 6, "bottle"), E.describeInBoxes(12, 6, "bottle"), E.describeInBoxes(0, 6, "bottle"), E.describeInBoxes(1, 0, "x"), E.describeInBoxes(7.5, 5, "")], ["1 × 6-bottle pack + 3 bottles", "2 × 6-bottle packs", "0 × 6-bottle packs", null, "1 × 5-units pack + 2.5 units"]);

// ═══ U2c-1 — save path ═══
const lot = { id: "L1", name: "Reagent C", lot_number: "TC-006", unit: "bottle ", quantity_received: 12, current_quantity: 9, expiry_date: null, low_stock_threshold: 2, units_per_carton: 6 };
const payloadOf = (over) => ({ ...lot, ...over });
check("no change → nothing to write", E.buildLotUpdate(lot, payloadOf({})), { changes: {}, expected: {}, changed: [] });
check("only the changed field is written, with its original as the condition", E.buildLotUpdate(lot, payloadOf({ low_stock_threshold: 3 })), { changes: { low_stock_threshold: 3 }, expected: { low_stock_threshold: 2 }, changed: ["low_stock_threshold"] });
check("current_quantity not changed → never sent (stale window can't overwrite stock)", E.buildLotUpdate(lot, payloadOf({ expiry_date: "2027-03-01" })).changed, ["expiry_date"]);
check("numbers compared as numbers ('9' = 9, 6.0 = 6)", E.buildLotUpdate(lot, payloadOf({ current_quantity: "9", units_per_carton: 6.0 })).changed, []);
check("null ↔ value both detected; blank expiry = null", [E.buildLotUpdate(lot, payloadOf({ expiry_date: "2027-01-01" })).expected, E.buildLotUpdate({ ...lot, expiry_date: "2027-01-01" }, payloadOf({ expiry_date: null })).changes, E.buildLotUpdate(lot, payloadOf({ expiry_date: "" })).changed], [{ expiry_date: null }, { expiry_date: null }, []]);
check("packaging off: units_per_carton 6 → null, condition 6", E.buildLotUpdate(lot, payloadOf({ units_per_carton: null })), { changes: { units_per_carton: null }, expected: { units_per_carton: 6 }, changed: ["units_per_carton"] });
check("text compared exactly (a deliberate unit retype is an edit)", E.buildLotUpdate(lot, payloadOf({ unit: "bottle" })).changes, { unit: "bottle" });
check("fields outside Edit Lot (name, deleted …) are never written", E.buildLotUpdate(lot, payloadOf({ name: "X", deleted: true, current_quantity: 8 })).changed, ["current_quantity"]);
check("EDITABLE_FIELDS", E.EDITABLE_FIELDS, ["lot_number", "unit", "quantity_received", "current_quantity", "expiry_date", "low_stock_threshold", "units_per_carton", "pack_unit"]);

check("conflict message", /changed elsewhere since you opened it.*Nothing was saved/.test(E.describeSaveError({ kind: "conflict" })), true);
check("missing lot message", E.describeSaveError({ kind: "missing" }), "This lot no longer exists, so nothing was saved.");
check("database Lot guard → clear message naming the field", [E.describeSaveError({ message: "packaging_locked", details: "unit", code: "P0001" }), E.describeSaveError({ message: "packaging_locked", details: "units_per_carton" }), E.describeSaveError({ message: "packaging_locked", details: "pack_unit" })], ["This lot now has usage or Stock Count records, so its unit can't be changed. Nothing was saved.", "This lot now has usage or Stock Count records, so its box size can't be changed. Nothing was saved.", "This lot now has usage or Stock Count records, so its package name can't be changed. Nothing was saved."]);
check("other constraint violation names the constraint", E.describeSaveError({ code: "23514", message: 'new row for relation "reagents" violates check constraint "reagents_qty_check"' }), "The database refused one of the values (reagents_qty_check). Nothing was saved.");
check("pack-name constraint → its own clear message", E.describeSaveError({ code: "23514", message: 'new row for relation "reagents" violates check constraint "reagents_pack_unit_valid"' }), "The database refused the package name (it must be 1–40 characters, needs a box size, and can't be the same as the unit). Nothing was saved.");
check("network errors", [E.describeSaveError({ message: "TypeError: Failed to fetch" }), E.describeSaveError(new TypeError("Load failed"))], ["Couldn't reach the database, so nothing was saved. Check the connection and try again.", "Couldn't reach the database, so nothing was saved. Check the connection and try again."]);
check("other errors keep the database message", E.describeSaveError({ message: "permission denied for table reagents", code: "42501" }), "The database refused the change (permission denied for table reagents). Nothing was saved.");

// A recording stub of the Supabase client: no network, every call recorded.
function stub(scenario) {
  const calls = [], audit = [];
  const client = {
    from(table) {
      const rec = { table, op: null, values: null, filters: [], select: null };
      calls.push(rec);
      const b = {
        update(v) { rec.op = "update"; rec.values = v; return b; },
        eq(f, v) { rec.filters.push(["eq", f, v]); return b; },
        is(f, v) { rec.filters.push(["is", f, v]); return b; },
        select(cols) { if (!rec.op) rec.op = "select"; rec.select = cols; return b; },
        then(resolve, reject) {
          const r = rec.op === "update" ? scenario.update : scenario.lookup;
          if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
          return Promise.resolve(r).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return { client, calls, audit, logActivity: async (...a) => { audit.push(a); } };
}
const NOW = "2026-10-12T10:00:00.000Z";
const run = (scenario, over, original = lot) => { const s = stub(scenario); return E.saveLotEdit({ client: s.client, original, payload: { ...original, ...over }, username: "tester", now: NOW, logActivity: s.logActivity }).then((r) => ({ r, ...s })); };

let t = await run({ update: { data: [{ id: "L1" }], error: null } }, { low_stock_threshold: 3, expiry_date: "2027-03-01" });
check("success: one UPDATE of reagents with only the changed fields + edited_by/edited_at", [t.calls.length, t.calls[0].op, t.calls[0].values], [1, "update", { expiry_date: "2027-03-01", low_stock_threshold: 3, edited_by: "tester", edited_at: NOW }]);
check("success: conditions = id + each changed field's ORIGINAL value (null via IS NULL)", t.calls[0].filters, [["eq", "id", "L1"], ["is", "expiry_date", null], ["eq", "low_stock_threshold", 2]]);
check("success: asks for the updated rows back (to detect zero-row updates)", t.calls[0].select, "id");
check("success: result ok, activity logged exactly once AFTER the update", [t.r.ok, t.audit.length, t.audit[0]], [true, 1, ["edit", "reagent", "Reagent C — Lot TC-006"]]);
t = await run({ update: { data: [], error: null } }, {});
check("no change: no database call, no activity, reported as unchanged", [t.r, t.calls.length, t.audit.length], [{ ok: true, unchanged: true, changed: [] }, 0, 0]);
t = await run({ update: { data: null, error: { message: "packaging_locked", details: "unit", code: "P0001" } } }, { unit: "box" });
check("database guard refusal: not ok, clear message, NO activity", [t.r.ok, t.r.message, t.audit.length], [false, "This lot now has usage or Stock Count records, so its unit can't be changed. Nothing was saved.", 0]);
t = await run({ update: { data: null, error: { message: "TypeError: Failed to fetch", details: "", code: "" } } }, { current_quantity: 8 });
check("network error returned by the client: not ok, network message, NO activity", [t.r.ok, /Couldn't reach the database/.test(t.r.message), t.audit.length], [false, true, 0]);
t = await run({ update: new TypeError("Failed to fetch") }, { current_quantity: 8 });
check("network error thrown by the client: not ok, network message, NO activity", [t.r.ok, /Couldn't reach the database/.test(t.r.message), t.audit.length], [false, true, 0]);
t = await run({ update: { data: [], error: null }, lookup: { data: [{ id: "L1" }], error: null } }, { current_quantity: 8 });
check("zero rows + lot still exists → conflict (e.g. usage logged meanwhile), NO activity", [t.r.ok, /changed elsewhere/.test(t.r.message), t.audit.length, t.calls[1].op, t.calls[1].filters], [false, true, 0, "select", [["eq", "id", "L1"]]]);
t = await run({ update: { data: [], error: null }, lookup: { data: [], error: null } }, { current_quantity: 8 });
check("zero rows + lot gone → 'no longer exists', NO activity", [t.r.ok, t.r.message, t.audit.length], [false, "This lot no longer exists, so nothing was saved.", 0]);
t = await run({ update: { data: [], error: null }, lookup: new TypeError("Failed to fetch") }, { current_quantity: 8 });
check("zero rows + lookup fails → treated as conflict (never as success), NO activity", [t.r.ok, /changed elsewhere/.test(t.r.message), t.audit.length], [false, true, 0]);
t = await run({ update: { data: null, error: null } }, { current_quantity: 8 });
check("no rows array at all → not treated as success", [t.r.ok, t.audit.length], [false, 0]);
t = await run({ update: { data: [{ id: "L1" }], error: null } }, { current_quantity: 7 });
check("quantity edit: condition on the ORIGINAL current_quantity (9) — a concurrent consumption makes it miss", t.calls[0].filters, [["eq", "id", "L1"], ["eq", "current_quantity", 9]]);
check("success: auditLogged true, no warning", [t.r.auditLogged, t.r.warning], [true, undefined]);
for (const [label, logFn] of [["throws", async () => { throw new Error("audit down"); }], ["returns { error }", async () => ({ data: null, error: { message: "insert denied" } })]]) {
  const s = stub({ update: { data: [{ id: "L1" }], error: null } });
  const r = await E.saveLotEdit({ client: s.client, original: lot, payload: payloadOf({ current_quantity: 7 }), username: "u", now: NOW, logActivity: logFn });
  check(`saved but activity log ${label}: reported honestly (ok, auditLogged false, warning) and the update is NOT repeated`, [r.ok, r.auditLogged, /was saved, but it could not be recorded in the activity log/.test(r.warning || ""), s.calls.filter((c) => c.op === "update").length], [true, false, true, 1]);
}
const noLog = await (async () => { const s = stub({ update: { data: [{ id: "L1" }], error: null } }); return E.saveLotEdit({ client: s.client, original: lot, payload: payloadOf({ current_quantity: 7 }), username: "u", now: NOW }); })();
check("no logActivity supplied → auditLogged null (not claimed)", [noLog.ok, noLog.auditLogged], [true, null]);

// ═══ U2c-2 — package name ═══
const plainB = { id: "pb", name: "Saline B", lot_number: "TB-1", unit: "bottle", quantity_received: 9, current_quantity: 9, low_stock_threshold: 2, units_per_carton: null, pack_unit: null, expiry_date: null };
const legacy = { id: "lg", name: "Reagent C", lot_number: "TC-007", unit: "bottle ", quantity_received: 12, current_quantity: 9, low_stock_threshold: 2, units_per_carton: 6, pack_unit: null, expiry_date: null };
const named = { ...legacy, id: "nm", lot_number: "TC-008", pack_unit: "box" };
const frac = { ...legacy, id: "fr", lot_number: "TC-009", units_per_carton: 2.5 };
const P2 = (original, over = {}, o = {}) => E.planLotEdit({ original, form: asForm(original, over), packagingEnabled: o.on ?? (original.units_per_carton != null), unitsPerBox: o.per ?? (original.units_per_carton ?? ""), packUnit: "pack" in o ? o.pack : (original.pack_unit ?? ""), history: o.history ?? HIST, confirmed: o.confirmed ?? false });
const qty = (p) => p.payload && [p.payload.quantity_received, p.payload.current_quantity, p.payload.low_stock_threshold];
const pk = (p) => p.payload && [p.payload.units_per_carton, p.payload.pack_unit];
const errs = (p) => p.errors.join(" | ");

check("validatePackUnit: 40 ok, 41 too_long, trimmed length counts, measured refused, same-as-base (incl. plural) refused", [E.validatePackUnit("x".repeat(40), "bottle").ok, E.validatePackUnit("x".repeat(41), "bottle").reason, E.validatePackUnit("  " + "x".repeat(40) + "  ", "bottle").ok, E.validatePackUnit("mL", "bottle").reason, E.validatePackUnit("Bottles", "bottle ").reason, E.validatePackUnit("box", "bottle").reason], [true, "too_long", true, "measured_unit", "same_as_base_unit", null]);
check("no packaging: unrelated edit ok, pack_unit stays null and is not written", (() => { const p = P2(plainB, { low_stock_threshold: "3" }, { history: NONE }); return [p.status, pk(p), E.buildLotUpdate(plainB, p.payload).changed]; })(), ["ok", [null, null], ["low_stock_threshold"]]);
check("enable without a name → invalid ('Choose a package name')", (() => { const p = P2(plainB, {}, { on: true, per: "6", pack: "", history: NONE }); return [p.status, /Choose a package name/.test(errs(p)), p.payload]; })(), ["invalid", true, null]);
check("enable with whitespace-only name → invalid", P2(plainB, {}, { on: true, per: "6", pack: "   ", history: NONE }).status, "invalid");
check("enable with preset 'box' → needs_confirmation; '1 box = 6 bottles', nothing multiplied", (() => { const p = P2(plainB, {}, { on: true, per: "6", pack: "box", history: NONE }); return [p.status, /Packaging is turned on: 1 box = 6 bottles\. Nothing is multiplied/.test(p.confirmations[0]), /\(1 box \+ 3 bottles\)/.test(p.confirmations[0]), /not in boxes/.test(p.confirmations[0])]; })(), ["needs_confirmation", true, true, true]);
check("enable with preset, confirmed → ok; units_per_carton 6, pack_unit 'box'; quantities exactly as typed", (() => { const p = P2(plainB, {}, { on: true, per: "6", pack: "box", history: NONE, confirmed: true }); return [p.status, pk(p), qty(p)]; })(), ["ok", [6, "box"], [9, 9, 2]]);
check("enable: written fields are units_per_carton + pack_unit, conditions both IS NULL", E.buildLotUpdate(plainB, P2(plainB, {}, { on: true, per: "6", pack: "box", history: NONE, confirmed: true }).payload), { changes: { units_per_carton: 6, pack_unit: "box" }, expected: { units_per_carton: null, pack_unit: null }, changed: ["units_per_carton", "pack_unit"] });
check("custom name is trimmed, spelling kept ('  Sachet ' → 'Sachet')", pk(P2(plainB, {}, { on: true, per: "10", pack: "  Sachet ", history: NONE, confirmed: true })), [10, "Sachet"]);
check("custom name of exactly 40 chars accepted; 41 refused with a clear message", [P2(plainB, {}, { on: true, per: "6", pack: "a".repeat(40), history: NONE, confirmed: true }).status, errs(P2(plainB, {}, { on: true, per: "6", pack: "a".repeat(41), history: NONE }))], ["ok", "The package name can be at most 40 characters."]);
check("measured name refused ('mL')", errs(P2(plainB, {}, { on: true, per: "6", pack: "mL", history: NONE })), '"mL" is a measurement, not a package. Choose a package name such as Box.');
check("name equal to the unit refused ('Bottles' for bottle; 'box' for a box lot)", [P2(plainB, {}, { on: true, per: "6", pack: "Bottles", history: NONE }).status, /can't be the same as the unit inside it \("bottle"\)/.test(errs(P2(plainB, {}, { on: true, per: "6", pack: "Bottles", history: NONE }))), P2({ ...plainB, unit: "box" }, {}, { on: true, per: "6", pack: "box", history: NONE }).status], ["invalid", true, "invalid"]);
for (const bad of ["0", "-2", "2.5", "abc", ""]) check(`enable with box size ${JSON.stringify(bad)} → invalid (whole number ≥ 1 required)`, [P2(plainB, {}, { on: true, per: bad, pack: "box", history: NONE }).status, /a whole number of 1 or more/.test(errs(P2(plainB, {}, { on: true, per: bad, pack: "box", history: NONE })))], ["invalid", true]);
check("box-size error names the package ('in each kit')", /in each kit \(a whole number/.test(errs(P2(plainB, {}, { on: true, per: "0", pack: "kit", history: NONE }))), true);
check("enable with a name on a lot with history → blocked, no payload (even if confirmed)", (() => { const p = P2(plainB, {}, { on: true, per: "6", pack: "box", confirmed: true }); return [p.status, p.payload]; })(), ["blocked", null]);
check("adding a first name to a legacy packaged lot with history → blocked (D3, NULL → value)", (() => { const p = P2(legacy, {}, { pack: "box", confirmed: true }); return [p.status, /so a package name can't be added now/.test(p.blocks.join(" ")), p.payload]; })(), ["blocked", true, null]);
check("renaming the package on a lot with history → blocked, message names old and new", (() => { const p = P2(named, {}, { pack: "carton" }); return [p.status, p.blocks.join(" ").includes('package name can\'t be changed from "box" to "carton"')]; })(), ["blocked", true]);
check("history UNKNOWN → package name change blocked", [P2(legacy, {}, { pack: "box", history: UNKNOWN }).status, P2(named, {}, { pack: "kit", history: UNKNOWN }).status], ["blocked", "blocked"]);
check("only logs / only Stock Count lines → still blocked", [P2(legacy, {}, { pack: "box", history: { logs: 1, countLines: 0 } }).status, P2(legacy, {}, { pack: "box", history: { logs: 0, countLines: 1 } }).status], ["blocked", "blocked"]);
check("disabling packaging of a named lot with history → blocked", P2(named, {}, { on: false }).status, "blocked");
check("lot with history: unrelated edit ok; packaging values kept and NOT written", (() => { const p = P2(named, { current_quantity: "7" }); return [p.status, pk(p), qty(p), E.buildLotUpdate(named, p.payload).changed]; })(), ["ok", [6, "box"], [12, 7, 2], ["current_quantity"]]);
check("packUnit omitted by the caller → saved name kept", pk(E.planLotEdit({ original: named, form: asForm(named), packagingEnabled: true, unitsPerBox: "6", history: HIST })), [6, "box"]);
check("legacy lot, no history: add a name → confirmation; then only pack_unit written (condition IS NULL)", (() => { const a = P2(legacy, {}, { pack: "box", history: NONE }); const b = P2(legacy, {}, { pack: "box", history: NONE, confirmed: true }); return [a.status, /The package name is set to "box" \(1 box = 6 bottles\)\. Nothing is converted/.test(a.confirmations[0]), E.buildLotUpdate(legacy, b.payload), qty(b)]; })(), ["needs_confirmation", true, { changes: { pack_unit: "box" }, expected: { pack_unit: null }, changed: ["pack_unit"] }, [12, 9, 2]]);
check("named lot, no history: rename box → carton; condition on the old name", (() => { const a = P2(named, {}, { pack: "carton", history: NONE }); const b = P2(named, {}, { pack: "carton", history: NONE, confirmed: true }); return [a.confirmations[0].startsWith('The package name changes from "box" to "carton" (1 carton = 6 bottles)'), E.buildLotUpdate(named, b.payload)]; })(), [true, { changes: { pack_unit: "carton" }, expected: { pack_unit: "box" }, changed: ["pack_unit"] }]);
check("named lot: clearing the name while packaging stays on → invalid", P2(named, {}, { pack: "", history: NONE }).status, "invalid");
check("named lot, no history: disable → confirmation, then pack_unit AND units_per_carton cleared together", (() => { const a = P2(named, {}, { on: false, history: NONE }); const b = P2(named, {}, { on: false, history: NONE, confirmed: true }); return [a.status, /Nothing is divided/.test(a.confirmations.join(" ")), E.buildLotUpdate(named, b.payload), qty(b)]; })(), ["needs_confirmation", true, { changes: { units_per_carton: null, pack_unit: null }, expected: { units_per_carton: 6, pack_unit: "box" }, changed: ["units_per_carton", "pack_unit"] }, [12, 9, 2]]);
check("disable: a typed name is ignored (packaging off always means no name)", pk(P2(named, {}, { on: false, pack: "carton", history: NONE, confirmed: true })), [null, null]);
check("box size and name changed together (no history) → both confirmations, both written", (() => { const p = P2(named, {}, { per: "4", pack: "kit", history: NONE, confirmed: true }); return [p.confirmations.length, E.buildLotUpdate(named, p.payload).changed]; })(), [2, ["units_per_carton", "pack_unit"]]);
check("unit changed (no history) to the saved package name → invalid (the database would refuse it too)", P2(named, { unit: "box" }, { history: NONE }).status, "invalid");
check("case-only rename ('box' → 'Box') counts as a change (never silently written)", P2(named, {}, { pack: "Box", history: NONE }).status, "needs_confirmation");
check("legacy fractional box size (2.5), no name: unrelated edit ok, 2.5 kept and not written", (() => { const p = P2(frac, { low_stock_threshold: "1" }); return [p.status, pk(p), E.buildLotUpdate(frac, p.payload).changed]; })(), ["ok", [2.5, null], ["low_stock_threshold"]]);
check("legacy fractional box size: adding a name → invalid ('isn't a whole number … first')", (() => { const p = P2(frac, {}, { pack: "box", history: NONE }); return [p.status, /box size \(2\.5\) isn't a whole number, so a package name can't be set/.test(errs(p))]; })(), ["invalid", true]);
check("legacy fractional box size: fixing the size to 3 and naming it (no history) → allowed with confirmation", P2(frac, {}, { per: "3", pack: "box", history: NONE }).status, "needs_confirmation");
const oddName = { ...legacy, id: "on", lot_number: "TC-010", pack_unit: "ml" };
check("legacy name that fails the new UI rule ('ml'): unrelated edit ok, name kept and not written", (() => { const p = P2(oddName, { expiry_date: "2027-05-01" }); return [p.status, pk(p), E.buildLotUpdate(oddName, p.payload).changed]; })(), ["ok", [6, "ml"], ["expiry_date"]]);
const spaced = { ...legacy, id: "sp", lot_number: "TC-011", pack_unit: " Box " };
check("legacy name with stray spaces: unchanged → kept exactly (no silent trim write)", (() => { const p = P2(spaced, { current_quantity: "8" }); return [p.status, pk(p), E.buildLotUpdate(spaced, p.payload).changed]; })(), ["ok", [6, " Box "], ["current_quantity"]]);
check("describeInBoxes with a package name", [E.describeInBoxes(9, 6, "bottle", "box"), E.describeInBoxes(12, 6, "bottle", "carton"), E.describeInBoxes(7, 6, "bottle", "Sachet"), E.describeInBoxes(14, 6, "vial", "kit"), E.describeInBoxes(5, 6, "bottle", "box")], ["1 box + 3 bottles", "2 cartons", "1 Sachet + 1 bottle", "2 kits + 2 vials", "0 boxes + 5 bottles"]);
check("packNameProblem", [E.packNameProblem("box", "bottle"), E.packNameProblem("", "bottle") !== null], [null, true]);
{
  const p = P2(legacy, {}, { pack: "box", history: NONE, confirmed: true });
  const s = stub({ update: { data: [{ id: "lg" }], error: null } });
  const r = await E.saveLotEdit({ client: s.client, original: legacy, payload: p.payload, username: "u", now: "T" });
  check("save: one UPDATE writing only pack_unit, condition pack_unit IS NULL", [r.ok, s.calls.length, s.calls[0].values, s.calls[0].filters], [true, 1, { pack_unit: "box", edited_by: "u", edited_at: "T" }, [["eq", "id", "lg"], ["is", "pack_unit", null]]]);
}
{
  const p = P2(named, {}, { on: false, history: NONE, confirmed: true });
  const s = stub({ update: { data: [{ id: "nm" }], error: null } });
  await E.saveLotEdit({ client: s.client, original: named, payload: p.payload, username: "u", now: "T" });
  check("save disable: both cleared, conditions on both original values", [s.calls[0].values, s.calls[0].filters], [{ units_per_carton: null, pack_unit: null, edited_by: "u", edited_at: "T" }, [["eq", "id", "nm"], ["eq", "units_per_carton", 6], ["eq", "pack_unit", "box"]]]);
}
{
  const p = P2(legacy, {}, { pack: "box", history: NONE, confirmed: true });
  const s = stub({ update: { data: null, error: { message: "packaging_locked", details: "pack_unit", code: "P0001" } } });
  const r = await E.saveLotEdit({ client: s.client, original: legacy, payload: p.payload, username: "u", now: "T", logActivity: async () => { throw new Error("must not log"); } });
  check("save refused by the DB guard (history appeared meanwhile) → not ok, package-name message, no activity", [r.ok, r.message, r.auditLogged], [false, "This lot now has usage or Stock Count records, so its package name can't be changed. Nothing was saved.", undefined]);
}
}, { expectedChecks: 125 });
