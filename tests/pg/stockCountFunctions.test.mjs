// B1.5a — atomic Stock Count functions (stock_count_window / resolve / redate) on real
// PostgreSQL, each on two databases (Evidence Guard off / on):
//   0 migration, catalog, SECURITY INVOKER, grants (anon only)
//   1 window parity: SQL vs countBounds.js in the lab time zone, incl. midnight edges
//   2 parity with the recorded B1 client writes (golden, synthetic seed)
//   3 auto-remove rule edge cases          4 result contract: every refusal writes nothing
//   5 method writes                        6 fault injection: nothing committed, retry once
//   7 concurrency (two connections)        8 lost response / retry
//   9 Edit dates (redate): parity, historical lines, contract, faults, concurrency
//  10 guard: function writes pass, direct forbidden mutations refused
//  11 current app write patterns unaffected (guard off)
// Ported from runB15.mjs. Test-only fault triggers (zz_test_*) are created here, never in a migration.
process.env.TZ = "Asia/Riyadh"; // the lab's clock, as the browser sees it
import { readFileSync } from "node:fs";
import { suite, check, load, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles, faultTriggers } from "../helpers/pg.mjs";
import { uuidOf, canon } from "../helpers/uuid.mjs";

const { previousCompletedCounts, usageInterval } = await load("countBounds.js");
const { buildSpreadEntries } = await load("logSpread.js");
const B1RUNS = JSON.parse(readFileSync(rootPath("tests", "fixtures", "golden", "b1-client-writes.json"), "utf8"));
const REG = JSON.parse(readFileSync(rootPath("tests", "fixtures", "golden", "b1-auto-remove-writes.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = uuidOf;
const C = "Unlogged (physical count)";
let section = "";
const sec = (s) => { section = s; };
const chk = (name, actual, expected) => check(`[${section}] ${name}`, canon(actual), canon(expected));
const BASE = `
  grant usage on schema public to anon, authenticated, other;
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
  alter table reagents enable row level security; create policy "allow all reagents" on reagents for all using (true) with check (true);
  alter table consumption_logs enable row level security; create policy "allow all consumption_logs" on consumption_logs for all using (true) with check (true);
  alter table audit_log enable row level security; create policy "allow all audit_log" on audit_log for all using (true) with check (true);
  grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`;
const PRE = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql", "ADD_EVIDENCE_FOUNDATION.sql"];
const FUNCS = readRoot("ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql");
const FAULTS = faultTriggers(["consumption_logs", "reagents", "audit_log", "inventory_count_items"]);

for (const version of PG_VERSIONS) suite(`B1.5a · atomic Stock Count functions (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version, { flags: ["deadlock_timeout=200ms"] });
  try {
  const connectTo = (db) => server.connect(db);
  { const r = await server.connect(await server.createDatabase()); await ensureRoles(r, ["anon", "authenticated", "other"]); await r.end(); }
  const catalog = async (c) => ({
    funcs: (await c.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' n, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1`)).rows,
    trigs: (await c.query(`select tgname n, md5(pg_get_triggerdef(oid)) h from pg_trigger where not tgisinternal order by 1`)).rows,
  });
  async function makeDb(_label, guard) {
    const name = await server.createDatabase();
    const admin = await connectTo(name);
    await admin.query(BASE);
    for (const f of PRE) await admin.query(readRoot(f));
    await admin.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
    const before = await catalog(admin);
    let e1 = null, e2 = null; try { await admin.query(FUNCS); } catch (e) { e1 = e.message; } try { await admin.query(FUNCS); } catch (e) { e2 = e.message; }
    const after = await catalog(admin);
    if (guard) await admin.query(readRoot("ADD_EVIDENCE_GUARD.sql"));
    await admin.query(FAULTS);
    const anon = await connectTo(name); await anon.query("set role anon");
    return { name, guard, admin, anon, migration: { e1, e2, before, after } };
  }
  const DBS = [await makeDb("b15_fn", false), await makeDb("b15_fng", true)];

  // ── helpers ──
  const val = (v, ids) => (v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : mapv(v, ids));
  const mapv = (v, ids) => { if (typeof v === "string") { if (/^\w+#\d+$/.test(v) && !ids.has(v)) throw Object.assign(new Error("skip"), { skip: true }); return ids.get(v) ?? v; } return Array.isArray(v) ? v.map((x) => mapv(x, ids)) : v; };
  const insRow = async (c, table, row, ids) => { const cols = Object.keys(row); const r = await c.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, cols.map((k) => val(row[k], ids))); return r.rows[0].id; };
  async function seed(db, s) {
    await db.admin.query("truncate audit_log, consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
    const ids = new Map();
    for (const t of ["reagents", "inventory_counts", "inventory_count_items", "consumption_logs"]) for (const r of s[t]) ids.set(r.id, U(r.id));
    for (const t of ["reagents", "inventory_counts", "inventory_count_items", "consumption_logs"]) for (const r of s[t]) await insRow(db.admin, t, r, ids);
    return ids;
  }
  // Replays the exact writes the B1 client issued (expected state for parity).
  async function replayClient(db, s, writes) {
    const ids = await seed(db, s); let seq = 0;
    for (const w of writes) {
      try {
        if (w.op === "insert") { for (const row of Array.isArray(w.payload) ? w.payload : [w.payload]) { seq++; ids.set(`${w.table}#${seq}`, await insRow(db.anon, w.table, row, ids)); } }
        else {
          const params = []; const p = (v) => (params.push(val(v, ids)), `$${params.length}`);
          const set = w.op === "update" ? Object.entries(w.payload).map(([k, v]) => `${k} = ${p(v)}`).join(", ") : "";
          const where = w.filters.map(([k, col, v]) => (k === "eq" ? `${col} = ${p(v)}` : `${col} = any(${p(v)})`)).join(" and ") || "true";
          await db.anon.query(w.op === "update" ? `update ${w.table} set ${set} where ${where}` : `delete from ${w.table} where ${where}`, params);
        }
      } catch (e) { if (!e.skip) throw e; }
    }
  }
  async function rpc(c, fn, args) {
    const keys = Object.keys(args);
    try { const r = await c.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => (k === "p_allocation" && args[k] != null ? JSON.stringify(args[k]) : args[k]))); return r.rows[0].r; }
    catch (e) { return { error: `${e.code}:${e.message}` }; }
  }
  const line = async (db, key) => (await db.admin.query("select * from inventory_count_items where id = $1", [U(key)])).rows[0];
  async function resolveArgs(db, key, method, extra = {}) {
    const l = await line(db, key);
    return { p_item_id: U(key), p_method: method, p_actor: "TESTER", p_seen_expected: l.expected_quantity, p_seen_counted: l.counted_quantity, ...extra };
  }
  const resolve = async (db, c, key, method, extra) => rpc(c, "stock_count_resolve", await resolveArgs(db, key, method, extra));
  const spreadAlloc = (amount, from, to) => buildSpreadEntries(amount, from, to).map((e) => ({ date: e.date, amount: e.amount }));
  const fullFp = async (c) => (await c.query(`select md5(string_agg(h, '|' order by t)) fp from (
      select 'r' t, coalesce(string_agg(x::text, ',' order by x.id), '') h from reagents x union all
      select 'l', coalesce(string_agg(x::text, ',' order by x.id), '') from consumption_logs x union all
      select 'a', coalesce(string_agg(x::text, ',' order by x.id), '') from audit_log x union all
      select 'i', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_count_items x union all
      select 'c', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_counts x) s`)).rows[0].fp;
  // Business state without generated ids / timestamps (for comparing two runs).
  const biz = async (c) => ({
    logs: (await c.query("select reagent_id, amount::float8 amount, to_char(date, 'YYYY-MM-DD') date, used_by, note, source_count_item_id, date_provenance, deleted from consumption_logs order by reagent_id, date, amount, note")).rows,
    reagents: (await c.query("select id, name, lot_number, current_quantity::float8 q, deleted, deleted_by, device from reagents order by id")).rows,
    audit: (await c.query("select action, entity, description, performed_by from audit_log order by performed_at, description")).rows,
    items: (await c.query("select id, expected_quantity::float8 e, counted_quantity::float8 c, resolved, resolution_note, resolved_by, resolution_details, cardinality(consumption_log_ids) n from inventory_count_items order by id")).rows,
    counts: (await c.query("select id, status from inventory_counts order by id")).rows,
  });
  const anonConn = async (db) => { const c = await connectTo(db.name); await c.query("set role anon"); return c; };
  async function race(db, callA, callB, commitA = true) {
    const A = await anonConn(db), B = await anonConn(db);
    const bPid = (await B.query("select pg_backend_pid() p")).rows[0].p;
    await A.query("begin"); const ra = await callA(A);
    const pb = callB(B); let waited = false;
    for (let i = 0; i < 250 && !waited; i++) { waited = (await db.admin.query("select wait_event_type w from pg_stat_activity where pid = $1", [bPid])).rows[0]?.w === "Lock"; if (!waited) await sleep(20); }
    await A.query(commitA ? "commit" : "rollback"); const rb = await pb;
    await A.end(); await B.end();
    return { ra, rb, waited };
  }
  const DEFAULT_SEED = B1RUNS.exact_default.seed;
  const REMAINDER_SEED = B1RUNS.spread_remainder.seed;
  const finishCount = async (db, key) => db.anon.query("update inventory_counts set status = 'completed', completed_by = 'TESTER', completed_at = now() where id = $1", [U(key)]);

  // ═════ 0. Migration, catalog, grants (per database) ═════
  for (const db of DBS) {
    sec(`${db.guard ? "guard" : "no-guard"} / migration`);
    chk("functions migration runs unchanged and re-runs (idempotent)", [db.migration.e1, db.migration.e2], [null, null]);
    const b = db.migration.before, a = db.migration.after;
    chk("only the 3 new functions were added; every existing function unchanged", [a.funcs.filter((f) => !b.funcs.some((x) => x.n === f.n)).map((f) => f.n), b.funcs.filter((f) => !a.funcs.some((x) => x.n === f.n && x.h === f.h)).map((f) => f.n)],
      [["stock_count_redate(p_item_id uuid, p_actor text, p_current_log_ids uuid[], p_mode text, p_date date, p_from date, p_to date, p_allocation jsonb)", "stock_count_resolve(p_item_id uuid, p_method text, p_actor text, p_seen_expected numeric, p_seen_counted numeric, p_date date, p_allocation jsonb)", "stock_count_window(p_reagent_id uuid, p_count_id uuid)"], []]);
    chk("no trigger added, removed or changed by the migration", a.trigs, b.trigs);
    const sec2 = (await db.admin.query(`select proname, prosecdef, provolatile, proconfig from pg_proc where proname like 'stock_count_%' order by 1`)).rows;
    chk("all SECURITY INVOKER with fixed search_path", sec2.map((r) => [r.proname, r.prosecdef, r.proconfig]), ["stock_count_redate", "stock_count_resolve", "stock_count_window"].map((n) => [n, false, ["search_path=pg_catalog, public, pg_temp"]]));
    const grants = (await db.admin.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('other', p.oid, 'execute') other from pg_proc p where proname like 'stock_count_%' order by 1`)).rows;
    chk("EXECUTE: anon yes; authenticated / other roles (PUBLIC) no", grants.map((g) => [g.anon, g.auth, g.other]), [[true, false, false], [true, false, false], [true, false, false]]);
    const o = await connectTo(db.name); await o.query("set role other");
    chk("a role without the grant cannot call it", (await rpc(o, "stock_count_window", { p_reagent_id: U("x"), p_count_id: U("y") })).error?.split(":")[0], "42501");
    await o.end();
    chk("table privileges unchanged (anon has no new grants; other has none)", (await db.admin.query("select count(*)::int n from information_schema.role_table_grants where grantee = 'other'")).rows[0].n, 0);
  }

  // ═════ 1. Window parity: SQL vs countBounds.js (Asia/Riyadh) ═════
  {
    const db = DBS[0];
    sec("window parity");
    chk("JS clock is Asia/Riyadh (UTC+3)", new Date(2026, 8, 1).getTimezoneOffset(), -180);
    const fx = [
      { n: "no previous count", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [] },
      { n: "previous completed count", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-20T07:00:00Z", "2026-09-20T10:00:00Z"]] },
      { n: "prev at Riyadh 23:59:59.999", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-19T10:00:00Z", "2026-09-19T20:59:59.999Z"]] },
      { n: "prev at Riyadh 00:00:00.000 next day", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-19T10:00:00Z", "2026-09-19T21:00:00.000Z"]] },
      { n: "count started Riyadh 23:59:59.999", lot: { date_added: "2026-07-01" }, start: "2026-09-29T20:59:59.999Z", prev: [] },
      { n: "count started Riyadh 00:00 next day", lot: { date_added: "2026-07-01" }, start: "2026-09-29T21:00:00.000Z", prev: [] },
      { n: "prev day == received day (source previous_count)", lot: { date_added: "2026-09-20" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-20T05:00:00Z", "2026-09-20T06:00:00Z"]] },
      { n: "prev before received (received wins)", lot: { date_added: "2026-09-25" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-20T05:00:00Z", "2026-09-20T06:00:00Z"]] },
      { n: "received after count start (empty)", lot: { date_added: "2026-10-02" }, start: "2026-09-30T08:00:00Z", prev: [] },
      { n: "in-progress & later counts ignored", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["in_progress", "2026-09-25T05:00:00Z", null], ["completed", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"]] },
      { n: "completed exactly at start (same ms) ignored", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00.500Z", prev: [["completed", "2026-09-29T05:00:00Z", "2026-09-30T08:00:00.500Z"]] },
      { n: "completed 1 ms before start included", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00.500Z", prev: [["completed", "2026-09-29T05:00:00Z", "2026-09-30T08:00:00.499Z"]] },
      { n: "µs earlier but same ms (browser ms precision) ignored", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00.500700Z", prev: [["completed", "2026-09-29T05:00:00Z", "2026-09-30T08:00:00.500200Z"]] },
      { n: "several previous: latest wins", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-08-01T05:00:00Z", "2026-08-01T06:00:00Z"], ["completed", "2026-09-10T05:00:00Z", "2026-09-10T22:30:00Z"], ["completed", "2026-09-05T05:00:00Z", "2026-09-05T06:00:00Z"]] },
      { n: "completed status but no completed_at ignored", lot: { date_added: "2026-07-01" }, start: "2026-09-30T08:00:00Z", prev: [["completed", "2026-09-25T05:00:00Z", null]] },
      { n: "count started exactly Riyadh midnight, prev same day", lot: { date_added: "2026-07-01" }, start: "2026-09-29T21:00:00Z", prev: [["completed", "2026-09-29T21:00:00Z", "2026-09-29T21:00:00Z"]] },
      { n: "no received date → Riyadh day of created_at", lot: { date_added: null, created_at: "2026-07-01T22:30:00Z" }, start: "2026-09-30T08:00:00Z", prev: [] },
      { n: "no lot (reagent removed)", lot: null, start: "2026-09-30T08:00:00Z", prev: [] },
    ];
    for (const f of fx) {
      await db.admin.query("truncate audit_log, consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
      const lotId = U("lot-" + f.n), countId = U("count-" + f.n);
      if (f.lot) await db.admin.query("insert into reagents (id, name, lot_number, current_quantity, date_added, created_at) values ($1, 'X', 'L', 1, $2, $3)", [lotId, f.lot.date_added, f.lot.created_at || "2026-06-01T00:00:00Z"]);
      await db.admin.query("insert into inventory_counts (id, department, status, started_by, started_at) values ($1, 'Chemistry', 'in_progress', 'T', $2)", [countId, f.start]);
      for (const [i, [st, sa, ca]] of f.prev.entries()) {
        const pid = U(`p${i}-${f.n}`);
        await db.admin.query("insert into inventory_counts (id, department, status, started_by, started_at, completed_at) values ($1, $2, $3, 'T', $4, $5)", [pid, `Dept${i}`, st, sa, ca]);
        if (f.lot) await db.admin.query("insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, $2, 'X', 'L', 'D', 'u', 1)", [pid, lotId]);
      }
      if (f.lot) await db.admin.query("insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, $2, 'X', 'L', 'D', 'u', 1)", [countId, lotId]);
      const sql = await rpc(db.anon, "stock_count_window", { p_reagent_id: f.lot ? lotId : null, p_count_id: countId });
      // JS: exactly what StockCount gives countBounds (PostgREST JSON of the same rows).
      const session = (await db.admin.query("select json_build_object('id', id, 'started_at', started_at) j from inventory_counts where id = $1", [countId])).rows[0].j;
      const lines = (await db.admin.query("select coalesce(json_agg(json_build_object('reagent_id', i.reagent_id, 'count_id', i.count_id, 'inventory_counts', json_build_object('status', c.status, 'started_at', c.started_at, 'completed_at', c.completed_at))), '[]') j from inventory_count_items i join inventory_counts c on c.id = i.count_id where i.reagent_id = $1", [lotId])).rows[0].j;
      const lot = f.lot ? (await db.admin.query("select json_build_object('id', id, 'date_added', date_added, 'created_at', created_at) j from reagents where id = $1", [lotId])).rows[0].j : undefined;
      const js = usageInterval({ lot, previousCompletedAt: previousCompletedCounts(lines, session)[lotId], session });
      const jsN = js.ok ? { ok: true, from: js.from, to: js.to, source: js.fromSource } : { ok: false, reason: js.reason, ...(js.from ? { from: js.from, to: js.to } : {}) };
      chk(`${f.n}: SQL = JS ${JSON.stringify(jsN)}`, sql, jsN);
    }
  }

  for (const db of DBS) {
    const G = db.guard ? "guard" : "no-guard";
    const A = db.anon;

    // ═════ 2. Parity with the B1 client writes (same seed, same choices) ═════
    sec(`${G} / parity with B1 client`);
    const cases = [
      ["exact_default", DEFAULT_SEED, B1RUNS.exact_default.writes, "i-alpha", "usage_exact", { p_date: "2026-09-30" }],
      ["exact_changed", DEFAULT_SEED, B1RUNS.exact_changed.writes, "i-alpha", "usage_exact", { p_date: "2026-09-25" }],
      ["exact_changed_then_back", DEFAULT_SEED, B1RUNS.exact_changed_then_back.writes, "i-alpha", "usage_exact", { p_date: "2026-09-30" }],
      ["spread", DEFAULT_SEED, B1RUNS.spread.writes, "i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") }],
      ["spread_remainder", REMAINDER_SEED, B1RUNS.spread_remainder.writes, "i-alpha", "usage_spread", { p_allocation: spreadAlloc(0.07, "2026-09-20", "2026-09-30") }],
      ["spread_received_window", DEFAULT_SEED, B1RUNS.spread_received_window.writes, "i-beta", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-25", "2026-09-30") }],
      ["corrected_shortage", DEFAULT_SEED, B1RUNS.corrected_shortage.writes, "i-alpha", "corrected", {}],
      ["apply_surplus", DEFAULT_SEED, B1RUNS.apply_surplus.writes, "i-gamma", "corrected", {}],
      ["kept", DEFAULT_SEED, B1RUNS.kept.writes, "i-beta", "kept", {}],
      ["auto_remove_usage (Delta 0, alternate lot)", DEFAULT_SEED, JSON.parse(REG.auto_remove_usage_single.sequence.replace(/<ts>/g, "2026-10-05T00:00:00.000Z")), "i-delta1", "usage_exact", { p_date: "2026-09-28" }],
      ["auto_remove_correct (Delta 0, alternate lot)", DEFAULT_SEED, JSON.parse(REG.auto_remove_correct_single.sequence.replace(/<ts>/g, "2026-10-05T00:00:00.000Z")), "i-delta1", "corrected", {}],
    ];
    for (const [name, s, writes, key, method, extra] of cases) {
      await replayClient(db, s, writes); const expected = await biz(db.admin);
      await seed(db, s); const r = await resolve(db, A, key, method, extra); const actual = await biz(db.admin);
      chk(`${name}: status ok`, r.status, "ok");
      if (name === "spread_remainder") {
        // Known, approved difference: the browser computes 5 − 4.93 in floating point.
        const fix = (x) => JSON.parse(JSON.stringify(x).replace("0.07000000000000028", "0.07"));
        chk(`${name}: identical to the B1 client except the browser's float text in the audit row (0.07000000000000028 → 0.07)`, [actual, JSON.stringify(expected).includes("0.07000000000000028")], [fix(expected), true]);
      } else chk(`${name}: logs, stock, auto-removal, audit text, line, resolution_details identical to the B1 client`, actual, expected);
      const l = await line(db, key);
      chk(`${name}: resolved_at is the database clock (within this test run)`, Math.abs(Date.now() - new Date(l.resolved_at).getTime()) < 120000, true);
    }

    // ═════ 3. Auto-remove rule edge cases ═════
    sec(`${G} / auto-remove rule`);
    const ar = async (alternate, target = {}) => {
      const s = JSON.parse(JSON.stringify(DEFAULT_SEED));
      const d1 = s.reagents.find((r) => r.id === "r-delta1"), d2 = s.reagents.find((r) => r.id === "r-delta2");
      Object.assign(d1, target); Object.assign(d2, alternate);
      await seed(db, s); const r = await resolve(db, A, "i-delta1", "corrected", {});
      const t = (await db.admin.query("select deleted, deleted_by from reagents where id = $1", [U("r-delta1")])).rows[0];
      const au = (await db.admin.query("select count(*)::int n from audit_log where performed_by = 'System'")).rows[0].n;
      return [r.status, t.deleted, t.deleted_by, au];
    };
    const REMOVED = ["ok", true, "Auto (lot depleted, alternate lot available)", 1], KEPT_ = ["ok", false, null, 0];
    chk("alternate lot same name + device with stock → removed", await ar({}), REMOVED);
    chk("alternate lot on another device → not removed", await ar({ device: "OTHER" }), KEPT_);
    chk("both devices empty ('') → same device → removed", await ar({ device: "" }, { device: "" }), REMOVED);
    chk("alternate lot deleted → not removed", await ar({ deleted: true }), KEPT_);
    chk("alternate lot at 0 → not removed", await ar({ current_quantity: 0 }), KEPT_);
    chk("name differs only by case → not removed (exact match, as JS ===)", await ar({ name: "delta" }), KEPT_);
    chk("target already deleted (existing quirk kept): re-marked as auto-removed", await ar({}, { deleted: true, deleted_by: "staff-1" }), REMOVED);
    {
      const s = JSON.parse(JSON.stringify(DEFAULT_SEED)); await seed(db, s);
      await resolve(db, A, "i-delta1", "corrected", {});
      chk("auto-remove audit text and actor", (await db.admin.query("select action, entity, description, performed_by from audit_log order by performed_at")).rows.map((r) => [r.action, r.description, r.performed_by]),
        [["edit", "Delta — Lot D1 — Physical count adjustment: 2 → 0", "TESTER"], ["delete", "Delta — Lot D1 (auto-removed, depleted)", "System"]]);
    }

    // ═════ 4. Result contract (every non-ok status writes nothing) ═════
    sec(`${G} / result contract`);
    const noWrite = async (label, fn, expectStatus) => { const before = await fullFp(db.admin); const r = await fn(); chk(`${label} → ${expectStatus}, zero writes`, [r.status ?? r.error, await fullFp(db.admin)], [expectStatus, before]); return r; };
    await seed(db, DEFAULT_SEED);
    await noWrite("unknown method", () => resolve(db, A, "i-alpha", "usage", {}), "invalid_input");
    await noWrite("blank actor", async () => rpc(A, "stock_count_resolve", { ...(await resolveArgs(db, "i-alpha", "kept")), p_actor: " " }), "invalid_input");
    await noWrite("exact without date", () => resolve(db, A, "i-alpha", "usage_exact", {}), "invalid_input");
    await noWrite("spread with a date", () => resolve(db, A, "i-alpha", "usage_spread", { p_date: "2026-09-25", p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") }), "invalid_input");
    await noWrite("usage on a surplus line", () => resolve(db, A, "i-gamma", "usage_exact", { p_date: "2026-09-25" }), "invalid_input");
    await noWrite("unknown line", () => rpc(A, "stock_count_resolve", { p_item_id: U("nope"), p_method: "kept", p_actor: "T", p_seen_expected: 1, p_seen_counted: 0 }), "not_found");
    await noWrite("seen counted differs from the locked row", () => resolve(db, A, "i-alpha", "corrected", { p_seen_counted: 4 }), "stale_line");
    await noWrite("seen expected differs", () => resolve(db, A, "i-alpha", "kept", { p_seen_expected: 6 }), "stale_line");
    await noWrite("line without discrepancy", () => resolve(db, A, "i-delta2", "kept", {}), "no_discrepancy");
    await noWrite("completed count", () => resolve(db, A, "i-done", "kept", {}), "already_resolved");
    // Fabricated state (setup only; the B2 guard forbids reopening a line, so triggers are off for this one statement).
    await db.admin.query("set session_replication_role = replica");
    await db.admin.query("update inventory_count_items set resolved = false where id = $1", [U("i-done")]);
    await db.admin.query("set session_replication_role = origin");
    await noWrite("unresolved line in a completed count", () => resolve(db, A, "i-done", "kept", {}), "invalid_count_state");
    await seed(db, DEFAULT_SEED);
    await noWrite("exact date before the window floor (09-19)", () => resolve(db, A, "i-alpha", "usage_exact", { p_date: "2026-09-19" }), "outside_window");
    await noWrite("exact date after the count start day (10-01)", () => resolve(db, A, "i-alpha", "usage_exact", { p_date: "2026-10-01" }), "outside_window");
    await noWrite("spread starting before the floor", () => resolve(db, A, "i-alpha", "usage_spread", { p_allocation: [{ date: "2026-09-13", amount: 1 }, { date: "2026-09-20", amount: 1 }] }), "outside_window");
    await noWrite("spread sum below the shortage", () => resolve(db, A, "i-alpha", "usage_spread", { p_allocation: [{ date: "2026-09-20", amount: 1 }, { date: "2026-09-27", amount: 0.99 }] }), "allocation_mismatch");
    await noWrite("spread sum above the shortage", () => resolve(db, A, "i-alpha", "usage_spread", { p_allocation: [{ date: "2026-09-20", amount: 1 }, { date: "2026-09-27", amount: 1.01 }] }), "allocation_mismatch");
    for (const [label, alloc] of [["empty allocation", []], ["not an array", { date: "2026-09-20", amount: 2 }], ["negative amount", [{ date: "2026-09-20", amount: 3 }, { date: "2026-09-27", amount: -1 }]],
      ["3 decimals", [{ date: "2026-09-20", amount: 1.005 }, { date: "2026-09-27", amount: 0.995 }]], ["amount as string", [{ date: "2026-09-20", amount: "2" }]], ["invalid date", [{ date: "2026-09-31", amount: 2 }]],
      ["date with time", [{ date: "2026-09-20T00:00", amount: 2 }]], ["duplicate dates", [{ date: "2026-09-20", amount: 1 }, { date: "2026-09-20", amount: 1 }]], ["descending dates", [{ date: "2026-09-27", amount: 1 }, { date: "2026-09-20", amount: 1 }]],
      ["extra key", [{ date: "2026-09-20", amount: 2, note: "x" }]], ["missing amount", [{ date: "2026-09-20" }]]])
      await noWrite(`spread ${label}`, () => resolve(db, A, "i-alpha", "usage_spread", { p_allocation: alloc }), "invalid_allocation");
    await db.admin.query("update inventory_count_items set reagent_id = null where id = $1", [U("i-alpha")]);
    await noWrite("usage when the lot no longer exists", () => resolve(db, A, "i-alpha", "usage_exact", { p_date: "2026-09-25" }), "window_unavailable");
    chk("corrected without a lot: resolve only (no stock, no audit), as today", [(await resolve(db, A, "i-alpha", "corrected", {})).status, (await db.admin.query("select count(*)::int n from audit_log")).rows[0].n, (await line(db, "i-alpha")).resolution_note], ["ok", 0, "Corrected to match count"]);
    await seed(db, DEFAULT_SEED);
    chk("zero spread entries allowed (current spread can emit 0 for tiny shortages)", (await resolve(db, A, "i-alpha", "usage_spread", { p_allocation: [{ date: "2026-09-20", amount: 0 }, { date: "2026-09-27", amount: 2 }] })).status, "ok");

    // ═════ 5. Kept / corrected exact writes ═════
    sec(`${G} / method writes`);
    {
      await seed(db, DEFAULT_SEED); const f0 = await biz(db.admin);
      const r = await resolve(db, A, "i-beta", "kept", {}); const f1 = await biz(db.admin);
      chk("kept: only the line changes (no log, no stock, no audit)", [r.status, f1.logs, f1.reagents, f1.audit], ["ok", f0.logs, f0.reagents, f0.audit]);
      chk("kept: line resolution", [r.line.resolved, r.line.resolution_note, r.line.resolved_by, r.line.resolution_details], [true, "Kept system value", "TESTER", { v: 1, method: "kept", discrepancy: { expected: 4, counted: 2, difference: -2 }, window: null, allocation: [], date_provenance: null }]);
      await seed(db, DEFAULT_SEED);
      const r2 = await resolve(db, A, "i-alpha", "usage_exact", { p_date: "2026-09-30" });
      const logs = (await db.admin.query("select id, amount::float8 a, source_count_item_id s, date_provenance p from consumption_logs where reagent_id = $1 and used_by = $2 and id <> $3", [U("r-alpha"), C, U("log-x")])).rows;
      chk("exact: one row linked to the line, provenance chosen by the database, ids recorded", [logs.length, logs[0].a, logs[0].s, logs[0].p, r2.log_ids, r2.line.consumption_log_ids], [1, 2, U("i-alpha"), "count_exact_default", [logs[0].id], [logs[0].id]]);
    }

    // ═════ 6. Failure injection (resolve) ═════
    sec(`${G} / failure injection: resolve`);
    const faultCase = async (label, s, key, method, extra, point, verify) => {
      await seed(db, s); const before = await fullFp(db.admin);
      await A.query(`set test.fault = '${point}'`); const r = await resolve(db, A, key, method, extra); await A.query("reset test.fault");
      chk(`${label} @ ${point}: call fails`, /injected fault/.test(r.error || ""), true);
      chk(`${label} @ ${point}: NOTHING committed (all 5 tables byte-identical)`, await fullFp(db.admin), before);
      const r2 = await resolve(db, A, key, method, extra);
      chk(`${label} @ ${point}: retry without fault succeeds exactly once`, [r2.status, ...(await verify())], ["ok", ...(await verify.expected)]);
    };
    const usageCounts = (itemKey, lotKey) => { const f = async () => { const q = (await db.admin.query("select (select count(*) from consumption_logs where source_count_item_id = $1)::int logs, (select count(*) from audit_log)::int audits, (select current_quantity::float8 from reagents where id = $2) qty, (select resolved from inventory_count_items where id = $1) res", [U(itemKey), U(lotKey)])).rows[0]; return [q.logs, q.audits, q.qty, q.res]; }; return f; };
    const withExp = (f, exp) => Object.assign(f, { expected: Promise.resolve(exp) });
    for (const p of ["consumption_logs_insert_before_1", "consumption_logs_insert_after_1", "reagents_update_before_1", "reagents_update_after_1", "audit_log_insert_before_1", "audit_log_insert_after_1", "inventory_count_items_update_before_1", "inventory_count_items_update_after_1"])
      await faultCase("exact", DEFAULT_SEED, "i-alpha", "usage_exact", { p_date: "2026-09-25" }, p, withExp(usageCounts("i-alpha", "r-alpha"), [1, 1, 3, true]));
    for (const p of ["consumption_logs_insert_before_1", "consumption_logs_insert_before_2", "consumption_logs_insert_after_2", "reagents_update_before_1", "audit_log_insert_after_1", "inventory_count_items_update_before_1"])
      await faultCase("spread (2 rows)", DEFAULT_SEED, "i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") }, p, withExp(usageCounts("i-alpha", "r-alpha"), [2, 1, 3, true]));
    for (const p of ["reagents_update_before_2", "reagents_update_after_2", "audit_log_insert_before_2", "audit_log_insert_after_2"])
      await faultCase("exact + auto-remove", DEFAULT_SEED, "i-delta1", "usage_exact", { p_date: "2026-09-28" }, p, withExp(usageCounts("i-delta1", "r-delta1"), [1, 2, 0, true]));
    for (const p of ["reagents_update_before_1", "reagents_update_after_1", "audit_log_insert_before_1", "audit_log_insert_after_1", "inventory_count_items_update_before_1"])
      await faultCase("corrected", DEFAULT_SEED, "i-alpha", "corrected", {}, p, withExp(usageCounts("i-alpha", "r-alpha"), [0, 1, 3, true]));
    for (const p of ["inventory_count_items_update_before_1", "inventory_count_items_update_after_1"])
      await faultCase("kept", DEFAULT_SEED, "i-beta", "kept", {}, p, withExp(usageCounts("i-beta", "r-beta"), [0, 0, 4, true]));

    // ═════ 7. Concurrency (two real connections) ═════
    sec(`${G} / concurrency: resolve`);
    const callR = (key, method, extra) => async (c) => resolve(db, c, key, method, extra);
    const combos = [
      ["exact vs exact", callR("i-alpha", "usage_exact", { p_date: "2026-09-25" }), callR("i-alpha", "usage_exact", { p_date: "2026-09-28" })],
      ["exact vs spread", callR("i-alpha", "usage_exact", { p_date: "2026-09-25" }), callR("i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") })],
      ["spread vs corrected", callR("i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") }), callR("i-alpha", "corrected", {})],
      ["corrected vs kept", callR("i-alpha", "corrected", {}), callR("i-alpha", "kept", {})],
    ];
    for (const [name, ca, cb] of combos) {
      await seed(db, DEFAULT_SEED); await ca(db.anon); const onlyA = await biz(db.admin);
      await seed(db, DEFAULT_SEED);
      const { ra, rb, waited } = await race(db, ca, cb, true);
      chk(`${name}: B waited on A's lock; A ok; B already_resolved`, [waited, ra.status, rb.status], [true, "ok", "already_resolved"]);
      chk(`${name}: final state == A alone (B wrote nothing: no 2nd allocation, stock effect, audit or snapshot)`, await biz(db.admin), onlyA);
      await seed(db, DEFAULT_SEED); await cb(db.anon); const onlyB = await biz(db.admin);
      await seed(db, DEFAULT_SEED);
      const x = await race(db, ca, cb, false);
      chk(`${name}: A rolls back while B waits → B proceeds and succeeds once`, [x.waited, x.rb.status, await biz(db.admin)], [true, "ok", onlyB]);
    }

    // ═════ 8. Retry / lost response ═════
    sec(`${G} / retry`);
    {
      await seed(db, DEFAULT_SEED);
      const args = await resolveArgs(db, "i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") });
      const X = await anonConn(db); await X.query("begin"); const first = await rpc(X, "stock_count_resolve", args); await X.query("commit"); await X.end(); // response "lost" by the client
      const fp = await fullFp(db.admin);
      const again = await rpc(A, "stock_count_resolve", args);
      chk("lost response, retry with the same request → already_resolved, zero writes", [first.status, again.status, await fullFp(db.admin)], ["ok", "already_resolved", fp]);
      chk("the retry returns the committed line (same resolution_details / resolved_at)", [again.line.resolution_details, again.line.resolved_at], [first.line.resolution_details, first.line.resolved_at]);
      const third = await resolve(db, A, "i-alpha", "kept", {});
      chk("retry after success with a different method → already_resolved, zero writes", [third.status, await fullFp(db.admin)], ["already_resolved", fp]);
      chk("exactly one allocation, one audit, one stock effect", (await db.admin.query("select (select count(*) from consumption_logs where source_count_item_id = $1)::int l, (select count(*) from audit_log)::int a, (select current_quantity::float8 from reagents where id = $2) q", [U("i-alpha"), U("r-alpha")])).rows[0], { l: 2, a: 1, q: 3 });
    }

    // ═════ 9. Edit dates (redate) ═════
    sec(`${G} / redate`);
    const prepCompletedSpread = async () => {
      await seed(db, DEFAULT_SEED);
      await resolve(db, A, "i-alpha", "usage_spread", { p_allocation: spreadAlloc(2, "2026-09-20", "2026-09-30") });
      for (const k of ["i-beta", "i-delta1"]) await resolve(db, A, k, "kept", {});
      await resolve(db, A, "i-gamma", "corrected", {});
      await finishCount(db, "c-open");
      return (await line(db, "i-alpha"));
    };
    const redate = async (c, key, args) => rpc(c, "stock_count_redate", { p_item_id: U(key), p_actor: "TESTER", ...args });
    {
      // Parity with the B1 client's Edit dates (two edits after a spread).
      await replayClient(db, DEFAULT_SEED, B1RUNS.edit_dates_after_spread.writes); const expected = await biz(db.admin);
      const l0 = await prepCompletedSpread();
      const r1 = await redate(A, "i-alpha", { p_current_log_ids: l0.consumption_log_ids, p_mode: "exact", p_date: "2026-09-22" });
      const r2 = await redate(A, "i-alpha", { p_current_log_ids: r1.log_ids, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-30", p_allocation: spreadAlloc(2, "2026-09-21", "2026-09-30") });
      const l2 = await line(db, "i-alpha");
      chk("parity: two Edit dates → state identical to the B1 client (rows, note, audit text, stock, details)", [r1.status, r2.status, await biz(db.admin)], ["ok", "ok", expected]);
      chk("resolved_at / resolved_by / resolution_details untouched by both edits", [l2.resolved_at.getTime(), l2.resolved_by, l2.resolution_details], [l0.resolved_at.getTime(), l0.resolved_by, l0.resolution_details]);
      chk("replacement rows: same line, count_redated, total 2, old rows gone", (await db.admin.query("select count(*)::int n, sum(amount)::float8 s, bool_and(source_count_item_id = $1) linked, bool_and(date_provenance = 'count_redated') p from consumption_logs where reagent_id = $2 and used_by = $3 and id <> $4", [U("i-alpha"), U("r-alpha"), C, U("log-x")])).rows[0], { n: 2, s: 2, linked: true, p: true });
      await replayClient(db, DEFAULT_SEED, B1RUNS.edit_dates_historical.writes); const expH = await biz(db.admin);
      await seed(db, DEFAULT_SEED);
      const rh = await redate(A, "i-done", { p_current_log_ids: [U("log-x")], p_mode: "exact", p_date: "2026-08-15" });
      chk("parity: historical linked line (ids, no source link) → identical to the B1 client", [rh.status, await biz(db.admin)], ["ok", expH]);
      chk("historical line: details / resolved_at / resolved_by stay NULL (nothing invented)", (await db.admin.query("select resolution_details, resolved_at, resolved_by from inventory_count_items where id = $1", [U("i-done")])).rows[0], { resolution_details: null, resolved_at: null, resolved_by: null });
    }
    {
      // Historical lines resolved before log links existed: the app's existing match, deterministic or refused.
      const hist = async (logs, extraItems = []) => {
        const s = JSON.parse(JSON.stringify(DEFAULT_SEED));
        s.inventory_counts.push({ id: "c-h", department: "Phlebotomy", status: "completed", started_by: "T", started_at: "2026-09-10T08:00:00Z", completed_by: "T", completed_at: "2026-09-10T09:00:00Z" });
        s.inventory_count_items.push({ id: "i-h", count_id: "c-h", reagent_id: "r-hemo", reagent_name: "Hemo", lot_number: "H1", department: "Hematology", unit: "box", expected_quantity: 5, counted_quantity: 3, resolved: true, resolution_note: "Logged as usage on 2026-09-10", consumption_log_ids: [], created_at: "2026-09-10T08:00:00Z" }, ...extraItems);
        logs.forEach((l, i) => s.consumption_logs.push({ id: `h${i}`, reagent_id: "r-hemo", used_by: C, note: "Retroactively logged — found missing during a physical count.", deleted: false, ...l }));
        await seed(db, s);
      };
      const H = (n) => U(`h${n}`);
      await hist([{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:30:00Z" }]);
      const ok = await redate(A, "i-h", { p_current_log_ids: [H(0)], p_mode: "exact", p_date: "2026-09-05" });
      chk("historical unlinked line, single matching row → re-dated, linked to the line, count_redated", [ok.status, (await db.admin.query("select to_char(date,'YYYY-MM-DD') d, source_count_item_id s, date_provenance p from consumption_logs where reagent_id = $1", [U("r-hemo")])).rows], ["ok", [{ d: "2026-09-05", s: U("i-h"), p: "count_redated" }]]);
      const refuse = async (label, logs, ids, status, reason, extraItems) => { await hist(logs, extraItems); const fp = await fullFp(db.admin); const r = await redate(A, "i-h", { p_current_log_ids: ids, p_mode: "exact", p_date: "2026-09-05" }); chk(`historical ${label} → ${status}${reason ? "/" + reason : ""}, zero writes`, [r.status, r.reason ?? null, await fullFp(db.admin)], [status, reason ?? null, fp]); };
      await refuse("duplicate row (duplicate-correction: sum 4 ≠ shortage 2)", [{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:30:00Z" }, { amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:31:00Z" }], [H(0), H(1)], "allocation_unsafe", "no_exact_match");
      await refuse("row created after the count window", [{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T09:01:30Z" }], [H(0)], "allocation_unsafe", "no_exact_match");
      await refuse("row already claimed by another line", [{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:30:00Z" }], [H(0)], "allocation_unsafe", "claimed_by_another_line",
        [{ id: "i-h2", count_id: "c-done", reagent_id: "r-hemo", reagent_name: "Hemo", lot_number: "H1", department: "Hematology", unit: "box", expected_quantity: 1, counted_quantity: 0, resolved: true, resolution_note: "Logged as usage on 2026-09-01", consumption_log_ids: ["h0"], created_at: "2026-09-01T08:00:00Z" }]);
      await refuse("undone (soft-deleted) row", [{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:30:00Z", deleted: true }], [H(0)], "allocation_unsafe", "deleted_row");
      await refuse("client's ids differ from the match", [{ amount: 2, date: "2026-09-10", created_at: "2026-09-10T08:30:00Z" }], [U("something-else")], "stale_allocation");
    }
    {
      sec(`${G} / redate contract`);
      const l0 = await prepCompletedSpread(); const ids = l0.consumption_log_ids;
      const nw = async (label, key, args, status) => { const fp = await fullFp(db.admin); const r = await redate(A, key, args); chk(`${label} → ${status}, zero writes`, [r.status ?? r.error, await fullFp(db.admin)], [status, fp]); };
      await nw("stale ids (another device re-dated)", "i-alpha", { p_current_log_ids: [U("zz")], p_mode: "exact", p_date: "2026-09-22" }, "stale_allocation");
      await nw("subset of the current rows", "i-alpha", { p_current_log_ids: ids.slice(0, 1), p_mode: "exact", p_date: "2026-09-22" }, "stale_allocation");
      await nw("exact date outside window", "i-alpha", { p_current_log_ids: ids, p_mode: "exact", p_date: "2026-10-01" }, "outside_window");
      await nw("range crossing the floor", "i-alpha", { p_current_log_ids: ids, p_mode: "range", p_from: "2026-09-13", p_to: "2026-09-30", p_allocation: spreadAlloc(2, "2026-09-13", "2026-09-30") }, "outside_window");
      await nw("range allocation outside its own from/to", "i-alpha", { p_current_log_ids: ids, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-25", p_allocation: [{ date: "2026-09-21", amount: 1 }, { date: "2026-09-28", amount: 1 }] }, "outside_window");
      await nw("range total changed", "i-alpha", { p_current_log_ids: ids, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-30", p_allocation: [{ date: "2026-09-21", amount: 1 }, { date: "2026-09-28", amount: 2 }] }, "allocation_mismatch");
      await nw("range malformed allocation", "i-alpha", { p_current_log_ids: ids, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-30", p_allocation: [{ date: "2026-09-28", amount: 1 }, { date: "2026-09-21", amount: 1 }] }, "invalid_allocation");
      await nw("kept line", "i-beta", { p_current_log_ids: [], p_mode: "exact", p_date: "2026-09-22" }, "invalid_line_state");
      await nw("corrected line", "i-gamma", { p_current_log_ids: [], p_mode: "exact", p_date: "2026-09-22" }, "invalid_line_state");
      await nw("mode/argument mismatch", "i-alpha", { p_current_log_ids: ids, p_mode: "exact", p_from: "2026-09-21" }, "invalid_input");
      await nw("unknown line", "nope", { p_current_log_ids: ids, p_mode: "exact", p_date: "2026-09-22" }, "not_found");
      await seed(db, DEFAULT_SEED);
      await resolve(db, A, "i-alpha", "usage_exact", { p_date: "2026-09-25" });
      await nw("count still in progress", "i-alpha", { p_current_log_ids: (await line(db, "i-alpha")).consumption_log_ids, p_mode: "exact", p_date: "2026-09-22" }, "invalid_count_state");
      // a linked row undone by the generic editor (pre-B2) must not be resurrected
      const l1 = await prepCompletedSpread(); if (!db.guard) {
        await db.admin.query("update consumption_logs set deleted = true where id = $1", [l1.consumption_log_ids[0]]);
        await nw("linked row was undone (soft-deleted)", "i-alpha", { p_current_log_ids: l1.consumption_log_ids, p_mode: "exact", p_date: "2026-09-22" }, "allocation_unsafe");
      }
    }
    {
      sec(`${G} / failure injection: redate`);
      for (const p of ["consumption_logs_insert_before_1", "consumption_logs_insert_after_1", "consumption_logs_insert_after_2", "consumption_logs_delete_before_1", "consumption_logs_delete_after_1", "consumption_logs_delete_before_2", "inventory_count_items_update_before_1", "audit_log_insert_before_1", "audit_log_insert_after_1"]) {
        const l0 = await prepCompletedSpread(); const before = await fullFp(db.admin);
        const oldRows = (await db.admin.query("select id from consumption_logs where id = any($1) order by id", [l0.consumption_log_ids])).rows.map((r) => r.id);
        const args = { p_current_log_ids: l0.consumption_log_ids, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-30", p_allocation: spreadAlloc(2, "2026-09-21", "2026-09-30") };
        await A.query(`set test.fault = '${p}'`); const r = await redate(A, "i-alpha", args); await A.query("reset test.fault");
        chk(`redate @ ${p}: fails, NOTHING committed (old allocation intact, no partial new rows, stock & details unchanged)`, [/injected fault/.test(r.error || ""), await fullFp(db.admin), oldRows.length], [true, before, 2]);
        const r2 = await redate(A, "i-alpha", args);
        chk(`redate @ ${p}: retry succeeds once (2 new rows, total 2, old rows gone)`, [r2.status, (await db.admin.query("select count(*)::int n, sum(amount)::float8 s, count(*) filter (where id = any($2))::int old from consumption_logs where source_count_item_id = $1", [U("i-alpha"), oldRows])).rows[0]], ["ok", { n: 2, s: 2, old: 0 }]);
      }
      sec(`${G} / concurrency: redate`);
      let cur = null; // the rows both devices saw (fresh ids after every preparation)
      const prep = async () => { cur = (await prepCompletedSpread()).consumption_log_ids; };
      const ra = (c) => redate(c, "i-alpha", { p_current_log_ids: cur, p_mode: "exact", p_date: "2026-09-22" });
      const rb = (c) => redate(c, "i-alpha", { p_current_log_ids: cur, p_mode: "range", p_from: "2026-09-21", p_to: "2026-09-30", p_allocation: spreadAlloc(2, "2026-09-21", "2026-09-30") });
      await prep(); await ra(db.anon); const onlyA = await biz(db.admin);
      await prep();
      const x = await race(db, ra, rb, true);
      chk("simultaneous re-dates: B waited; A ok; B stale_allocation; final == A alone (one allocation)", [x.waited, x.ra.status, x.rb.status, await biz(db.admin)], [true, "ok", "stale_allocation", onlyA]);
      await prep(); await rb(db.anon); const onlyB = await biz(db.admin);
      await prep();
      const y = await race(db, ra, rb, false);
      chk("A rolls back while B waits → B re-dates once", [y.waited, y.rb.status, await biz(db.admin)], [true, "ok", onlyB]);
      chk("never two replacement allocations", (await db.admin.query("select count(*)::int n from consumption_logs where source_count_item_id = $1", [U("i-alpha")])).rows[0].n, 2);
    }

    // ═════ 10. Guard: function writes pass, direct forbidden mutations still refused ═════
    if (db.guard) {
      sec("guard / direct mutations after function writes");
      await prepCompletedSpread();
      const id = U("i-alpha");
      const t = async (sql, p) => { try { await A.query(sql, p); return "OK"; } catch (e) { return `${e.code}:${e.message}/${e.detail}`; } };
      chk("direct change of resolution_details refused", await t(`update inventory_count_items set resolution_details = '{"v":1}' where id = $1`, [id]), "P0001:evidence_field_protected/resolution_details");
      chk("direct change of resolved_at refused", await t("update inventory_count_items set resolved_at = now() where id = $1", [id]), "P0001:evidence_field_protected/resolved_at");
      chk("direct amount change on a function-written correction row refused", await t("update consumption_logs set amount = 9 where source_count_item_id = $1", [id]), "P0001:evidence_field_protected/amount");
      chk("direct undo of a function-written correction row refused", await t("update consumption_logs set deleted = true where source_count_item_id = $1", [id]), "P0001:evidence_field_protected/deleted");
      chk("direct provenance change refused", await t("update consumption_logs set date_provenance = 'manual' where source_count_item_id = $1", [id]), "P0001:evidence_field_protected/date_provenance");
    }

    // ═════ 11. Current app unaffected (functions present, guard off) ═════
    if (!db.guard) {
      sec("no-guard / current app write patterns with functions installed");
      await seed(db, DEFAULT_SEED);
      const q = async (sql, p) => { try { const r = await A.query(sql, p); return r.rows[0]?.id ?? "OK"; } catch (e) { return `ERR ${e.code} ${e.message}`; } };
      const out = [];
      const m = await q(`insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc) values ($1, 1, '2026-10-05', 'staff-1', 'x', false) returning id`, [U("r-hemo")]); out.push(typeof m === "string" && m.startsWith("ERR") ? m : "OK");
      out.push(await q("update consumption_logs set amount = 2, date = '2026-10-04', used_by = 'staff-2', edited_by = 'staff-1', edited_at = now() where id = $1", [m]));
      out.push(await q("update consumption_logs set deleted = true, deleted_by = 'staff-1', deleted_at = now() where id = $1", [m]));
      const cnt = await q("insert into inventory_counts (department, started_by) values ('Phlebotomy', 'staff-1') returning id");
      const it = await q("insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, $2, 'Hemo', 'H1', 'Phlebotomy', 'box', 3) returning id", [cnt, U("r-hemo")]);
      out.push(await q("update inventory_count_items set counted_quantity = 1 where id = $1", [it]));
      const corr = await q(`insert into consumption_logs (reagent_id, amount, date, used_by, note) values ($1, 2, '2026-10-05', '${C}', 'Retroactively logged — found missing during a physical count.') returning id`, [U("r-hemo")]); out.push(corr.startsWith?.("ERR") ? corr : "OK");
      out.push(await q("update inventory_count_items set consumption_log_ids = array[$1::uuid] where id = $2", [corr, it]));
      out.push(await q("update reagents set current_quantity = 1 where id = $1", [U("r-hemo")]));
      out.push(await q("insert into audit_log (action, entity, description, performed_by) values ('edit', 'reagent', 'x', 'staff-1') returning id").then((v) => (v.startsWith?.("ERR") ? v : "OK")));
      out.push(await q("update inventory_count_items set resolved = true, resolution_note = 'Logged as usage on 2026-10-05' where id = $1", [it]));
      out.push(await q("update inventory_counts set status = 'completed', completed_by = 'staff-1', completed_at = now() where id = $1", [cnt]));
      const rep = await q(`insert into consumption_logs (reagent_id, amount, date, used_by, note) values ($1, 2, '2026-10-01', '${C}', 'x') returning id`, [U("r-hemo")]); out.push(rep.startsWith?.("ERR") ? rep : "OK");
      out.push(await q("delete from consumption_logs where id = $1", [corr]));
      out.push(await q("update inventory_count_items set resolution_note = 'Logged as usage on 2026-10-01' where id = $1", [it]));
      out.push(await q("update inventory_count_items set consumption_log_ids = array[$1::uuid] where id = $2", [rep, it]));
      const cnt2 = await q("insert into inventory_counts (department, started_by) values ('Phlebotomy', 'staff-1') returning id");
      await q("insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity) values ($1, $2, 'Hemo', 'H1', 'Phlebotomy', 'box', 3)", [cnt2, U("r-hemo")]);
      out.push(await q("delete from inventory_counts where id = $1", [cnt2]));
      chk("deployed app's direct writes (Log use insert/edit/undo, start, save, correction, link, stock, audit, resolve, finish, Edit dates, delete count) all work", out.filter((x) => x !== "OK"), []);
      chk("B1 app's evidence fields still writable directly (B1 replay is run separately)", await q("update inventory_count_items set counted_at = now(), counted_by = 'staff-1' where id = $1", [it]), "OK");
    }
  }
  for (const db of DBS) { await db.anon.end(); await db.admin.end(); }
  } finally { await server.stop(); }
}, { expectedChecks: 459 });
