// Batch D — historical evidence backfill (ADD_HISTORICAL_EVIDENCE_BACKFILL.sql) on real
// PostgreSQL, against the synthetic history in tests/fixtures/backfillHistory.mjs (built around
// the plan's own row ids; every other value invented). Metadata only: exactly the planned
// classes and links, nothing else changes, re-running changes nothing, the guard then protects
// it, newer evidence is never overwritten, rows that changed since are skipped.
// Ported from runD.mjs (which used the read-only Production snapshot). What cannot be re-proved
// synthetically — that the plan was correctly DERIVED from Production — is listed in the
// coverage matrix; the plan was applied in Phase 5.
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres } from "../helpers/pg.mjs";
import { historyDb, EVIDENCE_CHAIN } from "../helpers/historyDb.mjs";
import { canon } from "../helpers/uuid.mjs";
import { buildBackfillHistory, CU } from "../fixtures/backfillHistory.mjs";

const { plan: P, tables, expected: X } = buildBackfillHistory();
const D = readRoot("ADD_HISTORICAL_EVIDENCE_BACKFILL.sql");
let section = "";
const chk = (n, a, b) => check(`[${section}] ${n}`, canon(a), canon(b));

for (const version of PG_VERSIONS) suite(`Batch D · historical evidence backfill (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const BIZ = {
      reagents: "select md5(string_agg(t::text, '|' order by id)) h from (select * from reagents) t",
      consumption_logs: "select md5(string_agg(t::text, '|' order by id)) h from (select id, reagent_id, amount, date, used_by, note, tested_by_qc, deleted, deleted_by, deleted_at, edited_by, edited_at, created_at, active_device_changed, previous_active_lot_id from consumption_logs) t",
      inventory_counts: "select md5(string_agg(t::text, '|' order by id)) h from (select * from inventory_counts) t",
      inventory_count_items: "select md5(string_agg(t::text, '|' order by id)) h from (select id, count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity, resolved, resolution_note, created_at, consumption_log_ids from inventory_count_items) t",
      audit_log: "select md5(string_agg(t::text, '|' order by id)) h from (select * from audit_log) t",
    };
    const bizFp = async (c) => Object.fromEntries(await Promise.all(Object.entries(BIZ).map(async ([k, q]) => [k, (await c.query(q)).rows[0].h])));
    const allFp = async (c) => (await c.query("select md5(string_agg(h, '|' order by t)) h from (select 'l' t, md5(string_agg(x::text, ',' order by x.id)) h from consumption_logs x union all select 'i', md5(string_agg(x::text, ',' order by x.id)) from inventory_count_items x union all select 'r', md5(string_agg(x::text, ',' order by x.id)) from reagents x union all select 'c', md5(string_agg(x::text, ',' order by x.id)) from inventory_counts x union all select 'a', md5(string_agg(x::text, ',' order by x.id)) from audit_log x) s")).rows[0].h;
    const meta = async (c) => ({
      prov: Object.fromEntries((await c.query("select coalesce(date_provenance, 'NULL') p, count(*)::int n from consumption_logs group by 1")).rows.map((r) => [r.p, r.n])),
      linked: (await c.query("select count(*)::int n from consumption_logs where source_count_item_id is not null")).rows[0].n,
      resolved_at: (await c.query("select count(*)::int n from inventory_count_items where resolved_at is not null")).rows[0].n,
      resolved_by: (await c.query("select count(*)::int n from inventory_count_items where resolved_by is not null")).rows[0].n,
      counted_at_or_by: (await c.query("select count(*)::int n from inventory_count_items where counted_at is not null or counted_by is not null")).rows[0].n,
      resolution_details: (await c.query("select count(*)::int n from inventory_count_items where resolution_details is not null")).rows[0].n,
    });
    const runD = async (c) => { try { await c.query(D); return null; } catch (e) { return e.message; } };

    // ═════ 1. Replica with / without the final guard ═════
    for (const guard of [true, false]) {
      section = guard ? "history + final guard" : "history, guard off";
      const c = await historyDb(server, tables, { before: EVIDENCE_CHAIN.filter((f) => guard || f !== "ADD_EVIDENCE_GUARD.sql") });
      const loaded = Object.fromEntries(await Promise.all(["reagents", "consumption_logs", "inventory_counts", "inventory_count_items", "audit_log"].map(async (t) => [t, (await c.query(`select count(*)::int n from ${t}`)).rows[0].n])));
      chk("database holds the whole synthetic history", loaded, X.rows);
      const before = await meta(c), biz0 = await bizFp(c);
      const itemsAll0 = (await c.query("select md5(string_agg(x::text, ',' order by x.id)) h from inventory_count_items x")).rows[0].h;
      chk("before: no evidence metadata at all (the state after the Foundation)", before, { prov: { NULL: X.rows.consumption_logs }, linked: 0, resolved_at: 0, resolved_by: 0, counted_at_or_by: 0, resolution_details: 0 });
      chk("run 1: no error", await runD(c), null);
      const after = await meta(c), all1 = await allFp(c);
      chk(`after: ${X.provenance.manual} manual, ${X.provenance.count_redated} count_redated, ${X.provenance.historical_unknown} historical_unknown; ${X.links} linked; count lines get no resolved_at/by, counted_at/by or details`, after, { prov: X.provenance, linked: X.links, resolved_at: 0, resolved_by: 0, counted_at_or_by: 0, resolution_details: 0 });
      chk("inventory_count_items not touched at all (every column of every line byte-identical)", (await c.query("select md5(string_agg(x::text, ',' order by x.id)) h from inventory_count_items x")).rows[0].h, itemsAll0);
      chk("business values byte-identical (reagents, log facts, counts, line facts, audit log)", await bizFp(c), biz0);
      const prov = (await c.query("select id, date_provenance p from consumption_logs")).rows;
      const byP = (p) => prov.filter((r) => r.p === p).map((r) => r.id).sort();
      chk("exactly the planned rows in each class", [byP("manual"), byP("count_redated"), byP("historical_unknown")], [[...P.manual].sort(), [...P.count_redated].sort(), [...P.historical_unknown].sort()]);
      chk("manual_spread / count_exact* / count_spread_window never assigned to history", ["manual_spread", "count_exact", "count_exact_default", "count_spread_window"].map((p) => byP(p).length), [0, 0, 0, 0]);
      chk("exactly the planned links", (await c.query("select id, source_count_item_id l from consumption_logs where source_count_item_id is not null")).rows.map((r) => [r.id, r.l]).sort(), P.links.map((x) => [x.row, x.line]).sort());
      chk("only the two approved consumption_logs columns were filled (no row left with both NULL)", (await c.query("select count(*)::int n from consumption_logs where date_provenance is null and source_count_item_id is null")).rows[0].n, 0);
      const dup = (await c.query("select l.amount::float8 a, l.deleted, l.date_provenance p, l.source_count_item_id = i.id same, i.expected_quantity::float8 - i.counted_quantity::float8 shortage, i.resolved_at from consumption_logs l join inventory_count_items i on i.reagent_name = $2 and i.lot_number = $3 where l.reagent_id = i.reagent_id and l.used_by = $1", [CU, X.dupLine.name, X.dupLine.lot])).rows;
      chk("duplicate-correction line: both correction rows kept as they are, both linked to the one line (sum 2 vs shortage 1 stays visible), resolved_at NULL", [dup.length, dup.every((r) => r.same && r.a === 1 && !r.deleted && r.p === "historical_unknown" && r.shortage === 1 && r.resolved_at === null)], [2, true]);
      chk(`${X.beforeReceived} re-dated rows dated before their lot's received date: unchanged dates, classified count_redated`, (await c.query("select count(*)::int n, bool_and(l.date_provenance = 'count_redated') ok from consumption_logs l join reagents r on r.id = l.reagent_id where l.used_by = $1 and l.date < r.date_added", [CU])).rows[0], { n: X.beforeReceived, ok: true });
      chk(`${X.correctedLines} corrected-to-match-count lines: no logs created, none linked`, (await c.query("select count(*)::int n, count(*) filter (where exists (select 1 from consumption_logs l where l.source_count_item_id = i.id))::int linked from inventory_count_items i where resolution_note = 'Corrected to match count'")).rows[0], { n: X.correctedLines, linked: 0 });
      chk(`all ${X.lines} historical lines keep resolved_at/by, counted_at/by, resolution_details NULL (intentional)`, (await c.query("select count(*)::int n from inventory_count_items where resolved_at is null and resolved_by is null and counted_at is null and counted_by is null and resolution_details is null")).rows[0].n, X.lines);
      chk("the historical resolution audit rows are still all there, unchanged", (await c.query("select count(*)::int n from audit_log where entity = 'reagent' and description like '% — Physical count %'")).rows[0].n, X.resolutionAuditRows);
      chk("run 2: no error, and zero changes (every row of every table byte-identical)", [await runD(c), await allFp(c)], [null, all1]);
      if (guard) {
        const t = async (sql) => { try { await c.query(sql); return "OK"; } catch (e) { return `${e.message}/${e.detail}`; } };
        chk("after backfill, the guard protects it: provenance change refused", await t(`update consumption_logs set date_provenance = 'manual_spread' where id = '${P.manual[0]}'`), "evidence_field_protected/date_provenance");
        chk("… re-linking refused", await t(`update consumption_logs set source_count_item_id = null where id = '${P.links[0].row}'`), "evidence_field_protected/source_count_item_id");
      }
      await c.end();
    }

    // ═════ 2. Already-classified / newer evidence is never overwritten ═════
    {
      section = "preservation";
      const c = await historyDb(server, tables);
      const target = { manual: P.manual[0], redated: P.count_redated[0], unknown: P.historical_unknown[0], link: P.links.find((x) => x.method !== "consumption_log_ids").row, line: P.links[0].line };
      const otherLine = (await c.query("select id from inventory_count_items where id <> $1 and resolved and resolution_note like 'Logged as usage%' limit 1", [P.links.find((x) => x.row === target.link).line])).rows[0].id;
      await c.query("set session_replication_role = replica"); // seeding newer evidence onto targeted rows
      await c.query("update consumption_logs set date_provenance = 'manual_spread' where id = $1", [target.manual]);
      await c.query("update consumption_logs set date_provenance = 'count_exact' where id = $1", [target.redated]);
      await c.query("update consumption_logs set date_provenance = 'count_exact_default' where id = $1", [target.unknown]);
      await c.query("update consumption_logs set source_count_item_id = $2 where id = $1", [target.link, otherLine]);
      await c.query("update inventory_count_items set resolved_at = '2026-01-01T00:00:00Z', resolved_by = 'EARLIER' where id = $1", [target.line]);
      await c.query("set session_replication_role = origin");
      const lot = (await c.query("select id from reagents where not deleted limit 1")).rows[0].id;
      for (const p of ["manual", "manual_spread", "count_exact", "count_exact_default", "count_spread_window", "count_redated", "historical_unknown"])
        await c.query("insert into consumption_logs (reagent_id, amount, date, used_by, note, date_provenance, source_count_item_id) values ($1, 1, '2026-10-06', $2, 'new', $3, $4)", [lot, p.startsWith("manual") ? "staff-1" : CU, p, p.startsWith("manual") ? null : otherLine]);
      const before = (await c.query("select id, date_provenance, source_count_item_id from consumption_logs where note = 'new' order by date_provenance")).rows;
      chk("run: no error", await runD(c), null);
      const g = async (id) => (await c.query("select date_provenance p, source_count_item_id s from consumption_logs where id = $1", [id])).rows[0];
      chk("pre-set provenance kept (manual_spread / count_exact / count_exact_default not overwritten)", [(await g(target.manual)).p, (await g(target.redated)).p, (await g(target.unknown)).p], ["manual_spread", "count_exact", "count_exact_default"]);
      chk("pre-set link kept (not re-pointed)", (await g(target.link)).s, otherLine);
      chk("pre-set resolved_at/by kept", (await c.query("select resolved_at, resolved_by from inventory_count_items where id = $1", [target.line])).rows[0], { resolved_at: new Date("2026-01-01T00:00:00Z"), resolved_by: "EARLIER" });
      chk("new-style rows (all 7 values, linked) untouched", (await c.query("select id, date_provenance, source_count_item_id from consumption_logs where note = 'new' order by date_provenance")).rows, before);
      chk("everything else still filled as planned (planned − the 3 pre-set rows + the 7 new rows)", (await meta(c)).prov,
        { manual: X.provenance.manual - 1 + 1, count_redated: X.provenance.count_redated - 1 + 1, historical_unknown: X.provenance.historical_unknown - 1 + 1, manual_spread: 2, count_exact: 2, count_exact_default: 2, count_spread_window: 1 });
      await c.end();
    }

    // ═════ 3. Rows that changed since the plan was made are skipped, not mis-classified ═════
    {
      section = "changed since the plan";
      const c = await historyDb(server, tables);
      const moved = P.links.find((x) => x.method === "consumption_log_ids").row;
      const renamed = P.count_redated[1];
      const otherLot = (await c.query("select l.id from reagents l where l.id <> (select reagent_id from consumption_logs where id = $1) limit 1", [moved])).rows[0].id;
      await c.query("set session_replication_role = replica");
      await c.query("update consumption_logs set reagent_id = $2 where id = $1", [moved, otherLot]);
      await c.query("update consumption_logs set used_by = 'staff-9' where id = $1", [renamed]);
      await c.query("update consumption_logs set deleted = true where id = $1", [P.historical_unknown[1]]);
      await c.query("set session_replication_role = origin");
      chk("run: no error", await runD(c), null);
      const r1 = (await c.query("select source_count_item_id s from consumption_logs where id = $1", [moved])).rows[0];
      const r2 = (await c.query("select date_provenance p from consumption_logs where id = $1", [renamed])).rows[0];
      chk("a row now on another lot is not linked; a row no longer a correction is not classified count_redated (left NULL)", [r1.s, r2.p], [null, null]);
      chk("an undone correction is still classified (provenance describes its date choice)", (await c.query("select date_provenance p from consumption_logs where id = $1", [P.historical_unknown[1]])).rows[0].p, "historical_unknown");
      await c.end();
    }
  } finally { await server.stop(); }
}, { expectedChecks: 43 });
