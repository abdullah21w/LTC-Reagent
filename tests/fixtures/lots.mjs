// Synthetic Lot rows (no Production data, no real reagent names or Lot numbers).
// Each one reproduces a SHAPE seen in real inventories, so the rules are tested
// against realistic cases:
//   mixed units in one group, different box sizes in one group, current above
//   received (a stored value that must never be "repaired"), a lot whose base
//   unit is itself a box inside an outer carton, stray spaces and case in units.
const base = { department: "Chemistry", device: "Analyzer 1", item_type: "Reagent", expiry_date: "2027-06-30", date_added: "2026-01-15", deleted: false, low_stock_threshold: 1, pack_unit: null };
const lot = (id, name, lot_number, unit, quantity_received, current_quantity, units_per_carton = null, extra = {}) =>
  ({ ...base, id, name, lot_number, unit, quantity_received, current_quantity, units_per_carton, ...extra });

export const LOTS = {
  // "Analyte P": one lot counted in plain boxes, one in pieces packed 3 per box
  pBox: lot("p-box", "Analyte P", "TP-100", "box", 3, 1),
  pPiece: lot("p-pc", "Analyte P", "TP-200", "Piece ", 15, 15, 3),
  // "Analyte M": the same shape, 2 boxes + 10 pieces packed 2 per box
  mBox: lot("m-box", "Analyte M", "TM-100", "BOX", 3, 2),
  mPiece: lot("m-pc", "Analyte M", "TM-200", "pieces", 10, 10, 2),
  // "Kit Q": same unit (bottle), different box sizes (1 and 6)
  q1: lot("q-1", "Kit Q", "TQ-101", "bottle", 6, 6, 1),
  q6: lot("q-6", "Kit Q", "TQ-106", "bottle", 6, 6, 6),
  // "Reference L": two bottle lots sharing a box size of 8; one shows current > received
  l1: lot("l-1", "Reference L", "TL-001", "bottle ", 2, 10, 8),
  l2: lot("l-2", "Reference L", "TL-002", "Bottle", 8, 8, 8),
  // "Reagent C": 9 bottles at 6 per box
  c6: lot("c-6", "Reagent C", "TC-006", "bottle ", 12, 9, 6),
  // "Paper S": base unit is a box; 5 boxes come in an outer pack (never "1 box = 5 boxes")
  s5: lot("s-5", "Paper S", "TS-005", "box", 5, 5, 5, { department: "Admin", device: "" }),
  // un-packaged lots in assorted spellings
  plain1: lot("x-1", "Buffer X", "TX-001", "bags ", 4, 3),
  plain2: lot("x-2", "Tips Y", "TY-001", "rolls", 2, 2),
  plain3: lot("x-3", "Gas Z", "TZ-001", "cylinder", 1, 1),
};
export const ALL_LOTS = Object.values(LOTS);

// Unit spellings of the kind staff actually type (case, plural, trailing spaces).
export const UNIT_SPELLINGS = ["box", "Box", "BOX", "cylinder", "bottle", "BOTTLE", "Bottle", "bottle ", "pieces", "bag", "BAGS", "pieces ", "bags ", "bags", "rolls", "Piece ", "Bottle ", "PIECES"];
