// A synthetic Stock Count history shaped around the one-off Batch D backfill plan.
//
// ADD_HISTORICAL_EVIDENCE_BACKFILL.sql lists, by row id, which historical logs get which
// provenance and which correction rows link to which count line. Those ids are already in
// the repository; everything else here (names, lots, quantities, dates, people, notes) is
// invented. The history is built so that each rule the backfill relies on holds, and so
// that the known anomalies exist on purpose:
//   · a "duplicate-correction" line: shortage 1 but two correction rows of 1 (both stay, both linked)
//   · 8 re-dated correction rows dated before their lot's received date
//   · 12 "Corrected to match count" lines with no usage logs
//   · 3 undone manual logs
// Expected values are derived from this construction (not from running the SQL).
import { readRoot } from "../helpers/core.mjs";
import { uuidOf } from "../helpers/uuid.mjs";

export const CU = "Unlogged (physical count)";

/** The plan as written in the SQL file: { manual, count_redated, historical_unknown, links: [{row, line, method}] }. */
export function readBackfillPlan() {
  const full = readRoot("ADD_HISTORICAL_EVIDENCE_BACKFILL.sql");
  const sql = full.slice(full.search(/^begin;/m)); // the header comment repeats the section titles
  const section = (a, b) => sql.slice(sql.indexOf(a), b ? sql.indexOf(b) : undefined);
  const ids = (s) => [...s.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
  const manual = ids(section("-- 1. manual", "-- 2. count_redated"));
  const count_redated = ids(section("-- 2. count_redated", "-- 3. historical_unknown"));
  const historical_unknown = ids(section("-- 3. historical_unknown", "-- 4. source_count_item_id"));
  const links = [...section("-- 4. source_count_item_id").matchAll(/\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid\)/g)]
    .map(([, row, line]) => ({ row, line, method: count_redated.includes(row) ? "consumption_log_ids" : "audit_window" }));
  return { manual, count_redated, historical_unknown, links };
}

