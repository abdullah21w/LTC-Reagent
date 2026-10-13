// Batch C — atomic Stock Count start (stock_count_start) on real PostgreSQL:
// migration and grants; eligibility = the client's rule (not deleted, exact department,
// Whole lab = every department; "All lab" is an ordinary department); initial line state;
// result contract (every refusal writes nothing); concurrent starts on two connections
// (advisory lock, department vs Whole lab, rollback while waiting); quantity changes racing
// the start (row locks; snapshot = committed value); fault injection (nothing committed,
// retry once); coexistence with resolve, the guard and the scope rule.
// Ported from runC.mjs; device names and staff codes replaced by synthetic ones.
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles, faultTriggers } from "../helpers/pg.mjs";
import { uuidOf } from "../helpers/uuid.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = uuidOf;
let section = "";
const chk = (n, a, b) => check(`[${section}] ${n}`, a, b);
const BASE = `
  grant usage on schema public to anon, authenticated, other;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create table reagents (id uuid primary key default gen_random_uuid(), name text not null, department text not null, device text not null default '', lot_number text not null, unit text not null,
    current_quantity numeric not null, deleted boolean not null default false, deleted_by text, deleted_at timestamptz, expiry_date date, date_added date not null default current_date, item_type text not null default 'Reagent', created_at timestamptz default now());
  create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
  create table consumption_logs (id uuid primary key default gen_random_uuid(), reagent_id uuid references reagents(id) on delete cascade, amount numeric not null, date date not null, used_by text not null, note text, tested_by_qc boolean not null default false, active_device_changed boolean not null default false, previous_active_lot_id uuid, deleted boolean not null default false, deleted_by text, deleted_at timestamptz, edited_by text, edited_at timestamptz, created_at timestamptz not null default now());
  create table audit_log (id uuid primary key default gen_random_uuid(), action text not null, entity text not null, description text not null, performed_by text not null, performed_at timestamptz not null default now());
  alter table reagents enable row level security; create policy "allow all reagents" on reagents for all using (true) with check (true);
  grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`;
const CHAIN = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql", "ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_EVIDENCE_GUARD.sql"];
const START = readRoot("ADD_STOCK_COUNT_START.sql");
const FAULTS = faultTriggers(["inventory_counts", "inventory_count_items", "audit_log", "reagents", "consumption_logs"]);
// Lots: departments incl. "All lab" (an ordinary department), a deleted lot, a lot at 0, several devices.
const LOTS = [
  ["A", "Chemistry", "Analyzer 1", 8], ["B", "Chemistry", "", 3], ["C", "Chemistry", "Analyzer 2", 15], ["Cz", "Chemistry", "", 0], ["Cdel", "Chemistry", "", 5, true],
  ["H1", "Hematology", "Analyzer 3", 4], ["L1", "All lab", "", 20], ["L2", "All lab", "", 1], ["Ldel", "All lab", "", 2, true], ["P1", "Phlebotomy", "", 7],
];

