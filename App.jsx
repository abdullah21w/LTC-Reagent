import React, { useState, useEffect, useMemo } from "react";
import { Beaker, TrendingDown, Plus, Users, FileText, LayoutGrid, ChevronRight, ChevronLeft, X, Droplet, ScanLine, Pencil, Trash2, Bell, LogOut, SlidersHorizontal, Download, AlertTriangle, ClipboardX, History, BarChart3, KeyRound, Menu, Cpu, Clock, Moon, Sun, Archive, Ban, CalendarDays, ShoppingCart, Printer, CheckCircle2, ClipboardCheck } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { supabase } from "./supabaseClient";
import { verifyPassword, hashPassword } from "./passwordUtils";
import Login from "./Login";
import Settings from "./Settings";
import BarcodeScanner from "./BarcodeScanner";
import ReceiveWizard, { YesNoRow } from "./ReceiveWizard";
import Charts from "./Charts";
import StockCount from "./StockCount";

const DEPT_PALETTE = ["#0F7173", "#B5473A", "#8A5A2B", "#5A6ACF", "#2F8F5B", "#B8860B", "#7A4FA3", "#C1432B"];
function deptColor(dept, list) {
  const i = Math.max(0, list.indexOf(dept));
  return DEPT_PALETTE[i % DEPT_PALETTE.length];
}
const INSPECTION_KEYS = ["intact_container", "complete_compound", "expiration_validity", "lot_matches_kit", "storage_condition_ok"];

// Colors for the client-side "Full report" PDF export (Reports page) — same
// palette as the server-side monthly report in api/_reportBuilder.js, kept
// as a separate literal copy since that file ships to a Vercel function and
// can't share an import with the Vite-bundled frontend.
const REPORT_TEAL = "#0F7173";
const REPORT_NAVY = "#1B2B2E";
const REPORT_MUTED = "#7B8E8A";
const REPORT_RED = "#C1432B";
const REPORT_AMBER = "#B8860B";
const REPORT_BORDER = "#E1E8E5";
const REPORT_STRIPE = "#F7F9F8";

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");

const THEME = {
  primary: "var(--primary)",
  primaryLight: "var(--primary-light)",
  sidebarBg: "var(--sidebar-bg)",
  sidebarText: "var(--sidebar-text)",
  sidebarTextActive: "var(--sidebar-text-active)",
  bg: "var(--bg)",
  cardBg: "var(--card-bg)",
  cardBorder: "var(--card-border)",
  cardShadow: "var(--card-shadow)",
  text: "var(--text)",
  textMuted: "var(--text-muted)",
};

function statusOf(item, warnDays = 30) {
  const lowStock = item.current_quantity <= item.low_stock_threshold;
  if (item.current_quantity <= 0) return "red";
  if (!item.expiry_date) return lowStock ? "yellow" : "green";
  const dExp = daysBetween(item.expiry_date, todayISO());
  if (dExp < 0) return "red";
  if (dExp <= warnDays || lowStock) return "yellow";
  return "green";
}

function isExpiringSoonItem(item, warnDays) {
  if (!item.expiry_date) return false;
  const dExp = daysBetween(item.expiry_date, todayISO());
  return dExp >= 0 && dExp <= warnDays;
}

