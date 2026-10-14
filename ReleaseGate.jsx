import React, { useState, useEffect, useRef, useCallback } from "react";
import { decideRelease, isBusy, onBusyChange, mayAutoReload, RELEASE_CHECK_EVENT } from "./releaseGuard";

// Watches the release state (ADD_RELEASE_CONTROL.sql) and tells the app what to
// show. Checks on load (ltc_hello, which also reports this build), every minute,
// when the page or installed app comes back into view or online, after any save
// the database refused for release reasons, and when another tab says so.
// When this build is no longer the approved one, the page reloads itself — but
// only while nothing is being entered or saved (releaseGuard.isBusy), and at most
// once per 5 minutes; otherwise it shows the update banner and waits.
export function useRelease({ client, build, pollMs = 60000, reload = () => window.location.reload() }) {
  const [release, setRelease] = useState(null);
  const [blocked, setBlocked] = useState(false); // outdated, but a reload isn't safe / allowed right now
  const channel = useRef(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const check = useCallback(async () => {
    try {
      const r = await client.from("app_release").select("maintenance, maintenance_message, enforce_build, approved_build").eq("id", 1);
      if (!r?.error && Array.isArray(r?.data) && r.data[0]) setRelease(r.data[0]);
    } catch { /* keep the last known state; the database enforces anyway */ }
  }, [client]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await client.rpc("ltc_hello");
        if (alive && !r?.error && r?.data && typeof r.data === "object") setRelease(r.data);
        else if (alive) check();
      } catch { if (alive) check(); }
    })();
    const t = setInterval(check, pollMs);
    const onVisible = () => { if (document.visibilityState !== "hidden") check(); };
    window.addEventListener(RELEASE_CHECK_EVENT, check);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisible);
    try {
      channel.current = new BroadcastChannel("ltc-release");
      channel.current.onmessage = () => check();
    } catch { channel.current = null; }
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(RELEASE_CHECK_EVENT, check);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisible);
      try { channel.current?.close(); } catch { /* ignore */ }
    };
  }, [client, check, pollMs]);

  const decision = decideRelease(build, release);

  useEffect(() => {
    if (decision.kind !== "outdated") { setBlocked(false); return undefined; }
    try { channel.current?.postMessage("check"); } catch { /* ignore */ }
    const tryReload = () => {
      if (!isBusy() && mayAutoReload()) { reloadRef.current(); return; }
      setBlocked(true);
    };
    tryReload();
    return onBusyChange((busyNow) => { if (!busyNow) tryReload(); });
  }, [decision.kind]);

  return { decision, release, blocked, recheck: check };
}

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "#F0F3F2", fontFamily: "'Inter', sans-serif", boxSizing: "border-box" };

/** Full screen while maintenance is on (staff, and anyone not signed in). */
export function MaintenanceScreen({ message, onOwnerSignIn }) {
  return (
    <div style={wrap}>
      <div role="alert" data-testid="maintenance-screen" style={{ background: "#fff", borderRadius: 12, padding: "26px 22px", maxWidth: 420, width: "100%", boxShadow: "0 8px 28px rgba(15,25,26,0.12)", textAlign: "center" }}>
        <div style={{ fontSize: 34, marginBottom: 8 }} aria-hidden="true">🛠️</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: "#1F2D2B", marginBottom: 8 }}>Update in progress</div>
        <div style={{ fontSize: 14, color: "#516361", lineHeight: 1.5 }}>{message || "LTC Lab Inventory is being updated. Please wait — the app will continue by itself when the update is finished."}</div>
        <div style={{ fontSize: 12.5, color: "#7B8E8A", marginTop: 12 }}>Nothing can be saved during the update. You don't need to reload.</div>
        {onOwnerSignIn && <button type="button" onClick={onOwnerSignIn} style={{ marginTop: 18, background: "none", border: "1px solid #C7D1CE", color: "#516361", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 600 }}>Owner sign-in</button>}
      </div>
    </div>
  );
}

/** Top banner for the owner while maintenance is on (read-only view). */
export function OwnerMaintenanceBanner({ message }) {
  return (
    <div role="status" data-testid="owner-maintenance-banner" style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 60, background: "#7C3E00", color: "#fff", padding: "9px 14px", fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
      Maintenance mode is ON — nothing can be saved by anyone until the release is approved.{message ? ` (${message})` : ""}
    </div>
  );
}

/** Top banner when this page is an older version than the approved one. */
export function UpdateBanner({ blocked, onReload }) {
  return (
    <div role="alert" data-testid="update-banner" style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 60, background: "#0F7173", color: "#fff", padding: "10px 14px", fontSize: 13, lineHeight: 1.45, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px" }}>
        <b>A new version of LTC Lab Inventory is ready.</b>{" "}
        {blocked ? "Saving is disabled on this older version. Finish copying anything you were entering, close the window, then reload." : "Reloading…"}
      </div>
      <button type="button" onClick={onReload} style={{ background: "#fff", color: "#0F7173", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 13 }}>Reload now</button>
    </div>
  );
}
