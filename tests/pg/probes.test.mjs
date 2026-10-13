// Runbook probes are write-free: each Stock Count function called inside a READ ONLY
// transaction (as PostgREST runs GET) returns invalid_input / a window and writes
// nothing. Ported from the Probe review suite (already synthetic).
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";

for (const version of PG_VERSIONS) suite(`Probes · read-only GET probes write nothing (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const c = await server.connect(await server.createDatabase());
    await ensureRoles(c);
    await c.query("grant usage on schema public to anon;");
    await c.query(readRoot("supabase_schema.sql"));
    for (const f of ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql", "ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_STOCK_COUNT_START.sql", "ADD_EVIDENCE_GUARD.sql"]) await c.query(readRoot(f));
    await c.query("grant select, insert, update, delete on all tables in schema public to anon;");
    await c.query("insert into reagents (name, department, lot_number, unit, quantity_received, current_quantity, added_by) values ('X', 'probe', 'L', 'box', 1, 1, 'T')"); // a 'probe' department lot: a real start would create a count
    const ro = async (sql) => { await c.query("begin transaction read only; set local role anon;"); try { return (await c.query(sql)).rows[0].r; } catch (e) { return `ERR ${e.code} ${e.message}`; } finally { await c.query("rollback"); } };
    const Z = "00000000-0000-0000-0000-000000000000";
    check("window probe (stable) → a result in a read-only transaction", (await ro(`select stock_count_window('${Z}', '${Z}') r`)).reason, "no_lot");
    check("resolve probe → invalid_input (refused before any table access)", (await ro(`select stock_count_resolve(p_item_id => '${Z}', p_method => 'probe', p_actor => 'probe', p_seen_expected => 0, p_seen_counted => 0) r`)).status, "invalid_input");
    check("redate probe → invalid_input", (await ro(`select stock_count_redate(p_item_id => '${Z}', p_actor => 'probe', p_current_log_ids => '{}', p_mode => 'probe') r`)).status, "invalid_input");
    check("start probe (blank actor) → invalid_input even though department 'probe' has a lot", (await ro(`select stock_count_start(p_department => 'probe', p_actor => '') r`)).status, "invalid_input");
    check("nothing was written", (await c.query("select (select count(*) from inventory_counts)::int c, (select count(*) from inventory_count_items)::int i")).rows[0], { c: 0, i: 0 });
    await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 5 });
