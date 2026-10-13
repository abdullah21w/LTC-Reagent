// U2c-3 — Log use packaging wording: the real LogConsumptionModal in jsdom.
// Display only: the saved payload must stay the typed amount in the lot's unit.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("U2c-3 · Log use window", async () => {
const env = setupDom();
const { w } = env;
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["LogConsumptionModal"] })] });

let root, host;
const sq = (t) => t.replace(/\s+/g, " ").trim();
const text = () => sq(host.textContent);
const lotSelect = () => [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith("Lot to use"))?.querySelector("select");
const option = () => { const s = lotSelect(); return s ? sq(s.options[s.selectedIndex].textContent) : ""; };
const usingNote = () => sq([...host.querySelectorAll("div")].find((d) => /^(Using|You picked) /.test(sq(d.textContent)) && d.children.length <= 3)?.textContent || "");
const amountLabel = () => [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith("Amount used"));
const amountInput = () => amountLabel().querySelector("input");
const hint = () => { const h = host.querySelector('[data-testid="log-pack-hint"]'); return h ? sq(h.textContent) : null; };
async function type(input, value) { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(input, value); await A.act(async () => { input.dispatchEvent(new w.Event("input", { bubbles: true })); }); }
async function click(el) { await A.act(async () => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }); }
const submitted = [];
async function open(lots) {
  host = document.createElement("div"); document.body.appendChild(host); root = A.createRoot(host);
  await A.act(async () => { root.render(A.createElement(A.LogConsumptionModal, { reagents: lots, presets: [], username: "tester", lotToLotPending: [], onClose() {}, onSubmit: (e) => submitted.push(e) })); });
}
const close = async () => { await A.act(async () => root.unmount()); host.remove(); };
const lot = (over) => ({ id: "x", name: "Item", device: "", lot_number: "A1", unit: "piece", current_quantity: 12, quantity_received: 20, units_per_carton: null, pack_unit: null, expiry_date: null, date_added: "2026-01-01", item_type: "Reagent", deleted: false, ...over });
const view = () => ({ option: option(), using: usingNote(), label: amountLabel() ? sq(amountLabel().textContent) : null, hint: hint() });
const NOTE = " Equivalents are calculated from the amount, not a count of sealed packages.";

// 1. Named package (Piece / Box / 5)
await open([lot({ name: "Tips", unit: "Piece", pack_unit: "Box", units_per_carton: 5 })]);
check("named: option, using note, label, packaging line", view(), {
  option: "Lot A1 · 12 pieces left · Equivalent: 2 boxes + 2 pieces · No expiry (FEFO suggestion)",
  using: "Using Lot A1 · 12 pieces left · Equivalent: 2 boxes + 2 pieces · No expiry date",
  label: "Amount used (pieces)",
  hint: `1 box = 5 pieces. Enter the amount in pieces.${NOTE}`,
});
await type(amountInput(), "7");
check("named: typed 7 → '7 pieces · Equivalent: 1 box + 2 pieces' (display only)", hint(), `1 box = 5 pieces. Enter the amount in pieces.${NOTE}7 pieces · Equivalent: 1 box + 2 pieces`);
await type(amountInput(), "3");
check("named: less than one package typed → no package reading", hint(), `1 box = 5 pieces. Enter the amount in pieces.${NOTE}`);
await type(amountInput(), "5");
check("named: exactly one package → singular '1 box'", hint().endsWith("5 pieces · Equivalent: 1 box"), true);
await type(amountInput(), "7");
await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Save log"));
check("saved payload: amount is the typed number in the lot's unit (no ×5, no ÷5)", (({ reagentId, amount, usedBy, note, testedByQC, replaceOnDevice, confirmLotToLotId }) => ({ reagentId, amount, usedBy, note, testedByQC, replaceOnDevice, confirmLotToLotId }))(submitted.at(-1) || {}), { reagentId: "x", amount: 7, usedBy: "tester", note: "", testedByQC: false, replaceOnDevice: true, confirmLotToLotId: null });
check("saved payload has exactly these keys", Object.keys(submitted.at(-1) || {}), ["reagentId", "amount", "date", "usedBy", "note", "testedByQC", "replaceOnDevice", "confirmLotToLotId"]);
await close();

// 2. Singular / plural
await open([lot({ current_quantity: 1, pack_unit: "box", units_per_carton: 5 })]);
check("singular: '1 piece left', no package reading below one package", view().option, "Lot A1 · 1 piece left · No expiry (FEFO suggestion)");
await close();
await open([lot({ current_quantity: 5, pack_unit: "carton", units_per_carton: 5 })]);
check("exactly one package: 'Equivalent: 1 carton'", view().option, "Lot A1 · 5 pieces left · Equivalent: 1 carton · No expiry (FEFO suggestion)");
await close();
await open([lot({ current_quantity: 0, pack_unit: "kit", units_per_carton: 1, unit: "test" })]);
check("zero left, package of 1: '0 tests left', '1 kit = 1 test'", [view().option, view().hint], ["Lot A1 · 0 tests left · No expiry (FEFO suggestion)", `1 kit = 1 test. Enter the amount in tests.${NOTE}`]);
await close();

