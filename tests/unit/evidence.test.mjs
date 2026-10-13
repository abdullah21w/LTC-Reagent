// Batch E — reconciliationEvidence.js (classification, discrepancy, allocation, validator).
// Ported from the Batch E review suite unchanged (it was already synthetic); runs in the
// lab's time zone like the browser.
process.env.TZ = "Asia/Riyadh";
import { suite, check, load } from "../helpers/core.mjs";

suite("Batch E · reconciliation evidence rules (reconciliationEvidence.js)", async () => {
const E = await load("reconciliationEvidence.js");
const CU = "Unlogged (physical count)";
const pick = (c) => [c.classification, c.isManual, c.isCountDerived, c.quantityEvidence, c.timingEvidence, c.linked, c.consistent];

// ── classifyLog: all seven values ──
const L = (p, extra = {}) => ({ id: "x", date_provenance: p, used_by: p && p.startsWith("manual") ? "staff-1" : CU, source_count_item_id: p && !p.startsWith("manual") ? "line" : null, amount: 1, date: "2026-10-01", deleted: false, ...extra });
check("manual → manual_direct / direct quantity / direct timing", pick(E.classifyLog(L("manual"))), ["manual_direct", true, false, "direct", "direct", false, true]);
check("manual_spread → manual_distributed / direct quantity / distributed timing", pick(E.classifyLog(L("manual_spread"))), ["manual_distributed", true, false, "direct", "distributed", false, true]);
check("count_exact → count_exact / physical / explicit", pick(E.classifyLog(L("count_exact"))), ["count_exact", false, true, "physical_count_derived", "explicit", true, true]);
check("count_exact_default → count_default / physical / default_assumption", pick(E.classifyLog(L("count_exact_default"))), ["count_default", false, true, "physical_count_derived", "default_assumption", true, true]);
check("count_spread_window → count_distributed / physical / distributed", pick(E.classifyLog(L("count_spread_window"))), ["count_distributed", false, true, "physical_count_derived", "distributed", true, true]);
check("count_redated → count_redated / physical / redated", pick(E.classifyLog(L("count_redated"))), ["count_redated", false, true, "physical_count_derived", "redated", true, true]);
check("historical_unknown → count_historical_unknown / physical / historical_unknown", pick(E.classifyLog(L("historical_unknown", { source_count_item_id: null }))), ["count_historical_unknown", false, true, "physical_count_derived", "historical_unknown", false, true]);
check("timing never confused: historical_unknown, count_spread_window, manual_spread are not direct/explicit", ["historical_unknown", "count_spread_window", "manual_spread", "count_exact_default", "count_redated"].map((p) => ["direct", "explicit"].includes(E.classifyLog(L(p)).timingEvidence)), [false, false, false, false, false]);
check("quantity of a count correction stays physical_count_derived even when timing is unknown", E.classifyLog(L("historical_unknown")).quantityEvidence, "physical_count_derived");
check("no provenance: manual row → unclassified, direct quantity", pick(E.classifyLog(L(null, { used_by: "staff-1" }))), ["unclassified", true, false, "direct", "unclassified", false, true]);
check("no provenance: legacy correction → unclassified, physical quantity", pick(E.classifyLog(L(null, { used_by: CU }))), ["unclassified", false, true, "physical_count_derived", "unclassified", false, true]);
check("invalid provenance → invalid, quantity unknown", pick(E.classifyLog(L("spread", { used_by: "staff-1", source_count_item_id: null }))), ["invalid", true, false, "unknown", "unclassified", false, true]);
check("manual provenance on a correction user → inconsistent", E.classifyLog(L("manual", { used_by: CU })).consistent, false);
check("manual provenance with a count link → inconsistent", E.classifyLog(L("manual", { source_count_item_id: "line" })).consistent, false);
check("count provenance on a normal unlinked log → inconsistent", E.classifyLog(L("count_exact", { used_by: "staff-1", source_count_item_id: null })).consistent, false);
check("all 7 PROVENANCE entries present", Object.keys(E.PROVENANCE), ["manual", "manual_spread", "count_exact", "count_exact_default", "count_spread_window", "count_redated", "historical_unknown"]);

// ── countLineDiscrepancy: from expected / counted only ──
const D = (e, c) => { const d = E.countLineDiscrepancy({ expected_quantity: e, counted_quantity: c }); return [d.kind, d.difference, d.shortage, d.surplus]; };
check("shortage: counted 3 of 5 → difference −2, shortage 2", D(5, 3), ["shortage", -2, 2, 0]);
check("surplus: counted 3 of 2 → +1", D(2, 3), ["surplus", 1, 0, 1]);
check("zero discrepancy", D(4, 4), ["match", 0, 0, 0]);
check("uncounted", D(4, null), ["uncounted", null, 0, 0]);
check("decimals exact (5 − 4.93 = 0.07, numeric strings accepted)", D("5", "4.93"), ["shortage", -0.07, 0.07, 0]);

// ── lineAllocation: physical shortage stays authoritative ──
const usage = (e, c) => ({ id: "line", expected_quantity: e, counted_quantity: c, resolved: true, resolution_note: "Logged as usage on 2026-09-16" });
const rows = (...a) => a.map((amount, i) => ({ id: `r${i}`, amount, deleted: false }));
const A = (line, logs) => { const a = E.lineAllocation(line, logs); return [a.physicalShortage, a.allocationTotal, a.allocationMismatch, a.status]; };
check("duplicate corrections: shortage 1, two corrections of 1 → allocation 2, mismatch +1, 'excess' (physical shortage still 1)", A(usage(1, 0), rows(1, 1)), [1, 2, 1, "excess"]);
check("matching allocation", A(usage(5, 3), rows(1, 1)), [2, 2, 0, "matches"]);
check("short allocation", A(usage(5, 2), rows(1, 1)), [3, 2, -1, "short"]);
check("usage line with no allocation", A(usage(5, 3), []), [2, 0, -2, "none"]);
check("undone correction rows are not part of the allocation", (() => { const a = E.lineAllocation(usage(5, 3), [...rows(2), { id: "u", amount: 2, deleted: true }]); return [a.allocationTotal, a.undoneTotal, a.status]; })(), [2, 2, "matches"]);
check("corrected line: no allocation expected", A({ ...usage(5, 3), resolution_note: "Corrected to match count" }, []), [2, 0, null, "not_applicable"]);
check("corrected line with linked logs → unexpected_allocation", A({ ...usage(5, 3), resolution_note: "Corrected to match count" }, rows(2)), [2, 2, null, "unexpected_allocation"]);
check("surplus line resolved: no shortage, nothing to allocate", A({ ...usage(2, 3), resolution_note: "Corrected to match count" }, []), [0, 0, null, "not_applicable"]);

// ── lineEvidence: era only when it can be decided ──
const line0 = { counted_quantity: 3, resolved: true };
check("no evidenceSince → era undetermined", E.lineEvidence(line0, { started_at: "2026-09-16T13:00:00Z" }).era, "undetermined");
check("count before evidenceSince → historical; after → evidence_era", [E.lineEvidence(line0, { started_at: "2026-09-16T13:00:00Z" }, { evidenceSince: "2026-10-10T00:00:00Z" }).era, E.lineEvidence(line0, { started_at: "2026-10-11T08:00:00Z" }, { evidenceSince: "2026-10-10T00:00:00Z" }).era], ["historical", "evidence_era"]);

// ── validateEvidence ──
const lot = { id: "lotA", name: "Alpha", lot_number: "A1", date_added: "2026-07-01" };
const prevCount = { id: "c0", status: "completed", started_at: "2026-09-01T08:00:00Z", completed_at: "2026-09-01T09:00:00Z" };
const newCount = { id: "c1", status: "completed", started_at: "2026-10-12T08:00:00Z", completed_at: "2026-10-12T10:00:00Z" };
const SINCE = "2026-10-10T00:00:00Z";
const complete = { id: "L1", count_id: "c1", reagent_id: "lotA", reagent_name: "Alpha", lot_number: "A1", expected_quantity: 5, counted_quantity: 3, resolved: true, resolution_note: "Logged as usage spread from 2026-09-01 to 2026-10-12", counted_at: "2026-10-12T08:30:00Z", counted_by: "staff-1", resolved_at: "2026-10-12T09:00:00Z", resolved_by: "staff-1", resolution_details: { v: 1 } };
const prevLine = { id: "L0", count_id: "c0", reagent_id: "lotA", reagent_name: "Alpha", lot_number: "A1", expected_quantity: 5, counted_quantity: 5, resolved: false, counted_at: "2026-09-01T08:30:00Z", counted_by: "staff-1" };
const newRows = [{ id: "n1", reagent_id: "lotA", amount: 1, date: "2026-09-01", used_by: CU, date_provenance: "count_spread_window", source_count_item_id: "L1", deleted: false, created_at: "2026-10-12T09:00:00Z" }, { id: "n2", reagent_id: "lotA", amount: 1, date: "2026-09-08", used_by: CU, date_provenance: "count_spread_window", source_count_item_id: "L1", deleted: false, created_at: "2026-10-12T09:00:00Z" }];
const manualNew = { id: "m1", reagent_id: "lotA", amount: 1, date: "2026-10-11", used_by: "staff-1", date_provenance: "manual", source_count_item_id: null, deleted: false, created_at: "2026-10-11T09:00:00Z" };
const base = { reagents: [lot], counts: [prevCount, newCount], items: [prevLine, complete], logs: [...newRows, manualNew] };
const V = (data) => E.validateEvidence(data, { evidenceSince: SINCE });
check("complete new-style evidence → no findings at all → READY", [V(base).findings, E.readinessStatus([{ ok: true }], V(base))], [[], "READY"]);
const codes = (data) => V(data).findings.map((f) => `${f.severity}:${f.code}`).sort();
check("new count_exact row without link → error", codes({ ...base, logs: [...base.logs, { ...newRows[0], id: "x", date_provenance: "count_exact", source_count_item_id: null }] }).filter((c) => c.includes("unlinked")), ["error:count_log_unlinked"]);
check("manual log with a count link → error", codes({ ...base, logs: [{ ...manualNew, source_count_item_id: "L1" }, ...newRows] }).filter((c) => c.startsWith("error")), ["error:allocation_excess", "error:manual_log_with_source"] /* the linked manual row also inflates L1's allocation */);
check("manual provenance on correction user → error", codes({ ...base, logs: [{ ...newRows[0], date_provenance: "manual" }, newRows[1]] }).filter((c) => c.startsWith("error")), ["error:manual_provenance_on_correction"]);
check("count provenance on a normal log → error", codes({ ...base, logs: [...base.logs, { ...manualNew, id: "y", date_provenance: "count_redated" }] }).filter((c) => c.startsWith("error")), ["error:count_provenance_on_manual_log"]);
check("invalid provenance → error", codes({ ...base, logs: [...base.logs, { ...manualNew, id: "z", date_provenance: "spread" }] }).filter((c) => c.startsWith("error")), ["error:invalid_provenance"]);
check("link to a line of another lot → error", codes({ ...base, reagents: [lot, { ...lot, id: "lotB" }], logs: [{ ...newRows[0], reagent_id: "lotB" }, newRows[1], manualNew] }).filter((c) => c.includes("mismatch")), ["error:link_lot_mismatch"]);
check("new row dated before received / outside window → errors (evidence era)", codes({ ...base, logs: [{ ...newRows[0], date: "2026-06-20" }, newRows[1], manualNew] }).filter((c) => /date_/.test(c)), ["error:date_before_received", "error:date_outside_count_window"]);
check("new line resolved without resolution_details/resolved_at → error", codes({ ...base, items: [prevLine, { ...complete, resolution_details: null, resolved_at: null }] }).filter((c) => c.includes("metadata")), ["error:line_metadata_missing"]);
check("new log without provenance (old client after rollout) → error", codes({ ...base, logs: [...base.logs, { ...manualNew, id: "w", date_provenance: null }] }).filter((c) => c.includes("unclassified")), ["error:unclassified_provenance"]);
// historical era: same facts are warnings / limitations, and never block
const histLine = { ...complete, id: "H1", count_id: "c0h", counted_at: null, counted_by: null, resolved_at: null, resolved_by: null, resolution_details: null, expected_quantity: 1, counted_quantity: 0, resolution_note: "Logged as usage on 2026-09-16" };
const histCount = { id: "c0h", status: "completed", started_at: "2026-09-16T13:00:00Z", completed_at: "2026-09-16T14:00:00Z" };
const dupRows = ["k1", "k2"].map((id) => ({ id, reagent_id: "lotA", amount: 1, date: "2026-09-16", used_by: CU, date_provenance: "historical_unknown", source_count_item_id: "H1", deleted: false, created_at: "2026-09-16T13:49:00Z" }));
const hist = { reagents: [lot], counts: [prevCount, histCount], items: [prevLine, histLine], logs: [...dupRows, { ...dupRows[0], id: "k3", date: "2026-06-01", date_provenance: "count_redated" }] };
const hv = V(hist);
check("historical duplicate-correction line: allocation_excess warning (physical 1, allocation 3 incl. a re-dated row) surfaced", hv.findings.filter((f) => f.code === "allocation_excess").map((f) => [f.severity, f.physical_shortage, f.allocation_total]), [["warning", 1, 3]]);
check("historical: pre-received date + missing metadata + unknown timing are warnings / limitations, no errors", [hv.summary.error, codes(hist).filter((c) => !c.startsWith("warning:allocation")).sort()], [0, ["expected_historical_limitation:historical_line_metadata_missing", "expected_historical_limitation:historical_unknown_timing", "expected_historical_limitation:historical_unknown_timing", "warning:date_before_received", "warning:date_outside_count_window"]]);
check("historical warnings never block: READY_WITH_HISTORICAL_WARNINGS", E.readinessStatus([{ ok: true }], hv), "READY_WITH_HISTORICAL_WARNINGS");
check("a failed check blocks", E.readinessStatus([{ ok: false }], V(base)), "BLOCKED");
check("missing metadata with no evidenceSince is a warning, not assumed historical", E.validateEvidence(hist).findings.filter((f) => f.code.includes("metadata")).map((f) => `${f.severity}:${f.code}`), ["warning:line_metadata_missing"]);
check("usage line with no linked rows → warning (historical) / error (new)", [V({ ...hist, logs: [] }).findings.filter((f) => f.code === "usage_line_without_allocation").map((f) => f.severity), V({ ...base, logs: [manualNew] }).findings.filter((f) => f.code === "usage_line_without_allocation").map((f) => f.severity)], [["warning"], ["error"]]);
check("dates given as Date objects (some drivers) are compared as calendar days, same result as text", (() => {
  const asDates = { ...hist, reagents: [{ ...lot, date_added: new Date(2026, 6, 1) }], logs: hist.logs.map((l) => ({ ...l, date: new Date(`${l.date}T00:00:00`) })) };
  return codes(asDates).filter((c) => c.includes("date_")).sort();
})(), codes(hist).filter((c) => c.includes("date_")).sort());
check("validator never mutates its input", (() => { const d = JSON.parse(JSON.stringify(hist)); E.validateEvidence(d, { evidenceSince: SINCE }); return JSON.stringify(d) === JSON.stringify(hist); })(), true);
}, { expectedChecks: 49 });
