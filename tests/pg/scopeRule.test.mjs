// One open Stock Count per scope (ADD_ONE_OPEN_COUNT_PER_SCOPE.sql): department vs
// "Whole lab" rules, sequential and truly concurrent (two connections, READ
// COMMITTED), rollback while waiting, the index backstop, and the app's error
// recogniser (countScope.js isScopeConflict). Ported from the review suites
// run.mjs (scope rule alone), runAS.mjs (+ Evidence Foundation + Guard) and
// runAS2.mjs (+ Foundation + Functions + Guard) — all three variants run here.
import { suite, check, load, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";

const { isScopeConflict } = await load("countScope.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What supabase-js hands the app: PostgREST maps sqlstate→code, message, detail→details, hint.
const asSupabaseError = (e) => (e ? { code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null } : null);
const errFields = (e) => (e ? { code: e.code, message: e.message, detail: e.detail ?? null, hint: e.hint ?? null, constraint: e.constraint ?? null, table: e.table ?? null } : null);
const VARIANTS = [
  ["scope rule only", []],
  ["+ Evidence Foundation + Guard", ["ADD_EVIDENCE_FOUNDATION.sql", "ADD_EVIDENCE_GUARD.sql"]],
  ["+ Foundation + Functions + Guard", ["ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_EVIDENCE_GUARD.sql"]],
];

for (const version of PG_VERSIONS) suite(`Scope rule · one open Stock Count per department / Whole lab (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    for (const [variant, extra] of VARIANTS) {
      const V = (n) => `[${variant}] ${n}`;
      const db = await server.createDatabase();
      const connect = () => server.connect(db);
      const admin = await connect();
      await ensureRoles(admin);
      await admin.query(`
        grant usage on schema public to anon, authenticated;
        alter default privileges in schema public grant all on tables to anon, authenticated;
        create table reagents (id uuid primary key default gen_random_uuid(), name text);
        create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
        create table consumption_logs (id uuid primary key default gen_random_uuid());
        grant all on reagents, staff_accounts, consumption_logs to anon, authenticated;`);
      await admin.query(readRoot("ADD_INVENTORY_COUNTS.sql"));
      await admin.query(readRoot("ADD_COUNT_LOG_LINKS.sql"));
      await admin.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
      const migration = readRoot("ADD_ONE_OPEN_COUNT_PER_SCOPE.sql");
      let migErr = null; try { await admin.query(migration); } catch (e) { migErr = e; }
      check(V("1. migration runs unchanged without errors"), errFields(migErr), null);
      let migErr2 = null; try { await admin.query(migration); } catch (e) { migErr2 = e; }
      check(V("1. migration re-run (idempotent) without errors"), errFields(migErr2), null);
      if (extra.length) {
        for (const f of extra) await admin.query(readRoot(f));
        check(V("0. Evidence Guard triggers present alongside the scope trigger"), (await admin.query("select count(*)::int n from pg_trigger where tgname in ('consumption_logs_evidence_guard','inventory_count_items_evidence_guard','inventory_counts_open_scope') and not tgisinternal")).rows[0].n, 3);
      }
      const objs = await admin.query(`
        select (select count(*) from pg_indexes where tablename = 'inventory_counts' and indexname in ('inventory_counts_one_open_per_department','inventory_counts_one_open_whole_lab'))::int as idx,
               (select count(*) from pg_trigger where tgname = 'inventory_counts_open_scope' and not tgisinternal)::int as trg,
               (select count(*) from pg_proc where proname = 'inventory_counts_check_open_scope')::int as fn,
               (select prosecdef from pg_proc where proname = 'inventory_counts_check_open_scope') as secdef`);
      check(V("1. both partial unique indexes, the trigger and the function exist (security definer)"), [objs.rows[0].idx, objs.rows[0].trg, objs.rows[0].fn, objs.rows[0].secdef], [2, 1, 1, true]);

      const anonClient = async () => { const c = await connect(); await c.query("set role anon"); return c; };
      const reset = async () => admin.query("delete from inventory_counts");
      const ins = async (c, dept, status = "in_progress", id = null) => {
        try { const r = await c.query(`insert into inventory_counts (${id ? "id, " : ""}department, status, started_by) values (${id ? "$3, " : ""}$1, $2, 'TEST') returning id`, id ? [dept, status, id] : [dept, status]); return { ok: true, id: r.rows[0].id }; }
        catch (e) { return { ok: false, err: e }; }
      };
      const outcome = (r) => (r.ok ? "OK" : `${r.err.code}${r.err.constraint ? ":" + r.err.constraint : ""}${r.err.code === "P0001" ? ":" + r.err.message + "/" + r.err.detail : ""}`);

      // ── 2. Sequential ──
      const A = await anonClient();
      const seq = async (name, setup, attempt, expected) => { await reset(); for (const [d, s] of setup) { const r = await ins(A, d, s); if (!r.ok) throw new Error(`setup failed for ${name}: ${r.err.message}`); } const r = await ins(A, attempt[0], attempt[1] || "in_progress"); check(V(`2. ${name}`), outcome(r), expected); return r; };
      const W = null;
      await seq("no open → Chemistry", [], ["Chemistry"], "OK");
      const r2 = await seq("Chemistry open → second Chemistry rejected", [["Chemistry", "in_progress"]], ["Chemistry"], "P0001:stock_count_scope_conflict/same_department_open");
      await seq("Chemistry open → Hematology allowed", [["Chemistry", "in_progress"]], ["Hematology"], "OK");
      await seq("Chemistry open → All lab allowed", [["Chemistry", "in_progress"]], ["All lab"], "OK");
      await seq("All lab open → second All lab rejected", [["All lab", "in_progress"]], ["All lab"], "P0001:stock_count_scope_conflict/same_department_open");
      await seq("no open → Whole lab", [], [W], "OK");
      const r6 = await seq("Whole lab open → second Whole lab rejected", [[W, "in_progress"]], [W], "P0001:stock_count_scope_conflict/whole_lab_open");
      const r7 = await seq("Whole lab open → Chemistry rejected", [[W, "in_progress"]], ["Chemistry"], "P0001:stock_count_scope_conflict/whole_lab_open");
      await seq("Whole lab open → All lab rejected", [[W, "in_progress"]], ["All lab"], "P0001:stock_count_scope_conflict/whole_lab_open");
      const r9 = await seq("Chemistry open → Whole lab rejected", [["Chemistry", "in_progress"]], [W], "P0001:stock_count_scope_conflict/department_open");
      await seq("All lab open → Whole lab rejected", [["All lab", "in_progress"]], [W], "P0001:stock_count_scope_conflict/department_open");
      await seq("Chemistry + Hematology open → Whole lab rejected", [["Chemistry", "in_progress"], ["Hematology", "in_progress"]], [W], "P0001:stock_count_scope_conflict/department_open");
      await seq("completed Chemistry → new Chemistry allowed", [["Chemistry", "completed"]], ["Chemistry"], "OK");
      await seq("completed Whole lab → new Whole lab allowed", [[W, "completed"]], [W], "OK");
      await seq("completed Chemistry/Hematology → Whole lab allowed", [["Chemistry", "completed"], ["Hematology", "completed"]], [W], "OK");
      await reset(); const open1 = await ins(A, "Chemistry");
      await A.query("update inventory_counts set status = 'completed', completed_at = now() where id = $1", [open1.id]);
      check(V("2. complete open Chemistry (UPDATE through the trigger) → new Chemistry allowed"), outcome(await ins(A, "Chemistry")), "OK");
      await reset(); const open2 = await ins(A, W);
      await A.query("delete from inventory_counts where id = $1", [open2.id]);
      check(V("2. delete open Whole lab → Chemistry allowed"), outcome(await ins(A, "Chemistry")), "OK");
      await reset(); await ins(A, "Chemistry"); const done = await ins(A, "Chemistry", "completed");
      let reopen = null; try { await A.query("update inventory_counts set status = 'in_progress' where id = $1", [done.id]); } catch (e) { reopen = e; }
      check(V("2. re-opening a completed Chemistry while another is open (UPDATE) → rejected"), reopen ? `${reopen.code}:${reopen.message}` : "OK", "P0001:stock_count_scope_conflict");

      // ── 5. Real error fields → the app's recogniser ──
      check(V("5. recogniser: trigger refusals (all 3 detail kinds) → ours"), [r2, r6, r7, r9].map((r) => isScopeConflict(asSupabaseError(r.err))), [true, true, true, true]);
      await admin.query("alter table inventory_counts disable trigger inventory_counts_open_scope");
      await reset(); await ins(A, "Chemistry"); const i1 = await ins(A, "Chemistry");
      await reset(); await ins(A, W); const i2 = await ins(A, W);
      await reset(); await ins(A, "Chemistry"); const crossWithoutTrigger = await ins(A, W);
      await admin.query("alter table inventory_counts enable trigger inventory_counts_open_scope");
      check(V("5. index backstop (trigger disabled): same department → 23505 on inventory_counts_one_open_per_department"), [i1.err?.code, i1.err?.constraint], ["23505", "inventory_counts_one_open_per_department"]);
      check(V("5. index backstop (trigger disabled): second Whole lab → 23505 on inventory_counts_one_open_whole_lab"), [i2.err?.code, i2.err?.constraint], ["23505", "inventory_counts_one_open_whole_lab"]);
      check(V("5. (documented) without the trigger, Whole lab + Chemistry is NOT blocked by indexes alone"), crossWithoutTrigger.ok, true);
      check(V("5. recogniser: real index 23505s → ours"), [isScopeConflict(asSupabaseError(i1.err)), isScopeConflict(asSupabaseError(i2.err))], [true, true]);
      await reset(); await ins(A, "Chemistry", "completed", "11111111-1111-1111-1111-111111111111"); const pkDup = await ins(A, "Hematology", "completed", "11111111-1111-1111-1111-111111111111");
      let otherP0001 = null; try { await A.query("do $$ begin raise exception 'something else went wrong'; end $$"); } catch (e) { otherP0001 = e; }
      await admin.query("create table unrelated_things (code text unique); grant all on unrelated_things to anon");
      let otherUnique = null; try { await A.query("insert into unrelated_things values ('x'), ('x')"); } catch (e) { otherUnique = e; }
      let fkErr = null; try { await A.query("insert into inventory_count_items (count_id, reagent_name, lot_number, department, unit, expected_quantity) values (gen_random_uuid(), 'x', 'x', 'x', 'x', 1)"); } catch (e) { fkErr = e; }
      check(V("5. recogniser: primary-key 23505 / other P0001 / other unique index / FK error → NOT ours"), [isScopeConflict(asSupabaseError(pkDup.err)), isScopeConflict(asSupabaseError(otherP0001)), isScopeConflict(asSupabaseError(otherUnique)), isScopeConflict(asSupabaseError(fkErr))], [false, false, false, false]);

      // ── 3. True concurrency: two independent connections ──
      const T1 = await anonClient(), T2 = await anonClient();
      const p2 = (await T2.query("select pg_backend_pid() as p")).rows[0].p;
      const waitInfo = async (pid) => (await admin.query("select state, wait_event_type, wait_event from pg_stat_activity where pid = $1", [pid])).rows[0];
      async function race(name, aDept, bDept, { aEnd = "commit", expectB }) {
        await reset();
        await T1.query("begin"); await T2.query("begin");
        const iso = (await T2.query("show transaction_isolation")).rows[0].transaction_isolation;
        const a = await ins(T1, aDept);
        let bDone = false; const bP = ins(T2, bDept).then((r) => { bDone = true; return r; });
        await sleep(700);
        const w = await waitInfo(p2);
        const bWaited = !bDone && w.wait_event_type === "Lock" && w.wait_event === "advisory";
        await T1.query(aEnd);
        const b = await bP;
        await T2.query(b.ok ? "commit" : "rollback");
        check(V(`3. ${name}: A ok, B waited on the advisory lock, B after A ${aEnd} → ${expectB}, READ COMMITTED`), [a.ok, bWaited, outcome(b), iso], [true, true, expectB, "read committed"]);
      }
      await race("A Chemistry vs B Chemistry", "Chemistry", "Chemistry", { expectB: "P0001:stock_count_scope_conflict/same_department_open" });
      await race("B Whole lab vs A Whole lab", W, W, { expectB: "P0001:stock_count_scope_conflict/whole_lab_open" });
      await race("C A Chemistry first, B Whole lab", "Chemistry", W, { expectB: "P0001:stock_count_scope_conflict/department_open" });
      await race("D A Whole lab first, B Chemistry", W, "Chemistry", { expectB: "P0001:stock_count_scope_conflict/whole_lab_open" });
      await race("E Chemistry vs Hematology (both allowed; B briefly waits, then succeeds)", "Chemistry", "Hematology", { expectB: "OK" });
      await race("F Chemistry vs All lab (both allowed; B briefly waits, then succeeds)", "Chemistry", "All lab", { expectB: "OK" });
      await race("G All lab vs All lab", "All lab", "All lab", { expectB: "P0001:stock_count_scope_conflict/same_department_open" });
      await race("R1 A Chemistry ROLLBACK, waiting B Chemistry", "Chemistry", "Chemistry", { aEnd: "rollback", expectB: "OK" });
      await race("R2 A Whole lab ROLLBACK, waiting B Chemistry", W, "Chemistry", { aEnd: "rollback", expectB: "OK" });
      await race("R3 A Chemistry ROLLBACK, waiting B Whole lab", "Chemistry", W, { aEnd: "rollback", expectB: "OK" });
      await reset(); await ins(A, "Chemistry");
      await T1.query("begin"); await T2.query("begin");
      const aH = await ins(T1, "Hematology");
      let bD = false; const bWhole = ins(T2, W).then((r) => { bD = true; return r; });
      await sleep(700); const ww = await waitInfo(p2);
      const bWaitedR4 = !bD && ww.wait_event_type === "Lock" && ww.wait_event === "advisory";
      await T1.query("rollback"); const bw = await bWhole; await T2.query(bw.ok ? "commit" : "rollback");
      check(V("3. R4 committed Chemistry exists; A Hematology rolls back; waiting B Whole lab → still rejected (sees the committed Chemistry)"), [aH.ok, bWaitedR4, outcome(bw)], [true, true, "P0001:stock_count_scope_conflict/department_open"]);
      await reset();
      await T1.query("begin"); await T2.query("begin");
      const c1 = await ins(T1, "Chemistry"); const c2P = ins(T2, "Hematology");
      await sleep(300); await T1.query("commit"); const c2 = await c2P; await T2.query("commit");
      check(V("3. concurrent Chemistry + Hematology both committed; then Whole lab rejected"), [c1.ok, c2.ok, outcome(await ins(A, W))], [true, true, "P0001:stock_count_scope_conflict/department_open"]);
      for (const c of [A, T1, T2, admin]) await c.end();
    }
  } finally { await server.stop(); }
}, { expectedChecks: 119 });
