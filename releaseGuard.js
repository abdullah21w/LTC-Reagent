// Release control in the browser (the database side is ADD_RELEASE_CONTROL.sql,
// which is what actually blocks writes — old tabs included). This module only
// decides what to SHOW and WHEN it is safe to reload:
//   * decideRelease: maintenance / outdated / ok, from the state row.
//   * the unsaved-work registry: any open write window, unsaved Stock Count entry
//     or save in flight marks the page busy; an outdated page reloads itself ONLY
//     when nothing is busy (never during a save, never over unsaved input).
//   * reload-loop protection: at most one automatic reload per 5 minutes per tab
//     (e.g. while Vercel is still switching to the new version).
//   * releaseRefusalMessage: turns the database's refusals into clear messages.

export const RELEASE_CHECK_EVENT = "ltc-release-check";

/** release: { maintenance, maintenance_message, enforce_build, approved_build } | null → { kind, message? } */
export function decideRelease(build, release) {
  if (!release || typeof release !== "object") return { kind: "unknown" };
  if (release.maintenance) return { kind: "maintenance", message: release.maintenance_message || "" };
  if (release.enforce_build && release.approved_build && release.approved_build !== build) return { kind: "outdated" };
  return { kind: "ok" };
}

export const MAINTENANCE_SAVE_MESSAGE = "LTC Lab Inventory is in maintenance for an update, so nothing was saved. Your entries are kept — try again when the update is finished.";
export const OUTDATED_SAVE_MESSAGE = "This page is an older version of LTC Lab Inventory, so nothing was saved. Copy your entries if you need them, then reload the page to get the new version.";

/** "maintenance" | "outdated" | null — from a database error (message, details or a thrown Error). */
export function releaseRefusal(e) {
  const m = `${e?.message || ""} ${e?.details || ""}`;
  if (/\bltc_maintenance\b/.test(m)) return "maintenance";
  if (/\bltc_outdated_client\b/.test(m)) return "outdated";
  return null;
}

/** A clear message for a refused save, or null; also asks the page to re-check the release state. */
export function releaseRefusalMessage(e) {
  const k = releaseRefusal(e);
  if (!k) return null;
  requestReleaseCheck();
  return k === "maintenance" ? MAINTENANCE_SAVE_MESSAGE : OUTDATED_SAVE_MESSAGE;
}

export function requestReleaseCheck() {
  try { globalThis.window?.dispatchEvent(new globalThis.window.Event(RELEASE_CHECK_EVENT)); } catch { /* not in a browser */ }
}

// ── Unsaved work ──
const busy = new Map();
const listeners = new Set();
export function setBusy(key, on) {
  const was = isBusy();
  if (on) busy.set(key, true); else busy.delete(key);
  if (was !== isBusy()) listeners.forEach((fn) => { try { fn(isBusy()); } catch { /* ignore */ } });
}
export const isBusy = () => busy.size > 0;
export const busyKeys = () => [...busy.keys()];
export function onBusyChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── Reload-loop protection ──
const RELOAD_KEY = "ltc_auto_reload_at";
export const AUTO_RELOAD_GAP_MS = 5 * 60 * 1000;
export function mayAutoReload(now = Date.now(), storage = safeSession()) {
  try {
    const last = Number(storage?.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < AUTO_RELOAD_GAP_MS) return false;
    storage?.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}
function safeSession() { try { return globalThis.sessionStorage; } catch { return null; } }
