// What evidence do we actually have for a lot / Stock Count line, and how much
// can each part be trusted? Read-only interpretation of stored rows — nothing
// here writes, repairs or predicts anything.
//
// Two separate questions, never merged into one score:
//   quantity evidence  how the AMOUNT is known
//     direct                  logged by hand as used
//     physical_count_derived  a shortage found by a physical count
//     unknown                 the row's own provenance is invalid
//   timing evidence    how the DATE is known
//     direct              logged by hand on its usage date
//     explicit            a count correction dated on a day the user picked
//     default_assumption  a count correction left on the count's start day
//     distributed         spread weekly over a range / window (estimated)
//     redated             a count correction re-dated later (Edit dates)
//     historical_unknown  older correction; how its date was chosen is lost
//     unclassified        no provenance recorded (yet)
//
// A count line's physical discrepancy comes ONLY from its expected and counted
// quantities. Correction logs are the allocation (timing) of that shortage;
// their total never redefines it (e.g. kit3 / 0314: shortage 1, logs total 2).
//
// Dates use the lab's local calendar days (countBounds.js): run it with the
// lab's time zone (Asia/Riyadh), as the browser does.
import { isCountDerivedLog } from "./countEvidence";
import { STOCK_COUNT_CORRECTION_USER } from "./forecast";
import { previousCompletedCounts, usageInterval, localDay } from "./countBounds";

// A calendar date as "YYYY-MM-DD" whether it arrives as text (Supabase) or as a
// Date (some drivers): never compare a Date object with a date string.
const dayOf = (v) => (v == null ? null : v instanceof Date ? localDay(v) : String(v).slice(0, 10));

// The seven provenance values and what each one means (frozen semantics).
export const PROVENANCE = Object.freeze({
  manual: { classification: "manual_direct", kind: "manual", quantityEvidence: "direct", timingEvidence: "direct" },
  manual_spread: { classification: "manual_distributed", kind: "manual", quantityEvidence: "direct", timingEvidence: "distributed" },
  count_exact: { classification: "count_exact", kind: "count", quantityEvidence: "physical_count_derived", timingEvidence: "explicit" },
  count_exact_default: { classification: "count_default", kind: "count", quantityEvidence: "physical_count_derived", timingEvidence: "default_assumption" },
  count_spread_window: { classification: "count_distributed", kind: "count", quantityEvidence: "physical_count_derived", timingEvidence: "distributed" },
  count_redated: { classification: "count_redated", kind: "count", quantityEvidence: "physical_count_derived", timingEvidence: "redated" },
  historical_unknown: { classification: "count_historical_unknown", kind: "count", quantityEvidence: "physical_count_derived", timingEvidence: "historical_unknown" },
});
// Only the atomic Stock Count functions (and B1) ever wrote these.
const NEW_ONLY = new Set(["count_exact", "count_exact_default", "count_spread_window"]);

const n = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 1e6) / 1e6);

export function classifyLog(log) {
  const provenance = log.date_provenance ?? null;
  const meaning = provenance == null ? null : PROVENANCE[provenance] || null;
  const isCountDerived = isCountDerivedLog(log);
  return {
    id: log.id,
    provenance,
    known: !!meaning,
    classification: provenance == null ? "unclassified" : meaning ? meaning.classification : "invalid",
    isManual: !isCountDerived,
    isCountDerived,
    // what the row itself says vs what its user / link say
    consistent: !meaning || (meaning.kind === "count") === isCountDerived,
    quantityEvidence: meaning || provenance == null ? (isCountDerived ? "physical_count_derived" : "direct") : "unknown",
    timingEvidence: meaning ? meaning.timingEvidence : "unclassified",
    linked: log.source_count_item_id != null,
    sourceCountItemId: log.source_count_item_id ?? null,
    valid: !log.deleted,
  };
}

// The physical observation of one count line: counted − expected.
export function countLineDiscrepancy(line) {
  const expected = n(line.expected_quantity), counted = n(line.counted_quantity);
  if (counted == null) return { expected, counted, difference: null, kind: "uncounted", shortage: 0, surplus: 0 };
  const difference = n(counted - expected);
  return {
    expected, counted, difference,
    kind: difference < 0 ? "shortage" : difference > 0 ? "surplus" : "match",
    shortage: difference < 0 ? n(expected - counted) : 0,
    surplus: difference > 0 ? difference : 0,
  };
}

