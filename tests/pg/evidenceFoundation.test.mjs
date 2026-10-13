// Batch A — Evidence Foundation (ADD_EVIDENCE_FOUNDATION.sql) on real PostgreSQL:
// schema, FK/CHECK/index, historical rows untouched, every app write pattern still
// works, then the Batch A guard (as committed in 94d2df2, copied to
// tests/fixtures/historical-sql so no git history is needed) and its write-once
// rules, FK ON DELETE SET NULL, and the documented old-client hazard. The current
// (B2) guard is tested in evidenceGuardCompat.test.mjs. Ported from runA.mjs;
// identifiers replaced by synthetic ones.
import { readFileSync } from "node:fs";
import { suite, check, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";

const BATCH_A_GUARD = readFileSync(rootPath("tests", "fixtures", "historical-sql", "ADD_EVIDENCE_GUARD.batch-a.94d2df2.sql"), "utf8");
const CORR = "Unlogged (physical count)";

for (const version of PG_VERSIONS) suite(`Batch A · Evidence Foundation and Batch A guard (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
  const db = await server.createDatabase();
  const connect = () => server.connect(db);
  const admin = await connect();
  await ensureRoles(admin);
  await admin.query(`
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create table reagents (id uuid primary key default gen_random_uuid(), name text, lot_number text, department text, device text,
      current_quantity numeric not null default 0, deleted boolean not null default false, deleted_by text, deleted_at timestamptz, active_on_device boolean not null default false);
    create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
    create table consumption_logs (
      id uuid primary key default gen_random_uuid(), reagent_id uuid references reagents(id) on delete cascade,
      amount numeric not null, date date not null, used_by text not null, note text, tested_by_qc boolean not null default false,
      active_device_changed boolean not null default false, previous_active_lot_id uuid,
      deleted boolean not null default false, deleted_by text, deleted_at timestamptz, edited_by text, edited_at timestamptz,
      created_at timestamptz not null default now());
    create table audit_log (id uuid primary key default gen_random_uuid(), action text, entity text, description text, performed_by text, performed_at timestamptz default now());
    grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`);
  for (const f of ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"]) await admin.query(readRoot(f));
  await admin.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
  // Pre-existing "historical" rows, created BEFORE the new migration.
  await admin.query(`
    insert into reagents (id, name, lot_number, department, device, current_quantity) values
      ('00000000-0000-0000-0000-0000000000a1', 'Analyte C', 'TC-372', 'Chemistry', 'Analyzer 1', 6),
      ('00000000-0000-0000-0000-0000000000a2', 'Wash W', 'TR-065', 'Hematology', 'Analyzer 2', 15);
    insert into inventory_counts (id, department, status, started_by, started_at, completed_by, completed_at)
      values ('00000000-0000-0000-0000-0000000000c1', 'Chemistry', 'completed', 'staff-b', '2026-09-16T13:12:00Z', 'staff-b', '2026-09-16T13:51:00Z');
    insert into inventory_count_items (id, count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity, resolved, resolution_note)
      values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Analyte C', 'TC-372', 'Chemistry', 'Piece', 25, 6, true, 'Logged as usage on 2026-09-16');
    insert into consumption_logs (id, reagent_id, amount, date, used_by, note) values
      ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 19, '2026-09-16', '${CORR}', 'Retroactively logged — found missing during a physical count.'),
      ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a2', 1, '2026-09-10', 'staff-a', null);`);
  const fp = async () => (await admin.query("select md5(string_agg(t::text, '|' order by t::text)) h from (select id, reagent_id, amount, date, used_by, note, deleted from consumption_logs where id in ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2') union all select id, reagent_id, expected_quantity, null, reagent_name, resolution_note, resolved from inventory_count_items where id = '00000000-0000-0000-0000-0000000000d1' union all select id, null, current_quantity, null, name, lot_number, deleted from reagents) t")).rows[0].h;
  const before = await fp();

  // ── Part 1 migration (twice: idempotent) ──
  let e1 = null, e2 = null; try { await admin.query(readRoot("ADD_EVIDENCE_FOUNDATION.sql")); } catch (e) { e1 = e.message; } try { await admin.query(readRoot("ADD_EVIDENCE_FOUNDATION.sql")); } catch (e) { e2 = e.message; }
  check("A1. ADD_EVIDENCE_FOUNDATION.sql runs unchanged, and re-runs (idempotent)", [e1, e2], [null, null]);
  const cols = (await admin.query(`select table_name, column_name, data_type, is_nullable from information_schema.columns
    where (table_name, column_name) in (('consumption_logs','source_count_item_id'),('consumption_logs','date_provenance'),('inventory_count_items','counted_at'),('inventory_count_items','counted_by'),('inventory_count_items','resolved_at'),('inventory_count_items','resolved_by'),('inventory_count_items','resolution_details')) order by 1, 2`)).rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}`);
  check("schema: all 7 fields with the right types, all nullable", cols, ["consumption_logs.date_provenance:text:YES", "consumption_logs.source_count_item_id:uuid:YES", "inventory_count_items.counted_at:timestamp with time zone:YES", "inventory_count_items.counted_by:text:YES", "inventory_count_items.resolution_details:jsonb:YES", "inventory_count_items.resolved_at:timestamp with time zone:YES", "inventory_count_items.resolved_by:text:YES"]);
  const fk = (await admin.query(`select confrelid::regclass::text tgt, confdeltype from pg_constraint where conrelid = 'consumption_logs'::regclass and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'consumption_logs'::regclass and attname = 'source_count_item_id')]::smallint[]`)).rows[0];
  check("schema: FK → inventory_count_items, ON DELETE SET NULL ('n')", [fk?.tgt, fk?.confdeltype], ["inventory_count_items", "n"]);
  check("schema: partial index on source_count_item_id", (await admin.query("select indexdef from pg_indexes where indexname = 'consumption_logs_source_count_item_idx'")).rows[0]?.indexdef.replace(/public\./g, ""), "CREATE INDEX consumption_logs_source_count_item_idx ON consumption_logs USING btree (source_count_item_id) WHERE (source_count_item_id IS NOT NULL)");
  check("schema: provenance CHECK exists", (await admin.query("select count(*)::int n from pg_constraint where conname = 'consumption_logs_date_provenance_check'")).rows[0].n, 1);
  check("existing rows keep NULL in every new field", (await admin.query("select (select count(*) from consumption_logs where source_count_item_id is not null or date_provenance is not null)::int + (select count(*) from inventory_count_items where counted_at is not null or counted_by is not null or resolved_at is not null or resolved_by is not null or resolution_details is not null)::int n")).rows[0].n, 0);
  check("existing business values unchanged by part 1", await fp(), before);

  // anon client = the app's PostgREST role
  const A = await connect(); await A.query("set role anon");
  const tryQ = async (sql, params = []) => { try { const r = await A.query(sql, params); return { ok: true, rows: r.rows, n: r.rowCount }; } catch (e) { return { ok: false, code: e.code, msg: e.message, detail: e.detail }; } };
  const res = (r) => (r.ok ? "OK" : `${r.code}:${r.msg}${r.detail ? "/" + r.detail : ""}`);

  // ── Old-app compatibility (current production code paths, without the new fields) ──
  async function oldAppFlows(label) {
    const out = {};
    out.manualInsert = res(await tryQ(`insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id) values ('00000000-0000-0000-0000-0000000000a2', 2, '2026-10-05', 'staff-a', 'x', false, false, null) returning id`));
    const mid = (await A.query("select id from consumption_logs where used_by = 'staff-a' order by created_at desc limit 1")).rows[0].id;
    out.manualEdit = res(await tryQ(`update consumption_logs set amount = 3, date = '2026-10-04', used_by = 'staff-b', note = 'y', tested_by_qc = true, edited_by = 'staff-a', edited_at = now() where id = $1`, [mid]));
    out.manualUndo = res(await tryQ(`update consumption_logs set deleted = true, deleted_by = 'staff-a', deleted_at = now() where id = $1`, [mid]));
    out.manualSpreadEdit = res(await tryQ(`with d as (delete from consumption_logs where id = $1 returning reagent_id) insert into consumption_logs (reagent_id, amount, date, used_by) select reagent_id, 1, '2026-10-01', 'staff-b' from d`, [mid]));
    // startCount → items → saveCount → resolve (old payloads) → finish
    const cnt = (await A.query(`insert into inventory_counts (department, started_by) values ('Hematology', 'staff-a') returning id`)).rows[0].id;
    const it = (await A.query(`insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, '00000000-0000-0000-0000-0000000000a2', 'Wash W', 'TR-065', 'Hematology', 'box', 15) returning id`, [cnt])).rows[0].id;
    out.saveCount = res(await tryQ(`update inventory_count_items set counted_quantity = 13 where id = $1`, [it]));
    const corr = await tryQ(`insert into consumption_logs (reagent_id, amount, date, used_by, note) values ('00000000-0000-0000-0000-0000000000a2', 2, '2026-10-05', '${CORR}', 'Retroactively logged — found missing during a physical count.') returning id`);
    out.correctionInsert = res(corr);
    out.linkIds = res(await tryQ(`update inventory_count_items set consumption_log_ids = array[$1::uuid] where id = $2`, [corr.rows[0].id, it]));
    out.reagentQty = res(await tryQ(`update reagents set current_quantity = 13 where id = '00000000-0000-0000-0000-0000000000a2'`));
    out.resolve = res(await tryQ(`update inventory_count_items set resolved = true, resolution_note = 'Logged as usage on 2026-10-05' where id = $1`, [it]));
    out.finish = res(await tryQ(`update inventory_counts set status = 'completed', completed_by = 'staff-a', completed_at = now() where id = $1`, [cnt]));
    // Edit dates: insert replacement rows, delete old rows, rewrite note + ids
    const repl = await tryQ(`insert into consumption_logs (reagent_id, amount, date, used_by, note) values ('00000000-0000-0000-0000-0000000000a2', 1, '2026-09-28', '${CORR}', 'Retroactively logged — spread …'), ('00000000-0000-0000-0000-0000000000a2', 1, '2026-10-05', '${CORR}', 'Retroactively logged — spread …') returning id`);
    out.editDatesInsert = res(repl);
    out.editDatesDeleteOld = res(await tryQ(`delete from consumption_logs where id = $1`, [corr.rows[0].id]));
    out.editDatesNote = res(await tryQ(`update inventory_count_items set resolution_note = 'Logged as usage spread from 2026-09-28 to 2026-10-05' where id = $1`, [it]));
    out.editDatesIds = res(await tryQ(`update inventory_count_items set consumption_log_ids = $1::uuid[] where id = $2`, [repl.rows.map((r) => r.id), it]));
    // delete an in-progress count (cascade)
    const cnt2 = (await A.query(`insert into inventory_counts (department, started_by) values ('Chemistry', 'staff-a') returning id`)).rows[0].id;
    await A.query(`insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, '00000000-0000-0000-0000-0000000000a1', 'Analyte C', 'TC-372', 'Chemistry', 'Piece', 6)`, [cnt2]);
    out.deleteInProgressCount = res(await tryQ(`delete from inventory_counts where id = $1`, [cnt2]));
    out.linesCascaded = (await A.query(`select count(*)::int n from inventory_count_items where count_id = $1`, [cnt2])).rows[0].n;
    return out;
  }
  const allOk = (o) => Object.entries(o).filter(([k, v]) => k !== "linesCascaded" && v !== "OK").map(([k, v]) => `${k}=${v}`);
  const before2 = await oldAppFlows("part1");
  check("compat (part 1 only): every current-app write pattern still works (manual insert/edit/undo/spread, start, saveCount, correction insert, ids, qty, resolve, finish, Edit dates, delete in-progress)", [allOk(before2), before2.linesCascaded], [[], 0]);
  check("compat (part 1 only): old-app generic edit of a correction log still works (no guard yet)", res(await tryQ(`update consumption_logs set amount = 19, edited_by = 'staff-a' where id = '00000000-0000-0000-0000-0000000000e1'`)), "OK");

  // ── Provenance CHECK ──
  const pv = async (v) => res(await tryQ(`insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ('00000000-0000-0000-0000-0000000000a2', 1, '2026-10-05', 'staff-a', $1)`, [v]));
  check("provenance: NULL accepted", await pv(null), "OK");
  check("provenance: all 6 approved values accepted", await (async () => { const o = []; for (const v of ["manual", "count_exact", "count_exact_default", "count_spread_window", "count_redated", "historical_unknown"]) o.push(await pv(v)); return o; })(), ["OK", "OK", "OK", "OK", "OK", "OK"]);
  check("provenance: invalid value rejected by the CHECK (23514)", (await tryQ(`insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ('00000000-0000-0000-0000-0000000000a2', 1, '2026-10-05', 'staff-a', 'exact')`)).code, "23514");

  check("database encoding is UTF8 (as Supabase)", (await admin.query("select pg_encoding_to_char(encoding) e from pg_database where datname = current_database()")).rows[0].e, "UTF8");
  // Part-1 compat flows changed reagent quantities, so re-baseline right before part 2.
  const beforeGuard = await fp();
  // ── Part 2 migration (guards) ──
  let g1 = null, g2 = null; try { await admin.query(BATCH_A_GUARD); } catch (e) { g1 = e.message; } try { await admin.query(BATCH_A_GUARD); } catch (e) { g2 = e.message; }
  check("A2. ADD_EVIDENCE_GUARD.sql runs unchanged, and re-runs (idempotent)", [g1, g2], [null, null]);
  check("guard triggers + functions exist (security definer)", (await admin.query(`select (select count(*) from pg_trigger where tgname in ('consumption_logs_evidence_guard','inventory_count_items_evidence_guard') and not tgisinternal)::int t, (select count(*) from pg_proc where proname in ('consumption_logs_guard_evidence','inventory_count_items_guard_evidence') and prosecdef)::int f`)).rows[0], { t: 2, f: 2 });
  check("open-count scope trigger still present and unchanged", (await admin.query("select count(*)::int n from pg_trigger where tgname = 'inventory_counts_open_scope'")).rows[0].n, 1);
  check("historical rows unchanged by part 2 (fingerprint vs. pre-migration)", await fp(), beforeGuard);

  // ── Count-derived log guard ──
  const mkCount = async () => { const c = (await A.query(`insert into inventory_counts (department, started_by, status, completed_at) values ('All lab', 'T', 'completed', now()) returning id`)).rows[0].id; const i = (await A.query(`insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity) values ($1, '00000000-0000-0000-0000-0000000000a1', 'Analyte C', 'TC-372', 'All lab', 'Piece', 5, 3) returning id`, [c])).rows[0].id; return { c, i }; };
  const { c: cA, i: itemA } = await mkCount(); const { i: itemB } = await mkCount();
  const mkLog = async (src, used = CORR, prov = null) => (await A.query(`insert into consumption_logs (reagent_id, amount, date, used_by, source_count_item_id, date_provenance) values ('00000000-0000-0000-0000-0000000000a1', 2, '2026-10-05', $1, $2, $3) returning id`, [used, src, prov])).rows[0].id;
  const upd = async (id, set, params = []) => res(await tryQ(`update consumption_logs set ${set} where id = $1`, [id, ...params]));
  const linked = await mkLog(itemA, CORR, "count_spread_window");
  check("linked correction: amount change REFUSED", await upd(linked, "amount = 9"), "P0001:evidence_field_protected/amount");
  check("linked correction: reagent_id change REFUSED", await upd(linked, "reagent_id = '00000000-0000-0000-0000-0000000000a2'"), "P0001:evidence_field_protected/reagent_id");
  check("linked correction: used_by change REFUSED", await upd(linked, "used_by = 'staff-a'"), "P0001:evidence_field_protected/used_by");
  check("linked correction: deleted (undo) REFUSED", await upd(linked, "deleted = true, deleted_by = 'X', deleted_at = now()"), "P0001:evidence_field_protected/deleted");
  check("linked correction: source → other line REFUSED", await upd(linked, "source_count_item_id = $2", [itemB]), "P0001:evidence_field_protected/source_count_item_id");
  check("linked correction: source → NULL (line still exists) REFUSED", await upd(linked, "source_count_item_id = null"), "P0001:evidence_field_protected/source_count_item_id");
  check("linked correction: provenance → other value REFUSED", await upd(linked, "date_provenance = 'count_exact'"), "P0001:evidence_field_protected/date_provenance");
  check("linked correction: provenance → NULL REFUSED", await upd(linked, "date_provenance = null"), "P0001:evidence_field_protected/date_provenance");
  check("linked correction: date / note / edited_by changes still allowed (not protected fields)", await upd(linked, "date = '2026-10-01', note = 'n', edited_by = 'staff-a', edited_at = now()"), "OK");
  // historical-style correction (used_by only, nothing set yet)
  const hist = await mkLog(null, CORR, null);
  check("unlinked correction (used_by): amount change REFUSED", await upd(hist, "amount = 9"), "P0001:evidence_field_protected/amount");
  check("unlinked correction: deleted REFUSED", await upd(hist, "deleted = true"), "P0001:evidence_field_protected/deleted");
  check("unlinked correction: source NULL → line ALLOWED (backfill path)", await upd(hist, "source_count_item_id = $2", [itemA]), "OK");
  check("… then source → other line REFUSED", await upd(hist, "source_count_item_id = $2", [itemB]), "P0001:evidence_field_protected/source_count_item_id");
  check("unlinked correction: provenance NULL → historical_unknown ALLOWED", await upd(hist, "date_provenance = 'historical_unknown'"), "OK");
  check("… then provenance → count_redated REFUSED", await upd(hist, "date_provenance = 'count_redated'"), "P0001:evidence_field_protected/date_provenance");
  check("same value re-written (no change) is allowed (NULL-safe comparison)", await upd(hist, "date_provenance = 'historical_unknown', source_count_item_id = $2", [itemA]), "OK");
  // Edit-dates architecture: replacement rows + hard delete of old rows
  const repl = await mkLog(itemA, CORR, "count_redated");
  check("Edit dates: replacement row insert OK, old linked row hard delete OK", [res({ ok: !!repl }), res(await tryQ(`delete from consumption_logs where id = $1`, [linked]))], ["OK", "OK"]);

  // ── Manual logs stay fully editable ──
  const man = await mkLog(null, "staff-a", "manual");
  check("manual log: amount/date/used_by/note/QC edit allowed", await upd(man, "amount = 5, date = '2026-10-02', used_by = 'staff-b', note = 'z', tested_by_qc = true"), "OK");
  check("manual log: undo (deleted = true) allowed", await upd(man, "deleted = true, deleted_by = 'staff-a', deleted_at = now()"), "OK");
  check("manual log: provenance is write-once too (manual → count_exact REFUSED)", await upd(man, "date_provenance = 'count_exact'"), "P0001:evidence_field_protected/date_provenance");
  const manNull = await mkLog(null, "staff-a", null);
  check("manual log with NULL provenance: NULL → manual allowed (backfill path)", await upd(manNull, "date_provenance = 'manual'"), "OK");

  // ── Count item write-once fields ──
  const updI = async (id, set, params = []) => res(await tryQ(`update inventory_count_items set ${set} where id = $1`, [id, ...params]));
  check("item: resolution_details NULL → value allowed", await updI(itemB, `resolution_details = '{"v":1,"method":"usage_window"}'`), "OK");
  check("item: resolution_details → changed value REFUSED", await updI(itemB, `resolution_details = '{"v":1,"method":"corrected"}'`), "P0001:evidence_field_protected/resolution_details");
  check("item: resolution_details → NULL REFUSED", await updI(itemB, "resolution_details = null"), "P0001:evidence_field_protected/resolution_details");
  check("item: resolved_at NULL → value allowed; change REFUSED; NULL REFUSED", [await updI(itemB, "resolved_at = '2026-10-05T10:00:00Z'"), await updI(itemB, "resolved_at = now()"), await updI(itemB, "resolved_at = null")], ["OK", "P0001:evidence_field_protected/resolved_at", "P0001:evidence_field_protected/resolved_at"]);
  check("item: resolved_by NULL → value allowed; change REFUSED; NULL REFUSED", [await updI(itemB, "resolved_by = 'staff-b'"), await updI(itemB, "resolved_by = 'staff-a'"), await updI(itemB, "resolved_by = null")], ["OK", "P0001:evidence_field_protected/resolved_by", "P0001:evidence_field_protected/resolved_by"]);
  check("item: counted_at / counted_by stay updatable (set, change, clear)", [await updI(itemB, "counted_at = now(), counted_by = 'staff-b'"), await updI(itemB, "counted_at = now() + interval '1 minute', counted_by = 'staff-a'"), await updI(itemB, "counted_at = null, counted_by = null")], ["OK", "OK", "OK"]);
  check("item: existing columns stay updatable after resolution (counted_quantity, resolved, resolution_note, consumption_log_ids)", await updI(itemB, "counted_quantity = 4, resolved = true, resolution_note = 'Logged as usage spread from 2026-09-28 to 2026-10-05', consumption_log_ids = '{}'"), "OK");
  check("item: same values re-written (no change) allowed", await updI(itemB, `resolution_details = '{"v":1,"method":"usage_window"}', resolved_at = '2026-10-05T10:00:00Z', resolved_by = 'staff-b'`), "OK");

  // ── FK ON DELETE SET NULL keeps the log ──
  const cX = (await A.query(`insert into inventory_counts (department, started_by) values ('Phlebotomy', 'T') returning id`)).rows[0].id;
  const iX = (await A.query(`insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, '00000000-0000-0000-0000-0000000000a1', 'Analyte C', 'TC-372', 'Phlebotomy', 'Piece', 5) returning id`, [cX])).rows[0].id;
  const lX = await mkLog(iX, CORR, "count_exact_default");
  check("deleting an in-progress count (cascade) succeeds with the guard on", res(await tryQ(`delete from inventory_counts where id = $1`, [cX])), "OK");
  check("… its correction log survives, link SET NULL, provenance/amount/used_by kept", (await A.query(`select source_count_item_id, date_provenance, amount::int, used_by, deleted from consumption_logs where id = $1`, [lX])).rows[0], { source_count_item_id: null, date_provenance: "count_exact_default", amount: 2, used_by: CORR, deleted: false });
  check("deleting a count line directly also SET NULLs (FK path) without refusal", await (async () => { const { i } = await mkCount(); const l = await mkLog(i, CORR, "count_exact"); const d = res(await tryQ(`delete from inventory_count_items where id = $1`, [i])); return [d, (await A.query("select source_count_item_id from consumption_logs where id = $1", [l])).rows[0].source_count_item_id]; })(), ["OK", null]);

  // ── Old app AFTER the guard: current flows still fine, except generic edits of corrections ──
  const after = await oldAppFlows("part2");
  check("compat (with guard): every current-app Stock Count / manual-log write pattern still works", [allOk(after), after.linesCascaded], [[], 0]);
  // The deployment-order hazard: old saveEditedLog/deleteLog update stock FIRST, then the log.
  const qtyBefore = (await A.query("select current_quantity::int q from reagents where id = '00000000-0000-0000-0000-0000000000a1'")).rows[0].q;
  await A.query("update reagents set current_quantity = current_quantity + 19 where id = '00000000-0000-0000-0000-0000000000a1'"); // old deleteLog step 1
  const step2 = res(await tryQ(`update consumption_logs set deleted = true, deleted_by = 'staff-a', deleted_at = now() where id = '00000000-0000-0000-0000-0000000000e1'`)); // step 2
  const qtyAfter = (await A.query("select current_quantity::int q from reagents where id = '00000000-0000-0000-0000-0000000000a1'")).rows[0].q;
  check("HAZARD (documented): old-app undo of a correction → stock restored (+19) but log update refused = partial write", [step2, qtyAfter - qtyBefore], ["P0001:evidence_field_protected/deleted", 19]);
  for (const c of [A, admin]) await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 51 });