export function buildBackfillHistory() {
  const plan = readBackfillPlan();
  const base = { item_type: "Reagent", device: "", expiry_date: "2027-06-30", added_by: "tester", low_stock_threshold: 1, deleted: false, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, receiving_notes: "", inspection_notes: "", active_on_device: false };
  const reagents = [], counts = [], items = [], logs = [], audit = [];
  const COUNT_DEFS = [
    { key: "c-chem", department: "Chemistry", day: "2026-09-16" },
    { key: "c-hema", department: "Hematology", day: "2026-09-20" },
    { key: "c-phleb", department: "Phlebotomy", day: "2026-09-25" },
  ];
  for (const c of COUNT_DEFS) counts.push({ id: uuidOf(c.key), department: c.department, status: "completed", started_by: "tester", started_at: `${c.day}T08:00:00Z`, completed_by: "tester", completed_at: `${c.day}T12:00:00Z` });
  const countFor = (i) => COUNT_DEFS[i % COUNT_DEFS.length];
  const auditRow = (desc, at) => audit.push({ id: uuidOf(`audit-${audit.length}`), action: "edit", entity: "reagent", description: desc, performed_by: "tester", performed_at: at });

  // ── usage lines (one lot each) from the plan's links ──
  const rowsByLine = new Map();
  for (const l of plan.links) (rowsByLine.get(l.line) || rowsByLine.set(l.line, []).get(l.line)).push(l.row);
  const lineIds = [...rowsByLine.keys()];
  // the duplicate-correction line: an "audit_window" line with two rows
  const dupLine = lineIds.find((id) => rowsByLine.get(id).length === 2 && rowsByLine.get(id).every((r) => plan.historical_unknown.includes(r)));
  const redatedLines = lineIds.filter((id) => rowsByLine.get(id).every((r) => plan.count_redated.includes(r)));
  let beforeReceived = 0;
  lineIds.forEach((lineId, i) => {
    const c = countFor(i), rows = rowsByLine.get(lineId);
    const lotId = uuidOf(`bf-lot-${i}`);
    const isDup = lineId === dupLine, redated = redatedLines.includes(lineId);
    const name = isDup ? "Kit K" : `Item ${String(i + 1).padStart(2, "0")}`, lot = isDup ? "TK-552" : `TB-${String(i + 1).padStart(3, "0")}`;
    const shortage = isDup ? 1 : rows.length; // every row is 1 unit; duplicate line: 2 rows for a shortage of 1
    const expected = 10, counted = expected - shortage;
    reagents.push({ ...base, id: lotId, name, department: c.department, lot_number: lot, unit: "box", quantity_received: 12, current_quantity: counted, date_added: "2026-07-01" });
    const note = redated ? "Logged as usage spread from 2026-09-01 to 2026-09-10" : `Logged as usage on ${c.day}`;
    items.push({ id: lineId, count_id: uuidOf(c.key), reagent_id: lotId, reagent_name: name, lot_number: lot, department: c.department, unit: "box", expected_quantity: expected, counted_quantity: counted, resolved: true, resolution_note: note, consumption_log_ids: redated ? rows : [], created_at: `${c.day}T08:00:00Z` });
    rows.forEach((rowId, k) => {
      // re-dated rows: dates follow the edit; the first 8 of them predate the lot's receipt
      let date = c.day;
      if (redated) { date = beforeReceived < 8 ? "2026-06-20" : `2026-09-${String(1 + (k % 9)).padStart(2, "0")}`; if (beforeReceived < 8) beforeReceived++; }
      logs.push({ id: rowId, reagent_id: lotId, amount: 1, date, used_by: CU, note: "Retroactively logged — found missing during a physical count.", tested_by_qc: false, deleted: false, created_at: `${c.day}T09:${String(k).padStart(2, "0")}:00Z`, active_device_changed: false, previous_active_lot_id: null });
    });
    auditRow(`${name} — Lot ${lot} — Physical count found ${shortage} box of unlogged usage, recorded as consumption dated ${c.day}: ${expected} → ${counted}`, `${c.day}T09:00:30Z`);
  });

  // ── 12 "Corrected to match count" lines (no logs) and 8 lines without a discrepancy ──
  for (let i = 0; i < 20; i++) {
    const c = countFor(i), corrected = i < 12;
    const lotId = uuidOf(`bf-extra-lot-${i}`);
    const name = `Other ${String(i + 1).padStart(2, "0")}`, lot = `TO-${String(i + 1).padStart(3, "0")}`;
    reagents.push({ ...base, id: lotId, name, department: c.department, lot_number: lot, unit: "bottle", quantity_received: 6, current_quantity: corrected ? 4 : 5, date_added: "2026-07-01" });
    items.push({ id: uuidOf(`bf-extra-line-${i}`), count_id: uuidOf(c.key), reagent_id: lotId, reagent_name: name, lot_number: lot, department: c.department, unit: "bottle", expected_quantity: 5, counted_quantity: corrected ? 4 : 5, resolved: corrected, resolution_note: corrected ? "Corrected to match count" : null, consumption_log_ids: [], created_at: `${c.day}T08:00:00Z` });
    if (corrected) auditRow(`${name} — Lot ${lot} — Physical count adjustment: 5 → 4`, `${c.day}T10:00:00Z`);
  }

  // ── 68 manual logs (3 undone) on 6 lots ──
  for (let j = 0; j < 6; j++) reagents.push({ ...base, id: uuidOf(`bf-manual-lot-${j}`), name: `Manual ${j + 1}`, department: j % 2 ? "Hematology" : "Chemistry", lot_number: `TM-${j + 1}`, unit: "piece", quantity_received: 100, current_quantity: 80, date_added: "2026-07-01" });
  plan.manual.forEach((id, k) => {
    const deleted = k < 3;
    logs.push({ id, reagent_id: uuidOf(`bf-manual-lot-${k % 6}`), amount: 1 + (k % 3), date: `2026-08-${String(1 + (k % 28)).padStart(2, "0")}`, used_by: k % 2 ? "staff-a" : "staff-b", note: "", tested_by_qc: false, deleted, deleted_by: deleted ? "staff-a" : null, deleted_at: deleted ? "2026-09-01T10:00:00Z" : null, created_at: `2026-08-${String(1 + (k % 28)).padStart(2, "0")}T10:00:00Z`, active_device_changed: false, previous_active_lot_id: null });
  });
  for (let k = 0; k < 5; k++) audit.push({ id: uuidOf(`audit-other-${k}`), action: "add", entity: "reagent", description: `received lot ${k}`, performed_by: "tester", performed_at: "2026-07-01T09:00:00Z" });

  const tables = { reagents, inventory_counts: counts, inventory_count_items: items, consumption_logs: logs, audit_log: audit };
  const expected = {
    rows: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])),
    provenance: { manual: plan.manual.length, count_redated: plan.count_redated.length, historical_unknown: plan.historical_unknown.length },
    links: plan.links.length,
    dupLine: { name: "Kit K", lot: "TK-552", rows: 2, shortage: 1 },
    beforeReceived,
    correctedLines: 12,
    lines: items.length,
    resolvedLinesWithoutMetadata: items.filter((i) => i.resolved).length,
    linesResolvedOrCounted: items.filter((i) => i.resolved || i.counted_quantity !== null).length,
    resolutionAuditRows: audit.filter((a) => / — Physical count /.test(a.description)).length,
  };
  return { plan, tables, expected };
}

/** Inserts the history with triggers off (restoring existing rows, as a backup restore would). */
export async function loadBackfillHistory(c, tables) {
  await c.query("set session_replication_role = replica");
  for (const t of ["reagents", "inventory_counts", "inventory_count_items", "consumption_logs", "audit_log"]) {
    const rows = tables[t];
    const cols = (await c.query("select column_name from information_schema.columns where table_name = $1", [t])).rows.map((r) => r.column_name);
    const use = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => cols.includes(k));
    await c.query(`insert into ${t} (${use.join(", ")}) select ${use.join(", ")} from json_populate_recordset(null::${t}, $1::json)`, [JSON.stringify(rows)]);
  }
  await c.query("set session_replication_role = origin");
}
