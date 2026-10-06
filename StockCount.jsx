import React, { useState, useEffect, useRef } from "react";
import { ClipboardCheck, ScanLine, Search, Check, X, ChevronRight, AlertTriangle, Plus, RotateCcw, Trash2, Pencil } from "lucide-react";
import { supabase } from "./supabaseClient";
import BarcodeScanner from "./BarcodeScanner";
import { buildSpreadEntries } from "./logSpread";
import { localDay, previousCompletedCounts, usageInterval, dateInInterval, entriesInInterval } from "./countBounds";
import { startDecision, isScopeConflict } from "./countScope";
import { countedFields } from "./countEvidence";

const T = {
  primary: "var(--primary)",
  bg: "var(--bg)",
  cardBg: "var(--card-bg)",
  cardBorder: "var(--card-border)",
  cardShadow: "var(--card-shadow)",
  text: "var(--text)",
  textMuted: "var(--text-muted)",
};
const RED = "#C1432B";
const AMBER = "#B8860B";
const GREEN = "#2F6B4F";

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const todayISO = () => new Date().toISOString().slice(0, 10);

// Expiry shown next to every lot so a mistyped date at receiving time gets
// noticed while someone is physically holding the box. Read live from the
// reagent (not snapshotted) so a corrected date shows up immediately.
function ExpiryTag({ reagent, warnDays }) {
  if (!reagent) return null;
  if (!reagent.expiry_date) return <span style={{ color: T.textMuted }}> · no expiry</span>;
  const days = Math.round((new Date(reagent.expiry_date) - new Date(todayISO())) / 86400000);
  const color = days < 0 ? RED : days <= warnDays ? AMBER : T.textMuted;
  return <span style={{ color, fontWeight: days <= warnDays ? 700 : 400 }}> · Exp {reagent.expiry_date}{days < 0 ? " (expired)" : ""}</span>;
}

const describeEdit = (e) => (e.mode === "range" ? `spread ${e.from} → ${e.to}` : e.date);

