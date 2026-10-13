// Edit Lot window (App.jsx EditReagentModal), real component in jsdom:
// U0 render, U2c-1 save behaviour (errors keep the window open, one save per tap),
// U2c-2 package name UI and the lock on Lots with history. Database is stubbed.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("U0 · U2c-1 · U2c-2 · Edit Lot window", async () => {

const env = setupDom();
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { buildLotUpdate } from "${src("lotEdit.js")}"; export { createRoot } from "react-dom/client"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["EditReagentModal"] })] });
const U = ui(A, env.w);
const { w } = env;

// ═══ U0 — server render (history not loaded yet → unit/packaging locked) ═══
const html = (r) => A.renderToStaticMarkup(A.createElement(A.EditReagentModal, { reagent: r, onClose() {}, onSave() {} })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const packed0 = { id: "k", name: "Reagent C", lot_number: "TC-006", unit: "bottle ", quantity_received: 12, current_quantity: 9, low_stock_threshold: 2, units_per_carton: 6, expiry_date: null };
const plain0 = { id: "p", name: "Enzyme A", lot_number: "TA-147", unit: "box", quantity_received: 3, current_quantity: 2, low_stock_threshold: 2, units_per_carton: null, expiry_date: "2027-01-01" };
const a = html(packed0), b = html(plain0);
check("packaged lot renders labels in its unit", [a.includes("Quantity received (bottle)"), a.includes("Current quantity (bottle)"), a.includes("Low stock alert below (bottle)")], [true, true, true]);
check("packaged lot shows the stored units as packs (neutral wording, nothing converted)", [a.includes("= 2 × 6-bottle packs"), a.includes("= 1 × 6-bottle pack + 3 bottles")], [true, true]);
check("packaged lot explains the storage unit; no 'in boxes' label", [a.includes("Quantities are stored in bottle (the unit inside each package), never in packages."), /\(in boxes\)/.test(a)], [true, false]);
check("plain lot renders labels in its unit, no pack text", [b.includes("Quantity received (box)"), /× \d+-/.test(b)], [true, false]);
check("unchanged lot: no confirmation or block shown on open", [/I confirm/.test(a + b), /can't be changed/.test(a + b)], [false, false]);

// ── Static checks on App.jsx (current source) ──
const app = readSource("App.jsx");
const modal = app.slice(app.indexOf("function EditReagentModal("), app.indexOf("const DISCARD_REASONS"));
check("modal: no multiplication of quantities by units per box", /\*\s*(upc|Number\(unitsPerCarton\))|(quantity_received|current_quantity)\s*\*/.test(modal), false);
check("modal: saves only plan.payload, only when status is ok and something changed", [/onSave\(reagent, plan\.payload\)/.test(modal), /!canSave\) return/.test(modal), /const canSave = plan\.status === "ok" && pending\.length > 0/.test(modal)], [true, true, true]);
check("modal: history lookups are reads (select … head) on both tables; no writes", [(modal.match(/select\("id", \{ count: "exact", head: true \}\)/g) || []).length, /\.(insert|update|delete|upsert|rpc)\(/.test(modal)], [2, false]);
const save = app.slice(app.indexOf("async function saveEditedReagent("), app.indexOf("async function deleteReagent("));
check("App: saves through saveLotEdit; closes and reloads only when result.ok; warns when the activity entry failed", [save.includes("saveLotEdit("), /\.update\(/.test(save), /if \(result\.ok\) \{\s*setEditReagent\(null\);\s*loadAll\(\);[\s\S]*?if \(result\.auditLogged === false\) alert\(result\.warning\);\s*\}/.test(save)], [true, false, true]);
check("App: logActivity returns the insert result (so a failed entry is detectable)", /return await supabase\.from\("audit_log"\)\.insert\(/.test(app.slice(app.indexOf("async function logActivity("), app.indexOf("async function logActivity(") + 300)), true);

// ═══ U2c-1 — save behaviour ═══
const saveBtn = () => [...U.host.querySelectorAll("button")].find((x) => /Save changes|Saving…/.test(x.textContent));
const alertText = () => U.host.querySelector('[role="alert"]')?.textContent ?? null;
const lot = { id: "L1", name: "Reagent C", lot_number: "TC-006", unit: "bottle ", quantity_received: 12, current_quantity: 9, expiry_date: null, low_stock_threshold: 2, units_per_carton: 6 };
globalThis.__history = { logs: 0, countLines: 0 };
const calls = [];
let next = { ok: false, message: "The database refused the change (boom). Nothing was saved." };
const onSave = async (...x) => { calls.push(x); return typeof next === "function" ? next() : next; };
await U.mount(A.createElement(A.EditReagentModal, { reagent: lot, onClose() {}, onSave }));
check("opens with Save disabled and 'No changes to save yet.'", [saveBtn().disabled, U.text().includes("No changes to save yet.")], [true, true]);
await U.click(saveBtn());
check("clicking a disabled Save does nothing", calls.length, 0);
await U.type(U.inputByLabel("Low stock alert below"), "3");
check("after a change: Save enabled, 'No changes' gone", [saveBtn().disabled, U.text().includes("No changes to save yet.")], [false, false]);
await U.click(saveBtn());
check("save called once with (original row, payload)", [calls.length, calls[0][0].id, calls[0][1].low_stock_threshold], [1, "L1", 3]);
check("failure: error shown as an alert, window still open, Save usable again", [alertText(), U.text().includes("Edit lot TC-006"), saveBtn().disabled, saveBtn().textContent], ["The database refused the change (boom). Nothing was saved.", true, false, "Save changes"]);
await U.type(U.inputByLabel("Low stock alert below"), "4");
check("a new edit clears the previous save error", alertText(), null);
let release;
next = new Promise((r) => { release = r; });
const n0 = calls.length;
await U.click(saveBtn()); await U.click(saveBtn()); await U.click(saveBtn());
check("rapid repeated taps while saving → exactly one save call; button shows 'Saving…'", [calls.length - n0, saveBtn().textContent, saveBtn().disabled], [1, "Saving…", true]);
await A.act(async () => { release({ ok: false, message: "This lot was changed elsewhere since you opened it. Nothing was saved." }); });
await U.settle();
check("conflict result shown; nothing claims success", [/changed elsewhere/.test(alertText() || ""), saveBtn().textContent], [true, "Save changes"]);
next = () => Promise.reject(new Error("unexpected"));
await U.type(U.inputByLabel("Low stock alert below"), "5");
await U.click(saveBtn());
await U.settle();
check("a thrown error is caught and shown; window stays open", [alertText(), U.text().includes("Edit lot TC-006")], ["The change couldn't be saved. Nothing was saved.", true]);
next = { ok: true, changed: ["low_stock_threshold"] };
await U.type(U.inputByLabel("Low stock alert below"), "6");
await U.click(saveBtn());
await U.settle();
check("success: no error message", alertText(), null);
await U.unmount();

// ═══ U2c-2 — package name UI ═══
const btn = (t) => [...U.host.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
const packagingBox = () => [...U.host.querySelectorAll("label")].find((l) => /This item comes in packages/.test(l.textContent))?.querySelector("input");
const confirmBox = () => [...U.host.querySelectorAll("label")].find((l) => /I confirm the quantities/.test(l.textContent))?.querySelector("input");
const preview = () => U.host.querySelector('[data-testid="pack-preview"]')?.textContent.replace(/\s+/g, " ") ?? null;
const lockedPanel = () => U.host.querySelector('[data-testid="packaging-locked"]')?.textContent.replace(/\s+/g, " ") ?? null;
const other = () => U.host.querySelector('input[aria-label="Other package name"]');
const saved = [];
const open = async (r) => { saved.length = 0; await U.mount(A.createElement(A.EditReagentModal, { reagent: r, onClose() {}, onSave: async (...x) => { saved.push(x); return { ok: true, changed: [] }; } })); };
const plain = { id: "p", name: "Saline B", lot_number: "TB-1", unit: "bottle", quantity_received: 9, current_quantity: 9, low_stock_threshold: 2, units_per_carton: null, pack_unit: null, expiry_date: null };
const legacy = { id: "k", name: "Reagent C", lot_number: "TC-007", unit: "bottle ", quantity_received: 12, current_quantity: 9, low_stock_threshold: 2, units_per_carton: 6, pack_unit: null, expiry_date: null };
const named = { ...legacy, id: "n", lot_number: "TC-008", pack_unit: "box" };

globalThis.__history = { logs: 0, countLines: 0 };
await open(plain);
check("no history: unit editable, packaging checkbox shown, no lock panel", [U.inputByLabel("Unit").disabled, !!packagingBox(), lockedPanel()], [false, true, null]);
await U.click(packagingBox());
check("packaging on: the 8 preset names + Other… are buttons (no <datalist>)", [["Box", "Carton", "Pack", "Kit", "Case", "Bag", "Tray", "Rack", "Other…"].every((t) => btn(t)), U.host.querySelectorAll("datalist").length], [true, 0]);
check("no name chosen yet → 'Choose a package name', Save disabled", [/Choose a package name/.test(U.text()), saveBtn().disabled], [true, true]);
await U.click(btn("Box"));
await U.type(U.inputByLabel("bottle per"), "6");
check("preset Box + 6 → live preview, hint, size label, Box selected", [preview(), /= 1 box \+ 3 bottles/.test(U.text()), !!U.inputByLabel("bottle per box"), btn("Box").getAttribute("aria-pressed")], ["1 box = 6 bottles — preview only; stored quantities stay in bottle.", true, true, "true"]);
check("the preview changes no quantity field", [U.inputByLabel("Quantity received").value, U.inputByLabel("Current quantity").value], ["9", "9"]);
check("confirmation required before saving", [/Packaging is turned on: 1 box = 6 bottles/.test(U.text()), saveBtn().disabled], [true, true]);
await U.click(confirmBox());
await U.click(saveBtn());
check("saved payload: units_per_carton 6, pack_unit 'box', quantities exactly as before", [saved.length, saved[0]?.[1].units_per_carton, saved[0]?.[1].pack_unit, saved[0]?.[1].quantity_received, saved[0]?.[1].current_quantity], [1, 6, "box", 9, 9]);
await U.unmount();

await open(plain);
await U.click(packagingBox());
await U.click(btn("Other…"));
check("Other… shows a text input", !!other(), true);
await U.type(other(), "Sachet");
await U.type(U.inputByLabel("bottle per"), "10");
check("custom name preview keeps its spelling", preview(), "1 Sachet = 10 bottles — preview only; stored quantities stay in bottle.");
await U.type(other(), "x".repeat(41));
check("41-character name → error shown, Save disabled", [/at most 40 characters/.test(U.text()), saveBtn().disabled], [true, true]);
await U.type(other(), "mL");
check("measured name → error, Save disabled", [/is a measurement, not a package/.test(U.text()), saveBtn().disabled], [true, true]);
await U.type(other(), "bottles");
check("name equal to the unit → error, Save disabled", [/can't be the same as the unit inside it/.test(U.text()), saveBtn().disabled], [true, true]);
await U.type(other(), "  Sachet  ");
await U.type(U.inputByLabel("bottle per"), "2.5");
check("fractional size → whole-number error, Save disabled", [/a whole number of 1 or more/.test(U.text()), saveBtn().disabled], [true, true]);
await U.type(U.inputByLabel("bottle per"), "10");
await U.click(confirmBox());
await U.click(saveBtn());
check("custom name saved trimmed", [saved.length, saved[0]?.[1].pack_unit, saved[0]?.[1].units_per_carton], [1, "Sachet", 10]);
await U.unmount();

await open(plain);
await U.click(packagingBox());
await U.click(btn("Other…"));
await U.type(other(), "Sachet");
await U.click(btn("Kit"));
check("preset after Other: input hidden, Kit selected", [other(), btn("Kit").getAttribute("aria-pressed"), btn("Other…").getAttribute("aria-pressed")], [null, "true", "false"]);
await U.unmount();

globalThis.__history = { logs: 4, countLines: 1 };
await open(named);
check("history: lock panel with saved values and the reason", [lockedPanel()?.includes("Unit and packaging (locked)"), lockedPanel()?.includes("Unit: bottle"), lockedPanel()?.includes("Packaging: 1 box = 6 bottles"), lockedPanel()?.includes("4 usage logs and 1 Stock Count line recorded in bottles")], [true, true, true, true]);
check("history: unit input disabled; no packaging checkbox, no name buttons, no size input", [U.inputByLabel("Unit").disabled, packagingBox() ?? null, btn("Box") ?? null, U.inputByLabel("bottle per") ?? null], [true, null, null, null]);
check("history: existing breakdown still shown with the saved name", /= 1 box \+ 3 bottles/.test(U.text()), true);
await U.type(U.inputByLabel("Current quantity"), "8");
await U.click(saveBtn());
check("history: ordinary edit saves; packaging values unchanged and not among written fields", [saved.length, saved[0]?.[1].pack_unit, saved[0]?.[1].units_per_carton, A.buildLotUpdate(named, saved[0]?.[1]).changed], [1, "box", 6, ["current_quantity"]]);
await U.unmount();
await open(legacy);
check("history, legacy lot without a name → 'package name not recorded'", lockedPanel()?.includes("Packaging: 1 package = 6 bottles (package name not recorded)"), true);
await U.unmount();
await open(plain);
check("history, unpackaged lot → 'Not packaged'", lockedPanel()?.includes("Packaging: Not packaged — counted in single bottles"), true);
await U.unmount();

globalThis.__history = { error: true };
await open(named);
check("lookup failed: locked, says history couldn't be checked; other fields editable", [/couldn't be checked/.test(lockedPanel() || ""), U.inputByLabel("Unit").disabled, U.inputByLabel("Low stock alert below").disabled], [true, true, false]);
await U.unmount();
globalThis.__history = { hang: true };
await open(plain);
check("loading: locked, 'Checking this lot's history…'", [/Checking this lot's history/.test(lockedPanel() || ""), U.inputByLabel("Unit").disabled, packagingBox() ?? null], [true, true, null]);
await U.unmount();

globalThis.__history = { logs: 0, countLines: 0 };
await open(named);
check("no history, named lot: Box pre-selected, preview shown", [btn("Box").getAttribute("aria-pressed"), preview()], ["true", "1 box = 6 bottles — preview only; stored quantities stay in bottle."]);
await U.click(packagingBox());
check("turning packaging off: name controls gone, confirmation asked", [btn("Box") ?? null, /Packaging is turned off/.test(U.text())], [null, true]);
await U.click(confirmBox());
await U.click(saveBtn());
check("disable saved: units_per_carton null AND pack_unit null; quantities unchanged", [saved[0]?.[1].units_per_carton, saved[0]?.[1].pack_unit, saved[0]?.[1].quantity_received, saved[0]?.[1].current_quantity], [null, null, 12, 9]);
await U.unmount();
await open(legacy);
check("legacy unnamed: no name selected, no error shown", [[...U.host.querySelectorAll("button")].filter((x) => x.getAttribute("aria-pressed") === "true").length, /Choose a package name/.test(U.text())], [0, false]);
await U.type(U.inputByLabel("Low stock alert below"), "3");
await U.click(saveBtn());
check("legacy unnamed: unrelated edit saves; pack_unit stays null", [saved.length, saved[0]?.[1].pack_unit, A.buildLotUpdate(legacy, saved[0]?.[1]).changed], [1, null, ["low_stock_threshold"]]);
await U.unmount();
await open({ ...named, pack_unit: "Sachet" });
check("saved custom name: Other… selected, input holds it", [btn("Other…").getAttribute("aria-pressed"), other()?.value], ["true", "Sachet"]);
await U.unmount();

check("the window itself never writes to the database (reads only)", globalThis.__writes || [], []);
check("no React errors during the interactions", env.errors, []);
env.close();
}, { expectedChecks: 51 });
