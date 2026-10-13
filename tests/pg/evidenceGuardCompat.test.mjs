// Evidence Guard (B2, final rules) and the rollout compatibility matrix on real PostgreSQL:
//   · guard rules: what is refused on corrections and resolved lines, what stays allowed
//   · matrix: each app version's exact write sequence for 10 operations × 6 schema states
//     (none, Foundation, +Functions, +Guard, +Start, +Start+Guard) — every outcome must
//     equal the reviewed matrix (tests/fixtures/golden/compat-matrix.json), plus the named
//     rollout-decision assertions from the B2 and MatrixC review suites.
// Ported from runMatrixC.mjs (a superset of runB2.mjs: same guard rules, B2's matrix is the
// identical subset of this one) with runB2.mjs's five matrix assertions kept by name.
import { readFileSync } from "node:fs";
import { suite, check, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";
import { uuidOf, canon } from "../helpers/uuid.mjs";

const GOLDEN = JSON.parse(readFileSync(rootPath("tests", "fixtures", "golden", "compat-matrix.json"), "utf8"));
const U = uuidOf;
const C = "Unlogged (physical count)";
let section = "";
const chk = (n, a, b) => check(`[${section}] ${n}`, canon(a), canon(b));
const BASE = `  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create table reagents (id uuid primary key default gen_random_uuid(), name text not null, lot_number text not null, department text, unit text, device text not null default '',
    current_quantity numeric not null default 0, deleted boolean not null default false, deleted_by text, deleted_at timestamptz,
    expiry_date date, date_added date, active_on_device boolean not null default false, created_at timestamptz default now());
  create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
  create table consumption_logs (id uuid primary key default gen_random_uuid(), reagent_id uuid references reagents(id) on delete cascade,
    amount numeric not null, date date not null, used_by text not null, note text, tested_by_qc boolean not null default false,
    active_device_changed boolean not null default false, previous_active_lot_id uuid, deleted boolean not null default false,
    deleted_by text, deleted_at timestamptz, edited_by text, edited_at timestamptz, created_at timestamptz not null default now());
  create table audit_log (id uuid primary key default gen_random_uuid(), action text not null, entity text not null, description text not null, performed_by text not null, performed_at timestamptz not null default now());
  grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`;
const PRE = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"];
const F = "ADD_EVIDENCE_FOUNDATION.sql", FN = "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", G = "ADD_EVIDENCE_GUARD.sql", ST = "ADD_STOCK_COUNT_START.sql";
const SCHEMAS = { none: [], F: [F], "F+Fn": [F, FN], "F+Fn+G": [F, FN, G], "F+Fn+S": [F, FN, ST], "F+Fn+S+G": [F, FN, ST, G] };

for (const version of PG_VERSIONS) suite(`B2 · Evidence Guard rules and rollout compatibility matrix (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
  const DBS = {};
  for (const [name, files] of Object.entries(SCHEMAS)) {
    const db = await server.createDatabase();
    const admin = await server.connect(db);
    await ensureRoles(admin);
    await admin.query(BASE);
    for (const f of PRE) await admin.query(readRoot(f));
    await admin.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
    const errs = [];
    for (const f of files) for (let i = 0; i < 2; i++) { try { await admin.query(readRoot(f)); } catch (e) { errs.push(`${f}: ${e.message}`); } }
    const anon = await server.connect(db); await anon.query("set role anon");
    DBS[name] = { admin, anon, errs };
  }
  section = "migrations";
  for (const [n, d] of Object.entries(DBS)) chk(`${n}: every migration runs twice without error (idempotent)`, d.errs, []);

  // ── Seed (same for every case) ──
  // r-a lot (qty 5) · log-m manual · log-lc legacy correction (no link) · log-ld undone legacy correction
  // c-open in progress: i-open (5 → 3, unresolved), i-res (resolved, counted 3)
  // c-done completed: i-done resolved usage, linked via ids to log-x (legacy, no source link)
  async function seed(db) {
    const a = db.admin;
    await a.query("set session_replication_role = replica"); // seeding only (historical rows can predate the guard)
    await a.query("truncate audit_log, consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
    await a.query(`insert into reagents (id, name, lot_number, department, unit, current_quantity, date_added) values ($1, 'Alpha', 'A1', 'Chemistry', 'box', 5, '2026-07-01')`, [U("r-a")]);
    const log = (id, used, amount, date, deleted = false) => a.query("insert into consumption_logs (id, reagent_id, amount, date, used_by, note, deleted, created_at) values ($1, $2, $3, $4, $5, 'n', $6, '2026-09-01T08:30:00Z')", [U(id), U("r-a"), amount, date, used, deleted]);
    await a.query(`insert into reagents (id, name, lot_number, department, unit, current_quantity, date_added) values ($1, 'Hemo', 'H1', 'Hematology', 'box', 4, '2026-07-01')`, [U("r-h")]);
    await log("log-m", "staff-a", 1, "2026-09-10"); await log("log-lc", C, 2, "2026-09-12"); await log("log-ld", C, 1, "2026-09-13", true); await log("log-x", C, 2, "2026-09-01");
    await a.query(`insert into inventory_counts (id, department, status, started_by, started_at) values ($1, 'Chemistry', 'in_progress', 'T', '2026-09-30T08:00:00Z')`, [U("c-open")]);
    await a.query(`insert into inventory_counts (id, department, status, started_by, started_at, completed_by, completed_at) values ($1, null, 'completed', 'T', '2026-09-01T08:00:00Z', 'T', '2026-09-01T09:00:00Z')`, [U("c-done")]);
    const line = (id, count, e, c, extra = "", vals = []) => a.query(`insert into inventory_count_items (id, count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity${extra ? ", " + extra : ""}) values ($1, $2, $3, 'Alpha', 'A1', 'Chemistry', 'box', $4, $5${vals.map((_, i) => `, $${6 + i}`).join("")})`, [U(id), U(count), U("r-a"), e, c, ...vals]);
    await line("i-open", "c-open", 5, 3);
    await line("i-res", "c-open", 6, 3, "resolved, resolution_note", [true, "Corrected to match count"]);
    await line("i-done", "c-done", 7, 5, "resolved, resolution_note, consumption_log_ids", [true, "Logged as usage on 2026-09-01", [U("log-x")]]);
    await a.query("set session_replication_role = origin");
  }
  const fp = async (db) => (await db.admin.query(`select md5(string_agg(h, '|' order by t)) fp from (
      select 'r' t, coalesce(string_agg(x::text, ',' order by x.id), '') h from reagents x union all
      select 'l', coalesce(string_agg(x::text, ',' order by x.id), '') from consumption_logs x union all
      select 'a', coalesce(string_agg(x::text, ',' order by x.id), '') from audit_log x union all
      select 'i', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_count_items x union all
      select 'c', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_counts x) s`)).rows[0].fp;
  const one = async (db, sql, p = []) => (await db.admin.query(sql, p)).rows[0];
  // Runs an app's statements one by one, like the app (each its own request; errors don't stop it unless the app checks).
  async function run(db, steps) {
    const errors = [];
    for (const s of steps) {
      if (s.skipIf && (await s.skipIf())) continue;
      try { const r = await db.anon.query(s.sql, s.params || []); if (s.after) await s.after(r); }
      catch (e) { errors.push(`${e.code}${e.message === "evidence_field_protected" ? ":guard/" + e.detail : ""}`); if (s.stopOnError) break; }
    }
    return errors;
  }

  // ═════ 1. Final guard rules (F+Fn+G) ═════
  {
    const db = DBS["F+Fn+G"]; section = "guard rules";
    const t = async (label, sql, p, expectRef) => { await seed(db); const before = await fp(db); let got = "OK"; try { await db.anon.query(sql, p); } catch (e) { got = `${e.code}:${e.message}/${e.detail}`; } chk(`${label} → ${expectRef || "allowed"}`, [got, expectRef ? (await fp(db)) === before : true], [expectRef ? `P0001:evidence_field_protected/${expectRef}` : "OK", true]); };
    await t("legacy correction: date change", "update consumption_logs set date = '2026-09-11' where id = $1", [U("log-lc")], "date");
    await t("legacy correction: amount change", "update consumption_logs set amount = 3 where id = $1", [U("log-lc")], "amount");
    await t("legacy correction: used_by → a person (reclassify)", "update consumption_logs set used_by = 'staff-a' where id = $1", [U("log-lc")], "used_by");
    await t("legacy correction: undo", "update consumption_logs set deleted = true where id = $1", [U("log-lc")], "deleted");
    await t("legacy correction: note / QC still writable (not evidence)", "update consumption_logs set note = 'x', tested_by_qc = true where id = $1", [U("log-lc")], null);
    await t("manual log: date, amount, used_by, undo all still allowed", "update consumption_logs set date = '2026-09-11', amount = 2, used_by = 'staff-b', deleted = true where id = $1", [U("log-m")], null);
    await t("manual log → reserved used_by is NOT refused by the database (app-level rule)", `update consumption_logs set used_by = '${C}' where id = $1`, [U("log-m")], null);
    await t("unresolved line: counted_quantity / at / by change freely", "update inventory_count_items set counted_quantity = 4, counted_at = now(), counted_by = 'staff-1' where id = $1", [U("i-open")], null);
    await t("resolved line: counted_quantity change", "update inventory_count_items set counted_quantity = 4 where id = $1", [U("i-res")], "counted_quantity");
    await t("resolved line: counted_quantity cleared", "update inventory_count_items set counted_quantity = null where id = $1", [U("i-res")], "counted_quantity");
    await t("resolved line: counted_quantity same value rewritten", "update inventory_count_items set counted_quantity = 3 where id = $1", [U("i-res")], null);
    await t("resolved line: counted_at / counted_by NULL → value (recording history)", "update inventory_count_items set counted_at = '2026-09-30T09:00:00Z', counted_by = 'staff-1' where id = $1", [U("i-res")], null);
    {
      await seed(db);
      await db.admin.query("update inventory_count_items set counted_at = '2026-09-30T09:00:00Z', counted_by = 'staff-1' where id = $1", [U("i-res")]);
      for (const [label, set, ref] of [["counted_at changed", "counted_at = now()", "counted_at"], ["counted_at cleared", "counted_at = null", "counted_at"], ["counted_by changed", "counted_by = 'staff-2'", "counted_by"], ["counted_by cleared", "counted_by = null", "counted_by"]]) {
        const before = await fp(db); let got = "OK"; try { await db.anon.query(`update inventory_count_items set ${set} where id = $1`, [U("i-res")]); } catch (e) { got = `${e.message}/${e.detail}`; }
        chk(`resolved line: ${label} → ${ref}`, [got, (await fp(db)) === before], [`evidence_field_protected/${ref}`, true]);
      }
    }
    await t("resolved line: reopened (true → false)", "update inventory_count_items set resolved = false where id = $1", [U("i-res")], "resolved");
    await t("resolved line: note / links still updatable (Edit dates needs them)", "update inventory_count_items set resolution_note = 'Logged as usage on 2026-09-02', consumption_log_ids = '{}' where id = $1", [U("i-done")], null);
    await t("unresolved → resolved still allowed", "update inventory_count_items set resolved = true, resolution_note = 'Kept system value' where id = $1", [U("i-open")], null);
    {
      await seed(db);
      const r = await db.anon.query("select stock_count_resolve(p_item_id => $1, p_method => 'usage_spread', p_actor => 'T', p_seen_expected => 5, p_seen_counted => 3, p_allocation => $2::jsonb) r", [U("i-open"), JSON.stringify([{ date: "2026-09-20", amount: 1 }, { date: "2026-09-27", amount: 1 }])]);
      const linked = (await db.admin.query("select id from consumption_logs where source_count_item_id = $1 order by date", [U("i-open")])).rows.map((x) => x.id);
      const before = await fp(db); let got = "OK";
      try { await db.anon.query("update consumption_logs set date = '2026-09-21' where id = $1", [linked[0]]); } catch (e) { got = `${e.message}/${e.detail}`; }
      chk("new linked correction (function-written): in-place date change refused", [r.rows[0].r.status, got, (await fp(db)) === before], ["ok", "evidence_field_protected/date", true]);
      got = "OK"; try { await db.anon.query("update inventory_count_items set counted_quantity = 2 where id = $1", [U("i-open")]); } catch (e) { got = `${e.message}/${e.detail}`; }
      chk("line resolved by the function: counted_quantity now frozen", got, "evidence_field_protected/counted_quantity");
      got = "OK"; try { await db.anon.query("delete from inventory_counts where id = $1", [U("c-open")]); } catch (e) { got = e.message; }
      chk("deleting an in-progress count with resolved lines still cascades (no DELETE guard)", [got, (await one(db, "select count(*)::int n from inventory_count_items where count_id = $1", [U("c-open")])).n, (await one(db, "select count(*)::int n from consumption_logs where id = any($1) and source_count_item_id is null", [linked])).n], ["OK", 0, 2]);
    }
    {
      await seed(db);
      const before = await fp(db); let got = "OK";
      try { await db.anon.query("delete from consumption_logs where id = $1", [U("log-lc")]); } catch (e) { got = e.message; }
      chk("direct hard DELETE of a correction row is NOT prevented by the guard (documented; app blocks generic purge)", [got, (await fp(db)) !== before], ["OK", true]);
    }
  }

  // ═════ 2. Compatibility matrix ═════
  // Each app version's exact write sequence for nine operations (from its code).
  const now = "2026-10-06T10:00:00Z";
  const OPS = {
    "Log use (manual)": (app) => [
      { sql: "update reagents set current_quantity = 4 where id = $1", params: [U("r-a")] },
      { sql: `insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id${app === "B2" ? ", date_provenance" : ""}) values ($1, 1, '2026-10-06', 'staff-a', '', false, false, null${app === "B2" ? ", 'manual'" : ""})`, params: [U("r-a")] },
    ],
    "Generic edit, manual log": () => [
      { sql: "update reagents set current_quantity = 4 where id = $1", params: [U("r-a")] },
      { sql: "update consumption_logs set amount = 2, date = '2026-09-11', used_by = 'staff-a', note = 'n', tested_by_qc = false, edited_by = 'staff-1', edited_at = now() where id = $1", params: [U("log-m")] },
      { sql: "insert into audit_log (action, entity, description, performed_by) values ('edit', 'log', 'x', 'staff-1')" },
    ],
    "Generic edit, correction (amount)": (app) => (app === "B2" ? [] : [
      { sql: "update reagents set current_quantity = 4 where id = $1", params: [U("r-a")] },
      { sql: "update consumption_logs set amount = 3, date = '2026-09-12', used_by = $2, note = 'n', tested_by_qc = false, edited_by = 'staff-1', edited_at = now() where id = $1", params: [U("log-lc"), C] },
      { sql: "insert into audit_log (action, entity, description, performed_by) values ('edit', 'log', 'x', 'staff-1')" },
    ]),
    "Generic undo, correction": (app) => (app === "B2" ? [] : [
      { sql: "update reagents set current_quantity = 7 where id = $1", params: [U("r-a")] },
      { sql: "update consumption_logs set deleted = true, deleted_by = 'staff-1', deleted_at = now() where id = $1", params: [U("log-lc")] },
      { sql: "insert into audit_log (action, entity, description, performed_by) values ('delete', 'log', 'x', 'staff-1')" },
    ]),
    "Generic purge, undone correction": (app) => (app === "B2" ? [] : [
      { sql: "delete from consumption_logs where id = $1", params: [U("log-ld")] },
      { sql: "insert into audit_log (action, entity, description, performed_by) values ('purge', 'log', 'x', 'OWNER')" },
    ]),
    "Resolve discrepancy (exact date)": (app) => {
      if (app === "B1.5b" || app === "B2") return [{ sql: "select stock_count_resolve(p_item_id => $1, p_method => 'usage_exact', p_actor => 'staff-1', p_seen_expected => 5, p_seen_counted => 3, p_date => '2026-09-25')", params: [U("i-open")] }];
      const ev = app === "B1";
      let created = null;
      return [
        { sql: `insert into consumption_logs (reagent_id, amount, date, used_by, note${ev ? ", source_count_item_id, date_provenance" : ""}) values ($1, 2, '2026-09-25', $2, 'Retroactively logged — found missing during a physical count.'${ev ? ", $3, 'count_exact'" : ""}) returning id`, params: ev ? [U("r-a"), C, U("i-open")] : [U("r-a"), C], after: (r) => { created = r.rows[0].id; } },
        { sql: "update inventory_count_items set consumption_log_ids = array[$2::uuid] where id = $1", params: [U("i-open"), null], skipIf: async () => !created, get paramsLate() { return null; } },
        { sql: "update reagents set current_quantity = 3 where id = $1", params: [U("r-a")] },
        { sql: "insert into audit_log (action, entity, description, performed_by) values ('edit', 'reagent', 'x', 'staff-1')" },
        { sql: `update inventory_count_items set resolved = true, resolution_note = 'Logged as usage on 2026-09-25'${ev ? ", resolved_at = now(), resolved_by = 'staff-1', resolution_details = '{\"v\":1}'" : ""} where id = $1`, params: [U("i-open")] },
      ].map((s) => (s.get ? s : s));
    },
    "Save counted quantity": (app) => [{ sql: `update inventory_count_items set counted_quantity = 4${app === "Old" ? "" : ", counted_at = now(), counted_by = 'staff-1'"} where id = $1`, params: [U("i-open")] }],
    "Edit dates (completed count)": (app) => {
      if (app === "B1.5b" || app === "B2") return [{ sql: "select stock_count_redate(p_item_id => $1, p_actor => 'staff-1', p_current_log_ids => $2, p_mode => 'exact', p_date => '2026-08-15')", params: [U("i-done"), [U("log-x")]] }];
      const ev = app === "B1";
      return [
        { sql: `insert into consumption_logs (reagent_id, amount, date, used_by, note${ev ? ", source_count_item_id, date_provenance" : ""}) values ($1, 2, '2026-08-15', $2, 'Retroactively logged — found missing during a physical count.'${ev ? ", $3, 'count_redated'" : ""}) returning id`, params: ev ? [U("r-a"), C, U("i-done")] : [U("r-a"), C], stopOnError: true },
        { sql: "delete from consumption_logs where id = $1", params: [U("log-x")] },
        { sql: "update inventory_count_items set resolution_note = 'Logged as usage on 2026-08-15' where id = $1", params: [U("i-done")] },
        { sql: "update inventory_count_items set consumption_log_ids = (select array_agg(id) from consumption_logs where reagent_id = $2 and date = '2026-08-15') where id = $1", params: [U("i-done"), U("r-a")] },
        { sql: "insert into audit_log (action, entity, description, performed_by) values ('edit', 'log', 'x', 'staff-1')" },
      ];
    },
    "Start count (Hematology)": (app) => {
      if (app === "C") return [{ sql: "select stock_count_start(p_department => 'Hematology', p_actor => 'staff-1')" }];
      let count = null; // old client: insert the header, then lines from the BROWSER's quantity (5)
      return [
        { sql: "insert into inventory_counts (department, started_by) values ('Hematology', 'staff-1') returning id", after: (r) => { count = r.rows[0].id; }, stopOnError: true },
        { get sql() { return "insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, $2, 'Hemo', 'H1', 'Hematology', 'box', 5)"; }, get params() { return [count, U("r-h")]; } },
      ];
    },
    "Change count after resolution": (app) => (app === "B1.5b" || app === "B2" ? [] : [{ sql: "update inventory_count_items set counted_quantity = 4 where id = $1", params: [U("i-res")] }]),
  };
  // Expected full effect of each operation.
  const FULL = {
    "Log use (manual)": async (db) => (await one(db, "select (select current_quantity::float8 from reagents where name = 'Alpha') q, (select count(*) from consumption_logs where date = '2026-10-06')::int n")).q === 4 && (await one(db, "select count(*)::int n from consumption_logs where date = '2026-10-06'")).n === 1,
    "Generic edit, manual log": async (db) => (await one(db, "select amount::float8 a from consumption_logs where id = $1", [U("log-m")])).a === 2 && (await one(db, "select current_quantity::float8 q from reagents where name = 'Alpha'")).q === 4,
    "Generic edit, correction (amount)": async (db) => (await one(db, "select amount::float8 a from consumption_logs where id = $1", [U("log-lc")])).a === 3,
    "Generic undo, correction": async (db) => (await one(db, "select deleted from consumption_logs where id = $1", [U("log-lc")])).deleted,
    "Generic purge, undone correction": async (db) => (await one(db, "select count(*)::int n from consumption_logs where id = $1", [U("log-ld")])).n === 0,
    "Resolve discrepancy (exact date)": async (db) => { const r = await one(db, "select resolved, cardinality(consumption_log_ids) n from inventory_count_items where id = $1", [U("i-open")]); const l = await one(db, "select count(*)::int n from consumption_logs where date = '2026-09-25'"); const q = await one(db, "select current_quantity::float8 q from reagents where name = 'Alpha'"); return r.resolved && r.n === 1 && l.n === 1 && q.q === 3; },
    "Save counted quantity": async (db) => (await one(db, "select counted_quantity::float8 c from inventory_count_items where id = $1", [U("i-open")])).c === 4,
    "Edit dates (completed count)": async (db) => (await one(db, "select count(*)::int n from consumption_logs where reagent_id = $1 and used_by = $2 and date = '2026-08-15'", [U("r-a"), C])).n === 1 && (await one(db, "select count(*)::int n from consumption_logs where id = $1", [U("log-x")])).n === 0,
    "Start count (Hematology)": async (db) => { const r = await one(db, "select count(*)::int n, max(i.expected_quantity)::float8 e from inventory_counts c join inventory_count_items i on i.count_id = c.id where c.department = 'Hematology'"); return r.n === 1; },
    "Change count after resolution": async (db) => (await one(db, "select counted_quantity::float8 c from inventory_count_items where id = $1", [U("i-res")])).c === 4,
  };
  const APPS = ["Old", "B1", "B1.5b", "B2", "C"];
  const matrix = {};
  section = "matrix";
  for (const [schema, db] of Object.entries(DBS)) for (const app of APPS) for (const [op, build] of Object.entries(OPS)) {
    await seed(db);
    const before = await fp(db);
    let steps = build(app === "C" && op !== "Start count (Hematology)" ? "B2" : app);
    // the link update needs the inserted id (Old/B1 resolve)
    if (op === "Resolve discrepancy (exact date)" && (app === "Old" || app === "B1")) {
      let created = null;
      steps = steps.map((s, i) => (i === 0 ? { ...s, after: (r) => { created = r.rows[0]?.id; } } : i === 1 ? { ...s, skipIf: async () => !created, get params() { return [U("i-open"), created]; } } : s));
    }
    const errors = steps.length ? await run(db, steps) : [];
    const changed = (await fp(db)) !== before;
    const full = await FULL[op](db);
    const staleStart = op === "Start count (Hematology)" && full ? (await one(db, "select max(i.expected_quantity)::float8 e from inventory_count_items i join inventory_counts c on c.id = i.count_id where c.department = 'Hematology'")).e === 5 : false;
    const outcome = staleStart ? "OK but STALE snapshot (browser quantity 5, database 4)" : !steps.length ? "blocked in app (no writes)" : full && !errors.length ? "OK" : full ? `OK (with errors: ${errors.join(",")})` : !changed ? `refused, nothing written (${errors.join(",")})` : `PARTIAL WRITE (${errors.join(",")})`;
    (matrix[op] ||= {})[`${app} @ ${schema}`] = outcome;
  }
  const M = (op, app, schema) => matrix[op][`${app} @ ${schema}`];
  // Expectations that matter for the rollout decision.
  const finalOK = (app, schema) => Object.keys(OPS).every((op) => /^(OK|blocked in app)/.test(M(op, app, schema)) && !/STALE/.test(M(op, app, schema)));
  chk("Batch C app @ F+Fn+S+G: every operation OK or blocked in the app; start snapshot from the database", [finalOK("C", "F+Fn+S+G"), M("Start count (Hematology)", "C", "F+Fn+S+G")], [true, "OK"]);
  chk("Batch C app @ F+Fn+S (guard off): same", finalOK("C", "F+Fn+S"), true);
  chk("Batch C app without the start function: start refused cleanly (nothing written)", ["none", "F", "F+Fn", "F+Fn+G"].map((s) => M("Start count (Hematology)", "C", s).startsWith("refused")), [true, true, true, true]);
  chk("every earlier app starts with the browser's (stale) quantity on every schema", ["Old", "B1", "B1.5b", "B2"].every((a) => Object.keys(SCHEMAS).every((s) => /STALE/.test(M("Start count (Hematology)", a, s)))), true);
  chk("adding the start function changes nothing for earlier apps (F+Fn+S ≡ F+Fn, F+Fn+S+G ≡ F+Fn+G)", ["Old", "B1", "B1.5b", "B2"].every((a) => Object.keys(OPS).every((op) => M(op, a, "F+Fn+S") === M(op, a, "F+Fn") && M(op, a, "F+Fn+S+G") === M(op, a, "F+Fn+G"))), true);
  section = "matrix (B2 assertions)";
  const B2_OPS = Object.keys(OPS).filter((op) => op !== "Start count (Hematology)"); // the 9 operations of the B2 suite
  chk("B2 @ final (F+Fn+G): every operation either OK or blocked in the app — no refusal, no partial write", B2_OPS.map((op) => [op, M(op, "B2", "F+Fn+G")]), B2_OPS.map((op) => [op, ["Generic edit, correction (amount)", "Generic undo, correction", "Generic purge, undone correction", "Change count after resolution"].includes(op) ? "blocked in app (no writes)" : "OK"]));
  chk("B2 @ F+Fn (guard off): same", B2_OPS.map((op) => M(op, "B2", "F+Fn")), B2_OPS.map((op) => M(op, "B2", "F+Fn+G")));
  chk("Old app @ final guard: generic edit / undo of a correction = PARTIAL WRITE (why the guard waits for B2 everywhere)", [M("Generic edit, correction (amount)", "Old", "F+Fn+G").startsWith("PARTIAL"), M("Generic undo, correction", "Old", "F+Fn+G").startsWith("PARTIAL")], [true, true]);
  chk("B2 @ no schema: Log use = PARTIAL WRITE (stock lowered, insert rejected) → Foundation must come first", M("Log use (manual)", "B2", "none").startsWith("PARTIAL"), true);
  chk("B1.5b/B2 @ Foundation only: resolve and Edit dates refused cleanly (function missing), nothing written", [M("Resolve discrepancy (exact date)", "B1.5b", "F"), M("Edit dates (completed count)", "B2", "F")].map((x) => x.startsWith("refused")), [true, true]);
  section = "matrix (golden)";
  chk("every one of the 300 cells (10 operations × 5 app versions × 6 schema states) equals the reviewed matrix", matrix, GOLDEN);

  for (const d of Object.values(DBS)) { await d.anon.end(); await d.admin.end(); }
  } finally { await server.stop(); }
}, { expectedChecks: 40 });
