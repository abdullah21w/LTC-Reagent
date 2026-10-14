// Release control (ADD_RELEASE_CONTROL.sql) on real PostgreSQL, post-Gate-A3 schema +
// Atomic Log Use + Atomic edit/undo, the app's anon role with its x-ltc-build header
// simulated as PostgREST sets it (request.headers): maintenance blocks every app write
// on all 13 tables (0-row statements, TRUNCATE and the database functions too) except
// the audited non-inventory exemptions; one approved build only; old clients without
// a header refused; a clean boundary for in-flight transactions; owner-only control;
// append-only audit trail; no reopening to a build that never reported in.
import { randomUUID, randomBytes } from "node:crypto";
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, applyLogUse, applyLogEdit, applyRelease, waitForLock } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

const TABLES = ["reagents", "consumption_logs", "inventory_counts", "inventory_count_items", "lot_to_lot_pending", "low_stock_snoozes", "reagent_presets", "devices", "staff_accounts", "app_config", "audit_log", "login_snapshots", "public_view_visits"];
const build = () => randomBytes(20).toString("hex");

for (const version of PG_VERSIONS) suite(`Release control: maintenance + forced update (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete, truncate on all tables in schema public to anon");
    await applyLogUse(c); await applyLogEdit(c);
    const ids0 = (await c.query("select array_agg(id) a from reagents")).rows[0].a;
    const hist = async () => JSON.stringify([(await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows, (await c.query("select * from inventory_count_items order by id")).rows, (await c.query("select * from inventory_counts order by id")).rows]);
    const history0 = await hist();
    await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if; end $$;`);
    await c.query("grant usage on schema public to service_role; grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role; alter default privileges in schema public grant all on tables to service_role; alter default privileges in schema public grant all on functions to service_role");
    await applyRelease(c);
    await c.query("grant select, insert, update, delete, truncate on all tables in schema public to anon"); // as Supabase: the app tables stay fully granted
    await c.query("revoke all on app_release, app_release_log, app_release_seen from anon; grant select on app_release to anon"); // …the migration's own grants re-applied after the blanket grant above
    const verify = (await c.query(readRoot("VERIFY_RELEASE_CONTROL.sql"))).rows;
    check("VERIFY_RELEASE_CONTROL.sql: checks 1–12 and OVERALL PASS; state starts with maintenance and enforcement OFF; no unexpected SECURITY DEFINER function", [verify.filter((r) => r.ord <= 99).map((r) => r.result), verify.find((r) => r.ord == 100).result, verify.find((r) => r.ord == 101).result], [Array(13).fill("PASS"), "maintenance=false enforce_build=false approved_build=none", "none"]);
    const definers = (await c.query("select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where p.proname like 'ltc\\_%' or p.proname like 'app\\_release%' order by 1")).rows;
    check("every new function pins search_path (pg_catalog, public, pg_temp — pg_temp last); only ltc_hello is SECURITY DEFINER", [definers.every((d) => d.cfg.includes("search_path=pg_catalog, public, pg_temp")), definers.filter((d) => d.prosecdef).map((d) => d.proname)], [true, ["ltc_hello"]]);
    check("installing it changed no inventory, count or count line", await hist() === history0, true);

    const conn = async (b) => { const k = await server.connect(db); await k.query("set role anon"); if (b !== undefined) await k.query("select set_config('request.headers', $1, false)", [b === null ? "{}" : JSON.stringify({ "x-ltc-build": b, "x-client-info": "supabase-js" })]); return k; };
    const attempt = async (k, sql, params) => { try { await k.query(sql, params); return "ok"; } catch (e) { return e.message; } };
    const lot = async (name, lotNo, qty) => (await c.query("insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, date_added, added_by, low_stock_threshold) values ($1, 'RelLab', 'Reagent', '', $2, 'piece', $3, $3, '2026-10-01', 'tester', 0) returning id", [name, lotNo, qty])).rows[0].id;
    const qty = async (id) => (await c.query("select current_quantity from reagents where id = $1", [id])).rows[0].current_quantity;
    const useCall = (k, lotId, amount = 1) => attempt(k, "select log_use($1, $2, $3, '2026-10-13', 'tester', '', false, true, false, null, 'tester')", [randomUUID(), lotId, amount]);
    const owner = (sql, params) => attempt(c, sql, params);
    const state = async () => (await c.query("select maintenance, enforce_build, approved_build from app_release")).rows[0];
    const logCount = async () => Number((await c.query("select count(*) from app_release_log")).rows[0].count);

    // ── 1. Installed, nothing enabled: no behaviour change ──
    const L = await lot("Gel R", "TR-901", 50);
    const old = await conn(); // an old tab: no x-ltc-build header at all
    check("with nothing enabled, an old client (no header) still writes as before: direct update and log_use", [await attempt(old, "update reagents set low_stock_threshold = 1 where id = $1", [L]), await useCall(old, L), await qty(L)], ["ok", "ok", "49"]);

    // ── 2. Maintenance ON: every app write refused, everywhere ──
    check("ltc_maintenance_on: state + audit entry", [await owner("select ltc_maintenance_on('release 7')"), await state(), (await c.query("select action, reason, db_user from app_release_log order by id desc limit 1")).rows[0]], ["ok", { maintenance: true, enforce_build: false, approved_build: null }, { action: "maintenance_on", reason: "release 7", db_user: "postgres" }]);
    const k1 = await conn(build());
    const matrix = [];
    for (const t of TABLES) {
      for (const [op, sql] of [["INSERT", `insert into ${t} select * from ${t} where false`], ["UPDATE", `update ${t} set id = id where false`], ["DELETE", `delete from ${t} where false`]]) {
        const r = await attempt(k1, sql);
        matrix.push(`${t}:${op}:${r === "ok" ? "ok" : r === "ltc_maintenance" ? "blocked" : r}`);
      }
    }
    const exempt = ["app_config:UPDATE", "audit_log:INSERT", "login_snapshots:INSERT", "public_view_visits:INSERT"];
    check("maintenance: every INSERT / UPDATE / DELETE on all 13 tables is refused — even statements touching no row — except exactly the 4 audited exemptions", [matrix.filter((m) => m.endsWith(":ok")).map((m) => m.replace(/:ok$/, "")), matrix.filter((m) => !m.endsWith(":ok") && !m.endsWith(":blocked"))], [exempt, []]);
    check("maintenance: TRUNCATE by the app's role refused (table intact)", [await attempt(k1, "truncate consumption_logs"), Number((await c.query("select count(*) from consumption_logs")).rows[0].count) > 0], ["ltc_maintenance", true]);
    const before = await hist();
    const lg = (await c.query("select id, amount, date::text from consumption_logs where reagent_id = $1 limit 1", [L])).rows[0];
    const rpcs = [
      await useCall(k1, L),
      await attempt(k1, "select log_edit($1, $2, 1, $3, 'tester', '', false, 2, $3, 'tester', '', false, 'tester')", [randomUUID(), lg.id, lg.date]),
      await attempt(k1, "select log_undo($1, $2, 1, $3, 'tester')", [randomUUID(), lg.id, lg.date]),
      await attempt(k1, "select stock_count_start('RelLab', 'tester')"),
    ];
    check("maintenance: log_use, log_edit, log_undo and stock_count_start all refused; nothing written (stock 49, history identical)", [rpcs, await qty(L), await hist() === before], [["ltc_maintenance", "ltc_maintenance", "ltc_maintenance", "ltc_maintenance"], "49", true]);
    // exemptions, row by row
    const ex = [
      await attempt(k1, "insert into audit_log (action, entity, description, performed_by) values ('login', 'user', 'tester (Staff) signed in', 'tester')"),
      await attempt(k1, "insert into audit_log (action, entity, description, performed_by) values ('edit', 'reagent', 'x', 'tester')"),
      await attempt(k1, "insert into audit_log (action, entity, description, performed_by) values ('login', 'reagent', 'x', 'tester')"),
      await attempt(k1, "update app_config set backup_last_sent = current_date, monthly_report_last_sent = 'x', owner_2fa_code = '123456', owner_2fa_code_expires = now() where id = 1"),
      await attempt(k1, "update app_config set departments = '[]'::jsonb where id = 1"),
      await attempt(k1, "update app_config set owner_password = 'x', backup_last_sent = current_date where id = 1"),
      await attempt(k1, "insert into app_config (id) values (2)"),
      await attempt(k1, "delete from audit_log where true"),
      await attempt(k1, "insert into login_snapshots (username) values ('tester')"),
      await attempt(k1, "update login_snapshots set username = 'x' where true"),
      await attempt(k1, "insert into public_view_visits default values"),
    ];
    check("exemptions are exactly as narrow as audited: only sign-in activity, only the 4 app_config bookkeeping columns, only sign-in / visit inserts; everything else refused", ex, ["ok", "ltc_maintenance", "ltc_maintenance", "ok", "ltc_maintenance", "ltc_maintenance", "ltc_maintenance", "ltc_maintenance", "ok", "ltc_maintenance", "ok"]);
    check("the owner (SQL Editor) can still repair data during maintenance", [await owner("update reagents set low_stock_threshold = 2 where id = $1", [L]), await owner("select ltc_release_state()")], ["ok", "ok"]);
    const hello = (await k1.query("select ltc_hello() r")).rows[0].r;
    check("ltc_hello still works during maintenance (reports the build, returns the state)", [hello.maintenance, hello.enforce_build, hello.your_build.length], [true, false, 40]);

    // ── 3. Owner-only control; append-only audit trail ──
    const own = [
      await attempt(k1, "update app_release set maintenance = false"), await attempt(k1, "delete from app_release"), await attempt(k1, "insert into app_release_log (action, maintenance, enforce_build, reason) values ('x', false, false, 'x')"),
      await attempt(k1, "select * from app_release_log"), await attempt(k1, "select * from app_release_seen"), await attempt(k1, "select ltc_maintenance_off('staff')"),
      await attempt(k1, "select ltc_release_open($1, 'staff', true)", [build()]), await attempt(k1, "select ltc_enforcement_set(false, 'staff')"), await attempt(k1, "truncate app_release"),
    ];
    check("staff / old tabs / anyone with the public key cannot change the state, read or write the audit trail, or run any owner function", own.map((m) => /permission denied/.test(m) ? "denied" : m), Array(9).fill("denied"));
    check("…and the state is unchanged (still maintenance)", (await state()).maintenance, true);
    check("the audit trail is append-only even for the owner (update / delete / truncate refused)", [await owner("update app_release_log set reason = 'x'"), await owner("delete from app_release_log"), await owner("truncate app_release_log")].map((m) => /append-only/.test(m)), [true, true, true]);

    // ── 4. Approving exactly one build; never one that didn't report in ──
    const B = build(), D = build();
    check("open refuses a malformed build, a build never reported by a running app (typo / failed deployment), and anything without the owner's explicit deployment confirmation", [/40-character/.test(await owner("select ltc_release_open('abc123', 'release 7')")), /has not been reported/.test(await owner("select ltc_release_open($1, 'release 7', p_deployment_verified => true)", [B])), /confirm the deployment first/.test(await owner("select ltc_release_open($1, 'release 7')", [B])), (await state()).maintenance], [true, true, true, true]);
    const kB = await conn(B);
    await kB.query("select ltc_hello()");
    check("after the new build reports in (ltc_hello), open approves exactly it, turns enforcement on and maintenance off", [await owner("select ltc_release_open($1, 'release 7 verified', p_deployment_verified => true)", [B]), await state()], ["ok", { maintenance: false, enforce_build: true, approved_build: B }]);
    check("approved build: direct writes and log_use work", [await attempt(kB, "update reagents set low_stock_threshold = 3 where id = $1", [L]), await useCall(kB, L), await qty(L)], ["ok", "ok", "48"]);
    const kOld = await conn(), kOther = await conn(build()), kBad = await server.connect(db);
    await kBad.query("set role anon"); await kBad.query("select set_config('request.headers', 'not json', false)");
    const refusedOld = [
      await attempt(kOld, "update reagents set low_stock_threshold = 4 where id = $1", [L]), await attempt(kOld, "insert into consumption_logs (reagent_id, amount, date, used_by) values ($1, 1, current_date, 'tester')", [L]),
      await attempt(kOld, "delete from low_stock_snoozes where false"), await useCall(kOld, L),
      await attempt(kOld, "select log_undo($1, $2, 1, $3, 'tester')", [randomUUID(), lg.id, lg.date]), await attempt(kOld, "select stock_count_start('RelLab', 'tester')"),
      await attempt(kOld, "insert into audit_log (action, entity, description, performed_by) values ('login', 'user', 'x', 'x')"),
      await attempt(kOther, "update reagents set low_stock_threshold = 4 where id = $1", [L]), await useCall(kOther, L), await attempt(kBad, "update reagents set low_stock_threshold = 4 where id = $1", [L]),
    ];
    check("old clients WITHOUT a header — direct table writes and RPCs — and any other build, or a malformed header, are refused (exactly one approved build, no grace)", refusedOld, Array(10).fill("ltc_outdated_client"));
    check("…nothing they tried was written (stock 48, threshold 3)", [await qty(L), (await c.query("select low_stock_threshold from reagents where id = $1", [L])).rows[0].low_stock_threshold], ["48", "3"]);
    const oldHello = (await kOld.query("select ltc_hello() r")).rows[0].r;
    check("an old or outdated client can still read the state (so a new-version client knows to reload); nothing recorded for it", [oldHello.your_build, oldHello.approved_build === B, Number((await c.query("select count(*) from app_release_seen where build <> $1 and build <> $2", [B, hello.your_build])).rows[0].count)], [null, true, 0]);

    // ── 5. A failed deployment can't reopen anything ──
    await owner("select ltc_maintenance_on('release 8')");
    check("release 8 fails to deploy (its build D never reports): opening D is refused, the system stays in maintenance, and the previous build B can't write either", [/has not been reported/.test(await owner("select ltc_release_open($1, 'release 8', p_deployment_verified => true)", [D])), await state(), await attempt(kB, "update reagents set low_stock_threshold = 5 where id = $1", [L])], [true, { maintenance: true, enforce_build: true, approved_build: B }, "ltc_maintenance"]);
    check("recovery: roll back to B (it reported in) → B writes again, recorded as a rollback", [await owner("select ltc_release_rollback($1, 'release 8 failed', p_deployment_verified => true)", [B]), await attempt(kB, "update reagents set low_stock_threshold = 5 where id = $1", [L]), (await c.query("select action, approved_build = $1 as b from app_release_log order by id desc limit 1", [B])).rows[0]], ["ok", "ok", { action: "rollback", b: true }]);
    check("p_force exists for the owner only (e.g. the deployed app can't be opened): approves an unreported build", [await owner("select ltc_release_open($1, 'forced', p_deployment_verified => true, p_force => true)", [D]), (await state()).approved_build === D, await attempt(kB, "update reagents set low_stock_threshold = 6 where id = $1", [L])], ["ok", true, "ltc_outdated_client"]);
    await owner("select ltc_release_rollback($1, 'back to B', p_deployment_verified => true)", [B]);
    check("emergency switch: enforcement off lets old clients write again (maintenance still enforceable); back on restores the check", [await owner("select ltc_enforcement_set(false, 'emergency')"), await attempt(kOld, "update reagents set low_stock_threshold = 7 where id = $1", [L]), await owner("select ltc_enforcement_set(true, 'fixed')"), await attempt(kOld, "update reagents set low_stock_threshold = 8 where id = $1", [L])], ["ok", "ok", "ok", "ltc_outdated_client"]);

    // ── 6. Concurrency boundary: in-flight transactions complete whole or roll back whole ──
    const L2 = await lot("Gel S", "TR-902", 20);
    const w1 = await conn(B), ownerConn = await server.connect(db);
    const pidOwner = (await ownerConn.query("select pg_backend_pid() p")).rows[0].p;
    await w1.query("begin");
    await w1.query("select log_use($1, $2, 2, '2026-10-13', 'tester', '', false, true, false, null, 'tester')", [randomUUID(), L2]); // first write of the transaction
    const switching = ownerConn.query("select ltc_maintenance_on('release 9')").then(() => "done", (e) => e.message);
    const waited = await waitForLock(c, pidOwner);
    const wNew = await conn(B);
    const t0 = Date.now();
    const newcomer = await useCall(wNew, L);
    const newcomerMs = Date.now() - t0;
    check("while the switch waits, a NEW app transaction (Log Use, already holding its Lot's row locks) is refused AT ONCE — it never waits, so it can't deadlock", [newcomer, newcomerMs < 2000, (await state()).maintenance], ["ltc_maintenance", true, false]);
    await wNew.end();
    const second = await attempt(w1, "select log_use($1, $2, 3, '2026-10-13', 'tester', '', false, true, false, null, 'tester')", [randomUUID(), L2]);
    check("maintenance switch WAITS while an app transaction is in flight; that transaction keeps writing (its 2nd write passes)", [waited.waited, second, (await state()).maintenance], [true, "ok", false]);
    await w1.query("commit");
    check("…the transaction commits whole (20 − 2 − 3 = 15), then maintenance switches on", [await switching, await qty(L2), (await state()).maintenance], ["done", "15", true]);
    check("…and every write after the switch is refused", await useCall(w1, L2), "ltc_maintenance");
    await owner("select ltc_maintenance_off('test')");
    const w2 = await conn(B);
    await w2.query("begin");
    await w2.query("select log_use($1, $2, 4, '2026-10-13', 'tester', '', false, true, false, null, 'tester')", [randomUUID(), L2]);
    const switching2 = ownerConn.query("select ltc_maintenance_on('release 10')").then(() => "done", (e) => e.message);
    await waitForLock(c, pidOwner);
    await w2.query("rollback");
    check("an in-flight transaction that rolls back leaves nothing (15), then maintenance switches on", [await switching2, await qty(L2), (await state()).maintenance], ["done", "15", true]);
    await owner("select ltc_maintenance_off('test')");
    const w3 = await conn(B);
    await w3.query("begin");
    await w3.query("select log_use($1, $2, 1, '2026-10-13', 'tester', '', false, true, false, null, 'tester')", [randomUUID(), L2]);
    const n0 = await logCount();
    const timedOut = await owner("select ltc_maintenance_on('release 11', null, interval '300 milliseconds')");
    check("a stuck transaction: the switch gives up after its wait limit with a lock-timeout error; state and audit trail unchanged", [/lock timeout/.test(timedOut), (await state()).maintenance, await logCount() - n0], [true, false, 0]);
    await w3.query("commit");
    check("…the stuck transaction still completes normally (14), and the switch can be retried", [await qty(L2), await owner("select ltc_maintenance_on('release 11 retry')"), (await state()).maintenance], ["14", "ok", true]);

    // ── 6b. Stock Count in flight across the boundary ──
    await owner("select ltc_maintenance_off('stock count test')");
    const sc = await conn(B), scOther = await conn(B);
    await sc.query("begin");
    const started = (await sc.query("select stock_count_start('RelLab', 'tester') r")).rows[0].r;
    const scLine = started.items.find((i) => i.lot_number === "TR-902");
    const switching3 = ownerConn.query("select ltc_maintenance_on('release 12')").then(() => "done", (e) => e.message);
    await waitForLock(c, pidOwner);
    const otherWrite = await attempt(scOther, "update inventory_count_items set counted_quantity = 1 where id = $1", [started.items.find((i) => i.lot_number === "TR-901").id]);
    const counted = await attempt(sc, "update inventory_count_items set counted_quantity = 10, counted_at = now(), counted_by = 'tester' where id = $1", [scLine.id]);
    const resolved = (await sc.query("select stock_count_resolve($1, 'corrected', 'tester', $2, 10) r", [scLine.id, scLine.expected_quantity])).rows[0].r;
    check("Stock Count in flight while maintenance is being switched on: its start, count entry and reconciliation continue; another device's count entry is refused at once", [started.status, counted, resolved.status, otherWrite, (await state()).maintenance], ["ok", "ok", "ok", "ltc_maintenance", false]);
    await sc.query("commit");
    check("…it commits whole (Lot corrected to the counted 10, line resolved), then maintenance is on and further Stock Count writes are refused", [await switching3, await qty(L2), (await c.query("select resolved from inventory_count_items where id = $1", [scLine.id])).rows[0].resolved, await attempt(scOther, "select stock_count_start('Chemistry', 'tester')")], ["done", "10", true, "ltc_maintenance"]);

    // ── 6c. No way around the guard ──
    const kZ = await conn(build());
    await kZ.query("select ltc_hello()");
    const Z = (await c.query("select build from app_release_seen order by last_seen desc limit 1")).rows[0].build;
    check("anyone with the public key can make a build 'reported' — so that alone never approves it: without the owner's deployment confirmation, open is refused", [/confirm the deployment first/.test(await owner("select ltc_release_open($1, 'spoofed')", [Z])), (await state()).approved_build === B], [true, true]);
    await c.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'ltc_extra_role') then create role ltc_extra_role nologin; end if; end $$; grant all on reagents to ltc_extra_role");
    const kx = await server.connect(db); await kx.query("set role ltc_extra_role");
    const ks = await server.connect(db); await ks.query("set role service_role");
    const extra = await attempt(kx, "update reagents set low_stock_threshold = 9 where id = $1", [L]);
    check("allowlist: any other database role is checked like the app and refused (fail-closed: here it may not even read the state); only owner / supabase_admin / service_role pass", [extra !== "ok" && /ltc_maintenance|permission denied for table app_release/.test(extra), await attempt(ks, "update reagents set low_stock_threshold = 9 where id = $1", [L])], [true, "ok"]);
    check("the server key cannot change the release state or run any owner function", [await attempt(ks, "update app_release set maintenance = false"), await attempt(ks, "select ltc_maintenance_off('server')"), await attempt(ks, "select ltc_release_open($1, 'server', true, true)", [B]), await attempt(ks, "select ltc_hello()")].map((m) => /permission denied/.test(m) ? "denied" : m), ["denied", "denied", "denied", "denied"]);
    const kh = await conn(build());
    await kh.query("create temp table app_release (id smallint, maintenance boolean, maintenance_message text, enforce_build boolean, approved_build text); insert into app_release values (1, false, '', false, null); create temp table app_release_seen (build text primary key, first_seen timestamptz, last_seen timestamptz, hits bigint)");
    const hijackWrite = await attempt(kh, "update reagents set low_stock_threshold = 9 where id = $1", [L]);
    const hijackHello = (await kh.query("select ltc_hello() r")).rows[0].r;
    check("search_path hijack: temporary tables named app_release / app_release_seen change nothing — the guard still sees maintenance, and ltc_hello reads and records in the real tables", [hijackWrite, hijackHello.maintenance, Number((await c.query("select count(*) from app_release_seen where build = $1", [hijackHello.your_build])).rows[0].count), Number((await kh.query("select count(*) from pg_temp.app_release_seen")).rows[0].count)], ["ltc_maintenance", true, 1, 0]);
    check("anon is not a member of any privileged role (it can't switch to one)", (await c.query("select pg_has_role('anon', 'postgres', 'member') a, pg_has_role('anon', 'service_role', 'member') b")).rows[0], { a: false, b: false });
    for (const k of [kZ, kx, ks, kh, sc, scOther]) await k.end();

    // ── 7. Audit trail and history ──
    const actions = (await c.query("select action from app_release_log order by id")).rows.map((r) => r.action);
    check("every change is in the audit trail, in order (installed, maintenance, open, rollback, enforcement…)", [actions[0], actions.includes("maintenance_on"), actions.includes("release_open"), actions.includes("rollback"), actions.includes("enforcement_off"), actions.includes("enforcement_on"), actions.at(-1)], ["installed", true, true, true, true, true, "maintenance_on"]);
    const reagentsNow = JSON.stringify((await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows);
    check("no pre-existing Lot was changed by any of this (the test's own Stock Count only touched its own Lots)", reagentsNow === JSON.parse(history0)[0] ? true : JSON.stringify(JSON.parse(history0)[0]) === reagentsNow, true);
    for (const k of [old, k1, kB, kOld, kOther, kBad, w1, w2, w3, ownerConn]) await k.end();
    await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 40 });
