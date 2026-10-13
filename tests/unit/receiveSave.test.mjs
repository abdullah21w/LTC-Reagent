// U2d-1 — Receive save path (receiveSave.js) with a recording stub of the Supabase client:
// every outcome (saved, recovered after a lost response, already saved by primary key,
// mismatch, refused, permission, not confirmed, unknown, zero rows), honest wording, and an
// activity entry written at most once per receipt. Each case uses its own receipt id.
import { randomUUID } from "node:crypto";
import { suite, check, load, readSource } from "../helpers/core.mjs";

suite("U2d-1 · Receive save path (receiveSave.js)", async () => {
const S = await load("receiveSave.js");
const entry = (over = {}) => ({ receiptId: randomUUID(), name: "  Reagent R​ ", department: "Chemistry", itemType: "Reagent", device: "Analyzer 1", lotNumber: "TR-001", unit: "bottle", quantityReceived: 12, expiryDate: "2027-06-30", receivedDate: "2026-10-13", receivedBy: "tester", lowStockThreshold: 2, unitsPerCarton: 6, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: false, receivingNotes: "note", inspectionNotes: "", ...over });

// ── the row written: exactly the columns Receive always wrote, plus the receipt id ──
const E0 = entry({ receiptId: "11111111-2222-4333-8444-555555555555" });
check("row: same columns and values as before (name cleaned, current = received), plus id", S.buildReceiptRow(E0, E0.receiptId), { id: E0.receiptId, name: "Reagent R", department: "Chemistry", item_type: "Reagent", device: "Analyzer 1", lot_number: "TR-001", unit: "bottle", quantity_received: 12, current_quantity: 12, expiry_date: "2027-06-30", date_added: "2026-10-13", added_by: "tester", low_stock_threshold: 2, units_per_carton: 6, pack_unit: null, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: false, receiving_notes: "note", inspection_notes: "" });
check("row: blank device → '', blank expiry → null, no packaging → null (as before)", (({ device, expiry_date, units_per_carton, pack_unit }) => [device, expiry_date, units_per_carton, pack_unit])(S.buildReceiptRow(entry({ device: "", expiryDate: "", unitsPerCarton: null, packUnit: "box" }), "x")), ["", null, null, null]);
check("row (U2d-2): packaged receipt stores the package name trimmed with its size; the activity text names it", [(({ units_per_carton, pack_unit }) => [units_per_carton, pack_unit])(S.buildReceiptRow(entry({ unitsPerCarton: 5, packUnit: "  Sachet " }), "x")), S.receiptDescription(S.buildReceiptRow(entry({ unitsPerCarton: 5, packUnit: "kit", quantityReceived: 17, unit: "test" }), "x"))], [[5, "Sachet"], "Reagent R — Lot TR-001 — received 17 test (5 per kit)"]);
check("an existing Lot with a different package name is not this receipt (mismatch)", S.sameReceipt(S.buildReceiptRow(entry({ unitsPerCarton: 5, packUnit: "box" }), "i"), { ...S.buildReceiptRow(entry({ unitsPerCarton: 5, packUnit: "kit" }), "i") }), false);
check("receipt ids: UUID v4 format, unique", (() => { const a = S.newReceiptId(), b = S.newReceiptId(); return [/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), a !== b]; })(), [true, true]);
check("activity text: name, Lot, quantity and unit, box size (no secrets)", [S.receiptDescription(S.buildReceiptRow(E0, "x")), S.receiptDescription(S.buildReceiptRow(entry({ unitsPerCarton: null, unit: "box", quantityReceived: 3 }), "x"))], ["Reagent R — Lot TR-001 — received 12 bottle (6 per box)", "Reagent R — Lot TR-001 — received 3 box"]);

// ── recording stub ──
function stub(sc) {
  const calls = [], audit = [];
  const client = { from(table) {
    const rec = { table, op: "select", values: null, filters: [], cols: null }; calls.push(rec);
    const b = {
      insert(v) { rec.op = "insert"; rec.values = v; return b; },
      select(c) { rec.cols = c; return b; },
      eq(f, v) { rec.filters.push([f, v]); return b; },
      then(res, rej) {
        const n = calls.filter((c) => c.op === rec.op).indexOf(rec);
        const r = rec.op === "insert" ? (Array.isArray(sc.insert) ? sc.insert[n] : sc.insert) : (Array.isArray(sc.read) ? sc.read[n] : sc.read);
        return (r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r() : r)).then(res, rej);
      },
    };
    return b;
  } };
  return { client, calls, audit, logActivity: async (...a) => { audit.push(a); return sc.audit ?? { error: null }; } };
}
const run = async (sc, e = entry(), withLog = true, s = stub(sc)) => { const r = await S.saveReceipt({ client: s.client, entry: e, logActivity: withLog ? s.logActivity : undefined }); return { r, ...s, e, inserts: s.calls.filter((c) => c.op === "insert").length, reads: s.calls.filter((c) => c.op === "select").length }; };
const rowOf = (e) => S.buildReceiptRow(e, e.receiptId);
const net = () => new TypeError("Failed to fetch");
const dup = { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "reagents_pkey"', details: "Key (id)=(…) already exists." } };

let e = entry(); let t = await run({ insert: { data: [{ id: e.receiptId }], error: null } }, e);
check("saved: one insert of the receipt row asking for the id back; activity once; no read-back", [t.r.ok, t.r.outcome, t.inserts, t.calls[0].table, t.calls[0].cols, t.calls[0].values.id === e.receiptId, t.audit.length, t.audit[0]?.slice(0, 2), t.r.auditLogged, t.reads], [true, "saved", 1, "reagents", "id", true, 1, ["receive", "reagent"], true, 0]);
t = await run({ insert: { data: null, error: { code: "23514", message: 'new row for relation "reagents" violates check constraint "reagents_pack_unit_valid"' } } });
check("constraint refusal: not ok, clear message naming the constraint, no activity, no retry", [t.r.ok, t.r.outcome, /reagents_pack_unit_valid.*Nothing was saved/.test(t.r.message), t.audit.length, t.inserts], [false, "rejected", true, 0, 1]);
t = await run({ insert: { data: null, error: { code: "23502", message: 'null value in column "department" of relation "reagents" violates not-null constraint' } } });
check("missing required value: not ok, names the column", [t.r.outcome, /\(department\)/.test(t.r.message), t.audit.length], ["rejected", true, 0]);
t = await run({ insert: { data: null, error: { code: "42501", message: 'new row violates row-level security policy for table "reagents"' } } });
check("permission / RLS refusal: not ok, permission message, no activity", [t.r.outcome, t.r.message, t.audit.length], ["rejected", "You don't have permission to receive stock, so nothing was saved. Ask the owner to check your account.", 0]);

// ── uncertain outcomes ──
t = await run({ insert: { data: null, error: { message: "TypeError: Failed to fetch", code: "" } }, read: { data: [], error: null } });
check("network failure, Lot not found (yet): not_confirmed — never 'not saved'; no activity", [t.r.ok, t.r.outcome, t.reads, t.audit.length], [false, "not_confirmed", 1, 0]);
const honest = (m) => [/same window/.test(m), /Don't start a new receipt/.test(m), /can only ever be saved once/.test(m), /\b(was not saved|not saved|failed to save|nothing was saved)\b/i.test(m)];
check("not_confirmed / unknown messages: stay in the same window, don't start a new receipt, safe to press again — and never claim the receipt failed", [honest(S.NOT_CONFIRMED_MESSAGE), honest(S.UNKNOWN_MESSAGE), /may still arrive/.test(S.NOT_CONFIRMED_MESSAGE)], [[true, true, true, false], [true, true, true, false], true]);
e = entry(); t = await run({ insert: net(), read: { data: [rowOf(e)], error: null } }, e);
check("response lost AFTER the server committed: found by id → recovered (confirmed), activity once", [t.r.ok, t.r.outcome, t.inserts, t.audit.length], [true, "recovered", 1, 1]);
t = await run({ insert: net(), read: net() });
check("network failure and the check fails too: unknown — never reported as saved or as failed", [t.r.ok, t.r.outcome, t.r.message === S.UNKNOWN_MESSAGE, t.audit.length], [false, "unknown", true, 0]);
e = entry(); t = await run({ insert: { data: [], error: null }, read: { data: [rowOf(e)], error: null } }, e);
check("zero rows returned but the Lot exists: confirmed only after reading it back", [t.r.ok, t.r.outcome, t.reads, t.audit.length], [true, "saved", 1, 1]);
t = await run({ insert: { data: [], error: null }, read: { data: [], error: null } });
check("zero rows returned and not found: not ok (never assumed saved)", [t.r.ok, t.r.outcome, t.audit.length], [false, "not_confirmed", 0]);
t = await run({ insert: { data: null, error: null }, read: { data: [], error: null } });
check("no rows array at all: not ok", [t.r.ok, t.audit.length], [false, 0]);
t = await run({ insert: { data: [{ id: "someone-else" }], error: null }, read: { data: [], error: null } });
check("a returned row with another id is not proof of this receipt", [t.r.ok, t.r.outcome], [false, "not_confirmed"]);

// ── primary-key conflict: identity + submitted fields decide ──
e = entry(); t = await run({ insert: dup, read: { data: [rowOf(e)], error: null } }, e);
check("primary key refuses a 2nd Lot; the existing Lot has this receipt id and the same values → already_saved", [t.r.ok, t.r.outcome, t.inserts], [true, "already_saved", 1]);
for (const [label, change] of [["quantity", { quantity_received: 5 }], ["Lot number", { lot_number: "TR-999" }], ["unit", { unit: "box" }], ["received by", { added_by: "someone" }], ["receipt id itself", { id: "00000000-0000-4000-8000-000000000000" }]]) {
  e = entry(); t = await run({ insert: dup, read: { data: [{ ...rowOf(e), ...change }], error: null } }, e);
  check(`existing Lot differs in ${label} → mismatch: NEVER reported as a successful receipt, no activity`, [t.r.ok, t.r.outcome, t.r.message === S.MISMATCH_MESSAGE, t.audit.length], [false, "mismatch", true, 0]);
}
t = await run({ insert: dup, read: { data: [], error: null } });
check("primary-key conflict but the Lot can't be read: unknown (not a success)", [t.r.ok, t.r.outcome], [false, "unknown"]);
t = await run({ insert: { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "something_else"' } } });
check("an unrelated unique violation is a plain refusal", [t.r.outcome, t.reads], ["rejected", 0]);

// ── activity entry at most once per receipt ──
e = entry();
const first = await run({ insert: net(), read: { data: [rowOf(e)], error: null } }, e);
const second = await run({ insert: dup, read: { data: [rowOf(e)], error: null } }, e);
const third = await run({ insert: dup, read: { data: [rowOf(e)], error: null } }, e);
check("receipt confirmed after a lost response (recovered), then confirmed again twice (already_saved): activity written ONCE", [first.r.outcome, first.audit.length, second.r.outcome, second.audit.length, second.r.auditAlreadyRecorded, third.audit.length], ["recovered", 1, "already_saved", 0, true, 0]);
e = entry();
const failA = await run({ insert: { data: [{ id: e.receiptId }], error: null }, audit: { error: { message: "insert denied" } } }, e);
const laterB = await run({ insert: dup, read: { data: [rowOf(e)], error: null } }, e);
check("activity refused after a confirmed save: ok + warning, Lot not re-inserted; it is NOT marked recorded, so a later confirmation tries again (failure never hidden)", [failA.r.ok, failA.r.auditLogged, failA.r.warning === S.AUDIT_WARNING, failA.inserts, laterB.audit.length, laterB.r.auditLogged], [true, false, true, 1, 1, true]);
{ const ee = entry(); const s = stub({ insert: { data: [{ id: ee.receiptId }], error: null } }); const r = await S.saveReceipt({ client: s.client, entry: ee, logActivity: async () => { throw new Error("down"); } }); check("activity logger throws: same honest result, one insert", [r.ok, r.auditLogged, s.calls.filter((c) => c.op === "insert").length], [true, false, 1]); }
e = entry(); t = await run({ insert: { data: [{ id: e.receiptId }], error: null } }, e, false);
check("no activity logger supplied: auditLogged null (not claimed)", [t.r.ok, t.r.auditLogged], [true, null]);
t = await run({ insert: { data: [{ id: "x" }], error: null } }, entry({ receiptId: undefined }));
check("no receipt id: nothing sent", [t.r.ok, t.inserts], [false, 0]);
check("describeReceiveError: other errors keep the database message; refusals say nothing was saved", [S.describeReceiveError({ message: "boom" }), S.describeReceiveError({ code: "22P02", message: "invalid input syntax for type numeric" }).endsWith("try again.")], ["The database refused the receipt (boom). Nothing was saved.", true]);
const recvSrc = ["receiveSave.js", "receivePlan.js", "ReceiveWizard.jsx"].map((f) => [f, readSource(f)]);
check("U2d-2 final review: the Receive path can only insert a new Lot — no update, upsert, delete or RPC anywhere in it (an existing Lot can't be changed)", recvSrc.filter(([, t]) => /\.(update|upsert|delete|rpc)\(/.test(t)).map(([f]) => f), []);
check("…and quantity_received and current_quantity come from the same value in the inserted row", (({ quantity_received, current_quantity }) => [quantity_received, current_quantity])(S.buildReceiptRow(entry({ quantityReceived: 1500.1 }), "x")), [1500.1, 1500.1]);
}, { expectedChecks: 34 });