export default function StockCount({ reagents, departments, username, reload, warnDays = 30 }) {
  const reagentById = {};
  reagents.forEach((r) => { reagentById[r.id] = r; });
  const [view, setView] = useState("list"); // list | active | review
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [startDept, setStartDept] = useState("all");
  const [notice, setNotice] = useState(""); // why a start continued an open count or was refused
  const [activeSession, setActiveSession] = useState(null);
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const [loggingItemId, setLoggingItemId] = useState(null);
  const [logMode, setLogMode] = useState("unknown"); // unknown | exact
  const [logDate, setLogDate] = useState(todayISO());
  const [lineMsg, setLineMsg] = useState({}); // itemId -> why a usage date was refused
  const [linkedLogs, setLinkedLogs] = useState({}); // itemId -> { logs, matched }
  const [edits, setEdits] = useState({}); // itemId -> pending date draft, applied only on approval
  const [editingId, setEditingId] = useState(null);
  const [edMode, setEdMode] = useState("exact");
  const [edDate, setEdDate] = useState(todayISO());
  const [edFrom, setEdFrom] = useState(todayISO());
  const [edTo, setEdTo] = useState(todayISO());
  const [applyingEdits, setApplyingEdits] = useState(false);
  const [editMsg, setEditMsg] = useState("");
  const rowRefs = useRef({});
  // In-flight guard against double submission (double clicks, or a click
  // while the first request chain is still running). The ref is the source of
  // truth and is taken synchronously, before any await; the state copy only
  // drives the disabled buttons. Released in finally, so a thrown failure
  // never leaves the action locked. Every write action on one count line
  // shares one key (line:<id>), so two different resolutions can't overlap.
  const pendingRef = useRef(new Set());
  const [pending, setPending] = useState(() => new Set());
  async function guarded(key, fn) {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    try {
      await fn();
    } finally {
      pendingRef.current.delete(key);
      setPending(new Set(pendingRef.current));
    }
  }
  const busy = (key) => pending.has(key);

  useEffect(() => { loadSessions(); }, []);

  // Date window for usage corrections (countBounds.js): one read per review
  // screen — the count lines of the lots shown here, with their counts — to
  // find each exact lot's previous completed count. Nothing is written.
  const reviewLotKey = view === "review" && activeSession
    ? [...new Set(items.map((i) => i.reagent_id).filter(Boolean))].sort().join(",")
    : "";
  const priorKey = activeSession ? `${activeSession.id}|${reviewLotKey}` : "";
  const [priorCounts, setPriorCounts] = useState({ key: "", status: "idle", byLot: {} });
  useEffect(() => {
    if (!reviewLotKey) return;
    const key = priorKey, session = activeSession;
    let cancelled = false;
    setPriorCounts({ key, status: "loading", byLot: {} });
    supabase.from("inventory_count_items").select("reagent_id,count_id,inventory_counts(status,started_at,completed_at)").in("reagent_id", reviewLotKey.split(","))
      .then(
        ({ data, error }) => { if (!cancelled) setPriorCounts(error ? { key, status: "error", byLot: {} } : { key, status: "ready", byLot: previousCompletedCounts(data, session) }); },
        () => { if (!cancelled) setPriorCounts({ key, status: "error", byLot: {} }); }
      );
    return () => { cancelled = true; };
  }, [priorKey]);

  // The window a line's usage may be dated in, or why it isn't available yet.
  function countWindow(it) {
    if (priorCounts.key !== priorKey || priorCounts.status === "loading" || priorCounts.status === "idle") return { ok: false, reason: "loading" };
    if (priorCounts.status === "error") return { ok: false, reason: "error" };
    return usageInterval({ lot: reagentById[it.reagent_id], previousCompletedAt: priorCounts.byLot[it.reagent_id], session: activeSession });
  }
  function windowProblem(iv) {
    if (iv.reason === "loading") return "Loading the dates of earlier counts…";
    if (iv.reason === "error") return "Couldn't load the dates of earlier counts, so this usage can't be dated yet. Reopen this count to try again.";
    if (iv.reason === "no_lot") return "This lot's record wasn't found, so this usage can't be dated.";
    if (iv.reason === "empty") return `No valid dates: this lot's window starts ${iv.from}, after this count started (${iv.to}).`;
    return "This lot's dates are unknown, so this usage can't be dated.";
  }
  const windowSource = (iv) => (iv.fromSource === "previous_count" ? "since this lot's previous stock count" : "since this lot was received");
  const outsideMsg = (iv) => `Choose a date from ${iv.from} to ${iv.to} (${windowSource(iv)}, up to the day this count started).`;
  const setMsg = (id, text, calm = false) => setLineMsg((m) => ({ ...m, [id]: text ? { text, calm } : null }));

  async function loadSessions() {
    setLoadingSessions(true);
    const { data } = await supabase.from("inventory_counts").select("*").order("started_at", { ascending: false });
    setSessions(data || []);
    setLoadingSessions(false);
  }

  async function loadItems(countId) {
    const { data } = await supabase.from("inventory_count_items").select("*").eq("count_id", countId).order("department").order("reagent_name");
    setItems(data || []);
    return data || [];
  }

  // Only in-progress counts can be deleted; a completed count is a permanent
  // record and can only be edited. Corrections already applied from an
  // in-progress count (quantity changes, usage logs) are NOT undone.
  async function deleteSession(s) {
    if (s.status === "completed") return;
    const { data: its } = await supabase.from("inventory_count_items").select("resolved,resolution_note").eq("count_id", s.id);
    const applied = (its || []).filter((i) => i.resolved && i.resolution_note !== "Kept system value").length;
    const msg = applied > 0
      ? `This count has already changed ${applied} item(s) in your real inventory (quantities and/or usage entries). Deleting it only removes the count record — it does NOT undo those changes. Delete anyway?`
      : "Delete this count? Nothing in your inventory was changed by it.";
    if (!confirm(msg)) return;
    await supabase.from("inventory_counts").delete().eq("id", s.id);
    await supabase.from("audit_log").insert({
      action: "delete",
      entity: "stock count",
      description: `In-progress stock count (${s.department || "Whole lab"}, started ${fmtDateTime(s.started_at)}) deleted${applied > 0 ? `; ${applied} correction(s) it had already applied were left in place` : ""}`,
      performed_by: username,
    });
    loadSessions();
  }

  // Finds the consumption_logs rows each "logged as usage" line created. Lines
  // resolved after the link column existed carry their ids; older ones are
  // matched by reagent + "Unlogged (physical count)" + the count's time window,
  // and only trusted if the amounts add up to the shortage exactly.
  async function loadLinkedLogs(session, list) {
    const usageItems = list.filter((i) => i.resolved && (i.resolution_note || "").startsWith("Logged as usage"));
    if (usageItems.length === 0) { setLinkedLogs({}); return; }
    const ids = [...new Set(usageItems.flatMap((i) => i.consumption_log_ids || []))];
    const byId = {};
    if (ids.length) {
      const { data } = await supabase.from("consumption_logs").select("*").in("id", ids);
      (data || []).forEach((l) => { byId[l.id] = l; });
    }
    let windowLogs = [];
    if (usageItems.some((i) => !(i.consumption_log_ids || []).length)) {
      const end = session.completed_at ? new Date(new Date(session.completed_at).getTime() + 60000).toISOString() : new Date().toISOString();
      const { data } = await supabase.from("consumption_logs").select("*").eq("used_by", "Unlogged (physical count)").gte("created_at", session.started_at).lte("created_at", end);
      windowLogs = data || [];
    }
    const result = {};
    usageItems.forEach((i) => {
      if ((i.consumption_log_ids || []).length) {
        const logs = i.consumption_log_ids.map((id) => byId[id]).filter(Boolean);
        result[i.id] = { logs, matched: logs.length === i.consumption_log_ids.length };
      } else {
        const logs = windowLogs.filter((l) => l.reagent_id === i.reagent_id);
        const sum = logs.reduce((s, l) => s + Number(l.amount), 0);
        const shortage = Number(i.expected_quantity) - Number(i.counted_quantity);
        result[i.id] = { logs, matched: logs.length > 0 && Math.abs(sum - shortage) < 0.005 };
      }
    });
    setLinkedLogs(result);
  }

  function openEditor(it) {
    const dates = (linkedLogs[it.id]?.logs || []).map((l) => l.date).sort();
    const first = dates[0] || todayISO();
    const last = dates[dates.length - 1] || first;
    const draft = edits[it.id];
    setEdMode(draft ? draft.mode : dates.length > 1 ? "range" : "exact");
    setEdDate(draft?.date || first);
    setEdFrom(draft?.from || first);
    setEdTo(draft?.to || last);
    setEditingId(it.id);
  }

  function saveDraft(it) {
    setEdits((prev) => ({ ...prev, [it.id]: { mode: edMode, date: edDate, from: edFrom, to: edTo } }));
    setEditingId(null);
  }

  // A date edit must stay inside the line's window (countBounds.js), for both
  // an exact date and every weekly entry a range would create.
  function draftProblem(it, d) {
    const iv = countWindow(it);
    if (!iv.ok) return windowProblem(iv);
    if (d.mode === "range") {
      if (!dateInInterval(d.from, iv) || !dateInInterval(d.to, iv) || d.from > d.to) return outsideMsg(iv);
      const total = Math.round((linkedLogs[it.id]?.logs || []).reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
      return entriesInInterval(buildSpreadEntries(total, d.from, d.to), iv) ? null : outsideMsg(iv);
    }
    return dateInInterval(d.date, iv) ? null : outsideMsg(iv);
  }

  function saveDraftChecked(it) {
    const problem = draftProblem(it, { mode: edMode, date: edDate, from: edFrom, to: edTo });
    setMsg(it.id, problem);
    if (!problem) saveDraft(it);
  }

  // Re-checked at Apply time too (a draft can't be applied unless every one is valid).
  async function applyAllEditsChecked() {
    const bad = Object.entries(edits).filter(([id, d]) => { const it = items.find((i) => i.id === id); return it && draftProblem(it, d); });
    if (bad.length) {
      bad.forEach(([id, d]) => setMsg(id, draftProblem(items.find((i) => i.id === id), d)));
      setEditMsg("Nothing was applied: a date edit is outside its lot's valid dates (see the line above).");
      return;
    }
    await applyAllEdits();
  }

  function discardDraft(itemId) {
    setEdits((prev) => { const next = { ...prev }; delete next[itemId]; return next; });
  }

  // Nothing above touches real data: drafts live only in memory. Applying
  // re-dates each drafted line with ONE atomic call (stock_count_redate): the
  // replacement entries, removal of the old ones, the line's note/links and the
  // audit row commit together, or that line stays exactly as it was. Lines are
  // independent; the stock and the original resolution never change.
  async function applyAllEdits() {
    setApplyingEdits(true);
    setEditMsg("");
    let applied = 0;
    let changed = 0;
    let failed = 0;
    for (const [itemId, e] of Object.entries(edits)) {
      const info = linkedLogs[itemId];
      if (!info || !info.matched) { failed++; setMsg(itemId, "This line's usage entries weren't found, so its dates weren't changed."); continue; }
      const total = Math.round(info.logs.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
      const r = await countCall("stock_count_redate", {
        p_item_id: itemId,
        p_actor: username,
        p_current_log_ids: info.logs.map((l) => l.id),
        p_mode: e.mode === "range" ? "range" : "exact",
        ...(e.mode === "range"
          ? { p_from: e.from, p_to: e.to, p_allocation: buildSpreadEntries(total, e.from, e.to).map((en) => ({ date: en.date, amount: en.amount })) }
          : { p_date: e.date }),
      });
      if (r.status === "ok") applied++;
      else if (r.status === "stale_allocation") changed++;
      else failed++;
      setMsg(itemId, resultMessage(r));
    }
    const data = await loadItems(activeSession.id);
    await loadLinkedLogs(activeSession, data);
    setEdits({});
    setApplyingEdits(false);
    const parts = [`${applied} edit${applied === 1 ? "" : "s"} applied`];
    if (changed) parts.push(`${changed} changed since loaded — review again`);
    if (failed) parts.push(`${failed} could not be updated (see the line${failed === 1 ? "" : "s"} above)`);
    setEditMsg(`${parts.join(", ")}.`);
    if (applied) reload();
  }

  async function startCount() {
    const scope = reagents.filter((r) => !r.deleted && (startDept === "all" || r.department === startDept));
    if (scope.length === 0) return;
    const { data: session, error } = await supabase
      .from("inventory_counts")
      .insert({ department: startDept === "all" ? null : startDept, started_by: username })
      .select()
      .single();
    if (error || !session) return { error };
    const rows = scope.map((r) => ({
      count_id: session.id,
      reagent_id: r.id,
      reagent_name: r.name,
      lot_number: r.lot_number,
      department: r.department,
      unit: r.unit,
      expected_quantity: r.current_quantity,
    }));
    const { data: inserted } = await supabase.from("inventory_count_items").insert(rows).select();
    setActiveSession(session);
    setItems(inserted || []);
    setView("active");
    loadSessions();
  }

  // Start a count, or continue the open one for the same scope (countScope.js).
  // 1. fresh read of the open counts, 2. start only if allowed, 3. if the
  // database still refuses (another tab/device won a race), re-read and
  // continue/explain. Only this rule's own refusals are handled here.
  const scopeName = (dept) => (dept == null ? "Whole lab" : dept);
  async function applyStartDecision(d, dept) {
    if (d.kind === "resume") {
      setNotice(dept == null ? "A Whole lab count is already in progress. Continuing the existing count." : `${dept} already has a stock count in progress. Continuing the existing count.`);
      await resumeCount(d.session);
      return true;
    }
    if (d.kind === "blocked_by_whole_lab") {
      setNotice("A Whole lab count is in progress. No other count can start until it's finished.");
      loadSessions();
      return true;
    }
    if (d.kind === "blocked_by_departments") {
      setNotice(`Whole lab can't start while other counts are in progress (${[...new Set(d.sessions.map((s) => scopeName(s.department)))].join(", ")}). Finish them first.`);
      loadSessions();
      return true;
    }
    return false;
  }
  async function readOpenCounts() {
    const { data, error } = await supabase.from("inventory_counts").select("*").eq("status", "in_progress");
    return error ? null : data || [];
  }
  async function startOrContinue() {
    const dept = startDept === "all" ? null : startDept;
    setNotice("");
    const open = await readOpenCounts();
    if (open && (await applyStartDecision(startDecision(dept, open), dept))) return;
    const result = await startCount();
    if (!result || !isScopeConflict(result.error)) return;
    const now = await readOpenCounts();
    if (now && (await applyStartDecision(startDecision(dept, now), dept))) return;
    setNotice("Another stock count was just started or changed. Please try again.");
    loadSessions();
  }

  async function resumeCount(session) {
    setActiveSession(session);
    setEdits({});
    setEditingId(null);
    setEditMsg("");
    setLinkedLogs({});
    const data = await loadItems(session.id);
    if (session.status === "completed") await loadLinkedLogs(session, data);
    setView(session.status === "completed" ? "review" : "active");
  }

  // Counting only — resolving is separate. Once a line is resolved its counted
  // quantity is final: the input is disabled and this refuses the write too.
  async function saveCount(itemId, value) {
    const current = items.find((it) => it.id === itemId);
    if (current?.resolved) return;
    const num = value === "" ? null : Number(value);
    const observed = countedFields(current?.counted_quantity, num, username);
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, counted_quantity: num, ...observed } : it)));
    await supabase.from("inventory_count_items").update({ counted_quantity: num, ...observed }).eq("id", itemId);
  }

  function handleScan(text) {
    setShowScanner(false);
    const match = items.find((it) => it.lot_number === text);
    if (!match) return;
    setSearch("");
    setHighlightId(match.id);
    setTimeout(() => {
      rowRefs.current[match.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      rowRefs.current[match.id]?.querySelector("input")?.focus();
    }, 50);
    setTimeout(() => setHighlightId(null), 2500);
  }

  // Every discrepancy resolution, and every Edit dates line, is ONE call to an
  // atomic database function (ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql): the
  // correction rows, the lot's stock, auto-removal (same rule as App.jsx's
  // recordConsumption), the audit rows and the line's resolution commit
  // together or not at all. The database reads the real quantities itself;
  // what the user saw is sent only so it can refuse ("stale_line") if the line
  // changed meanwhile. Any status other than "ok" means nothing was written,
  // so nothing here falls back to other writes or retries on its own.
  async function countCall(fn, args) {
    try {
      const { data, error } = await supabase.rpc(fn, args);
      return !error && data && data.status ? data : { status: "error" };
    } catch {
      return { status: "error" };
    }
  }

  function resultMessage(r) {
    switch (r.status) {
      case "ok": return null;
      case "already_resolved": return "This line was already resolved (on another device or by an earlier attempt). Showing the saved result.";
      case "stale_line": return "This line changed since it was loaded, so nothing was saved. Please review it again.";
      case "stale_allocation": return "This line's usage entries changed since they were loaded, so nothing was changed. Please review its dates again.";
      case "outside_window": return r.window?.ok ? outsideMsg({ ...r.window, fromSource: r.window.source }) : "That date is outside this lot's valid dates, so nothing was saved.";
      case "window_unavailable": return windowProblem({ reason: r.window?.reason, from: r.window?.from, to: r.window?.to });
      case "allocation_mismatch":
      case "invalid_allocation": return "The usage entries didn't match the missing amount, so nothing was saved. Reopen this count and try again.";
      case "allocation_unsafe": return "This line's usage entries can't be matched safely, so they weren't changed.";
      case "no_discrepancy": return "This line no longer has a discrepancy, so nothing was saved.";
      case "invalid_count_state": return "This count is no longer in a state that allows this, so nothing was saved. Reopen the count to see its current state.";
      case "invalid_line_state": return "This line's dates can't be edited, so nothing was changed.";
      case "not_found": return "This line no longer exists (the count may have been deleted), so nothing was saved.";
      case "invalid_input": return "Nothing was saved: the request was incomplete. Reopen this count and try again.";
      default: return "Couldn't confirm the save. Check the connection and try again — it can't be applied twice.";
    }
  }

  // Resolves one discrepancy line. Whenever the database returns the line, that
  // authoritative row replaces the local copy (nothing is marked resolved here
  // on the browser's own say-so). If the call failed without an answer, the
  // line is re-read: the save may still have gone through (a lost response).
  async function resolveLine(item, method, extra = {}) {
    let r = await countCall("stock_count_resolve", {
      p_item_id: item.id,
      p_method: method,
      p_actor: username,
      p_seen_expected: item.expected_quantity,
      p_seen_counted: item.counted_quantity,
      ...extra,
    });
    if (r.status === "error") {
      const { data } = await supabase.from("inventory_count_items").select("*").eq("id", item.id);
      if (data && data[0]?.resolved) r = { status: "already_resolved", line: data[0] };
    }
    if (r.line) setItems((prev) => prev.map((it) => (it.id === item.id ? r.line : it)));
    if (r.status === "ok" || r.status === "already_resolved") setLoggingItemId((cur) => (cur === item.id ? null : cur));
    setMsg(item.id, resultMessage(r), r.status === "already_resolved");
    if (r.status === "ok" && method !== "kept") reload();
    return r;
  }

  const applyCorrection = (item) => resolveLine(item, "corrected");

  // For a shortage specifically: the missing units were genuinely used but
  // never logged. Recording it as a real consumption_logs row (instead of
  // just silently lowering current_quantity) keeps usage-rate analytics,
  // reorder suggestions, and "most used" reports honest. The date is left
  // to the person resolving it — we have no way to know when the units
  // actually went missing, only that they're gone now.
  // The database checks the date against the same window and records it as
  // count_exact_default (the default day was kept) or count_exact.
  const logUnrecordedUsage = (item, date) => resolveLine(item, "usage_exact", { p_date: date });

  // Same idea as logUnrecordedUsage, but for when you're confident the
  // shortage built up gradually over a known period rather than on one
  // specific day — spreads it into ~weekly entries so it doesn't show up as
  // one artificial spike in the usage-rate charts. The entries are built here
  // (logSpread.js) and checked by the database: inside the window, adding up
  // exactly to the shortage.
  const logUnrecordedUsageSpread = (item, entries) =>
    resolveLine(item, "usage_spread", { p_allocation: entries.map((e) => ({ date: e.date, amount: e.amount })) });

  const dismissDiscrepancy = (item) => resolveLine(item, "kept");

  async function finishSession() {
    await supabase.from("inventory_counts").update({ status: "completed", completed_by: username, completed_at: new Date().toISOString() }).eq("id", activeSession.id);
    const completed = { ...activeSession, status: "completed", completed_by: username, completed_at: new Date().toISOString() };
    setActiveSession(completed);
    const data = await loadItems(activeSession.id);
    await loadLinkedLogs(completed, data);
    loadSessions();
  }

  function backToList() {
    setView("list");
    setActiveSession(null);
    setItems([]);
    setSearch("");
    setEdits({});
    setEditingId(null);
    setLinkedLogs({});
    setEditMsg("");
  }

  const term = search.trim().toLowerCase();
  const filteredItems = term
    ? items.filter((it) => it.reagent_name.toLowerCase().includes(term) || it.lot_number.toLowerCase().includes(term))
    : items;
  const byDept = {};
  filteredItems.forEach((it) => { (byDept[it.department] = byDept[it.department] || []).push(it); });

  const countedN = items.filter((it) => it.counted_quantity !== null).length;
  const discrepancies = items.filter((it) => it.counted_quantity !== null && Number(it.counted_quantity) !== Number(it.expected_quantity));
  const unresolvedDiscrepancies = discrepancies.filter((it) => !it.resolved);
  const notCounted = items.filter((it) => it.counted_quantity === null);

  // Start-button state from the sessions already loaded (convenience only — the
  // fresh check in startOrContinue and the database are what enforce the rule).
  const loadedDecision = startDecision(startDept === "all" ? null : startDept, sessions);
  const startBlocked = loadedDecision.kind === "blocked_by_whole_lab" || loadedDecision.kind === "blocked_by_departments";
  const startHint = loadedDecision.kind === "resume"
    ? `${scopeName(loadedDecision.session.department)} already has a count in progress — Continue count opens it.`
    : loadedDecision.kind === "blocked_by_whole_lab"
      ? "A Whole lab count is in progress. Finish it before starting another count."
      : loadedDecision.kind === "blocked_by_departments"
        ? `Whole lab can't start while other counts are in progress (${[...new Set(loadedDecision.sessions.map((s) => scopeName(s.department)))].join(", ")}).`
        : "";

  if (view === "list") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text }}>Stock count</h2>
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
          Walk the shelves and count what's actually there, then compare against what the system expects. Count whenever you like — no schedule. Each department can have one count open at a time; a Whole lab count (every department) needs all other counts finished first.
        </div>

        {notice && (
          <div style={{ fontSize: 13, color: T.text, background: "#FBF3DF", border: `1px solid ${AMBER}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{notice}</div>
        )}

        <div style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 12, boxShadow: T.cardShadow, padding: 16, marginBottom: 24, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select value={startDept} onChange={(e) => setStartDept(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: "9px 12px", fontSize: 14, background: T.cardBg, color: T.text, flex: 1, minWidth: 160 }}>
            <option value="all">Whole lab</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={() => guarded("start", startOrContinue)} disabled={busy("start") || startBlocked} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, opacity: busy("start") || startBlocked ? 0.6 : 1 }}>
            {loadedDecision.kind === "resume" ? <><ChevronRight size={15} /> Continue count</> : <><Plus size={15} /> Start new count</>}
          </button>
          {startHint && <div style={{ flexBasis: "100%", fontSize: 12.5, color: T.textMuted }}>{startHint}</div>}
        </div>

        <div style={{ fontWeight: 700, fontSize: 13, color: T.textMuted, letterSpacing: 0.3, marginBottom: 8 }}>PAST SESSIONS</div>
        {loadingSessions && <div style={{ fontSize: 13, color: T.textMuted }}>Loading…</div>}
        {!loadingSessions && sessions.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>No counts yet — start your first one above.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
              <button
                onClick={() => resumeCount(s)}
                style={{ flex: 1, minWidth: 0, background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 10, padding: "12px 16px", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.status === "completed" ? GREEN : AMBER, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>{s.department || "Whole lab"}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>
                    {s.status === "completed" ? "Completed" : "In progress"} · started by {s.started_by} · {fmtDateTime(s.started_at)}
                  </div>
                </div>
                <ChevronRight size={16} color={T.textMuted} />
              </button>
              {s.status !== "completed" && (
                <button
                  onClick={() => guarded(`delete:${s.id}`, () => deleteSession(s))}
                  disabled={busy(`delete:${s.id}`)}
                  title="Delete this count (only possible while it's still in progress)"
                  style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 10, padding: "0 12px", color: RED, opacity: busy(`delete:${s.id}`) ? 0.6 : 1 }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (view === "active") {
    return (
      <div>
        <button onClick={() => { setNotice(""); backToList(); }} style={{ background: "none", border: "none", color: T.primary, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>← Back to stock count</button>
        {notice && (
          <div style={{ fontSize: 13, color: T.text, background: "#FBF3DF", border: `1px solid ${AMBER}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>{notice}</div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 10 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text }}>{activeSession.department || "Whole lab"} — counting</h2>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted }}>{countedN} / {items.length} counted</div>
        </div>
        <div style={{ height: 6, background: T.cardBorder, borderRadius: 3, marginBottom: 18, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${items.length ? (countedN / items.length) * 100 : 0}%`, background: T.primary, transition: "width .2s" }} />
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={15} color={T.textMuted} style={{ position: "absolute", left: 12, top: 12 }} />
            <input
              placeholder="Search reagent or lot number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%", border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: "10px 12px 10px 36px", fontSize: 15, boxSizing: "border-box", background: T.cardBg, color: T.text }}
            />
          </div>
          <button onClick={() => setShowScanner(true)} title="Scan a lot to find it" style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: "0 14px", display: "flex", alignItems: "center", gap: 6, color: T.text, fontSize: 13.5, fontWeight: 600 }}>
            <ScanLine size={16} /> Scan
          </button>
        </div>

        {Object.keys(byDept).sort().map((dept) => (
          <div key={dept} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.textMuted, marginBottom: 8 }}>{dept}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {byDept[dept].map((it) => {
                const isHighlighted = highlightId === it.id;
                const hasMismatch = it.counted_quantity !== null && Number(it.counted_quantity) !== Number(it.expected_quantity);
                return (
                  <div
                    key={it.id}
                    ref={(el) => (rowRefs.current[it.id] = el)}
                    style={{
                      background: isHighlighted ? `${T.primary}18` : T.cardBg,
                      border: `1px solid ${isHighlighted ? T.primary : T.cardBorder}`,
                      borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
                      transition: "background .3s, border-color .3s",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 140 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>{it.reagent_name}</div>
                      <div style={{ fontSize: 11.5, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>Lot {it.lot_number} · expected {it.expected_quantity} {it.unit}<ExpiryTag reagent={reagentById[it.reagent_id]} warnDays={warnDays} /></div>
                    </div>
                    <input
                      type="number"
                      placeholder="Counted"
                      defaultValue={it.counted_quantity ?? ""}
                      disabled={!!it.resolved}
                      title={it.resolved ? "This line is resolved — its counted quantity can't be changed." : undefined}
                      onBlur={(e) => saveCount(it.id, e.target.value)}
                      style={{
                        width: 100, border: `1px solid ${hasMismatch ? AMBER : T.cardBorder}`, borderRadius: 7, padding: "8px 10px",
                        fontSize: 15, textAlign: "right", background: T.cardBg, color: T.text, boxSizing: "border-box",
                      }}
                    />
                    <div style={{ fontSize: 12, color: T.textMuted, width: 30 }}>{it.unit}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <button onClick={() => setView("review")} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "12px", fontWeight: 700, fontSize: 14, width: "100%", marginTop: 8 }}>
          Review & finish ({discrepancies.length} discrepanc{discrepancies.length === 1 ? "y" : "ies"}{notCounted.length ? `, ${notCounted.length} not counted` : ""})
        </button>

        {showScanner && <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleScan} />}
      </div>
    );
  }

  // view === "review"
  return (
    <div>
      <button onClick={() => { setNotice(""); backToList(); }} style={{ background: "none", border: "none", color: T.primary, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>← Back to stock count</button>
      {notice && (
        <div style={{ fontSize: 13, color: T.text, background: "#FBF3DF", border: `1px solid ${AMBER}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>{notice}</div>
      )}
      <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text, marginBottom: 4 }}>{activeSession.department || "Whole lab"} — review</h2>
      <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
        {activeSession.status === "completed" ? `Completed by ${activeSession.completed_by} · ${fmtDateTime(activeSession.completed_at)}` : "Only mismatches are shown below — everything else matched what the system expected."}
      </div>

      {discrepancies.length === 0 && (
        <div style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 10, padding: 20, textAlign: "center", color: T.textMuted, fontSize: 13.5, marginBottom: 20 }}>
          <Check size={22} color={GREEN} style={{ marginBottom: 6 }} />
          <div>No discrepancies — everything counted matched the system.</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        {discrepancies.map((it) => {
          const over = Number(it.counted_quantity) > Number(it.expected_quantity);
          const shortage = !over;
          const isLogging = loggingItemId === it.id;
          const canEdit = activeSession.status === "completed" && it.resolved && (it.resolution_note || "").startsWith("Logged as usage");
          const info = linkedLogs[it.id];
          const draft = edits[it.id];
          const isEditing = editingId === it.id;
          const lineKey = `line:${it.id}`;
          const lineBusy = busy(lineKey);
          const win = isLogging || isEditing ? countWindow(it) : null;
          const winMin = win?.ok ? win.from : undefined;
          const winMax = win?.ok ? win.to : undefined;
          return (
            <div key={it.id} style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderLeft: `4px solid ${AMBER}`, borderRadius: 8, padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>{it.reagent_name}</div>
                  <div style={{ fontSize: 11.5, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>Lot {it.lot_number} · {it.department}<ExpiryTag reagent={reagentById[it.reagent_id]} warnDays={warnDays} /></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12.5, color: T.textMuted }}>System said <b style={{ color: T.text }}>{it.expected_quantity}</b></div>
                  <div style={{ fontSize: 12.5, color: over ? GREEN : RED, fontWeight: 700 }}>You counted {it.counted_quantity}</div>
                </div>
                {it.resolved ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: GREEN, background: "#E8F2EC", borderRadius: 6, padding: "4px 10px" }}>{it.resolution_note}</span>
                    {canEdit && info?.matched && (
                      <button onClick={() => openEditor(it)} title="Edit the usage dates for this line" style={{ background: "none", border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "4px 8px", color: T.text, display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600 }}>
                        <Pencil size={13} /> Edit dates
                      </button>
                    )}
                    {canEdit && info && !info.matched && (
                      <span title="Its usage entries were changed since, or couldn't be matched exactly" style={{ fontSize: 11.5, color: T.textMuted }}>Can't edit here — usage entries not found</span>
                    )}
                  </div>
                ) : shortage ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => { setLoggingItemId(it.id); setLogMode("unknown"); setLogDate(localDay(activeSession.started_at)); setMsg(it.id, null); }} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Log as unrecorded usage</button>
                    <button onClick={() => guarded(lineKey, () => applyCorrection(it))} disabled={lineBusy} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.text, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, opacity: lineBusy ? 0.6 : 1 }}>Correct a logging error</button>
                    <button onClick={() => guarded(lineKey, () => dismissDiscrepancy(it))} disabled={lineBusy} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.textMuted, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, opacity: lineBusy ? 0.6 : 1 }}>Keep system value</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => guarded(lineKey, () => applyCorrection(it))} disabled={lineBusy} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, opacity: lineBusy ? 0.6 : 1 }}>Apply correction</button>
                    <button onClick={() => guarded(lineKey, () => dismissDiscrepancy(it))} disabled={lineBusy} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.textMuted, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, opacity: lineBusy ? 0.6 : 1 }}>Keep system value</button>
                  </div>
                )}
              </div>

              {canEdit && draft && !isEditing && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.cardBorder}`, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: AMBER, background: "#FBF3DF", borderRadius: 6, padding: "3px 9px" }}>Pending: {describeEdit(draft)}</span>
                  <span style={{ fontSize: 12, color: T.textMuted }}>not applied yet</span>
                  <button onClick={() => discardDraft(it.id)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Undo</button>
                </div>
              )}

              {isEditing && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.cardBorder}` }}>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>
                    Currently: {(info?.logs || []).map((l) => l.date).sort().join(", ") || "—"} · {Math.round((info?.logs || []).reduce((s, l) => s + Number(l.amount), 0) * 100) / 100} {it.unit} in total (the amount stays the same, only the dates change)
                  </div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    <button onClick={() => setEdMode("exact")} style={{ background: edMode === "exact" ? T.primary : "none", color: edMode === "exact" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}>Exact date</button>
                    <button onClick={() => setEdMode("range")} style={{ background: edMode === "range" ? T.primary : "none", color: edMode === "range" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}>Spread over a range</button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {edMode === "exact" ? (
                      <input type="date" value={edDate} min={winMin} max={winMax} onChange={(e) => setEdDate(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                    ) : (
                      <>
                        <input type="date" value={edFrom} min={winMin} max={edTo} onChange={(e) => setEdFrom(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                        <span style={{ fontSize: 12.5, color: T.textMuted }}>to</span>
                        <input type="date" value={edTo} min={edFrom} max={winMax} onChange={(e) => setEdTo(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                      </>
                    )}
                    <button onClick={() => saveDraftChecked(it)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Save as draft</button>
                    <button onClick={() => setEditingId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8 }}>
                    {win?.ok ? `Valid dates: ${win.from} to ${win.to} (${windowSource(win)}, up to the day this count started).` : windowProblem(win || { reason: "loading" })}
                  </div>
                </div>
              )}

              {isLogging && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.cardBorder}` }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    <button
                      onClick={() => setLogMode("unknown")}
                      style={{ background: logMode === "unknown" ? T.primary : "none", color: logMode === "unknown" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}
                    >
                      Unknown date
                    </button>
                    <button
                      onClick={() => setLogMode("exact")}
                      style={{ background: logMode === "exact" ? T.primary : "none", color: logMode === "exact" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}
                    >
                      Exact date
                    </button>
                  </div>

                  {logMode === "unknown" ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, color: T.textMuted, flex: "1 1 240px" }}>
                        {win?.ok ? (
                          <>The exact dates aren't known, so the missing {Math.round((Number(it.expected_quantity) - Number(it.counted_quantity)) * 100) / 100} {it.unit} will be estimated as weekly entries across <b style={{ color: T.text }}>{win.from} – {win.to}</b> ({windowSource(win)}, up to the day this count started).</>
                        ) : windowProblem(win || { reason: "loading" })}
                      </span>
                      <button
                        onClick={() => guarded(lineKey, async () => {
                          const iv = countWindow(it);
                          if (!iv.ok) { setMsg(it.id, windowProblem(iv)); return; }
                          const entries = buildSpreadEntries(Number(it.expected_quantity) - Number(it.counted_quantity), iv.from, iv.to);
                          if (!entriesInInterval(entries, iv)) { setMsg(it.id, outsideMsg(iv)); return; }
                          setMsg(it.id, null);
                          await logUnrecordedUsageSpread(it, entries);
                        })}
                        disabled={lineBusy || !win?.ok}
                        style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, opacity: lineBusy || !win?.ok ? 0.6 : 1 }}
                      >
                        Confirm
                      </button>
                      <button onClick={() => setLoggingItemId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, color: T.textMuted }}>Only if you know when it was used:</span>
                      <input
                        type="date"
                        value={logDate}
                        min={winMin}
                        max={winMax}
                        onChange={(e) => setLogDate(e.target.value)}
                        style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }}
                      />
                      <button
                        onClick={() => guarded(lineKey, async () => {
                          const iv = countWindow(it);
                          if (!dateInInterval(logDate, iv)) { setMsg(it.id, iv.ok ? outsideMsg(iv) : windowProblem(iv)); return; }
                          setMsg(it.id, null);
                          await logUnrecordedUsage(it, logDate);
                        })}
                        disabled={lineBusy}
                        style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700, opacity: lineBusy ? 0.6 : 1 }}
                      >
                        Confirm
                      </button>
                      <button onClick={() => setLoggingItemId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                      {win?.ok && <span style={{ fontSize: 12, color: T.textMuted, flexBasis: "100%" }}>Valid dates: {win.from} to {win.to} ({windowSource(win)}, up to the day this count started).</span>}
                    </div>
                  )}
                </div>
              )}

              {lineMsg[it.id] && (
                <div style={{ fontSize: 12, color: lineMsg[it.id].calm ? T.textMuted : RED, marginTop: 8 }}>{lineMsg[it.id].text}</div>
              )}
            </div>
          );
        })}
      </div>

      {notCounted.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.textMuted, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertTriangle size={13} color={AMBER} /> NOT COUNTED ({notCounted.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {notCounted.map((it) => (
              <div key={it.id} style={{ fontSize: 13, color: T.textMuted, padding: "6px 4px", borderBottom: `1px solid ${T.cardBorder}` }}>{it.reagent_name} — Lot {it.lot_number}<ExpiryTag reagent={reagentById[it.reagent_id]} warnDays={warnDays} /></div>
            ))}
          </div>
        </div>
      )}

      {editMsg && (
        <div style={{ fontSize: 13, color: GREEN, background: "#E8F2EC", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{editMsg}</div>
      )}

      {Object.keys(edits).length > 0 && (
        <div style={{ position: "sticky", bottom: 12, background: T.cardBg, border: `1px solid ${AMBER}`, borderRadius: 10, boxShadow: T.cardShadow, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 180, fontSize: 13.5, fontWeight: 600, color: T.text }}>
            {Object.keys(edits).length} date edit{Object.keys(edits).length === 1 ? "" : "s"} waiting for your approval
            <div style={{ fontSize: 12, fontWeight: 400, color: T.textMuted }}>Nothing changes in your data until you press Apply.</div>
          </div>
          <button onClick={() => setEdits({})} disabled={applyingEdits} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.textMuted, borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 600 }}>Discard all</button>
          <button onClick={() => guarded("apply-edits", applyAllEditsChecked)} disabled={applyingEdits || busy("apply-edits")} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, opacity: applyingEdits ? 0.7 : 1 }}>{applyingEdits ? "Applying…" : "Apply all"}</button>
        </div>
      )}

      {activeSession.status !== "completed" && (
        <button
          onClick={() => guarded("finish", finishSession)}
          disabled={unresolvedDiscrepancies.length > 0 || busy("finish")}
          style={{
            background: unresolvedDiscrepancies.length > 0 ? T.cardBorder : T.primary,
            color: unresolvedDiscrepancies.length > 0 ? T.textMuted : "#fff",
            border: "none", borderRadius: 8, padding: "12px", fontWeight: 700, fontSize: 14, width: "100%",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            cursor: unresolvedDiscrepancies.length > 0 ? "not-allowed" : "pointer",
            opacity: busy("finish") ? 0.6 : 1,
          }}
        >
          <ClipboardCheck size={16} />
          {unresolvedDiscrepancies.length > 0 ? `Resolve ${unresolvedDiscrepancies.length} discrepanc${unresolvedDiscrepancies.length === 1 ? "y" : "ies"} first` : "Finish session"}
        </button>
      )}
    </div>
  );
}
