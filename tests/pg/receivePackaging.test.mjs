// U2d-2 — packaged / unit-safe Receive on real PostgreSQL (post-Gate-A3 schema, anon role):
// values come from receivePlan.planReceipt and are saved through receiveSave.saveReceipt
// (the U2d-1 path). Exact saved columns, measured decimals, threshold 0, custom names, the
// pack-name constraint when the UI is bypassed, the read-only duplicate lookup, existing Lots
// never changed, U2d-1 idempotency with packaging, and Stock Count snapshots of the new name.
import { randomUUID } from "node:crypto";
import { suite, check, load, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, pgClient, inTx } from "../helpers/pg.mjs";
import { seed, IDS } from "../fixtures/pgSeed.mjs";

const P = await load("receivePlan.js");
const S = await load("receiveSave.js");
const base = { name: "Reagent R", department: "Chemistry", itemType: "Reagent", device: "Analyzer 1", deviceChoice: "device", expiryDate: "2027-06-30", expiryChoice: "date", receivedDate: "2026-10-13", receivedBy: "tester", intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, receivingNotes: "", inspectionNotes: "" };
// What the Receive window sends: the plan's values (exactly as ReceiveWizard.finish does).
const entryFrom = (form, over = {}) => {
  const r = P.planReceipt({ packaged: false, quantity: "", packUnit: "", unitsPerPackage: "", packages: "", loose: "", lowStock: "", ...form }, 5);
  if (r.status !== "ok") throw new Error(r.errors.join("; "));
  const v = r.value;
  return { ...base, receiptId: randomUUID(), lotNumber: "TP-001", unit: v.unit, quantityReceived: v.total, unitsPerCarton: v.packaged ? v.perPackage : null, packUnit: v.packaged ? v.packUnit : null, lowStockThreshold: v.lowStock, ...over };
};
function lostAfterCommit(base) {
  return { from(t) { const b = base.from(t); let op = "select"; const w = { insert(v) { op = "insert"; b.insert(v); return w; }, select(c) { b.select(c); return w; }, eq(f, v) { b.eq(f, v); return w; }, then(res, rej) { return (op === "insert" ? b.then((r) => (r.error ? r : Promise.reject(new TypeError("Failed to fetch")))) : b.then((r) => r)).then(res, rej); } }; return w; } };
}

