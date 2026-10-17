// The real Receive window (ReceiveWizard.jsx) and Edit Lot window in jsdom: the
// device and expiry decisions. Nothing is pre-selected; Next stays disabled with
// the reasons shown until both are decided; "Select a device" offers only the
// department's devices; the review and the payload carry exactly the decisions.
// Edit Lot shows the explicit expiry choice for Lots received with it.
import { suite, check, load, src, appPlugin } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Receive window · explicit device and expiry choice", async () => {
const env = setupDom();
const A = await load({ contents: `export { default as ReceiveWizard } from "${src("ReceiveWizard.jsx")}"; export * from "${src("App.jsx")}"; export { buildLotUpdate } from "${src("lotEdit.js")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` },
  { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["EditReagentModal"] })] });
const U = ui(A, env.w);
const gbtn = (group, t) => [...(U.host.querySelector(`[role="group"][aria-label="${group}"]`)?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === t);
const pressed = (group) => [...(U.host.querySelector(`[role="group"][aria-label="${group}"]`)?.querySelectorAll('button[aria-pressed="true"]') || [])].map((b) => b.textContent.trim());
const btn = (t) => [...U.host.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const choiceErrs = () => U.host.querySelector('[data-testid="choice-errors"]')?.textContent ?? "";
const review = () => Object.fromEntries([...U.host.querySelectorAll("[data-review]")].map((b) => [b.getAttribute("data-review"), b.textContent]));
const DEVICES = [{ id: "d1", name: "VITROS", department: "Chemistry" }, { id: "d2", name: "SYSMEX", department: "Chemistry" }, { id: "d3", name: "RUBY", department: "Hematology" }];
const calls = [];
const open = async () => { calls.length = 0; await U.mount(A.createElement(A.ReceiveWizard, { presets: [], devices: DEVICES, role: "staff", username: "tester", departments: ["Chemistry", "Hematology", "Store"], defaultLowStock: 5, onClose() {}, onSubmit: async (e) => { calls.push(e); return { ok: true, outcome: "saved" }; } })); };
const basics = async () => { await U.type(U.inputByLabel("Item (type to search)"), "ERF"); await U.type(U.inputByLabel("Lot number"), "A3826"); await U.click(btn("box")); await U.type(U.inputByLabel("Quantity received"), "2"); };

await open(); await basics();
check("nothing pre-selected for device or expiry; Next disabled; both reasons shown", [pressed("Device"), pressed("Expiry"), btn("Next: Inspection").disabled, /choose a device from the list/.test(choiceErrs()), /enter the expiry date, or choose "No expiry date"/.test(choiceErrs())], [[], [], true, true, true]);
await U.click(gbtn("Device", "Select a device"));
const sel = () => U.host.querySelector('[data-testid="receive-device"]');
check("'Select a device': a list of THIS department's devices only, nothing picked yet; still not enough", [[...sel().options].map((o) => o.textContent), sel().value, btn("Next: Inspection").disabled, /choose which device \(from the Chemistry list\)/.test(choiceErrs())], [["Choose the device…", "VITROS", "SYSMEX"], "", true, true]);
await U.type(sel(), "VITROS");
await U.click(gbtn("Expiry", "Enter the expiry date"));
check("'Enter the expiry date' without a date: still blocked", [btn("Next: Inspection").disabled, /Expiry: enter the expiry date\./.test(choiceErrs())], [true, true]);
await U.type(U.host.querySelector('[data-testid="receive-expiry"]'), "2028-03-09");
check("device picked + date entered: Next enabled, no reasons left", [btn("Next: Inspection").disabled, choiceErrs()], [false, ""]);
await U.click(btn("Next: Inspection")); await U.settle();
check("review shows the decisions", [review()["Device"], review()["Expiry"]], ["VITROS", "2028-03-09"]);
await U.click(btn("Add to inventory")); await U.settle();
check("sent: the device and date WITH their choices", (({ device, deviceChoice, expiryDate, expiryChoice }) => [device, deviceChoice, expiryDate, expiryChoice])(calls[0] || {}), ["VITROS", "device", "2028-03-09", "date"]);
await U.unmount();

await open(); await basics();
await U.click(gbtn("Device", "Select a device")); await U.type(U.host.querySelector('[data-testid="receive-device"]'), "SYSMEX");
await U.click(gbtn("Device", "No device recorded")); await U.click(gbtn("Expiry", "No expiry date"));
await U.click(btn("Next: Inspection")); await U.settle();
check("'No device recorded' / 'No expiry date': review says so", [review()["Device"], review()["Expiry"]], ["No device recorded", "No expiry date"]);
await U.click(btn("Add to inventory")); await U.settle();
check("sent: blank device and no date, each with its 'none' choice (a device picked earlier is dropped)", (({ device, deviceChoice, expiryDate, expiryChoice }) => [device, deviceChoice, expiryDate, expiryChoice])(calls[0] || {}), ["", "none", null, "none"]);
await U.unmount();

await open(); await basics();
await U.type([...U.host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "Store")), "Store");
await U.click(gbtn("Device", "Select a device"));
check("department without devices: the list is disabled and only 'No device recorded' can be chosen", [U.host.querySelector('[data-testid="receive-device"]').disabled, /The Store department has no devices in Settings/.test(choiceErrs())], [true, true]);
await U.unmount();

// ── Edit Lot: explicit expiry ──
globalThis.__history = { logs: 0, countLines: 0 };
const sent = [];
const onSave = async (o, p) => { sent.push(A.buildLotUpdate(o, p).changes); return { ok: true }; };
const lot = { id: "L", name: "ERF", department: "Chemistry", device: "VITROS", device_choice: "device", lot_number: "A3826", unit: "box", quantity_received: 2, current_quantity: 2, low_stock_threshold: 1, units_per_carton: null, pack_unit: null, expiry_date: "2028-03-09", expiry_choice: "date", active_on_device: false };
await U.mount(A.createElement(A.EditReagentModal, { reagent: lot, devices: DEVICES, onClose() {}, onSave }));
check("Edit Lot, lot received with an explicit expiry: the two choices shown, 'Expiry date' selected with its date", [pressed("Expiry"), U.host.querySelector('[data-testid="lot-expiry"]')?.value], [["Expiry date"], "2028-03-09"]);
await U.click(gbtn("Expiry", "No expiry date"));
await U.click([...U.host.querySelectorAll("button")].find((x) => /Save changes/.test(x.textContent)));
check("…choosing 'No expiry date' saves the date cleared WITH expiry_choice 'none'", sent, [{ expiry_date: null, expiry_choice: "none" }]);
await U.unmount();
await U.mount(A.createElement(A.EditReagentModal, { reagent: { ...lot, device_choice: null, expiry_choice: null }, devices: DEVICES, onClose() {}, onSave }));
check("Edit Lot, legacy lot: the plain expiry field as before (no choice buttons)", [!!U.host.querySelector('[role="group"][aria-label="Expiry"]'), !!U.inputByLabel("Expiry date (leave blank if not applicable)")], [false, true]);
await U.unmount();
});
