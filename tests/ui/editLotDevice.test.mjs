// Edit Lot window (App.jsx EditReagentModal), real component in jsdom: the device
// field. A lot without a device offers ONLY its own department's devices (plus
// "leave as it is"); a lot with a device shows it read-only; choosing one sends
// only the device; App passes the device list to the window. Database stubbed.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Edit Lot window · device of a lot recorded without one", async () => {
const env = setupDom();
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { buildLotUpdate } from "${src("lotEdit.js")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` },
  { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["EditReagentModal"] })] });
const U = ui(A, env.w);
globalThis.__history = { logs: 0, countLines: 0 };
const DEVICES = [{ name: "VITROS", department: "Chemistry" }, { name: "SYSMEX", department: "Chemistry" }, { name: "RUBY", department: "Hematology" }];
const blank = { id: "A3826", name: "ERF", department: "Chemistry", device: "", lot_number: "A3826", unit: "BOX", quantity_received: 2, current_quantity: 2, low_stock_threshold: 2, units_per_carton: null, pack_unit: null, expiry_date: "2028-03-09", active_on_device: false };
const select = () => U.host.querySelector('[data-testid="lot-device-select"]');
const saveBtn = () => [...U.host.querySelectorAll("button")].find((x) => /Save changes|Saving…/.test(x.textContent));
const sent = [];
const onSave = async (original, payload) => { sent.push(A.buildLotUpdate(original, payload).changes); return { ok: true }; };

await U.mount(A.createElement(A.EditReagentModal, { reagent: blank, devices: DEVICES, onClose() {}, onSave }));
check("lot without a device: a device list with only its department's devices, starting at 'leave as it is'", [!!select(), [...select().options].map((o) => o.textContent), select().value],
  [true, ["No device — leave as it is", "SYSMEX", "VITROS"], ""]);
check("nothing chosen: nothing to save", saveBtn().disabled, true);
await U.type(select(), "VITROS");
await U.click(saveBtn());
check("choosing VITROS and saving sends only the device", sent, [{ device: "VITROS" }]);
await U.unmount();

await U.mount(A.createElement(A.EditReagentModal, { reagent: { ...blank, id: "L3470", device: "VITROS" }, devices: DEVICES, onClose() {}, onSave }));
check("lot with a device: shown read-only with an explanation; no device list", [!!select(), U.host.querySelector('[data-testid="lot-device"]')?.textContent.replace(/\s+/g, " ").trim()], [false, "DeviceVITROSA lot's device can't be changed here."]);
await U.unmount();

await U.mount(A.createElement(A.EditReagentModal, { reagent: { ...blank, department: "Store" }, devices: DEVICES, onClose() {}, onSave }));
check("department without devices: the list is disabled and says why", [select().disabled, /The Store department has no devices in Settings\./.test(U.text())], [true, true]);
await U.unmount();

const app = readSource("App.jsx");
check("App passes the device list to the Edit Lot window, and the window passes it to planLotEdit", [/<EditReagentModal reagent=\{editReagent\} devices=\{devices\}/.test(app), /planLotEdit\(\{[^}]*devices \}\)/.test(app)], [true, true]);
});
