import React, { useState, useEffect, useMemo } from "react";
import { Beaker, TrendingDown, Plus, Users, FileText, LayoutGrid, ChevronRight, X, Droplet, ScanLine, Pencil, Trash2, Bell, LogOut, SlidersHorizontal, Download, AlertTriangle, ClipboardX, History, BarChart3, KeyRound, Menu, Cpu, Clock } from "lucide-react";
import { supabase } from "./supabaseClient";
import Login from "./Login";
import Settings from "./Settings";
import BarcodeScanner from "./BarcodeScanner";
import ReceiveWizard, { YesNoRow } from "./ReceiveWizard";
import Charts from "./Charts";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const DEPT_PALETTE = ["#0F7173", "#B5473A", "#8A5A2B", "#5A6ACF", "#2F8F5B", "#B8860B", "#7A4FA3", "#C1432B"];
function deptColor(dept, list) {
  const i = Math.max(0, list.indexOf(dept));
  return DEPT_PALETTE[i % DEPT_PALETTE.length];
}
const INSPECTION_KEYS = ["intact_container", "complete_compound", "expiration_validity", "lot_matches_kit", "storage_condition_ok"];

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");

const THEME = {
  primary: "#0F7173",
  primaryLight: "#5FBFB0",
  sidebarBg: "#1B2B2E",
  sidebarText: "#8FA39E",
  sidebarTextActive: "#F0F3F2",
  bg: "#F0F3F2",
  cardBorder: "#E1E8E5",
  cardShadow: "0 8px 24px rgba(0,0,0,0.06)",
  text: "#1B2B2E",
  textMuted: "#7B8E8A",
};

function statusOf(item, warnDays = 30) {
  const dExp = daysBetween(item.expiry_date, todayISO());
  const lowStock = item.current_quantity <= item.low_stock_threshold;
  if (dExp < 0 || item.current_quantity <= 0) return "red";
  if (dExp <= warnDays || lowStock) return "yellow";
  return "green";
}

function isExpiringSoonItem(item, warnDays) {
  const dExp = daysBetween(item.expiry_date, todayISO());
  return dExp >= 0 && dExp <= warnDays;
}

function hasInspectionIssue(item) {
  return INSPECTION_KEYS.some((k) => item[k] === false);
}

const STATUS_META = {
  red: { label: "Critical", color: "#C1432B", bg: "#FBEAE6" },
  yellow: { label: "Watch", color: "#B8860B", bg: "#FBF3DF" },
  green: { label: "Stable", color: "#2F6B4F", bg: "#E8F2EC" },
  low: { label: "Low stock", color: "#B8860B", bg: "#FBF3DF" },
  expiring: { label: "Expiring soon", color: "#8A5A2B", bg: "#FBF0E4" },
};

const FULL_PERMISSIONS = { dashboard: true, reports: true, charts: true, settings: true, receive: true, log_use: true, edit: true, delete: true };
const DEFAULT_NEW_PERMISSIONS = { dashboard: true, reports: true, charts: false, settings: false, receive: false, log_use: false, edit: false, delete: false };

