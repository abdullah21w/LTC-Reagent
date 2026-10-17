// Zero-quantity lots (forecast.js): a lot with nothing left stays recorded but is
// never stock. Status from USABLE stock (has stock, not expired): Critical only
// when no usable stock is left or an expired lot still holds stock; an empty lot
// alone is not Critical; a unit with nothing left while another unit has stock is
// Watch (never added together or converted, its reorder hint kept). FEFO / USE
// FIRST / the unit's low-stock threshold come from lots with stock. Stock-count
// corrections still count as usage. The ERF and CRP shapes from Production.
import { suite, check, load, src } from "../helpers/core.mjs";

const F = await load({ contents: `export * from "${src("forecast.js")}";` });

suite("Zero-quantity lots · status, FEFO and units from usable stock", async () => {
const today = "2026-10-17";
const shift = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);
const compareLots = (a, b) => { const x = !!a.expiry_date, y = !!b.expiry_date; if (x && y) return new Date(a.expiry_date) - new Date(b.expiry_date); if (x !== y) return x ? -1 : 1; return new Date(a.date_added) - new Date(b.date_added); };
const isExpiringSoonItem = (i, w) => { if (!i.expiry_date) return false; const d = daysBetween(i.expiry_date, today); return d >= 0 && d <= w; };
const env = (snoozes = []) => ({ snoozes, warnDays: 30, today, compareLots, daysBetween, hasInspectionIssue: () => false, isExpiringSoonItem });
let n = 0;
const lot = (o) => ({ id: `L${++n}`, name: "R", department: "Chemistry", device: "VITROS", item_type: "Reagent", unit: "box", quantity_received: 5, current_quantity: 5, low_stock_threshold: 1, units_per_carton: null, pack_unit: null, expiry_date: shift(400), date_added: "2026-07-15", deleted: false, active_on_device: false, ...o });
const groupOf = (lots, logs = [], snoozes = []) => F.buildGroups(lots, logs, env(snoozes))[0];
const why = (g) => F.statusReasons(g.items, 30, today, !!g.snoozedUntil, g.snoozedUntil);
const kinds = (g) => why(g).reasons.map((r) => r.kind);

// ── ERF (Production): L3470 0 BOX (expires first), A3826 2 BOX, threshold 1 ──
const corr = (lotId, amount, date) => ({ id: `c${++n}`, reagent_id: lotId, amount, date, used_by: F.STOCK_COUNT_CORRECTION_USER, deleted: false });
const L3470 = lot({ name: "ERF", lot_number: "L3470", unit: "BOX", quantity_received: 3, current_quantity: 0, expiry_date: "2027-09-08", item_type: "Other" });
const A3826 = lot({ name: "ERF", lot_number: "A3826", unit: "BOX", quantity_received: 2, current_quantity: 2, expiry_date: "2028-03-09", date_added: "2026-09-22" });
const erfLogs = ["2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14"].map((d) => corr(L3470.id, 0.25, d));
const erf = groupOf([L3470, A3826], erfLogs);
check("ERF: an empty L3470 next to A3826 (2 BOX > threshold 1) → Stable, not Critical", [erf.status, why(erf).status], ["green", "green"]);
check("ERF: FEFO / USE FIRST is A3826 (L3470 expires first but is empty and comes last)", [erf.fefo.lot_number, erf.items.map((i) => i.lot_number)], ["A3826", ["A3826", "L3470"]]);
check("ERF: 'In stock' counts only lots with stock (1); the empty lot stays a recorded lot of the group", [erf.items.filter(F.lotHasStock).map((i) => i.lot_number), erf.items.length], [["A3826"], 2]);
check("ERF: total 2 BOX, not low, no reorder; stock-count corrections still count as usage (1 BOX in 30 days → 60 days left)", [erf.totalQty, erf.lowStock, erf.recentUsed, erf.predictedDaysLeft, F.reorderSuggestion(erf.dailyRate, erf.totalQty, 15).needed], [2, false, 1, 60, false]);
check("ERF: the detail page explains it — L3470 is empty (information only), nothing Critical", kinds(erf), ["empty_lot"]);

// ── CRP (Production): Piece lot 0 and expired, box lot 4; no conversion ──
const P372 = lot({ name: "CRP", lot_number: "372399", unit: "Piece ", quantity_received: 25, current_quantity: 0, units_per_carton: 5, low_stock_threshold: 2, expiry_date: "2026-10-01" });
const B375 = lot({ name: "CRP", lot_number: "375113576768", unit: "box", quantity_received: 4, current_quantity: 4, low_stock_threshold: 2, expiry_date: "2027-03-01", date_added: "2026-09-22" });
const crpLogs = ["2026-09-23", "2026-09-30", "2026-10-07"].map((d) => corr(P372.id, 1.5, d));
const crp = groupOf([P372, B375], crpLogs);
const piece = crp.parts.find((p) => p.key === F.lotUnitKey(P372)), box = crp.parts.find((p) => p.key === "box");
check("CRP: no Piece left, 4 box in stock → Watch (not Critical), Piece reported as the unit that is out", [crp.status, why(crp).status, crp.unitsOut.map((u) => u.unit.trim())], ["yellow", "yellow", ["Piece"]]);
check("CRP: Piece and box are never added or converted (no group total; each unit on its own)", [crp.mixedUnits, crp.totalQty, piece.totalQty, box.totalQty, piece.hasStock, box.hasStock], [true, null, 0, 4, false, true]);
check("CRP: the Piece reorder hint stays (4.5 Piece used in 30 days → order 3 for 15 days); box has none", [F.reorderSuggestion(piece.dailyRate, piece.totalQty, 15), F.reorderSuggestion(box.dailyRate, box.totalQty, 15).needed], [{ target: 3, suggestedQty: 3, needed: true }, false]);
const unitOut = why(crp).reasons.find((r) => r.kind === "unit_out");
check("CRP: the reason names the other unit's stock (4 box), and USE FIRST is the box lot", [unitOut.unit.trim(), unitOut.otherUnits.map((o) => `${o.totalQty} ${o.unit}`), crp.fefo.lot_number], ["Piece", ["4 box"], "375113576768"]);

// ── the rules ──
const allEmpty = groupOf([lot({ current_quantity: 0 }), lot({ current_quantity: 0, expiry_date: shift(500) })]);
check("all lots empty → Critical (out of stock)", [allEmpty.status, kinds(allEmpty).includes("out_of_stock"), why(allEmpty).status], ["red", true, "red"]);
const expiredStock = groupOf([lot({ current_quantity: 3, expiry_date: shift(-5) }), lot({ current_quantity: 10, expiry_date: shift(300) })]);
check("an expired lot that still holds stock stays Critical, even with usable stock elsewhere (it must be discarded)", [expiredStock.status, kinds(expiredStock)[0], expiredStock.fefo.current_quantity], ["red", "expired", 10]);
const onlyExpired = groupOf([lot({ current_quantity: 3, expiry_date: shift(-5) })]);
check("only an expired lot with stock → Critical (expired + no usable stock)", [onlyExpired.status, kinds(onlyExpired)], ["red", ["expired", "out_of_stock"]]);
const expiredEmpty = groupOf([lot({ current_quantity: 0, expiry_date: shift(-20) }), lot({ current_quantity: 10, expiry_date: shift(300) })]);
check("an expired AND empty lot next to a usable lot → not Critical (nothing to discard)", [expiredEmpty.status, kinds(expiredEmpty)], ["green", ["empty_lot"]]);
const realLow = groupOf([lot({ current_quantity: 0, low_stock_threshold: 0, expiry_date: shift(10) }), lot({ current_quantity: 2, low_stock_threshold: 3 })]);
check("a real low stock is not hidden: 2 left ≤ threshold 3 of the lot WITH stock (the empty lot's threshold 0 is ignored) → Watch", [realLow.status, realLow.lowStock, realLow.parts[0].threshold, kinds(realLow).includes("low_stock")], ["yellow", true, 3, true]);
const notLowByEmptyThreshold = groupOf([lot({ current_quantity: 0, low_stock_threshold: 9, expiry_date: shift(10) }), lot({ current_quantity: 4, low_stock_threshold: 2 })]);
check("an empty lot's high threshold doesn't make the reagent low (4 left > threshold 2 of the lot with stock)", [notLowByEmptyThreshold.status, notLowByEmptyThreshold.lowStock], ["green", false]);
const snoozed = groupOf([lot({ name: "S", current_quantity: 0 }), lot({ name: "S", current_quantity: 1, low_stock_threshold: 3 })], [], [{ reagent_name: "S", device: "VITROS", snoozed_until: shift(5) }]);
check("a snoozed low stock stays snoozed (Stable), the empty lot changes nothing", [snoozed.status, why(snoozed).status, snoozed.snoozedUntil], ["green", "green", shift(5)]);
const emptySoon = groupOf([lot({ current_quantity: 0, expiry_date: shift(5) }), lot({ current_quantity: 10, expiry_date: shift(300) })]);
const usableSoon = groupOf([lot({ current_quantity: 10, expiry_date: shift(5) })]);
check("expiring soon: an empty lot about to expire is not a warning; a lot WITH stock about to expire still is (Watch)", [emptySoon.status, emptySoon.expiringSoon, usableSoon.status, usableSoon.expiringSoon], ["green", false, "yellow", true]);
const order = groupOf([lot({ lot_number: "E", current_quantity: 0, expiry_date: shift(1) }), lot({ lot_number: "X", current_quantity: 2, expiry_date: shift(-1) }), lot({ lot_number: "U2", current_quantity: 2, expiry_date: shift(90) }), lot({ lot_number: "U1", current_quantity: 2, expiry_date: shift(60) })]);
check("FEFO order: usable lots by expiry, then expired lots with stock, then empty lots", order.items.map((i) => i.lot_number), ["U1", "U2", "X", "E"]);
const noUnitOutWhenNothingElse = groupOf([lot({ unit: "Piece", current_quantity: 0 }), lot({ unit: "box", current_quantity: 0 })]);
check("every unit empty → Critical (out of stock), not 'unit out' Watch", [noUnitOutWhenNothingElse.status, noUnitOutWhenNothingElse.unitsOut, kinds(noUnitOutWhenNothingElse).includes("unit_out")], ["red", [], false]);
const lots = [L3470, A3826, P372, B375, ...["Q", "W"].map((nm) => lot({ name: nm, current_quantity: 0 }))];
const groups = F.buildGroups(lots, [...erfLogs, ...crpLogs], env());
check("invariants: status = detail-page status for every group; USE FIRST is never an empty lot while a usable lot exists", [groups.every((g) => why(g).status === g.status), groups.every((g) => !g.items.some((i) => F.lotIsUsable(i, today)) || F.lotIsUsable(g.fefo, today))], [true, true]);
check("nothing is changed on the lots (quantities, dates stay as given)", [L3470.current_quantity, P372.current_quantity, P372.expiry_date, A3826.current_quantity], [0, 0, "2026-10-01", 2]);
});