// 3. Unnamed legacy package
await open([lot({ unit: "bottle ", units_per_carton: 6, current_quantity: 9 })]);
check("unnamed legacy: neutral wording, no invented name", view(), {
  option: "Lot A1 · 9 bottles left · Equivalent: 1 × 6-bottle pack + 3 bottles · No expiry (FEFO suggestion)",
  using: "Using Lot A1 · 9 bottles left · Equivalent: 1 × 6-bottle pack + 3 bottles · No expiry date",
  label: "Amount used (bottles)",
  hint: `Packs of 6 bottles (package name not recorded). Enter the amount in bottles.${NOTE}`,
});
check("unnamed legacy: the word 'box' appears nowhere", /\bbox(es)?\b/i.test(text()), false);
await close();

// 4. Single-unit lots
await open([lot({ unit: "box", current_quantity: 3 })]);
check("single-unit 'box' lot: '3 boxes left', label in boxes, no packaging line", view(), { option: "Lot A1 · 3 boxes left · No expiry (FEFO suggestion)", using: "Using Lot A1 · 3 boxes left · No expiry date", label: "Amount used (boxes)", hint: null });
await close();
await open([lot({ unit: "mL", current_quantity: 15.5 })]);
check("measured unit: '15.5 mL left', label (mL)", [view().option, view().label, view().hint], ["Lot A1 · 15.5 mL left · No expiry (FEFO suggestion)", "Amount used (mL)", null]);
await close();

// 5. Invalid legacy factors: never used to split
for (const f of [2.5, 0]) {
  await open([lot({ unit: "bottle", units_per_carton: f, current_quantity: 9 })]);
  check(`legacy box size ${f}: amounts in bottles only, honest note, no package reading`, [view().option, view().hint], ["Lot A1 · 9 bottles left · No expiry (FEFO suggestion)", `Recorded package size (${f}) isn't a whole number of 1 or more, so amounts are shown in bottles only. Enter the amount in bottles.`]);
  await type(amountInput(), "7");
  check(`legacy box size ${f}: typed amount gets no package reading, and no 'Equivalent' wording`, [hint().includes("="), hint().includes("Equivalent")], [false, false]);
  await close();
}

// 6. Two lots: FEFO order and per-lot wording; picking the other lot
await open([lot({ id: "a", lot_number: "A1", pack_unit: "box", units_per_carton: 5, current_quantity: 7, expiry_date: "2027-01-01" }), lot({ id: "b", lot_number: "B2", units_per_carton: 4, current_quantity: 8, expiry_date: "2027-06-01" })]);
const opts = [...host.querySelectorAll("option")].filter((o) => o.value === "a" || o.value === "b").map((o) => sq(o.textContent));
check("two lots: each option uses that lot's own packaging", opts, ["Lot A1 · 7 pieces left · Equivalent: 1 box + 2 pieces · Expires 2027-01-01 (FEFO suggestion)", "Lot B2 · 8 pieces left · Equivalent: 2 × 4-piece packs · Expires 2027-06-01"]);
const sel = lotSelect();
Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set.call(sel, "b");
await A.act(async () => { sel.dispatchEvent(new w.Event("change", { bubbles: true })); });
check("picking lot B2 switches the packaging line to B2's (unnamed)", view().hint, `Packs of 4 pieces (package name not recorded). Enter the amount in pieces.${NOTE}`);
check("no nested parentheses in the Using note or Lot options", [/\([^)]*\(/.test(usingNote()), [...lotSelect().options].some((o) => /\([^)]*\(/.test(o.textContent))], [false, false]);
await close();

// ── Static invariants of the current source ──
const app = readSource("App.jsx");
const m = app.slice(app.indexOf("function LogConsumptionModal("), app.indexOf("function EditReagentModal("));
check("old wording gone from the window ('/box)', 'full box', 'remaining', formatCartonQty)", [/\/box\)/.test(m), /full box/.test(m), /remaining/.test(m), /formatCartonQty/.test(app)], [false, false, false, false]);
const helpers = app.slice(app.indexOf("const qtyInUnit = "), app.indexOf("// U2b — quantity displays"));
check("Log use display helpers do no arithmetic on stored quantities and touch no database", [/(current_quantity|quantity_received|units_per_carton)\s*[-+*/]|[-+*/]\s*\w+\.(current_quantity|units_per_carton)/.test(helpers), /supabase|\.(insert|update|delete|rpc)\(/.test(helpers), helpers.length > 200], [false, false, true]);
check("the amount input keeps the typed text (value/onChange), converted only by Number() at submit", [m.includes('value={amount} onChange={(e) => setAmount(e.target.value)}'), /amount: Number\(amount\)/.test(m)], [true, true]);
check("the window writes nothing to the database itself", globalThis.__writes || [], []);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 25 });
