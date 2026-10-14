// Atomic edit / undo — the real Edit consumption log window (EditLogModal) in jsdom:
// Spread disabled (no way to reach the old destructive path), amount validated before
// sending, one request per tap burst, failures keep the window and entries with the
// message, retries reuse the window's request id. Plus App's wiring of edit and undo.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Atomic edit / undo · Edit log window", async () => {
const env = setupDom();
const { w } = env;
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["EditLogModal"] })] });
let root, host, closed = 0;
const calls = [];
let next;
const onSave = async (u, orig) => { calls.push([u, orig]); return typeof next === "function" ? next() : next; };
const log = { id: "log-1", reagent_id: "lot-1", amount: 3, date: "2026-10-01", used_by: "tester", note: "", tested_by_qc: false, date_provenance: "manual", source_count_item_id: null, deleted: false };
const lot = { id: "lot-1", unit: "piece", current_quantity: 2 };
async function open() {
  calls.length = 0; closed = 0;
  host = document.createElement("div"); document.body.appendChild(host); root = A.createRoot(host);
  await A.act(async () => { root.render(A.createElement(A.EditLogModal, { log, lot, onClose() { closed++; }, onSave })); });
}
const shut = async () => { await A.act(async () => root.unmount()); host.remove(); };
async function type(input, value) { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(input, value); await A.act(async () => { input.dispatchEvent(new w.Event("input", { bubbles: true })); }); }
async function click(el) { if (!el) throw new Error("nothing to click"); await A.act(async () => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }); }
const input = (label) => [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith(label))?.querySelector("input");
const btn = (t) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const saveBtn = () => [...host.querySelectorAll("button")].find((b) => /^(Save|Saving…)/.test(b.textContent.trim()));
const tid = (id) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

// 1. Spread disabled
await open();
await click(btn("Spread over a range"));
check("'Spread over a range' is disabled, explains why, and clicking it changes nothing (no range fields)", [btn("Spread over a range").disabled, tid("spread-unavailable"), !!input("From"), !!input("Date"), /total across the range/.test(host.textContent)], [true, "Spreading an entry over a date range is temporarily unavailable while a version that keeps the original entry in the history is being developed. Use \"Exact date\" for now.", false, true, false]);

// 2. Validation before sending
const v = [];
for (const a of ["6", "0", "2.5", "1e1"]) { await type(input("Amount"), a); v.push([a, tid("edit-amount-error"), saveBtn().disabled]); }
check("invalid amounts: reason shown, Save disabled (over old + left, zero, fractional pieces, exponent)", v, [
  ["6", "This Lot has only 2 pieces left, so this entry can be at most 5. To record more, correct the Lot's quantity first (Edit Lot or Stock Count).", true],
  ["0", "Amount used must be more than 0.", true],
  ["2.5", "Amount used must be a whole number of pieces.", true],
  ["1e1", "Amount used must be written as a plain number (for example 2 or 2.5).", true],
]);
await type(input("Amount"), "5");
check("valid (5 = 3 + the 2 left): no message, Save enabled", [tid("edit-amount-error"), saveBtn().disabled], [null, false]);

// 3. Submission: one request per burst; failure keeps everything; retry with the same id
let release; next = new Promise((r) => { release = r; });
await type(input("Note"), "corrected");
const b = saveBtn();
await click(b); await click(b); await click(b);
check("rapid taps while saving → exactly one request; it carries a request id, the exact amount and no spread", [calls.length, /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(calls[0][0].requestId), calls[0][0].amount, calls[0][0].spreadMode, calls[0][1] === log], [1, true, 5, false, true]);
await A.act(async () => { release("This entry was changed by someone else since you opened it, so nothing was saved. Close this window, reload the page and try again with the current values."); });
await A.act(async () => {});
check("a refusal (stale) is shown; entries kept; Save usable again; the window stays open", [tid("edit-refusal"), input("Amount").value, input("Note").value, saveBtn().disabled, closed], ["This entry was changed by someone else since you opened it, so nothing was saved. Close this window, reload the page and try again with the current values.", "5", "corrected", false, 0]);
next = undefined;
await click(saveBtn());
check("retry sends the SAME request id (the change can only ever be applied once)", [calls.length, calls[1][0].requestId === calls[0][0].requestId], [2, true]);
check("confirmed: no message (the parent closes the window)", tid("edit-refusal"), null);
await shut();
await open();
next = () => Promise.reject(new Error("boom"));
await click(saveBtn()); await A.act(async () => {});
check("a thrown error: honest 'not known' message, entries kept, Save again possible", [/isn't known whether this change was saved/.test(tid("edit-refusal") || ""), saveBtn().disabled], [true, false]);
await type(input("Note"), "x");
check("typing again clears the old message", tid("edit-refusal"), null);
await shut();

// 4. App wiring
const app = readSource("App.jsx");
const ed = app.slice(app.indexOf("async function saveEditedLog("), app.indexOf("async function deleteLog("));
const unStart = app.indexOf("async function deleteLog(");
const un = app.slice(unStart, app.indexOf("\n  async function ", unStart)); // deleteLog's own body only (the next function, purgeReagent, erases on purpose)
check("edit: through saveLogEdit only; Spread refused before anything is sent; the old multi-write path is gone", [ed.includes("saveLogEdit({ client: supabase, request: {"), ed.includes("if (updated.spreadMode) return SPREAD_UNAVAILABLE;"), /from\("reagents"\)|from\("consumption_logs"\)|Math\.max\(0|buildSpreadEntries/.test(ed), /buildSpreadEntries/.test(app)], [true, true, false, false]);
check("undo: the same confirmation, one undo per entry at a time, through saveLogUndo with a fresh request id; no direct writes", [un.includes('confirm("Remove this log entry? The amount will be added back to stock, but it stays in Reports for audit purposes.")'), un.includes("if (undoInFlight.current.has(log.id)) return;"), un.includes("saveLogUndo({ client: supabase, request: { requestId: newRequestId(), log }, actor: username })"), /from\("reagents"\)|from\("consumption_logs"\)|logActivity\(/.test(un)], [true, true, true, false]);
check("the window closes only on a confirmed save; a stale refusal reloads the data", [/if \(result\.ok\) \{\s*setEditLog\(null\);\s*loadAll\(\);\s*return;\s*\}/.test(ed), ed.includes('if (result.outcome === "stale" || result.outcome === "log_not_found") loadAll();')], [true, true]);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 13 });
