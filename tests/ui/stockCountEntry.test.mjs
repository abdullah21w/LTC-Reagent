// The real Stock Count screen (StockCount.jsx) in jsdom: package + loose entry on
// lines whose snapshot has packaging, the original single field otherwise; a count
// is saved only when focus leaves the line's fields, only when valid and changed,
// and shown as saved only after the database accepted it.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, ui } from "../helpers/dom.mjs";

// Programmable stub: counts and lines come from globalThis.__sc; updates are
// recorded with their payload and answered by __sc.updateResult().
const STUB = `
export const supabase = {
  from: (t) => {
    const st = { op: "select", payload: null, filters: [] };
    const b = new Proxy({}, { get: (_, k) => {
      if (k === "then") return (res, rej) => {
        const S = globalThis.__sc;
        let p;
        if (st.op === "update") { S.writes.push({ table: t, payload: st.payload, filters: st.filters }); p = Promise.resolve().then(() => (S.updateResult ? S.updateResult() : { data: null, error: null })); }
        else if (st.op !== "select") { S.writes.push({ table: t, op: st.op }); p = Promise.resolve({ data: null, error: null }); }
        else p = Promise.resolve({ data: t === "inventory_counts" ? S.sessions : t === "inventory_count_items" ? S.items : [], error: null });
        return p.then(res, rej);
      };
      if (k === "update") return (v) => { st.op = "update"; st.payload = v; return b; };
      if (["insert", "delete", "upsert"].includes(k)) return () => { st.op = k; return b; };
      if (k === "eq") return (f, v) => { st.filters.push([f, v]); return b; };
      return () => b;
    } });
    return b;
  },
  rpc: (n) => { globalThis.__sc.writes.push({ rpc: n }); return Promise.resolve({ data: null, error: null }); },
};
`;