for (const version of PG_VERSIONS) suite(`U2d-2 · packaged Receive on PostgreSQL (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query(readRoot("MIGRATE_RECEIPT_CHOICES.sql")); // Receive now stores the device / expiry choices
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    check("database is in the post-Gate-A3 state", (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows.find((r) => r.ord == 99).result, "PASS");
    const anon = await server.connect(db); await anon.query("set role anon");
    const anon2 = await server.connect(db); await anon2.query("set role anon");
    const client = pgClient(anon);
    const log = async (action, entity, description) => { try { await anon.query("insert into audit_log (action, entity, description, performed_by) values ($1, $2, $3, 'tester')", [action, entity, description]); return { error: null }; } catch (e) { return { error: { message: e.message } }; } };
    const row = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows[0];
    const cols = (r) => r && { unit: r.unit, quantity_received: Number(r.quantity_received), current_quantity: Number(r.current_quantity), units_per_carton: r.units_per_carton === null ? null : Number(r.units_per_carton), pack_unit: r.pack_unit, low_stock_threshold: Number(r.low_stock_threshold) };
    const ids0 = (await c.query("select array_agg(id) a from reagents")).rows[0].a;
    const existing0 = JSON.stringify((await c.query("select * from reagents order by id")).rows);
    const lines0 = JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows);
    const logs0 = JSON.stringify((await c.query("select * from consumption_logs order by id")).rows);

    // 1. packaged countable
    let e = entryFrom({ unit: "piece", packaged: true, packUnit: "box", unitsPerPackage: "5", packages: "3", loose: "2" });
    let r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("3 boxes × 5 + 2 pieces: one Lot storing 17 pieces (received = current), box size 5, package name 'box'", [r.outcome, cols(await row(e.receiptId))], ["saved", { unit: "piece", quantity_received: 17, current_quantity: 17, units_per_carton: 5, pack_unit: "box", low_stock_threshold: 5 }]);
    check("activity entry names the package", (await c.query("select description from audit_log where action = 'receive' and description like '%TP-001%'")).rows.map((x) => x.description), ["Reagent R — Lot TP-001 — received 17 piece (5 per box)"]);

    // 2. unpackaged measured with decimals, threshold 0
    e = entryFrom({ unit: "mL", quantity: "12.55", lowStock: "0" }, { lotNumber: "TP-002" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("unpackaged 12.55 mL with an explicit 0 threshold: stored exactly; no packaging", [r.outcome, cols(await row(e.receiptId)), (await row(e.receiptId)).quantity_received], ["saved", { unit: "mL", quantity_received: 12.55, current_quantity: 12.55, units_per_carton: null, pack_unit: null, low_stock_threshold: 0 }, "12.55"]);

    // 3. measured inside packages: exact decimal total
    e = entryFrom({ unit: "mL", packaged: true, packUnit: "bottle", unitsPerPackage: "500", packages: "3", loose: "0.1" }, { lotNumber: "TP-003" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("3 bottles × 500 mL + 0.1 mL stored as exactly 1500.1 (no floating-point noise in the database)", [r.outcome, (await row(e.receiptId)).quantity_received, (await row(e.receiptId)).current_quantity, cols(await row(e.receiptId)).pack_unit], ["saved", "1500.1", "1500.1", "bottle"]);

    // 4. custom package name, trimmed
    e = entryFrom({ unit: "test", packaged: true, packUnit: "  Sachet ", unitsPerPackage: "10", packages: "2" }, { lotNumber: "TP-004" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("custom package name stored trimmed ('Sachet'), 20 tests", [r.outcome, cols(await row(e.receiptId)).pack_unit, cols(await row(e.receiptId)).quantity_received], ["saved", "Sachet", 20]);

    // 5. the database still refuses a bad name if the UI were bypassed
    e = { ...entryFrom({ unit: "piece", quantity: "3" }, { lotNumber: "TP-005" }), unitsPerCarton: 4, packUnit: "Piece" };
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("UI bypassed with name = base unit: the database refuses it (reagents_pack_unit_valid); nothing saved", [r.ok, r.outcome, /reagents_pack_unit_valid/.test(r.message), await row(e.receiptId)], [false, "rejected", true, undefined]);

    // 6. duplicate lookup (read-only), then a legitimate repeat receipt of the same Lot number
    const look = await pgClient(anon).from("reagents").select("id, name, lot_number, department, device, unit, units_per_carton, pack_unit, quantity_received, current_quantity, date_added, added_by, deleted").eq("lot_number", "TP-001");
    const dups = P.findPossibleDuplicates(look.data, { lotNumber: "TP-001", department: "Chemistry", device: "Analyzer 1", unit: "piece" });
    check("lookup by Lot number finds the earlier receipt: same department+device, packaging copyable", [look.error, dups.length, dups[0]?.sameIdentity, dups[0]?.packagingCopyable], [null, 1, true, true]);
    const before = JSON.stringify(await row(dups[0].lot.id));
    e = entryFrom({ unit: "piece", packaged: true, packUnit: dups[0].lot.pack_unit, unitsPerPackage: String(dups[0].lot.units_per_carton), packages: "2" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("repeat receipt with copied packaging: a NEW Lot (nothing merged); the existing Lot byte-identical", [r.outcome, (await c.query("select count(*)::int n from reagents where lot_number = 'TP-001'")).rows[0].n, JSON.stringify(await row(dups[0].lot.id)) === before, cols(await row(e.receiptId)).quantity_received], ["saved", 2, true, 10]);

    // 7. U2d-1 protections with packaging
    e = entryFrom({ unit: "piece", packaged: true, packUnit: "kit", unitsPerPackage: "4", packages: "2", loose: "1" }, { lotNumber: "TP-007" });
    r = await S.saveReceipt({ client: lostAfterCommit(client), entry: e, logActivity: log });
    const r2 = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("lost response after commit → recovered; retry → already_saved (package name part of the identity check); one Lot", [r.outcome, r2.outcome, (await c.query("select count(*)::int n from reagents where id = $1", [e.receiptId])).rows[0].n, cols(await row(e.receiptId)).pack_unit], ["recovered", "already_saved", 1, "kit"]);
    const r3 = await S.saveReceipt({ client, entry: { ...e, packUnit: "box" }, logActivity: log });
    check("retry with a different package name → mismatch (not a success), nothing changed", [r3.ok, r3.outcome, cols(await row(e.receiptId)).pack_unit], [false, "mismatch", "kit"]);
    e = entryFrom({ unit: "piece", packaged: true, packUnit: "box", unitsPerPackage: "5", packages: "1" }, { lotNumber: "TP-008" });
    const [d1, d2] = await Promise.all([S.saveReceipt({ client: pgClient(anon), entry: e, logActivity: log }), S.saveReceipt({ client: pgClient(anon2), entry: e, logActivity: log })]);
    check("double submission of a packaged receipt at the same moment → exactly one Lot", [(await c.query("select count(*)::int n from reagents where id = $1", [e.receiptId])).rows[0].n, [d1.outcome, d2.outcome].sort()], [1, ["already_saved", "saved"]]);
    await c.query("revoke insert on reagents from anon");
    e = entryFrom({ unit: "piece", packaged: true, packUnit: "box", unitsPerPackage: "5", packages: "1" }, { lotNumber: "TP-009" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    await c.query("grant insert on reagents to anon");
    check("failed write (privilege) → rejected, nothing saved", [r.outcome, await row(e.receiptId)], ["rejected", undefined]);

    // 8. a new Stock Count snapshots the received packaging (U2a v2 start)
    const snap = await inTx(c, async () => {
      await c.query("set local role anon");
      const res = (await c.query("select stock_count_start('Chemistry', 'tester') r")).rows[0].r;
      return res.items.filter((i) => ["TP-001", "TP-003"].includes(i.lot_number)).map((i) => [i.lot_number, i.packaging_snapshot, i.pack_unit, Number(i.units_per_carton)]).sort();
    });
    check("a new Stock Count copies each received Lot's package name and size into its lines", snap, [["TP-001", 1, "box", 5], ["TP-001", 1, "box", 5], ["TP-003", 1, "bottle", 500]]);

    // 9. precision through form → plan → payload → PostgreSQL → read-back (final review)
    const cases = [["0.1", null], ["0.10", null], ["0.01", null], ["1.25", null], ["1500.1", null], [null, { packages: "3", unitsPerPackage: "500", loose: "0.1" }]];
    const got = [];
    for (const [i, [q, pk]] of cases.entries()) {
      e = entryFrom(pk ? { unit: "mL", packaged: true, packUnit: "bottle", ...pk } : { unit: "mL", quantity: q }, { lotNumber: `TQ-00${i}` });
      r = await S.saveReceipt({ client, entry: e, logActivity: log });
      const back = await pgClient(anon).from("reagents").select("quantity_received, current_quantity").eq("id", e.receiptId);
      const db = await row(e.receiptId);
      got.push([r.outcome, JSON.stringify(e.quantityReceived), db.quantity_received, db.current_quantity, Number(back.data[0].quantity_received) === e.quantityReceived]);
    }
    check("0.1 · 0.10 · 0.01 · 1.25 · 1500.1 · 3 × 500 mL + 0.1: payload, stored numeric (received and current) and read-back are the same exact decimal", got, [["saved", "0.1", "0.1", "0.1", true], ["saved", "0.1", "0.1", "0.1", true], ["saved", "0.01", "0.01", "0.01", true], ["saved", "1.25", "1.25", "1.25", true], ["saved", "1500.1", "1500.1", "1500.1", true], ["saved", "1500.1", "1500.1", "1500.1", true]]);
    e = entryFrom({ unit: "mL", quantity: "1000000000" }, { lotNumber: "TQ-MAX" });
    r = await S.saveReceipt({ client, entry: e, logActivity: log });
    check("the largest accepted amount (1,000,000,000) is stored exactly", [r.outcome, (await row(e.receiptId)).quantity_received], ["saved", "1000000000"]);

    // 10. package names: whatever Receive accepts the database accepts; the database refuses only names Receive refuses too
    const bases = ["piece", "bottle", "box", "carton", "kit", "test", "mL", "L", "g", "Cassette"];
    const names = ["box", "carton", "pack", "kit", "case", "bag", "tray", "rack", "Sachet", "  Pouch of 10 ", "BOXES", "Cartons", "bottles", "ml", "Litre", "a".repeat(40), "a".repeat(41)];
    const appOnly = [], wrong = [];
    for (const b of bases) for (const n of names) {
      const ok = P.planReceipt({ unit: b, packaged: true, packUnit: n, unitsPerPackage: "4", packages: "1", loose: "", quantity: "", lowStock: "" }, 5).status === "ok";
      // as the Receive window would send it if its check were skipped (name trimmed by buildReceiptRow)
      const ent = { ...base, receiptId: randomUUID(), lotNumber: "TN-001", unit: b, quantityReceived: 4, unitsPerCarton: 4, packUnit: n, lowStockThreshold: 0 };
      const res = await S.saveReceipt({ client, entry: ent, logActivity: async () => ({ error: null }) });
      if (ok && res.outcome !== "saved") wrong.push(["app accepts, database refuses", b, n]);
      if (!ok && res.outcome === "saved") appOnly.push([b, n.trim().length > 12 ? `${n.trim().slice(0, 4)}…(${n.trim().length})` : n.trim()]);
      if (!ok && res.outcome !== "saved" && !/reagents_pack_unit_valid/.test(res.message || "")) wrong.push(["refused for another reason", b, n, res.outcome]);
    }
    check("170 base × name pairs: no name Receive accepts is refused by reagents_pack_unit_valid", wrong, []);
    check("names only Receive refuses (the database constraint is deliberately narrower and is NOT broadened here): plurals, measured names and other spellings of the base unit", appOnly, [["piece", "ml"], ["piece", "Litre"], ["bottle", "bottles"], ["bottle", "ml"], ["bottle", "Litre"], ["box", "BOXES"], ["box", "ml"], ["box", "Litre"], ["carton", "Cartons"], ["carton", "ml"], ["carton", "Litre"], ["kit", "ml"], ["kit", "Litre"], ["test", "ml"], ["test", "Litre"], ["mL", "Litre"], ["L", "ml"], ["L", "Litre"], ["g", "ml"], ["g", "Litre"], ["Cassette", "ml"], ["Cassette", "Litre"]]);

    // 11. nothing else changed
    check("every new receipt stored quantity_received = current_quantity", (await c.query("select count(*)::int n from reagents where id <> all($1) and quantity_received <> current_quantity", [ids0])).rows[0].n, 0);
    check("every pre-existing Lot, usage log and Stock Count line untouched", [JSON.stringify((await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows) === existing0, JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows) === lines0, JSON.stringify((await c.query("select * from consumption_logs order by id")).rows) === logs0], [true, true, true]);
    check("seed Lot with history still has no package name (nothing backfilled)", (await row(IDS.pHist)).pack_unit, null);
    await anon.end(); await anon2.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 21 });