export default function App() {
  const [config, setConfig] = useState(null);
  const [role, setRole] = useState(() => localStorage.getItem("reagent_role") || null);
  const [username, setUsername] = useState(() => localStorage.getItem("reagent_username") || "");
  const [perms, setPerms] = useState(() => {
    try { return JSON.parse(localStorage.getItem("reagent_perms")) || null; } catch { return null; }
  });
  const [accountId, setAccountId] = useState(() => localStorage.getItem("reagent_account_id") || null);
  const can = (key) => role === "owner" || !!(perms && perms[key]);
  const [reagents, setReagents] = useState(null);
  const [logs, setLogs] = useState(null);
  const [presets, setPresets] = useState([]);
  const [staffAccounts, setStaffAccounts] = useState([]);
  const [devices, setDevices] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [tab, setTab] = useState("dashboard");
  const [showWizard, setShowWizard] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [editReagent, setEditReagent] = useState(null);
  const [editLog, setEditLog] = useState(null);
  const [error, setError] = useState("");
  const [bannerDismissed, setBannerDismissed] = useState(false);

  async function ensureConfig() {
    let { data } = await supabase.from("app_config").select("*").eq("id", 1).maybeSingle();
    if (!data) {
      await supabase.from("app_config").insert({ id: 1 });
      const r = await supabase.from("app_config").select("*").eq("id", 1).maybeSingle();
      data = r.data;
    }
    setConfig(data);
  }

  async function loadAll() {
    const { data: r, error: e1 } = await supabase.from("reagents").select("*").order("expiry_date");
    const { data: l, error: e2 } = await supabase.from("consumption_logs").select("*");
    const { data: p } = await supabase.from("reagent_presets").select("*").order("name");
    const { data: s } = await supabase.from("staff_accounts").select("*").order("username");
    const { data: a } = await supabase.from("audit_log").select("*").order("performed_at", { ascending: false });
    const { data: dv } = await supabase.from("devices").select("*").order("name");
    if (e1 || e2) {
      setError("Could not connect to the database. Check Supabase settings.");
      setReagents([]);
      setLogs([]);
      return;
    }
    setReagents(r || []);
    setLogs(l || []);
    setPresets(p || []);
    setStaffAccounts(s || []);
    setActivityLog(a || []);
    setDevices(dv || []);
  }

  async function logActivity(action, entity, description) {
    await supabase.from("audit_log").insert({ action, entity, description, performed_by: username });
  }

  useEffect(() => {
    ensureConfig();
    loadAll();
  }, []);

  function handleLogin(newRole, newUsername, newPerms, newAccountId) {
    const effectivePerms = newRole === "owner" ? FULL_PERMISSIONS : (newPerms || {});
    localStorage.setItem("reagent_role", newRole);
    localStorage.setItem("reagent_username", newUsername);
    localStorage.setItem("reagent_perms", JSON.stringify(effectivePerms));
    if (newAccountId) localStorage.setItem("reagent_account_id", newAccountId);
    else localStorage.removeItem("reagent_account_id");
    setRole(newRole);
    setUsername(newUsername);
    setPerms(effectivePerms);
    setAccountId(newAccountId || null);
    const order = ["dashboard", "reports", "charts", "settings"];
    const firstTab = order.find((t) => newRole === "owner" || effectivePerms[t]) || "dashboard";
    setTab(firstTab);
  }
  function logout() {
    localStorage.removeItem("reagent_role");
    localStorage.removeItem("reagent_username");
    localStorage.removeItem("reagent_perms");
    localStorage.removeItem("reagent_account_id");
    setRole(null);
    setUsername("");
    setPerms(null);
    setAccountId(null);
  }

  async function changeOwnPassword(currentPassword, newPassword) {
    if (role === "owner") {
      if (currentPassword !== config.owner_password) return "Current password is incorrect.";
      const { error } = await supabase.from("app_config").update({ owner_password: newPassword }).eq("id", 1);
      if (error) return "Could not save the new password.";
      ensureConfig();
      return null;
    }
    const mine = staffAccounts.find((s) => s.id === accountId);
    if (!mine) return "Could not find your account.";
    if (currentPassword !== mine.password) return "Current password is incorrect.";
    const { error } = await supabase.from("staff_accounts").update({ password: newPassword }).eq("id", accountId);
    if (error) return "Could not save the new password.";
    loadAll();
    return null;
  }

  async function addReagent(entry) {
    if (!can("receive")) return;
    await supabase.from("reagents").insert({
      name: entry.name,
      department: entry.department,
      item_type: entry.itemType,
      device: entry.device || "",
      lot_number: entry.lotNumber,
      unit: entry.unit,
      quantity_received: entry.quantityReceived,
      current_quantity: entry.quantityReceived,
      expiry_date: entry.expiryDate,
      date_added: entry.receivedDate,
      added_by: entry.receivedBy,
      low_stock_threshold: entry.lowStockThreshold,
      intact_container: entry.intact_container,
      complete_compound: entry.complete_compound,
      expiration_validity: entry.expiration_validity,
      lot_matches_kit: entry.lot_matches_kit,
      storage_condition_ok: entry.storage_condition_ok,
      receiving_notes: entry.receivingNotes,
      inspection_notes: entry.inspectionNotes,
    });
    setShowWizard(false);
    loadAll();
  }

  async function recordConsumption(entry) {
    if (!can("log_use")) return;
    const item = reagents.find((r) => r.id === entry.reagentId);
    if (!item) return;
    const newQty = Math.max(0, item.current_quantity - entry.amount);
    await supabase.from("reagents").update({ current_quantity: newQty }).eq("id", item.id);
    await supabase.from("consumption_logs").insert({
      reagent_id: entry.reagentId, amount: entry.amount, date: entry.date, used_by: entry.usedBy, note: entry.note, tested_by_qc: entry.testedByQC,
    });
    setShowLog(false);
    loadAll();
  }

  async function saveEditedReagent(updated) {
    if (!can("edit")) return;
    await supabase.from("reagents").update({
      lot_number: updated.lot_number,
      quantity_received: updated.quantity_received,
      current_quantity: updated.current_quantity,
      expiry_date: updated.expiry_date,
      low_stock_threshold: updated.low_stock_threshold,
      edited_by: username,
      edited_at: new Date().toISOString(),
    }).eq("id", updated.id);
    await logActivity("edit", "reagent", `${updated.name || ""} — Lot ${updated.lot_number}`.trim());
    setEditReagent(null);
    loadAll();
  }

  async function deleteReagent(id) {
    if (!can("delete")) return;
    if (!confirm("Remove this lot from the active inventory? It will stay in Reports for audit purposes.")) return;
    const item = reagents.find((r) => r.id === id);
    await supabase.from("reagents").update({ deleted: true, deleted_by: username, deleted_at: new Date().toISOString() }).eq("id", id);
    await logActivity("delete", "reagent", item ? `${item.name} — Lot ${item.lot_number}` : id);
    loadAll();
  }

  async function saveEditedLog(updated, original) {
    if (!can("edit")) return;
    const item = reagents.find((r) => r.id === original.reagent_id);
    if (item) {
      const delta = updated.amount - original.amount;
      const newQty = Math.max(0, item.current_quantity - delta);
      await supabase.from("reagents").update({ current_quantity: newQty }).eq("id", item.id);
    }
    await supabase.from("consumption_logs").update({
      amount: updated.amount, date: updated.date, used_by: updated.used_by, note: updated.note, tested_by_qc: updated.tested_by_qc,
      edited_by: username, edited_at: new Date().toISOString(),
    }).eq("id", updated.id);
    await logActivity("edit", "log", `${item ? item.name : "Unknown"} — ${updated.amount} used by ${updated.used_by} on ${updated.date}`);
    setEditLog(null);
    loadAll();
  }

  async function deleteLog(log) {
    if (!can("delete")) return;
    if (!confirm("Remove this log entry? The amount will be added back to stock, but it stays in Reports for audit purposes.")) return;
    const item = reagents.find((r) => r.id === log.reagent_id);
    if (item) await supabase.from("reagents").update({ current_quantity: item.current_quantity + log.amount }).eq("id", item.id);
    await supabase.from("consumption_logs").update({ deleted: true, deleted_by: username, deleted_at: new Date().toISOString() }).eq("id", log.id);
    await logActivity("delete", "log", `${item ? item.name : "Unknown"} — ${log.amount} used by ${log.used_by} on ${log.date}`);
    loadAll();
  }

  async function purgeReagent(id) {
    if (role !== "owner") return;
    if (!confirm("Permanently erase this record? This cannot be undone and it will disappear from Reports too.")) return;
    const item = reagents.find((r) => r.id === id);
    await supabase.from("reagents").delete().eq("id", id);
    await logActivity("purge", "reagent", item ? `${item.name} — Lot ${item.lot_number}` : id);
    loadAll();
  }

  async function purgeLog(id) {
    if (role !== "owner") return;
    if (!confirm("Permanently erase this record? This cannot be undone and it will disappear from Reports too.")) return;
    const log = logs.find((l) => l.id === id);
    const item = log ? reagents.find((r) => r.id === log.reagent_id) : null;
    await supabase.from("consumption_logs").delete().eq("id", id);
    await logActivity("purge", "log", log ? `${item ? item.name : "Unknown"} — ${log.amount} used by ${log.used_by} on ${log.date}` : id);
    loadAll();
  }

  async function clearActivityLog() {
    if (role !== "owner") return;
    if (!confirm("Erase the entire activity history? This cannot be undone.")) return;
    await supabase.from("audit_log").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    loadAll();
  }

  const warnDays = config?.expiry_warning_days ?? 30;

  const groups = useMemo(() => {
    if (!reagents) return [];
    const active = reagents.filter((r) => !r.deleted);
    const map = {};
    for (const r of active) {
      const key = `${r.name}::${r.device || ""}`;
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
    return Object.entries(map).map(([key, items]) => {
      const sorted = [...items].sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
      const totalQty = items.reduce((s, i) => s + i.current_quantity, 0);
      const totalReceived = items.reduce((s, i) => s + i.quantity_received, 0);
      const anyExpiredOrEmpty = items.some((i) => daysBetween(i.expiry_date, todayISO()) < 0 || i.current_quantity <= 0);
      const flagged = items.some(hasInspectionIssue);
      const lowStock = totalQty > 0 && totalQty <= sorted[0].low_stock_threshold;
      const expiringSoon = items.some((i) => isExpiringSoonItem(i, warnDays));
      const worstStatus = anyExpiredOrEmpty ? "red" : (lowStock || expiringSoon) ? "yellow" : "green";
      return { key, name: items[0].name, device: items[0].device || "", items: sorted, fefo: sorted[0], totalQty, totalReceived, status: worstStatus, department: items[0].department, unit: items[0].unit, flagged, lowStock, expiringSoon };
    });
  }, [reagents, warnDays]);

  const counts = useMemo(() => {
    const c = { red: 0, yellow: 0, green: 0, flagged: 0, lowStock: 0, expiringSoon: 0 };
    groups.forEach((g) => {
      c[g.status]++;
      if (g.flagged) c.flagged++;
      if (g.lowStock) c.lowStock++;
      if (g.expiringSoon) c.expiringSoon++;
    });
    return c;
  }, [groups]);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (!reagents || Notification.permission !== "granted") return;
    if (counts.red === 0) return;
    const key = `notified-${todayISO()}`;
    if (localStorage.getItem(key)) return;
    new Notification("Reagent Log — Critical items", { body: `${counts.red} reagent(s) expired or out of stock. Open the app to review.` });
    localStorage.setItem(key, "1");
  }, [counts, reagents]);

  function enableNotifications() {
    if (typeof Notification === "undefined") {
      alert("Browser notifications aren't supported in this browser (this is normal on Safari for iPhone/iPad). Everything else in the app works fine.");
      return;
    }
    Notification.requestPermission();
  }

  if (!config || reagents === null || logs === null) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "IBM Plex Mono, monospace", color: "#4A5A5C" }}>Loading…</div>;
  }
  if (!role) return <Login config={config} staffAccounts={staffAccounts} onLogin={handleLogin} />;

  return (
    <div style={{ minHeight: "100vh", background: THEME.bg, fontFamily: "'Inter', sans-serif", color: THEME.text, display: "flex" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; cursor: pointer; }
        input, select { font-family: inherit; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 4px; }
        .hover-lift { transition: all 0.2s ease; }
        .hover-lift:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(0,0,0,0.09); }
        .sidebar-desktop { display: block; }
        .sidebar-mobile-toggle { display: none; }
        @media (max-width: 880px) {
          .sidebar-desktop { position: fixed; top: 0; left: 0; height: 100vh; z-index: 70; transform: translateX(-100%); transition: transform 0.25s ease; }
          .sidebar-desktop.open { transform: translateX(0); box-shadow: 0 0 40px rgba(0,0,0,0.25); }
          .sidebar-mobile-toggle { display: flex !important; }
          .topbar-date { display: none; }
          .main-content { padding-left: 14px !important; padding-right: 14px !important; }
        }
      `}</style>

      {sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", zIndex: 60 }} />}

      <Sidebar
        tab={tab} setTab={setTab} role={role} can={can}
        onAdd={() => setShowWizard(true)} onLog={() => setShowLog(true)}
        onLogout={logout} onChangePassword={() => setShowChangePassword(true)}
        username={username} open={sidebarOpen} onCloseMobile={() => setSidebarOpen(false)}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <TopBar tab={tab} role={role} username={username} onEnableNotif={enableNotifications} onMenuClick={() => setSidebarOpen(true)} />

        <main className="main-content" style={{ maxWidth: 1160, margin: "0 auto", padding: "24px 28px 80px" }}>
          {counts.red > 0 && !bannerDismissed && tab !== "settings" && (
            <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={18} color="#DC2626" />
              <div style={{ flex: 1, fontSize: 13.5, color: "#7F1D1D" }}><b>{counts.red}</b> reagent{counts.red > 1 ? "s" : ""} expired or out of stock — needs attention now.</div>
              <button onClick={() => setBannerDismissed(true)} style={{ background: "none", border: "none", color: "#7F1D1D" }}><X size={16} /></button>
            </div>
          )}
          {counts.flagged > 0 && tab !== "settings" && (
            <div style={{ background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 12, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
              <ClipboardX size={18} color="#D97706" />
              <div style={{ flex: 1, fontSize: 13.5, color: "#78350F" }}><b>{counts.flagged}</b> reagent{counts.flagged > 1 ? "s" : ""} failed an inspection check on receipt — review before use.</div>
            </div>
          )}

          {tab === "dashboard" && can("dashboard") && <Dashboard groups={groups} counts={counts} devices={devices} logs={logs} departments={config.departments || []} role={role} can={can} onDeleteReagent={deleteReagent} onSelect={(g) => { setSelectedGroup(g); setTab("detail"); }} />}
          {tab === "detail" && can("dashboard") && selectedGroup && (
            <DetailView
              group={groups.find((g) => g.key === selectedGroup.key) || selectedGroup}
              logs={logs.filter((l) => !l.deleted && (groups.find((g) => g.key === selectedGroup.key)?.items || []).some((i) => i.id === l.reagent_id))}
              role={role}
              can={can}
              warnDays={warnDays}
              onBack={() => setTab("dashboard")}
              onEditReagent={setEditReagent} onDeleteReagent={deleteReagent}
              onEditLog={setEditLog} onDeleteLog={deleteLog}
            />
          )}
          {tab === "reports" && can("reports") && <Reports reagents={reagents} logs={logs} departments={config.departments || []} role={role} onPurgeReagent={purgeReagent} onPurgeLog={purgeLog} />}
          {tab === "settings" && can("settings") && <Settings config={config} presets={presets} role={role} staffAccounts={staffAccounts} devices={devices} reload={() => { ensureConfig(); loadAll(); }} />}
          {tab === "charts" && can("charts") && <Charts reagents={reagents} logs={logs} />}
          {tab === "deletions" && role === "owner" && <DeletionsLog activityLog={activityLog} onClear={clearActivityLog} />}
        </main>
      </div>

      {showWizard && <ReceiveWizard presets={presets} devices={devices} role={role} username={username} departments={config.departments || []} defaultLowStock={config.low_stock_default_percent} onClose={() => setShowWizard(false)} onSubmit={addReagent} />}
      {showLog && <LogConsumptionModal reagents={reagents.filter((r) => !r.deleted)} username={username} onClose={() => setShowLog(false)} onSubmit={recordConsumption} />}
      {editReagent && <EditReagentModal reagent={editReagent} onClose={() => setEditReagent(null)} onSave={saveEditedReagent} />}
      {editLog && <EditLogModal log={editLog} onClose={() => setEditLog(null)} onSave={saveEditedLog} />}
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} onSave={changeOwnPassword} />}
      {error && <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", background: "#DC2626", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 14 }}>{error}</div>}
    </div>
  );
}

function Sidebar({ tab, setTab, role, can, onAdd, onLog, onLogout, onChangePassword, username, open, onCloseMobile }) {
  const go = (t) => { setTab(t); onCloseMobile(); };
  const initial = (username || "?").charAt(0).toUpperCase();
  return (
    <aside className={`sidebar-desktop${open ? " open" : ""}`} style={{ width: 264, background: THEME.sidebarBg, borderRight: "none", display: "flex", flexDirection: "column", padding: "22px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 8px 22px", borderBottom: "1px solid rgba(255,255,255,0.1)", marginBottom: 18 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: THEME.primaryLight, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Beaker size={19} color={THEME.sidebarBg} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: THEME.sidebarTextActive }}>Reagent Log</div>
          <div style={{ fontSize: 11.5, color: THEME.sidebarText }}>LTC Lab Inventory</div>
        </div>
      </div>

      <nav style={{ flex: 1, overflowY: "auto" }}>
        {can("dashboard") && <SideItem active={tab === "dashboard" || tab === "detail"} onClick={() => go("dashboard")} icon={<LayoutGrid size={16} />} label="Dashboard" />}

        <SideGroup label="Tracking" />
        {can("reports") && <SideItem active={tab === "reports"} onClick={() => go("reports")} icon={<FileText size={16} />} label="Reports" />}
        {can("charts") && <SideItem active={tab === "charts"} onClick={() => go("charts")} icon={<BarChart3 size={16} />} label="Usage charts" />}
        {role === "owner" && <SideItem active={tab === "deletions"} onClick={() => go("deletions")} icon={<History size={16} />} label="Activity log" />}

        {can("settings") && (
          <>
            <SideGroup label="Management" />
            <SideItem active={tab === "settings"} onClick={() => go("settings")} icon={<SlidersHorizontal size={16} />} label="Settings" />
          </>
        )}

        {(can("log_use") || can("receive")) && <SideGroup label="Actions" />}
        {can("log_use") && <SideItem active={false} onClick={() => { onLog(); onCloseMobile(); }} icon={<TrendingDown size={16} />} label="Log use" />}
        {can("receive") && <SideItem active={false} onClick={() => { onAdd(); onCloseMobile(); }} icon={<Plus size={16} />} label="Receive stock" />}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, paddingTop: 16, borderTop: `1px solid rgba(255,255,255,0.1)` }}>
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: THEME.primaryLight, color: THEME.sidebarBg, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13.5, flexShrink: 0 }}>{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: THEME.sidebarTextActive, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{username}</div>
          <div style={{ fontSize: 11, color: THEME.sidebarText }}>{role === "owner" ? "Owner" : "Lab staff"}</div>
        </div>
        <button onClick={onChangePassword} title="Change my password" style={{ background: "none", border: "none", color: THEME.sidebarText, padding: 4 }}><KeyRound size={15} /></button>
        <button onClick={onLogout} title="Log out" style={{ background: "none", border: "none", color: THEME.sidebarText, padding: 4 }}><LogOut size={15} /></button>
      </div>
    </aside>
  );
}

function SideGroup({ label }) {
  return <div style={{ fontSize: 10.5, fontWeight: 700, color: THEME.sidebarText, letterSpacing: 0.6, textTransform: "uppercase", padding: "16px 10px 6px" }}>{label}</div>;
}

function SideItem({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: active ? "rgba(95,191,176,0.15)" : "transparent", color: active ? THEME.primaryLight : THEME.sidebarText, border: "none", borderRadius: 8, padding: "9px 10px", fontSize: 13.5, fontWeight: active ? 600 : 500, marginBottom: 2, textAlign: "left" }}>
      {icon} {label}
    </button>
  );
}

const TAB_TITLES = { dashboard: "Dashboard", detail: "Dashboard", reports: "Reports", settings: "Settings", charts: "Usage charts", deletions: "Activity log" };
const TAB_SUBTITLES = {
  dashboard: "Overview of laboratory inventory",
  detail: "Reagent lot details",
  reports: "Full inventory and consumption history",
  settings: "Manage users, permissions, and defaults",
  charts: "Consumption trends over time",
  deletions: "Full record of edits and deletions",
};

function TopBar({ tab, role, username, onEnableNotif, onMenuClick }) {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const initial = (username || "?").charAt(0).toUpperCase();
  return (
    <div style={{ background: "#fff", borderBottom: `1px solid ${THEME.cardBorder}`, padding: "18px 28px" }}>
      <div style={{ maxWidth: 1160, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <button className="sidebar-mobile-toggle" onClick={onMenuClick} style={{ display: "none", background: "none", border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, padding: 8, color: THEME.text, flexShrink: 0 }}>
            <Menu size={18} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{TAB_TITLES[tab] || "Reagent Log"}</div>
            <div style={{ fontSize: 13, color: THEME.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{TAB_SUBTITLES[tab] || ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <button onClick={onEnableNotif} title="Enable browser alerts" style={{ background: "#fff", border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: 9, color: "#475569" }}><Bell size={16} /></button>
          <div className="topbar-date" style={{ fontSize: 13, color: THEME.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>{today}</div>
          <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#E4F4F1", color: THEME.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13.5 }}>{initial}</div>
        </div>
      </div>
    </div>
  );
}

function StatCardV2({ icon, iconBg, iconColor, value, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="hover-lift"
      style={{
        background: "#fff",
        border: `1px solid ${active ? iconColor : THEME.cardBorder}`,
        borderRadius: 16,
        boxShadow: active ? `0 0 0 2px ${iconColor}33` : THEME.cardShadow,
        padding: 20,
        flex: 1,
        minWidth: 160,
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ width: 44, height: 44, borderRadius: "50%", background: iconBg, color: iconColor, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
        {icon}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: THEME.text, fontFamily: "'Inter', sans-serif", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 13, color: THEME.textMuted, marginTop: 4 }}>{label}</div>
    </button>
  );
}

function Panel({ title, action, children }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${THEME.cardBorder}`, borderRadius: 16, boxShadow: THEME.cardShadow, padding: 20, flex: 1, minWidth: 300 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: THEME.text }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function GaugeBar({ pct, color }) {
  return (
    <div style={{ width: 44, height: 64, border: "1.5px solid #C7D1CE", borderRadius: 5, position: "relative", overflow: "hidden", background: "#fff", flexShrink: 0 }}>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: `${Math.min(100, Math.max(3, pct))}%`, background: color, transition: "height .3s" }} />
      <div style={{ position: "absolute", top: 4, left: 0, right: 0, textAlign: "center", fontSize: 9, color: "#8A9694", fontFamily: "'IBM Plex Mono', monospace" }}>{Math.round(pct)}%</div>
    </div>
  );
}

