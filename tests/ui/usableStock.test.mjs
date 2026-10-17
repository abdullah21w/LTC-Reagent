// Zero-quantity lots on the real screens (App.jsx, jsdom): DetailView, Dashboard,
// Reorder. The ERF and CRP shapes from Production: an empty lot is not "In stock",
// never USE FIRST, stays under All lots; ERF reads Stable; CRP reads Watch with
// the other unit named and nothing converted; the Piece reorder hint stays with a
// note. Database stubbed; nothing is written.
import { suite, check, load, src, appPlugin } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Zero-quantity lots · DetailView, Dashboard and Reorder", async () => {
const env = setupDom();
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { buildGroups, STOCK_COUNT_CORRECTION_USER } from "${src("forecast.js")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` },
  { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["compareLots", "daysBetween", "hasInspectionIssue", "isExpiringSoonItem", "todayISO", "DetailView", "Dashboard", "ReorderPage"] })] });
const U = ui(A, env.w);
const today = A.todayISO();
const shift = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let n = 0;
const lot = (o) => ({ id: `L${++n}`, department: "Chemistry", device: "VITROS", item_type: "Reagent", quantity_received: 5, current_quantity: 5, low_stock_threshold: 1, units_per_carton: null, pack_unit: null, date_added: shift(-90), deleted: false, active_on_device: false,
  intact_container: true, complete_compound: true, expiration_validity: true, lot_matches_kit: true, storage_condition_ok: true, ...o });
const L3470 = lot({ name: "ERF", lot_number: "L3470", unit: "BOX", quantity_received: 3, current_quantity: 0, expiry_date: shift(325), item_type: "Other" });
const A3826 = lot({ name: "ERF", lot_number: "A3826", unit: "BOX", quantity_received: 2, current_quantity: 2, expiry_date: shift(508), date_added: shift(-25) });
const P372 = lot({ name: "CRP", lot_number: "372399", unit: "Piece ", quantity_received: 25, current_quantity: 0, units_per_carton: 5, low_stock_threshold: 2, expiry_date: shift(-16) });
const B375 = lot({ name: "CRP", lot_number: "375113576768", unit: "box", quantity_received: 4, current_quantity: 4, low_stock_threshold: 2, expiry_date: shift(135), date_added: shift(-25) });
const R = [L3470, A3826, P372, B375];
const corr = (lotId, amount, d) => ({ id: `c${++n}`, reagent_id: lotId, amount, date: shift(d), used_by: A.STOCK_COUNT_CORRECTION_USER, deleted: false, date_provenance: "count_spread" });
const L = [...[-24, -17, -10, -3].map((d) => corr(L3470.id, 0.25, d)), ...[-24, -17, -10].map((d) => corr(P372.id, 1.5, d))];
const groups = A.buildGroups(R, L, { snoozes: [], warnDays: 30, today, compareLots: A.compareLots, daysBetween: A.daysBetween, hasInspectionIssue: A.hasInspectionIssue, isExpiringSoonItem: A.isExpiringSoonItem });
const G = Object.fromEntries(groups.map((g) => [g.name, g]));
const detail = (g) => A.createElement(A.DetailView, { group: g, logs: L.filter((l) => g.items.some((i) => i.id === l.reagent_id)), allReagents: R, allLogs: L, coverageDays: 15, can: () => true, warnDays: 30, onBack() {}, onEditReagent() {}, onDeleteReagent() {}, onDiscardReagent() {}, onEditLog() {}, onDeleteLog() {}, onSnooze() {}, onUnsnooze() {} });
const text = () => U.textOf(U.host);
const openHow = async () => { const b = [...U.host.querySelectorAll("button")].find((x) => /How these numbers are calculated/.test(x.textContent)); if (b) await U.click(b); };
const tab = (label) => [...U.host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent.startsWith(label));

// ── ERF ──
await U.mount(detail(G.ERF));
await openHow();
const inStockText = () => text().split("In stock (")[1] || "";
check("ERF detail: Stable; 'In stock (1)'; USE FIRST shown once, on A3826; L3470 not in the In stock list", [G.ERF.status, !!tab("In stock (1)"), (text().match(/USE FIRST/g) || []).length, /USE FIRST Lot A3826/.test(text()), /Lot L3470/.test(inStockText().split("All lots (")[1] || "")], ["green", true, 1, true, false]);
check("ERF detail: the reasons say L3470 is empty and not counted as stock — nothing says Critical", [/Lot L3470 is empty \(0 left\) — kept under All lots, not counted as stock/.test(text()), /→ Critical/.test(text()), /Across 1 lot in stock/.test(text()), /Status: Stable/.test(text())], [true, false, true, true]);
await U.click(tab("All lots"));
check("ERF detail: L3470 is still under All lots (record and history kept)", /L3470/.test(text()), true);
await U.unmount();

// ── CRP ──
await U.mount(detail(G.CRP));
await openHow();
check("CRP detail: Watch; the Piece unit is out with 4 box named, not converted, not added together", [G.CRP.status, /No Piece left — 4 box in stock in a different unit \(not converted, not added together\) → Watch/.test(text()), /\b4 Piece\b|\b20 Piece\b|\b0\.8 box\b/.test(text())], ["yellow", true, false]);
check("CRP detail: the Piece block says Watch (not Critical) and keeps the reorder suggestion, with the other-unit note", [/No Piece left — 4 box in stock in a different unit \(not converted, not added together\), so this is shown as Watch\./.test(text()), /Suggest ordering 3 Piece to cover 15 days at the current rate\. Note: 4 box in stock in a different unit — not converted; check before ordering\./.test(text()), /Out of stock — shown as Critical/.test(text())], [true, true, false]);
check("CRP detail: 'In stock (1)' with USE FIRST on the box lot only", [!!tab("In stock (1)"), /USE FIRST Lot 375113576768/.test(text()), (text().match(/USE FIRST/g) || []).length], [true, true, 1]);
await U.unmount();

// ── Dashboard and Reorder ──
await U.mount(A.createElement(A.Dashboard, { groups, counts: { red: 0, yellow: 1, green: 1, flagged: 0, lowStock: 0, expiringSoon: 0 }, departments: ["Chemistry"], devices: [], logs: L, reagents: R, can: () => true, onDeleteReagent() {}, onDiscardReagent() {}, onSelect() {}, onViewDevices() {}, onSnooze() {}, onUnsnooze() {} }));
check("Dashboard: ERF row names A3826 as the next lot (not the empty L3470)", [/Lot A3826/.test(text()), /nearest L3470|Lot L3470/.test(text())], [true, false]);
await U.unmount();
await U.mount(A.createElement(A.ReorderPage, { groups, coverageDays: 15, onSelectGroup() {} }));
const note = U.host.querySelector('[data-testid="reorder-other-unit"]')?.textContent ?? "";
check("Reorder: CRP still suggests 3 Piece, noting the 4 box in another unit (not converted); ERF suggests nothing", [/CRP/.test(text()), note, /ERF/.test(text())], [true, "No Piece left · 4 box in stock in a different unit — not converted; check before ordering", false]);
await U.unmount();
check("statuses: ERF Stable, CRP Watch — no Critical left from an empty lot alone", groups.map((g) => `${g.name}:${g.status}`).sort(), ["CRP:yellow", "ERF:green"]);
});
