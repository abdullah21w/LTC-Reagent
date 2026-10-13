// U2d-1 — the real Receive window (ReceiveWizard.jsx) in jsdom: a refused or unconfirmed
// save keeps the window and every entry, repeated taps send one request, a retry sends the
// same receipt id, and the quantity sent is exactly what Receive always computed.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("U2d-1 · Receive window save behaviour", async () => {
const env = setupDom();
const A = await load({ contents: `export { default as ReceiveWizard } from "${src("ReceiveWizard.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE })] });
const U = ui(A, env.w);
const btn = (t) => [...U.host.querySelectorAll("button")].find((b) => b.textContent.trim().endsWith(t));
const alertText = () => U.host.querySelector('[role="alert"]')?.textContent ?? null;
const calls = [];
let next = { ok: false, message: "The database refused the receipt (boom). Nothing was saved." };
const onSubmit = async (e) => { calls.push(e); return typeof next === "function" ? next() : next; };
let closed = 0;
const open = async () => { calls.length = 0; await U.mount(A.createElement(A.ReceiveWizard, { presets: [], devices: [], role: "staff", username: "tester", departments: ["Chemistry"], defaultLowStock: 5, onClose: () => { closed++; }, onSubmit })); };
const fill = async ({ packaging = false } = {}) => {
  await U.type(U.inputByLabel("Item (type to search)"), "Reagent R");
  await U.type(U.inputByLabel("Lot number"), "TR-001");
  if (packaging) {
    await U.click([...U.host.querySelectorAll("label")].find((l) => /This item comes in boxes/.test(l.textContent)).querySelector("input"));
    await U.type(U.inputByLabel("mL per box"), "6");
    await U.type(U.inputByLabel("Boxes received"), "3");
  } else await U.type(U.inputByLabel("Quantity received"), "12");
  await U.click(btn("Next: Inspection"));
};

// 1. Refused save: window stays, message shown, entries kept, button usable again
await open(); await fill();
await U.click(btn("Add to inventory"));
check("refused: one request; message shown as an alert; window still open (inspection step)", [calls.length, alertText(), !!btn("Add to inventory"), closed], [1, "The database refused the receipt (boom). Nothing was saved.", true, 0]);
check("refused: button enabled again (not stuck on Saving…)", [btn("Add to inventory").disabled, /Saving…/.test(U.text())], [false, false]);
await U.click(btn("Back"));
check("refused: every entry kept (name, Lot, quantity)", [U.inputByLabel("Item (type to search)").value, U.inputByLabel("Lot number").value, U.inputByLabel("Quantity received").value], ["Reagent R", "TR-001", "12"]);
await U.click(btn("Next: Inspection"));

// 2. Retry: same receipt id (a retry can never create a second Lot); payload unchanged
next = { ok: true, outcome: "saved" };
await U.click(btn("Add to inventory"));
check("retry sends the SAME receipt id; it is a v4 UUID", [calls.length, calls[1].receiptId === calls[0].receiptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(calls[0].receiptId)], [2, true, true]);
check("payload quantity and fields exactly as Receive always sent them", (({ name, lotNumber, quantityReceived, unitsPerCarton, unit, lowStockThreshold, receivedBy }) => ({ name, lotNumber, quantityReceived, unitsPerCarton, unit, lowStockThreshold, receivedBy }))(calls[1]), { name: "Reagent R", lotNumber: "TR-001", quantityReceived: 12, unitsPerCarton: null, unit: "mL", lowStockThreshold: 5, receivedBy: "tester" });
check("success: no error shown; the window does not close itself (the parent closes it)", [alertText(), closed], [null, 0]);
await U.unmount();

// 3. Repeated taps while saving → exactly one request
await open(); await fill();
let release; next = new Promise((r) => { release = r; });
const b = btn("Add to inventory");
await U.click(b); await U.click(b); await U.click(b);
check("rapid repeated taps while saving → exactly one request; shows Saving…, Back disabled", [calls.length, /Saving…/.test(U.text()), btn("Back").disabled], [1, true, true]);
await A.act(async () => { release({ ok: false, outcome: "unknown", message: "The connection failed before the database answered, so we can't tell whether this receipt was saved." }); });
await U.settle();
check("unknown outcome: honest message, entries kept, retry possible", [/can't tell whether this receipt was saved/.test(alertText() || ""), btn("Add to inventory").disabled], [true, false]);
await U.unmount();

// 4. A thrown error is caught and shown
await open(); await fill();
next = () => Promise.reject(new Error("unexpected"));
await U.click(btn("Add to inventory")); await U.settle();
check("a thrown error: caught, honest message, window open, retry possible", [/couldn't be confirmed\. Your entries are kept/.test(alertText() || ""), btn("Add to inventory").disabled], [true, false]);
await U.unmount();

// 5. Packaging path: quantity semantics unchanged (boxes × per box, in the unit)
await open(); await fill({ packaging: true });
next = { ok: true };
await U.click(btn("Add to inventory"));
check("packaging: quantity = boxes × units per box (3 × 6 = 18), box size sent, as before", [calls[0].quantityReceived, calls[0].unitsPerCarton], [18, 6]);
await U.unmount();

// 6. Exit guard after an uncertain result
const closeBtn = () => U.host.querySelector('button[aria-label="Close"]');
const dialog = () => U.host.querySelector('[role="alertdialog"]');
const dlgBtn = (t) => [...(dialog()?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === t);
const uncertainResult = (outcome) => ({ ok: false, outcome, message: outcome === "unknown" ? "…isn't known yet whether this receipt was saved…" : "…could not be confirmed…" });

closed = 0; await open(); await fill();
next = uncertainResult("unknown");
await U.click(btn("Add to inventory"));
await U.click(closeBtn());
check("unknown result → Close does NOT close; a confirmation explains the risk", [closed, !!dialog(), /may already have been saved/.test(dialog()?.textContent || ""), /different receipt reference/.test(dialog()?.textContent || ""), /added twice/.test(dialog()?.textContent || ""), /safest choice is to stay here/.test(dialog()?.textContent || "")], [0, true, true, true, true, true]);
check("the confirmation takes focus on 'Stay in this window' (it is brought into view, not hidden above a scrolled window)", document.activeElement?.textContent?.trim(), "Stay in this window");
await U.click(dlgBtn("Stay in this window"));
check("Stay: confirmation gone, window open, still on the inspection step", [closed, dialog(), !!btn("Add to inventory")], [0, null, true]);
await U.click(btn("Back"));
check("Stay: every entry kept", [U.inputByLabel("Item (type to search)").value, U.inputByLabel("Lot number").value, U.inputByLabel("Quantity received").value], ["Reagent R", "TR-001", "12"]);
await U.click(btn("Next: Inspection"));
next = uncertainResult("unknown");
await U.click(btn("Add to inventory"));
check("Stay: the retry sends the SAME receipt id", [calls.length, calls[1].receiptId === calls[0].receiptId], [2, true]);
await U.click(closeBtn());
await U.click(dlgBtn("Leave anyway"));
check("Leave anyway: exits only after that explicit choice (onClose once)", closed, 1);
await U.unmount();

closed = 0; await open(); await fill();
next = uncertainResult("not_confirmed");
await U.click(btn("Add to inventory"));
await U.click(closeBtn());
check("not_confirmed result → Close shows the confirmation, does not close", [closed, !!dialog()], [0, true]);
await U.click(dlgBtn("Leave anyway"));
check("…Leave anyway → closes", closed, 1);
await U.unmount();

closed = 0; await open(); await fill();
next = () => Promise.reject(new Error("unexpected"));
await U.click(btn("Add to inventory")); await U.settle();
await U.click(closeBtn());
check("an unexpected thrown error is treated as uncertain → confirmation, no close", [closed, !!dialog()], [0, true]);
await U.unmount();

closed = 0; await open(); await fill();
next = { ok: false, outcome: "rejected", message: "The database refused the receipt (boom). Nothing was saved." };
await U.click(btn("Add to inventory"));
await U.click(closeBtn());
check("confirmed refusal → Close closes normally (no confirmation)", [closed, dialog()], [1, null]);
await U.unmount();

closed = 0; await open(); await fill();
next = uncertainResult("unknown");
await U.click(btn("Add to inventory"));
next = { ok: false, outcome: "rejected", message: "The database refused the receipt (boom). Nothing was saved." };
await U.click(btn("Add to inventory"));
await U.click(closeBtn());
check("uncertain, then a later attempt is a confirmed refusal → no longer blocked", [closed, dialog()], [1, null]);
await U.unmount();

closed = 0; await open();
await U.click(closeBtn());
check("no attempt yet → Close closes normally", [closed, dialog()], [1, null]);
await U.unmount();

closed = 0; await open(); await fill();
next = { ok: true, outcome: "saved" };
await U.click(btn("Add to inventory"));
check("confirmed success → no confirmation, no error; the parent closes the window (see App check below)", [dialog(), alertText(), closed], [null, null, 0]);
await U.unmount();

// ── Static checks on the wiring ──
const app = readSource("App.jsx"), wiz = readSource("ReceiveWizard.jsx");
const add = app.slice(app.indexOf("async function addReagent("), app.indexOf("async function recordConsumption("));
check("App.addReagent: saves through saveReceipt; closes and reloads only when result.ok; warns when the activity entry failed; no direct insert", [add.includes("saveReceipt({ client: supabase, entry, logActivity })"), /if \(result\.ok\) \{\s*setShowWizard\(false\);\s*loadAll\(\);\s*if \(result\.auditLogged === false\) alert\(result\.warning\);\s*\}/.test(add), /\.insert\(/.test(add)], [true, true, false]);
check("ReceiveWizard: no database access of its own; quantity formula unchanged", [/supabase/.test(wiz), wiz.includes("const finalQty = usePackaging ? Number(unitsPerCarton) * Number(cartonsReceived) : Number(form.quantityReceived);")], [false, true]);
check("the window itself never wrote to the database", globalThis.__writes || [], []);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 27 });