function Dashboard({ groups, counts, departments, devices, logs, can, onDeleteReagent, onSelect }) {
  const [search, setSearch] = useState("");
  const [activeDept, setActiveDept] = useState("all");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px", color: "#7B8E8A" }}>
        <Droplet size={36} style={{ marginBottom: 12, opacity: 0.5 }} />
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: "#1B2B2E" }}>No reagents logged yet</div>
        <div style={{ fontSize: 14 }}>Use "Receive stock" above to add your first reagent batch.</div>
      </div>
    );
  }

  const allDevices = [...new Set(groups.map((g) => g.device).filter(Boolean))].sort();

  const expiringList = groups.filter((g) => g.expiringSoon).sort((a, b) => new Date(a.fefo.expiry_date) - new Date(b.fefo.expiry_date)).slice(0, 5);
  const lowStockList = groups.filter((g) => g.lowStock).slice(0, 5);
  const recentUsage = [...(logs || [])].filter((l) => !l.deleted).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const reagentById = {};
  groups.forEach((g) => g.items.forEach((i) => { reagentById[i.id] = { name: g.name, device: g.device, unit: g.unit }; }));

  const chartData = (() => {
    const days = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const byDay = {};
    (logs || []).forEach((l) => { if (!l.deleted) byDay[l.date] = (byDay[l.date] || 0) + Number(l.amount || 0); });
    return days.map((d) => ({ date: d.slice(5), qty: byDay[d] || 0 }));
  })();

  const term = search.trim().toLowerCase();
  let filteredGroups = term
    ? groups.filter((g) => g.name.toLowerCase().includes(term) || g.fefo.lot_number.toLowerCase().includes(term) || g.device.toLowerCase().includes(term))
    : groups;
  if (deviceFilter !== "all") filteredGroups = filteredGroups.filter((g) => g.device === deviceFilter);
  if (statusFilter === "critical") filteredGroups = filteredGroups.filter((g) => g.status === "red");
  else if (statusFilter === "low") filteredGroups = filteredGroups.filter((g) => g.lowStock);
  else if (statusFilter === "expiring") filteredGroups = filteredGroups.filter((g) => g.expiringSoon);
  else if (statusFilter === "stable") filteredGroups = filteredGroups.filter((g) => g.status === "green");

  const deptCounts = departments.map((d) => ({ dept: d, n: filteredGroups.filter((g) => g.department === d).length })).filter((x) => x.n > 0);
  const visibleDepts = activeDept === "all" ? deptCounts.map((x) => x.dept) : [activeDept];
  const byDept = visibleDepts.map((d) => ({ dept: d, items: filteredGroups.filter((g) => g.department === d) })).filter((x) => x.items.length);

  const noFilters = !term && deviceFilter === "all" && statusFilter === "all" && activeDept === "all";

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCardV2 icon={<Beaker size={20} />} iconBg="#E4F4F1" iconColor={THEME.primary} value={groups.length} label="Total reagents" active={statusFilter === "all"} onClick={() => setStatusFilter("all")} />
        <StatCardV2 icon={<AlertTriangle size={20} />} iconBg="#FFF7ED" iconColor="#EA580C" value={counts.lowStock} label="Low stock" active={statusFilter === "low"} onClick={() => setStatusFilter(statusFilter === "low" ? "all" : "low")} />
        <StatCardV2 icon={<Clock size={20} />} iconBg="#FEF2F2" iconColor="#DC2626" value={counts.expiringSoon} label="Expiring soon" active={statusFilter === "expiring"} onClick={() => setStatusFilter(statusFilter === "expiring" ? "all" : "expiring")} />
        <StatCardV2 icon={<Cpu size={20} />} iconBg="#F0FDF4" iconColor="#16A34A" value={(devices || []).length} label="Connected devices" />
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <Panel title="Expiring soon" action={<span style={{ fontSize: 12.5, color: THEME.primary, fontWeight: 600, cursor: "pointer" }} onClick={() => setStatusFilter("expiring")}>View all</span>}>
          {expiringList.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>Nothing expiring soon.</div>}
          {expiringList.map((g) => {
            const dExp = daysBetween(g.fefo.expiry_date, todayISO());
            return (
              <div key={g.key} onClick={() => onSelect(g)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}`, cursor: "pointer" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</div>
                  <div style={{ fontSize: 11.5, color: THEME.textMuted }}>Lot {g.fefo.lot_number}</div>
                </div>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: dExp < 0 ? "#DC2626" : "#EA580C", background: dExp < 0 ? "#FEF2F2" : "#FFF7ED", borderRadius: 6, padding: "3px 8px", flexShrink: 0 }}>
                  {dExp < 0 ? "Expired" : `${dExp}d left`}
                </span>
              </div>
            );
          })}
        </Panel>

        <Panel title="Usage analytics" action={<span style={{ fontSize: 12, color: THEME.textMuted }}>Last 30 days</span>}>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="usageFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={THEME.primary} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={THEME.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={THEME.cardBorder} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10.5, fill: THEME.textMuted }} interval={4} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10.5, fill: THEME.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12.5, borderRadius: 8, border: `1px solid ${THEME.cardBorder}` }} />
              <Area type="monotone" dataKey="qty" stroke={THEME.primary} strokeWidth={2} fill="url(#usageFill)" name="Used" />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <Panel title="Low stock" action={<span style={{ fontSize: 12.5, color: THEME.primary, fontWeight: 600, cursor: "pointer" }} onClick={() => setStatusFilter("low")}>View all</span>}>
          {lowStockList.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>Nothing low on stock.</div>}
          {lowStockList.map((g) => (
            <div key={g.key} onClick={() => onSelect(g)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}`, cursor: "pointer" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</div>
                <div style={{ fontSize: 11.5, color: THEME.textMuted }}>Min {g.fefo.low_stock_threshold} {g.unit}</div>
              </div>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#EA580C", background: "#FFF7ED", borderRadius: 6, padding: "3px 8px", flexShrink: 0 }}>{g.totalQty} {g.unit}</span>
            </div>
          ))}
        </Panel>

        <Panel title="Recent usage">
          {recentUsage.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>No consumption logged yet.</div>}
          {recentUsage.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: THEME.textMuted, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Reagent</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Used by</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Device</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Date</th>
                    <th style={{ padding: "0 0 8px 0", fontWeight: 600, textAlign: "right" }}>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {recentUsage.map((l) => {
                    const r = reagentById[l.reagent_id] || {};
                    return (
                      <tr key={l.id} style={{ borderTop: `1px solid ${THEME.cardBorder}` }}>
                        <td style={{ padding: "9px 8px 9px 0", fontWeight: 600, color: THEME.text }}>{r.name || "—"}</td>
                        <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.used_by}</td>
                        <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{r.device || "—"}</td>
                        <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.date}</td>
                        <td style={{ padding: "9px 0", textAlign: "right", fontWeight: 600, color: THEME.text }}>{l.amount} {r.unit || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        )}
        </Panel>
      </div>

      <div style={{ fontSize: 15, fontWeight: 700, color: THEME.text, margin: "28px 0 14px" }}>All reagents</div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          placeholder="Search reagent, lot number, or device…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 2, minWidth: 200, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 16, boxSizing: "border-box" }}
        />
        <select
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
          style={{ flex: 1, minWidth: 160, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 15, boxSizing: "border-box", background: "#fff" }}
        >
          <option value="all">All devices</option>
          {allDevices.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 22, overflowX: "auto", paddingBottom: 2 }}>
        <DeptPill active={activeDept === "all"} onClick={() => setActiveDept("all")} label="All" color="#516361" />
        {deptCounts.map(({ dept, n }) => (
          <DeptPill key={dept} active={activeDept === dept} onClick={() => setActiveDept(dept)} label={`${dept} · ${n}`} color={deptColor(dept, departments)} />
        ))}
      </div>

      {byDept.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#8A9694", fontSize: 13.5 }}>
          No matches{noFilters ? "" : " for this filter"}.
        </div>
      )}
      {byDept.map(({ dept, items }) => (
        <div key={dept} style={{ marginBottom: 26 }}>
          {activeDept === "all" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: deptColor(dept, departments) }} />
              <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>{dept}</span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((g) => {
              const m = STATUS_META[g.status];
              const pct = g.totalReceived > 0 ? (g.totalQty / g.totalReceived) * 100 : 0;
              const dExp = daysBetween(g.fefo.expiry_date, todayISO());
              return (
                <div key={g.key} onClick={() => onSelect(g)} className="dash-row" style={{ display: "flex", alignItems: "center", gap: 16, background: "#fff", border: "1px solid #E1E8E5", borderLeft: `4px solid ${m.color}`, borderRadius: 8, padding: "12px 16px", textAlign: "left", cursor: "pointer", flexWrap: "wrap" }}>
                  <GaugeBar pct={pct} color={m.color} />
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {g.name}
                      {g.device && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#0F7173", background: "#E4F4F1", borderRadius: 5, padding: "2px 6px" }}>{g.device}</span>
                      )}
                      {g.lowStock && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#B8860B", background: "#FBF3DF", borderRadius: 5, padding: "2px 6px" }}>Low stock</span>
                      )}
                      {g.expiringSoon && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#8A5A2B", background: "#FBF0E4", borderRadius: 5, padding: "2px 6px" }}>Expiring soon</span>
                      )}
                      {g.flagged && <ClipboardX size={13} color="#B8860B" title="Inspection issue on receipt" />}
                    </div>
                    <div style={{ fontSize: 12.5, color: "#7B8E8A", fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>
                      {g.totalQty} {g.unit} total left · {g.items.length > 1 ? `${g.items.length} lots (nearest: ${g.fefo.lot_number})` : `Lot ${g.fefo.lot_number}`}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: m.color }}>{m.label}</div>
                    <div style={{ fontSize: 11.5, color: "#8A9694" }}>{dExp < 0 ? `expired ${Math.abs(dExp)}d ago` : `expires in ${dExp}d`}</div>
                  </div>
                  {can("delete") && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteReagent(g.fefo.id); }}
                      title="Remove this lot"
                      style={{ background: "none", border: "none", color: "#C1432B", padding: 4 }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                  <ChevronRight size={16} color="#B7C3C0" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function DeptPill({ active, onClick, label, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        flexShrink: 0,
        background: active ? color : "#fff",
        color: active ? "#fff" : "#3A4A48",
        border: `1px solid ${active ? color : "#D6DEDB"}`,
        borderRadius: 20,
        padding: "7px 14px",
        fontSize: 12.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function DetailView({ group, logs, can, warnDays, onBack, onEditReagent, onDeleteReagent, onEditLog, onDeleteLog }) {
  const last30 = logs.filter((l) => daysBetween(todayISO(), l.date) <= 30);
  const consumed30 = last30.reduce((s, l) => s + l.amount, 0);
  const avgDaily = consumed30 / 30;
  const daysLeft = avgDaily > 0 ? Math.round(group.totalQty / avgDaily) : null;

  const inspectionLabels = {
    intact_container: "Intact container",
    complete_compound: "Complete components",
    expiration_validity: "Expiration validity",
    lot_matches_kit: "Lot number of kit matches components",
    storage_condition_ok: "Storage condition",
  };

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#0F7173", fontSize: 13, fontWeight: 600, marginBottom: 18, display: "flex", alignItems: "center", gap: 4 }}>← Back to dashboard</button>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{group.name}</h2>
      <div style={{ fontSize: 13, color: "#7B8E8A", marginBottom: 20, fontFamily: "'IBM Plex Mono', monospace" }}>{group.department}{group.device ? ` · ${group.device}` : ""} · {group.totalQty} {group.unit} in stock across {group.items.length} lot(s)</div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 11, color: "#8A9694", fontWeight: 600, textTransform: "uppercase" }}>Avg daily use (30d)</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{avgDaily.toFixed(1)} <span style={{ fontSize: 13, fontWeight: 500 }}>{group.unit}/day</span></div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 11, color: "#8A9694", fontWeight: 600, textTransform: "uppercase" }}>Projected runout</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{daysLeft !== null ? `${daysLeft}d` : "—"}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 150 }}>
          <div style={{ fontSize: 11, color: "#8A9694", fontWeight: 600, textTransform: "uppercase" }}>Consumed this month</div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{consumed30} <span style={{ fontSize: 13, fontWeight: 500 }}>{group.unit}</span></div>
        </div>
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>LOTS — use earliest expiry first (FEFO)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 26 }}>
        {group.items.map((it, idx) => {
          const dExp = daysBetween(it.expiry_date, todayISO());
          const m = STATUS_META[statusOf(it, warnDays)];
          const failedItems = INSPECTION_KEYS.filter((k) => it[k] === false).map((k) => inspectionLabels[k]);
          return (
            <div key={it.id} style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {idx === 0 && <span style={{ background: "#0F7173", color: "#fff", fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 4 }}>USE FIRST</span>}
                <div style={{ flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>Lot {it.lot_number}</div>
                <div style={{ fontSize: 13 }}>{it.current_quantity}/{it.quantity_received} {it.unit}</div>
                <div style={{ fontSize: 12.5, color: m.color, fontWeight: 600 }}>{dExp < 0 ? `expired ${Math.abs(dExp)}d ago` : `${dExp}d left`}</div>
                {can("edit") && <button onClick={() => onEditReagent(it)} style={{ background: "none", border: "none", color: "#8A9694" }}><Pencil size={14} /></button>}
                {can("delete") && <button onClick={() => onDeleteReagent(it.id)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={14} /></button>}
              </div>
              {failedItems.length > 0 && (
                <div style={{ marginTop: 8, background: "#FBF3DF", border: "1px solid #B8860B33", borderRadius: 6, padding: "6px 10px", fontSize: 11.5, color: "#7A5C08" }}>
                  ⚠ Inspection issue: {failedItems.join(", ")}
                </div>
              )}
              {(it.receiving_notes || it.inspection_notes) && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: "#516361" }}>
                  {it.receiving_notes && <div><b>Note:</b> {it.receiving_notes}</div>}
                  {it.inspection_notes && <div><b>Inspection note:</b> {it.inspection_notes}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>CONSUMPTION HISTORY</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {logs.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No usage logged yet.</div>}
        {[...logs].sort((a, b) => new Date(b.date) - new Date(a.date)).map((l) => (
          <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13, padding: "8px 0", borderBottom: "1px solid #EEF2F0" }}>
            <div style={{ width: 90, color: "#8A9694", fontFamily: "'IBM Plex Mono', monospace" }}>{l.date}</div>
            <div style={{ flex: 1 }}>−{l.amount} {group.unit}</div>
            <div style={{ color: "#7B8E8A", display: "flex", alignItems: "center", gap: 4 }}><Users size={12} /> {l.used_by}</div>
            <div style={{ fontSize: 11, color: l.tested_by_qc ? "#2F6B4F" : "#8A9694", fontWeight: 600 }}>{l.tested_by_qc ? "QC ✓" : "QC —"}</div>
            {can("edit") && <button onClick={() => onEditLog(l)} style={{ background: "none", border: "none", color: "#8A9694" }}><Pencil size={13} /></button>}
            {can("delete") && <button onClick={() => onDeleteLog(l)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={13} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

const INSPECTION_REPORT_LABELS = {
  intact_container: "Intact container",
  complete_compound: "Complete components",
  expiration_validity: "Expiration validity",
  lot_matches_kit: "Lot matches kit components",
  storage_condition_ok: "Storage condition",
};

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function Reports({ reagents, logs, departments, role, onPurgeReagent, onPurgeLog }) {
  const [viewTab, setViewTab] = useState("receive");
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(todayISO());
  const [searchLot, setSearchLot] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const reagentById = {};
  reagents.forEach((r) => { reagentById[r.id] = r; });

  const matchedLots = useMemo(() => {
    const term = searchLot.trim().toLowerCase();
    return reagents
      .filter((r) => (term ? r.lot_number.toLowerCase().includes(term) : r.date_added >= dateFrom && r.date_added <= dateTo))
      .filter((r) => (deptFilter ? r.department === deptFilter : true))
      .sort((a, b) => new Date(b.date_added) - new Date(a.date_added));
  }, [reagents, searchLot, dateFrom, dateTo, deptFilter]);

  const matchedLogs = useMemo(() => {
    const term = searchLot.trim().toLowerCase();
    return logs
      .filter((l) => {
        const r = reagentById[l.reagent_id];
        if (term) {
          return (r && r.lot_number.toLowerCase().includes(term)) || (r && r.name.toLowerCase().includes(term)) || l.used_by.toLowerCase().includes(term);
        }
        return l.date >= dateFrom && l.date <= dateTo;
      })
      .filter((l) => (deptFilter ? reagentById[l.reagent_id]?.department === deptFilter : true))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [logs, reagents, searchLot, dateFrom, dateTo, deptFilter]);

  function logsFor(reagentId) {
    return logs.filter((l) => l.reagent_id === reagentId);
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const rows = [];
    matchedLots.forEach((r) => {
      const rLogs = logsFor(r.id);
      const base = {
        Reagent: r.name,
        Department: r.department,
        Type: r.item_type,
        "Lot Number": r.lot_number,
        "Received By": r.added_by,
        "Received Date": r.date_added,
        "Expiry Date": r.expiry_date,
        "Qty Received": r.quantity_received,
        "Qty Remaining": r.current_quantity,
        Unit: r.unit,
        "Intact Container": r.intact_container ? "Yes" : "No",
        "Complete Components": r.complete_compound ? "Yes" : "No",
        "Expiration Validity": r.expiration_validity ? "Yes" : "No",
        "Lot Matches Kit": r.lot_matches_kit ? "Yes" : "No",
        "Storage Condition": r.storage_condition_ok ? "Yes" : "No",
        "Receiving Note": r.receiving_notes || "",
        "Inspection Note": r.inspection_notes || "",
        "Lot Deleted": r.deleted ? "Yes" : "No",
      };
      if (rLogs.length === 0) {
        rows.push({ ...base, "Consumption Date": "", "Amount Used": "", "Used By": "", "Tested by QC": "", "Log Deleted": "" });
      } else {
        rLogs.forEach((l) => {
          rows.push({ ...base, "Consumption Date": l.date, "Amount Used": l.amount, "Used By": l.used_by, "Tested by QC": l.tested_by_qc ? "Yes" : "No", "Log Deleted": l.deleted ? "Yes" : "No" });
        });
      }
    });
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "No records match this filter." }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Report");
    XLSX.writeFile(wb, `reagent-report-${dateFrom}-to-${dateTo}.xlsx`);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Full report</h2>
        <button onClick={exportExcel} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "8px 12px", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Download size={14} /> Export Excel</button>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        <button
          onClick={() => setViewTab("receive")}
          style={{ background: viewTab === "receive" ? "#0F7173" : "#fff", color: viewTab === "receive" ? "#fff" : "#516361", border: "1px solid #E1E8E5", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700 }}
        >
          Receive ({matchedLots.length})
        </button>
        <button
          onClick={() => setViewTab("logs")}
          style={{ background: viewTab === "logs" ? "#0F7173" : "#fff", color: viewTab === "logs" ? "#fff" : "#516361", border: "1px solid #E1E8E5", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700 }}
        >
          Log use ({matchedLogs.length})
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "#7B8E8A" }}>From</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ border: "1px solid #C7D1CE", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
          <span style={{ fontSize: 12, color: "#7B8E8A" }}>To</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ border: "1px solid #C7D1CE", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
        </div>
        <input
          placeholder={viewTab === "receive" ? "Search by lot number…" : "Search by lot number, reagent, or used by…"}
          value={searchLot}
          onChange={(e) => setSearchLot(e.target.value)}
          style={{ border: "1px solid #C7D1CE", borderRadius: 6, padding: "7px 10px", fontSize: 13, flex: 1, minWidth: 180 }}
        />
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ border: "1px solid #C7D1CE", borderRadius: 6, padding: "7px 10px", fontSize: 13 }}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {searchLot.trim() && <div style={{ fontSize: 12, color: "#8A9694", marginBottom: 10 }}>Searching — date filter is ignored while searching.</div>}

      {viewTab === "receive" && (
        <>
          {matchedLots.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#8A9694", fontSize: 13.5 }}>No records match this filter.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {matchedLots.map((r) => {
              const rLogCount = logsFor(r.id).length;
              const failedItems = Object.keys(INSPECTION_REPORT_LABELS).filter((k) => r[k] === false);
              return (
                <div key={r.id} style={{ background: "#fff", border: r.deleted ? "1px solid #C1432B55" : "1px solid #E1E8E5", borderRadius: 10, padding: 16, opacity: r.deleted ? 0.75 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                      {r.name}
                      {r.deleted && <span style={{ fontSize: 10, fontWeight: 700, color: "#C1432B", background: "#FBEAE6", padding: "2px 7px", borderRadius: 4 }}>DELETED by {r.deleted_by} · {fmtDateTime(r.deleted_at)}</span>}
                      {r.deleted && role === "owner" && (
                        <button onClick={() => onPurgeReagent(r.id)} style={{ background: "none", border: "1px solid #C1432B", color: "#C1432B", borderRadius: 6, padding: "3px 9px", fontSize: 10.5, fontWeight: 700 }}>Erase permanently</button>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#7B8E8A", fontFamily: "'IBM Plex Mono', monospace" }}>{r.department} · {r.item_type} · Lot {r.lot_number}</div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 12, fontSize: 12.5 }}>
                    <div><div style={{ color: "#2F6B4F", fontSize: 10.5, textTransform: "uppercase", fontWeight: 700 }}>Received by</div>{r.added_by}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Received date</div>{r.date_added}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Expiry date</div>{r.expiry_date}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Quantity</div>{r.current_quantity}/{r.quantity_received} {r.unit}</div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {Object.entries(INSPECTION_REPORT_LABELS).map(([key, label]) => (
                      <span key={key} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, background: r[key] ? "#E8F2EC" : "#FBEAE6", color: r[key] ? "#2F6B4F" : "#C1432B", fontWeight: 600 }}>
                        {r[key] ? "✓" : "✕"} {label}
                      </span>
                    ))}
                  </div>
                  {failedItems.length > 0 && (
                    <div style={{ fontSize: 11.5, color: "#8A2E1F", marginBottom: 10 }}>⚠ Inspection issue on receipt</div>
                  )}
                  {(r.receiving_notes || r.inspection_notes) && (
                    <div style={{ fontSize: 12, color: "#516361", marginBottom: 12, background: "#F7F9F8", border: "1px solid #E1E8E5", borderRadius: 6, padding: "8px 10px" }}>
                      {r.receiving_notes && <div><b>Receiving note:</b> {r.receiving_notes}</div>}
                      {r.inspection_notes && <div><b>Inspection note:</b> {r.inspection_notes}</div>}
                    </div>
                  )}

                  <div style={{ fontSize: 12, color: "#7B8E8A" }}>
                    {rLogCount === 0 ? "No usage recorded yet." : `${rLogCount} usage ${rLogCount === 1 ? "entry" : "entries"} — see the "Log use" tab above.`}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {viewTab === "logs" && (
        <>
          {matchedLogs.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#8A9694", fontSize: 13.5 }}>No records match this filter.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {matchedLogs.map((l) => {
              const r = reagentById[l.reagent_id];
              return (
                <div key={l.id} style={{ background: "#fff", border: l.deleted ? "1px solid #C1432B55" : "1px solid #E1E8E5", borderRadius: 10, padding: 16, opacity: l.deleted ? 0.75 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                      {r ? r.name : "Unknown reagent"}
                      {l.deleted && <span style={{ fontSize: 10, fontWeight: 700, color: "#C1432B", background: "#FBEAE6", padding: "2px 7px", borderRadius: 4 }}>DELETED by {l.deleted_by} · {fmtDateTime(l.deleted_at)}</span>}
                      {l.deleted && role === "owner" && (
                        <button onClick={() => onPurgeLog(l.id)} style={{ background: "none", border: "1px solid #C1432B", color: "#C1432B", borderRadius: 6, padding: "3px 9px", fontSize: 10.5, fontWeight: 700 }}>Erase permanently</button>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#7B8E8A", fontFamily: "'IBM Plex Mono', monospace" }}>{r ? `${r.department} · Lot ${r.lot_number}${r.device ? ` · ${r.device}` : ""}` : ""}</div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 12, fontSize: 12.5 }}>
                    <div><div style={{ color: "#1D4ED8", fontSize: 10.5, textTransform: "uppercase", fontWeight: 700 }}>Used by</div>{l.used_by}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Date</div>{l.date}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Amount used</div>{l.amount} {r ? r.unit : ""}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Tested by QC</div>{l.tested_by_qc ? "Yes" : "No"}</div>
                  </div>

                  {l.note && (
                    <div style={{ fontSize: 12, color: "#516361", background: "#F7F9F8", border: "1px solid #E1E8E5", borderRadius: 6, padding: "8px 10px" }}>
                      <b>Note:</b> {l.note}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function DeletionsLog({ activityLog, onClear }) {
  const ACTION_META = {
    edit: { label: "Edited", color: "#B8860B", bg: "#FBF3DF" },
    delete: { label: "Removed", color: "#C1432B", bg: "#FBEAE6" },
    purge: { label: "Erased permanently", color: "#8A2E1F", bg: "#FBEAE6" },
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Activity log</h2>
        {activityLog.length > 0 && (
          <button onClick={onClear} style={{ background: "none", border: "1px solid #C1432B", color: "#C1432B", borderRadius: 7, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>
            Clear all activity
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, color: "#7B8E8A", marginBottom: 24 }}>Every edit, removal, and permanent erase — in order, newest first. Only visible to your account.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {activityLog.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No activity recorded yet.</div>}
        {activityLog.map((e) => {
          const m = ACTION_META[e.action] || { label: e.action, color: "#516361", bg: "#F0F3F2" };
          return (
            <div key={e.id} style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: m.color, background: m.bg, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", flexShrink: 0 }}>{m.label}</span>
              <div style={{ flex: 1, fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{e.description}</div>
                <div style={{ fontSize: 11.5, color: "#8A9694", marginTop: 2 }}>{e.entity === "reagent" ? "Reagent lot" : "Usage log"} · by <b>{e.performed_by}</b> on {fmtDateTime(e.performed_at)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,25,26,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 440, maxHeight: "88vh", overflowY: "auto", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A9694" }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
const labelStyle = { fontSize: 12.5, fontWeight: 600, color: "#516361" };

function LogConsumptionModal({ reagents, username, onClose, onSubmit }) {
  const [typeFilter, setTypeFilter] = useState("");
  const filteredReagents = typeFilter ? reagents.filter((r) => r.item_type === typeFilter) : reagents;
  const names = [...new Set(filteredReagents.map((r) => r.name))];
  const [name, setName] = useState(names[0] || "");
  const devicesForName = [...new Set(reagents.filter((r) => r.name === name).map((r) => r.device || ""))];
  const [device, setDevice] = useState(devicesForName[0] || "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const usedBy = username;
  const [note, setNote] = useState("");
  const [testedByQC, setTestedByQC] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  const lots = reagents.filter((r) => r.name === name && (r.device || "") === device).sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
  const fefo = lots[0];

  function changeType(t) {
    setTypeFilter(t);
    const list = t ? reagents.filter((r) => r.item_type === t) : reagents;
    const firstName = [...new Set(list.map((r) => r.name))][0] || "";
    changeName(firstName);
  }

  function changeName(newName) {
    setName(newName);
    const opts = [...new Set(reagents.filter((r) => r.name === newName).map((r) => r.device || ""))];
    setDevice(opts[0] || "");
  }

  function handleScan(text) {
    const match = reagents.find((r) => r.lot_number === text);
    if (match) {
      setName(match.name);
      setDevice(match.device || "");
    }
    setShowScanner(false);
  }

  function submit() {
    if (!fefo || !amount || !usedBy) return;
    onSubmit({ reagentId: fefo.id, amount: Number(amount), date, usedBy, note, testedByQC });
  }

  if (reagents.length === 0) {
    return <Modal title="Log consumption" onClose={onClose}><div style={{ fontSize: 13.5, color: "#7B8E8A" }}>No reagents in inventory yet. Receive stock first.</div></Modal>;
  }

  return (
    <Modal title="Log daily consumption" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Type
          <select style={inputStyle} value={typeFilter} onChange={(e) => changeType(e.target.value)}>
            <option value="">All types</option>
            <option value="Reagent">Reagent</option>
            <option value="QC">QC</option>
            <option value="Cal">Cal</option>
            <option value="Other">Other</option>
          </select>
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <label style={{ ...labelStyle, flex: 1 }}>Reagent (type to search)
            <input list="log-use-names" style={inputStyle} value={name} onChange={(e) => changeName(e.target.value)} placeholder="Search reagent name" />
            <datalist id="log-use-names">
              {names.map((n) => <option key={n} value={n} />)}
            </datalist>
          </label>
          <button type="button" onClick={() => setShowScanner(true)} style={{ background: "#F0F3F2", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 10px" }}><ScanLine size={16} /></button>
        </div>
        {names.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9694" }}>No items of this type in stock.</div>}
        {devicesForName.some(Boolean) && (
          <label style={labelStyle}>Device used
            <select style={inputStyle} value={device} onChange={(e) => setDevice(e.target.value)}>
              {devicesForName.map((d) => <option key={d || "none"} value={d}>{d || "No device specified"}</option>)}
            </select>
          </label>
        )}
        {name && !fefo && <div style={{ fontSize: 12.5, color: "#C1432B" }}>No stock of "{name}" on this device.</div>}
        {fefo && (
          <div style={{ background: "#EAF6F4", border: "1px solid #C6E8E3", borderRadius: 7, padding: "9px 12px", fontSize: 12.5, color: "#0F5F5B" }}>
            FEFO suggests <b>Lot {fefo.lot_number}</b> ({fefo.current_quantity} {fefo.unit} left, expires {fefo.expiry_date}){lots.length > 1 ? ` — ${lots.length} lots available` : ""}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...labelStyle, flex: 1 }}>Amount used ({fefo?.unit || "unit"})<input type="number" style={inputStyle} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label style={{ ...labelStyle, flex: 1 }}>Date<input type="date" style={inputStyle} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <label style={labelStyle}>Used by
          <div style={{ ...inputStyle, background: "#F0F3F2", color: "#516361", display: "flex", alignItems: "center" }}>{usedBy}</div>
        </label>
        <label style={labelStyle}>Note (optional)<input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. daily QC run" /></label>
        <YesNoRow label="Tested by QC" value={testedByQC} onChange={setTestedByQC} />
        <button onClick={submit} disabled={!fefo} style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: fefo ? 1 : 0.5 }}>Save log</button>
      </div>
      {showScanner && <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleScan} />}
    </Modal>
  );
}

function EditReagentModal({ reagent, onClose, onSave }) {
  const [form, setForm] = useState({ ...reagent });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal title={`Edit lot ${reagent.lot_number}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Lot number<input style={inputStyle} value={form.lot_number} onChange={set("lot_number")} /></label>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...labelStyle, flex: 1 }}>Quantity received<input type="number" style={inputStyle} value={form.quantity_received} onChange={set("quantity_received")} /></label>
          <label style={{ ...labelStyle, flex: 1 }}>Current quantity<input type="number" style={inputStyle} value={form.current_quantity} onChange={set("current_quantity")} /></label>
        </div>
        <label style={labelStyle}>Expiry date<input type="date" style={inputStyle} value={form.expiry_date} onChange={set("expiry_date")} /></label>
        <label style={labelStyle}>Low stock alert below<input type="number" style={inputStyle} value={form.low_stock_threshold} onChange={set("low_stock_threshold")} /></label>
        <button
          onClick={() => onSave({ ...form, quantity_received: Number(form.quantity_received), current_quantity: Number(form.current_quantity), low_stock_threshold: Number(form.low_stock_threshold) })}
          style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}
        >Save changes</button>
      </div>
    </Modal>
  );
}

function EditLogModal({ log, onClose, onSave }) {
  const [form, setForm] = useState({ ...log });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal title="Edit consumption log" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Amount<input type="number" style={inputStyle} value={form.amount} onChange={set("amount")} /></label>
        <label style={labelStyle}>Date<input type="date" style={inputStyle} value={form.date} onChange={set("date")} /></label>
        <label style={labelStyle}>Used by<input style={inputStyle} value={form.used_by} onChange={set("used_by")} /></label>
        <label style={labelStyle}>Note<input style={inputStyle} value={form.note || ""} onChange={set("note")} /></label>
        <YesNoRow label="Tested by QC" value={form.tested_by_qc} onChange={(v) => setForm((f) => ({ ...f, tested_by_qc: v }))} />
        <button onClick={() => onSave({ ...form, amount: Number(form.amount) }, log)} style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}>Save changes</button>
      </div>
    </Modal>
  );
}

function ChangePasswordModal({ onClose, onSave }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!current || !next) { setMsg("Fill in both fields."); return; }
    if (next !== confirm) { setMsg("New passwords don't match."); return; }
    setSaving(true);
    const err = await onSave(current, next);
    setSaving(false);
    if (err) { setMsg(err); return; }
    setMsg("Password changed.");
    setTimeout(onClose, 1200);
  }

  return (
    <Modal title="Change my password" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Current password<input type="password" style={inputStyle} value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label style={labelStyle}>New password<input type="password" style={inputStyle} value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label style={labelStyle}>Confirm new password<input type="password" style={inputStyle} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {msg && <div style={{ fontSize: 12.5, color: msg === "Password changed." ? "#2F6B4F" : "#C1432B" }}>{msg}</div>}
        <button disabled={saving} onClick={submit} style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: saving ? 0.7 : 1 }}>
          {saving ? "Saving…" : "Save new password"}
        </button>
      </div>
    </Modal>
  );
}