for (const version of PG_VERSIONS) suite(`Batch C · atomic Stock Count start (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
  const db = await server.createDatabase();
  const connect = () => server.connect(db);
  const admin = await connect();
  await ensureRoles(admin, ["anon", "authenticated", "other"]);
  await admin.query(BASE);
  for (const f of CHAIN) await admin.query(readRoot(f));
  await admin.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
  const cat = async () => ({ f: (await admin.query("select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' n, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1")).rows, t: (await admin.query("select tgname n, md5(pg_get_triggerdef(oid)) h from pg_trigger where not tgisinternal order by 1")).rows });
  const before = await cat();
  let e1 = null, e2 = null; try { await admin.query(START); } catch (e) { e1 = e.message; } try { await admin.query(START); } catch (e) { e2 = e.message; }
  const after = await cat();
  await admin.query(FAULTS);
  const anon = async () => { const c = await connect(); await c.query("set role anon"); return c; };
  const A = await anon();

  section = "migration";
  chk("ADD_STOCK_COUNT_START.sql runs twice without error (on Foundation + Functions + B2 Guard + scope rule)", [e1, e2], [null, null]);
  chk("adds exactly stock_count_start; every existing function and trigger unchanged", [after.f.filter((x) => !before.f.some((y) => y.n === x.n)).map((x) => x.n), before.f.filter((x) => !after.f.some((y) => y.n === x.n && y.h === x.h)).map((x) => x.n), JSON.stringify(after.t) === JSON.stringify(before.t)], [["stock_count_start(p_department text, p_actor text)"], [], true]);
  chk("SECURITY INVOKER, fixed search_path; EXECUTE for anon only", (await admin.query("select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') au, has_function_privilege('other', p.oid, 'execute') o from pg_proc p where proname = 'stock_count_start'")).rows[0], { prosecdef: false, proconfig: ["search_path=pg_catalog, public, pg_temp"], a: true, au: false, o: false });

  const reset = async () => {
    await admin.query("set session_replication_role = replica");
    await admin.query("truncate audit_log, consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
    await admin.query("set session_replication_role = origin");
    for (const [k, dept, dev, q, del] of LOTS) await admin.query("insert into reagents (id, name, department, device, lot_number, unit, current_quantity, deleted, expiry_date) values ($1, $2, $3, $4, $5, 'box', $6, $7, '2027-01-01')", [U(k), `R-${k}`, dept, dev, `LOT-${k}`, q, !!del]);
  };
  const fp = async () => (await admin.query(`select md5(string_agg(h, '|' order by t)) fp from (
      select 'r' t, coalesce(string_agg(x::text, ',' order by x.id), '') h from reagents x union all
      select 'a', coalesce(string_agg(x::text, ',' order by x.id), '') from audit_log x union all
      select 'i', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_count_items x union all
      select 'c', coalesce(string_agg(x::text, ',' order by x.id), '') from inventory_counts x) s`)).rows[0].fp;
  const start = async (c, dept, actor = "staff-1") => { try { return (await c.query("select stock_count_start(p_department => $1, p_actor => $2) r", [dept, actor])).rows[0].r; } catch (e) { return { error: `${e.code}:${e.message}` }; } };
  const name = Object.fromEntries(LOTS.map(([k]) => [U(k), k]));

  // ── Eligibility: same rule as the client (not deleted, exact department; Whole lab = all) ──
  section = "eligibility";
  for (const dept of ["Chemistry", "All lab", "Hematology", "Phlebotomy", null, "Biochemistry", "chemistry"]) {
    await reset();
    const r = await start(A, dept);
    const clientRule = LOTS.filter(([, d, , , del]) => !del && (dept === null || d === dept)).map(([k, d, , q]) => [k, d, q]).sort();
    const got = (r.items || []).map((i) => [name[i.reagent_id], i.department, Number(i.expected_quantity)]).sort();
    chk(`${dept ?? "Whole lab"}: lots = client rule (not deleted, exact department${dept === null ? ", every department" : ""}); expected = database quantity`, clientRule.length ? [r.status, got] : [r.status], clientRule.length ? ["ok", clientRule] : ["no_items"]);
  }
  chk("'All lab' is an ordinary department (only its own lots), not Whole lab", LOTS.filter(([, d, , , del]) => !del && d === "All lab").length, 2);

  // ── Header / line initial state ──
  section = "initial state";
  {
    await reset();
    const t0 = (await admin.query("select now() n")).rows[0].n;
    const r = await start(A, "Chemistry", "staff-a");
    const h = (await admin.query("select department, status, started_by, started_at, completed_by, completed_at from inventory_counts")).rows[0];
    chk("header: department, status in_progress, started_by = actor, not completed", [h.department, h.status, h.started_by, h.completed_by, h.completed_at], ["Chemistry", "in_progress", "staff-a", null, null]);
    chk("started_at = database time of the start (not browser)", Math.abs(new Date(h.started_at) - new Date(t0)) < 5000, true);
    const items = (await admin.query("select reagent_name, lot_number, department, unit, counted_quantity, counted_at, counted_by, resolved, resolution_note, consumption_log_ids, resolved_at, resolved_by, resolution_details from inventory_count_items order by reagent_name")).rows;
    chk("lines: snapshot fields from the lot; every count/resolution/evidence field at its default (nothing pre-filled)", items.map((i) => [i.reagent_name, i.lot_number, i.department, i.unit, i.counted_quantity, i.counted_at, i.counted_by, i.resolved, i.resolution_note, i.consumption_log_ids, i.resolved_at, i.resolved_by, i.resolution_details]),
      ["A", "B", "C", "Cz"].map((k) => [`R-${k}`, `LOT-${k}`, "Chemistry", "box", null, null, null, false, null, [], null, null, null]));
    chk("returned count/items = stored rows (items ordered department, name — as the app reads them)", [r.count.id === (await admin.query("select id from inventory_counts")).rows[0].id, r.items.map((i) => i.reagent_name)], [true, ["R-A", "R-B", "R-C", "R-Cz"]]);
    chk("no audit row (starting a count never wrote one)", (await admin.query("select count(*)::int n from audit_log")).rows[0].n, 0);
  }

  // ── Result contract ──
  section = "result contract";
  {
    const nw = async (label, fn, status) => { const f0 = await fp(); const r = await fn(); chk(`${label} → ${status}, zero writes`, [r.status ?? r.error, await fp()], [status, f0]); };
    await reset();
    await nw("department with no lots", () => start(A, "Biochemistry"), "no_items");
    await nw("blank department", () => start(A, "  "), "invalid_scope");
    await nw("blank actor", () => start(A, "Chemistry", " "), "invalid_input");
    await reset(); await admin.query("update reagents set deleted = true");
    await nw("every lot deleted (Whole lab)", () => start(A, null), "no_items");
    for (const [label, first, second, status] of [["same department open", "Chemistry", "Chemistry", "scope_conflict"], ["Whole lab open → Chemistry", null, "Chemistry", "scope_conflict"], ["Chemistry open → Whole lab", "Chemistry", null, "scope_conflict"], ["Whole lab open → Whole lab", null, null, "scope_conflict"], ["Chemistry open → All lab", "Chemistry", "All lab", "ok"], ["Chemistry open → Hematology", "Chemistry", "Hematology", "ok"]]) {
      await reset(); await start(A, first);
      if (status === "ok") chk(`sequential: ${label} → ok (both open)`, [(await start(A, second)).status, (await admin.query("select count(*)::int n from inventory_counts where status = 'in_progress'")).rows[0].n], ["ok", 2]);
      else await nw(`sequential: ${label}`, () => start(A, second), status);
    }
  }

  // ── Concurrent starts (two connections) ──
  section = "concurrent starts";
  async function race(depA, depB, commitA = true) {
    const CA = await anon(), CB = await anon();
    const bPid = (await CB.query("select pg_backend_pid() p")).rows[0].p;
    await CA.query("begin"); const ra = await start(CA, depA, "DEV-A");
    const pb = start(CB, depB, "DEV-B"); let waited = false;
    for (let i = 0; i < 250 && !waited; i++) { const w = (await admin.query("select wait_event_type t, wait_event e from pg_stat_activity where pid = $1", [bPid])).rows[0]; waited = w?.t === "Lock"; if (!waited) await sleep(20); }
    const waitedOn = (await admin.query("select wait_event e from pg_stat_activity where pid = $1", [bPid])).rows[0]?.e;
    await CA.query(commitA ? "commit" : "rollback"); const rb = await pb;
    await CA.end(); await CB.end();
    const counts = (await admin.query("select c.department, c.started_by, (select count(*) from inventory_count_items i where i.count_id = c.id)::int n from inventory_counts c order by started_by")).rows;
    return { ra: ra.status, rb: rb.status, waited, waitedOn, counts };
  }
  const full = { Chemistry: 4, "All lab": 2, Hematology: 1, null: 8 };
  for (const [label, a, b, expB] of [["same department", "Chemistry", "Chemistry", "scope_conflict"], ["Whole lab vs department", null, "Chemistry", "scope_conflict"], ["department vs Whole lab", "Chemistry", null, "scope_conflict"], ["different departments", "Chemistry", "Hematology", "ok"], ["All lab vs Chemistry", "All lab", "Chemistry", "ok"], ["Whole lab vs Whole lab", null, null, "scope_conflict"]]) {
    await reset();
    const r = await race(a, b);
    const exp = [{ department: a, started_by: "DEV-A", n: full[a] }, ...(expB === "ok" ? [{ department: b, started_by: "DEV-B", n: full[b] }] : [])];
    chk(`${label}: B waits (advisory lock), A ok, B ${expB}; only allowed counts exist, each with ALL its lines`, [r.waited, r.waitedOn, r.ra, r.rb, r.counts], [true, "advisory", "ok", expB, exp]);
  }
  await reset();
  {
    const r = await race("Chemistry", "Chemistry", false);
    chk("same department, A rolls back while B waits → B starts (one complete count)", [r.waited, r.rb, r.counts], [true, "ok", [{ department: "Chemistry", started_by: "DEV-B", n: 4 }]]);
  }

  // ── Quantity change racing the start ──
  section = "quantity race";
  {
    const qOf = async (cid) => Number((await admin.query("select expected_quantity from inventory_count_items where reagent_id = $1 and count_id = $2", [U("A"), cid])).rows[0].expected_quantity);
    // R1: a Log use update (10 → … ) is in flight when the start begins
    for (const [label, end, expect] of [["usage update in flight commits", "commit", 7], ["usage update in flight rolls back", "rollback", 8]]) {
      await reset();
      const L = await anon(), S = await anon();
      const sPid = (await S.query("select pg_backend_pid() p")).rows[0].p;
      await L.query("begin"); await L.query("update reagents set current_quantity = 7 where id = $1", [U("A")]);
      const ps = start(S, "Chemistry", "DEV-S"); let waited = false, ev = null;
      for (let i = 0; i < 250 && !waited; i++) { const w = (await admin.query("select wait_event_type t, wait_event e from pg_stat_activity where pid = $1", [sPid])).rows[0]; waited = w?.t === "Lock"; ev = w?.e; if (!waited) await sleep(20); }
      await L.query(end); const r = await ps;
      chk(`R1 ${label}: start waits on the lot's row lock (${ev}); expected_quantity = ${expect} (the committed value)`, [waited, ev, r.status, await qOf(r.count.id)], [true, "transactionid", "ok", expect]);
      await L.end(); await S.end();
    }
    // R2: the start is in flight (lots share-locked) when a Log use update arrives
    await reset();
    const S = await anon(), L = await anon();
    const lPid = (await L.query("select pg_backend_pid() p")).rows[0].p;
    await S.query("begin"); const r = await start(S, "Chemistry", "DEV-S");
    const pl = L.query("update reagents set current_quantity = 7 where id = $1", [U("A")]).then(() => "OK", (e) => e.code); let waited = false, ev = null;
    for (let i = 0; i < 250 && !waited; i++) { const w = (await admin.query("select wait_event_type t, wait_event e from pg_stat_activity where pid = $1", [lPid])).rows[0]; waited = w?.t === "Lock"; ev = w?.e; if (!waited) await sleep(20); }
    await S.query("commit"); const lr = await pl;
    chk("R2 start in flight: the usage update waits for the start to commit (row lock), then applies; snapshot keeps the value at start (8)", [waited, ev, r.status, lr, await qOf(r.count.id), Number((await admin.query("select current_quantity from reagents where id = $1", [U("A")])).rows[0].current_quantity)], [true, "transactionid", "ok", "OK", 8, 7]);
    await S.end(); await L.end();
    // R3: a lot deleted (soft) in flight → start waits, then excludes it
    await reset();
    const D = await anon(), S3 = await anon();
    await D.query("begin"); await D.query("update reagents set deleted = true where id = $1", [U("B")]);
    const p3 = start(S3, "Chemistry"); await sleep(300); await D.query("commit"); const r3 = await p3;
    chk("R3 lot removed in flight: start waits, then leaves it out (it no longer matches)", r3.items.map((i) => name[i.reagent_id]).sort(), ["A", "C", "Cz"]);
    await D.end(); await S3.end();
  }

  // ── Failure injection ──
  section = "failure injection";
  for (const [label, point] of [["before count header insert", "inventory_counts_insert_before_1"], ["after header insert", "inventory_counts_insert_after_1"], ["during line creation (1st line)", "inventory_count_items_insert_before_1"], ["after some line work (3rd line)", "inventory_count_items_insert_before_3"], ["after the last line, before completion", "inventory_count_items_insert_after_4"]]) {
    await reset(); const f0 = await fp();
    await A.query(`set test.fault = '${point}'`); const r = await start(A, "Chemistry"); await A.query("reset test.fault");
    chk(`${label}: call fails; counts, lines, audit, lots all unchanged`, [/injected fault/.test(r.error || ""), await fp()], [true, f0]);
    const r2 = await start(A, "Chemistry");
    chk(`${label}: retry → exactly one complete count (4 lines)`, [r2.status, (await admin.query("select count(*)::int c, (select count(*) from inventory_count_items)::int i from inventory_counts")).rows[0]], ["ok", { c: 1, i: 4 }]);
  }
  chk("no audit step exists in a start (nothing to inject before/after an audit insert)", (await admin.query("select count(*)::int n from audit_log")).rows[0].n, 0);

  // ── Coexistence with the rest of the stack ──
  section = "stack compatibility";
  {
    await reset();
    const r = await start(A, "Chemistry");
    const line = r.items.find((i) => i.reagent_name === "R-A");
    await A.query("update inventory_count_items set counted_quantity = 6, counted_at = now(), counted_by = 'staff-1' where id = $1", [line.id]);
    const res = (await A.query("select stock_count_resolve(p_item_id => $1, p_method => 'usage_exact', p_actor => 'staff-1', p_seen_expected => 8, p_seen_counted => 6, p_date => current_date) r", [line.id])).rows[0].r;
    let refused = "OK"; try { await A.query("update inventory_count_items set counted_quantity = 5 where id = $1", [line.id]); } catch (e) { refused = `${e.message}/${e.detail}`; }
    chk("a started count resolves through stock_count_resolve; B2 guard then freezes its counted quantity", [res.status, refused], ["ok", "evidence_field_protected/counted_quantity"]);
    let upd = "OK"; try { await A.query("update inventory_counts set status = 'completed', completed_at = now() where id = $1", [r.count.id]); } catch (e) { upd = e.message; }
    chk("finish still works; scope trigger untouched", [upd, (await start(A, "Chemistry")).status], ["OK", "ok"]);
  }
  await A.end(); await admin.end();
  } finally { await server.stop(); }
}, { expectedChecks: 50 });