// Sorts lots for FEFO use: dated lots first (soonest expiry first), then
// undated lots ordered oldest-received first (FIFO) since there's no expiry
// to prioritize by.
// Normalizes a name for comparison: strips invisible unicode characters
// (zero-width spaces, bidi marks — easy to pick up by accident when typing
// with a mixed Arabic/English keyboard), trims, lowercases, and collapses
// repeated whitespace. Prevents "looks identical but doesn't match" search bugs.
function normalizeName(s) {
  return (s || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compareLots(a, b) {
  const aHas = !!a.expiry_date, bHas = !!b.expiry_date;
  if (aHas && bHas) return new Date(a.expiry_date) - new Date(b.expiry_date);
  if (aHas !== bHas) return aHas ? -1 : 1;
  return new Date(a.date_added) - new Date(b.date_added);
}

// When a lot has carton packaging enabled, current_quantity/quantity_received
// are stored in boxes (the fine-grained unit actually decremented by Log use).
// This turns that raw box count into a { main, sub } display: cartons as the
// headline number, total boxes remaining as the smaller supporting text.
// Lots without packaging return { main: "<qty> <unit>", sub: null } unchanged.
function formatCartonQty(qty, unitsPerCarton, unit) {
  if (!unitsPerCarton || unitsPerCarton <= 0) return { main: `${qty} ${unit}`, sub: null };
  const cartons = Math.floor(qty / unitsPerCarton);
  return { main: `${cartons} box${cartons === 1 ? "" : "es"}`, sub: `${qty} ${unit} remaining` };
}

const LOT_TO_LOT_DEVICES = ["vitros"];
function needsLotToLot(deviceName) {
  return !!deviceName && LOT_TO_LOT_DEVICES.includes(deviceName.trim().toLowerCase());
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

const FULL_PERMISSIONS = { dashboard: true, reports: true, charts: true, settings: true, receive: true, log_use: true, edit: true, delete: true, discard: true, stock_count: true };
const DEFAULT_NEW_PERMISSIONS = { dashboard: true, reports: true, charts: false, settings: false, receive: false, log_use: false, edit: false, delete: false, stock_count: false };

const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours

export default function App() {
  // If the stored session is missing or older than 12 hours, clear it so the
  // Login screen shows again — this is what makes the Activity log actually
  // reflect real sessions instead of one login staying valid forever.
  const sessionAt = localStorage.getItem("reagent_session_at");
  const sessionValid = sessionAt && (Date.now() - Number(sessionAt) <= SESSION_MAX_MS);
  if (!sessionValid) {
    localStorage.removeItem("reagent_role");
    localStorage.removeItem("reagent_username");
    localStorage.removeItem("reagent_perms");
    localStorage.removeItem("reagent_account_id");
    localStorage.removeItem("reagent_session_at");
  }

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
  const [lotToLotPending, setLotToLotPending] = useState([]);
  const [snoozes, setSnoozes] = useState([]);
  const [loginSummary, setLoginSummary] = useState(null);
  const [lotToLotNotice, setLotToLotNotice] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [showWizard, setShowWizard] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("reagent_dark") === "1");
  function toggleDarkMode() {
    setDarkMode((d) => {
      localStorage.setItem("reagent_dark", !d ? "1" : "0");
      return !d;
    });
  }
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [editReagent, setEditReagent] = useState(null);
  const [discardReagentTarget, setDiscardReagentTarget] = useState(null);
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
    const { data: ltl } = await supabase.from("lot_to_lot_pending").select("*");
    const { data: sn } = await supabase.from("low_stock_snoozes").select("*");
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
    setLotToLotPending(ltl || []);
    setSnoozes(sn || []);
  }

  async function logActivity(action, entity, description, performedBy) {
    await supabase.from("audit_log").insert({ action, entity, description, performed_by: performedBy || username });
  }

  useEffect(() => {
    ensureConfig();
    loadAll();
  }, []);

  async function handleLogin(newRole, newUsername, newPerms, newAccountId) {
    const effectivePerms = newRole === "owner" ? FULL_PERMISSIONS : (newPerms || {});
    localStorage.setItem("reagent_role", newRole);
    localStorage.setItem("reagent_username", newUsername);
    localStorage.setItem("reagent_perms", JSON.stringify(effectivePerms));
    localStorage.setItem("reagent_session_at", String(Date.now()));
    if (newAccountId) localStorage.setItem("reagent_account_id", newAccountId);
    else localStorage.removeItem("reagent_account_id");
    setRole(newRole);
    setUsername(newUsername);
    setPerms(effectivePerms);
    setAccountId(newAccountId || null);

    // "What changed since your last login" — compare precisely against a
    // snapshot of exactly which groups were Critical/Low stock at the time
    // of this user's previous login, not a date-based guess.
    const myPastLogins = (activityLog || [])
      .filter((e) => e.action === "login" && e.performed_by === newUsername)
      .sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
    const currentCriticalKeys = groups.filter((g) => g.status === "red").map((g) => g.key);
    const currentLowStockKeys = groups.filter((g) => g.lowStock).map((g) => g.key);

    if (myPastLogins[0]) {
      const since = myPastLogins[0].performed_at.slice(0, 10);
      const received = (reagents || []).filter((r) => r.date_added >= since).length;
      const used = (logs || []).filter((l) => !l.deleted && l.date >= since).length;

      const { data: prevSnap } = await supabase
        .from("login_snapshots")
        .select("critical_keys,low_stock_keys")
        .eq("username", newUsername)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const prevCritical = new Set((prevSnap && prevSnap.critical_keys) || []);
      const prevLowStock = new Set((prevSnap && prevSnap.low_stock_keys) || []);
      const newCritical = currentCriticalKeys.filter((k) => !prevCritical.has(k)).length;
      const newLowStock = currentLowStockKeys.filter((k) => !prevLowStock.has(k)).length;

      setLoginSummary({ since, received, used, critical: newCritical, lowStock: newLowStock });
    }

    await supabase.from("login_snapshots").insert({ username: newUsername, critical_keys: currentCriticalKeys, low_stock_keys: currentLowStockKeys });

    logActivity("login", "user", `${newUsername} (${newRole === "owner" ? "Owner" : "Staff"}) signed in`, newUsername);
    const order = ["dashboard", "reports", "charts", "settings"];
    const firstTab = order.find((t) => newRole === "owner" || effectivePerms[t]) || "dashboard";
    setTab(firstTab);
  }
  function logout() {
    localStorage.removeItem("reagent_role");
    localStorage.removeItem("reagent_username");
    localStorage.removeItem("reagent_perms");
    localStorage.removeItem("reagent_account_id");
    localStorage.removeItem("reagent_session_at");
    setRole(null);
    setUsername("");
    setPerms(null);
    setAccountId(null);
  }

  async function changeOwnPassword(currentPassword, newPassword) {
    if (role === "owner") {
      if (!(await verifyPassword(currentPassword, config.owner_password))) return "Current password is incorrect.";
      const newHash = await hashPassword(newPassword);
      const { error } = await supabase.from("app_config").update({ owner_password: newHash }).eq("id", 1);
      if (error) return "Could not save the new password.";
      ensureConfig();
      return null;
    }
    const mine = staffAccounts.find((s) => s.id === accountId);
    if (!mine) return "Could not find your account.";
    if (!(await verifyPassword(currentPassword, mine.password))) return "Current password is incorrect.";
    const newHash = await hashPassword(newPassword);
    const { error } = await supabase.from("staff_accounts").update({ password: newHash }).eq("id", accountId);
    if (error) return "Could not save the new password.";
    loadAll();
    return null;
  }

  async function addReagent(entry) {
    if (!can("receive")) return;
    await supabase.from("reagents").insert({
      name: (entry.name || "").replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "").trim(),
      department: entry.department,
      item_type: entry.itemType,
      device: entry.device || "",
      lot_number: entry.lotNumber,
      unit: entry.unit,
      quantity_received: entry.quantityReceived,
      current_quantity: entry.quantityReceived,
      expiry_date: entry.expiryDate || null,
      date_added: entry.receivedDate,
      added_by: entry.receivedBy,
      low_stock_threshold: entry.lowStockThreshold,
      units_per_carton: entry.unitsPerCarton || null,
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

    const updatePayload = { current_quantity: newQty };
    if (newQty <= 0) {
      const hasAlternative = reagents.some((r) => r.id !== item.id && r.name === item.name && (r.device || "") === (item.device || "") && !r.deleted && r.current_quantity > 0);
      if (hasAlternative) {
        updatePayload.deleted = true;
        updatePayload.deleted_by = "Auto (lot depleted, alternate lot available)";
        updatePayload.deleted_at = new Date().toISOString();
      }
    }
    await supabase.from("reagents").update(updatePayload).eq("id", item.id);
    if (updatePayload.deleted) {
      await logActivity("delete", "reagent", `${item.name} — Lot ${item.lot_number} (auto-removed, depleted)`, "System");
    }
    let activeDeviceChanged = false;
    let previousActiveLotId = null;
    if (item.device && !item.active_on_device) {
      activeDeviceChanged = true;
      if (entry.replaceOnDevice) {
        const prevActive = reagents.find((r) => r.id !== item.id && r.name === item.name && r.device === item.device && !r.deleted && r.active_on_device);
        previousActiveLotId = prevActive ? prevActive.id : null;
      }
    }

    await supabase.from("consumption_logs").insert({
      reagent_id: entry.reagentId, amount: entry.amount, date: entry.date, used_by: entry.usedBy, note: entry.note, tested_by_qc: entry.testedByQC,
      active_device_changed: activeDeviceChanged, previous_active_lot_id: previousActiveLotId,
    });
    if (item.device) {
      if (entry.replaceOnDevice) {
        const siblings = reagents.filter((r) => r.name === item.name && r.device === item.device && r.id !== item.id && !r.deleted && r.active_on_device);
        for (const s of siblings) {
          await supabase.from("reagents").update({ active_on_device: false }).eq("id", s.id);
        }
      }
      if (!item.active_on_device) {
        await supabase.from("reagents").update({ active_on_device: true }).eq("id", item.id);
      }
    }

    if (needsLotToLot(item.device)) {
      // Step 2: mark today's Lot-to-Lot check as done, if this submission was confirming one.
      if (entry.confirmLotToLotId) {
        await supabase.from("lot_to_lot_pending").update({ confirmed: true, confirmed_by: username, confirmed_at: new Date().toISOString() }).eq("id", entry.confirmLotToLotId);
      }
      // Step 1: this lot just ran out — if another lot of the same reagent is
      // waiting on this device, flag that the next use needs Lot-to-Lot verification.
      if (newQty <= 0) {
        const otherLotAvailable = reagents.some((r) => r.id !== item.id && r.name === item.name && r.device === item.device && !r.deleted && r.current_quantity > 0);
        if (otherLotAvailable) {
          await supabase.from("lot_to_lot_pending").upsert(
            { reagent_name: item.name, device: item.device, depleted_lot_number: item.lot_number, confirmed: false, confirmed_by: null, confirmed_at: null, created_at: new Date().toISOString() },
            { onConflict: "reagent_name,device" }
          );
          setLotToLotNotice(`Lot ${item.lot_number} of ${item.name} just ran out on ${item.device}. A Lot-to-Lot verification will be required before the next lot is used.`);
        }
      }
    }

    setShowLog(false);
    loadAll();
  }

  async function saveEditedReagent(updated) {
    if (!can("edit")) return;
    await supabase.from("reagents").update({
      lot_number: updated.lot_number,
      unit: updated.unit,
      quantity_received: updated.quantity_received,
      current_quantity: updated.current_quantity,
      expiry_date: updated.expiry_date || null,
      low_stock_threshold: updated.low_stock_threshold,
      units_per_carton: updated.units_per_carton ?? null,
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

  async function restoreReagent(id) {
    if (!can("delete")) return;
    const item = reagents.find((r) => r.id === id);
    await supabase.from("reagents").update({ deleted: false, deleted_by: null, deleted_at: null }).eq("id", id);
    await logActivity("edit", "reagent", `${item ? item.name : ""} — Lot ${item ? item.lot_number : id} restored`.trim());
    loadAll();
  }

  async function discardReagent(id, reason, note) {
    if (!can("discard")) return;
    const item = reagents.find((r) => r.id === id);
    await supabase.from("reagents").update({
      deleted: true, deleted_by: username, deleted_at: new Date().toISOString(),
      discard_reason: reason, discard_note: note || null,
    }).eq("id", id);
    await logActivity("discard", "reagent", item ? `${item.name} — Lot ${item.lot_number} (${reason})` : id);
    setDiscardReagentTarget(null);
    loadAll();
  }

  async function removeFromDevice(id) {
    if (!can("edit")) return;
    await supabase.from("reagents").update({ active_on_device: false }).eq("id", id);
    loadAll();
  }

  async function snoozeLowStock(name, device, days) {
    if (!can("edit")) return;
    const until = new Date();
    until.setDate(until.getDate() + Number(days));
    await supabase.from("low_stock_snoozes").upsert(
      { reagent_name: name, device: device || "", snoozed_until: until.toISOString().slice(0, 10), snoozed_by: username },
      { onConflict: "reagent_name,device" }
    );
    loadAll();
  }

  async function unsnoozeLowStock(name, device) {
    if (!can("edit")) return;
    await supabase.from("low_stock_snoozes").delete().eq("reagent_name", name).eq("device", device || "");
    loadAll();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAINTENANCE (Owner only, triggered manually from Settings → "Run maintenance")
  // Applies fixed/updated rules retroactively to existing data that was created
  // before the rule existed. Add a new numbered step here each time a change
  // needs to be backfilled onto old records — this is the one place to check
  // when starting a new conversation about "apply this to existing data too".
  // ─────────────────────────────────────────────────────────────────────────
  async function runMaintenance() {
    if (role !== "owner") return { ok: false, message: "Only the owner can run maintenance." };
    let depletedRemoved = 0;

    // Step 1: auto-remove depleted lots (qty <= 0) that already have an
    // alternate lot (same name + device) covering them. Matches the rule
    // applied automatically to new "Log use" entries going forward.
    const active = reagents.filter((r) => !r.deleted);
    for (const item of active) {
      if (item.current_quantity > 0) continue;
      const hasAlternative = active.some((r) => r.id !== item.id && r.name === item.name && (r.device || "") === (item.device || "") && r.current_quantity > 0);
      if (hasAlternative) {
        await supabase.from("reagents").update({
          deleted: true,
          deleted_by: "Maintenance (lot depleted, alternate lot available)",
          deleted_at: new Date().toISOString(),
        }).eq("id", item.id);
        depletedRemoved++;
      }
    }
    if (depletedRemoved > 0) {
      await logActivity("delete", "reagent", `Maintenance: auto-removed ${depletedRemoved} depleted lot(s) with an alternate lot available`, "System");
    }

    loadAll();
    return { ok: true, message: `Maintenance complete. ${depletedRemoved} depleted lot(s) removed.` };
  }

  async function saveEditedLog(updated, original) {
    if (!can("edit")) return;
    const item = reagents.find((r) => r.id === original.reagent_id);
    if (item) {
      const delta = updated.amount - original.amount;
      const newQty = Math.max(0, item.current_quantity - delta);
      const updatePayload = { current_quantity: newQty };
      if (item.deleted && newQty > 0) {
        updatePayload.deleted = false;
        updatePayload.deleted_by = null;
        updatePayload.deleted_at = null;
      }
      await supabase.from("reagents").update(updatePayload).eq("id", item.id);
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
    if (item) {
      const restoredQty = item.current_quantity + log.amount;
      const updatePayload = { current_quantity: restoredQty };
      // If this lot had been auto-removed for being depleted, bring it back
      // now that it has stock again.
      if (item.deleted && restoredQty > 0) {
        updatePayload.deleted = false;
        updatePayload.deleted_by = null;
        updatePayload.deleted_at = null;
      }
      // If this log entry had promoted this lot to "active on device", undo that
      // too — but only if no OTHER remaining (non-deleted) log entry still points
      // to this same lot. If another entry still uses it, it's genuinely still the
      // active lot and shouldn't be demoted just because we're undoing one entry.
      const otherLogsForThisLot = logs.filter((l) => l.id !== log.id && l.reagent_id === item.id && !l.deleted);
      const shouldRevertActiveStatus = log.active_device_changed && otherLogsForThisLot.length === 0;
      if (shouldRevertActiveStatus) {
        updatePayload.active_on_device = false;
      }
      await supabase.from("reagents").update(updatePayload).eq("id", item.id);
      if (shouldRevertActiveStatus && log.previous_active_lot_id) {
        const prevLot = reagents.find((r) => r.id === log.previous_active_lot_id);
        const prevPayload = { active_on_device: true };
        if (prevLot && prevLot.deleted) {
          // It had been auto-removed (e.g. depleted) — bring it back into view
          // so it actually shows up as the active lot on the device again.
          prevPayload.deleted = false;
          prevPayload.deleted_by = null;
          prevPayload.deleted_at = null;
        }
        await supabase.from("reagents").update(prevPayload).eq("id", log.previous_active_lot_id);
      }
    }
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
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    return Object.entries(map).map(([key, items]) => {
      const sorted = [...items].sort(compareLots);
      const totalQty = items.reduce((s, i) => s + i.current_quantity, 0);
      const totalReceived = items.reduce((s, i) => s + i.quantity_received, 0);
      const anyExpiredOrEmpty = items.some((i) => (i.expiry_date && daysBetween(i.expiry_date, todayISO()) < 0) || i.current_quantity <= 0);
      const flagged = items.some(hasInspectionIssue);
      const lowStockRaw = totalQty > 0 && totalQty <= sorted[0].low_stock_threshold;
      const activeSnooze = (snoozes || []).find((s) => s.reagent_name === items[0].name && s.device === (items[0].device || "") && s.snoozed_until >= todayISO());
      const lowStock = lowStockRaw && !activeSnooze;
      const snoozedUntil = activeSnooze ? activeSnooze.snoozed_until : null;
      const expiringSoon = items.some((i) => isExpiringSoonItem(i, warnDays));
      const worstStatus = anyExpiredOrEmpty ? "red" : (lowStock || expiringSoon) ? "yellow" : "green";

      const itemIds = new Set(items.map((i) => i.id));
      const recentUsed = (logs || []).filter((l) => !l.deleted && itemIds.has(l.reagent_id) && new Date(l.date) >= cutoff).reduce((s, l) => s + Number(l.amount || 0), 0);
      const dailyRate = recentUsed / 30;
      const predictedDaysLeft = dailyRate > 0 ? Math.floor(totalQty / dailyRate) : null;

      return { key, name: items[0].name, device: items[0].device || "", items: sorted, fefo: sorted[0], totalQty, totalReceived, status: worstStatus, department: items[0].department, unit: items[0].unit, flagged, lowStock, lowStockRaw, snoozedUntil, expiringSoon, dailyRate, predictedDaysLeft };
    });
  }, [reagents, warnDays, logs, snoozes]);

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

  const urlToken = new URLSearchParams(window.location.search).get("public");
  if (urlToken && config.public_view_enabled && config.public_view_token && urlToken === config.public_view_token) {
    return <PublicSummaryPage groups={groups} counts={counts} logs={logs} reagents={reagents} departments={config.departments || []} />;
  }

  if (!role) return <Login config={config} staffAccounts={staffAccounts} onLogin={handleLogin} />;

  return (
    <div style={{ minHeight: "100vh", background: THEME.bg, fontFamily: "'Inter', sans-serif", color: THEME.text, display: "flex" }} data-theme={darkMode ? "dark" : "light"}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        :root {
          --primary: #0F7173;
          --primary-light: #5FBFB0;
          --sidebar-bg: #1B2B2E;
          --sidebar-text: #8FA39E;
          --sidebar-text-active: #F0F3F2;
          --bg: #F0F3F2;
          --card-bg: #ffffff;
          --card-border: #E1E8E5;
          --card-shadow: 0 8px 24px rgba(0,0,0,0.06);
          --text: #1B2B2E;
          --text-muted: #7B8E8A;
        }
        [data-theme="dark"] {
          --primary: #5FBFB0;
          --primary-light: #7DD3C0;
          --sidebar-bg: #0C1416;
          --sidebar-text: #6E827D;
          --sidebar-text-active: #EDF2F1;
          --bg: #10191B;
          --card-bg: #1A2426;
          --card-border: #2B3A3C;
          --card-shadow: 0 8px 24px rgba(0,0,0,0.4);
          --text: #E7EEEC;
          --text-muted: #8CA09B;
        }
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
        .print-report-only { display: none; }
        @media print {
          .sidebar-desktop, .topbar-noprint, .no-print { display: none !important; }
          .main-content { padding: 0 !important; max-width: none !important; }
          body, .main-content { background: #fff !important; }
          .print-report-hide { display: none !important; }
          .print-report-only { display: block !important; }
        }
      `}</style>

      {sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", zIndex: 60 }} />}

      <Sidebar
        tab={tab} setTab={setTab} role={role} can={can}
        onAdd={() => setShowWizard(true)} onLog={() => setShowLog(true)}
        onLogout={logout} onChangePassword={() => setShowChangePassword(true)}
        username={username} open={sidebarOpen} onCloseMobile={() => setSidebarOpen(false)}
        darkMode={darkMode} onToggleDarkMode={toggleDarkMode}
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
          {lotToLotNotice && (
            <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 12, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={18} color="#4F46E5" />
              <div style={{ flex: 1, fontSize: 13.5, color: "#3730A3" }}>{lotToLotNotice}</div>
              <button onClick={() => setLotToLotNotice(null)} style={{ background: "none", border: "none", color: "#3730A3" }}><X size={16} /></button>
            </div>
          )}
          {loginSummary && (
            <div style={{ background: "#EAF6F4", border: "1px solid #C6E8E3", borderRadius: 12, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
              <History size={18} color="#0F7173" />
              <div style={{ flex: 1, fontSize: 13.5, color: "#0F5F5B" }}>
                Since your last login ({loginSummary.since}): <b>{loginSummary.received}</b> received, <b>{loginSummary.used}</b> used
                {loginSummary.critical > 0 && <> · <b style={{ color: "#C1432B" }}>{loginSummary.critical} newly critical</b></>}
                {loginSummary.lowStock > 0 && <> · <b style={{ color: "#B8860B" }}>{loginSummary.lowStock} newly low stock</b></>}
              </div>
              <button onClick={() => setLoginSummary(null)} style={{ background: "none", border: "none", color: "#0F5F5B" }}><X size={16} /></button>
            </div>
          )}

          {tab === "dashboard" && can("dashboard") && <Dashboard groups={groups} counts={counts} devices={devices} logs={logs} reagents={reagents} departments={config.departments || []} role={role} can={can} onDeleteReagent={deleteReagent} onDiscardReagent={setDiscardReagentTarget} onSelect={(g) => { setSelectedGroup(g); setTab("detail"); }} onViewDevices={() => setTab("devices")} onSnooze={snoozeLowStock} onUnsnooze={unsnoozeLowStock} />}
          {tab === "detail" && can("dashboard") && selectedGroup && (
            <DetailView
              group={groups.find((g) => g.key === selectedGroup.key) || selectedGroup}
              logs={logs.filter((l) => !l.deleted && (groups.find((g) => g.key === selectedGroup.key)?.items || []).some((i) => i.id === l.reagent_id))}
              role={role}
              can={can}
              warnDays={warnDays}
              onBack={() => setTab("dashboard")}
              onEditReagent={setEditReagent} onDeleteReagent={deleteReagent} onDiscardReagent={setDiscardReagentTarget}
              onEditLog={setEditLog} onDeleteLog={deleteLog}
              onSnooze={snoozeLowStock} onUnsnooze={unsnoozeLowStock}
            />
          )}
          {tab === "reports" && can("reports") && <Reports reagents={reagents} logs={logs} departments={config.departments || []} role={role} can={can} onDeleteReagent={deleteReagent} onRestoreReagent={restoreReagent} onDeleteLog={deleteLog} onPurgeReagent={purgeReagent} onPurgeLog={purgeLog} />}
          {tab === "devices" && can("dashboard") && <DevicesBoard reagents={reagents} devices={devices} warnDays={warnDays} can={can} onEdit={setEditReagent} onDelete={deleteReagent} onDiscard={setDiscardReagentTarget} onRemove={removeFromDevice} />}
          {tab === "history" && can("dashboard") && <HistoryPage reagents={reagents} logs={logs} />}
          {tab === "calendar" && can("dashboard") && <CalendarPage reagents={reagents} onSelectGroup={(g) => { setSelectedGroup(g); setTab("detail"); }} groups={groups} />}
          {tab === "reorder" && can("dashboard") && <ReorderPage groups={groups} coverageDays={config.reorder_coverage_days ?? 30} onSelectGroup={(g) => { setSelectedGroup(g); setTab("detail"); }} />}
          {tab === "stockcount" && can("stock_count") && <StockCount reagents={reagents} departments={config.departments || []} username={username} reload={loadAll} />}
          {tab === "settings" && can("settings") && <Settings config={config} presets={presets} role={role} staffAccounts={staffAccounts} devices={devices} reload={() => { ensureConfig(); loadAll(); }} onRunMaintenance={runMaintenance} />}
          {tab === "charts" && can("charts") && <Charts reagents={reagents} logs={logs} />}
          {tab === "deletions" && role === "owner" && <DeletionsLog activityLog={activityLog} onClear={clearActivityLog} />}
        </main>
      </div>

      {showWizard && <ReceiveWizard presets={presets} devices={devices} role={role} username={username} departments={config.departments || []} defaultLowStock={config.low_stock_default_percent} onClose={() => setShowWizard(false)} onSubmit={addReagent} />}
      {showLog && <LogConsumptionModal reagents={reagents.filter((r) => !r.deleted)} presets={presets} username={username} lotToLotPending={lotToLotPending} onClose={() => setShowLog(false)} onSubmit={recordConsumption} />}
      {editReagent && <EditReagentModal reagent={editReagent} onClose={() => setEditReagent(null)} onSave={saveEditedReagent} />}
      {discardReagentTarget && <DiscardModal reagent={discardReagentTarget} onClose={() => setDiscardReagentTarget(null)} onDiscard={discardReagent} />}
      {editLog && <EditLogModal log={editLog} onClose={() => setEditLog(null)} onSave={saveEditedLog} />}
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} onSave={changeOwnPassword} />}
      {error && <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", background: "#DC2626", color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 14 }}>{error}</div>}
    </div>
  );
}

function PublicSummaryPage({ groups, counts, logs, reagents, departments }) {
  useEffect(() => {
    supabase.from("public_view_visits").insert({});
  }, []);
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");

  const cardStyle = { background: "#fff", border: "1px solid #E1E8E5", borderRadius: 14, padding: 18, marginBottom: 16 };
  const panelTitle = { fontSize: 14, fontWeight: 700, color: "#1B2B2E", marginBottom: 12 };

  const reagentById = {};
  (reagents || []).forEach((r) => { reagentById[r.id] = { name: r.name, device: r.device, unit: r.unit }; });

  const expiringList = groups.filter((g) => g.expiringSoon).sort((a, b) => new Date(a.fefo.expiry_date || 0) - new Date(b.fefo.expiry_date || 0)).slice(0, 8);
  const lowStockList = groups.filter((g) => g.lowStock).slice(0, 8);
  const predictedList = groups.filter((g) => g.predictedDaysLeft !== null && g.predictedDaysLeft <= 14).sort((a, b) => a.predictedDaysLeft - b.predictedDaysLeft).slice(0, 8);
  const recentUsage = [...(logs || [])].filter((l) => !l.deleted).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8);

  const term = search.trim().toLowerCase();
  let filteredGroups = term
    ? groups.filter((g) => g.name.toLowerCase().includes(term) || g.items.some((i) => i.lot_number.toLowerCase().includes(term)))
    : groups;
  if (deptFilter !== "all") filteredGroups = filteredGroups.filter((g) => g.department === deptFilter);
  filteredGroups = [...filteredGroups].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ minHeight: "100vh", background: "#F0F3F2", fontFamily: "'Inter', sans-serif", padding: "40px 16px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <div style={{ background: "#1B2B2E", borderRadius: 8, padding: 8 }}>
            <Beaker size={20} color="#5FBFB0" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#1B2B2E" }}>LTC Lab Inventory</div>
            <div style={{ fontSize: 12, color: "#7B8E8A" }}>Read-only overview · refresh page for latest data</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
          {[
            { label: "Total reagents", value: groups.length, color: "#0F7173", bg: "#E4F4F1" },
            { label: "Critical", value: counts.red, color: "#C1432B", bg: "#FBEAE6" },
            { label: "Low stock", value: counts.lowStock, color: "#EA580C", bg: "#FFF7ED" },
            { label: "Expiring soon", value: counts.expiringSoon, color: "#DC2626", bg: "#FEF2F2" },
            { label: "Stable", value: counts.green, color: "#2F6B4F", bg: "#E8F2EC" },
          ].map((s) => (
            <div key={s.label} style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 12, padding: 18, flex: "1 1 140px", minWidth: 140 }}>
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: s.bg, color: s.color, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, marginBottom: 10 }}>{s.value}</div>
              <div style={{ fontSize: 12.5, color: "#7B8E8A" }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div style={cardStyle}>
          <div style={panelTitle}>Expiring soon</div>
          {expiringList.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>Nothing expiring soon.</div>}
          {expiringList.map((g) => (
            <div key={g.key} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #EEF2F0", fontSize: 13 }}>
              <span style={{ color: "#1B2B2E", fontWeight: 600 }}>{g.name}</span>
              <span style={{ color: "#8A9694" }}>{g.fefo.expiry_date}</span>
            </div>
          ))}
        </div>

        <div style={cardStyle}>
          <div style={panelTitle}>Low stock</div>
          {lowStockList.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>Nothing low on stock.</div>}
          {lowStockList.map((g) => (
            <div key={g.key} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #EEF2F0", fontSize: 13 }}>
              <span style={{ color: "#1B2B2E", fontWeight: 600 }}>{g.name}</span>
              <span style={{ color: "#8A9694" }}>{g.totalQty} {g.unit} left</span>
            </div>
          ))}
        </div>

        <div style={cardStyle}>
          <div style={panelTitle}>Predicted to run low (next 14 days)</div>
          {predictedList.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>Nothing predicted to run low soon.</div>}
          {predictedList.map((g) => (
            <div key={g.key} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #EEF2F0", fontSize: 13 }}>
              <span style={{ color: "#1B2B2E", fontWeight: 600 }}>{g.name}</span>
              <span style={{ color: "#EA580C" }}>~{g.predictedDaysLeft}d left</span>
            </div>
          ))}
        </div>

        <div style={cardStyle}>
          <div style={panelTitle}>Recent usage</div>
          {recentUsage.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No consumption logged yet.</div>}
          {recentUsage.map((l) => {
            const r = reagentById[l.reagent_id];
            return (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #EEF2F0", fontSize: 13 }}>
                <span style={{ color: "#1B2B2E", fontWeight: 600 }}>{r ? r.name : "Unknown"}</span>
                <span style={{ color: "#8A9694" }}>{l.amount} {r ? r.unit : ""} · {l.date}</span>
              </div>
            );
          })}
        </div>

        <div style={cardStyle}>
          <div style={panelTitle}>All reagents ({filteredGroups.length})</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <input
              placeholder="Search name or lot…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 160, border: "1px solid #C7D1CE", borderRadius: 7, padding: "8px 10px", fontSize: 13 }}
            />
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ border: "1px solid #C7D1CE", borderRadius: 7, padding: "8px 10px", fontSize: 13 }}>
              <option value="all">All departments</option>
              {(departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {filteredGroups.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No matches.</div>}
          {filteredGroups.map((g) => {
            const m = STATUS_META[g.status];
            return (
              <div key={g.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid #EEF2F0" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1B2B2E" }}>{g.name}</div>
                  <div style={{ fontSize: 11.5, color: "#8A9694" }}>{g.department}{g.device ? ` · ${g.device}` : ""} · {g.totalQty} {g.unit}</div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: m.color, background: m.bg, borderRadius: 6, padding: "3px 8px", flexShrink: 0 }}>{m.label}</span>
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 11.5, color: "#8A9694", textAlign: "center", marginTop: 8 }}>
          This is a shared read-only summary link — no login required, no data can be changed from here.
        </div>
      </div>
    </div>
  );
}

function Sidebar({ tab, setTab, role, can, onAdd, onLog, onLogout, onChangePassword, username, open, onCloseMobile, darkMode, onToggleDarkMode }) {
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
        {can("dashboard") && <SideItem active={tab === "devices"} onClick={() => go("devices")} icon={<Cpu size={16} />} label="Devices" />}
        {can("dashboard") && <SideItem active={tab === "history"} onClick={() => go("history")} icon={<Archive size={16} />} label="History" />}
        {can("dashboard") && <SideItem active={tab === "calendar"} onClick={() => go("calendar")} icon={<CalendarDays size={16} />} label="Calendar" />}
        {can("dashboard") && <SideItem active={tab === "reorder"} onClick={() => go("reorder")} icon={<ShoppingCart size={16} />} label="Reorder" />}
        {can("stock_count") && <SideItem active={tab === "stockcount"} onClick={() => go("stockcount")} icon={<ClipboardCheck size={16} />} label="Stock count" />}
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
        <button onClick={onToggleDarkMode} title={darkMode ? "Switch to light mode" : "Switch to dark mode"} style={{ background: "none", border: "none", color: THEME.sidebarText, padding: 4 }}>{darkMode ? <Sun size={15} /> : <Moon size={15} />}</button>
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

const TAB_TITLES = { dashboard: "Dashboard", detail: "Dashboard", reports: "Reports", devices: "Devices", history: "History", calendar: "Calendar", reorder: "Reorder", stockcount: "Stock count", settings: "Settings", charts: "Usage charts", deletions: "Activity log" };
const TAB_SUBTITLES = {
  dashboard: "Overview of laboratory inventory",
  detail: "Reagent lot details",
  reports: "Full inventory and consumption history",
  devices: "What's currently loaded on each device",
  history: "Search any reagent's full lot and usage history",
  calendar: "Expiry dates laid out by day",
  reorder: "Suggested reorder quantities based on usage",
  stockcount: "Compare what's on the shelf to what the system expects",
  settings: "Manage users, permissions, and defaults",
  charts: "Consumption trends over time",
  deletions: "Full record of edits and deletions",
};

function TopBar({ tab, role, username, onEnableNotif, onMenuClick }) {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const initial = (username || "?").charAt(0).toUpperCase();
  return (
    <div className="topbar-noprint" style={{ background: THEME.cardBg, borderBottom: `1px solid ${THEME.cardBorder}`, padding: "18px 28px" }}>
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
          <button onClick={onEnableNotif} title="Enable browser alerts" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: 9, color: THEME.textMuted }}><Bell size={16} /></button>
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
        background: THEME.cardBg,
        border: `1px solid ${active ? iconColor : THEME.cardBorder}`,
        borderRadius: 16,
        boxShadow: active ? `0 0 0 2px ${iconColor}33, 0 10px 24px ${iconColor}30` : THEME.cardShadow,
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
    <div style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 16, boxShadow: THEME.cardShadow, padding: 20, flex: 1, minWidth: 300 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: THEME.text }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function DeptPill({ active, onClick, label, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        flexShrink: 0,
        background: active ? color : THEME.cardBg,
        color: active ? "#fff" : THEME.text,
        border: `1px solid ${active ? color : THEME.cardBorder}`,
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

function Dashboard({ groups, counts, departments, devices, logs, reagents, can, onDeleteReagent, onDiscardReagent, onSelect, onViewDevices, onSnooze, onUnsnooze }) {
  const [search, setSearch] = useState("");
  const [activeDept, setActiveDept] = useState("all");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [snoozingKey, setSnoozingKey] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px", color: THEME.textMuted }}>
        <Droplet size={36} style={{ marginBottom: 12, opacity: 0.5 }} />
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: THEME.text }}>No reagents logged yet</div>
        <div style={{ fontSize: 14 }}>Use "Receive stock" above to add your first reagent batch.</div>
      </div>
    );
  }

  function toggleExpand(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function lastLogFor(g) {
    const ids = new Set(g.items.map((i) => i.id));
    return [...(logs || [])].filter((l) => !l.deleted && ids.has(l.reagent_id)).sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
  }

  const allDevices = [...new Set(groups.map((g) => g.device).filter(Boolean))].sort();

  const recentUsage = [...(logs || [])].filter((l) => !l.deleted).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const reagentById = {};
  (reagents || []).forEach((i) => { reagentById[i.id] = { name: i.name, device: i.device, unit: i.unit }; });

  const predictedList = groups
    .filter((g) => g.predictedDaysLeft !== null && g.predictedDaysLeft <= 14)
    .sort((a, b) => a.predictedDaysLeft - b.predictedDaysLeft)
    .slice(0, 5);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const mostUsedMap = {};
  (logs || []).forEach((l) => {
    if (l.deleted || new Date(l.date) < monthStart) return;
    const r = reagentById[l.reagent_id];
    if (!r) return;
    mostUsedMap[r.name] = (mostUsedMap[r.name] || 0) + Number(l.amount || 0);
  });
  const mostUsedList = Object.entries(mostUsedMap).map(([name, qty]) => ({ name, qty, unit: groups.find((g) => g.name === name)?.unit || "" })).sort((a, b) => b.qty - a.qty).slice(0, 5);

  const snoozedGroups = groups.filter((g) => g.snoozedUntil);

  const pulseData = [];
  {
    const byDate = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const entry = { date: iso, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), total: 0 };
      byDate[iso] = entry;
      pulseData.push(entry);
    }
    (logs || []).forEach((l) => {
      if (l.deleted) return;
      const entry = byDate[l.date];
      if (entry) entry.total += Number(l.amount || 0);
    });
  }
  const pulseTotal = pulseData.reduce((s, d) => s + d.total, 0);

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
      <div style={{ display: "flex", alignItems: "center", gap: 24, background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 16, boxShadow: `0 12px 32px rgba(15,113,115,0.16), ${THEME.cardShadow}`, padding: "20px 24px", marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 6 }}>14-day activity</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: THEME.text, fontFamily: "'IBM Plex Mono', monospace" }}>{pulseTotal}</div>
          <div style={{ fontSize: 12, color: THEME.textMuted, marginTop: 2 }}>units consumed, all departments</div>
        </div>
        <div style={{ flex: 1, minWidth: 220, height: 64 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={pulseData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0F7173" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#0F7173" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Tooltip
                formatter={(v) => [`${v} units`, "Used"]}
                labelFormatter={(_, p) => (p && p[0] ? p[0].payload.label : "")}
                contentStyle={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, fontSize: 12 }}
              />
              <Area type="monotone" dataKey="total" stroke="#0F7173" strokeWidth={2} fill="url(#pulseFill)" style={{ filter: "drop-shadow(0 0 5px rgba(15,113,115,0.6))" }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCardV2 icon={<Beaker size={20} />} iconBg="#E4F4F1" iconColor={THEME.primary} value={groups.length} label="Total reagents" active={statusFilter === "all"} onClick={() => setStatusFilter("all")} />
        <StatCardV2 icon={<AlertTriangle size={20} />} iconBg={STATUS_META.red.bg} iconColor={STATUS_META.red.color} value={counts.red} label="Critical" active={statusFilter === "critical"} onClick={() => setStatusFilter(statusFilter === "critical" ? "all" : "critical")} />
        <StatCardV2 icon={<TrendingDown size={20} />} iconBg={STATUS_META.low.bg} iconColor={STATUS_META.low.color} value={counts.lowStock} label="Low stock" active={statusFilter === "low"} onClick={() => setStatusFilter(statusFilter === "low" ? "all" : "low")} />
        <StatCardV2 icon={<Clock size={20} />} iconBg={STATUS_META.expiring.bg} iconColor={STATUS_META.expiring.color} value={counts.expiringSoon} label="Expiring soon" active={statusFilter === "expiring"} onClick={() => setStatusFilter(statusFilter === "expiring" ? "all" : "expiring")} />
        <StatCardV2 icon={<CheckCircle2 size={20} />} iconBg={STATUS_META.green.bg} iconColor={STATUS_META.green.color} value={counts.green} label="Stable" active={statusFilter === "stable"} onClick={() => setStatusFilter(statusFilter === "stable" ? "all" : "stable")} />
        <StatCardV2 icon={<Cpu size={20} />} iconBg="#F0FDF4" iconColor="#16A34A" value={(devices || []).length} label="Connected devices" />
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 32, flexWrap: "wrap" }}>
        <Panel title="Devices" action={<span style={{ fontSize: 12.5, color: THEME.primary, fontWeight: 600, cursor: "pointer" }} onClick={onViewDevices}>View all</span>}>
          {(devices || []).length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>No devices added yet.</div>}
          {(devices || []).slice(0, 5).map((d) => {
            const activeLot = groups.flatMap((g) => g.items).find((i) => i.device === d.name && i.active_on_device);
            const dm = activeLot ? STATUS_META[statusOf(activeLot, 30)] : null;
            const dExp = activeLot && activeLot.expiry_date ? daysBetween(activeLot.expiry_date, todayISO()) : null;
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                  <div style={{ fontSize: 11.5, color: THEME.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeLot ? `${activeLot.name} · Lot ${activeLot.lot_number}` : "No active lot"}</div>
                </div>
                {activeLot && (
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 700, color: dm.color, background: dm.bg, borderRadius: 999, padding: "3px 10px" }}>
                      {dExp === null ? "No expiry" : dExp < 0 ? "Expired" : `${dExp}d left`}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </Panel>

        <Panel title="Recent usage">
          {recentUsage.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>No consumption logged yet.</div>}
          {recentUsage.map((l) => {
            const r = reagentById[l.reagent_id] || {};
            return (
              <div key={l.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name || "—"}</div>
                  <div style={{ fontSize: 11.5, color: THEME.textMuted }}>{l.used_by} · {r.device || "—"} · {l.date}</div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: THEME.text, flexShrink: 0 }}>{l.amount} {r.unit || ""}</span>
              </div>
            );
          })}
        </Panel>

        <Panel title="Predicted to run low" action={<span style={{ fontSize: 12, color: THEME.textMuted }}>Based on 30-day usage</span>}>
          {predictedList.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>Nothing predicted to run low in the next 2 weeks, based on recent usage.</div>}
          {predictedList.map((g) => (
            <div key={g.key} onClick={() => onSelect(g)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}`, cursor: "pointer" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</div>
                <div style={{ fontSize: 11.5, color: THEME.textMuted }}>~{g.dailyRate.toFixed(1)} {g.unit}/day · {g.totalQty} {g.unit} left</div>
              </div>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: g.predictedDaysLeft <= 3 ? STATUS_META.red.color : STATUS_META.expiring.color, background: g.predictedDaysLeft <= 3 ? STATUS_META.red.bg : STATUS_META.expiring.bg, borderRadius: 6, padding: "3px 8px", flexShrink: 0 }}>
                ~{g.predictedDaysLeft}d left
              </span>
            </div>
          ))}
        </Panel>

        <Panel title="Most used this month">
          {mostUsedList.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>No consumption logged yet this month.</div>}
          {mostUsedList.map((m, i) => (
            <div key={m.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: THEME.textMuted, width: 16, flexShrink: 0 }}>#{i + 1}</span>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: THEME.primary, flexShrink: 0 }}>{m.qty} {m.unit}</span>
            </div>
          ))}
        </Panel>
      </div>

      <div style={{ fontSize: 15, fontWeight: 700, color: THEME.text, margin: "0 0 14px" }}>All reagents</div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          placeholder="Search reagent, lot number, or device…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 2, minWidth: 200, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 16, boxSizing: "border-box", background: THEME.cardBg, color: THEME.text }}
        />
        <select
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
          style={{ flex: 1, minWidth: 160, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 15, boxSizing: "border-box", background: THEME.cardBg, color: THEME.text }}
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
        <div style={{ textAlign: "center", padding: "40px 20px", color: THEME.textMuted, fontSize: 13.5 }}>
          No matches{noFilters ? "" : " for this filter"}.
        </div>
      )}
      {byDept.map(({ dept, items }) => (
        <div key={dept} style={{ marginBottom: 22 }}>
          {activeDept === "all" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                background: `${deptColor(dept, departments)}22`, color: deptColor(dept, departments),
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700,
              }}>{dept.charAt(0).toUpperCase()}</span>
              <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>{dept}</span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((g) => {
              const m = STATUS_META[g.status];
              const dExp = g.fefo.expiry_date ? daysBetween(g.fefo.expiry_date, todayISO()) : null;
              const q = formatCartonQty(g.totalQty, g.fefo.units_per_carton, g.unit);
              const isOpen = expanded.has(g.key);
              const lastLog = isOpen ? lastLogFor(g) : null;
              return (
                <div key={g.key} className="hover-lift" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderLeft: `4px solid ${m.color}`, borderRadius: 8, overflow: "hidden" }}>
                  <div onClick={() => toggleExpand(g.key)} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 16px", cursor: "pointer", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 140 }}>
                      <div style={{ fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {g.name}
                        {g.device && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: THEME.primary, background: "#E4F4F1", borderRadius: 999, padding: "2px 8px" }}>{g.device}</span>
                        )}
                        {g.lowStock && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: STATUS_META.low.color, background: STATUS_META.low.bg, borderRadius: 999, padding: "2px 8px" }}>Low stock</span>
                        )}
                        {g.expiringSoon && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: STATUS_META.expiring.color, background: STATUS_META.expiring.bg, borderRadius: 999, padding: "2px 8px" }}>Expiring soon</span>
                        )}
                        {g.flagged && <ClipboardX size={13} color="#B8860B" title="Inspection issue on receipt" />}
                      </div>
                      <div style={{ fontSize: 12.5, color: THEME.textMuted, fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>
                        {q.main}{q.sub && <span style={{ opacity: 0.7 }}> ({q.sub})</span>} total left · {g.items.length > 1 ? `${g.items.length} lots (nearest: ${g.fefo.lot_number})` : `Lot ${g.fefo.lot_number}`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: m.color }}>{m.label}</div>
                      <div style={{ fontSize: 11.5, color: THEME.textMuted }}>{dExp === null ? "no expiry" : dExp < 0 ? `expired ${Math.abs(dExp)}d ago` : `expires in ${dExp}d`}</div>
                    </div>
                    <ChevronRight size={16} color="#B7C3C0" style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }} />
                  </div>
                  {isOpen && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "14px 32px", padding: "4px 16px 16px", borderTop: `1px solid ${THEME.cardBorder}`, background: THEME.bg, fontSize: 12.5 }}>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 3 }}>Lot</div>
                        <div style={{ color: THEME.text, fontFamily: "'IBM Plex Mono', monospace" }}>{g.fefo.lot_number}</div>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 3 }}>Expires</div>
                        <div style={{ color: THEME.text }}>{g.fefo.expiry_date || "No expiry"}</div>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 3 }}>Quantity</div>
                        <div style={{ color: THEME.text }}>{q.main}{q.sub && ` (${q.sub})`}</div>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 3 }}>Last used</div>
                        <div style={{ color: THEME.text }}>{lastLog ? `${lastLog.date} · ${lastLog.amount} ${g.unit} by ${lastLog.used_by}` : "—"}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: "auto", marginTop: 12 }}>
                        {can("edit") && g.lowStock && (
                          <button onClick={(e) => { e.stopPropagation(); setSnoozingKey(snoozingKey === g.key ? null : g.key); }} style={{ background: "none", border: "none", color: THEME.textMuted, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                            <Clock size={13} /> Snooze
                          </button>
                        )}
                        {can("discard") && (
                          <button onClick={(e) => { e.stopPropagation(); onDiscardReagent(g.fefo); }} title="Discard (expired/damaged)" style={{ background: "none", border: "none", color: STATUS_META.red.color }}>
                            <Ban size={15} />
                          </button>
                        )}
                        {can("delete") && (
                          <button onClick={(e) => { e.stopPropagation(); onDeleteReagent(g.fefo.id); }} title="Remove this lot" style={{ background: "none", border: "none", color: STATUS_META.red.color }}>
                            <Trash2 size={15} />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); onSelect(g); }} style={{ background: "none", border: "none", color: THEME.primary, fontSize: 12.5, fontWeight: 700 }}>
                          View full detail →
                        </button>
                      </div>
                      {snoozingKey === g.key && (
                        <div style={{ display: "flex", gap: 6, width: "100%" }}>
                          {[3, 7, 14, 30].map((d) => (
                            <button key={d} onClick={(e) => { e.stopPropagation(); onSnooze(g.name, g.device, d); setSnoozingKey(null); }} style={{ fontSize: 11.5, background: "none", border: `1px solid ${THEME.cardBorder}`, borderRadius: 6, padding: "4px 9px", color: THEME.text }}>{d}d</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {snoozedGroups.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: THEME.textMuted, marginBottom: 8 }}>Snoozed alerts</div>
          {snoozedGroups.map((g) => (
            <div key={"snz-" + g.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px", borderBottom: `1px solid ${THEME.cardBorder}`, fontSize: 12.5 }}>
              <span style={{ color: THEME.textMuted }}>{g.name} — until {g.snoozedUntil}</span>
              {can("edit") && <button onClick={() => onUnsnooze(g.name, g.device)} style={{ fontSize: 12, color: THEME.primary, background: "none", border: "none", fontWeight: 600 }}>Unsnooze</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DevicesBoard({ reagents, devices, warnDays, can, onEdit, onDelete, onDiscard, onRemove }) {
  const active = (reagents || []).filter((r) => !r.deleted);

  if (!devices || devices.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: THEME.textMuted, fontSize: 13.5 }}>
        No devices added yet. Add your lab's analyzers from Settings → Devices.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {devices.map((d) => {
        const activeLots = active.filter((r) => r.device === d.name && r.active_on_device);
        return (
          <Panel key={d.id} title={d.name} action={<span style={{ fontSize: 12, color: THEME.textMuted }}>{d.department}</span>}>
            {activeLots.length === 0 ? (
              <div style={{ fontSize: 13, color: THEME.textMuted }}>No active lot recorded on this device yet — logging a use will mark one automatically.</div>
            ) : (
              activeLots.map((r) => {
                const m = STATUS_META[statusOf(r, warnDays)];
                const dExp = r.expiry_date ? daysBetween(r.expiry_date, todayISO()) : null;
                return (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: `1px solid ${THEME.cardBorder}`, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text }}>{r.name}</div>
                      <div style={{ fontSize: 11.5, color: THEME.textMuted }}>
                        Lot {r.lot_number} · {(() => {
                          const q = formatCartonQty(r.current_quantity, r.units_per_carton, r.unit);
                          return q.sub ? `${q.main} (${q.sub})` : `${q.main} left`;
                        })()}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 700, color: m.color, background: m.bg, borderRadius: 6, padding: "3px 8px" }}>
                        {dExp === null ? "No expiry" : dExp < 0 ? "Expired" : `${dExp}d left`}
                      </span>
                      {r.expiry_date && <div style={{ fontSize: 10.5, color: THEME.textMuted, marginTop: 3 }}>{r.expiry_date}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      {can("edit") && (
                        <button onClick={() => onRemove(r.id)} title="Remove from this device (keeps it in inventory)" style={{ background: "none", border: `1px solid ${THEME.cardBorder}`, color: THEME.textMuted, borderRadius: 6, padding: "4px 8px", fontSize: 11 }}>
                          Remove from device
                        </button>
                      )}
                      {can("edit") && <button onClick={() => onEdit(r)} title="Edit this lot" style={{ background: "none", border: "none", color: THEME.textMuted, padding: 4 }}><Pencil size={14} /></button>}
                      {can("discard") && <button onClick={() => onDiscard(r)} title="Discard (expired/damaged)" style={{ background: "none", border: "none", color: "#C1432B", padding: 4 }}><Ban size={14} /></button>}
                      {can("delete") && <button onClick={() => onDelete(r.id)} title="Delete this lot" style={{ background: "none", border: "none", color: "#C1432B", padding: 4 }}><Trash2 size={14} /></button>}
                    </div>
                  </div>
                );
              })
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function HistoryPage({ reagents, logs }) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const allNames = [...new Set((reagents || []).map((r) => r.name))].sort();
  const term = normalizeName(search);
  const matchedName = allNames.find((n) => normalizeName(n) === term) || null;
  const suggestions = term && !matchedName ? allNames.filter((n) => normalizeName(n).includes(term)).slice(0, 8) : [];

  let lots = matchedName
    ? reagents.filter((r) => r.name === matchedName).sort(compareLots)
    : [];
  if (dateFrom) lots = lots.filter((l) => l.date_added >= dateFrom);
  if (dateTo) lots = lots.filter((l) => l.date_added <= dateTo);

  const lotIds = new Set(lots.map((l) => l.id));
  let relatedLogs = matchedName
    ? (logs || []).filter((l) => lotIds.has(l.reagent_id)).sort((a, b) => new Date(b.date) - new Date(a.date))
    : [];
  if (dateFrom) relatedLogs = relatedLogs.filter((l) => l.date >= dateFrom);
  if (dateTo) relatedLogs = relatedLogs.filter((l) => l.date <= dateTo);

  const lotById = {};
  lots.forEach((l) => { lotById[l.id] = l; });

  const totalReceived = lots.reduce((s, l) => s + Number(l.quantity_received || 0), 0);
  const totalRemaining = lots.reduce((s, l) => s + Number(l.current_quantity || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <input
          placeholder="Search a reagent name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          style={{ flex: 1, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 14px", fontSize: 16, boxSizing: "border-box", marginBottom: 12 }}
        />
        {matchedName && (
          <button onClick={() => window.print()} className="no-print" title="Print this reagent's history" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "10px 12px", color: THEME.text, flexShrink: 0 }}>
            <Printer size={16} />
          </button>
        )}
      </div>

      {matchedName && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: THEME.textMuted }}>From</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ border: `1px solid ${THEME.cardBorder}`, borderRadius: 6, padding: "7px 10px", fontSize: 13, background: THEME.cardBg, color: THEME.text }} />
          <span style={{ fontSize: 12, color: THEME.textMuted }}>To</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ border: `1px solid ${THEME.cardBorder}`, borderRadius: 6, padding: "7px 10px", fontSize: 13, background: THEME.cardBg, color: THEME.text }} />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={{ fontSize: 12, color: THEME.primary, background: "none", border: "none", fontWeight: 600 }}>Clear dates</button>
          )}
          <span style={{ fontSize: 11.5, color: THEME.textMuted }}>Filters lots by received date, and usage by log date.</span>
        </div>
      )}

      {!matchedName && suggestions.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {suggestions.map((n) => (
            <button key={n} onClick={() => setSearch(n)} style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 20, padding: "6px 14px", fontSize: 12.5, color: THEME.text }}>{n}</button>
          ))}
        </div>
      )}

      {!matchedName && !term && <div style={{ fontSize: 13.5, color: THEME.textMuted, padding: "20px 0" }}>Start typing a reagent name to see its full lot and usage history — including lots that already ran out.</div>}
      {!matchedName && term && suggestions.length === 0 && <div style={{ fontSize: 13.5, color: THEME.textMuted, padding: "20px 0" }}>No reagent matches "{search}".</div>}

      {matchedName && (
        <>
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            <StatCardV2 icon={<Archive size={20} />} iconBg="#E4F4F1" iconColor={THEME.primary} value={lots.length} label="Total lots ever received" />
            <StatCardV2 icon={<Beaker size={20} />} iconBg="#F0FDF4" iconColor="#16A34A" value={totalRemaining} label="Currently remaining (all lots)" />
            <StatCardV2 icon={<TrendingDown size={20} />} iconBg="#FFF7ED" iconColor="#EA580C" value={totalReceived} label="Total ever received" />
          </div>

          <Panel title={`${matchedName} — Lots (${lots.length})`}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: THEME.textMuted, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Lot</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Device</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Received</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Expiry</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600, textAlign: "right" }}>Received qty</th>
                    <th style={{ padding: "0 8px 8px 0", fontWeight: 600, textAlign: "right" }}>Remaining</th>
                    <th style={{ padding: "0 0 8px 0", fontWeight: 600 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.id} style={{ borderTop: `1px solid ${THEME.cardBorder}`, opacity: l.deleted ? 0.65 : 1 }}>
                      <td style={{ padding: "9px 8px 9px 0", fontWeight: 600, color: THEME.text, fontFamily: "'IBM Plex Mono', monospace" }}>{l.lot_number}</td>
                      <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.device || "—"}</td>
                      <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.date_added}</td>
                      <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.expiry_date || "No expiry"}</td>
                      <td style={{ padding: "9px 8px", textAlign: "right", color: THEME.text }}>{l.quantity_received} {l.unit}</td>
                      <td style={{ padding: "9px 8px", textAlign: "right", fontWeight: 600, color: THEME.text }}>{l.current_quantity} {l.unit}</td>
                      <td style={{ padding: "9px 0" }}>
                        {l.deleted ? (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: "#C1432B", background: "#FBEAE6", borderRadius: 5, padding: "2px 7px" }}>
                            {l.current_quantity <= 0 ? "Depleted" : "Removed"}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: "#2F6B4F", background: "#E8F2EC", borderRadius: 5, padding: "2px 7px" }}>Active</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div style={{ height: 16 }} />

          <Panel title={`Usage history (${relatedLogs.length})`}>
            {relatedLogs.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>No consumption logged for this reagent yet.</div>}
            {relatedLogs.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: THEME.textMuted, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Date</th>
                      <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Lot</th>
                      <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Device</th>
                      <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Used by</th>
                      <th style={{ padding: "0 0 8px 0", fontWeight: 600, textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relatedLogs.map((l) => {
                      const lot = lotById[l.reagent_id];
                      return (
                        <tr key={l.id} style={{ borderTop: `1px solid ${THEME.cardBorder}`, opacity: l.deleted ? 0.6 : 1 }}>
                          <td style={{ padding: "9px 8px 9px 0", color: THEME.textMuted }}>{l.date}</td>
                          <td style={{ padding: "9px 8px", color: THEME.text, fontFamily: "'IBM Plex Mono', monospace" }}>{lot ? lot.lot_number : "—"}</td>
                          <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{lot ? lot.device || "—" : "—"}</td>
                          <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{l.used_by}</td>
                          <td style={{ padding: "9px 0", textAlign: "right", fontWeight: 600, color: THEME.text }}>{l.amount} {lot ? lot.unit : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function CalendarPage({ reagents, groups, onSelectGroup }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [selectedDay, setSelectedDay] = useState(null);
  const [printReport, setPrintReport] = useState(false);

  const active = (reagents || []).filter((r) => !r.deleted && r.expiry_date);
  const byDay = {};
  active.forEach((r) => {
    const key = r.expiry_date;
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(r);
  });

  const year = cursor.getFullYear();
  const month = cursor.getMonth(); // 0-based
  const monthLabel = cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayISO();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function dayKey(d) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function changeMonth(delta) {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() + delta);
    setCursor(d);
    setSelectedDay(null);
  }

  function findGroupFor(item) {
    return groups.find((g) => g.name === item.name && (g.device || "") === (item.device || ""));
  }

  function printMonthReport() {
    setPrintReport(true);
  }

  useEffect(() => {
    if (!printReport) return;
    const t = setTimeout(() => window.print(), 30);
    const onAfterPrint = () => setPrintReport(false);
    window.addEventListener("afterprint", onAfterPrint);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", onAfterPrint); };
  }, [printReport]);

  const selectedItems = selectedDay ? (byDay[selectedDay] || []) : [];
  const monthItems = active.filter((r) => r.expiry_date.startsWith(monthPrefix)).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));

  return (
    <div>
      <div className={printReport ? "print-report-hide" : ""} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <button onClick={() => changeMonth(-1)} style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, padding: 8, color: THEME.text }}><ChevronLeft size={16} /></button>
        <div style={{ fontSize: 16, fontWeight: 700, color: THEME.text }}>{monthLabel}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => window.print()} className="no-print" title="Print this month" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, padding: 8, color: THEME.text }}><Printer size={16} /></button>
          <button onClick={printMonthReport} className="no-print" title="Print an expiry report for this month" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, padding: "8px 12px", color: THEME.text, display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            <FileText size={16} /> Report
          </button>
          <button onClick={() => changeMonth(1)} style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 8, padding: 8, color: THEME.text }}><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className={printReport ? "print-report-hide" : ""} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 6 }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: THEME.textMuted, padding: "4px 0" }}>{d}</div>
        ))}
      </div>

      <div className={printReport ? "print-report-hide" : ""} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={"e" + i} />;
          const key = dayKey(d);
          const items = byDay[key] || [];
          const hasExpired = items.some((it) => key < today);
          const hasSoon = items.some((it) => key >= today);
          const isToday = key === today;
          const bg = items.length === 0 ? THEME.cardBg : hasExpired ? "#FBEAE6" : "#FBF3DF";
          const border = isToday ? THEME.primary : THEME.cardBorder;
          return (
            <button
              key={key}
              onClick={() => items.length > 0 && setSelectedDay(selectedDay === key ? null : key)}
              style={{
                background: bg, border: `1.5px solid ${border}`, borderRadius: 8, minHeight: 64,
                padding: 6, textAlign: "left", cursor: items.length ? "pointer" : "default",
                display: "flex", flexDirection: "column", gap: 2,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: isToday ? 800 : 600, color: isToday ? THEME.primary : THEME.text }}>{d}</div>
              {items.slice(0, 2).map((it) => (
                <div key={it.id} style={{ fontSize: 9.5, color: hasExpired && key < today ? "#C1432B" : "#B8860B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
              ))}
              {items.length > 2 && <div style={{ fontSize: 9, color: THEME.textMuted }}>+{items.length - 2} more</div>}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <div className={printReport ? "print-report-hide" : ""} style={{ marginTop: 20 }}>
          <Panel title={`${selectedDay} — ${selectedItems.length} lot(s)`}>
            {selectedItems.map((it) => {
              const g = findGroupFor(it);
              const expired = selectedDay < today;
              return (
                <div
                  key={it.id}
                  onClick={() => g && onSelectGroup(g)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${THEME.cardBorder}`, cursor: g ? "pointer" : "default" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: THEME.text }}>{it.name}</div>
                    <div style={{ fontSize: 11.5, color: THEME.textMuted }}>Lot {it.lot_number}{it.device ? ` · ${it.device}` : ""} · {it.current_quantity} {it.unit} left</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: expired ? "#C1432B" : "#B8860B", background: expired ? "#FBEAE6" : "#FBF3DF", borderRadius: 6, padding: "3px 8px" }}>
                    {expired ? "Expired" : "Expiring"}
                  </span>
                </div>
              );
            })}
          </Panel>
        </div>
      )}

      <div className="print-report-only">
        <div style={{ fontSize: 18, fontWeight: 700, color: "#1B2B2E", marginBottom: 2 }}>Expiring in {monthLabel}</div>
        <div style={{ fontSize: 12, color: "#7B8E8A", marginBottom: 16 }}>{monthItems.length} lot{monthItems.length === 1 ? "" : "s"} · generated {today}</div>
        {monthItems.length === 0 ? (
          <div style={{ fontSize: 13, color: "#7B8E8A" }}>Nothing expires in {monthLabel}.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #1B2B2E" }}>
                <th style={{ padding: "6px 8px 6px 0" }}>Reagent</th>
                <th style={{ padding: "6px 8px" }}>Lot</th>
                <th style={{ padding: "6px 8px" }}>Department</th>
                <th style={{ padding: "6px 8px" }}>Device</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Qty left</th>
                <th style={{ padding: "6px 0 6px 8px", textAlign: "right" }}>Expires</th>
              </tr>
            </thead>
            <tbody>
              {monthItems.map((it) => (
                <tr key={it.id} style={{ borderBottom: "1px solid #E1E8E5", color: it.expiry_date < today ? "#C1432B" : "#1B2B2E" }}>
                  <td style={{ padding: "7px 8px 7px 0", fontWeight: 600 }}>{it.name}</td>
                  <td style={{ padding: "7px 8px", fontFamily: "monospace" }}>{it.lot_number}</td>
                  <td style={{ padding: "7px 8px" }}>{it.department}</td>
                  <td style={{ padding: "7px 8px" }}>{it.device || "—"}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>{it.current_quantity} {it.unit}</td>
                  <td style={{ padding: "7px 0 7px 8px", textAlign: "right", fontWeight: 600 }}>{it.expiry_date}{it.expiry_date < today ? " (expired)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReorderPage({ groups, coverageDays, onSelectGroup }) {
  const suggestions = groups
    .map((g) => {
      const target = Math.ceil((g.dailyRate || 0) * coverageDays);
      const suggestedQty = target - g.totalQty;
      return { ...g, target, suggestedQty };
    })
    .filter((g) => g.dailyRate > 0 && g.suggestedQty > 0)
    .sort((a, b) => b.suggestedQty - a.suggestedQty);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: THEME.textMuted }}>
          Based on each reagent's actual usage rate (last 30 days) and a target coverage of <b>{coverageDays} days</b> — change this in Settings.
        </div>
        <button onClick={() => window.print()} className="no-print" title="Print this list" style={{ background: THEME.cardBg, border: `1px solid ${THEME.cardBorder}`, borderRadius: 10, padding: "8px 10px", color: THEME.text, flexShrink: 0 }}>
          <Printer size={16} />
        </button>
      </div>

      <Panel title={`Suggested reorders (${suggestions.length})`}>
        {suggestions.length === 0 && <div style={{ fontSize: 13, color: THEME.textMuted }}>Nothing needs reordering right now based on current usage rates.</div>}
        {suggestions.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: THEME.textMuted, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                  <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Reagent</th>
                  <th style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>Device</th>
                  <th style={{ padding: "0 8px 8px 0", fontWeight: 600, textAlign: "right" }}>Daily use</th>
                  <th style={{ padding: "0 8px 8px 0", fontWeight: 600, textAlign: "right" }}>In stock</th>
                  <th style={{ padding: "0 0 8px 0", fontWeight: 600, textAlign: "right" }}>Suggested order</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((g) => (
                  <tr key={g.key} onClick={() => onSelectGroup(g)} style={{ borderTop: `1px solid ${THEME.cardBorder}`, cursor: "pointer" }}>
                    <td style={{ padding: "9px 8px 9px 0", fontWeight: 600, color: THEME.text }}>{g.name}</td>
                    <td style={{ padding: "9px 8px", color: THEME.textMuted }}>{g.device || "—"}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", color: THEME.textMuted }}>{g.dailyRate.toFixed(1)} {g.unit}</td>
                    <td style={{ padding: "9px 8px", textAlign: "right", color: THEME.textMuted }}>{g.totalQty} {g.unit}</td>
                    <td style={{ padding: "9px 0", textAlign: "right", fontWeight: 700, color: THEME.primary }}>{g.suggestedQty} {g.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function DetailView({ group, logs, can, warnDays, onBack, onEditReagent, onDeleteReagent, onDiscardReagent, onEditLog, onDeleteLog, onSnooze, onUnsnooze }) {
  const [showSnoozePicker, setShowSnoozePicker] = useState(false);
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
      <div style={{ fontSize: 13, color: "#7B8E8A", marginBottom: 8, fontFamily: "'IBM Plex Mono', monospace" }}>
        {group.department}{group.device ? ` · ${group.device}` : ""} · {group.totalQty} {group.unit} in stock across {group.items.length} lot(s)
        {group.predictedDaysLeft !== null && group.predictedDaysLeft !== undefined && (
          <> · <span style={{ color: group.predictedDaysLeft <= 3 ? "#C1432B" : group.predictedDaysLeft <= 14 ? "#B8860B" : "#7B8E8A", fontWeight: 700 }}>~{group.predictedDaysLeft}d left at current usage rate</span></>
        )}
      </div>
      {group.lowStockRaw && can("edit") && (
        <div style={{ marginBottom: 20 }}>
          {group.snoozedUntil ? (
            <div style={{ fontSize: 12.5, color: "#B8860B", display: "flex", alignItems: "center", gap: 8 }}>
              Low-stock alert snoozed until {group.snoozedUntil}
              <button onClick={() => onUnsnooze(group.name, group.device)} style={{ fontSize: 12, color: "#0F7173", background: "none", border: "none", fontWeight: 600 }}>Unsnooze</button>
            </div>
          ) : (
            <>
              <button onClick={() => setShowSnoozePicker(!showSnoozePicker)} style={{ fontSize: 12.5, color: "#B8860B", background: "#FBF3DF", border: "1px solid #F5E1A8", borderRadius: 6, padding: "5px 10px", fontWeight: 600 }}>
                Snooze low-stock alert
              </button>
              {showSnoozePicker && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  {[3, 7, 14, 30].map((d) => (
                    <button key={d} onClick={() => { onSnooze(group.name, group.device, d); setShowSnoozePicker(false); }} style={{ fontSize: 11.5, background: "#F0F3F2", border: "1px solid #E1E8E5", borderRadius: 6, padding: "4px 9px" }}>{d}d</button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

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
          const dExp = it.expiry_date ? daysBetween(it.expiry_date, todayISO()) : null;
          const m = STATUS_META[statusOf(it, warnDays)];
          const failedItems = INSPECTION_KEYS.filter((k) => it[k] === false).map((k) => inspectionLabels[k]);
          return (
            <div key={it.id} style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {idx === 0 && <span style={{ background: "#0F7173", color: "#fff", fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 4 }}>USE FIRST</span>}
                <div style={{ flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>Lot {it.lot_number}</div>
                <div style={{ textAlign: "right", fontSize: 13 }}>
                  {(() => {
                    const q = formatCartonQty(it.current_quantity, it.units_per_carton, it.unit);
                    return <>{q.main}{q.sub && <div style={{ fontSize: 10.5, color: "#8A9694" }}>{q.sub}</div>}</>;
                  })()}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12.5, color: m.color, fontWeight: 600 }}>{dExp === null ? "no expiry" : dExp < 0 ? `expired ${Math.abs(dExp)}d ago` : `${dExp}d left`}</div>
                  {it.expiry_date && <div style={{ fontSize: 10.5, color: "#8A9694", marginTop: 1 }}>{it.expiry_date}</div>}
                </div>
                {can("edit") && <button onClick={() => onEditReagent(it)} style={{ background: "none", border: "none", color: "#8A9694" }}><Pencil size={14} /></button>}
                {can("discard") && <button onClick={() => onDiscardReagent(it)} title="Discard (expired/damaged)" style={{ background: "none", border: "none", color: "#C1432B" }}><Ban size={14} /></button>}
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

// Builds the "Full report" PDF (Reports page export). RP is the dynamically
// imported @react-pdf/renderer module namespace, passed in so the library
// only loads when someone actually clicks "Export PDF" instead of bloating
// the initial app bundle.
function buildReportPdfDoc(RP, { matchedLots, matchedLogs, matchedDiscards, reagentById, dateFrom, dateTo, deptLabel }) {
  const { Document, Page, Text, View, StyleSheet } = RP;

  const styles = StyleSheet.create({
    page: { padding: 30, paddingBottom: 44, fontSize: 8, fontFamily: "Helvetica", color: REPORT_NAVY },
    brand: { fontSize: 15, fontFamily: "Helvetica-Bold", color: REPORT_TEAL },
    title: { fontSize: 11, fontFamily: "Helvetica-Bold", color: REPORT_NAVY, marginTop: 2 },
    meta: { fontSize: 8, color: REPORT_MUTED, marginTop: 2 },
    rule: { borderBottomWidth: 1, borderBottomColor: REPORT_BORDER, marginTop: 8, marginBottom: 12 },
    sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: REPORT_NAVY, marginBottom: 6 },
    empty: { fontSize: 8, color: REPORT_MUTED, fontStyle: "italic", marginBottom: 12 },
    headRow: { flexDirection: "row", backgroundColor: REPORT_NAVY, borderRadius: 3, paddingVertical: 4, paddingHorizontal: 5, marginBottom: 1 },
    headCell: { fontSize: 6.5, fontFamily: "Helvetica-Bold", color: "#FFFFFF", textTransform: "uppercase" },
    row: { flexDirection: "row", paddingVertical: 4, paddingHorizontal: 5, borderRadius: 3 },
    stripe: { backgroundColor: REPORT_STRIPE },
    cell: { fontSize: 7.5 },
    footer: {
      position: "absolute", bottom: 18, left: 30, right: 30,
      flexDirection: "row", justifyContent: "space-between",
      borderTopWidth: 1, borderTopColor: REPORT_BORDER, paddingTop: 5,
      fontSize: 7, color: REPORT_MUTED,
    },
  });

  function Table({ columns, rows }) {
    return (
      <View wrap>
        <View style={styles.headRow}>
          {columns.map((c, i) => <Text key={i} style={[styles.headCell, { width: c.width }]}>{c.label}</Text>)}
        </View>
        {rows.map((r, ri) => (
          <View key={ri} style={[styles.row, ri % 2 === 1 && styles.stripe]}>
            {columns.map((c, ci) => (
              <Text key={ci} style={[styles.cell, { width: c.width, color: c.color ? c.color(r) : REPORT_NAVY }]}>{c.value(r)}</Text>
            ))}
          </View>
        ))}
      </View>
    );
  }

  function inspectionSummary(r) {
    const failed = INSPECTION_KEYS.filter((k) => r[k] === false);
    return failed.length ? `${failed.length} issue(s)` : "OK";
  }

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page} wrap>
        <View fixed>
          <Text style={styles.brand}>LTC Lab Inventory</Text>
          <Text style={styles.title}>Full Report</Text>
          <Text style={styles.meta}>{dateFrom} to {dateTo} · {deptLabel} · Generated {todayISO()}</Text>
          <View style={styles.rule} />
        </View>

        <Text style={styles.sectionTitle}>Lots ({matchedLots.length})</Text>
        {matchedLots.length === 0 ? (
          <Text style={styles.empty}>No lots match this filter.</Text>
        ) : (
          <Table
            columns={[
              { label: "Reagent", width: "14%", value: (r) => r.name },
              { label: "Dept", width: "10%", value: (r) => r.department },
              { label: "Type", width: "9%", value: (r) => r.item_type },
              { label: "Lot", width: "9%", value: (r) => r.lot_number },
              { label: "Received by", width: "9%", value: (r) => r.added_by },
              { label: "Received", width: "8%", value: (r) => r.date_added },
              { label: "Expiry", width: "8%", value: (r) => r.expiry_date || "—" },
              { label: "Qty recv", width: "7%", value: (r) => String(r.quantity_received) },
              { label: "Qty left", width: "7%", value: (r) => String(r.current_quantity) },
              { label: "Unit", width: "6%", value: (r) => r.unit },
              { label: "Inspection", width: "7%", value: inspectionSummary, color: (r) => (INSPECTION_KEYS.some((k) => r[k] === false) ? REPORT_AMBER : REPORT_MUTED) },
              { label: "Status", width: "6%", value: (r) => (r.deleted ? "Deleted" : "Active"), color: (r) => (r.deleted ? REPORT_RED : REPORT_MUTED) },
            ]}
            rows={matchedLots}
          />
        )}

        <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Consumption log ({matchedLogs.length})</Text>
        {matchedLogs.length === 0 ? (
          <Text style={styles.empty}>No consumption logged for this filter.</Text>
        ) : (
          <Table
            columns={[
              { label: "Date", width: "10%", value: (l) => l.date },
              { label: "Reagent", width: "22%", value: (l) => reagentById[l.reagent_id]?.name || "—" },
              { label: "Lot", width: "14%", value: (l) => reagentById[l.reagent_id]?.lot_number || "—" },
              { label: "Amount", width: "12%", value: (l) => `${l.amount} ${reagentById[l.reagent_id]?.unit || ""}` },
              { label: "Used by", width: "18%", value: (l) => l.used_by },
              { label: "QC tested", width: "12%", value: (l) => (l.tested_by_qc ? "Yes" : "No") },
              { label: "Status", width: "12%", value: (l) => (l.deleted ? "Deleted" : "Active"), color: (l) => (l.deleted ? REPORT_RED : REPORT_MUTED) },
            ]}
            rows={matchedLogs}
          />
        )}

        <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Discarded ({matchedDiscards.length})</Text>
        {matchedDiscards.length === 0 ? (
          <Text style={styles.empty}>Nothing discarded for this filter.</Text>
        ) : (
          <Table
            columns={[
              { label: "Date", width: "12%", value: (r) => (r.deleted_at || "").slice(0, 10) },
              { label: "Reagent", width: "22%", value: (r) => r.name },
              { label: "Lot", width: "14%", value: (r) => r.lot_number },
              { label: "Reason", width: "16%", value: (r) => r.discard_reason || "—" },
              { label: "Note", width: "24%", value: (r) => r.discard_note || "—" },
              { label: "By", width: "12%", value: (r) => r.deleted_by || "—" },
            ]}
            rows={matchedDiscards}
          />
        )}

        <View style={styles.footer} fixed>
          <Text>LTC Lab Inventory — Full report</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

function Reports({ reagents, logs, departments, role, can, onDeleteReagent, onRestoreReagent, onDeleteLog, onPurgeReagent, onPurgeLog }) {
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

  const matchedDiscards = useMemo(() => {
    const term = searchLot.trim().toLowerCase();
    return reagents
      .filter((r) => !!r.discard_reason)
      .filter((r) => {
        const day = (r.deleted_at || "").slice(0, 10);
        if (term) return r.lot_number.toLowerCase().includes(term) || r.name.toLowerCase().includes(term);
        return day >= dateFrom && day <= dateTo;
      })
      .filter((r) => (deptFilter ? r.department === deptFilter : true))
      .sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
  }, [reagents, searchLot, dateFrom, dateTo, deptFilter]);

  const logUseCount = matchedLogs.length + matchedDiscards.length;

  function logsFor(reagentId) {
    return logs.filter((l) => l.reagent_id === reagentId);
  }

  async function exportPdf() {
    const RP = await import("@react-pdf/renderer");
    const doc = buildReportPdfDoc(RP, {
      matchedLots, matchedLogs, matchedDiscards, reagentById,
      dateFrom, dateTo, deptLabel: deptFilter || "All departments",
    });
    const blob = await RP.pdf(doc).toBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reagent-report-${dateFrom}-to-${dateTo}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Full report</h2>
        <button onClick={exportPdf} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "8px 12px", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Download size={14} /> Export PDF</button>
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
          Log use ({logUseCount})
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
                      {r.deleted && can("delete") && (
                        <button onClick={() => onRestoreReagent(r.id)} style={{ background: "none", border: "1px solid #0F7173", color: "#0F7173", borderRadius: 6, padding: "3px 9px", fontSize: 10.5, fontWeight: 700 }}>Restore</button>
                      )}
                      {r.deleted && role === "owner" && (
                        <button onClick={() => onPurgeReagent(r.id)} style={{ background: "none", border: "1px solid #C1432B", color: "#C1432B", borderRadius: 6, padding: "3px 9px", fontSize: 10.5, fontWeight: 700 }}>Erase permanently</button>
                      )}
                      {!r.deleted && can("delete") && (
                        <button onClick={() => onDeleteReagent(r.id)} title="Remove this lot" style={{ background: "none", border: "none", color: "#C1432B", padding: 2 }}><Trash2 size={14} /></button>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "#7B8E8A", fontFamily: "'IBM Plex Mono', monospace" }}>{r.department} · {r.item_type} · Lot {r.lot_number}</div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 12, fontSize: 12.5 }}>
                    <div><div style={{ color: "#2F6B4F", fontSize: 10.5, textTransform: "uppercase", fontWeight: 700 }}>Received by</div>{r.added_by}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Received date</div>{r.date_added}</div>
                    <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Expiry date</div>{r.expiry_date || "No expiry"}</div>
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
          {logUseCount === 0 && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "#8A9694", fontSize: 13.5 }}>No records match this filter.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ...matchedLogs.map((l) => ({ _type: "log", _sortAt: new Date(l.date).getTime(), data: l })),
              ...matchedDiscards.map((r) => ({ _type: "discard", _sortAt: new Date(r.deleted_at).getTime(), data: r })),
            ]
              .sort((a, b) => b._sortAt - a._sortAt)
              .map((entry) => {
                if (entry._type === "log") {
                  const l = entry.data;
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
                          {!l.deleted && can("delete") && (
                            <button onClick={() => onDeleteLog(l)} title="Undo this log entry" style={{ background: "none", border: "none", color: "#C1432B", padding: 2 }}><Trash2 size={14} /></button>
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
                }
                const r = entry.data;
                return (
                  <div key={"discard-" + r.id} style={{ background: "#fff", border: "1px solid #FBD5B5", borderRadius: 10, padding: 16, opacity: 0.9 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                        {r.name}
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#8A5A2B", background: "#FBF0E4", padding: "2px 7px", borderRadius: 4 }}>DISCARD</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "#7B8E8A", fontFamily: "'IBM Plex Mono', monospace" }}>{r.department} · Lot {r.lot_number}{r.device ? ` · ${r.device}` : ""}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, fontSize: 12.5 }}>
                      <div><div style={{ color: "#8A5A2B", fontSize: 10.5, textTransform: "uppercase", fontWeight: 700 }}>Discarded by</div>{r.deleted_by}</div>
                      <div><div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Date</div>{fmtDateTime(r.deleted_at)}</div>
                      {role === "owner" && (
                        <div style={{ gridColumn: "span 2" }}>
                          <div style={{ color: "#8A9694", fontSize: 10.5, textTransform: "uppercase" }}>Reason (owner only)</div>
                          {r.discard_reason}{r.discard_note ? `: ${r.discard_note}` : ""}
                        </div>
                      )}
                    </div>
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
    discard: { label: "Discarded", color: "#8A5A2B", bg: "#FBF0E4" },
    purge: { label: "Erased permanently", color: "#8A2E1F", bg: "#FBEAE6" },
    login: { label: "Signed in", color: "#0F7173", bg: "#EAF6F4" },
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
      <div style={{ fontSize: 13, color: "#7B8E8A", marginBottom: 24 }}>Every login, edit, removal, and permanent erase — in order, newest first. Only visible to your account.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {activityLog.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No activity recorded yet.</div>}
        {activityLog.map((e) => {
          const m = ACTION_META[e.action] || { label: e.action, color: "#516361", bg: "#F0F3F2" };
          const entityLabel = e.entity === "reagent" ? "Reagent lot" : e.entity === "user" ? "Login" : "Usage log";
          return (
            <div key={e.id} style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: m.color, background: m.bg, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase", flexShrink: 0 }}>{m.label}</span>
              <div style={{ flex: 1, fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{e.description}</div>
                <div style={{ fontSize: 11.5, color: "#8A9694", marginTop: 2 }}>{entityLabel} · by <b>{e.performed_by}</b> on {fmtDateTime(e.performed_at)}</div>
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

function LogConsumptionModal({ reagents, presets, username, lotToLotPending, onClose, onSubmit }) {
  const [showPrep, setShowPrep] = useState(false);
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

  const lots = reagents.filter((r) => r.name === name && (r.device || "") === device).sort(compareLots);
  const fefo = lots[0];
  const [selectedLotId, setSelectedLotId] = useState("");
  const chosenLot = (selectedLotId && lots.find((l) => l.id === selectedLotId)) || fefo;
  const currentActiveLot = device ? reagents.find((r) => r.name === name && r.device === device && r.active_on_device) : null;
  const showReplaceChoice = !!(device && chosenLot && currentActiveLot);
  const [replaceOnDevice, setReplaceOnDevice] = useState(true);

  const pendingLtl = needsLotToLot(device) ? (lotToLotPending || []).find((p) => p.reagent_name === name && p.device === device && !p.confirmed) : null;
  const [ltlConfirmed, setLtlConfirmed] = useState(false);
  useEffect(() => { setLtlConfirmed(false); }, [pendingLtl?.id]);

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
    setSelectedLotId("");
    setShowPrep(false);
  }

  function changeDevice(newDevice) {
    setDevice(newDevice);
    setSelectedLotId("");
  }

  function handleScan(text) {
    const match = reagents.find((r) => r.lot_number === text);
    if (match) {
      setName(match.name);
      setDevice(match.device || "");
      setSelectedLotId(match.id);
    }
    setShowScanner(false);
  }

  const [submitting, setSubmitting] = useState(false);
  function submit() {
    if (!chosenLot || !amount || !usedBy) return;
    if (pendingLtl && !ltlConfirmed) return;
    if (submitting) return;
    setSubmitting(true);
    onSubmit({ reagentId: chosenLot.id, amount: Number(amount), date, usedBy, note, testedByQC, replaceOnDevice: showReplaceChoice ? replaceOnDevice : true, confirmLotToLotId: pendingLtl ? pendingLtl.id : null });
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
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <label style={labelStyle}>Reagent (type to search)
              <input style={inputStyle} value={name} onChange={(e) => changeName(e.target.value)} placeholder="Search reagent name" autoComplete="off" />
            </label>
            {name.trim() && !names.includes(name) && names.filter((n) => n.toLowerCase().includes(name.trim().toLowerCase())).length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #C7D1CE", borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.12)" }}>
                {names.filter((n) => n.toLowerCase().includes(name.trim().toLowerCase())).slice(0, 8).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => changeName(n)}
                    style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #EEF2F0", padding: "10px 12px", fontSize: 14 }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => setShowScanner(true)} style={{ background: "#F0F3F2", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 10px", marginTop: 20 }}><ScanLine size={16} /></button>
        </div>
        {names.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9694" }}>No items of this type in stock.</div>}
        {devicesForName.some(Boolean) && (
          <label style={labelStyle}>Device used
            <select style={inputStyle} value={device} onChange={(e) => changeDevice(e.target.value)}>
              {devicesForName.map((d) => <option key={d || "none"} value={d}>{d || "No device specified"}</option>)}
            </select>
          </label>
        )}
        {name && !fefo && <div style={{ fontSize: 12.5, color: "#C1432B" }}>No stock of "{name}" on this device.</div>}
        {(() => {
          const matchingPreset = (presets || []).find((p) => p.name === name && p.prep_instructions);
          if (!matchingPreset) return null;
          return (
            <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 7, padding: "10px 12px" }}>
              <button type="button" onClick={() => setShowPrep(!showPrep)} style={{ background: "none", border: "none", color: "#3730A3", fontSize: 12.5, fontWeight: 600, padding: 0 }}>
                {showPrep ? "Hide" : "View"} preparation instructions for {name}
              </button>
              {showPrep && <div style={{ fontSize: 12.5, color: "#3730A3", marginTop: 8, whiteSpace: "pre-wrap" }}>{matchingPreset.prep_instructions}</div>}
            </div>
          );
        })()}
        {lots.length > 0 && (
          <label style={labelStyle}>Lot to use
            <select style={inputStyle} value={chosenLot ? chosenLot.id : ""} onChange={(e) => setSelectedLotId(e.target.value)}>
              {lots.map((l, idx) => (
                <option key={l.id} value={l.id}>
                  Lot {l.lot_number} — {(() => { const q = formatCartonQty(l.current_quantity, l.units_per_carton, l.unit); return q.sub ? `${q.main}, ${q.sub}` : `${q.main} left`; })()} — {l.expiry_date ? `expires ${l.expiry_date}` : "no expiry"}{idx === 0 ? " (FEFO suggestion)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosenLot && (
          <div style={{ background: "#EAF6F4", border: "1px solid #C6E8E3", borderRadius: 7, padding: "9px 12px", fontSize: 12.5, color: "#0F5F5B" }}>
            {selectedLotId && chosenLot.id !== fefo.id ? (
              <>You picked <b>Lot {chosenLot.lot_number}</b> instead of the FEFO suggestion (Lot {fefo.lot_number}).</>
            ) : (
              <>Using <b>Lot {chosenLot.lot_number}</b> ({(() => { const q = formatCartonQty(chosenLot.current_quantity, chosenLot.units_per_carton, chosenLot.unit); return q.sub ? `${q.main}, ${q.sub}` : `${q.main} left`; })()}, {chosenLot.expiry_date ? `expires ${chosenLot.expiry_date}` : "no expiry date"}){lots.length > 1 ? ` — ${lots.length} lots available` : ""}</>
            )}
          </div>
        )}
        {showReplaceChoice && (
          <div style={{ background: "#FFF7ED", border: "1px solid #FDBA74", borderRadius: 7, padding: "10px 12px" }}>
            <div style={{ fontSize: 12.5, color: "#7C3E00", marginBottom: 8 }}>
              Lot <b>{currentActiveLot.lot_number}</b> is currently marked active on <b>{device}</b>. Does this replace it?
            </div>
            <YesNoRow label="Replace the lot active on this device" value={replaceOnDevice} onChange={setReplaceOnDevice} />
            {!replaceOnDevice && <div style={{ fontSize: 11.5, color: "#7C3E00", marginTop: 6 }}>Both lots will show as active on this device — use this only if the device genuinely holds two lots at once.</div>}
          </div>
        )}
        {pendingLtl && (
          <div style={{ background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 7, padding: "10px 12px" }}>
            <div style={{ fontSize: 12.5, color: "#3730A3", marginBottom: 8 }}>
              Lot <b>{pendingLtl.depleted_lot_number}</b> ran out on <b>{device}</b>. Lot-to-Lot verification is required before using the next lot.
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#3730A3", cursor: "pointer" }}>
              <input type="checkbox" checked={ltlConfirmed} onChange={(e) => setLtlConfirmed(e.target.checked)} />
              I confirm Lot-to-Lot verification was performed for this lot
            </label>
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...labelStyle, flex: 1 }}>{chosenLot?.units_per_carton ? `Units used (of ${chosenLot.units_per_carton}/box)` : `Amount used (${chosenLot?.unit || "unit"})`}<input type="number" style={inputStyle} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label style={{ ...labelStyle, flex: 1 }}>Date<input type="date" style={inputStyle} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <label style={labelStyle}>Used by
          <div style={{ ...inputStyle, background: "#F0F3F2", color: "#516361", display: "flex", alignItems: "center" }}>{usedBy}</div>
        </label>
        <label style={labelStyle}>Note (optional)<input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. daily QC run" /></label>
        <YesNoRow label="Tested by QC" value={testedByQC} onChange={setTestedByQC} />
        <button onClick={submit} disabled={!chosenLot || (pendingLtl && !ltlConfirmed) || submitting} style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: (!chosenLot || (pendingLtl && !ltlConfirmed) || submitting) ? 0.5 : 1 }}>{submitting ? "Saving…" : "Save log"}</button>
      </div>
      {showScanner && <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleScan} />}
    </Modal>
  );
}

function EditReagentModal({ reagent, onClose, onSave }) {
  const [form, setForm] = useState({ ...reagent });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const wasPackaged = !!reagent.units_per_carton;
  const [packagingEnabled, setPackagingEnabled] = useState(wasPackaged);
  const [unitsPerCarton, setUnitsPerCarton] = useState(reagent.units_per_carton || "");
  const [saving, setSaving] = useState(false);

  function submit() {
    if (saving) return;
    setSaving(true);
    const payload = { ...form, quantity_received: Number(form.quantity_received), current_quantity: Number(form.current_quantity), low_stock_threshold: Number(form.low_stock_threshold) };
    if (packagingEnabled && unitsPerCarton) {
      const upc = Number(unitsPerCarton);
      if (!wasPackaged) {
        // Newly enabling packaging: the existing numbers were plain units —
        // convert them once into the new carton-based box count.
        payload.quantity_received = payload.quantity_received * upc;
        payload.current_quantity = payload.current_quantity * upc;
      }
      payload.units_per_carton = upc;
    } else {
      payload.units_per_carton = null;
    }
    onSave(payload);
  }

  return (
    <Modal title={`Edit lot ${reagent.lot_number}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Lot number<input style={inputStyle} value={form.lot_number} onChange={set("lot_number")} /></label>
        <label style={labelStyle}>Unit<input style={inputStyle} value={form.unit} onChange={set("unit")} /></label>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...labelStyle, flex: 1 }}>Quantity received{packagingEnabled ? " (in boxes)" : ""}<input type="number" style={inputStyle} value={form.quantity_received} onChange={set("quantity_received")} /></label>
          <label style={{ ...labelStyle, flex: 1 }}>Current quantity{packagingEnabled ? " (in boxes)" : ""}<input type="number" style={inputStyle} value={form.current_quantity} onChange={set("current_quantity")} /></label>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: "#3A4A48", cursor: "pointer" }}>
          <input type="checkbox" checked={packagingEnabled} onChange={(e) => setPackagingEnabled(e.target.checked)} />
          This item comes in boxes containing multiple {form.unit || "units"}
        </label>
        {packagingEnabled && (
          <label style={labelStyle}>{form.unit || "Units"} per box<input type="number" style={inputStyle} value={unitsPerCarton} onChange={(e) => setUnitsPerCarton(e.target.value)} /></label>
        )}
        {packagingEnabled && !wasPackaged && unitsPerCarton && (
          <div style={{ fontSize: 11.5, color: "#0F7173" }}>
            Quantities above will be converted once: {form.quantity_received} → {Number(form.quantity_received) * Number(unitsPerCarton)} {form.unit}, {form.current_quantity} → {Number(form.current_quantity) * Number(unitsPerCarton)} {form.unit}.
          </div>
        )}

        <label style={labelStyle}>Expiry date (leave blank if not applicable)<input type="date" style={inputStyle} value={form.expiry_date || ""} onChange={set("expiry_date")} /></label>
        <label style={labelStyle}>Low stock alert below<input type="number" style={inputStyle} value={form.low_stock_threshold} onChange={set("low_stock_threshold")} /></label>
        <button
          disabled={saving}
          onClick={submit}
          style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: saving ? 0.7 : 1 }}
        >{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </Modal>
  );
}

const DISCARD_REASONS = ["Expired", "Damaged", "Contaminated", "Other"];

function DiscardModal({ reagent, onClose, onDiscard }) {
  const [reason, setReason] = useState(DISCARD_REASONS[0]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    await onDiscard(reagent.id, reason, note);
    setSaving(false);
  }

  return (
    <Modal title={`Discard Lot ${reagent.lot_number}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "#516361" }}>{reagent.name} — {reagent.current_quantity} {reagent.unit} remaining</div>
        <label style={labelStyle}>Reason
          <select style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)}>
            {DISCARD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label style={labelStyle}>Note (optional)<input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. found leaking on shelf" /></label>
        <div style={{ fontSize: 11.5, color: "#8A9694" }}>This removes the lot from active inventory, same as delete — but the reason is recorded and only visible to the owner in Reports.</div>
        <button disabled={saving} onClick={submit} style={{ marginTop: 6, background: "#C1432B", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: saving ? 0.7 : 1 }}>
          {saving ? "Discarding…" : "Discard this lot"}
        </button>
      </div>
    </Modal>
  );
}

function EditLogModal({ log, onClose, onSave }) {
  const [form, setForm] = useState({ ...log });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [saving, setSaving] = useState(false);
  function submit() {
    if (saving) return;
    setSaving(true);
    onSave({ ...form, amount: Number(form.amount) }, log);
  }
  return (
    <Modal title="Edit consumption log" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>Amount<input type="number" style={inputStyle} value={form.amount} onChange={set("amount")} /></label>
        <label style={labelStyle}>Date<input type="date" style={inputStyle} value={form.date} onChange={set("date")} /></label>
        <label style={labelStyle}>Used by<input style={inputStyle} value={form.used_by} onChange={set("used_by")} /></label>
        <label style={labelStyle}>Note<input style={inputStyle} value={form.note || ""} onChange={set("note")} /></label>
        <YesNoRow label="Tested by QC" value={form.tested_by_qc} onChange={(v) => setForm((f) => ({ ...f, tested_by_qc: v }))} />
        <button disabled={saving} onClick={submit} style={{ marginTop: 6, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, opacity: saving ? 0.7 : 1 }}>{saving ? "Saving…" : "Save changes"}</button>
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
