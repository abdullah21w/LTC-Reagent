// U2b — screens that aggregate stock, on the synthetic inventory: amounts in different
// units are never combined, legacy packaging is never named, low evidence is shown the
// same way everywhere. Real components; database stubbed; network blocked.
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { suite, check, load, src, appPlugin, rootPath, CACHE } from "../helpers/core.mjs";
import { setupDom, ui, STUB_SUPABASE } from "../helpers/dom.mjs";
import { buildInventory } from "../fixtures/inventory.mjs";

suite("U2b · stock screens, reports and PDFs", async () => {
const env = setupDom();
const A = await load({ contents: `export * from "${src("App.jsx")}"; export { default as Charts } from "${src("Charts.jsx")}"; export { buildGroups } from "${src("forecast.js")}"; export { createRoot } from "react-dom/client"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement, act } from "react"; export * as RP from "@react-pdf/renderer";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE, appExports: ["compareLots", "daysBetween", "hasInspectionIssue", "isExpiringSoonItem", "Dashboard", "DetailView", "ReorderPage", "HistoryPage", "PublicSummaryPage", "DevicesBoard", "buildReportPdfDoc"] })] });
const U = ui(A, env.w);
const { reagents: R, logs: L, today, d } = buildInventory();
const envFor = (t) => ({ snoozes: [], warnDays: 30, today: t, compareLots: A.compareLots, daysBetween: A.daysBetween, hasInspectionIssue: A.hasInspectionIssue, isExpiringSoonItem: A.isExpiringSoonItem });
const groups = A.buildGroups(R, L, envFor(today));
const G = Object.fromEntries(groups.map((g) => [g.name, g]));
const counts = { red: 0, yellow: 0, green: 0, flagged: 0, lowStock: 0, expiringSoon: 0 };
groups.forEach((g) => { counts[g.status]++; if (g.lowStock) counts.lowStock++; if (g.expiringSoon) counts.expiringSoon++; });
const text = () => U.textOf(U.host);
const totalConsumed = () => (text().match(/Total consumed — [\d-]+ to [\d-]+ ([\d.]+) (\S+)/) || []).slice(1).join(" ");
const detailProps = (g) => ({ group: g, logs: L, allReagents: R, allLogs: L, coverageDays: 30, can: () => true, warnDays: 30, onBack() {}, onEditReagent() {}, onDeleteReagent() {}, onDiscardReagent() {}, onEditLog() {}, onDeleteLog() {}, onSnooze() {}, onUnsnooze() {} });
const tab = (label) => [...U.host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent.startsWith(label));

// ── 1. Charts unit picker ──
await U.mount(A.createElement(A.Charts, { reagents: R.filter((r) => r.name === "Analyte U"), logs: L, departments: [] }));
await U.type(U.host.querySelectorAll('input[type="date"]')[0], d(90));
check("Charts (box + Piece usage): picker offers both units", [text().includes("recorded in 2 different units"), U.buttons("box").length, U.buttons("Piece").length], [true, 1, 1]);
check("Charts: default unit = most used in range (Piece), total in Piece only", totalConsumed(), "13 Piece");
await U.click(U.buttons("box")[0]);
check("Charts: switch to box → box usage only (1 box)", totalConsumed(), "1 box");
await U.click(U.buttons("Piece")[0]);
check("Charts: switch back → 13 Piece again; never a combined 14", [totalConsumed(), /\b14 (box|Piece)/.test(text())], ["13 Piece", false]);
await U.unmount();
await U.mount(A.createElement(A.Charts, { reagents: R.filter((r) => r.name === "Analyte P"), logs: L, departments: [] }));
await U.type(U.host.querySelectorAll('input[type="date"]')[0], d(90));
check("Charts (stock in box + Piece, usage only in box): default box (2 box), Piece 0 — never a sum", totalConsumed(), "2 box");
await U.click(U.buttons("Piece")[0]);
check("Charts: Piece selected → 0 Piece", totalConsumed(), "0 Piece");
await U.unmount();

// ── 2. History search and per-unit totals ──
await U.mount(A.createElement(A.HistoryPage, { reagents: R, logs: L }));
const search = U.host.querySelector('input[placeholder="Search a reagent name…"]');
await U.type(search, "Analyte P");
check("History: remaining shown per unit '1 box · 15 Piece'", text().includes("Currently remaining (all lots) 1 box · 15 Piece"), true);
check("History: received per unit '3 box · 15 Piece', never one sum", [text().includes("Total ever received 3 box · 15 Piece"), text().includes("Total ever received 18 ")], [true, false]);
await U.type(search, "Kit Q");
check("History: ended box lot and bottle lots kept apart", /Currently remaining \(all lots\) \d+ box · 12 bottle/.test(text()), true);
await U.type(search, "Enzyme A");
check("History (one unit): one total per field, no separator", /Currently remaining \(all lots\) \d+ box Total ever received \d+ box /.test(text()), true);
await U.unmount();

// ── 3. DetailView ──
await U.mount(A.createElement(A.DetailView, detailProps(G["Analyte P"])));
check("DetailView mixed: two forecast blocks, How collapsed", [text().includes("Status & forecast — stock in box"), text().includes("Status & forecast — stock in Piece"), text().includes("Only lots recorded in box are added here")], [true, true, false]);
await U.click(U.buttons("How these numbers are calculated")[0]);
check("DetailView mixed: 'How' expands both unit blocks, each adds only its own lots", [text().includes("Only lots recorded in box are added here"), text().includes("Only lots recorded in Piece are added here"), /= 16 (box|Piece)/.test(text())], [true, true, false]);
check("DetailView mixed: low stock judged per unit (box low)", text().includes("Low stock: 1 box left, at or below the threshold of 1 box"), true);
await U.click(U.buttons("How the expiry outlook is estimated")[0]);
check("DetailView mixed: expiry outlook rates per unit", [text().includes("Usage rate (box)"), text().includes("Usage rate (Piece)")], [true, true]);
await U.click(tab("All lots"));
const lotCards = text().split("All lots — newest received first")[1] || "";
check("DetailView mixed 'All lots': each lot shows its own unit", [/Received qty 3 box/.test(lotCards), /Received qty 15 Piece/.test(lotCards)], [true, true]);
await U.click(tab("In stock"));
check("DetailView mixed 'In stock': lot quantities in their own units, Piece lot with neutral pack text", [text().includes("1 box"), text().includes("15 Piece"), text().includes("5 × 3-piece packs")], [true, true, true]);
check("DetailView mixed: snooze offered (group is low through its box part)", U.buttons("Snooze low-stock alert").length, 1);
await U.unmount();
await U.mount(A.createElement(A.DetailView, detailProps(G["Analyte N"])));
check("DetailView: one Piece forecast; box usage listed separately as another unit", [text().includes("Usage in another unit: 1 box"), text().includes("Stock is recorded in")], [true, false]);
check("DetailView: low-evidence warning (corrections only)", [text().includes("Low evidence: based only on stock-count corrections"), text().includes("treat as a rough estimate")], [true, true]);
await U.click(U.buttons("How these numbers are calculated")[0]);
check("DetailView: usage row = 12 Piece from 1 log, recorded by stock-count corrections", [text().includes("12 Piece from 1 usage log"), text().includes("recorded by stock-count corrections")], [true, true]);
await U.unmount();
await U.mount(A.createElement(A.DetailView, detailProps(G["Reference L"])));
await U.click(tab("All lots"));
check("DetailView 'All lots': ended box lot in box, bottle lots in bottle", [/Received qty \d+ box/.test(text()), /Received qty 8 bottle/.test(text())], [true, true]);
await U.unmount();

// ── 4. Mixed-unit navigation, run-out rail, Reorder, Public summary ──
let selected = null;
await U.mount(A.createElement(A.Dashboard, { groups, counts, departments: [...new Set(R.map((r) => r.department))], devices: [], logs: L, reagents: R, can: () => true, onDeleteReagent() {}, onDiscardReagent() {}, onSelect: (g) => { selected = g; }, onViewDevices() {}, onSnooze() {}, onUnsnooze() {} }));
const railRow = (name) => [...U.host.querySelectorAll(".dash-click")].find((el) => el.textContent.includes(name) && /~\d+d/.test(el.textContent));
check("Dashboard rail: mixed group shows the box part's rate and stock, labelled (single log → low evidence)", railRow("ZZ mixed")?.textContent.replace(/\s+/g, " ").trim() ?? null, "ZZ mixed~0.1 box/day · 1 box left (box stock only) · low evidence~10d");
check("Dashboard rail: corrections-only forecast flagged, with the full reason on hover", [railRow("XX corr")?.textContent.replace(/\s+/g, " ").trim(), railRow("XX corr")?.querySelector("span[title]")?.getAttribute("title")], ["XX corr~0.1 box/day · 1 box left · low evidence~10d", "Low evidence: based only on stock-count corrections"]);
check("Dashboard rail: normal-evidence forecast NOT flagged", railRow("YY normal")?.textContent.replace(/\s+/g, " ").trim(), "YY normal~0.2 bottle/day · 2 bottle left~10d");
await U.click(railRow("XX corr"));
check("Dashboard rail: flagged row still navigates", selected?.key, "XX corr::");
selected = null;
await U.click(railRow("ZZ mixed"));
check("Dashboard: clicking the run-out row navigates to that mixed group", [selected?.key, selected?.mixedUnits], ["ZZ mixed::", true]);
selected = null;
const row = [...U.host.querySelectorAll(".dash-row")].find((el) => el.textContent.includes("ZZ mixed"));
await U.click(row.querySelector(".dash-row-main"));
check("Dashboard: expanded mixed row shows per-unit quantity and last use in its lot's unit", [U.textOf(row).includes("1 box · 30 Piece (different units — not added together)"), /Last used.*· 3 box by tester|· 1 Piece by tester/.test(row.textContent.replace(/\s+/g, " "))], [true, true]);
await U.click([...row.querySelectorAll("button")].find((b) => b.textContent.includes("View full detail")));
check("Dashboard: 'View full detail' navigates to the mixed group", selected?.key, "ZZ mixed::");
check("Dashboard 14-day activity: metric labelled as a count of entries, not quantities", [text().includes("Usage entries, all departments"), text().includes("usage entries logged (a count of entries, not quantities)"), text().includes("units consumed")], [true, true, false]);
await U.unmount();
selected = null;
await U.mount(A.createElement(A.ReorderPage, { groups, coverageDays: 30, onSelectGroup: (g) => { selected = g; } }));
const reorderRow = (name) => [...U.host.querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes(name));
const zzRows = [...U.host.querySelectorAll("tbody tr")].filter((tr) => tr.textContent.includes("ZZ mixed"));
check("Reorder: one row for the box part (single log → low evidence); no Piece row", zzRows.map((tr) => tr.textContent.replace(/\s+/g, " ").trim()), ["ZZ mixed (box)—0.1 box1 box2 boxLow evidence"]);
check("Reorder: corrections-only row flagged (same numbers), normal row not", [reorderRow("XX corr")?.textContent.replace(/\s+/g, " ").trim(), reorderRow("YY normal")?.textContent.replace(/\s+/g, " ").trim()], ["XX corr—0.1 box1 box2 boxLow evidence", "YY normal—0.2 bottle2 bottle4 bottle"]);
check("Reorder: legend explains the flag; hover gives the exact reason", [text().includes("Low evidence = the usage rate rests only on stock-count corrections or on a single usage log"), reorderRow("XX corr")?.querySelector("div[title]")?.getAttribute("title")], [true, "Low evidence: based only on stock-count corrections"]);
await U.click(zzRows[0]);
check("Reorder: clicking a unit row opens the whole mixed group", [selected?.key, selected?.mixedUnits], ["ZZ mixed::", true]);
await U.unmount();
await U.mount(A.createElement(A.DetailView, detailProps(G["ZZ mixed"])));
check("DetailView mixed (navigated): box block 10 days left; Piece block 900 days", [/stock in box.*Days left 10 days/.test(text()), /stock in Piece.*Days left 900 days/.test(text())], [true, true]);
check("DetailView mixed: single-log warning on both unit blocks (one log each)", (text().match(/Low evidence: based on a single usage log/g) || []).length, 4);
await U.unmount();
await U.mount(A.createElement(A.DetailView, detailProps(G["YY normal"])));
check("DetailView normal evidence: no warning, normal wording", [text().includes("Low evidence"), text().includes("At the current usage rate")], [false, true]);
await U.unmount();
await U.mount(A.createElement(A.DetailView, detailProps(G["XX corr"])));
check("DetailView corrections-only: same warning as the lists", [text().includes("Low evidence: based only on stock-count corrections"), text().includes("Days left 10 days")], [true, true]);
await U.unmount();
await U.mount(A.createElement(A.PublicSummaryPage, { groups, counts, logs: L, reagents: R, departments: [] }));
const pubRow = (name) => U.textOf([...U.host.querySelectorAll("div")].reverse().find((el) => el.textContent.startsWith(name) && /d left/.test(el.textContent)) || U.host);
check("Public summary run-out list: flagged only where low evidence", [pubRow("XX corr"), pubRow("YY normal")], ["XX corr ~ 10 d left · low evidence", "YY normal ~ 10 d left"]);
check("Public summary: per-unit quantities, no NaN/undefined", [/NaN|undefined/.test(text()), text().includes("1 box · 15 Piece")], [false, true]);
await U.unmount();

// ── 5. Server renders of every group and board ──
const txt = (el) => A.renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
check(`DetailView renders for all ${groups.length} groups without NaN/undefined`, groups.filter((g) => /NaN|undefined/.test(txt(A.createElement(A.DetailView, detailProps(g))))).map((g) => g.key), []);
const dev = txt(A.createElement(A.DevicesBoard, { reagents: R, devices: [...new Set(R.map((r) => r.device).filter(Boolean))].map((x, i) => ({ id: i, name: x, department: "Chemistry" })), warnDays: 30, can: () => true, onEdit() {}, onDelete() {}, onDiscard() {} }));
check("DevicesBoard renders; packaged lots use neutral wording", [/NaN|undefined/.test(dev), /full box|\d+ boxes \(/.test(dev)], [false, false]);
const reorderHtml = txt(A.createElement(A.ReorderPage, { groups, coverageDays: 30, onSelectGroup() {} }));
check("Reorder page renders; no NaN / null / undefined", [/NaN|null|undefined/.test(reorderHtml), reorderHtml.includes("Suggested reorders")], [false, true]);

// ── 6. PDFs ──
const lotById = Object.fromEntries(R.map((r) => [r.id, r]));
const doc = A.buildReportPdfDoc(A.RP, { matchedLots: R, matchedLogs: L.filter((l) => !l.deleted), matchedDiscards: R.filter((r) => r.discard_reason), reagentById: lotById, dateFrom: d(90), dateTo: today, deptLabel: "All departments" });
const pdf = await A.RP.renderToBuffer(doc);
check("Reports page PDF renders", [pdf.slice(0, 4).toString(), pdf.length > 5000], ["%PDF", true]);
const realFetch = globalThis.fetch;
const fetched = [], external = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith("data:")) return realFetch(url, opts); // @react-pdf's bundled layout engine (local)
  if (!String(url).startsWith("https://mock.invalid/rest/v1/")) { external.push(String(url)); throw new Error("blocked external fetch " + url); }
  fetched.push([String(url).replace(/\?.*/, ""), opts?.method || "GET"]);
  const t = String(url).match(/rest\/v1\/(\w+)/)[1];
  const body = t === "app_config" ? [{ id: 1, expiry_warning_days: 30 }] : t === "reagents" ? R : t === "consumption_logs" ? L : null;
  if (!body) throw new Error("unexpected fetch " + url);
  return { json: async () => JSON.parse(JSON.stringify(body)) };
};
let monthly;
try {
  const RB = await import(pathToFileURL(rootPath("api", "_reportBuilder.js")).href);
  const [y, mo] = d(30).split("-").map(Number);
  monthly = await RB.buildMonthlyReport({ SUPABASE_URL: "https://mock.invalid", SUPABASE_KEY: "test", year: y, month: mo });
} finally { globalThis.fetch = realFetch; }
const buf = Buffer.isBuffer(monthly) ? monthly : monthly?.buffer || monthly;
check("monthly report: api/_reportBuilder.js runs under plain Node ESM (as on Vercel) and renders a PDF", Buffer.from(buf).slice(0, 4).toString(), "%PDF");
check("monthly report: only GET reads of 3 tables (mocked), no other network call, nothing written", [fetched.every(([, m]) => m === "GET"), [...new Set(fetched.map(([u]) => u.split("/").pop()))].sort(), external], [true, ["app_config", "consumption_logs", "reagents"], []]);
const vercel = await esbuild.build({ entryPoints: [rootPath("api", "generate-report.js"), rootPath("api", "send-monthly-report.js")], bundle: true, platform: "node", format: "esm", outdir: `${CACHE}/vercel-${process.pid}`, logLevel: "silent", packages: "external", metafile: true });
check("serverless entry points bundle and include ../units.js (Vercel-style resolution)", Object.keys(vercel.metafile.inputs).some((p) => p.endsWith("units.js")), true);

// Known, intended behaviour: opening the public summary records one visit row (why it is never opened on the live site during checks).
check("the only write from these screens is the public summary visit row", globalThis.__writes || [], [["public_view_visits", "insert"]]);
check("no React errors or warnings", env.errors, []);
env.close();
}, { expectedChecks: 48 });
