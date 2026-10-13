// Batch E — READINESS_CHECK.sql (read-only) at each rollout stage, and parity with the JS
// validator (reconciliationEvidence.js), on the synthetic history (tests/fixtures/backfillHistory.mjs).
// Stages: before the evidence rollout; Foundation+Functions+Start+D without the guard; the
// final stack; then an open count, a new-style row without a link, an old client writing
// after D, and a complete new count. Ported from runE.mjs (which used the Production
// snapshot); its history numbers are now derived from the synthetic construction.
process.env.TZ = "Asia/Riyadh";
import { suite, check, load, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres } from "../helpers/pg.mjs";
import { historyDb } from "../helpers/historyDb.mjs";
import { buildBackfillHistory, CU } from "../fixtures/backfillHistory.mjs";

const E = await load("reconciliationEvidence.js");
const { tables, expected: X } = buildBackfillHistory();
const RC = readRoot("READINESS_CHECK.sql");
const CHAIN = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"];
const ROLLOUT = ["ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_STOCK_COUNT_START.sql", "ADD_HISTORICAL_EVIDENCE_BACKFILL.sql"];
const stages = { pre: [], noguard: ROLLOUT, final: [...ROLLOUT, "ADD_EVIDENCE_GUARD.sql"] };
let section = "";
const chk = (n, a, b) => check(`[${section}] ${n}`, a, b);

