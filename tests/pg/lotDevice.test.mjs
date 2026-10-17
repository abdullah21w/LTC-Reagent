// Edit Lot — setting the device of a lot recorded without one, on real PostgreSQL
// (schema as on Production: U2a + atomic Log Use), as the app's anon role. The
// ERF situation: lot L3470 on VITROS (used, now empty) and lot A3826 received with
// no device. Proven here: only the device (+ edited_by / edited_at) changes; usage
// logs, Stock Count lines and every other lot are untouched; a second editor who
// opened the lot before it was set gets a conflict (nothing written, one activity
// entry in all); and afterwards the reagent list shows ERF ONCE with both lots.
import { suite, check, load, src } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, applyLogUse, pgClient } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

const E = await load({ contents: `export * from "${src("lotEdit.js")}"; export { buildGroups } from "${src("forecast.js")}";` });
const DEVICES = [{ name: "VITROS", department: "Chemistry" }, { name: "SYSMEX", department: "Chemistry" }];

for (const version of PG_VERSIONS) suite(`Edit Lot · set a lot's missing device (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    await applyLogUse(c);
    const mk = async () => { const k = await server.connect(db); await k.query("set role anon"); return k; };
    const editor = await mk(), other = await mk();
    const add = async (lot, device, type, qty, exp, added) => (await c.query("insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, expiry_date, date_added, added_by, low_stock_threshold) values ('ERF', 'Chemistry', $1, $2, $3, 'BOX', $4, $4, $5, $6, 'tester', 1) returning id", [type, device, lot, qty, exp, added])).rows[0].id;
    const L3470 = await add("L3470", "VITROS", "Other", 3, "2027-09-08", "2026-07-15");
    const A3826 = await add("A3826", "", "Reagent", 2, "2028-03-09", "2026-09-22");
    // L3470 used up on VITROS (A3826, having no device, is no alternative → not auto-removed)
    const used = (await editor.query("select log_use(gen_random_uuid(), $1, 3, '2026-10-10', 'tester', '', false, true, false, null, 'tester') r", [L3470])).rows[0].r.status;
    const started = (await editor.query("select stock_count_start('Chemistry', 'tester') r")).rows[0].r.status;
    const row = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows[0];
    const snap = async () => JSON.stringify([(await c.query("select * from consumption_logs order by id")).rows, (await c.query("select * from inventory_count_items order by id")).rows, (await c.query("select * from inventory_counts order by id")).rows, (await c.query("select * from reagents where id <> $1 order by id", [A3826])).rows]);
    check("setup like Production: L3470 used up on VITROS and still listed; A3826 without a device; a Stock Count open", [used, (await row(L3470)).current_quantity, (await row(L3470)).deleted, (await row(A3826)).device, started], ["ok", "0", false, "", "ok"]);

    const audit = [];
    const logFor = (k) => async (action, entity, description) => { audit.push(description); await k.query("insert into audit_log (action, entity, description, performed_by) values ($1, $2, $3, 'tester')", [action, entity, description]); };
    const before = await snap();
    const opened = await row(A3826), openedByOther = await row(A3826); // both editors opened the lot while it had no device
    const form = (r, device) => ({ lot_number: r.lot_number, unit: r.unit, quantity_received: String(r.quantity_received), current_quantity: String(r.current_quantity), expiry_date: r.expiry_date ? new Date(r.expiry_date).toISOString().slice(0, 10) : "", low_stock_threshold: String(r.low_stock_threshold), device });
    const planFor = (r, device) => E.planLotEdit({ original: r, form: form(r, device), packagingEnabled: false, history: { logs: 0, countLines: 1 }, devices: DEVICES });
    const p = planFor(opened, "VITROS");
    const r1 = await E.saveLotEdit({ client: pgClient(editor), original: opened, payload: p.payload, username: "tester", logActivity: logFor(editor) });
    const after = await row(A3826);
    check("set device: ok; in the row ONLY device, edited_by and edited_at changed (quantity, dates, unit, lot number, active on device untouched)", [p.status, r1.ok, Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(opened[k])).sort(), after.device, after.current_quantity, after.active_on_device], ["ok", true, ["device", "edited_at", "edited_by"], "VITROS", "2", false]);
    check("usage logs, Stock Count lines and counts, and every other lot: exactly as before", await snap() === before, true);
    check("activity log: one entry naming the device that was set", [audit, Number((await c.query("select count(*) from audit_log where description like '%device set to%'")).rows[0].count)], [["ERF — Lot A3826: device set to VITROS (was none)"], 1]);

    // a second editor who opened the lot before the device was set
    const r2 = await E.saveLotEdit({ client: pgClient(other), original: openedByOther, payload: planFor(openedByOther, "SYSMEX").payload, username: "other", logActivity: logFor(other) });
    check("a second editor (opened before it was set) choosing another device: conflict — nothing written, no second activity entry", [r2.ok, /changed elsewhere/.test(r2.message), (await row(A3826)).device, audit.length], [false, true, "VITROS", 1]);
    const r3 = await E.saveLotEdit({ client: pgClient(other), original: await row(A3826), payload: { ...(await row(A3826)), device: "SYSMEX" }, username: "other", logActivity: logFor(other) });
    check("moving the lot to another device afterwards is refused by the save path itself (nothing sent)", [r3.ok, (await row(A3826)).device, audit.length], [false, "VITROS", 1]);

    // the reagent list
    const all = (await c.query("select * from reagents")).rows.map((r) => ({ ...r, current_quantity: Number(r.current_quantity), quantity_received: Number(r.quantity_received), low_stock_threshold: Number(r.low_stock_threshold), expiry_date: r.expiry_date ? new Date(r.expiry_date).toISOString().slice(0, 10) : null, date_added: new Date(r.date_added).toISOString().slice(0, 10) }));
    const logs = (await c.query("select * from consumption_logs")).rows.map((l) => ({ ...l, amount: Number(l.amount), date: new Date(l.date).toISOString().slice(0, 10) }));
    const env = { snoozes: [], warnDays: 30, today: "2026-10-17", compareLots: (a, b) => (a.expiry_date < b.expiry_date ? -1 : 1), daysBetween: (a, b) => (new Date(a) - new Date(b)) / 86400000, hasInspectionIssue: () => false, isExpiringSoonItem: () => false };
    const erf = E.buildGroups(all, logs, env).filter((g) => g.name === "ERF");
    check("the reagent list now shows ERF ONCE (ERF::VITROS) with both lots (usable A3826 first, empty L3470 still listed), 2 BOX in stock, Stable (the lot emptied by Log Use / Stock Count no longer makes it Critical), L3470's usage counted", [erf.length, erf[0].key, erf[0].items.map((i) => i.lot_number), erf[0].totalQty, erf[0].recentUsed, erf[0].status, erf[0].fefo.lot_number], [1, "ERF::VITROS", ["A3826", "L3470"], 2, 3, "green", "A3826"]);
    const usedNew = (await editor.query("select log_use(gen_random_uuid(), $1, 1, '2026-10-17', 'tester', '', false, true, false, null, 'tester') r", [A3826])).rows[0].r.status;
    check("Log Use on the lot afterwards works as before (stock 2 → 1)", [usedNew, (await row(A3826)).current_quantity], ["ok", "1"]);
    for (const k of [editor, other, c]) await k.end();
  } finally {
    await server.stop();
  }
}, { expectedChecks: 8 });
