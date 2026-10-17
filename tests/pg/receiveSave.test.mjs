// U2d-1 — the Receive save path (receiveSave.saveReceipt) on real PostgreSQL, schema as on
// Production after Gate A3, as the anon role:
//   · the schema accepts a client-supplied Lot id (type, primary key, default, column grant,
//     row-level security, no insert trigger rewriting it)
//   · confirmed insert + activity entry; refusals (not-null, privilege, row-level security)
//   · network failure before the request; response lost after commit; the check failing too
//   · a LATE commit: the request is reported failed, the read-back finds nothing, then the
//     insert lands — a retry still cannot create a second Lot
//   · retry after the form changed (mismatch); repeated confirmations (activity once)
//   · two devices (two separate app sessions) submitting the same receipt at once
//   · activity entry refused
// One property throughout: a receipt can never create more than one Lot.
import { readdirSync } from "node:fs";
import { suite, check, load, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, pgClient } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";
import { randomUUID } from "node:crypto";

const S = await load("receiveSave.js");      // session of device 1
const S2 = await load("receiveSave.js");     // a separate module instance = another device's session
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = (over = {}) => ({ receiptId: randomUUID(), name: "Reagent R", department: "Chemistry", itemType: "Reagent", device: "Analyzer 1", deviceChoice: "device", expiryChoice: "date", lotNumber: "TR-001", unit: "bottle", quantityReceived: 12, expiryDate: "2027-06-30", receivedDate: "2026-10-13", receivedBy: "tester", lowStockThreshold: 2, unitsPerCarton: 6, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, receivingNotes: "", inspectionNotes: "", ...over });
// A client whose network fails at a chosen moment (the database itself is real).
function flaky(base, mode, pending = []) {
  return { from(t) {
    const b = base.from(t); let op = "select";
    const w = {
      insert(v) { op = "insert"; b.insert(v); return w; },
      select(c) { b.select(c); return w; },
      eq(f, v) { b.eq(f, v); return w; },
      then(res, rej) {
        const fail = () => Promise.reject(new TypeError("Failed to fetch"));
        if (op === "insert" && mode.insert === "before") return fail().then(res, rej);                       // never reached the server
        if (op === "insert" && mode.insert === "after") return b.then((r) => (r.error ? r : fail())).then(res, rej); // committed, response lost
        if (op === "insert" && mode.insert === "late") { pending.push(sleep(400).then(() => b.then((r) => r))); return fail().then(res, rej); } // lands after the check
        if (op === "select" && mode.read === "fail") return fail().then(res, rej);
        return b.then(res, rej);
      },
    };
    return w;
  } };
}

