// U2a — packaging schema foundation on real PostgreSQL (15 and 17), synthetic data.
// Pre-check → migration (twice) → verify → Lot packaging guard → constraints →
// Stock Count v2 + permanent snapshot guard → the app's own statements as anon →
// rollback (and rollback with real U2a-era snapshot lines). Ported from the U2a
// review suite; the Production replica is replaced by tests/fixtures/pgSeed.mjs and
// the business fingerprint by a full row-by-row dump of every inventory table.
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, U2A, err, inTx, asAnon, dumpAll } from "../helpers/pg.mjs";
import { seed, IDS } from "../fixtures/pgSeed.mjs";

const NEW_COLS = ["packaging_snapshot", "pack_unit", "units_per_carton"];

for (const version of PG_VERSIONS) suite(`U2a · packaging schema, guards and rollback (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const c = await server.connect(await server.createDatabase());
    await buildBaseSchema(c);
    await seed(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    const dump = () => dumpAll(c, { without: NEW_COLS });
    const dump0 = await dump();

    // ── 1. Pre-check (read-only) ──
    const pre = await inTx(c, async () => { await c.query("set transaction read only"); return (await c.query(readRoot("PRECHECK_PACKAGING.sql"))).rows; });
    check("PRECHECK_PACKAGING.sql runs read-only and passes on the pre-U2a state", pre.find((r) => r.ord == 99).result, "PASS");
    check("pre-check failures (none expected)", pre.filter((r) => r.result !== "PASS").map((r) => `${r.ord} ${r.check_name}: ${r.actual}`), []);

    // ── 2. Apply U2a (twice: safe to re-run) ──
    const applyErr = [];
    for (const round of [1, 2]) for (const f of U2A) { const e = await err(c, readRoot(f)); if (e) applyErr.push(`${round}:${f}:${e}`); }
    check("U2a files apply in order, twice, without error", applyErr, []);
    const post = await inTx(c, async () => { await c.query("set transaction read only"); return (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows; });
    check("VERIFY_PACKAGING.sql runs read-only and passes", post.find((r) => r.ord == 99).result, "PASS");
    check("verify failures (none expected)", post.filter((r) => r.result !== "PASS").map((r) => `${r.ord} ${r.check_name}: ${r.actual}`), []);
    check("pre-check fingerprints = verify fingerprints", pre.filter((r) => r.ord >= 31 && r.ord <= 35).map((r) => r.actual), post.filter((r) => r.ord >= 31 && r.ord <= 35).map((r) => r.actual));
    check("every existing row unchanged by the migration (all columns except the new, empty ones)", JSON.stringify(await dump()) === JSON.stringify(dump0), true);
    check("new columns empty: no pack_unit backfilled, every count line a legacy line", (await c.query("select (select count(*) from reagents where pack_unit is not null)::int a, (select count(*) from inventory_count_items where packaging_snapshot is not null or pack_unit is not null or units_per_carton is not null)::int b")).rows[0], { a: 0, b: 0 });

    const lot = async (id) => (await c.query("select * from reagents where id = $1", [id])).rows[0];
    const K = await lot(IDS.pHist), logsOnly = await lot(IDS.logsOnly), both = await lot(IDS.both), free = await lot(IDS.free), freePacked = await lot(IDS.freePack);
    const upd = (id, set) => err(c, `update reagents set ${set} where id = $1`, [id]);

    // ── 3. Lot packaging guard ──
    const L3 = async (l) => inTx(c, async () => [await upd(l.id, "unit = 'other'"), await upd(l.id, "units_per_carton = 7"), await upd(l.id, l.units_per_carton == null ? "units_per_carton = 4" : "units_per_carton = null")]);
    for (const [label, l] of [["count lines only", K], ["usage logs only", logsOnly], ["logs and count lines", both]]) {
      check(`lot with ${label}: unit / box size / packaging on-off refused`, (await L3(l)).map((x) => x && x.split("/")[0]), ["packaging_locked", "packaging_locked", "packaging_locked"]);
    }
    check("lot with history: pack_unit NULL → value refused (D3)", await inTx(c, () => upd(both.id, "pack_unit = 'carton'")), "packaging_locked/pack_unit");
    check("lot with history: unit change in case/spaces only allowed (as Edit Lot)", await inTx(c, async () => [await upd(K.id, "unit = 'piece'"), await upd(K.id, "unit = '  PIECE  '"), await upd(K.id, "unit = E'Piece\\u00a0'")]), [null, null, null]);
    check("lot with history: resending unchanged unit / box size passes", await inTx(c, () => upd(K.id, `unit = '${K.unit}', units_per_carton = ${K.units_per_carton}`)), null);
    check("lot with history: same box size written as 3.0 is not a change", await inTx(c, () => upd(K.id, "units_per_carton = 3.0")), null);
    check("an undone usage log still counts as history", await inTx(c, async () => {
      await c.query("insert into reagents (id, name, department, lot_number, unit, quantity_received, current_quantity, added_by) values ('00000000-0000-4000-8000-0000000000a1', 'T', 'X', 'T1', 'box', 5, 5, 'T')");
      await c.query("insert into consumption_logs (reagent_id, amount, date, used_by, deleted) values ('00000000-0000-4000-8000-0000000000a1', 1, current_date, 'T', true)");
      return upd("00000000-0000-4000-8000-0000000000a1", "unit = 'bottle'");
    }), "packaging_locked/unit");
    check("lot WITHOUT history: unit, box size, packaging on/off and pack_unit all editable", await inTx(c, async () => [await upd(free.id, "unit = 'bottle'"), await upd(free.id, "units_per_carton = 6"), await upd(free.id, "pack_unit = 'pack'"), await upd(free.id, "units_per_carton = null, pack_unit = null")]), [null, null, null, null]);
    check("lot WITHOUT history (packaged): box size change and pack_unit allowed", await inTx(c, async () => [await upd(freePacked.id, "units_per_carton = 9"), await upd(freePacked.id, "pack_unit = 'kit'")]), [null, null]);
    check("guard never fires on quantity / discard / restore / active / other updates (lot with history)", await inTx(c, async () => [
      await upd(both.id, "current_quantity = current_quantity - 1"),
      await upd(both.id, "deleted = true, deleted_by = 'T', deleted_at = now(), discard_reason = 'Expired', discard_note = ''"),
      await upd(both.id, "deleted = false, deleted_by = null, deleted_at = null"),
      await upd(both.id, "active_on_device = not active_on_device"),
      await upd(both.id, "quantity_received = quantity_received + 1, low_stock_threshold = 3, expiry_date = '2030-01-01', lot_number = lot_number || 'x'"),
    ]), [null, null, null, null, null]);

    // ── 4. Constraints (no whole-number check yet — D2, planned for U2d-3) ──
    check("pack_unit constraint: blank / >40 chars / without box size / equal to unit (case, spaces) refused", await inTx(c, async () => {
      const out = [];
      for (const v of ["'   '", `'${"x".repeat(41)}'`]) out.push((await err(c, `update reagents set units_per_carton = 4, pack_unit = ${v} where id = $1`, [free.id]))?.includes("reagents_pack_unit_valid"));
      out.push((await err(c, "update reagents set units_per_carton = null, pack_unit = 'box' where id = $1", [free.id]))?.includes("reagents_pack_unit_valid"));
      out.push((await err(c, "update reagents set units_per_carton = 4, pack_unit = upper(unit) || '  ' where id = $1", [free.id]))?.includes("reagents_pack_unit_valid"));
      return out;
    }), [true, true, true, true]);
    check("D2: fractional / zero / negative box sizes are still accepted by the database today", await inTx(c, async () => [
      await err(c, "insert into reagents (name, department, lot_number, unit, quantity_received, current_quantity, added_by, units_per_carton) values ('T', 'X', 'a', 'bottle', 5, 5, 'T', 2.5)"),
      await err(c, "insert into reagents (name, department, lot_number, unit, quantity_received, current_quantity, added_by, units_per_carton) values ('T', 'X', 'b', 'bottle', 5, 5, 'T', 0)"),
      await err(c, "insert into reagents (name, department, lot_number, unit, quantity_received, current_quantity, added_by, units_per_carton) values ('T', 'X', 'c', 'bottle', 5, 5, 'T', -1)"),
    ]), [null, null, null]);
    check("D2: no constraint anywhere tests units_per_carton for whole numbers", (await c.query("select count(*)::int n from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname in ('reagents','inventory_count_items') and c.contype = 'c' and pg_get_constraintdef(c.oid) ~* 'trunc|units_per_carton\\s*>'")).rows[0].n, 0);
    check("count-line snapshot constraint: partial legacy/snapshot combinations refused", await inTx(c, async () => {
      const cid = (await c.query("insert into inventory_counts (department, started_by, status) values ('ZZtest', 'T', 'completed') returning id")).rows[0].id;
      const ins = (v) => err(c, `insert into inventory_count_items (count_id, reagent_name, lot_number, department, unit, expected_quantity, packaging_snapshot, pack_unit, units_per_carton) values ($1, 'n', 'l', 'd', 'box', 1, ${v})`, [cid]);
      return [(await ins("null, 'box', null"))?.includes("snapshot_valid"), (await ins("null, null, 3"))?.includes("snapshot_valid"), (await ins("1, 'carton', null"))?.includes("snapshot_valid"), (await ins("2, null, null"))?.includes("snapshot_valid"), await ins("1, null, null"), await ins("1, 'carton', 10"), await ins("1, null, 2.5")];
    }), [true, true, true, true, null, null, null]);

    // ── 5. stock_count_start v2 and the count-line guards ──
    const startRes = await inTx(c, async () => {
      await c.query("set local role anon");
      const res = (await c.query("select stock_count_start('Chemistry', 'tester') r")).rows[0].r;
      await c.query("reset role");
      const lines = (await c.query("select i.*, r.units_per_carton lot_upc, r.pack_unit lot_pack from inventory_count_items i join reagents r on r.id = i.reagent_id where i.count_id = $1", [res.count.id])).rows;
      const legacy = (await c.query("select count(*)::int n from inventory_count_items where count_id <> $1 and (packaging_snapshot is not null or pack_unit is not null or units_per_carton is not null)", [res.count.id])).rows[0].n;
      const ln = lines.find((l) => Number(l.expected_quantity) > 0);
      await c.query("set local role anon");
      const counted = await err(c, "update inventory_count_items set counted_quantity = $2, counted_at = now(), counted_by = 'tester' where id = $1", [ln.id, Number(ln.expected_quantity) - 1]);
      const resolved = (await c.query("select stock_count_resolve($1, 'corrected', 'tester', $2, $3) r", [ln.id, ln.expected_quantity, Number(ln.expected_quantity) - 1])).rows[0].r;
      const tamper = [];
      for (const set of ["unit = 'other'", "packaging_snapshot = null", "pack_unit = 'crate'", "units_per_carton = 99"]) tamper.push(await err(c, `update inventory_count_items set ${set} where id = $1`, [lines.find((l) => l.units_per_carton !== null)?.id || ln.id]));
      const complete = await err(c, "update inventory_counts set status = 'completed', completed_by = 'tester', completed_at = now() where id = $1", [res.count.id]);
      return { res, lines, legacy, counted, resolved, tamper, complete };
    });
    check("stock_count_start v2 (as anon): ok, every new line has packaging_snapshot = 1 and the lot's own packaging", [startRes.res.status, startRes.lines.length > 0, startRes.lines.every((l) => l.packaging_snapshot === 1 && String(l.units_per_carton) === String(l.lot_upc) && l.pack_unit === l.lot_pack)], ["ok", true, true]);
    check("stock_count_start v2: returned lines carry the snapshot fields; packaged lots snapshot their box size", [Object.keys(startRes.res.items[0]).includes("packaging_snapshot"), startRes.lines.filter((l) => l.units_per_carton !== null).length > 0], [true, true]);
    check("stock_count_start v2: existing (legacy) lines untouched", startRes.legacy, 0);
    check("client during a count: counted update ok, resolve ok (line JSON includes snapshot), complete ok", [startRes.counted, startRes.resolved.status, startRes.resolved.line.packaging_snapshot, startRes.complete], [null, "ok", 1, null]);
    check("count-line guard: unit / snapshot / pack_unit / box size refused on a new line", startRes.tamper.map((x) => x && x.split("/").slice(0, 2).join("/")), ["evidence_field_protected/unit", "evidence_field_protected/packaging_snapshot", "evidence_field_protected/pack_unit", "evidence_field_protected/units_per_carton"]);
    check("count-line guard: a legacy line can't be given packaging (NULL → value) or a new unit", await inTx(c, async () => [await err(c, "update inventory_count_items set packaging_snapshot = 1 where id = $1", [IDS.linePHist]), await err(c, "update inventory_count_items set packaging_snapshot = 1, units_per_carton = 3 where id = $1", [IDS.linePHist]), await err(c, "update inventory_count_items set unit = 'box' where id = $1", [IDS.linePHist])].map((x) => x && x.split("/").slice(0, 2).join("/"))), ["evidence_field_protected/packaging_snapshot", "evidence_field_protected/packaging_snapshot", "evidence_field_protected/unit"]);
    check("count-line guard: existing rules unchanged (resolved line can't reopen; counted_quantity frozen)", await inTx(c, async () => [await err(c, "update inventory_count_items set resolved = false where id = $1", [IDS.lineBoth]), await err(c, "update inventory_count_items set counted_quantity = counted_quantity + 1 where id = $1", [IDS.lineBoth])].map((x) => x && x.split("/").slice(0, 2).join("/"))), ["evidence_field_protected/resolved", "evidence_field_protected/counted_quantity"]);
    check("in-progress count can still be deleted (lines cascade)", await inTx(c, async () => { await c.query("set local role anon"); const r = (await c.query("select stock_count_start('Hematology', 'tester') r")).rows[0].r; const e = await err(c, "delete from inventory_counts where id = $1", [r.count.id]); return [r.status, e, (await c.query("select count(*)::int n from inventory_count_items where count_id = $1", [r.count.id])).rows[0].n]; }), ["ok", null, 0]);
    check("lots counted in a new count become history: packaging then locked", await inTx(c, async () => { await c.query("set local role anon"); await c.query("select stock_count_start('Chemistry', 'tester')"); await c.query("reset role"); return upd(free.id, "unit = 'other'"); }).then((x) => x && x.split("/")[0]), "packaging_locked");

    // ── 6. The app's own statements (as App.jsx sends them, as anon) ──
    const ops = await asAnon(c, async () => {
      const out = {};
      const newId = (await c.query("insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, expiry_date, date_added, added_by, low_stock_threshold, units_per_carton, intact_container, complete_compound, expiration_validity, lot_matches_kit, storage_condition_ok, receiving_notes, inspection_notes) values ('U2a test', 'Chemistry', 'Reagent', 'Analyzer 1', 'N1', 'bottle', 12, 12, '2027-01-01', current_date, 'tester', 2, 6, true, true, true, true, true, '', '') returning id")).rows[0].id;
      out.receive = "ok";
      out.editNoHistory = await err(c, "update reagents set lot_number = 'N1', unit = 'Bottle', quantity_received = 12, current_quantity = 12, expiry_date = '2027-01-01', low_stock_threshold = 2, units_per_carton = 4, edited_by = 'tester', edited_at = now() where id = $1", [newId]);
      out.consume = await err(c, "update reagents set current_quantity = 11 where id = $1", [newId]);
      const logId = (await c.query("insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id, date_provenance) values ($1, 1, current_date, 'tester', '', false, false, null, 'manual') returning id", [newId])).rows[0].id;
      out.logInsert = "ok";
      out.editAfterHistorySameValues = await err(c, "update reagents set lot_number = 'N1', unit = 'Bottle', quantity_received = 12, current_quantity = 11, expiry_date = '2027-01-01', low_stock_threshold = 2, units_per_carton = 4, edited_by = 'tester', edited_at = now() where id = $1", [newId]);
      out.editAfterHistoryQuantityOnly = await err(c, "update reagents set lot_number = 'N1', unit = 'Bottle', quantity_received = 13, current_quantity = 10, expiry_date = '2027-02-01', low_stock_threshold = 3, units_per_carton = 4, edited_by = 'tester', edited_at = now() where id = $1", [newId]);
      out.editAfterHistoryBoxSize = (await err(c, "update reagents set lot_number = 'N1', unit = 'Bottle', quantity_received = 13, current_quantity = 10, expiry_date = '2027-02-01', low_stock_threshold = 3, units_per_carton = 6, edited_by = 'tester', edited_at = now() where id = $1", [newId]))?.split("/")[0];
      out.undo = await err(c, "update consumption_logs set deleted = true, deleted_by = 'tester', deleted_at = now() where id = $1", [logId]);
      out.undoRestore = await err(c, "update reagents set current_quantity = 11 where id = $1", [newId]);
      out.discard = await err(c, "update reagents set deleted = true, deleted_by = 'tester', deleted_at = now(), discard_reason = 'Expired', discard_note = '' where id = $1", [newId]);
      out.restore = await err(c, "update reagents set deleted = false, deleted_by = null, deleted_at = null where id = $1", [newId]);
      out.purgeLog = await err(c, "delete from consumption_logs where id = $1", [logId]);
      out.purgeLot = await err(c, "delete from reagents where id = $1", [newId]);
      return out;
    });
    check("app operations work: receive, edit, consume, log, undo, discard, restore, purge — the only refusal is a box-size change on a lot with history", ops, { receive: "ok", editNoHistory: null, consume: null, logInsert: "ok", editAfterHistorySameValues: null, editAfterHistoryQuantityOnly: null, editAfterHistoryBoxSize: "packaging_locked", undo: null, undoRestore: null, discard: null, restore: null, purgeLog: null, purgeLot: null });
    check("existing data still unchanged after all test transactions", JSON.stringify(await dump()) === JSON.stringify(dump0), true);

    // ── 7. Rollback: back to the exact pre-U2a functions; columns kept (D5) ──
    const rc = await server.connect(await server.createDatabase());
    await buildBaseSchema(rc);
    const defs = async (cl) => (await cl.query("select pg_get_functiondef(to_regprocedure('public.stock_count_start(text, text)')) s, pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_evidence()')) g, (select string_agg(grantee || ':' || privilege_type, ',' order by grantee) from information_schema.routine_privileges where routine_name = 'stock_count_start') p")).rows[0];
    const refDefs = await defs(rc);
    check("U2a never changed the Evidence Guard: its count-line function is byte-identical to a pre-U2a install", (await defs(c)).g, refDefs.g);
    check("ROLLBACK_PACKAGING.sql runs, twice", [await err(c, readRoot("ROLLBACK_PACKAGING.sql")), await err(c, readRoot("ROLLBACK_PACKAGING.sql"))], [null, null]);
    check("after rollback: stock_count_start, Evidence Guard function and grants are byte-identical to a fresh pre-U2a install", await defs(c), refDefs);
    check("after rollback: lot guard gone; Evidence Guard AND permanent snapshot guard present; columns and constraints kept", (await c.query("select (select count(*) from pg_trigger where tgname = 'reagents_packaging_guard')::int lot_guard, (select count(*) from pg_trigger where tgname in ('consumption_logs_evidence_guard','inventory_count_items_evidence_guard'))::int ev, (select count(*) from pg_trigger where tgname = 'inventory_count_items_snapshot_guard' and tgenabled <> 'D')::int snap, (select count(*) from information_schema.columns where column_name = 'packaging_snapshot')::int col, (select count(*) from pg_constraint where conname in ('reagents_pack_unit_valid','inventory_count_items_packaging_snapshot_valid'))::int con")).rows[0], { lot_guard: 0, ev: 2, snap: 1, col: 1, con: 2 });
    const vr = Object.fromEntries((await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows.map((r) => [r.ord, r.result]));
    check("after rollback, VERIFY_PACKAGING.sql: exactly checks 6, 10, 11 fail (lot guard / start v2 removed); 9 (snapshot guard) still PASS", [Object.entries(vr).filter(([o, r]) => r === "FAIL" && o !== "99").map(([o]) => +o), vr[9]], [[6, 10, 11], "PASS"]);
    check("after rollback: v1 start works (new lines without snapshot)", await inTx(c, async () => { await c.query("set local role anon"); const r = (await c.query("select stock_count_start('Chemistry', 'tester') r")).rows[0].r; return [r.status, r.items.every((i) => i.packaging_snapshot === null)]; }), ["ok", true]);
    check("re-apply U2a after rollback works and verifies", await (async () => { for (const f of U2A) { const e = await err(c, readRoot(f)); if (e) return e; } return (await c.query(readRoot("VERIFY_PACKAGING.sql"))).rows.find((r) => r.ord == 99).result; })(), "PASS");
    check("final: every row unchanged", JSON.stringify(await dump()) === JSON.stringify(dump0), true);
    await rc.end();

    // ── 8. Rollback with committed U2a-era snapshots (separate database) ──
    const rb = await server.connect(await server.createDatabase());
    await buildBaseSchema(rb);
    await seed(rb);
    await rb.query("grant select, insert, update, delete on all tables in schema public to anon");
    for (const f of U2A) await rb.query(readRoot(f));
    await rb.query("set role anon");
    const v2 = (await rb.query("select stock_count_start('Chemistry', 'tester') r")).rows[0].r;
    const v2ln = v2.items.find((i) => i.units_per_carton !== null);
    await rb.query("update inventory_count_items set counted_quantity = expected_quantity, counted_at = now(), counted_by = 'tester' where count_id = $1", [v2.count.id]);
    await rb.query("update inventory_counts set status = 'completed', completed_by = 'tester', completed_at = now() where id = $1", [v2.count.id]);
    await rb.query("reset role");
    check("rb: a committed U2a-era count exists with real packaging snapshots", [v2.status, v2ln?.packaging_snapshot, v2ln?.units_per_carton !== null], ["ok", 1, true]);
    const rbErr = async (sql, params) => { await rb.query("begin"); try { await rb.query(sql, params); return null; } catch (e) { return `${e.message}/${e.detail}`; } finally { await rb.query("rollback"); } };
    const attack = async (lineId) => [
      await rbErr("update inventory_count_items set unit = 'tampered' where id = $1", [lineId]),
      await rbErr("update inventory_count_items set packaging_snapshot = case when packaging_snapshot is null then 1 else null end where id = $1", [lineId]),
      await rbErr("update inventory_count_items set pack_unit = 'crate', units_per_carton = coalesce(units_per_carton, 7) where id = $1", [lineId]),
      await rbErr("update inventory_count_items set units_per_carton = coalesce(units_per_carton, 0) + 1 where id = $1", [lineId]),
    ];
    const refused = ["evidence_field_protected/unit", "evidence_field_protected/packaging_snapshot", "evidence_field_protected/pack_unit", "evidence_field_protected/units_per_carton"];
    for (const round of ["after U2a", "after rollback", "after rollback run twice"]) {
      if (round !== "after U2a") await rb.query(readRoot("ROLLBACK_PACKAGING.sql"));
      check(`rb ${round}: U2a-era snapshot line — unit / packaging_snapshot / pack_unit / units_per_carton all refused`, await attack(v2ln.id), refused);
      check(`rb ${round}: legacy line — unit change and every NULL → value backfill refused`, await attack(IDS.linePHist), refused);
    }
    await rb.query("set role anon");
    const v1 = (await rb.query("select stock_count_start('Hematology', 'tester') r")).rows[0].r;
    await rb.query("reset role");
    check("rb after rollback: v1 start creates lines without snapshot (NULL)", [v1.status, v1.items.every((i) => i.packaging_snapshot === null && i.pack_unit === null && i.units_per_carton === null)], ["ok", true]);
    check("rb after rollback: a line created by v1 can't be given a snapshot or a new unit either", await attack(v1.items[0].id), refused);
    check("rb after rollback: every Evidence Guard rule still enforced (reopen, counted_quantity, resolution_details, resolved_by)", [
      await rbErr("update inventory_count_items set resolved = false where id = $1", [IDS.lineBoth]),
      await rbErr("update inventory_count_items set counted_quantity = counted_quantity + 1 where id = $1", [IDS.lineBoth]),
      await rbErr("update inventory_count_items set resolution_details = '{}' where id = $1", [IDS.lineBoth]),
      await rbErr("update inventory_count_items set resolved_by = 'x' where id = $1", [IDS.lineBoth]),
    ].map((x) => x && x.split("/")[0]), Array(4).fill("evidence_field_protected"));
    check("rb after rollback: ordinary count work still allowed (counting an unresolved v1 line)", await rbErr("update inventory_count_items set counted_quantity = 1, counted_at = now(), counted_by = 'tester' where id = $1", [v1.items[0].id]), null);
    await rb.query(readRoot("ADD_EVIDENCE_GUARD.sql"));
    check("rb: re-running ADD_EVIDENCE_GUARD.sql (v1) doesn't remove snapshot protection", await attack(v2ln.id), refused);
    for (const f of U2A) await rb.query(readRoot(f));
    check("rb: re-apply U2a → VERIFY passes except 14 (real snapshot lines exist) and 15 (the v1 count left open) — protection holds", [(await rb.query(readRoot("VERIFY_PACKAGING.sql"))).rows.filter((r) => r.result === "FAIL" && r.ord != 99).map((r) => +r.ord), await attack(v2ln.id)], [[14, 15], refused]);
    await rb.end();
    await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 55 });
