// Synthetic database rows for the PostgreSQL suites (no Production data).
// Covers every history situation the guards care about:
//   pHist     packaged, Stock Count lines only            (Chemistry)
//   logsOnly  usage logs only                             (Hematology)
//   both      packaged, logs AND a resolved count line    (Chemistry)
//   free      no history, no box size, no expiry          (Chemistry)
//   freePack  no history, packaged                        (Hematology)
//   ended     discarded lot with a log                    (Hematology)
// Inserted with triggers disabled (session_replication_role = replica), exactly like
// restoring existing history; the tests then run with every trigger active.
export const IDS = {
  pHist: "00000000-0000-4000-8000-000000000001",
  logsOnly: "00000000-0000-4000-8000-000000000002",
  both: "00000000-0000-4000-8000-000000000003",
  free: "00000000-0000-4000-8000-000000000004",
  freePack: "00000000-0000-4000-8000-000000000005",
  ended: "00000000-0000-4000-8000-000000000006",
  count: "00000000-0000-4000-8000-0000000000c1",
  linePHist: "00000000-0000-4000-8000-0000000000d1",
  lineBoth: "00000000-0000-4000-8000-0000000000d2",
};

export async function seed(c) {
  await c.query("set session_replication_role = replica");
  const lot = (id, name, dept, device, lot_number, unit, qr, cq, upc, extra = "") =>
    c.query(`insert into reagents (id, name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, expiry_date, date_added, added_by, low_stock_threshold, units_per_carton${extra ? ", deleted, deleted_by, deleted_at, discard_reason, discard_note" : ""})
             values ($1, $2, $3, 'Reagent', $4, $5, $6, $7, $8, ${id === IDS.free ? "null" : "'2027-06-30'"}, '2026-07-01', 'tester', 1, $9${extra ? ", true, 'tester', '2026-09-01T10:00:00Z', 'Expired', ''" : ""})`,
      [id, name, dept, device, lot_number, unit, qr, cq, upc]);
  await lot(IDS.pHist, "Analyte P", "Chemistry", "Analyzer 1", "TP-200", "Piece ", 15, 15, 3);
  await lot(IDS.logsOnly, "Diluent H", "Hematology", "Analyzer 2", "TH-001", "box", 5, 4, null);
  await lot(IDS.both, "Reagent C", "Chemistry", "Analyzer 1", "TC-006", "bottle", 12, 8, 6);
  await lot(IDS.free, "Enzyme A", "Chemistry", "", "TA-147", "box", 3, 2, null);
  await lot(IDS.freePack, "Reference L", "Hematology", "Analyzer 2", "TL-002", "bottle", 8, 8, 8);
  await lot(IDS.ended, "Stain S", "Hematology", "", "TS-001", "bottle", 2, 0, null, "ended");

  await c.query(`insert into inventory_counts (id, department, status, started_by, started_at, completed_by, completed_at)
                 values ($1, 'Chemistry', 'completed', 'tester', '2026-09-15T08:00:00Z', 'tester', '2026-09-15T09:00:00Z')`, [IDS.count]);
  const line = (id, reagent, name, lot_number, unit, expected, counted, resolved, details) =>
    c.query(`insert into inventory_count_items (id, count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity, resolved, resolution_note, counted_at, counted_by, resolved_at, resolved_by, resolution_details)
             values ($1, $2, $3, $4, $5, 'Chemistry', $6, $7, $8, $9, $10, '2026-09-15T08:30:00Z', 'tester', ${resolved ? "'2026-09-15T08:45:00Z'" : "null"}, ${resolved ? "'tester'" : "null"}, $11)`,
      [id, IDS.count, reagent, name, lot_number, unit, expected, counted, resolved, resolved ? "corrected" : null, details ? JSON.stringify(details) : null]);
  await line(IDS.linePHist, IDS.pHist, "Analyte P", "TP-200", "Piece ", 15, 15, false, null);
  await line(IDS.lineBoth, IDS.both, "Reagent C", "TC-006", "bottle", 9, 8, true, { v: 1, method: "single_date", discrepancy: 1 });

  const log = (reagent, amount, date, used_by, provenance, extra = {}) =>
    c.query("insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, deleted, date_provenance, source_count_item_id) values ($1, $2, $3, $4, '', false, false, $5, $6)",
      [reagent, amount, date, used_by, provenance, extra.source ?? null]);
  await log(IDS.logsOnly, 1, "2026-09-20", "tester", "manual");
  await log(IDS.both, 3, "2026-09-10", "tester", "manual");
  await log(IDS.both, 1, "2026-09-15", "Unlogged (physical count)", "count_redated", { source: IDS.lineBoth });
  await log(IDS.ended, 2, "2026-08-30", "tester", "manual");

  await c.query("insert into audit_log (action, entity, description, performed_by) values ('add', 'reagent', 'seed', 'tester'), ('edit', 'reagent', 'seed', 'tester')");
  await c.query("set session_replication_role = origin");
}
