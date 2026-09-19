import React, { useState, useEffect, useRef } from "react";
import { ClipboardCheck, ScanLine, Search, Check, X, ChevronRight, AlertTriangle, Plus, RotateCcw, Trash2, Pencil } from "lucide-react";
import { supabase } from "./supabaseClient";
import BarcodeScanner from "./BarcodeScanner";
import { buildSpreadEntries } from "./logSpread";

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
  const [activeSession, setActiveSession] = useState(null);
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const [loggingItemId, setLoggingItemId] = useState(null);
  const [logMode, setLogMode] = useState("exact"); // exact | range
  const [logDate, setLogDate] = useState(todayISO());
  const [logRangeFrom, setLogRangeFrom] = useState(todayISO());
  const [logRangeTo, setLogRangeTo] = useState(todayISO());
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

  useEffect(() => { loadSessions(); }, []);

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

  function discardDraft(itemId) {
    setEdits((prev) => { const next = { ...prev }; delete next[itemId]; return next; });
  }

  // Nothing above touches real data: drafts live only in memory. This is the
  // only place the edited dates are actually written — new entries are
  // inserted first and the old ones removed only after that succeeds, so a
  // failure never leaves an item with no usage entries at all.
  async function applyAllEdits() {
    setApplyingEdits(true);
    setEditMsg("");
    let applied = 0;
    let failed = 0;
    for (const [itemId, e] of Object.entries(edits)) {
      const it = items.find((i) => i.id === itemId);
      const info = linkedLogs[itemId];
      if (!it || !info || !info.matched) { failed++; continue; }
      const total = Math.round(info.logs.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
      const entries = e.mode === "range" ? buildSpreadEntries(total, e.from, e.to) : [{ date: e.date, amount: total }];
      const note = e.mode === "range"
        ? `Retroactively logged — spread from ${e.from} to ${e.to}, found missing during a physical count.`
        : "Retroactively logged — found missing during a physical count.";
      const { data: inserted, error } = await supabase.from("consumption_logs").insert(entries.map((en) => ({
        reagent_id: it.reagent_id, amount: en.amount, date: en.date, used_by: "Unlogged (physical count)", note,
      }))).select("id");
      if (error || !inserted) { failed++; continue; }
      await supabase.from("consumption_logs").delete().in("id", info.logs.map((l) => l.id));
      const oldDates = info.logs.map((l) => l.date).sort();
      const oldText = oldDates.length > 1 ? `${oldDates[0]} → ${oldDates[oldDates.length - 1]}` : oldDates[0];
      const resNote = e.mode === "range" ? `Logged as usage spread from ${e.from} to ${e.to}` : `Logged as usage on ${e.date}`;
      await supabase.from("inventory_count_items").update({ resolution_note: resNote }).eq("id", itemId);
      // Separate call so the edit still works before ADD_COUNT_LOG_LINKS.sql has been run.
      await supabase.from("inventory_count_items").update({ consumption_log_ids: inserted.map((r) => r.id) }).eq("id", itemId);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "log",
        description: `Stock count edit: ${it.reagent_name} — Lot ${it.lot_number} — ${total} ${it.unit} of unlogged usage re-dated from ${oldText} to ${describeEdit(e)}`,
        performed_by: username,
      });
      applied++;
    }
    const data = await loadItems(activeSession.id);
    await loadLinkedLogs(activeSession, data);
    setEdits({});
    setApplyingEdits(false);
    setEditMsg(failed ? `${applied} updated, ${failed} could not be updated (their usage entries weren't found).` : `${applied} edit${applied === 1 ? "" : "s"} applied.`);
    reload();
  }

  async function startCount() {
    const scope = reagents.filter((r) => !r.deleted && (startDept === "all" || r.department === startDept));
    if (scope.length === 0) return;
    const { data: session, error } = await supabase
      .from("inventory_counts")
      .insert({ department: startDept === "all" ? null : startDept, started_by: username })
      .select()
      .single();
    if (error || !session) return;
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

  async function saveCount(itemId, value) {
    const num = value === "" ? null : Number(value);
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, counted_quantity: num } : it)));
    await supabase.from("inventory_count_items").update({ counted_quantity: num }).eq("id", itemId);
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

  // Mirrors the same auto-remove rule App.jsx's recordConsumption applies on
  // every normal "Log use" entry: once a lot hits 0, hide it from the active
  // list if another lot of the same reagent+device still has stock (it stays
  // visible, marked Critical, only when it's the last one left). That rule
  // lives in App.jsx and never ran for quantity changes made from here, so a
  // lot zeroed out via a physical count silently stayed "active" forever.
  async function autoRemoveIfDepleted(reagentId, newQty) {
    if (newQty > 0) return;
    const reagent = reagents.find((r) => r.id === reagentId);
    if (!reagent) return;
    const hasAlternative = reagents.some((r) => r.id !== reagent.id && r.name === reagent.name && (r.device || "") === (reagent.device || "") && !r.deleted && r.current_quantity > 0);
    if (!hasAlternative) return;
    await supabase.from("reagents").update({
      deleted: true,
      deleted_by: "Auto (lot depleted, alternate lot available)",
      deleted_at: new Date().toISOString(),
    }).eq("id", reagentId);
    await supabase.from("audit_log").insert({
      action: "delete",
      entity: "reagent",
      description: `${reagent.name} — Lot ${reagent.lot_number} (auto-removed, depleted)`,
      performed_by: "System",
    });
  }

  // Records which consumption_logs rows a count line created, so a completed
  // count can find them again for date edits. A separate update so resolving
  // still works before ADD_COUNT_LOG_LINKS.sql has been run.
  async function linkLogs(itemId, created) {
    if (!created || created.length === 0) return;
    await supabase.from("inventory_count_items").update({ consumption_log_ids: created.map((r) => r.id) }).eq("id", itemId);
  }

  async function applyCorrection(item) {
    if (item.reagent_id) {
      await supabase.from("reagents").update({ current_quantity: item.counted_quantity }).eq("id", item.reagent_id);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "reagent",
        description: `${item.reagent_name} — Lot ${item.lot_number} — Physical count adjustment: ${item.expected_quantity} → ${item.counted_quantity}`,
        performed_by: username,
      });
      await autoRemoveIfDepleted(item.reagent_id, item.counted_quantity);
    }
    await supabase.from("inventory_count_items").update({ resolved: true, resolution_note: "Corrected to match count" }).eq("id", item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, resolved: true, resolution_note: "Corrected to match count" } : it)));
    reload();
  }

  // For a shortage specifically: the missing units were genuinely used but
  // never logged. Recording it as a real consumption_logs row (instead of
  // just silently lowering current_quantity) keeps usage-rate analytics,
  // reorder suggestions, and "most used" reports honest. The date is left
  // to the person resolving it — we have no way to know when the units
  // actually went missing, only that they're gone now.
  async function logUnrecordedUsage(item, date) {
    const shortage = Number(item.expected_quantity) - Number(item.counted_quantity);
    if (item.reagent_id) {
      const { data: created } = await supabase.from("consumption_logs").insert({
        reagent_id: item.reagent_id,
        amount: shortage,
        date,
        used_by: "Unlogged (physical count)",
        note: "Retroactively logged — found missing during a physical count.",
      }).select("id");
      await linkLogs(item.id, created);
      await supabase.from("reagents").update({ current_quantity: item.counted_quantity }).eq("id", item.reagent_id);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "reagent",
        description: `${item.reagent_name} — Lot ${item.lot_number} — Physical count found ${shortage} ${item.unit} of unlogged usage, recorded as consumption dated ${date}: ${item.expected_quantity} → ${item.counted_quantity}`,
        performed_by: username,
      });
      await autoRemoveIfDepleted(item.reagent_id, item.counted_quantity);
    }
    const note = `Logged as usage on ${date}`;
    await supabase.from("inventory_count_items").update({ resolved: true, resolution_note: note }).eq("id", item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, resolved: true, resolution_note: note } : it)));
    setLoggingItemId(null);
    reload();
  }

  // Same idea as logUnrecordedUsage, but for when you're confident the
  // shortage built up gradually over a known period rather than on one
  // specific day — spreads it into ~weekly entries so it doesn't show up as
  // one artificial spike in the usage-rate charts.
  async function logUnrecordedUsageSpread(item, fromDate, toDate) {
    const shortage = Number(item.expected_quantity) - Number(item.counted_quantity);
    if (item.reagent_id) {
      const entries = buildSpreadEntries(shortage, fromDate, toDate);
      const { data: created } = await supabase.from("consumption_logs").insert(entries.map((e) => ({
        reagent_id: item.reagent_id,
        amount: e.amount,
        date: e.date,
        used_by: "Unlogged (physical count)",
        note: `Retroactively logged — spread from ${fromDate} to ${toDate}, found missing during a physical count.`,
      }))).select("id");
      await linkLogs(item.id, created);
      await supabase.from("reagents").update({ current_quantity: item.counted_quantity }).eq("id", item.reagent_id);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "reagent",
        description: `${item.reagent_name} — Lot ${item.lot_number} — Physical count found ${shortage} ${item.unit} of unlogged usage, spread as consumption from ${fromDate} to ${toDate}: ${item.expected_quantity} → ${item.counted_quantity}`,
        performed_by: username,
      });
      await autoRemoveIfDepleted(item.reagent_id, item.counted_quantity);
    }
    const note = `Logged as usage spread from ${fromDate} to ${toDate}`;
    await supabase.from("inventory_count_items").update({ resolved: true, resolution_note: note }).eq("id", item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, resolved: true, resolution_note: note } : it)));
    setLoggingItemId(null);
    reload();
  }

  async function dismissDiscrepancy(item) {
    await supabase.from("inventory_count_items").update({ resolved: true, resolution_note: "Kept system value" }).eq("id", item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, resolved: true, resolution_note: "Kept system value" } : it)));
  }

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

  if (view === "list") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: T.text }}>Stock count</h2>
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
          Walk the shelves and count what's actually there, then compare against what the system expects. Start as many sessions as you like — no schedule, no limit.
        </div>

        <div style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 12, boxShadow: T.cardShadow, padding: 16, marginBottom: 24, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select value={startDept} onChange={(e) => setStartDept(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: "9px 12px", fontSize: 14, background: T.cardBg, color: T.text, flex: 1, minWidth: 160 }}>
            <option value="all">Whole lab</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={startCount} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={15} /> Start new count
          </button>
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
                  onClick={() => deleteSession(s)}
                  title="Delete this count (only possible while it's still in progress)"
                  style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 10, padding: "0 12px", color: RED }}
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
        <button onClick={backToList} style={{ background: "none", border: "none", color: T.primary, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>← Back to stock count</button>
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
      <button onClick={backToList} style={{ background: "none", border: "none", color: T.primary, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>← Back to stock count</button>
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
                    <button onClick={() => { setLoggingItemId(it.id); setLogMode("exact"); setLogDate(todayISO()); setLogRangeFrom(todayISO()); setLogRangeTo(todayISO()); }} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Log as unrecorded usage</button>
                    <button onClick={() => applyCorrection(it)} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.text, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600 }}>Correct a logging error</button>
                    <button onClick={() => dismissDiscrepancy(it)} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.textMuted, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600 }}>Keep system value</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => applyCorrection(it)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Apply correction</button>
                    <button onClick={() => dismissDiscrepancy(it)} style={{ background: "none", border: `1px solid ${T.cardBorder}`, color: T.textMuted, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600 }}>Keep system value</button>
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
                      <input type="date" value={edDate} max={todayISO()} onChange={(e) => setEdDate(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                    ) : (
                      <>
                        <input type="date" value={edFrom} max={edTo} onChange={(e) => setEdFrom(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                        <span style={{ fontSize: 12.5, color: T.textMuted }}>to</span>
                        <input type="date" value={edTo} min={edFrom} max={todayISO()} onChange={(e) => setEdTo(e.target.value)} style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }} />
                      </>
                    )}
                    <button onClick={() => saveDraft(it)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Save as draft</button>
                    <button onClick={() => setEditingId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                  </div>
                </div>
              )}

              {isLogging && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.cardBorder}` }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    <button
                      onClick={() => setLogMode("exact")}
                      style={{ background: logMode === "exact" ? T.primary : "none", color: logMode === "exact" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}
                    >
                      Exact date
                    </button>
                    <button
                      onClick={() => setLogMode("range")}
                      style={{ background: logMode === "range" ? T.primary : "none", color: logMode === "range" ? "#fff" : T.textMuted, border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700 }}
                    >
                      Spread over a range
                    </button>
                  </div>

                  {logMode === "exact" ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, color: T.textMuted }}>Best guess for when it was used:</span>
                      <input
                        type="date"
                        value={logDate}
                        max={todayISO()}
                        onChange={(e) => setLogDate(e.target.value)}
                        style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }}
                      />
                      <button onClick={() => logUnrecordedUsage(it, logDate)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Confirm</button>
                      <button onClick={() => setLoggingItemId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5, color: T.textMuted }}>Spread across:</span>
                      <input
                        type="date"
                        value={logRangeFrom}
                        max={logRangeTo}
                        onChange={(e) => setLogRangeFrom(e.target.value)}
                        style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }}
                      />
                      <span style={{ fontSize: 12.5, color: T.textMuted }}>to</span>
                      <input
                        type="date"
                        value={logRangeTo}
                        min={logRangeFrom}
                        max={todayISO()}
                        onChange={(e) => setLogRangeTo(e.target.value)}
                        style={{ border: `1px solid ${T.cardBorder}`, borderRadius: 6, padding: "6px 8px", fontSize: 13, background: T.cardBg, color: T.text }}
                      />
                      <button onClick={() => logUnrecordedUsageSpread(it, logRangeFrom, logRangeTo)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Confirm</button>
                      <button onClick={() => setLoggingItemId(null)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12.5, fontWeight: 600 }}>Cancel</button>
                    </div>
                  )}
                </div>
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
          <button onClick={applyAllEdits} disabled={applyingEdits} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, opacity: applyingEdits ? 0.7 : 1 }}>{applyingEdits ? "Applying…" : "Apply all"}</button>
        </div>
      )}

      {activeSession.status !== "completed" && (
        <button
          onClick={finishSession}
          disabled={unresolvedDiscrepancies.length > 0}
          style={{
            background: unresolvedDiscrepancies.length > 0 ? T.cardBorder : T.primary,
            color: unresolvedDiscrepancies.length > 0 ? T.textMuted : "#fff",
            border: "none", borderRadius: 8, padding: "12px", fontWeight: 700, fontSize: 14, width: "100%",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            cursor: unresolvedDiscrepancies.length > 0 ? "not-allowed" : "pointer",
          }}
        >
          <ClipboardCheck size={16} />
          {unresolvedDiscrepancies.length > 0 ? `Resolve ${unresolvedDiscrepancies.length} discrepanc${unresolvedDiscrepancies.length === 1 ? "y" : "ies"} first` : "Finish session"}
        </button>
      )}
    </div>
  );
}
