import React, { useState, useEffect, useRef } from "react";
import { ClipboardCheck, ScanLine, Search, Check, X, ChevronRight, AlertTriangle, Plus, RotateCcw } from "lucide-react";
import { supabase } from "./supabaseClient";
import BarcodeScanner from "./BarcodeScanner";

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

export default function StockCount({ reagents, departments, username, reload }) {
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
  const [logDate, setLogDate] = useState(todayISO());
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
    await loadItems(session.id);
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

  async function applyCorrection(item) {
    if (item.reagent_id) {
      await supabase.from("reagents").update({ current_quantity: item.counted_quantity }).eq("id", item.reagent_id);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "reagent",
        description: `${item.reagent_name} — Lot ${item.lot_number} — Physical count adjustment: ${item.expected_quantity} → ${item.counted_quantity}`,
        performed_by: username,
      });
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
      await supabase.from("consumption_logs").insert({
        reagent_id: item.reagent_id,
        amount: shortage,
        date,
        used_by: "Unlogged (physical count)",
        note: "Retroactively logged — found missing during a physical count.",
      });
      await supabase.from("reagents").update({ current_quantity: item.counted_quantity }).eq("id", item.reagent_id);
      await supabase.from("audit_log").insert({
        action: "edit",
        entity: "reagent",
        description: `${item.reagent_name} — Lot ${item.lot_number} — Physical count found ${shortage} ${item.unit} of unlogged usage, recorded as consumption dated ${date}: ${item.expected_quantity} → ${item.counted_quantity}`,
        performed_by: username,
      });
    }
    const note = `Logged as usage on ${date}`;
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
    setActiveSession((s) => ({ ...s, status: "completed" }));
    loadSessions();
  }

  function backToList() {
    setView("list");
    setActiveSession(null);
    setItems([]);
    setSearch("");
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
            <button
              key={s.id}
              onClick={() => resumeCount(s)}
              style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 10, padding: "12px 16px", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}
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
                      <div style={{ fontSize: 11.5, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>Lot {it.lot_number} · expected {it.expected_quantity} {it.unit}</div>
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
          return (
            <div key={it.id} style={{ background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderLeft: `4px solid ${AMBER}`, borderRadius: 8, padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>{it.reagent_name}</div>
                  <div style={{ fontSize: 11.5, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace" }}>Lot {it.lot_number} · {it.department}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12.5, color: T.textMuted }}>System said <b style={{ color: T.text }}>{it.expected_quantity}</b></div>
                  <div style={{ fontSize: 12.5, color: over ? GREEN : RED, fontWeight: 700 }}>You counted {it.counted_quantity}</div>
                </div>
                {it.resolved ? (
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: GREEN, background: "#E8F2EC", borderRadius: 6, padding: "4px 10px" }}>{it.resolution_note}</span>
                ) : shortage ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => { setLoggingItemId(it.id); setLogDate(todayISO()); }} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 700 }}>Log as unrecorded usage</button>
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

              {isLogging && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.cardBorder}`, flexWrap: "wrap" }}>
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
              <div key={it.id} style={{ fontSize: 13, color: T.textMuted, padding: "6px 4px", borderBottom: `1px solid ${T.cardBorder}` }}>{it.reagent_name} — Lot {it.lot_number}</div>
            ))}
          </div>
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
