// U2b — unit-safe aggregation and forecast evidence (forecast.js), on the synthetic
// inventory. The original review suite also compared every group against the
// pre-U2b code over a Production snapshot; that one-off comparison is not ported
// (it needs the snapshot and old commits). What it protected is asserted here as
// rules: different units are never added, nothing is dropped, evidence is shared.
import { suite, check, load, src, appPlugin } from "../helpers/core.mjs";
import { STUB_SUPABASE } from "../helpers/dom.mjs";
import { buildInventory, CORRECTION_USER } from "../fixtures/inventory.mjs";

suite("U2b · unit-safe aggregation and evidence (forecast.js)", async () => {

const F = await load("forecast.js");
const A = await load({ contents: `export * from "${src("App.jsx")}";` }, { plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["compareLots", "daysBetween", "hasInspectionIssue", "isExpiringSoonItem", "groupQtyView", "lotQtyView"] })] });
const envFor = (today, snoozes = []) => ({ snoozes, warnDays: 30, today, compareLots: A.compareLots, daysBetween: A.daysBetween, hasInspectionIssue: A.hasInspectionIssue, isExpiringSoonItem: A.isExpiringSoonItem });

const { reagents: R, logs: L, today } = buildInventory();
const R0 = JSON.stringify(R), L0 = JSON.stringify(L);
const groups = F.buildGroups(R, L, envFor(today));
const G = Object.fromEntries(groups.map((g) => [g.name, g]));
const part = (g, k) => g.parts.find((p) => p.key === k);

// ── Mixed units are never added together ──
const P = G["Analyte P"];
check("mixed group: no group total, two parts (box 1, piece 15)", [P.mixedUnits, P.totalQty, P.unit, P.dailyRate, P.parts.map((p) => [p.key, p.totalQty])], [true, null, null, null, [["box", 1], ["piece", 15]]]);
check("mixed group: never 16 anywhere in its view", JSON.stringify(A.groupQtyView(P)).includes("16"), false);
check("mixed group: quantity text", A.groupQtyView(P), { main: "1 box · 15 Piece", sub: "different units — not added together" });
check("mixed group: piece part has no forecast (no usage logged in Piece) — nothing invented", [part(P, "piece").predictedDaysLeft, part(P, "piece").recentUsed], [null, 0]);
const Q = G["Kit Q"], Lc = G["Reference L"];
check("one unit, 12 bottles summed, NO pack equivalent (box sizes 1 vs 6)", [Q.mixedUnits, Q.totalQty, Q.parts[0].pack, A.groupQtyView(Q)], [false, 12, null, { main: "12 bottle", sub: null }]);
check("one unit, 18 bottles, shared box size 8 → neutral pack equivalent", [Lc.totalQty, Lc.parts[0].pack?.perBox, Lc.parts[0].pack?.verified, A.groupQtyView(Lc)], [18, 8, false, { main: "18 bottle", sub: "2 × 8-bottle packs + 2 bottles" }]);
check("lot with current above received: 10 bottles = 1 × 8-bottle pack + 2 (received 2 shown as stored)", [A.lotQtyView(R.find((r) => r.id === "l1")), R.find((r) => r.id === "l1").quantity_received], [{ main: "10 bottle", sub: "1 × 8-bottle pack + 2 bottles" }, 2]);
check("legacy packaging is never named as a box/carton (neutral 'N-unit pack' only)", groups.flatMap((g) => g.parts).map((p) => F.packEquivalentText(p.totalQty, p.pack, p.unit)).filter(Boolean).every((t) => /^\d+ × \d+-\S+ packs?( \+ .+)?$/.test(t) && !/carton|full box/i.test(t)), true);
check("stock in Piece only; recent box usage on an ended lot is kept as other-unit usage (not merged, not dropped)", [G["Analyte U"].mixedUnits, G["Analyte U"].parts.map((p) => p.key), G["Analyte U"].otherUnitUsage.map((o) => o.key)], [false, ["piece"], ["box"]]);

