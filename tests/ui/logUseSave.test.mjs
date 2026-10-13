// Atomic Log Use — the real Log use window (LogConsumptionModal) in jsdom: the amount
// is validated before sending; one request per tap burst; a failure keeps the window
// and every entry with a specific message; a retry sends the SAME reference id; after
// an uncertain outcome closing asks first. Plus App's wiring: recordConsumption goes
// through saveLogUse only (the old multi-write path is gone).
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Atomic Log Use · Log use window", async () => {
const env = setupDom();
const { w } = env;
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["LogConsumptionModal"] })] });

let root, host, closed = 0;
const calls = [];
let next = { ok: true, outcome: "saved" };
const onSubmit = async (e) => { calls.push(e); return typeof next === "function" ? next() : next; };
async function open(lots) {
  calls.length = 0; closed = 0;
  host = document.createElement("div"); document.body.appendChild(host); root = A.createRoot(host);
  await A.act(async () => { root.render(A.createElement(A.LogConsumptionModal, { reagents: lots, presets: [], username: "tester", lotToLotPending: [], onClose() { closed++; }, onSubmit })); });
}
const shut = async () => { await A.act(async () => root.unmount()); host.remove(); };
const settle = async () => { await A.act(async () => {}); };
async function type(input, value) { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(input, value); await A.act(async () => { input.dispatchEvent(new w.Event("input", { bubbles: true })); }); }
async function click(el) { if (!el) throw new Error("nothing to click"); await A.act(async () => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }); }
const amountInput = () => [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith("Amount used"))?.querySelector("input");
const noteInput = () => [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith("Note"))?.querySelector("input");
const saveBtn = () => [...host.querySelectorAll("button")].find((b) => /^(Save log|Saving…)$/.test(b.textContent.trim()));
const closeBtn = () => host.querySelector("button"); // the window's X (first button)
const amountError = () => host.querySelector('[data-testid="log-amount-error"]')?.textContent ?? null;
const saveError = () => host.querySelector('[data-testid="log-save-error"]')?.textContent ?? null;
const dialog = () => host.querySelector('[role="alertdialog"]');
const dlgBtn = (t) => [...(dialog()?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === t);
const lot = (over) => ({ id: "lot-1", name: "Tips", device: "", lot_number: "A1", unit: "piece", current_quantity: 12, quantity_received: 20, units_per_carton: null, pack_unit: null, expiry_date: null, date_added: "2026-01-01", item_type: "Reagent", deleted: false, ...over });

// 1. Validation before sending
await open([lot()]);
const v = [];
for (const a of ["-2", "2.5", "13", "1e2", "0"]) { await type(amountInput(), a); v.push([a, amountError(), saveBtn().disabled]); }
check("invalid amounts: a specific reason under the field, Save disabled (negative, fractional pieces, more than left, exponent, zero)", v, [
  ["-2", "Amount used can't be negative.", true],
  ["2.5", "Amount used must be a whole number of pieces.", true],
  ["13", "Only 12 pieces left in this Lot. Enter at most that — or, if more is really there, correct the Lot's quantity first (Edit Lot or Stock Count).", true],
  ["1e2", "Amount used must be written as a plain number (for example 2 or 2.5).", true],
  ["0", "Amount used must be more than 0.", true],
]);
await type(amountInput(), "");
check("empty amount: no nagging message, Save disabled", [amountError(), saveBtn().disabled], [null, true]);
await type(amountInput(), "3");
check("valid amount: no message, Save enabled", [amountError(), saveBtn().disabled], [null, false]);
await click(saveBtn());
check("sent once, with a reference id (v4 UUID) and the exact amount", [calls.length, /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(calls[0].logId), calls[0].amount, calls[0].reagentId], [1, true, 3, "lot-1"]);
check("confirmed success: no error shown; the window does not close itself (the parent closes it)", [saveError(), closed], [null, 0]);
await shut();
await open([lot({ unit: "mL", current_quantity: 100.5 })]);
await type(amountInput(), "0.25"); await click(saveBtn());
check("measured unit: 0.25 mL accepted and sent exactly", calls[0].amount, 0.25);
await shut();

// 2. Failures keep the window and entries; retry uses the SAME id
await open([lot()]);
await type(amountInput(), "4"); await type(noteInput(), "run 7");
next = { ok: false, outcome: "insufficient", available: 2, message: "Only 2 pieces left in this Lot now (another use may have just been recorded). Nothing was recorded." };
await click(saveBtn());
check("refused (insufficient): message shown, window open, entries kept, Save usable again", [saveError(), closed, amountInput().value, noteInput().value, saveBtn().disabled, saveBtn().textContent], ["Only 2 pieces left in this Lot now (another use may have just been recorded). Nothing was recorded.", 0, "4", "run 7", false, "Save log"]);
await type(amountInput(), "2");
check("editing the amount clears the old message", saveError(), null);
next = { ok: true, outcome: "saved" };
await click(saveBtn());
check("retry sends the SAME reference id (a retry can never record twice), with the corrected amount", [calls.length, calls[1].logId === calls[0].logId, calls[1].amount], [2, true, 2]);
await shut();

// 3. Repeated taps while saving → exactly one request
await open([lot()]);
await type(amountInput(), "1");
let release; next = new Promise((r) => { release = r; });
const b = saveBtn();
await click(b); await click(b); await click(b);
check("rapid taps while saving: exactly one request; 'Saving…' and disabled", [calls.length, saveBtn().textContent, saveBtn().disabled], [1, "Saving…", true]);
await A.act(async () => { release({ ok: false, outcome: "unknown", message: "The connection failed before the database answered, so it isn't known yet whether this use was recorded." }); }); await settle();
check("uncertain outcome: honest message, entries kept, retry possible", [/isn't known yet whether this use was recorded/.test(saveError() || ""), amountInput().value, saveBtn().disabled], [true, "1", false]);

// 4. Exit guard after an uncertain outcome
await click(closeBtn());
check("uncertain → closing asks first: explains it may be recorded and that a new window could record it twice; nothing closed", [closed, !!dialog(), /may already have been recorded/.test(dialog()?.textContent || ""), /recorded — and deducted — twice/.test(dialog()?.textContent || ""), /safest choice is to stay here/.test(dialog()?.textContent || "")], [0, true, true, true, true]);
check("focus goes to 'Stay in this window'", document.activeElement?.textContent?.trim(), "Stay in this window");
await click(dlgBtn("Stay in this window"));
check("Stay: dialog gone, window and entries kept", [dialog(), closed, amountInput().value], [null, 0, "1"]);
next = { ok: false, outcome: "not_confirmed", message: "The save could not be confirmed…" };
await click(saveBtn());
check("retry after uncertain → same id again", [calls.length, calls[1].logId === calls[0].logId], [2, true]);
await click(closeBtn()); await click(dlgBtn("Leave anyway"));
check("not_confirmed is uncertain too; 'Leave anyway' closes only after that explicit choice", closed, 1);
await shut();

await open([lot()]);
await type(amountInput(), "1");
next = () => Promise.reject(new Error("boom"));
await click(saveBtn()); await settle();
await click(closeBtn());
check("a thrown error is treated as uncertain (message + exit guard)", [/isn't known whether this use was recorded/.test(saveError() || ""), !!dialog(), closed], [true, true, 0]);
await shut();

await open([lot()]);
await type(amountInput(), "1");
next = { ok: false, outcome: "insufficient", message: "Only 0 pieces left…" };
await click(saveBtn());
await click(closeBtn());
check("after a confirmed refusal, closing works normally (no dialog)", [closed, dialog()], [1, null]);
await shut();
await open([lot()]);
await type(amountInput(), "1");
next = { ok: false, outcome: "unknown", message: "…" }; await click(saveBtn());
next = { ok: false, outcome: "lot_removed", message: "This Lot has been removed. Nothing was recorded." }; await click(saveBtn());
await click(closeBtn());
check("uncertain, then a definite refusal on retry (same id) → no longer blocked", [closed, dialog()], [1, null]);
await shut();

// 5. App wiring
const app = readSource("App.jsx");
const rc = app.slice(app.indexOf("async function recordConsumption("), app.indexOf("// Edit Lot save (lotEdit.js saveLotEdit)"));
check("recordConsumption records through saveLogUse (log_use) only — the old multi-write path is gone", [rc.includes("saveLogUse({ client: supabase, entry: { ...entry, unit: item.unit, lotToLot: needsLotToLot(item.device) }, actor: username })"), /from\("reagents"\)|from\("consumption_logs"\)|from\("lot_to_lot_pending"\)|Math\.max\(0/.test(rc)], [true, false]);
check("the window closes and reloads only on a confirmed save; the Lot-to-Lot notice comes from the database's answer", [/if \(result\.ok\) \{\s*setShowLog\(false\);\s*loadAll\(\);/.test(rc), rc.includes("if (result.lotToLotFlagged) setLotToLotNotice(")], [true, true]);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 22 });
