// U2c-1 + U2c-2 — the Edit Lot save path (lotEdit.saveLotEdit) on real PostgreSQL,
// schema as on Production after Gate A3 (evidence chain + U2a), synthetic data.
// A small adapter runs exactly the UPDATE … WHERE … RETURNING that supabase-js sends,
// as the anon role, on two separate connections to model two devices.
import { suite, check, load, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, pgClient } from "../helpers/pg.mjs";
import { seed, IDS } from "../fixtures/pgSeed.mjs";

const E = await load("lotEdit.js");

for (const version of PG_VERSIONS) suite(`U2c-1 · U2c-2 · Edit Lot save path (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c);
    await seed(c);
    await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    check("database is in the post-Gate-A3 state (VERIFY_PACKAGING passes)", (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows.find((r) => r.ord == 99).result, "PASS");

    const mk = async () => { const k = await server.connect(db); await k.query("set role anon"); return k; };
    const editor = await mk(), other = await mk();
    const client = pgClient(editor);
    const audit = [];
    const logActivity = async (action, entity, description) => { audit.push(description); await editor.query("insert into audit_log (action, entity, description, performed_by) values ($1, $2, $3, 'tester')", [action, entity, description]); };
    const row = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows[0];
    const auditCount = async () => (await c.query("select count(*)::int n from audit_log")).rows[0].n;
    const save = (original, over) => E.saveLotEdit({ client, original, payload: { ...original, ...over }, username: "tester", logActivity });
    const K = await row(IDS.pHist), free = await row(IDS.free);
    const linesBefore = JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows);
    const othersBefore = JSON.stringify((await c.query("select * from reagents where id <> all($1) order by id", [[K.id, free.id]])).rows);

    // ═══ U2c-1 ═══
    let orig = await row(K.id), a0 = await auditCount();
    let r = await save(orig, { low_stock_threshold: Number(orig.low_stock_threshold) + 1 });
    let after = await row(K.id);
    check("success: ok; only low_stock_threshold, edited_by, edited_at changed in the row", [r.ok, Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(orig[k])).sort()], [true, ["edited_at", "edited_by", "low_stock_threshold"]]);
    check("success: exactly one activity entry, written after the update", [(await auditCount()) - a0, audit.at(-1)], [1, "Analyte P — Lot TP-200"]);
    orig = await row(K.id); a0 = await auditCount();
    r = await save(orig, {});
    check("unchanged: no write (row identical incl. edited_at), no activity", [r.unchanged, JSON.stringify(await row(K.id)) === JSON.stringify(orig), (await auditCount()) - a0], [true, true, 0]);
    orig = await row(K.id); a0 = await auditCount();
    await other.query("update reagents set current_quantity = current_quantity - 1 where id = $1", [K.id]);
    await other.query("insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ($1, 1, current_date, 'staff', 'manual')", [K.id]);
    const consumed = Number((await row(K.id)).current_quantity);
    r = await save(orig, { current_quantity: Number(orig.current_quantity) + 5 });
    check("concurrent consumption + quantity edit → conflict; stock keeps the consumed value; no activity", [r.ok, /changed elsewhere/.test(r.message), Number((await row(K.id)).current_quantity), (await auditCount()) - a0], [false, true, consumed, 0]);
    orig = await row(K.id);
    await other.query("update reagents set current_quantity = current_quantity - 1 where id = $1", [K.id]);
    const consumed2 = Number((await row(K.id)).current_quantity);
    r = await save(orig, { expiry_date: "2031-01-31" });
    after = await row(K.id);
    check("concurrent consumption + expiry edit → saves; current_quantity stays the newer consumed value (never sent)", [r.ok, Number(after.current_quantity), after.expiry_date], [true, consumed2, "2031-01-31"]);
    orig = await row(K.id);
    const rA = await save(orig, { current_quantity: 10 }), rB = await save(orig, { current_quantity: 8 });
    check("concurrent quantity edits: first ok, second conflict; final value is the first's", [rA.ok, rB.ok, /changed elsewhere/.test(rB.message), Number((await row(K.id)).current_quantity)], [true, false, true, 10]);
    check("two editors changing DIFFERENT fields both succeed (unchanged fields not sent)", await (async () => { const o = await row(K.id); const x = await save(o, { lot_number: o.lot_number + "-a" }); const y = await save(o, { low_stock_threshold: 9 }); const f = await row(K.id); return [x.ok, y.ok, f.lot_number, Number(f.low_stock_threshold)]; })(), [true, true, "TP-200-a", 9]);
    orig = await row(free.id);
    check("fixture: a lot without history, without expiry or box size", [orig.expiry_date, orig.units_per_carton], [null, null]);
    const stale = { ...orig };
    r = await save(orig, { expiry_date: "2030-06-30" });
    check("null original (expiry_date IS NULL) → saved", [r.ok, (await row(free.id)).expiry_date], [true, "2030-06-30"]);
    r = await save(stale, { expiry_date: "2029-01-01" });
    check("stale null original after someone set it → conflict, not overwritten", [r.ok, /changed elsewhere/.test(r.message), (await row(free.id)).expiry_date], [false, true, "2030-06-30"]);
    orig = await row(free.id);
    r = await save(orig, { units_per_carton: 6 });
    check("box size NULL → 6 on a lot without history (IS NULL condition) → saved", [r.ok, Number((await row(free.id)).units_per_carton)], [true, 6]);
    orig = await row(free.id);
    r = await save(orig, { units_per_carton: null });
    check("box size 6 → NULL (value condition) → saved", [r.ok, (await row(free.id)).units_per_carton], [true, null]);
    orig = await row(K.id); a0 = await auditCount();
    r = await save(orig, { unit: "box" });
    check("history lot unit change (UI bypassed) → database guard refusal surfaced; row unchanged; no activity", [r.ok, r.message, (await row(K.id)).unit, (await auditCount()) - a0], [false, "This lot now has usage or Stock Count records, so its unit can't be changed. Nothing was saved.", orig.unit, 0]);
    r = await save(orig, { units_per_carton: 4 });
    check("history lot box size change → refused with the box-size message", [r.ok, r.message], [false, "This lot now has usage or Stock Count records, so its box size can't be changed. Nothing was saved."]);
    r = await save(orig, { unit: "Piece" });
    check("history lot unit case/space-only change → allowed (the database agrees)", r.ok, true);
    a0 = await auditCount();
    r = await save({ ...orig, id: "00000000-0000-4000-8000-00000000dead" }, { low_stock_threshold: 1 });
    check("lot no longer exists → 'no longer exists', no activity", [r.ok, r.message, (await auditCount()) - a0], [false, "This lot no longer exists, so nothing was saved.", 0]);
    await c.query("revoke insert on audit_log from anon");
    const realLog = async (action, entity, description) => { try { await editor.query("insert into audit_log (action, entity, description, performed_by) values ($1, $2, $3, 'tester')", [action, entity, description]); return { error: null }; } catch (e) { return { error: { message: e.message } }; } };
    orig = await row(K.id); a0 = await auditCount();
    r = await E.saveLotEdit({ client, original: orig, payload: { ...orig, low_stock_threshold: Number(orig.low_stock_threshold) + 2 }, username: "tester", logActivity: realLog });
    check("saved but the audit insert is denied → ok, auditLogged false, warning; applied once (not retried); no audit row", [r.ok, r.auditLogged, /could not be recorded in the activity log/.test(r.warning || ""), Number((await row(K.id)).low_stock_threshold), (await auditCount()) - a0], [true, false, true, Number(orig.low_stock_threshold) + 2, 0]);
    await c.query("grant insert on audit_log to anon");
    check("U2c-1: count lines (incl. snapshots) untouched by any save", JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows) === linesBefore, true);
    check("U2c-1: every other lot untouched", JSON.stringify((await c.query("select * from reagents where id <> all($1) order by id", [[K.id, free.id]])).rows) === othersBefore, true);

    // ═══ U2c-2 — package name ═══
    const histOf = async (id) => ({ logs: (await c.query("select count(*)::int n from consumption_logs where reagent_id = $1", [id])).rows[0].n, countLines: (await c.query("select count(*)::int n from inventory_count_items where reagent_id = $1", [id])).rows[0].n });
    const formOf = (x, over = {}) => ({ lot_number: x.lot_number, unit: x.unit, quantity_received: String(x.quantity_received), current_quantity: String(x.current_quantity), low_stock_threshold: String(x.low_stock_threshold), expiry_date: x.expiry_date || "", ...over });
    const plan = async (o, over = {}, opt = {}) => E.planLotEdit({ original: o, form: formOf(o, over), packagingEnabled: opt.on ?? (o.units_per_carton != null), unitsPerBox: opt.per ?? (o.units_per_carton ?? ""), packUnit: "pack" in opt ? opt.pack : (o.pack_unit ?? ""), history: await histOf(o.id), confirmed: true });
    const created = [];
    const lines2 = JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows);
    const others2 = JSON.stringify((await c.query("select * from reagents where id <> $1 order by id", [K.id])).rows);
    const mkLot = async (over = {}) => {
      const v = { name: "Synthetic", department: "Chemistry", device: "", lot_number: `T-${created.length + 1}`, unit: "bottle", quantity_received: 9, current_quantity: 7, low_stock_threshold: 2, added_by: "tester", units_per_carton: null, pack_unit: null, ...over };
      const cols = Object.keys(v);
      const l = (await c.query(`insert into reagents (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, cols.map((k) => v[k]))).rows[0];
      created.push(l.id); return l;
    };
    const qtyOf = (x) => [Number(x.quantity_received), Number(x.current_quantity), Number(x.low_stock_threshold)];

    orig = await row(K.id); a0 = await auditCount();
    check("fixture: lot with history, a box size and no package name", [((h) => h.logs + h.countLines > 0)(await histOf(K.id)), orig.units_per_carton !== null, orig.pack_unit], [true, true, null]);
    let p = await plan(orig, {}, { pack: "box" });
    check("history lot: adding a package name → plan blocked, no payload", [p.status, p.payload], ["blocked", null]);
    r = await save(orig, { pack_unit: "box" });
    check("history lot, UI bypassed: database guard refuses NULL → 'box'; clear message; row unchanged; no activity", [r.ok, r.message, (await row(K.id)).pack_unit, (await auditCount()) - a0], [false, "This lot now has usage or Stock Count records, so its package name can't be changed. Nothing was saved.", null, 0]);
    p = await plan(orig, { low_stock_threshold: String(Number(orig.low_stock_threshold) + 1) });
    r = await save(orig, p.payload);
    after = await row(K.id);
    check("history lot: unrelated edit saves; packaging untouched; quantities as typed", [p.status, r.ok, after.pack_unit, Number(after.units_per_carton) === Number(orig.units_per_carton), Number(after.current_quantity) === Number(orig.current_quantity)], ["ok", true, null, true, true]);
    const L1 = await mkLot();
    orig = await row(L1.id); a0 = await auditCount();
    p = await plan(orig, {}, { on: true, per: "6", pack: "box" });
    r = await save(orig, p.payload);
    after = await row(L1.id);
    check("no-history lot: packaging on with 'box' × 6 → saved; quantities NOT multiplied; one activity entry", [p.status, r.ok, Number(after.units_per_carton), after.pack_unit, qtyOf(after), (await auditCount()) - a0], ["ok", true, 6, "box", [9, 7, 2], 1]);
    orig = await row(L1.id);
    const pA = await plan(orig, {}, { pack: "kit" }), pB = await plan(orig, {}, { pack: "tray" });
    const sA = await save(orig, pA.payload), sB = await save(orig, pB.payload);
    check("concurrent renames from the same original: first saved, second conflict; final name is the first's", [sA.ok, sB.ok, /changed elsewhere/.test(sB.message || ""), (await row(L1.id)).pack_unit], [true, false, true, "kit"]);
    const stale2 = await row(L1.id);
    await other.query("update reagents set pack_unit = 'carton' where id = $1", [L1.id]);
    p = await plan(stale2, {}, { on: false });
    r = await save(stale2, p.payload);
    after = await row(L1.id);
    check("stale disable after someone renamed → conflict; newer name and box size kept", [r.ok, /changed elsewhere/.test(r.message || ""), after.pack_unit, Number(after.units_per_carton)], [false, true, "carton", 6]);
    orig = await row(L1.id);
    p = await plan(orig, {}, { on: false });
    r = await save(orig, p.payload);
    after = await row(L1.id);
    check("disable: units_per_carton and pack_unit both NULL; quantities unchanged", [r.ok, after.units_per_carton, after.pack_unit, qtyOf(after)], [true, null, null, [9, 7, 2]]);
    const L2 = await mkLot({ unit: "vial" });
    orig = await row(L2.id);
    p = await plan(orig, {}, { on: true, per: "10", pack: "  Sachet  " });
    r = await save(orig, p.payload);
    check("custom name '  Sachet  ' stored as 'Sachet'", [r.ok, (await row(L2.id)).pack_unit], [true, "Sachet"]);
    orig = await row(L2.id); a0 = await auditCount();
    const refusals = [];
    for (const bad of ["x".repeat(41), "vial", " VIAL ", "   "]) { const x = await save(orig, { pack_unit: bad }); refusals.push([x.ok, /refused the package name/.test(x.message || "")]); }
    check("database refuses 41 chars, name = unit (any case/space), blank — with the package-name message", refusals, [[false, true], [false, true], [false, true], [false, true]]);
    const L3 = await mkLot();
    orig = await row(L3.id);
    r = await save(orig, { pack_unit: "box" });
    check("database refuses a name without a box size", [r.ok, /refused the package name/.test(r.message || ""), (await row(L3.id)).pack_unit], [false, true, null]);
    check("the UI plan refuses the same values before sending anything", [(await plan(await row(L2.id), {}, { pack: "x".repeat(41) })).status, (await plan(await row(L2.id), {}, { pack: "Vials" })).status, (await plan(await row(L2.id), {}, { pack: "mL" })).status], ["invalid", "invalid", "invalid"]);
    check("no activity entries for any refusal; name still 'Sachet'", [(await auditCount()) - a0, (await row(L2.id)).pack_unit], [0, "Sachet"]);
    const L4 = await mkLot({ units_per_carton: 2.5 });
    orig = await row(L4.id);
    p = await plan(orig, { expiry_date: "2030-02-28" });
    r = await save(orig, p.payload);
    after = await row(L4.id);
    check("legacy 2.5 box size: unrelated edit saved; 2.5 kept as stored", [p.status, r.ok, Number(after.units_per_carton), after.pack_unit], ["ok", true, 2.5, null]);
    check("legacy 2.5 box size: adding a name is refused by the UI (whole size first)", (await plan(after, {}, { pack: "box" })).status, "invalid");
    p = await plan(after, {}, { per: "3", pack: "box" });
    r = await save(after, p.payload);
    check("legacy 2.5 → 3 with a name (no history): saved; quantities unchanged", [r.ok, Number((await row(L4.id)).units_per_carton), (await row(L4.id)).pack_unit, qtyOf(await row(L4.id))], [true, 3, "box", [9, 7, 2]]);
    const L5 = await mkLot({ units_per_carton: 6 });
    orig = await row(L5.id);
    p = await plan(orig, {}, { pack: "box" });
    await other.query("insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ($1, 1, current_date, 'staff', 'manual')", [L5.id]);
    a0 = await auditCount();
    r = await save(orig, p.payload);
    check("history recorded while the window is open → refused (packaging_locked); name stays NULL; no activity", [p.status, r.ok, r.message, (await row(L5.id)).pack_unit, (await auditCount()) - a0], ["ok", false, "This lot now has usage or Stock Count records, so its package name can't be changed. Nothing was saved.", null, 0]);
    check("…and the window, reopened, now blocks it in the UI", (await plan(await row(L5.id), {}, { pack: "box" })).status, "blocked");
    check("U2c-2: count lines (incl. snapshots) untouched", JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows) === lines2, true);
    check("U2c-2: every pre-existing lot other than K untouched", JSON.stringify((await c.query("select * from reagents where id <> all($1) order by id", [[K.id, ...created]])).rows) === others2, true);
    const ver2 = (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows;
    check("VERIFY_PACKAGING afterwards: only check 13 (migration-time 'no names yet') differs", ver2.filter((x) => x.result === "FAIL" && x.ord != 99).map((x) => Number(x.ord)), [13]);
    check("…and the only named lots are the ones these tests created", (await c.query("select count(*)::int n from reagents where pack_unit is not null and id <> all($1)", [created])).rows[0].n, 0);

    await editor.end(); await other.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 42 });
