// A small synthetic inventory (Lots + usage logs) for forecast and screen tests.
// No Production data: names, Lot numbers and people are invented. Dates are
// relative to `today`, so forecasts and windows are stable whenever tests run.
import { daysAgo } from "../helpers/core.mjs";

export const CORRECTION_USER = "Unlogged (physical count)"; // reserved name used by Stock Count corrections

export function buildInventory(today = new Date().toISOString().slice(0, 10)) {
  const d = (n) => daysAgo(n, today);
  const base = { department: "Chemistry", device: "Analyzer 1", item_type: "Reagent", expiry_date: "2028-06-30", date_added: d(120), deleted: false, low_stock_threshold: 1, pack_unit: null, units_per_carton: null, active_on_device: false, intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, receiving_notes: "", inspection_notes: "", added_by: "tester" };
  const L = (id, name, lot_number, unit, quantity_received, current_quantity, extra = {}) => ({ ...base, id, name, lot_number, unit, quantity_received, current_quantity, ...extra });
  const reagents = [
    // Analyte P — stock in two units (1 box + 15 Piece packed 3 per box); box usage only
    L("p1", "Analyte P", "TP-100", "box", 3, 1),
    L("p2", "Analyte P", "TP-200", "Piece ", 15, 15, { units_per_carton: 3 }),
    // Analyte U — stock in Piece; an ended box lot also had usage recently
    L("u1", "Analyte U", "TU-100", "box", 2, 0, { deleted: true, deleted_by: "tester", deleted_at: `${d(20)}T10:00:00Z` }),
    L("u2", "Analyte U", "TU-200", "Piece", 40, 27),
    // Analyte N — stock in Piece; usage only from a stock-count correction; one box used on an ended lot
    L("n1", "Analyte N", "TN-100", "box", 1, 0, { deleted: true, deleted_by: "tester", deleted_at: `${d(10)}T10:00:00Z` }),
    L("n2", "Analyte N", "TN-200", "Piece", 30, 18),
    // Kit Q — bottles at different box sizes (1 and 6); an ended lot in boxes
    L("q0", "Kit Q", "TQ-100", "box", 2, 0, { deleted: true, deleted_by: "tester", deleted_at: `${d(60)}T10:00:00Z` }),
    L("q1", "Kit Q", "TQ-101", "bottle", 6, 6, { units_per_carton: 1 }),
    L("q2", "Kit Q", "TQ-106", "bottle", 6, 6, { units_per_carton: 6 }),
    // Reference L — bottles sharing a box size of 8; one shows current above received (kept as stored)
    L("l0", "Reference L", "TL-000", "box", 1, 0, { device: "Analyzer 2", deleted: true, deleted_by: "tester", deleted_at: `${d(70)}T10:00:00Z` }),
    L("l1", "Reference L", "TL-001", "bottle ", 2, 10, { device: "Analyzer 2", units_per_carton: 8 }),
    L("l2", "Reference L", "TL-002", "bottle", 8, 8, { device: "Analyzer 2", units_per_carton: 8 }),
    // Enzyme A — one unit only
    L("a1", "Enzyme A", "TA-147", "box", 3, 2, { device: "", low_stock_threshold: 2 }),
    // Evidence cases, all running out within 14 days:
    //   YY normal — 3 normal usage logs (normal evidence, no warning)
    //   XX corr   — 2 stock-count corrections only (low evidence)
    //   ZZ mixed  — one log per unit (single log → low evidence on the box part)
    L("zz1", "ZZ mixed", "Z1", "box", 5, 1, { device: "", low_stock_threshold: 0, date_added: d(40) }),
    L("zz2", "ZZ mixed", "Z2", "Piece", 30, 30, { device: "", low_stock_threshold: 0, date_added: d(40), units_per_carton: 10 }),
    L("yy1", "YY normal", "Y1", "bottle", 10, 2, { device: "", low_stock_threshold: 0, date_added: d(40) }),
    L("xx1", "XX corr", "X1", "box", 5, 1, { device: "", low_stock_threshold: 0, date_added: d(40) }),
  ];
  const log = (id, reagent_id, amount, daysBack, used_by = "tester") => ({ id, reagent_id, amount, date: d(daysBack), used_by, deleted: false, note: "", tested_by_qc: false });
  const logs = [
    log("pl1", "p1", 1, 5), log("pl2", "p1", 1, 12),
    log("ul1", "u1", 1, 21), log("ul2", "u2", 5, 4), log("ul3", "u2", 4, 11), log("ul4", "u2", 4, 18),
    log("nl1", "n1", 1, 15), log("nl2", "n2", 12, 6, CORRECTION_USER),
    log("ql1", "q0", 2, 61),
    log("ll1", "l0", 1, 71),
    log("al1", "a1", 1, 9),
    log("zl1", "zz1", 3, 5), log("zl2", "zz2", 1, 5),
    log("yl1", "yy1", 2, 3), log("yl2", "yy1", 2, 10), log("yl3", "yy1", 2, 20),
    log("xl1", "xx1", 1.5, 4, CORRECTION_USER), log("xl2", "xx1", 1.5, 11, CORRECTION_USER),
  ];
  return { reagents, logs, today, d };
}
