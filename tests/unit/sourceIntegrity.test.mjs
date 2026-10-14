// Every name the app's code uses must be defined somewhere. A build does not catch an
// undefined name inside a component — it only fails in the browser, when that code runs
// (e.g. the Reports page crashed with "purgeReagent is not defined" after the function
// was removed by mistake while its Reports prop stayed). Static scope analysis of every
// app source file, plus the restored purgeReagent and the Reports wiring.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { suite, check, rootPath, readSource } from "../helpers/core.mjs";

suite("Source integrity · no undefined names (purgeReagent regression)", async () => {
// Babel comes with the app's own build tooling (@vitejs/plugin-react) in the repository's node_modules.
const req = createRequire(rootPath("package.json"));
const { parse } = req("@babel/parser");
const traverse = req("@babel/traverse").default;
const ast = (code) => parse(code, { sourceType: "module", plugins: ["jsx"] });
/** Names referenced in `code` that no declaration, import or parameter defines. */
const unbound = (code) => { let g = []; traverse(ast(code), { Program(p) { g = Object.keys(p.scope.globals); p.stop(); } }); return g.sort(); };

// Standard browser / Node runtime globals the app uses on purpose, plus Vite's build-time constant.
const RUNTIME = new Set(["Array", "Boolean", "BroadcastChannel", "Buffer", "Date", "Error", "Infinity", "JSON", "Map", "Math", "NaN", "Notification", "Number", "Object", "Promise", "Set", "String", "URL", "URLSearchParams", "Uint8Array", "alert", "clearInterval", "clearTimeout", "confirm", "console", "document", "fetch", "globalThis", "localStorage", "navigator", "process", "setInterval", "setTimeout", "undefined", "window", "__LTC_BUILD__"]);
const files = [
  ...readdirSync(rootPath(".")).filter((f) => /\.(jsx?|mjs)$/.test(f) && f !== "vite.config.js"),
  ...readdirSync(rootPath("api")).filter((f) => f.endsWith(".js")).map((f) => `api/${f}`),
].sort();
const problems = {};
for (const f of files) { const bad = unbound(readSource(f)).filter((n) => !RUNTIME.has(n)); if (bad.length) problems[f] = bad; }
check("the scan covers App.jsx, every component and every server function", [files.includes("App.jsx"), ["ReleaseGate.jsx", "StockCount.jsx", "Settings.jsx", "ReceiveWizard.jsx", "Login.jsx", "Charts.jsx", "main.jsx"].every((f) => files.includes(f)), files.filter((f) => f.startsWith("api/")).length >= 6], [true, true, true]);
check("no app source file uses a name that is not defined (would crash only at run time, not at build)", problems, {});

// The detector really catches this kind of bug: the app as deployed in 700efb9 / e8e94766 (purgeReagent removed).
const app = readSource("App.jsx");
const fnStart = app.indexOf("  async function purgeReagent(id) {"), fnEnd = app.indexOf("\n  }\n", fnStart) + 5;
check("…and it flags exactly purgeReagent when the function is removed again (as in 700efb9)", unbound(fnStart < 0 ? app : app.slice(0, fnStart) + app.slice(fnEnd)).filter((n) => !RUNTIME.has(n)), ["purgeReagent"]);

// purgeReagent restored exactly as it was before 700efb9: owner only, asks first, erases the record, logs it.
check("purgeReagent is defined once, unchanged from 84df840 (owner only, confirmation, erase, activity entry, reload)", [app.split("async function purgeReagent(").length - 1, fnStart < 0 ? "missing" : app.slice(fnStart, fnEnd)], [1, `  async function purgeReagent(id) {
    if (role !== "owner") return;
    if (!confirm("Permanently erase this record? This cannot be undone and it will disappear from Reports too.")) return;
    const item = reagents.find((r) => r.id === id);
    await supabase.from("reagents").delete().eq("id", id);
    await logActivity("purge", "reagent", item ? \`\${item.name} — Lot \${item.lot_number}\` : id);
    loadAll();
  }
`]);

// Every handler App passes to a component (onX={name}) resolves to something defined; Reports gets all five as functions.
const handlers = [], reportsProps = {};
traverse(ast(app), {
  JSXAttribute(p) {
    const e = p.node.value?.type === "JSXExpressionContainer" ? p.node.value.expression : null;
    if (!/^on[A-Z]/.test(p.node.name.name || "") || e?.type !== "Identifier") return;
    const b = p.scope.getBinding(e.name);
    handlers.push([e.name, !!b]);
    if (p.parent.name?.name === "Reports") reportsProps[p.node.name.name] = b ? b.path.node.type : "UNDEFINED";
  },
});
check("every onX={handler} prop in App.jsx names a defined function or value", [handlers.length > 20, handlers.filter(([, ok]) => !ok).map(([n]) => n)], [true, []]);
check("Reports receives delete / restore / delete-log / erase-Lot / erase-log handlers, all defined functions in App", reportsProps, { onDeleteReagent: "FunctionDeclaration", onRestoreReagent: "FunctionDeclaration", onDeleteLog: "FunctionDeclaration", onPurgeReagent: "FunctionDeclaration", onPurgeLog: "FunctionDeclaration" });
}, { expectedChecks: 6 });