// ── Nothing dropped: per-unit usage + other-unit usage = all usage of the group's lots in the window ──
const windowStart = F.forecastWindowStart(today);
const lotById = Object.fromEntries(R.map((r) => [r.id, r]));
const independent = {};
for (const l of L) { const r = lotById[l.reagent_id]; if (!r || l.deleted || l.date < windowStart || l.date > today) continue; const k = F.groupKeyOf(r); independent[k] = (independent[k] || 0) + Number(l.amount); }
check("every group: per-unit usage (+ other-unit usage) adds up exactly to the usage recorded on its lots", groups.filter((g) => Math.abs(g.parts.reduce((s, p) => s + p.recentUsed, 0) + g.otherUnitUsage.reduce((s, x) => s + x.recentUsed, 0) - (independent[g.key] || 0)) > 1e-9).map((g) => g.key), []);
check("statusReasons().status equals group.status for every group", groups.filter((g) => F.statusReasons(g.items, 30, today, !!g.snoozedUntil, g.snoozedUntil).status !== g.status).map((g) => g.key), []);
check("usageBreakdown(unit).total equals each part's usage", groups.flatMap((g) => g.parts.filter((p) => Math.abs(F.usageBreakdown(g.key, R, L, today, p.key).total - p.recentUsed) > 1e-9).map((p) => `${g.key}/${p.key}`)), []);

// ── Synthetic edge cases (ported verbatim from the U2b suite) ──
const base = { device: "D", department: "X", expiry_date: "2027-01-01", date_added: "2026-01-01", deleted: false, low_stock_threshold: 2, quantity_received: 10 };
const lots = [
  { ...base, id: "a", name: "S", lot_number: "A", unit: "bottle", current_quantity: 9, units_per_carton: 6 },
  { ...base, id: "b", name: "S", lot_number: "B", unit: "Bottles ", current_quantity: 4, units_per_carton: 4 },
  { ...base, id: "c", name: "T", lot_number: "C", unit: "", current_quantity: 3, units_per_carton: null },
  { ...base, id: "d", name: "T", lot_number: "D", unit: "box", current_quantity: 2, units_per_carton: null },
  { ...base, id: "e", name: "U", lot_number: "E", unit: "vial", current_quantity: 13, units_per_carton: 6, pack_unit: "pack" },
];
const logs = [
  { id: "l1", reagent_id: "a", amount: 3, date: "2026-10-10", deleted: false },
  { id: "l2", reagent_id: "b", amount: 3, date: "2026-10-09", deleted: false },
  { id: "l3", reagent_id: "c", amount: 1, date: "2026-10-09", deleted: false },
  { id: "l4", reagent_id: "zz", amount: 5, date: "2026-10-09", deleted: false },
];
const sg = Object.fromEntries(F.buildGroups(lots, logs, envFor("2026-10-11")).map((g) => [g.key, g]));
check("mixed packaging factors, same base unit: 13 bottles summed, no shared pack", [sg["S::D"].mixedUnits, sg["S::D"].totalQty, sg["S::D"].parts[0].pack, sg["S::D"].recentUsed], [false, 13, null, 6]);
check("blank unit → its own 'unit not recorded' part, never merged into box", [sg["T::D"].mixedUnits, sg["T::D"].parts.map((p) => [p.key, p.unit, p.totalQty, p.recentUsed])], [true, [["", "(unit not recorded)", 3, 1], ["box", "box", 2, 0]]]);
check("saved pack label (lot setting) is named: '2 packs + 1 vial'", F.packEquivalentText(13, sg["U::D"].parts[0].pack, "vial"), "2 packs + 1 vial");
check("pack text omitted below one full pack and for box size 1", [F.packEquivalentText(5, { perBox: 6, packUnit: { singular: "box", plural: "boxes" }, verified: false }, "bottle"), F.packEquivalentText(6, { perBox: 1, verified: false }, "bottle")], [null, null]);
check("pack equivalent is presentation only: totals and rates don't change with it", [sg["U::D"].totalQty, sg["U::D"].dailyRate], [13, 0]);
check("orphan log (lot no longer on record) can't be placed in a group — not added to any unit", F.recentUsageByGroupUnit(lots, logs, "2026-10-11"), { "S::D": { bottle: 6 }, "T::D": { "": 1 } });
const mixedLow = F.buildGroups([{ ...base, id: "m1", name: "M", lot_number: "1", unit: "box", current_quantity: 1, low_stock_threshold: 2 }, { ...base, id: "m2", name: "M", lot_number: "2", unit: "piece", current_quantity: 15, low_stock_threshold: 2 }], [], envFor("2026-10-11"))[0];
check("mixed group: low stock judged per unit (box 1 ≤ 2 → low) — a sum of 16 would have hidden it", [mixedLow.lowStockRaw, mixedLow.status, mixedLow.parts.map((p) => p.lowStockRaw)], [true, "yellow", [true, false]]);
check("mixed group: run-out ranking uses the earliest unit's forecast (forecastPart)", (() => { const g = F.buildGroups([{ ...base, id: "r1", name: "Q", lot_number: "1", unit: "box", current_quantity: 2 }, { ...base, id: "r2", name: "Q", lot_number: "2", unit: "piece", current_quantity: 30 }], [{ reagent_id: "r1", amount: 3, date: "2026-10-01", deleted: false }, { reagent_id: "r2", amount: 3, date: "2026-10-01", deleted: false }], envFor("2026-10-11"))[0]; return [g.predictedDaysLeft, g.forecastPart.key]; })(), [20, "box"]);
check("ZZ mixed: box runs out first (10 days), Piece 900 days; group ranked by box", [G["ZZ mixed"].mixedUnits, G["ZZ mixed"].predictedDaysLeft, G["ZZ mixed"].forecastPart.key, G["ZZ mixed"].parts.map((p) => p.predictedDaysLeft)], [true, 10, "box", [10, 900]]);

