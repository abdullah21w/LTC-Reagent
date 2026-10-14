// Release control in the browser (releaseGuard.js): what to show, when a reload is
// safe, reload-loop protection, and the refusal messages every save path now gives.
// Plus the wiring that makes the build id reach the database.
import { suite, check, load, readSource } from "../helpers/core.mjs";

suite("Release control · browser rules (releaseGuard.js)", async () => {
const G = await load("releaseGuard.js");
const B = "a".repeat(40), C = "b".repeat(40);

check("decision: no state readable → unknown (the database still enforces)", [G.decideRelease(B, null).kind, G.decideRelease(B, undefined).kind], ["unknown", "unknown"]);
check("decision: maintenance wins, with its message", G.decideRelease(B, { maintenance: true, maintenance_message: "m", enforce_build: true, approved_build: B }), { kind: "maintenance", message: "m" });
check("decision: enforcement on and another build approved → outdated; same build → ok", [G.decideRelease(B, { maintenance: false, enforce_build: true, approved_build: C }).kind, G.decideRelease(B, { maintenance: false, enforce_build: true, approved_build: B }).kind], ["outdated", "ok"]);
check("decision: enforcement off, or no approved build yet → ok (no grace logic: exactly one build when on)", [G.decideRelease(B, { maintenance: false, enforce_build: false, approved_build: C }).kind, G.decideRelease("dev", { maintenance: false, enforce_build: true, approved_build: null }).kind], ["ok", "ok"]);

check("refusals recognised in message, details or a thrown Error; other errors are not", [G.releaseRefusal({ message: "ltc_maintenance" }), G.releaseRefusal({ message: "x", details: "ltc_outdated_client" }), G.releaseRefusal(new Error("ltc_outdated_client")), G.releaseRefusal({ message: "permission denied" }), G.releaseRefusal(null)], ["maintenance", "outdated", "outdated", null, null]);
check("refusal messages say nothing was saved and what to do", [G.releaseRefusalMessage({ message: "ltc_maintenance" }), G.releaseRefusalMessage({ message: "ltc_outdated_client" }), G.releaseRefusalMessage({ message: "boom" })], [G.MAINTENANCE_SAVE_MESSAGE, G.OUTDATED_SAVE_MESSAGE, null]);

const seen = [];
const off = G.onBusyChange((b) => seen.push(b));
G.setBusy("a", true); G.setBusy("b", true); G.setBusy("a", false);
const mid = [G.isBusy(), G.busyKeys()];
G.setBusy("b", false);
off();
check("unsaved-work registry: busy while any key is set; listeners told only when busy flips", [mid, G.isBusy(), seen], [[true, ["b"]], false, [true, false]]);

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
const s = store();
check("reload-loop protection: first automatic reload allowed, a second within 5 minutes refused, allowed again after", [G.mayAutoReload(1000, s), G.mayAutoReload(1000 + 60000, s), G.mayAutoReload(1000 + G.AUTO_RELOAD_GAP_MS + 1, s)], [true, false, true]);
check("…if storage is unavailable, one reload is allowed (never stuck)", G.mayAutoReload(5, { getItem() { throw new Error("blocked"); } }), true);

// every save path gives the clear message
const LU = await load("logUseSave.js"), LE = await load("logEditSave.js"), RS = await load("receiveSave.js"), ED = await load("lotEdit.js");
const m = { message: "ltc_maintenance" }, o = { message: "ltc_outdated_client" };
check("Log use, edit, undo, Receive and Edit Lot all say 'maintenance' / 'older version' instead of a raw error", [LU.describeLogUseError(m), LE.describeEditError(o, "edit"), LE.describeEditError(m, "undo"), RS.describeReceiveError(o), ED.describeSaveError(m)], [G.MAINTENANCE_SAVE_MESSAGE, G.OUTDATED_SAVE_MESSAGE, G.MAINTENANCE_SAVE_MESSAGE, G.OUTDATED_SAVE_MESSAGE, G.MAINTENANCE_SAVE_MESSAGE]);
check("…and other errors keep their existing messages", [/database update for it hasn't been applied/.test(LU.describeLogUseError({ code: "PGRST202", message: "Could not find the function public.log_use" })), /Nothing was saved/.test(RS.describeReceiveError({ message: "boom" }))], [true, true]);

// wiring
const BI = await load("buildInfo.js");
check("build id: 'dev' when not built by Vercel", BI.BUILD, "dev");
const vc = readSource("vite.config.js");
check("vite.config.js bakes Vercel's commit id into the app AND publishes it at /version.json (for the owner's deployment check)", [vc.includes('const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.LTC_BUILD || "dev";'), vc.includes("__LTC_BUILD__: JSON.stringify(BUILD_ID)"), vc.includes('fileName: "version.json", source: JSON.stringify({ build: BUILD_ID })'), vc.includes("plugins: [react(), versionJson]")], [true, true, true, true]);
check("every database request from the app carries x-ltc-build", readSource("supabaseClient.js").includes('createClient(url, key, { global: { headers: { "x-ltc-build": BUILD } } })'), true);
const api = ["api/_reportBuilder.js", "api/send-2fa-code.js", "api/send-backup.js", "api/send-expiry-alerts.js", "api/send-monthly-report.js"];
check("every serverless call to the database carries x-ltc-build (Vercel's commit id), so cron jobs aren't refused", api.map((f) => { const t = readSource(f); return (t.match(/apikey: SUPABASE_KEY/g) || []).length === (t.match(/"x-ltc-build": process\.env\.VERCEL_GIT_COMMIT_SHA \|\| "dev"/g) || []).length; }), [true, true, true, true, true]);
}, { expectedChecks: 15 });