const RESOLUTION = (line) => (!line.resolved ? "unresolved"
  : (line.resolution_note || "").startsWith("Logged as usage") ? "usage"
  : line.resolution_note === "Corrected to match count" ? "corrected"
  : line.resolution_note === "Kept system value" ? "kept" : "other");

// How a line's physical shortage was allocated to correction logs. Only lines
// resolved as usage are expected to have an allocation (correcting or keeping
// the system value never creates logs).
export function lineAllocation(line, linkedLogs = []) {
  const d = countLineDiscrepancy(line);
  const valid = linkedLogs.filter((l) => !l.deleted), undone = linkedLogs.filter((l) => l.deleted);
  const allocationTotal = n(valid.reduce((s, l) => s + Number(l.amount), 0));
  const resolution = RESOLUTION(line);
  const expectsAllocation = resolution === "usage" && d.kind === "shortage";
  const allocationMismatch = expectsAllocation ? n(allocationTotal - d.shortage) : null;
  return {
    resolution,
    physicalShortage: d.shortage,           // authoritative quantity evidence
    allocationTotal,                        // what the correction logs say (valid rows)
    undoneTotal: n(undone.reduce((s, l) => s + Number(l.amount), 0)),
    rows: valid.length,
    allocationMismatch,
    status: !expectsAllocation ? (valid.length ? "unexpected_allocation" : "not_applicable")
      : valid.length === 0 ? "none"
      : allocationMismatch === 0 ? "matches"
      : allocationMismatch > 0 ? "excess" : "short",
  };
}

// Which evidence fields a line has, and whether it belongs to the era when the
// app records them (a count started at/after `evidenceSince`). Without that
// date the era can't be decided — missing fields are then not assumed historical.
export function lineEvidence(line, count, { evidenceSince } = {}) {
  const era = !evidenceSince || !count?.started_at ? "undetermined" : Date.parse(count.started_at) < Date.parse(evidenceSince) ? "historical" : "evidence_era";
  return {
    era,
    countedAt: line.counted_at != null, countedBy: line.counted_by != null,
    resolvedAt: line.resolved_at != null, resolvedBy: line.resolved_by != null,
    resolutionDetails: line.resolution_details != null,
  };
}

const logEra = (log, evidenceSince) => (!evidenceSince || !log.created_at ? "undetermined" : Date.parse(log.created_at) < Date.parse(evidenceSince) ? "historical" : "evidence_era");
const sev = (era, inEvidenceEra = "error", otherwise = "warning") => (era === "evidence_era" ? inEvidenceEra : otherwise);

