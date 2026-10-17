// MIGRATE_RECEIPT_CHOICES.sql on real PostgreSQL, in Production order (U2a, atomic
// Log Use, atomic edit / undo, release control with an approved build), driven as
// the app's anon role with its build header. Proven here:
//   * applying it changes no existing row; VERIFY passes; it adds no INSERT trigger;
//   * Lots recorded before it (no choices) keep working everywhere: Log Use, edit /
//     undo, Stock Count start / entry / resolve, discard, Edit Lot (device, expiry);
//   * a NEW Lot can't be saved without both choices or with choices that contradict
//     its data — whatever client sends it; Receive's save path stores them;
//   * retry safety is intact (same receipt id → "already saved"; other choices →
//     mismatch, never success); Lots with choices stay consistent on update;
//   * release control still refuses first; re-running never moves the cut-off;
//     rollback removes only the rule and keeps the recorded choices.
import { randomUUID, randomBytes } from "node:crypto";
import { suite, check, load, src, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, applyLogUse, applyLogEdit, applyRelease, pgClient } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

const M = await load({ contents: `export * as S from "${src("receiveSave.js")}"; export * as E from "${src("lotEdit.js")}";` });
const { S, E } = M;
const STRIP = (rows) => JSON.stringify(rows.map(({ device_choice, expiry_choice, ...r }) => r));