// ── Low evidence: one classification, shared by every screen ──
check("each part's evidence = usageEvidence for that unit (computed once in buildGroups)", groups.flatMap((g) => g.parts.filter((p) => JSON.stringify(p.evidence) !== JSON.stringify(F.usageEvidence(g.key, R, L, today, p.key))).map((p) => `${g.key}/${p.key}`)), []);
check("lowEvidence ⇔ a forecast exists AND evidence is corrections-only or a single log", groups.flatMap((g) => g.parts.filter((p) => p.lowEvidence !== (p.predictedDaysLeft !== null && ["corrections_only", "single_log"].includes(p.evidence.category))).map((p) => `${g.key}/${p.key}`)), []);
check("evidence categories: corrections-only, single log, multiple logs", [part(G["XX corr"], "box").evidence.category, part(G["ZZ mixed"], "box").evidence.category, part(G["YY normal"], "bottle").evidence.category, part(G["Analyte N"], "piece").evidence.category], ["corrections_only", "single_log", "multiple_logs", "corrections_only"]);
check("low-evidence flags: XX and ZZ flagged, YY not", [part(G["XX corr"], "box").lowEvidence, part(G["ZZ mixed"], "box").lowEvidence, part(G["YY normal"], "bottle").lowEvidence], [true, true, false]);
check("isLowEvidence / lowEvidenceLabel", [F.isLowEvidence({ category: "corrections_only" }), F.isLowEvidence({ category: "single_log" }), F.isLowEvidence({ category: "multiple_logs" }), F.isLowEvidence({ category: "none" }), F.isLowEvidence(null), F.lowEvidenceLabel({ category: "corrections_only" }), F.lowEvidenceLabel({ category: "single_log" }), F.lowEvidenceLabel({ category: "multiple_logs" })], [true, true, false, false, false, "Low evidence: based only on stock-count corrections", "Low evidence: based on a single usage log", null]);
check("stock-count corrections are recognised by the reserved user name", [F.isStockCountCorrection({ used_by: CORRECTION_USER }), F.isStockCountCorrection({ used_by: "tester" })], [true, false]);

// ── Reorder per part ──
check("reorder suggestion is per part, in that part's unit", (() => { const z = part(G["ZZ mixed"], "box"); return F.reorderSuggestion(z.dailyRate, z.totalQty, 30).suggestedQty > 0; })(), true);
check("fixtures were not mutated by any call", [JSON.stringify(R) === R0, JSON.stringify(L) === L0], [true, true]);
}, { expectedChecks: 29 });