// Read-only consistency report over stored rows. Returns findings, never fixes.
// Severities: error (unsafe / should not exist), warning (needs attention),
// expected_historical_limitation (known, accepted gaps in older history).
export function validateEvidence({ reagents = [], logs = [], counts = [], items = [] }, { evidenceSince } = {}) {
  const findings = [];
  const add = (severity, code, message, ref = {}) => findings.push({ severity, code, message, ...ref });
  const lotOf = Object.fromEntries(reagents.map((r) => [r.id, r]));
  const countOf = Object.fromEntries(counts.map((c) => [c.id, c]));
  const lineOf = Object.fromEntries(items.map((i) => [i.id, i]));
  const label = (l) => { const r = lotOf[l.reagent_id]; return r ? `${r.name} / ${r.lot_number}` : "unknown lot"; };
  const linesWithCounts = items.map((i) => ({ ...i, inventory_counts: countOf[i.count_id] || null }));

  for (const log of logs) {
    const c = classifyLog(log), era = logEra(log, evidenceSince), day = dayOf(log.date), ref = { log_id: log.id, lot: label(log), date: day };
    if (c.provenance != null && !c.known) add("error", "invalid_provenance", `Unknown date_provenance "${c.provenance}".`, ref);
    if (c.provenance == null) add(sev(era), "unclassified_provenance", "No date_provenance recorded.", ref);
    if (c.known && !c.consistent) {
      if (PROVENANCE[c.provenance].kind === "manual") add("error", log.used_by === STOCK_COUNT_CORRECTION_USER ? "manual_provenance_on_correction" : "manual_log_with_source", "Manual provenance on a Stock Count correction (correction user or count link).", ref);
      else add("error", "count_provenance_on_manual_log", "Stock Count provenance on a normal (non-correction, unlinked) log.", ref);
    }
    if (!c.isCountDerived) continue;
    if (c.provenance === "historical_unknown") add("expected_historical_limitation", "historical_unknown_timing", "Historical correction: how its date was chosen cannot be reconstructed.", ref);
    if (!c.linked) add(NEW_ONLY.has(c.provenance) ? "error" : sev(era), "count_log_unlinked", "Stock Count correction without source_count_item_id.", ref);
    const line = c.linked ? lineOf[c.sourceCountItemId] : null;
    if (c.linked && !line) { add("error", "link_to_missing_line", "source_count_item_id points to no count line.", ref); continue; }
    if (line && line.reagent_id !== log.reagent_id) add("error", "link_lot_mismatch", "Correction and its count line are for different lots.", { ...ref, line_id: line.id });
    if (line && RESOLUTION(line) !== "usage") add("error", "link_to_non_usage_line", "Correction linked to a line not resolved as usage.", { ...ref, line_id: line.id });
    const lot = lotOf[log.reagent_id];
    if (lot?.date_added && day < dayOf(lot.date_added)) add(sev(era), "date_before_received", `Dated ${day}, before the lot was received (${dayOf(lot.date_added)}).`, ref);
    if (line && lot) {
      const session = countOf[line.count_id];
      const iv = usageInterval({ lot, previousCompletedAt: previousCompletedCounts(linesWithCounts.filter((x) => x.reagent_id === lot.id), session)[lot.id], session });
      if (iv.ok && (day < iv.from || day > iv.to)) add(sev(era), "date_outside_count_window", `Dated ${day}, outside its count's window ${iv.from} – ${iv.to}.`, { ...ref, line_id: line.id });
    }
    if (log.deleted) add("warning", "undone_correction", "Correction row was undone (not part of its line's allocation).", ref);
  }

  for (const line of items) {
    const count = countOf[line.count_id], ev = lineEvidence(line, count, { evidenceSince });
    const ref = { line_id: line.id, lot: `${line.reagent_name} / ${line.lot_number}` };
    const linked = logs.filter((l) => l.source_count_item_id === line.id);
    const a = lineAllocation(line, linked), d = countLineDiscrepancy(line);
    if (line.resolved && d.kind === "uncounted") add("error", "resolved_without_count", "Resolved line has no counted quantity.", ref);
    if (a.status === "none") add(sev(ev.era), "usage_line_without_allocation", `Shortage ${a.physicalShortage} resolved as usage, but no linked correction rows.`, ref);
    if (a.status === "excess" || a.status === "short") add(sev(ev.era), a.status === "excess" ? "allocation_excess" : "allocation_short", `Physical shortage ${a.physicalShortage}; linked corrections total ${a.allocationTotal} (${a.allocationMismatch > 0 ? "+" : ""}${a.allocationMismatch}). The physical count is authoritative.`, { ...ref, physical_shortage: a.physicalShortage, allocation_total: a.allocationTotal, allocation_mismatch: a.allocationMismatch });
    if (a.status === "unexpected_allocation") add("error", "unexpected_allocation", `Correction rows linked to a line resolved as "${a.resolution}".`, ref);
    const missing = [line.counted_quantity != null && !ev.countedAt && "counted_at", line.counted_quantity != null && !ev.countedBy && "counted_by", line.resolved && !ev.resolvedAt && "resolved_at", line.resolved && !ev.resolvedBy && "resolved_by", line.resolved && !ev.resolutionDetails && "resolution_details"].filter(Boolean);
    if (missing.length) add(ev.era === "historical" ? "expected_historical_limitation" : sev(ev.era), ev.era === "historical" ? "historical_line_metadata_missing" : "line_metadata_missing", `Not recorded: ${missing.join(", ")}.`, { ...ref, missing });
  }
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const byCode = findings.reduce((m, f) => ((m[f.code] = (m[f.code] || 0) + 1), m), {});
  return { findings, byCode, summary: { error: count("error"), warning: count("warning"), expected_historical_limitation: count("expected_historical_limitation") } };
}

// READY only with no failed check, no error and no warning; historical warnings
// and limitations never block on their own.
export function readinessStatus(checks, validation) {
  if (checks.some((c) => !c.ok) || validation.summary.error > 0) return "BLOCKED";
  return validation.summary.warning > 0 || validation.summary.expected_historical_limitation > 0 ? "READY_WITH_HISTORICAL_WARNINGS" : "READY";
}