for (const version of PG_VERSIONS) suite(`Batch E · readiness check and validator parity (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const replica = (files) => historyDb(server, tables, { before: CHAIN, after: files });
    const fp = async (c) => (await c.query("select md5(string_agg(h, '|' order by t)) h from (select 'l' t, md5(string_agg(x::text, ',' order by x.id)) h from consumption_logs x union all select 'i', md5(string_agg(x::text, ',' order by x.id)) from inventory_count_items x union all select 'r', md5(string_agg(x::text, ',' order by x.id)) from reagents x union all select 'c', md5(string_agg(x::text, ',' order by x.id)) from inventory_counts x union all select 'a', md5(string_agg(x::text, ',' order by x.id)) from audit_log x) s")).rows[0].h;
    async function readiness(c) {
      const f0 = await fp(c);
      await c.query("begin transaction read only");
      let rows, err = null; try { rows = (await c.query(RC)).rows; } catch (e) { err = e.message; } finally { await c.query("rollback"); }
      return { err, rows, unchanged: (await fp(c)) === f0, overall: rows?.find((r) => r.area === "overall")?.result, blockers: rows?.filter((r) => r.result === "BLOCKER").map((r) => r.check_name) || [], by: Object.fromEntries((rows || []).map((r) => [r.check_name, [r.result, r.detail]])) };
    }
    const dataOf = async (c) => Object.fromEntries(await Promise.all(["reagents", "consumption_logs", "inventory_counts", "inventory_count_items"].map(async (t) => [t, (await c.query(`select coalesce(json_agg(x), '[]') j from ${t} x`)).rows[0].j])));

    section = "before the evidence rollout";
    {
      const c = await replica(stages.pre); const r = await readiness(c);
      chk("runs read-only on the older schema, writes nothing", [r.err, r.unchanged], [null, true]);
      chk("BLOCKED: Foundation, provenance CHECK, 4 functions, guard missing; structure checks need the Foundation", [r.overall, r.blockers], ["BLOCKED", ["Evidence Foundation columns (2 log + 5 count-line)", "Provenance CHECK allows exactly the 7 values", "stock_count_redate present and callable by anon", "stock_count_resolve present and callable by anon", "stock_count_start present and callable by anon", "stock_count_window present and callable by anon", "Evidence Guard enabled (final B2 rules)", "No new-style count correction without source_count_item_id", "No manual provenance on a Stock Count correction", "No Stock Count provenance on a normal log", "No unknown provenance value", "Every link joins a correction to a line of the same lot", "Every link points to a line resolved as usage"]]);
      chk("scope rule present; no open count", [r.by["Open-count scope rule (trigger + 2 unique indexes)"][0], r.by["No Stock Count currently open"]], ["ok", ["ok", "0 open"]]);
      await c.end();
    }
    section = "Foundation + Functions + Start + D, guard not yet enabled";
    {
      const c = await replica(stages.noguard); const r = await readiness(c);
      chk("BLOCKED only by the not-yet-enabled guard", [r.err, r.unchanged, r.overall, r.blockers], [null, true, "BLOCKED", ["Evidence Guard enabled (final B2 rules)"]]);
      await c.end();
    }
    section = "final stack";
    {
      const c = await replica(stages.final); const r = await readiness(c);
      chk("READY_WITH_HISTORICAL_WARNINGS, no blocker, read-only", [r.err, r.unchanged, r.overall, r.blockers], [null, true, "READY_WITH_HISTORICAL_WARNINGS", []]);
      const w = (k) => r.by[k];
      chk(`history: 0 unclassified, 0 unlinked; duplicate-correction mismatch 1; ${X.beforeReceived} pre-received; ${X.provenance.historical_unknown} unknown timing; ${X.resolvedLinesWithoutMetadata} resolved lines without modern metadata`, [
        w("Logs without provenance (classify with the regenerated Batch D)"), w("Stock Count corrections without a count-line link"),
        w("Usage lines whose linked corrections differ from the physical shortage (e.g. kit3 / 0314)"), w("Corrections dated before their lot was received"),
        w("Historical corrections with unknown timing provenance"), w("Resolved lines without resolved_at / resolved_by / resolution_details")].map((x) => [x[0], x[1].split(" ")[0]]),
        [["ok", "0"], ["ok", "0"], ["warning", "1"], ["warning", String(X.beforeReceived)], ["limitation", String(X.provenance.historical_unknown)], ["limitation", String(X.resolvedLinesWithoutMetadata)]]);
      chk("every structure check ok", r.rows.filter((x) => x.area === "structure").map((x) => x.result), ["ok", "ok", "ok", "ok", "ok", "ok"]);
      const d = await dataOf(c);
      const v = E.validateEvidence({ reagents: d.reagents, logs: d.consumption_logs, counts: d.inventory_counts, items: d.inventory_count_items }, { evidenceSince: "2026-10-20T00:00:00Z" });
      const cnt = (code) => v.findings.filter((f) => f.code === code).length;
      chk("validator agrees with the SQL: 0 errors; duplicate-correction excess 1; pre-received; unknown timing; 0 unlinked; 0 unclassified", [v.summary.error, cnt("allocation_excess"), cnt("date_before_received"), cnt("historical_unknown_timing"), cnt("count_log_unlinked"), cnt("unclassified_provenance")], [0, 1, X.beforeReceived, X.provenance.historical_unknown, 0, 0]);
      const k3 = v.findings.find((f) => f.code === "allocation_excess");
      chk("duplicate-correction line: physical shortage 1 authoritative, allocation 2 (+1), warning", [k3.lot, k3.severity, k3.physical_shortage, k3.allocation_total, k3.allocation_mismatch], [`${X.dupLine.name} / ${X.dupLine.lot}`, "warning", 1, 2, 1]);
      chk("validator: every resolved/counted historical line reported as an expected limitation (not an error)", [cnt("historical_line_metadata_missing"), v.findings.filter((f) => f.code.includes("metadata")).every((f) => f.severity === "expected_historical_limitation")], [X.linesResolvedOrCounted, true]);
      chk("validator readiness (no failed checks) = READY_WITH_HISTORICAL_WARNINGS", E.readinessStatus([{ ok: true }], v), "READY_WITH_HISTORICAL_WARNINGS");
      await c.end();
    }
    section = "final + open count";
    { const c = await replica(stages.final); await c.query("select stock_count_start('Chemistry', 'staff-1')"); const r = await readiness(c); chk("an open count blocks", [r.overall, r.blockers], ["BLOCKED", ["No Stock Count currently open"]]); await c.end(); }
    section = "final + new-style row without link";
    { const c = await replica(stages.final); const lot = (await c.query("select id from reagents limit 1")).rows[0].id;
      await c.query("insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ($1, 1, '2026-10-06', $2, 'count_exact')", [lot, CU]);
      const r = await readiness(c); chk("a count_exact row without source link blocks", [r.overall, r.blockers], ["BLOCKED", ["No new-style count correction without source_count_item_id"]]); await c.end(); }
    section = "final + old client wrote after D";
    { const c = await replica(stages.final); const lot = (await c.query("select id from reagents limit 1")).rows[0].id;
      await c.query("insert into consumption_logs (reagent_id, amount, date, used_by) values ($1, 1, '2026-10-06', 'staff-a')", [lot]);
      const r = await readiness(c); chk("a log without provenance is a warning (re-run D / old client), not a blocker", [r.overall, r.by["Logs without provenance (classify with the regenerated Batch D)"]], ["READY_WITH_HISTORICAL_WARNINGS", ["warning", "1 rows"]]); await c.end(); }
    section = "final + a complete new count";
    {
      const c = await replica(stages.final);
      const since = (await c.query("select now() n")).rows[0].n;
      await c.query("set role anon");
      const s = (await c.query("select stock_count_start('Hematology', 'staff-1') r")).rows[0].r;
      const line = s.items.find((i) => Number(i.expected_quantity) > 0);
      await c.query("update inventory_count_items set counted_quantity = $2, counted_at = now(), counted_by = 'staff-1' where id = $1", [line.id, Number(line.expected_quantity) - 1]);
      for (const i of s.items.filter((i) => i.id !== line.id)) await c.query("update inventory_count_items set counted_quantity = expected_quantity, counted_at = now(), counted_by = 'staff-1' where id = $1", [i.id]);
      const r1 = (await c.query("select stock_count_resolve(p_item_id => $1, p_method => 'usage_exact', p_actor => 'staff-1', p_seen_expected => $2, p_seen_counted => $3, p_date => (now() at time zone 'Asia/Riyadh')::date) r", [line.id, line.expected_quantity, Number(line.expected_quantity) - 1])).rows[0].r;
      await c.query("update inventory_counts set status = 'completed', completed_by = 'staff-1', completed_at = now() where id = $1", [s.count.id]);
      await c.query("reset role");
      const r = await readiness(c);
      chk("after a full new count (start → count → resolve → finish): still no blocker", [r1.status, r.overall, r.blockers], ["ok", "READY_WITH_HISTORICAL_WARNINGS", []]);
      const d = await dataOf(c);
      const v = E.validateEvidence({ reagents: d.reagents, logs: d.consumption_logs, counts: d.inventory_counts, items: d.inventory_count_items }, { evidenceSince: since.toISOString() });
      const newFindings = v.findings.filter((f) => (f.line_id && s.items.some((i) => i.id === f.line_id)) || (f.log_id && d.consumption_logs.find((l) => l.id === f.log_id)?.source_count_item_id === line.id));
      chk("new count's lines and correction: complete transaction-time evidence, zero findings", newFindings, []);
      chk("the new correction is classified count_exact_default, linked, physical quantity", (() => { const l = d.consumption_logs.find((x) => x.source_count_item_id === line.id); const k = E.classifyLog(l); return [k.classification, k.linked, k.quantityEvidence, k.timingEvidence]; })(), ["count_default", true, "physical_count_derived", "default_assumption"]);
      await c.end();
    }
  } finally { await server.stop(); }
}, { expectedChecks: 17 });