for (const version of PG_VERSIONS) suite(`U2d-1 · Receive save path (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query(readRoot("MIGRATE_RECEIPT_CHOICES.sql")); // Receive now stores the device / expiry choices
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    check("database is in the post-Gate-A3 state", (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows.find((r) => r.ord == 99).result, "PASS");

    // ── 0. The schema accepts a client-supplied Lot id (read-only inspection) ──
    const idCol = (await c.query("select data_type, column_default, is_identity, is_generated from information_schema.columns where table_name = 'reagents' and column_name = 'id'")).rows[0];
    const pk = (await c.query("select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'reagents'::regclass and contype = 'p'")).rows[0];
    check("reagents.id: uuid, default gen_random_uuid(), not an identity / generated column (an explicit value is kept)", [idCol.data_type, idCol.column_default, idCol.is_identity, idCol.is_generated], ["uuid", "gen_random_uuid()", "NO", "NEVER"]);
    check("reagents.id is the primary key (reagents_pkey) — the constraint retry safety relies on", [pk?.conname, pk?.d], ["reagents_pkey", "PRIMARY KEY (id)"]);
    check("anon may insert the id column; row-level security on, the policy allows the insert", (await c.query("select has_column_privilege('anon', 'reagents', 'id', 'INSERT') ins, (select relrowsecurity from pg_class where oid = 'reagents'::regclass) rls, (select count(*)::int from pg_policies where tablename = 'reagents' and cmd in ('ALL', 'INSERT') and coalesce(with_check, qual) = 'true') pol")).rows[0], { ins: true, rls: true, pol: 1 });
    check("no INSERT trigger on reagents can rewrite the id (only the update-only packaging guard exists)", (await c.query("select tgname, (tgtype & 4) <> 0 as on_insert from pg_trigger where tgrelid = 'reagents'::regclass and not tgisinternal order by 1")).rows, [{ tgname: "reagents_packaging_guard", on_insert: false }]);
    check("no SQL file in the repository alters reagents.id or adds an INSERT trigger on reagents", readdirSync(rootPath()).filter((f) => f.endsWith(".sql")).filter((f) => {
      const sql = readRoot(f).replace(/--[^\n]*/g, "");
      return /alter\s+table\s+(if\s+exists\s+)?(public\.)?reagents\b[^;]*\b(alter|add|drop)\s+(column\s+)?id\b/i.test(sql) || /create\s+(or\s+replace\s+)?trigger[^;]*\b(before|after|instead\s+of)\s+(insert|update\s+of\s+id)\b[^;]*\bon\s+(public\.)?reagents\b/i.test(sql);
    }), []);

    const mk = async () => { const k = await server.connect(db); await k.query("set role anon"); return k; };
    const dev1 = await mk(), dev2 = await mk();
    const client = pgClient(dev1);
    const log = (conn) => async (action, entity, description) => { try { await conn.query("insert into audit_log (action, entity, description, performed_by) values ($1, $2, $3, 'tester')", [action, entity, description]); return { error: null }; } catch (e) { return { error: { message: e.message } }; } };
    const lots = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows;
    const acts = async (lot) => (await c.query("select count(*)::int n from audit_log where action = 'receive' and description like $1", [`% — Lot ${lot} — %`])).rows[0].n;
    const others0 = JSON.stringify((await c.query("select * from reagents order by id")).rows);
    const lines0 = JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows);
    const logs0 = JSON.stringify((await c.query("select * from consumption_logs order by id")).rows);

    // 1. confirmed save with a client-supplied id
    let e = entry(); let r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    let rows = await lots(e.receiptId);
    check("saved: ok; exactly one new Lot whose id IS the receipt id", [r.ok, r.outcome, rows.length, rows[0]?.id === e.receiptId], [true, "saved", 1, true]);
    check("saved Lot = the entered values; current = received; box size kept; no package name (U2d-2 not started)", (({ name, lot_number, unit, department, device, quantity_received, current_quantity, units_per_carton, pack_unit, expiry_date, added_by }) => [name, lot_number, unit, department, device, Number(quantity_received), Number(current_quantity), Number(units_per_carton), pack_unit, expiry_date, added_by])(rows[0]), ["Reagent R", "TR-001", "bottle", "Chemistry", "Analyzer 1", 12, 12, 6, null, "2027-06-30", "tester"]);
    check("activity: exactly one 'receive' entry describing the receipt", (await c.query("select action, entity, description from audit_log where action = 'receive'")).rows, [{ action: "receive", entity: "reagent", description: "Reagent R — Lot TR-001 — received 12 bottle (6 per box)" }]);
    r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    check("the same receipt sent again after it was confirmed: already_saved, still one Lot, NO second activity entry", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-001"), r.auditAlreadyRecorded], [true, "already_saved", 1, 1, true]);

    // 2. database refusals: nothing saved, no activity
    e = entry({ department: null, lotNumber: "TR-R1" }); r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    check("not-null refusal: rejected, names the column, nothing saved, no activity", [r.outcome, /\(department\)/.test(r.message), (await lots(e.receiptId)).length, await acts("TR-R1")], ["rejected", true, 0, 0]);
    await c.query("revoke insert on reagents from anon");
    e = entry({ lotNumber: "TR-R2" }); r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    await c.query("grant insert on reagents to anon");
    check("privilege refusal: rejected with the permission message, nothing saved", [r.outcome, /don't have permission to receive stock/.test(r.message), (await lots(e.receiptId)).length], ["rejected", true, 0]);
    await c.query(`drop policy "allow all reagents" on reagents; create policy "read only" on reagents for select using (true);`);
    e = entry({ lotNumber: "TR-R3" }); r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    await c.query(`drop policy "read only" on reagents; create policy "allow all reagents" on reagents for all using (true) with check (true);`);
    check("row-level security refusal: rejected with the permission message, nothing saved", [r.outcome, /don't have permission/.test(r.message), (await lots(e.receiptId)).length], ["rejected", true, 0]);

    // 3. network failure before the request reached the server → not confirmed; retry saves once
    e = entry({ lotNumber: "TR-002" });
    r = await S.saveReceipt({ client: flaky(client, { insert: "before" }), entry: e, logActivity: log(dev1) });
    check("network failure before the request: not_confirmed, nothing saved, no activity", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-002")], [false, "not_confirmed", 0, 0]);
    r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    check("retry of the same receipt: saved exactly once, activity once", [r.outcome, (await lots(e.receiptId)).length, await acts("TR-002")], ["saved", 1, 1]);

    // 4. response lost after the server committed → recovered by id, never duplicated
    e = entry({ lotNumber: "TR-003" });
    r = await S.saveReceipt({ client: flaky(client, { insert: "after" }), entry: e, logActivity: log(dev1) });
    check("response lost after commit: recovered (found by its id), one Lot, activity once", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-003")], [true, "recovered", 1, 1]);
    e = entry({ lotNumber: "TR-004" });
    r = await S.saveReceipt({ client: flaky(client, { insert: "after", read: "fail" }), entry: e, logActivity: log(dev1) });
    check("response lost and the check fails too: unknown (honest), the Lot exists, no activity yet", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-004")], [false, "unknown", 1, 0]);
    r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    check("retry after the unknown outcome: the primary key refuses a second Lot; existing Lot verified → already_saved; activity once", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-004")], [true, "already_saved", 1, 1]);
    r = await S.saveReceipt({ client, entry: { ...e, quantityReceived: 20 }, logActivity: log(dev1) });
    check("retry after the form was changed: mismatch (not a success), nothing new saved, earlier values stay, no extra activity", [r.ok, r.outcome, (await lots(e.receiptId)).map((x) => Number(x.quantity_received)), await acts("TR-004")], [false, "mismatch", [12], 1]);

    // 5. a LATE commit: reported failed, not found by the check, then the insert lands
    e = entry({ lotNumber: "TR-007" });
    const pending = [];
    r = await S.saveReceipt({ client: flaky(client, { insert: "late" }, pending), entry: e, logActivity: log(dev1) });
    const atCheck = (await lots(e.receiptId)).length;
    await Promise.all(pending);
    const afterLanding = (await lots(e.receiptId)).length;
    check("late commit: the check found nothing → not_confirmed (not 'not saved'); then the first request DID land", [r.ok, r.outcome, atCheck, afterLanding], [false, "not_confirmed", 0, 1]);
    r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    check("retry after the late commit: the primary key refuses a second Lot → already_saved; exactly one Lot; activity once", [r.ok, r.outcome, (await lots(e.receiptId)).length, await acts("TR-007")], [true, "already_saved", 1, 1]);

    // 6. two devices (separate app sessions) submit the same receipt at the same moment
    e = entry({ lotNumber: "TR-005" });
    const [x1, x2] = await Promise.all([S.saveReceipt({ client: pgClient(dev1), entry: e, logActivity: log(dev1) }), S2.saveReceipt({ client: pgClient(dev2), entry: e, logActivity: log(dev2) })]);
    const twoDeviceActs = await acts("TR-005");
    check("same receipt from two sessions at once: exactly ONE Lot; one saved, the other verified as already saved", [(await lots(e.receiptId)).length, [x1.outcome, x2.outcome].sort(), x1.ok && x2.ok], [1, ["already_saved", "saved"], true]);
    check("…activity entries: 1 or 2, never more (two sessions can each record it — documented limitation)", twoDeviceActs >= 1 && twoDeviceActs <= 2, true);

    // 7. activity entry refused after a confirmed save
    await c.query("revoke insert on audit_log from anon");
    e = entry({ lotNumber: "TR-006" });
    const before = (await c.query("select count(*)::int n from audit_log")).rows[0].n;
    r = await S.saveReceipt({ client, entry: e, logActivity: log(dev1) });
    await c.query("grant insert on audit_log to anon");
    check("activity entry refused: Lot saved and reported (auditLogged false + warning); Lot not inserted again; no activity row", [r.ok, r.auditLogged, r.warning === S.AUDIT_WARNING, (await lots(e.receiptId)).length, (await c.query("select count(*)::int n from audit_log")).rows[0].n - before], [true, false, true, 1, 0]);

    // 8. nothing else touched
    const created = (await c.query("select array_agg(id) a from reagents where lot_number like 'TR-%'")).rows[0].a;
    check("existing Lots, usage logs and Stock Count lines untouched by every receipt", [JSON.stringify((await c.query("select * from reagents where id <> all($1) order by id", [created])).rows) === others0, JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows) === lines0, JSON.stringify((await c.query("select * from consumption_logs order by id")).rows) === logs0], [true, true, true]);
    check("receipts created exactly one Lot each (no duplicate anywhere)", (await c.query("select count(*)::int n, count(distinct lot_number)::int d from reagents where lot_number like 'TR-%'")).rows[0], { n: 7, d: 7 });
    await dev1.end(); await dev2.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 26 });
