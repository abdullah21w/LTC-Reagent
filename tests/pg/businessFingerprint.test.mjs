// Schema-stable BUSINESS fingerprint: generated from every business column that exists before
// the evidence rollout (evidence columns excluded by design), then shown to be identical through
// every rollout stage (Foundation, Functions, Start, D, Guard), independent of the session time
// zone, blind to evidence columns, and sensitive to a deliberate change of any protected value.
// Ported from runFP.mjs (which generated the column list from the Production snapshot); runs on
// the synthetic history (tests/fixtures/backfillHistory.mjs).
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres } from "../helpers/pg.mjs";
import { historyDb } from "../helpers/historyDb.mjs";
import { buildBackfillHistory } from "../fixtures/backfillHistory.mjs";

const { tables, expected: X } = buildBackfillHistory();
const TABLES = ["reagents", "consumption_logs", "inventory_counts", "inventory_count_items", "audit_log"];
// Evidence columns added during the rollout (never part of the business fingerprint).
const EVIDENCE = ["date_provenance", "source_count_item_id", "counted_at", "counted_by", "resolved_at", "resolved_by", "resolution_details"];
const CHAIN = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"];
const STAGES = [["Foundation", "ADD_EVIDENCE_FOUNDATION.sql"], ["Functions", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql"], ["Start", "ADD_STOCK_COUNT_START.sql"], ["D", "ADD_HISTORICAL_EVIDENCE_BACKFILL.sql"], ["Guard", "ADD_EVIDENCE_GUARD.sql"]];

for (const version of PG_VERSIONS) suite(`Business fingerprint · stable through the rollout, detects every mutation (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const c = await historyDb(server, tables, { before: CHAIN, after: [] });
    // ── Generate the fingerprint from the pre-rollout business columns and their types ──
    const parts = [];
    for (const t of TABLES) {
      const info = (await c.query("select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name", [t])).rows;
      const types = Object.fromEntries(info.map((r) => [r.column_name, r.data_type]));
      const cols = info.map((r) => r.column_name).filter((k) => !EVIDENCE.includes(k));
      const expr = cols.map((k) => types[k] === "numeric" ? `trim_scale(${k})` : types[k] === "timestamp with time zone" ? `(${k} at time zone 'UTC')` : k);
      parts.push(`select '${t}' as tbl, count(*) as rows, md5(string_agg(row(${expr.join(", ")})::text, '|' order by id)) as business_fp from ${t}`);
    }
    const FP = parts.join("\nunion all\n") + "\norder by 1;\n";
    const fp = async (tz = "UTC") => { await c.query(`set timezone = '${tz}'`); return Object.fromEntries((await c.query(FP)).rows.map((r) => [r.tbl, `${r.business_fp} (${r.rows})`])); };

    const base = await fp();
    check("time-zone independent (UTC = Asia/Riyadh = America/New_York session)", [await fp("Asia/Riyadh"), await fp("America/New_York")], [base, base]);
    for (const [name, f] of STAGES) {
      await c.query(readRoot(f));
      check(`after ${name}: business fingerprint identical to before the rollout`, await fp(), base);
    }
    check("the stages really changed the schema and metadata (so the test is meaningful)", (await c.query("select (select count(*) from consumption_logs where date_provenance is not null)::int p, (select count(*) from consumption_logs where source_count_item_id is not null)::int l, (select count(*) from pg_trigger where tgname like '%evidence_guard%')::int g")).rows[0], { p: X.rows.consumption_logs, l: X.links, g: 2 });
    check("evidence columns are NOT in the fingerprint: changing them leaves it identical", await (async () => {
      await c.query("begin; set local session_replication_role = replica;");
      await c.query("update inventory_count_items set counted_at = now(), counted_by = 'X', resolved_at = now(), resolved_by = 'X', resolution_details = '{}'");
      await c.query("update consumption_logs set date_provenance = null, source_count_item_id = null");
      const r = await fp(); await c.query("rollback"); return r;
    })(), base);
    const mutations = [
      ["reagents.current_quantity", "update reagents set current_quantity = current_quantity + 1 where id = (select min(id::text)::uuid from reagents)"],
      ["reagents.deleted", "update reagents set deleted = not deleted where id = (select min(id::text)::uuid from reagents)"],
      ["consumption_logs.amount", "update consumption_logs set amount = amount + 1 where id = (select min(id::text)::uuid from consumption_logs)"],
      ["consumption_logs.date", "update consumption_logs set date = date - 1 where id = (select min(id::text)::uuid from consumption_logs)"],
      ["consumption_logs.used_by", "update consumption_logs set used_by = used_by || 'x' where id = (select min(id::text)::uuid from consumption_logs)"],
      ["consumption_logs.note", "update consumption_logs set note = coalesce(note, '') || 'x' where id = (select min(id::text)::uuid from consumption_logs)"],
      ["consumption_logs.deleted", "update consumption_logs set deleted = not deleted where id = (select min(id::text)::uuid from consumption_logs)"],
      ["consumption_logs.created_at", "update consumption_logs set created_at = created_at + interval '1 microsecond' where id = (select min(id::text)::uuid from consumption_logs)"],
      ["inventory_counts.completed_at", "update inventory_counts set completed_at = completed_at + interval '1 second' where id = (select min(id::text)::uuid from inventory_counts)"],
      ["inventory_count_items.expected_quantity", "update inventory_count_items set expected_quantity = expected_quantity + 1 where id = (select min(id::text)::uuid from inventory_count_items)"],
      ["inventory_count_items.counted_quantity", "update inventory_count_items set counted_quantity = coalesce(counted_quantity, 0) + 1 where id = (select min(id::text)::uuid from inventory_count_items)"],
      ["inventory_count_items.resolved", "update inventory_count_items set resolved = not resolved where id = (select min(id::text)::uuid from inventory_count_items)"],
      ["inventory_count_items.resolution_note", "update inventory_count_items set resolution_note = coalesce(resolution_note, '') || 'x' where id = (select min(id::text)::uuid from inventory_count_items)"],
      ["inventory_count_items.consumption_log_ids", "update inventory_count_items set consumption_log_ids = consumption_log_ids || gen_random_uuid() where id = (select min(id::text)::uuid from inventory_count_items)"],
      ["audit_log.description", "update audit_log set description = description || 'x' where id = (select min(id::text)::uuid from audit_log)"],
      ["audit_log row deleted", "delete from audit_log where id = (select min(id::text)::uuid from audit_log)"],
      ["consumption_logs row inserted", "insert into consumption_logs (reagent_id, amount, date, used_by) select id, 1, current_date, 'x' from reagents limit 1"],
    ];
    for (const [label, sql] of mutations) {
      await c.query("begin; set local session_replication_role = replica;"); await c.query(sql);
      const r = await fp(); await c.query("rollback");
      check(`mutation of ${label} is detected (only its table's fingerprint changes)`, Object.keys(base).filter((t) => r[t] !== base[t]), [label.split(/[ .]/)[0]]);
    }
    check("after all mutation tests (rolled back) the fingerprint is the pre-rollout value again", await fp(), base);
    await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 26 });
