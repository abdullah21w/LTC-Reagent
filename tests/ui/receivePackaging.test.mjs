// U2d-2 — the real Receive window (ReceiveWizard.jsx) in jsdom: explicit base unit,
// packaged and unpackaged entry (countable and measured), validation before saving,
// low-stock threshold (blank = default, 0 kept), the review = exactly what is sent,
// and the duplicate advisory (read-only lookup, never blocks, manual packaging copy).
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("U2d-2 · Receive window packaging, review and duplicate advisory", async () => {
const env = setupDom();
const A = await load({ contents: `export { default as ReceiveWizard } from "${src("ReceiveWizard.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE })] });
const U = ui(A, env.w);
const btn = (t) => [...U.host.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const gbtn = (group, t) => [...(U.host.querySelector(`[role="group"][aria-label="${group}"]`)?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === t);
const pressed = (group) => [...(U.host.querySelector(`[role="group"][aria-label="${group}"]`)?.querySelectorAll('button[aria-pressed="true"]') || [])].map((b) => b.textContent.trim());
const total = () => U.host.querySelector('[data-testid="receipt-total"]')?.textContent ?? null;
const errs = () => U.host.querySelector('[data-testid="receipt-errors"]')?.textContent ?? "";
const nextBtn = () => btn("Next: Inspection");
const review = () => Object.fromEntries([...U.host.querySelectorAll("[data-review]")].map((b) => [b.getAttribute("data-review"), b.textContent]));
const advisory = () => U.host.querySelector('[data-testid="duplicate-advisory"]')?.textContent ?? null;
const calls = [], lookups = [];
let lookupResult = { data: [], error: null };
const onSubmit = async (e) => { calls.push(e); return { ok: true, outcome: "saved" }; };
const lookupLots = async (lot) => { lookups.push(lot); return typeof lookupResult === "function" ? lookupResult() : lookupResult; };
const open = async (props = {}) => { calls.length = 0; lookups.length = 0; await U.mount(A.createElement(A.ReceiveWizard, { presets: [{ id: "p1", name: "Diluent D", department: "Chemistry", unit: "mL" }], devices: [], role: "staff", username: "tester", departments: ["Chemistry", "Hematology"], defaultLowStock: 5, onClose() {}, onSubmit, lookupLots, ...props })); };
const basics = async () => { await U.type(U.inputByLabel("Item (type to search)"), "Reagent R"); await U.type(U.inputByLabel("Lot number"), "TR-001"); await U.click(gbtn("Device", "No device recorded")); await U.click(gbtn("Expiry", "No expiry date")); };
const finishStep2 = async () => { await U.click(nextBtn()); await U.settle(); };

// 1. Base unit is required — no default
await open(); await basics();
await U.type(U.inputByLabel("Quantity received"), "12");
check("no base unit pre-selected (no silent mL); Next disabled; the reason is shown", [pressed("Base unit"), nextBtn().disabled, /Choose the base unit/.test(errs())], [[], true, true]);
await U.click(btn("piece"));
check("choosing 'piece': selected, total shown, Next enabled", [pressed("Base unit"), total(), nextBtn().disabled], [["piece"], "Total to store: 12 pieces", false]);
await U.click(gbtn("Base unit", "Other…"));
await U.type(U.host.querySelector('input[aria-label="Other base unit"]'), "cassette");
check("Other… base unit typed by hand", [pressed("Base unit"), total()], [["Other…"], "Total to store: 12 cassettes"]);
await U.unmount();

// 2. A preset brings its own unit (explicit, from the preset)
await open();
await U.type(U.inputByLabel("Item (type to search)"), "Diluent D");
check("a preset sets its unit (mL selected because the preset says so)", pressed("Base unit"), ["mL"]);
await U.unmount();

// 3. Unpackaged, countable vs measured
await open(); await basics(); await U.click(btn("piece"));
await U.type(U.inputByLabel("Quantity received"), "2.5");
check("countable: 2.5 pieces refused before saving; Next disabled", [/whole number for this unit/.test(errs()), nextBtn().disabled, total()], [true, true, null]);
await U.click(btn("mL"));
check("measured: 2.5 mL accepted", [total(), nextBtn().disabled], ["Total to store: 2.5 mL", false]);
await U.type(U.inputByLabel("Quantity received"), "2.555");
check("measured: 3 decimals refused", [/at most 2 decimals/.test(errs()), nextBtn().disabled], [true, true]);
await U.type(U.inputByLabel("Quantity received"), "-3");
check("negative refused", /can't be negative/.test(errs()), true);
await U.unmount();

// 4. Packaged: labels follow the unit and package, live total
await open(); await basics(); await U.click(btn("piece"));
await U.click(btn("Packaged (box, carton, kit …)"));
check("packaged: package name required; Next disabled", [/Choose a package name/.test(errs()), nextBtn().disabled], [true, true]);
await U.click(btn("Box"));
await U.type(U.inputByLabel("Pieces per box"), "5");
await U.type(U.inputByLabel("Boxes received"), "3");
await U.type(U.inputByLabel("Loose pieces (optional)"), "2");
check("3 boxes × 5 pieces + 2 loose → 17 pieces, shown before saving", [total(), nextBtn().disabled], ["Total to store: 3 boxes × 5 pieces + 2 pieces = 17 pieces", false]);
await U.type(U.inputByLabel("Boxes received"), "1.5");
check("fractional package count refused", [/whole number \(count full packages/.test(errs()), nextBtn().disabled], [true, true]);
await U.type(U.inputByLabel("Boxes received"), "3");
await U.type(U.inputByLabel("Pieces per box"), "2.5");
check("fractional package size refused", [/a whole number of 1 or more/.test(errs()), nextBtn().disabled], [true, true]);
await U.type(U.inputByLabel("Pieces per box"), "5");
await U.click(gbtn("Package name", "Other…"));
await U.type(U.host.querySelector('input[aria-label="Other package name"]'), "x".repeat(41));
check("custom package name over 40 characters refused", [/at most 40 characters/.test(errs()), nextBtn().disabled], [true, true]);
await U.type(U.host.querySelector('input[aria-label="Other package name"]'), "pieces");
check("package name equal to the base unit refused", [/can't be the same as the unit inside it/.test(errs()), nextBtn().disabled], [true, true]);
await U.type(U.host.querySelector('input[aria-label="Other package name"]'), "Sachet");
await U.type(U.inputByLabel("Boxes received".replace("Boxes", "Sachet")) ?? U.inputByLabel("Sachet received"), "3");
check("custom name: labels follow it; total recalculated", [!!U.inputByLabel("Pieces per Sachet"), total()], [true, "Total to store: 3 Sachet × 5 pieces + 2 pieces = 17 pieces"]);
await U.type(U.inputByLabel("Sachet received"), "0");
await U.type(U.inputByLabel("Loose pieces (optional)"), "");
check("total 0 refused", [/must be more than 0/.test(errs()), nextBtn().disabled], [true, true]);
await U.unmount();

// 5. Measured base unit inside packages: exact decimals
await open(); await basics(); await U.click(btn("mL"));
await U.click(btn("Packaged (box, carton, kit …)"));
await U.click(gbtn("Package name", "Other…"));
await U.type(U.host.querySelector('input[aria-label="Other package name"]'), "bottle");
check("measured unit labels keep their spelling (\"mL per bottle\", not \"ML\")", [!!U.inputByLabel("mL per bottle"), !!U.inputByLabel("ML per bottle")], [true, false]);
await U.type(U.inputByLabel("mL per bottle"), "500");
await U.type(U.inputByLabel("Bottles received"), "3");
await U.type(U.inputByLabel("Loose mL (optional)"), "0.1");
check("3 bottles × 500 mL + 0.1 mL = exactly 1500.1 mL", total(), "Total to store: 3 bottles × 500 mL + 0.1 mL = 1500.1 mL");
await finishStep2();
check("…review shows the same exact total", [review()["Total stored"], review()["Received"]], ["1500.1 mL", "3 bottles + 0.1 loose mL"]);
await U.click(btn("Add to inventory"));
check("…and exactly that number is sent (JSON 1500.1), size 500, name bottle", [JSON.stringify(calls[0].quantityReceived), calls[0].unitsPerCarton, calls[0].packUnit], ["1500.1", 500, "bottle"]);
await U.unmount();

// 5b. Typed precision: kept exactly, or refused — never rounded away
await open(); await basics(); await U.click(btn("mL"));
await U.type(U.inputByLabel("Quantity received (mL)"), "0.10");
await U.type(U.inputByLabel("Low stock alert below (mL)"), "0.10");
await finishStep2();
check("0.10 mL with threshold 0.10: review 0.1 mL / 0.1 mL", [review()["Total stored"], review()["Low stock alert below"]], ["0.1 mL", "0.1 mL"]);
await U.click(btn("Add to inventory"));
check("…sent as exactly 0.1 and 0.1", [JSON.stringify(calls[0].quantityReceived), JSON.stringify(calls[0].lowStockThreshold)], ["0.1", "0.1"]);
await U.unmount();
await open(); await basics(); await U.click(btn("mL"));
const refusedQ = [];
for (const q of ["0.100000001", "1e3", "1000000000.01"]) { await U.type(U.inputByLabel("Quantity received (mL)"), q); refusedQ.push([q, errs(), nextBtn().disabled, total()]); }
check("0.100000001 / 1e3 / over 1,000,000,000 mL: refused with the reason, Next disabled, no total shown (nothing silently rounded)", refusedQ, [["0.100000001", "Quantity received can have at most 2 decimals.", true, null], ["1e3", "Quantity received must be written as a plain number (for example 12 or 12.5).", true, null], ["1000000000.01", "Quantity received can be at most 1,000,000,000.", true, null]]);
await U.unmount();

// 6. Low-stock threshold, review = payload
await open(); await basics(); await U.click(btn("piece"));
await U.click(btn("Packaged (box, carton, kit …)")); await U.click(btn("Kit"));
await U.type(U.inputByLabel("Pieces per kit"), "4"); await U.type(U.inputByLabel("Kits received"), "2"); await U.type(U.inputByLabel("Loose pieces (optional)"), "1");
await U.click(gbtn("Expiry", "Enter the expiry date")); await U.type(U.host.querySelector('[data-testid="receive-expiry"]'), "2027-06-30");
check("threshold label in the base unit; blank shows the default", [!!U.inputByLabel("Low stock alert below (pieces)"), /Leave blank for the default \(5\); 0 is kept as 0/.test(U.text())], [true, true]);
await finishStep2();
const today = new Date().toISOString().slice(0, 10);
check("review shows exactly what will be saved (blank threshold = default)", review(), { "Item": "Reagent R", "Lot number": "TR-001", "Department": "Chemistry", "Device": "No device recorded", "Base unit": "piece", "Packaging": "1 kit = 4 pieces", "Received": "2 kits + 1 loose piece", "Total stored": "9 pieces", "Expiry": "2027-06-30", "Received on": today, "Low stock alert below": "5 pieces (default)" });
await U.click(btn("Back"));
await U.type(U.inputByLabel("Low stock alert below (pieces)"), "0");
await finishStep2();
check("explicit 0 threshold: review says 0, not the default", review()["Low stock alert below"], "0 pieces");
await U.click(btn("Add to inventory"));
check("sent values = the review: unit, total, size, package name, threshold 0, expiry, receipt id", (({ unit, quantityReceived, unitsPerCarton, packUnit, lowStockThreshold, expiryDate, lotNumber, department }) => ({ unit, quantityReceived, unitsPerCarton, packUnit, lowStockThreshold, expiryDate, lotNumber, department }))(calls[0]), { unit: "piece", quantityReceived: 9, unitsPerCarton: 4, packUnit: "kit", lowStockThreshold: 0, expiryDate: "2027-06-30", lotNumber: "TR-001", department: "Chemistry" });
check("…and it carries the window's receipt id (U2d-1 unchanged)", /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(calls[0].receiptId), true);
await U.unmount();

// 7. Duplicate advisory: read-only lookup by Lot number, advisory only, manual copy
lookupResult = { data: [
  { id: "x1", name: "Reagent R", lot_number: "TR-001", department: "Chemistry", device: "", unit: "piece", units_per_carton: 5, pack_unit: "box", quantity_received: 15, current_quantity: 9, date_added: "2026-09-01", added_by: "staff-a", deleted: false },
  { id: "x2", name: "Reagent R", lot_number: "TR-001", department: "Hematology", device: "", unit: "bottle", units_per_carton: 6, pack_unit: null, quantity_received: 12, current_quantity: 12, date_added: "2026-08-01", added_by: "staff-b", deleted: true },
], error: null };
await open(); await basics(); await U.click(btn("piece")); await U.type(U.inputByLabel("Quantity received"), "10");
await finishStep2();
check("lookup called once with the trimmed Lot number when moving to the review", lookups, ["TR-001"]);
const adv = advisory() || "";
check("advisory: possible duplicate in this department/device, with details to identify it; not blocking", [/Possible duplicate: this Lot number is already recorded for this department and device/.test(adv), /9 of 15 pieces left/.test(adv), /received 2026-09-01 by staff-a/.test(adv), /1 box = 5 pieces/.test(adv), /nothing is merged and the existing Lot isn't changed/.test(adv), /not a lock/.test(adv), btn("Add to inventory").disabled], [true, true, true, true, true, true, false]);
check("the other Lot (other department, removed, recorded in bottles): listed, labelled removed, packaging not copyable", [/Lot TR-001 \(removed\)/.test(adv), /recorded in bottle, not piece, so its packaging can't be copied/.test(adv), U.host.querySelectorAll('[data-testid="duplicate-match"] button').length], [true, true, 1]);
await U.click(btn("Use the same packaging"));
check("manual copy: back to details, packaging filled from the existing Lot (box × 5), a note says the existing Lot isn't changed", [!!nextBtn(), pressed("Packaging"), pressed("Package name"), U.inputByLabel("Pieces per box")?.value, /Packaging copied from Lot TR-001: 1 box = 5 pieces.*Lot TR-001 itself is not changed/.test(U.host.querySelector('[role="status"]')?.textContent || "")], [true, ["Packaged (box, carton, kit …)"], ["Box"], "5", true]);
await U.type(U.inputByLabel("Boxes received"), "2");
await finishStep2();
await U.click(btn("Add to inventory"));
check("after copying, the receipt is still saved as a NEW Lot (nothing merged): 2 × 5 = 10 pieces, box", [calls.length, calls[0].quantityReceived, calls[0].unitsPerCarton, calls[0].packUnit], [1, 10, 5, "box"]);
await U.unmount();

lookupResult = { data: [], error: null };
await open(); await basics(); await U.click(btn("piece")); await U.type(U.inputByLabel("Quantity received"), "10");
await finishStep2();
check("no existing Lot with that number → no advisory", advisory(), null);
await U.unmount();
lookupResult = () => Promise.reject(new TypeError("Failed to fetch"));
await open(); await basics(); await U.click(btn("piece")); await U.type(U.inputByLabel("Quantity received"), "10");
await finishStep2();
check("lookup failed → says it couldn't check; saving still possible", [/Couldn't check for an existing Lot with this number/.test(advisory() || ""), btn("Add to inventory").disabled], [true, false]);
await U.unmount();

const wiz = readSource("ReceiveWizard.jsx"), app = readSource("App.jsx");
check("App wires a read-only lookup (select … eq lot_number), no write in it", (() => { const f = app.slice(app.indexOf("function lookupLotsByNumber("), app.indexOf("async function recordConsumption(")); return [/\.select\(/.test(f), /\.eq\("lot_number", lotNumber\)/.test(f), /\.(insert|update|delete|upsert|rpc)\(/.test(f), app.includes("lookupLots={lookupLotsByNumber}")]; })(), [true, true, false, true]);
check("Receive window: no <datalist>, no direct database access", [/<datalist/.test(wiz), /supabase/.test(wiz)], [false, false]);
check("the window wrote nothing itself", globalThis.__writes || [], []);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 39 });
