// Receive — an explicit decision for the device and the expiry date (receivePlan.js,
// receiveSave.js; database: MIGRATE_RECEIPT_CHOICES.sql). No default; a device
// must be one of the department's; a date must be a real date; the save path
// refuses before sending anything when a choice is missing or contradicts the
// data, and the choices are part of the receipt's identity on a retry.
// Edit Lot keeps a Lot's recorded choices consistent with its data.
import { suite, check, load, src } from "../helpers/core.mjs";

const M = await load({ contents: `export * from "${src("receivePlan.js")}"; export * as S from "${src("receiveSave.js")}"; export * as E from "${src("lotEdit.js")}";` });
const { S, E } = M;

suite("Receive · explicit device and expiry choice", async () => {
const DEV = [{ name: "VITROS", department: "Chemistry" }, { name: "RUBY", department: "Hematology" }];
const plan = (f) => M.planChoices({ department: "Chemistry", device: "", expiryDate: "", deviceChoice: "", expiryChoice: "", ...f }, DEV);

// ── planning ──
check("no choice made (the default): invalid, both reasons given", plan({}).errors, ['Device: choose a device from the list, or "No device recorded".', 'Expiry: enter the expiry date, or choose "No expiry date".']);
check("device + date: ok, values exactly as chosen", plan({ deviceChoice: "device", device: "VITROS", expiryChoice: "date", expiryDate: "2027-06-30" }), { status: "ok", errors: [], value: { device: "VITROS", device_choice: "device", expiry_date: "2027-06-30", expiry_choice: "date" } });
check("No device recorded + No expiry date: ok — stored as '' / null WITH the choice 'none'", plan({ deviceChoice: "none", device: "VITROS", expiryChoice: "none", expiryDate: "2027-06-30" }).value, { device: "", device_choice: "none", expiry_date: null, expiry_choice: "none" });
check("'Select a device' needs an actual device of THIS department (none picked / another department's / typed name refused)", [plan({ deviceChoice: "device", expiryChoice: "none" }).errors, plan({ deviceChoice: "device", device: "RUBY", expiryChoice: "none" }).status, plan({ deviceChoice: "device", device: "vitros", expiryChoice: "none" }).status],
  [["Device: choose which device (from the Chemistry list)."], "invalid", "invalid"]);
check("a department without devices: only 'No device recorded' is possible, and it says so", M.planChoices({ department: "Store", deviceChoice: "device", device: "", expiryChoice: "none" }, DEV).errors, ['The Store department has no devices in Settings — choose "No device recorded".']);
check("'Enter the expiry date' needs a real date (blank, impossible or malformed refused)", ["", "2027-02-30", "30/06/2027", "2027-6-30"].map((d) => plan({ deviceChoice: "none", expiryChoice: "date", expiryDate: d }).errors), Array(4).fill(["Expiry: enter the expiry date."]));
check("an unknown choice value is not a choice", [plan({ deviceChoice: "maybe", expiryChoice: "none" }).status, plan({ deviceChoice: "none", expiryChoice: "later" }).status], ["invalid", "invalid"]);

// ── the same rule on the row (what the database checks) ──
const row = (o) => ({ device: "VITROS", device_choice: "device", expiry_date: "2027-06-30", expiry_choice: "date", ...o });
check("row rule: consistent rows pass; missing / contradicting choices are named", [M.receiptChoicesProblem(row()), M.receiptChoicesProblem(row({ device: "", device_choice: "none", expiry_date: null, expiry_choice: "none" })),
  M.receiptChoicesProblem(row({ device_choice: null })), M.receiptChoicesProblem(row({ device_choice: "none" })), M.receiptChoicesProblem(row({ device: "", device_choice: "device" })),
  M.receiptChoicesProblem(row({ expiry_choice: "none" })), M.receiptChoicesProblem(row({ expiry_date: null })), M.receiptChoicesProblem(row({ expiry_date: "2027-13-01" }))],
  [null, null, "missing_choice", "device_mismatch", "device_mismatch", "expiry_mismatch", "expiry_mismatch", "expiry_mismatch"]);

// ── save path ──
const entry = (o = {}) => ({ receiptId: "11111111-2222-4333-8444-555555555555", name: "ERF", department: "Chemistry", itemType: "Reagent", device: "VITROS", deviceChoice: "device", lotNumber: "A1", unit: "box", quantityReceived: 2, expiryDate: "2027-06-30", expiryChoice: "date", receivedDate: "2026-10-17", receivedBy: "tester", lowStockThreshold: 1, ...o });
check("the row carries both choices next to the values", (({ device, device_choice, expiry_date, expiry_choice }) => [device, device_choice, expiry_date, expiry_choice])(S.buildReceiptRow(entry({ device: "", deviceChoice: "none", expiryDate: "", expiryChoice: "none" }), "x")), ["", "none", null, "none"]);
const sent = [];
const client = { from() { return { insert(r) { sent.push(r); return { select: async () => ({ data: [{ id: r.id }], error: null }) }; }, select() { return { eq: async () => ({ data: [], error: null }) }; } }; } };
const refused = [];
for (const o of [{ deviceChoice: undefined }, { expiryChoice: "" }, { deviceChoice: "none" }, { device: "", deviceChoice: "device" }, { expiryChoice: "none" }, { expiryDate: "", expiryChoice: "date" }]) {
  const r = await S.saveReceipt({ client, entry: entry(o) });
  refused.push([r.ok, r.outcome, r.message === S.CHOICES_MESSAGE]);
}
check("save path: missing or contradicting choice → refused BEFORE anything is sent (6 cases), with the clear message", [refused, sent.length], [Array(6).fill([false, "rejected", true]), 0]);
const ok = await S.saveReceipt({ client, entry: entry() });
check("…a complete receipt is sent once, with its choices", [ok.ok, sent.length, sent[0]?.device_choice, sent[0]?.expiry_choice], [true, 1, "device", "date"]);
const r0 = S.buildReceiptRow(entry(), "id1");
check("retry identity: an existing Lot with the same id but other choices is NOT this receipt (mismatch, never a success)", [S.sameReceipt(r0, { ...r0 }), S.sameReceipt(r0, { ...r0, expiry_choice: "none", expiry_date: null }), S.sameReceipt(r0, { ...r0, device_choice: null })], [true, false, false]);
check("the database's refusal of a receipt without choices gets the same clear message", S.describeReceiveError({ code: "23514", message: 'new row for relation "reagents" violates check constraint "reagents_receipt_choices"' }), S.CHOICES_MESSAGE);

// ── Edit Lot keeps the recorded choices consistent ──
const DEVICES = [{ name: "VITROS", department: "Chemistry" }];
const lot = (o) => ({ id: "L", name: "ERF", department: "Chemistry", device: "", device_choice: "none", lot_number: "A1", unit: "box", quantity_received: 2, current_quantity: 2, low_stock_threshold: 1, units_per_carton: null, pack_unit: null, expiry_date: "2027-06-30", expiry_choice: "date", active_on_device: false, ...o });
const form = (r, o = {}) => ({ lot_number: r.lot_number, unit: r.unit, quantity_received: String(r.quantity_received), current_quantity: String(r.current_quantity), expiry_date: r.expiry_date || "", low_stock_threshold: String(r.low_stock_threshold), device: r.device, expiry_choice: r.expiry_choice, ...o });
const P = (r, o) => E.planLotEdit({ original: r, form: form(r, o), packagingEnabled: false, history: { logs: 0, countLines: 0 }, devices: DEVICES });
const ch = (r, o) => { const p = P(r, o); return p.status === "ok" ? E.buildLotUpdate(r, p.payload).changes : p.errors; };
check("'No device recorded' lot given a device: the device AND device_choice 'device' are written together", ch(lot(), { device: "VITROS" }), { device: "VITROS", device_choice: "device" });
check("legacy lot (no choices recorded) given a device: only the device — it stays a legacy lot", ch(lot({ device_choice: null, expiry_choice: null }), { device: "VITROS" }), { device: "VITROS" });
check("explicit expiry: clearing the date alone is refused — 'No expiry date' must be chosen", ch(lot(), { expiry_date: "" }), ['Expiry: enter the expiry date, or choose "No expiry date".']);
check("explicit expiry: choosing 'No expiry date' writes expiry_choice 'none' and clears the date; choosing a date back writes both", [ch(lot(), { expiry_choice: "none" }), ch(lot({ expiry_date: null, expiry_choice: "none" }), { expiry_choice: "date", expiry_date: "2028-01-31" })],
  [{ expiry_date: null, expiry_choice: "none" }, { expiry_date: "2028-01-31", expiry_choice: "date" }]);
check("legacy lot: the expiry date can still be cleared as before (no choice recorded)", ch(lot({ device_choice: null, expiry_choice: null }), { expiry_date: "" }), { expiry_date: null });
const stub = () => { const calls = []; return { calls, client: { from() { const rec = { filters: [] }; calls.push(rec); const b = { update(v) { rec.values = v; return b; }, eq(f, v) { rec.filters.push([f, v]); return b; }, is(f, v) { rec.filters.push([f, null]); return b; }, select() { return b; }, then(res) { return Promise.resolve({ data: [{ id: "L" }], error: null }).then(res); } }; return b; } } }; };
const save = async (original, payload) => { const s = stub(); const r = await E.saveLotEdit({ client: s.client, original, payload, username: "u", now: "T", logActivity: async () => {} }); return [r.ok, s.calls.length]; };
check("save path refuses on its own: device without device_choice on a 'none' lot, a choice on a legacy lot, an unknown choice — nothing sent", [
  await save(lot(), { ...lot(), device: "VITROS" }), await save(lot({ expiry_choice: null, device_choice: null }), { ...lot({ expiry_choice: null, device_choice: null }), expiry_choice: "none", expiry_date: null }),
  await save(lot(), { ...lot(), expiry_choice: "later" })], [[false, 0], [false, 0], [false, 0]]);
const s2 = stub();
await E.saveLotEdit({ client: s2.client, original: lot(), payload: P(lot(), { device: "VITROS" }).payload, username: "u", now: "T", logActivity: async () => {} });
check("…the allowed change is conditional on the recorded choice and the blank device (concurrency)", s2.calls[0].filters, [["id", "L"], ["device", ""], ["device_choice", "none"]]);
});