for (const version of PG_VERSIONS) suite(`Receipt choices: explicit device and expiry on new Lots (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    await applyLogUse(c); await applyLogEdit(c); await applyRelease(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon; revoke all on app_release_log, app_release_seen from anon; revoke insert, update, delete on app_release from anon");
    const B = randomBytes(20).toString("hex");
    const conn = async (build = B) => { const k = await server.connect(db); await k.query("set role anon"); await k.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "x-ltc-build": build })]); return k; };
    const app = await conn();
    await app.query("select ltc_hello()");
    await c.query("select ltc_release_open($1, 'choices test', p_deployment_verified => true)", [B]);
    const add = async (lot, device, qty, exp) => (await c.query("insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, expiry_date, date_added, added_by, low_stock_threshold) values ('ERF', 'Chemistry', 'Reagent', $1, $2, 'box', $3, $3, $4, '2026-09-22', 'tester', 1) returning id", [device, lot, qty, exp])).rows[0].id;
    const legacyBlank = await add("A3826", "", 10, null), legacyDev = await add("L3470", "VITROS", 10, "2027-09-08");
    const before = STRIP((await c.query("select * from reagents order by id")).rows);

    // ── apply ──
    await c.query(readRoot("MIGRATE_RECEIPT_CHOICES.sql"));
    const v = (await c.query(readRoot("VERIFY_RECEIPT_CHOICES.sql"))).rows;
    const def0 = (await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'reagents_receipt_choices'")).rows[0].d;
    check("VERIFY: checks 1–6 and OVERALL PASS; every existing Lot is legacy (no choices); no existing row changed", [v.filter((r) => r.ord <= 99).map((r) => r.result), v.find((r) => r.ord == 100).result.startsWith(`${(await c.query("select count(*) from reagents")).rows[0].count} / 0`), STRIP((await c.query("select * from reagents order by id")).rows) === before],
      [Array(7).fill("PASS"), true, true]);
    check("no INSERT trigger on reagents (row level) — the rule is a check constraint", (await c.query("select count(*)::int n from pg_trigger where tgrelid = 'reagents'::regclass and not tgisinternal and (tgtype & 4) <> 0 and (tgtype & 1) = 1")).rows[0].n, 0);

    // ── legacy Lots keep working everywhere ──
    const q = (sql, p) => app.query(sql, p).then((r) => r.rows[0]?.r?.status ?? "ok", (e) => e.message);
    const LOG = randomUUID();
    const legacy = [
      await q("select log_use($1, $2, 2, '2026-10-16', 'tester', '', false, true, false, null, 'tester') r", [LOG, legacyBlank]),
      await q("select log_edit(gen_random_uuid(), $1, 2, '2026-10-16', 'tester', '', false, 3, '2026-10-16', 'tester', '', false, 'tester') r", [LOG]),
      await q("select log_undo(gen_random_uuid(), $1, 3, '2026-10-16', 'tester') r", [LOG]),
      await q("select stock_count_start('Chemistry', 'tester') r"),
    ];
    const line = (await c.query("select id, expected_quantity from inventory_count_items where reagent_id = $1", [legacyDev])).rows[0];
    legacy.push(await q("update inventory_count_items set counted_quantity = 9, counted_at = now(), counted_by = 'tester' where id = $1", [line.id]));
    legacy.push(await q("select stock_count_resolve($1, 'corrected', 'tester', $2, 9) r", [line.id, line.expected_quantity]));
    check("legacy Lots (no choices): Log Use, edit, undo, Stock Count start / entry / resolve all work as before", legacy, ["ok", "ok", "ok", "ok", "ok", "ok"]);
    const row = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows[0];
    const r1 = await E.saveLotEdit({ client: pgClient(app), original: await row(legacyBlank), payload: { ...(await row(legacyBlank)), device: "VITROS" }, username: "tester" });
    const r2 = await E.saveLotEdit({ client: pgClient(app), original: await row(legacyDev), payload: { ...(await row(legacyDev)), expiry_date: null }, username: "tester" });
    check("legacy Lots: Edit Lot can still give a device (phase A) and clear an expiry date; they stay legacy (choices NULL)", [r1.ok, r2.ok, (await row(legacyBlank)).device, (await row(legacyBlank)).device_choice, (await row(legacyDev)).expiry_choice], [true, true, "VITROS", null, null]);
    const discard = await q("update reagents set deleted = true, deleted_by = 'tester', deleted_at = now(), discard_reason = 'Expired' where id = $1", [legacyDev]);
    check("legacy Lot: discard works", discard, "ok");

    // ── new Lots ──
    const ins = (o) => app.query(`insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, expiry_date, date_added, added_by, low_stock_threshold${o.cols || ""}) values ('New', 'Chemistry', 'Reagent', $1, $2, 'box', 1, 1, $3, '2026-10-17', 'tester', 1${o.vals || ""})`, [o.device ?? "", "N-" + randomBytes(3).toString("hex"), o.exp ?? null])
      .then(() => "ok", (e) => (e.code === "23514" && /reagents_receipt_choices/.test(e.message) ? "refused" : e.message));
    check("a NEW Lot without choices — as an older app would send it — is refused, with or without device / date", [await ins({}), await ins({ device: "VITROS", exp: "2027-01-01" })], ["refused", "refused"]);
    check("…and so is any choice that contradicts the data, or only one choice", [
      await ins({ device: "", cols: ", device_choice, expiry_choice", vals: ", 'device', 'none'" }), await ins({ device: "VITROS", cols: ", device_choice, expiry_choice", vals: ", 'none', 'none'" }),
      await ins({ exp: null, cols: ", device_choice, expiry_choice", vals: ", 'none', 'date'" }), await ins({ exp: "2027-01-01", cols: ", device_choice, expiry_choice", vals: ", 'none', 'none'" }),
      await ins({ cols: ", device_choice", vals: ", 'none'" }), await ins({ cols: ", device_choice, expiry_choice", vals: ", 'maybe', 'none'" })], Array(6).fill("refused"));
    check("explicit, consistent choices are accepted (device + date, none + none)", [await ins({ device: "VITROS", exp: "2027-01-01", cols: ", device_choice, expiry_choice", vals: ", 'device', 'date'" }), await ins({ cols: ", device_choice, expiry_choice", vals: ", 'none', 'none'" })], ["ok", "ok"]);

    // ── Receive's save path ──
    const entry = (o = {}) => ({ receiptId: randomUUID(), name: "ERF", department: "Chemistry", itemType: "Reagent", device: "", deviceChoice: "none", lotNumber: "R-" + randomBytes(3).toString("hex"), unit: "box", quantityReceived: 2, expiryDate: "2028-03-09", expiryChoice: "date", receivedDate: "2026-10-17", receivedBy: "tester", lowStockThreshold: 1, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, receivingNotes: "", inspectionNotes: "", ...o });
    const e1 = entry();
    const s1 = await S.saveReceipt({ client: pgClient(app), entry: e1 });
    const saved = await row(e1.receiptId);
    check("Receive saves the Lot with its choices", [s1.ok, s1.outcome, saved.device, saved.device_choice, saved.expiry_choice], [true, "saved", "", "none", "date"]);
    const s2 = await S.saveReceipt({ client: pgClient(app), entry: e1 });
    const s3 = await S.saveReceipt({ client: pgClient(app), entry: { ...e1, expiryChoice: "none", expiryDate: "" } });
    check("retry safety: the same receipt again → already saved (no second Lot); same id with other choices → mismatch, never a success", [s2.ok, s2.outcome, s3.ok, s3.outcome, Number((await c.query("select count(*) from reagents where id = $1", [e1.receiptId])).rows[0].count)], [true, "already_saved", false, "mismatch", 1]);

    // ── Lots with choices stay consistent ──
    const upd = (sql, p) => app.query(sql, p).then((r) => `ok:${r.rowCount}`, (e) => (/reagents_receipt_choices/.test(e.message) ? "refused" : e.message));
    check("updates that would contradict the recorded choice are refused (device without its choice, date cleared / set without changing the choice)", [
      await upd("update reagents set device = 'VITROS' where id = $1", [e1.receiptId]), await upd("update reagents set expiry_date = null where id = $1", [e1.receiptId]),
      await upd("update reagents set device_choice = null, expiry_choice = null where id = $1", [e1.receiptId])], ["refused", "refused", "refused"]);
    const ed = await E.saveLotEdit({ client: pgClient(app), original: saved, payload: { ...saved, device: "VITROS", device_choice: "device" }, username: "tester" });
    const ed2 = await E.saveLotEdit({ client: pgClient(app), original: await row(e1.receiptId), payload: { ...(await row(e1.receiptId)), expiry_date: null, expiry_choice: "none" }, username: "tester" });
    check("Edit Lot keeps them consistent: 'No device recorded' → device + choice 'device'; date → 'No expiry date'", [ed.ok, ed2.ok, (await row(e1.receiptId)).device, (await row(e1.receiptId)).device_choice, (await row(e1.receiptId)).expiry_date, (await row(e1.receiptId)).expiry_choice], [true, true, "VITROS", "device", null, "none"]);
    check("Log Use on a Lot with choices works", await q("select log_use(gen_random_uuid(), $1, 1, '2026-10-17', 'tester', '', false, true, false, null, 'tester') r", [e1.receiptId]), "ok");

    // ── release control still comes first ──
    await c.query("select ltc_maintenance_on('choices test')");
    const m = await S.saveReceipt({ client: pgClient(app), entry: entry() });
    await c.query("select ltc_maintenance_off('choices test')");
    const old = await conn("f".repeat(40));
    const o = await S.saveReceipt({ client: pgClient(old), entry: entry() });
    check("release control: maintenance and an older build are refused before anything else (clear messages, nothing saved)", [m.ok, /maintenance/.test(m.message), o.ok, /older version/.test(o.message)], [false, true, false, true]);
    await old.end();

    // ── re-run, rollback, re-apply ──
    await c.query(readRoot("MIGRATE_RECEIPT_CHOICES.sql"));
    check("re-running the migration never moves the cut-off (constraint unchanged)", (await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'reagents_receipt_choices'")).rows[0].d, def0);
    const keep = JSON.stringify((await c.query("select id, device_choice, expiry_choice from reagents order by id")).rows);
    await c.query(readRoot("ROLLBACK_RECEIPT_CHOICES.sql"));
    check("rollback: the rule is gone, the recorded choices are kept, and a receipt without choices is accepted again", [(await c.query("select count(*)::int n from pg_constraint where conname = 'reagents_receipt_choices'")).rows[0].n, JSON.stringify((await c.query("select id, device_choice, expiry_choice from reagents order by id")).rows) === keep, await ins({})], [0, true, "ok"]);
    await c.query(readRoot("MIGRATE_RECEIPT_CHOICES.sql"));
    check("re-applying after a rollback: VERIFY all PASS (Lots received meanwhile without choices count as legacy)", (await c.query(readRoot("VERIFY_RECEIPT_CHOICES.sql"))).rows.filter((r) => r.ord <= 99).every((r) => r.result === "PASS"), true);
    await app.end(); await c.end();
  } finally {
    await server.stop();
  }
}, { expectedChecks: 17 });
