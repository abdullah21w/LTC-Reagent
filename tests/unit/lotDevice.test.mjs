// Edit Lot — giving a device to a lot recorded WITHOUT one (lotEdit.js). Only from
// the lot's own department's device list; a device already set is never changed
// (moving lots between devices is not part of this), a lot active on a device is
// never touched, nothing else about the lot changes, the write is conditional on
// the device still being blank, and the activity log says what was set.
// Plus: after the device is set, the reagent appears as ONE group (forecast.js).
import { suite, check, load, src } from "../helpers/core.mjs";

const E = await load({ contents: `export * from "${src("lotEdit.js")}"; export { buildGroups } from "${src("forecast.js")}";` });

suite("Edit Lot · set the device of a lot recorded without one", async () => {
const DEVICES = [{ name: "VITROS", department: "Chemistry" }, { name: "SYSMEX", department: "Chemistry" }, { name: "RUBY", department: "Hematology" }];
const blank = { id: "A3826", name: "ERF", department: "Chemistry", device: "", item_type: "Reagent", lot_number: "A3826", unit: "BOX", quantity_received: 2, current_quantity: 2, low_stock_threshold: 2, units_per_carton: null, pack_unit: null, expiry_date: "2028-03-09", active_on_device: false, date_added: "2026-09-22" };
const onVitros = { ...blank, id: "L3470", lot_number: "L3470", device: "VITROS", item_type: "Other", quantity_received: 3, current_quantity: 0, low_stock_threshold: 1, expiry_date: "2027-09-08", date_added: "2026-07-15" };
const form = (r, over = {}) => ({ lot_number: r.lot_number, unit: r.unit, quantity_received: String(r.quantity_received), current_quantity: String(r.current_quantity), expiry_date: r.expiry_date || "", low_stock_threshold: String(r.low_stock_threshold), device: r.device, ...over });
const plan = (r, over, devices = DEVICES) => E.planLotEdit({ original: r, form: form(r, over), packagingEnabled: false, history: { logs: 0, countLines: 0 }, devices });

// ── planning ──
const ok = plan(blank, { device: "VITROS" });
check("blank device → a device of the lot's department: ok; the only change written is the device", [ok.status, E.buildLotUpdate(blank, ok.payload).changes], ["ok", { device: "VITROS" }]);
check("…quantities, dates, unit, threshold and lot number are exactly as before", [ok.payload.quantity_received, ok.payload.current_quantity, ok.payload.expiry_date, ok.payload.unit, ok.payload.low_stock_threshold, ok.payload.lot_number, ok.payload.date_added, ok.payload.active_on_device], [2, 2, "2028-03-09", "BOX", 2, "A3826", "2026-09-22", false]);
check("a device of ANOTHER department, or one not in the list, is refused", [plan(blank, { device: "RUBY" }).status, plan(blank, { device: "Vitros" }).status, plan(blank, { device: "VITROS" }, []).status, plan(blank, { device: "RUBY" }).errors[0]],
  ["invalid", "invalid", "invalid", `"RUBY" isn't a device of the Chemistry department. Choose one from the list.`]);
check("a lot that already has a device can't be moved to another, or cleared", [plan(onVitros, { device: "SYSMEX" }).status, plan(onVitros, { device: "" }).status, plan(onVitros, { device: "SYSMEX" }).errors[0]],
  ["invalid", "invalid", "This lot is already on VITROS. Moving a lot to another device isn't available here."]);
check("a lot marked active on a device is never given a device here", plan({ ...blank, active_on_device: true }, { device: "VITROS" }).errors, ["This lot is marked active on a device, so its device can't be set here."]);
check("leaving the device as it is (blank or set) changes nothing about it — no device field in the update", [E.buildLotUpdate(blank, plan(blank, {}).payload).changed, E.buildLotUpdate(onVitros, plan(onVitros, { current_quantity: "0" }).payload).changed, plan(blank, { low_stock_threshold: "3" }).payload.device], [[], [], ""]);
check("device together with another field: both written, nothing else", E.buildLotUpdate(blank, plan(blank, { device: "VITROS", low_stock_threshold: "3" }).payload).changes, { low_stock_threshold: 3, device: "VITROS" });

// ── saving (recording stub: no network) ──
function stub(update) {
  const calls = [], audit = [];
  const client = { from(table) {
    const rec = { table, op: null, values: null, filters: [] }; calls.push(rec);
    const b = { update(v) { rec.op = "update"; rec.values = v; return b; }, eq(f, v) { rec.filters.push(["eq", f, v]); return b; }, is(f, v) { rec.filters.push(["is", f, v]); return b; },
      select() { if (!rec.op) rec.op = "select"; return b; }, then(res) { return Promise.resolve(rec.op === "update" ? update : { data: [{ id: blank.id }], error: null }).then(res); } };
    return b;
  } };
  return { client, calls, audit, logActivity: async (...a) => { audit.push(a); } };
}
const NOW = "2026-10-17T09:00:00.000Z";
let s = stub({ data: [{ id: blank.id }], error: null });
let r = await E.saveLotEdit({ client: s.client, original: blank, payload: ok.payload, username: "tester", now: NOW, logActivity: s.logActivity });
check("save: ONE update writing only device + edited_by / edited_at", [r.ok, s.calls.length, s.calls[0].values], [true, 1, { device: "VITROS", edited_by: "tester", edited_at: NOW }]);
check("save: only if the device is STILL blank (concurrent edits can't both set it)", s.calls[0].filters, [["eq", "id", "A3826"], ["eq", "device", ""]]);
check("activity log: says which device was set, once, after the update", s.audit, [["edit", "reagent", "ERF — Lot A3826: device set to VITROS (was none)"]]);
s = stub({ data: [], error: null });
r = await E.saveLotEdit({ client: s.client, original: blank, payload: ok.payload, username: "tester", now: NOW, logActivity: s.logActivity });
check("someone set the device meanwhile (update matches no row): conflict, nothing logged", [r.ok, /changed elsewhere/.test(r.message), s.audit.length], [false, true, 0]);
for (const [label, original, payload] of [["move", onVitros, { ...onVitros, device: "SYSMEX" }], ["clear", onVitros, { ...onVitros, device: "" }]]) {
  s = stub({ data: [{ id: original.id }], error: null });
  r = await E.saveLotEdit({ client: s.client, original, payload, username: "tester", now: NOW, logActivity: s.logActivity });
  check(`save path refuses on its own (even without planning) to ${label} an existing device: nothing sent`, [r.ok, s.calls.length, r.message], [false, 0, "Only a lot without a device can be given one here, so nothing was saved."]);
}
check("an edit that doesn't touch the device logs as before (no device note)", await (async () => { const t = stub({ data: [{ id: blank.id }], error: null }); await E.saveLotEdit({ client: t.client, original: blank, payload: plan(blank, { low_stock_threshold: "3" }).payload, username: "u", now: NOW, logActivity: t.logActivity }); return t.audit[0][2]; })(), "ERF — Lot A3826");

// ── the reagent list: ERF once after the device is set ──
const env = { snoozes: [], warnDays: 30, today: "2026-10-17", compareLots: (a, b) => (a.expiry_date < b.expiry_date ? -1 : 1), daysBetween: (a, b) => (new Date(a) - new Date(b)) / 86400000, hasInspectionIssue: () => false, isExpiringSoonItem: () => false };
const before = E.buildGroups([onVitros, blank], [], env), after = E.buildGroups([onVitros, { ...blank, device: "VITROS" }], [], env);
check("before: ERF shows twice (one group per device value)", before.map((g) => g.key).sort(), ["ERF::", "ERF::VITROS"]);
check("after setting the device: ERF is ONE group with both lots in FEFO order and the total of both", [after.length, after[0].key, after[0].items.map((i) => i.lot_number), after[0].totalQty], [1, "ERF::VITROS", ["L3470", "A3826"], 2]);
}, { expectedChecks: 16 });