suite("Stock Count window: package + loose entry", async () => {
const env = setupDom();
const A = await load({ contents: `export { default as StockCount } from "${src("StockCount.jsx")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB })] });
const U = ui(A, env.w);
const S = (globalThis.__sc = { writes: [], updateResult: null, sessions: [], items: [] });
const ln = (id, lot, over = {}) => ({ id, count_id: "c1", reagent_id: `r-${id}`, reagent_name: `Reagent ${lot}`, lot_number: lot, department: "Chemistry", unit: "piece", expected_quantity: 20, counted_quantity: null, resolved: false, packaging_snapshot: 1, pack_unit: "box", units_per_carton: 5, ...over });
S.sessions = [{ id: "c1", department: "Chemistry", status: "in_progress", started_by: "tester", started_at: "2026-10-13T08:00:00Z" }];
S.items = [
  ln("a", "TC-101"),                                                                        // named box of 5, not counted
  ln("b", "TC-102", { unit: "mL", pack_unit: "bottle", units_per_carton: 500, expected_quantity: 1500 }),
  ln("c", "TC-103", { pack_unit: null, units_per_carton: 10 }),                             // box size, no name recorded
  ln("d", "TC-104", { packaging_snapshot: null, pack_unit: null, units_per_carton: 5 }),    // created before U2a
  ln("e", "TC-105", { counted_quantity: 17 }),                                              // already counted
  ln("f", "TC-106", { counted_quantity: 10, resolved: true }),                              // resolved
  ln("g", "TC-107", { units_per_carton: 4 }),                                               // named box of 4
];
await U.mount(A.createElement(A.StockCount, { reagents: [], departments: ["Chemistry"], username: "tester", reload: () => {}, warnDays: 30 }));
await U.click([...U.host.querySelectorAll("button")].find((b) => /Chemistry/.test(b.textContent)));
await U.settle();

const row = (lot) => [...U.host.querySelectorAll("div")].find((d) => d.textContent.startsWith(`Lot ${lot} ·`))?.parentElement?.parentElement;
const inputs = (lot) => [...(row(lot)?.querySelectorAll("input") || [])];
const labels = (lot) => [...(row(lot)?.querySelectorAll("label") || [])].map((l) => l.textContent.replace(/\s+/g, " ").trim());
const tid = (lot, id) => row(lot)?.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const leave = async (input, to = null) => { await A.act(async () => { input.dispatchEvent(new env.w.FocusEvent("focusout", { bubbles: true, relatedTarget: to })); }); await U.settle(); };
const updates = () => S.writes.filter((w) => w.table === "inventory_count_items");
const sent = (i = -1) => { const u = updates().at(i); return u && { ...u.payload, counted_at: u.payload.counted_at ? "set" : u.payload.counted_at, id: u.filters[0]?.[1] }; };

// 1. Which lines get package + loose fields
const btn = (lot, t) => [...(row(lot)?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === t);
check("case 1 (named): 'Full boxes' + 'Loose pieces' shown directly, box size shown, no switch button", [labels("TC-101"), tid("TC-101", "count-packaging"), row("TC-101").querySelectorAll("button").length], [["Full boxes", "Loose pieces"], "1 box = 5 pieces", 0]);
check("case 1, measured unit: 'Full bottles' + 'Loose mL'", labels("TC-102"), ["Full bottles", "Loose mL"]);
check("case 2 (box size, no name): the normal quantity field by default, 'Package name not recorded' + factor, and the optional button", [inputs("TC-103").length, labels("TC-103"), tid("TC-103", "count-packaging"), !!btn("TC-103", "Calculate using packages")], [1, [], "Package name not recorded · 1 package = 10 pieces", true]);
check("case 3 (line from before U2a, no snapshot): only the quantity field, no packaging shown, no button", [inputs("TC-104").length, labels("TC-104"), tid("TC-104", "count-packaging"), row("TC-104").querySelectorAll("button").length], [1, [], null, 0]);

// 2. Moving between the two fields doesn't save; leaving the line does, once
const [boxA, looseA] = inputs("TC-101");
await U.type(boxA, "3");
await leave(boxA, looseA);
check("typing full boxes then moving to loose: nothing saved yet; running total shown", [updates().length, tid("TC-101", "count-total")], [0, "Counted: 3 boxes × 5 pieces = 15 pieces"]);
await U.type(looseA, "2");
check("3 boxes + 2 loose shows the calculation before saving", tid("TC-101", "count-total"), "Counted: 3 boxes × 5 pieces + 2 pieces = 17 pieces");
await leave(looseA);
check("leaving the line saves ONE update: counted 17 pieces (base units) with who/when, for that line only", [updates().length, sent()], [1, { counted_quantity: 17, counted_at: "set", counted_by: "tester", id: "a" }]);
check("after the save the fields show what was saved (3 + 2)", inputs("TC-101").map((i) => i.value), ["3", "2"]);

// 3. Reopening / navigating never changes a count by itself
const [boxE, looseE] = inputs("TC-105");
check("an already counted line (17) opens as 3 boxes + 2 loose", [boxE.value, looseE.value], ["3", "2"]);
await leave(boxE, looseE); await leave(looseE);
await U.type(boxE, "3"); await leave(boxE);
check("focus in and out, or retyping the same value: no write", updates().length, 1);

// 4. Validation: nothing invalid is saved; the reason is shown
await U.type(boxA, "1.5"); await leave(boxA);
check("fractional boxes: reason shown, nothing saved, entry kept", [tid("TC-101", "count-errors"), updates().length, inputs("TC-101")[0].value], ["Full boxes must be a whole number (count opened ones as loose pieces).", 1, "1.5"]);
await U.type(boxA, "3"); await U.type(looseA, "-1"); await leave(looseA);
check("negative loose: refused, nothing saved", [tid("TC-101", "count-errors"), updates().length], ["Loose pieces can't be negative.", 1]);
await U.type(looseA, "2"); await leave(looseA);
check("back to 3 + 2 (the saved count): no write, error gone", [updates().length, tid("TC-101", "count-errors")], [1, null]);

// 5. Measured, zero and clearing
const [btlB, looseB] = inputs("TC-102");
await U.type(btlB, "3"); await U.type(looseB, "0.1"); await leave(looseB);
check("3 bottles × 500 mL + 0.1 mL sent as exactly 1500.1", JSON.stringify(sent().counted_quantity), "1500.1");
const [pG, lG] = inputs("TC-107");
await U.type(pG, "0"); await U.type(lG, "0"); await leave(lG);
check("0 boxes + 0 loose is saved as a real count of 0", [sent().counted_quantity, sent().id], [0, "g"]);
await U.type(pG, "2"); await U.type(lG, "0"); await leave(lG);
check("positive boxes + 0 loose is valid: 2 × 4 + 0 = 8", [sent().counted_quantity, sent().id], [8, "g"]);
await U.type(pG, ""); await U.type(lG, ""); await leave(lG);
check("clearing both fields un-counts the line (null, who/when cleared)", sent(), { counted_quantity: null, counted_at: null, counted_by: null, id: "g" });

// 5b. Case 2: switching between the total and packages never writes and keeps the total exactly
const nSw = updates().length;
const [qC] = inputs("TC-103");
await U.type(qC, "21");
await U.click(btn("TC-103", "Calculate using packages"));
check("'Calculate using packages': package + loose fields appear with the entered 21 split exactly (2 + 1); still says the name isn't recorded; nothing written", [labels("TC-103"), inputs("TC-103").map((i) => i.value), tid("TC-103", "count-total"), tid("TC-103", "count-packaging"), updates().length - nSw], [["Full packages", "Loose pieces"], ["2", "1"], "Counted: 2 packages × 10 pieces + 1 piece = 21 pieces", "Package name not recorded · 1 package = 10 pieces", 0]);
await U.click(btn("TC-103", "Enter the total in pieces instead"));
check("switching back: the total field shows 21 again; still nothing written", [inputs("TC-103").map((i) => i.value), updates().length - nSw], [["21"], 0]);
await U.type(inputs("TC-103")[0], "2.5");
await U.click(btn("TC-103", "Calculate using packages"));
check("an invalid total is never converted: switch refused with the reason, entry '2.5' kept, still the total field, nothing written", [tid("TC-103", "count-switch-error"), inputs("TC-103").map((i) => i.value), updates().length - nSw], ["Fix this first, then switch: Counted quantity must be a whole number for this unit.", ["2.5"], 0]);
await U.type(inputs("TC-103")[0], "0");
await U.click(btn("TC-103", "Calculate using packages"));
check("a confirmed 0 stays a 0 when switching (0 + 0, not blank); switch error cleared", [inputs("TC-103").map((i) => i.value), tid("TC-103", "count-switch-error"), updates().length - nSw], [["0", "0"], null, 0]);
await U.type(inputs("TC-103")[0], "3"); await U.type(inputs("TC-103")[1], "4"); await leave(inputs("TC-103")[1]);
check("leaving the line after using packages saves once: 3 × 10 + 4 = 34 pieces", [updates().length - nSw, sent()], [1, { counted_quantity: 34, counted_at: "set", counted_by: "tester", id: "c" }]);
check("the chosen packages mode stays after the save, showing what was saved (3 + 4)", [labels("TC-103"), inputs("TC-103").map((i) => i.value)], [["Full packages", "Loose pieces"], ["3", "4"]]);
await U.click(btn("TC-103", "Enter the total in pieces instead")); await leave(inputs("TC-103")[0]);
check("switching back to the total of a saved count shows 34 and writes nothing (unchanged)", [inputs("TC-103").map((i) => i.value), updates().length - nSw], [["34"], 1]);

// 6. Base-unit line (no snapshot): validated now, saved as before
const [qD] = inputs("TC-104");
await U.type(qD, "2.5"); await leave(qD);
check("base-unit line: 2.5 pieces refused with the reason; nothing saved", [tid("TC-104", "count-errors"), updates().filter((u) => u.filters[0][1] === "d").length], ["Counted quantity must be a whole number for this unit.", 0]);
await U.type(qD, "7"); await leave(qD);
check("base-unit line: 7 saved (same statement as before)", sent(), { counted_quantity: 7, counted_at: "set", counted_by: "tester", id: "d" });

// 7. A refused or failed save keeps the entry and says so; retry works
const before = updates().length;
S.updateResult = () => ({ data: null, error: { message: "evidence_field_protected" } });
await U.type(boxA, "4"); await U.type(looseA, "0"); await leave(looseA);
check("refused save: message shown, entry kept (4 + 0), the line still holds its saved 17", [/wasn't saved/.test(tid("TC-101", "count-save-error") || ""), inputs("TC-101").map((i) => i.value), updates().length - before], [true, ["4", "0"], 1]);
S.updateResult = () => { throw new Error("Failed to fetch"); };
await leave(looseA);
check("a thrown network error is handled the same way (message, entry kept)", [/wasn't saved/.test(tid("TC-101", "count-save-error") || ""), inputs("TC-101").map((i) => i.value)], [true, ["4", "0"]]);
S.updateResult = null;
await leave(looseA);
check("retry after the problem: saved (20), message gone", [sent().counted_quantity, tid("TC-101", "count-save-error")], [20, null]);

// 8. One save at a time per line
let release; S.updateResult = () => new Promise((r) => { release = r; });
const n0 = updates().length;
await U.type(boxA, "5"); await leave(looseA); await leave(looseA); await leave(boxA);
check("leaving repeatedly while a save is in flight sends ONE update; 'Saving…' shown", [updates().length - n0, /Saving…/.test(row("TC-101").textContent)], [1, true]);
await A.act(async () => { release({ data: null, error: null }); }); await U.settle();
S.updateResult = null;
check("…then the line shows the saved 25 (5 boxes + 0)", inputs("TC-101").map((i) => i.value), ["5", "0"]);

// 9. Resolved lines are final
check("resolved line: both fields disabled", inputs("TC-106").map((i) => i.disabled), [true, true]);

// 10. Wiring
const sc = readSource("StockCount.jsx");
check("StockCount writes counts with the same statement as before (counted_quantity + counted_at/by on the line), and only there", [sc.includes(`update({ counted_quantity: next, ...observed }).eq("id", it.id)`), (sc.match(/from\("inventory_count_items"\)\.update\(/g) || []).length], [true, 1]);
check("no other writes happened (no reconciliation, no RPC, no Lot change)", S.writes.filter((w) => w.table !== "inventory_count_items").length, 0);
check("no React errors", env.errors, []);
await U.unmount();
env.close();
}, { expectedChecks: 35 });
