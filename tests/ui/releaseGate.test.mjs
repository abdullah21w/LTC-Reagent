// Release control — the real useRelease hook and screens (ReleaseGate.jsx) in jsdom,
// with a fake database and a recorded reload: maintenance screen, outdated → reload
// only when nothing is being entered or saved, waiting while busy, reload-loop
// protection, re-checks on events. Plus App / Stock Count wiring.
import { suite, check, load, src, appPlugin, readSource } from "../helpers/core.mjs";
import { setupDom, STUB_SUPABASE } from "../helpers/dom.mjs";

suite("Release control · maintenance screen and forced update", async () => {
const env = setupDom();
const { w } = env;
const A = await load({ contents: `export { useRelease, MaintenanceScreen, OwnerMaintenanceBanner, UpdateBanner } from "${src("ReleaseGate.jsx")}"; export { setBusy, isBusy, RELEASE_CHECK_EVENT } from "${src("releaseGuard.js")}"; export { createRoot } from "react-dom/client"; export { createElement, act } from "react";` }, { dom: true, plugins: [appPlugin({ stubSource: STUB_SUPABASE })] });
const B = "a".repeat(40), C = "b".repeat(40);
let state;
const reads = { hello: 0, select: 0 };
const client = {
  rpc: async (fn) => { reads.hello++; return { data: { your_build: B, ...state }, error: null }; },
  from: () => { const q = { select: () => q, eq: () => q, then: (res) => { reads.select++; return Promise.resolve({ data: [state], error: null }).then(res); } }; return q; },
};
let reloads = 0, probe = null, root, host;
function Probe() {
  const r = A.useRelease({ client, build: B, pollMs: 1000000, reload: () => { reloads++; } });
  probe = r;
  return r.decision.kind === "maintenance" ? A.createElement(A.MaintenanceScreen, { message: r.decision.message, onOwnerSignIn: () => {} })
    : r.decision.kind === "outdated" ? A.createElement(A.UpdateBanner, { blocked: r.blocked, onReload: () => {} })
    : A.createElement("div", { "data-testid": "app" }, "app");
}
const settle = async () => { for (let i = 0; i < 4; i++) await A.act(async () => {}); };
async function mount() { host = document.createElement("div"); document.body.appendChild(host); root = A.createRoot(host); await A.act(async () => { root.render(A.createElement(Probe)); }); await settle(); }
const unmount = async () => { await A.act(async () => root.unmount()); host.remove(); };
const tid = (id) => host.querySelector(`[data-testid="${id}"]`);
const recheck = async () => { await A.act(async () => { w.dispatchEvent(new w.Event(A.RELEASE_CHECK_EVENT)); }); await settle(); };
const reset = () => { reloads = 0; try { sessionStorage.clear(); } catch {} };

// 1. Normal / maintenance
state = { maintenance: false, maintenance_message: "", enforce_build: true, approved_build: B };
reset(); await mount();
check("approved build: the app is shown; the build was reported at load (ltc_hello); no reload", [!!tid("app"), reads.hello, reloads], [true, 1, 0]);
state = { ...state, maintenance: true, maintenance_message: "Updating — about 10 minutes." };
await recheck();
check("maintenance switched on → the full maintenance screen with its message and an owner sign-in; nothing reloads", [!!tid("maintenance-screen"), /Updating — about 10 minutes\./.test(tid("maintenance-screen")?.textContent || ""), /Owner sign-in/.test(host.textContent), reloads], [true, true, true, 0]);
state = { ...state, maintenance: false };
await recheck();
check("maintenance off again (same approved build) → the app continues by itself, no reload", [!!tid("app"), reloads], [true, 0]);
await unmount();

// 2. Outdated: reload only when safe
state = { maintenance: false, maintenance_message: "", enforce_build: true, approved_build: C };
reset(); await mount();
check("another build approved and nothing in progress → reloads itself once", [reloads, probe.decision.kind], [1, "outdated"]);
await unmount();

reset(); A.setBusy("log-window", true);
await mount();
check("outdated while a window is open / a save is in flight → NO reload; the banner says saving is disabled and to copy entries", [reloads, probe.blocked, /Saving is disabled on this older version/.test(tid("update-banner")?.textContent || "")], [0, true, true]);
await A.act(async () => { A.setBusy("log-window", false); }); await settle();
check("…the window closes (nothing busy) → reloads then", reloads, 1);
await unmount();

await mount();
check("reload-loop protection: outdated again within 5 minutes (e.g. Vercel still switching) → no second automatic reload; banner with a Reload button instead", [reloads, probe.blocked, /Reload now/.test(tid("update-banner")?.textContent || "")], [1, true, true]);
await unmount();

// 3. Re-checks
state = { maintenance: false, maintenance_message: "", enforce_build: true, approved_build: B };
reset(); await mount();
const s0 = reads.select;
await A.act(async () => { w.dispatchEvent(new w.Event("focus")); }); await settle();
await A.act(async () => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new w.Event("visibilitychange")); }); await settle();
await A.act(async () => { w.dispatchEvent(new w.Event("online")); }); await settle();
await recheck();
check("re-checks on focus, coming back into view (phones / installed app), coming online and after a refused save", reads.select - s0, 4);
await unmount();

// 4. Screens
host = document.createElement("div"); document.body.appendChild(host); root = A.createRoot(host);
await A.act(async () => { root.render(A.createElement(A.OwnerMaintenanceBanner, { message: "release 7" })); });
check("owner banner during maintenance: nothing can be saved by anyone until the release is approved", /Maintenance mode is ON — nothing can be saved by anyone until the release is approved\. \(release 7\)/.test(host.textContent), true);
await unmount();

// 5. Wiring
const app = readSource("App.jsx"), sc = readSource("StockCount.jsx");
check("App: useRelease with this build; maintenance screen BEFORE sign-in for staff (owner may sign in); banners for owner / outdated", [app.includes("useRelease({ client: supabase, build: BUILD })"), app.indexOf('release.decision.kind === "maintenance" && role !== "owner"') < app.indexOf("if (!role) return <Login"), app.includes('{release.decision.kind === "maintenance" && role === "owner" && <OwnerMaintenanceBanner'), app.includes('{release.decision.kind === "outdated" && <UpdateBanner')], [true, true, true, true]);
check("App: any open write window (Receive, Log use, Edit Lot, Discard, Edit log, password) or the Settings page counts as unsaved work", app.includes('setBusy("app-windows", !!(showWizard || showLog || showChangePassword || editReagent || discardReagentTarget || editLog || tab === "settings"));'), true);
check("Stock Count: unsaved count entries or a save in flight count as unsaved work; refusals shown plainly", [sc.includes('setBusy("stock-count", Object.keys(countDrafts).length > 0 || Object.values(countSaving).some(Boolean));'), sc.includes('case "release": return r.message;'), sc.includes('if (result.status === "release") { setNotice(result.message); return; }'), sc.includes("releaseRefusalMessage(error) ||")], [true, true, true, true]);
check("no React errors", env.errors, []);
env.close();
}, { expectedChecks: 13 });
