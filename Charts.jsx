import React, { useState, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

const inputStyle = { border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 14, boxSizing: "border-box" };
const RED = "#C1432B";
const AMBER = "#B8860B";
const GREEN = "#2F6B4F";
const MUTED = "#8A9694";
const BORDER = "#E1E8E5";

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function dateRange(from, to) {
  const dates = [];
  let d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}
function shortLabel(iso) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

const STAT_VIEWS = [
  { key: "per-reagent", label: "Per-reagent consumption" },
  { key: "waste", label: "Waste ratio" },
];

export default function Charts({ reagents, logs, departments }) {
  const [statView, setStatView] = useState("per-reagent");

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Statistics</h2>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>Pick a statistic to explore.</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
        {STAT_VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setStatView(v.key)}
            style={{
              background: statView === v.key ? "#0F7173" : "#fff",
              color: statView === v.key ? "#fff" : "#516361",
              border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700,
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      {statView === "per-reagent" && <PerReagentView reagents={reagents} logs={logs} />}
      {statView === "waste" && <WasteRatioView reagents={reagents} departments={departments} />}
    </div>
  );
}

function PerReagentView({ reagents, logs }) {
  const names = [...new Set(reagents.map((r) => r.name))].sort();
  const [selected, setSelected] = useState(names[0] || "");
  const [search, setSearch] = useState(names[0] || "");
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(todayISO());

  const suggestions = search.trim() && !names.includes(search) ? names.filter((n) => n.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8) : [];

  function pick(n) {
    setSearch(n);
    setSelected(n);
  }

  const lotsForReagent = useMemo(() => reagents.filter((r) => r.name === selected), [reagents, selected]);
  const lotIds = useMemo(() => new Set(lotsForReagent.map((r) => r.id)), [lotsForReagent]);
  const unit = lotsForReagent[0]?.unit || "";

  const rangeLogs = useMemo(
    () => logs.filter((l) => lotIds.has(l.reagent_id) && !l.deleted && l.date >= dateFrom && l.date <= dateTo),
    [logs, lotIds, dateFrom, dateTo]
  );
  const totalConsumed = rangeLogs.reduce((s, l) => s + l.amount, 0);

  const dailyData = useMemo(() => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return [];
    const days = dateRange(dateFrom, dateTo);
    const arr = days.map((d) => ({ day: shortLabel(d), full: d, amount: 0 }));
    const byDate = {};
    arr.forEach((a) => { byDate[a.full] = a; });
    rangeLogs.forEach((l) => {
      if (byDate[l.date]) byDate[l.date].amount += l.amount;
    });
    return arr;
  }, [rangeLogs, dateFrom, dateTo]);

  const deviceData = useMemo(() => {
    const map = {};
    lotsForReagent.forEach((r) => {
      const dev = r.device || "Unspecified";
      if (!map[dev]) map[dev] = { device: dev, received: 0, consumed: 0 };
      if (r.date_added >= dateFrom && r.date_added <= dateTo) map[dev].received += r.quantity_received;
    });
    rangeLogs.forEach((l) => {
      const lot = lotsForReagent.find((r) => r.id === l.reagent_id);
      const dev = lot?.device || "Unspecified";
      if (!map[dev]) map[dev] = { device: dev, received: 0, consumed: 0 };
      map[dev].consumed += l.amount;
    });
    return Object.values(map);
  }, [lotsForReagent, rangeLogs, dateFrom, dateTo]);

  if (names.length === 0) {
    return <div style={{ textAlign: "center", padding: "60px 20px", color: MUTED, fontSize: 13.5 }}>No reagents logged yet — nothing to chart.</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>Pick a reagent and any date range to see daily usage and how much each device consumed vs received.</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
        <label style={{ flex: 1, minWidth: 180, position: "relative" }}>
          <input style={{ ...inputStyle, width: "100%" }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reagent…" autoComplete="off" />
          {suggestions.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #C7D1CE", borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.12)" }}>
              {suggestions.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => pick(n)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #EEF2F0", padding: "10px 12px", fontSize: 14 }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
        </label>
        <span style={{ fontSize: 12, color: MUTED }}>From</span>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ fontSize: 12, color: MUTED }}>To</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} />
      </div>

      {lotsForReagent.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: MUTED, fontSize: 13.5 }}>No matching reagent — pick one from the list.</div>
      ) : dateFrom > dateTo ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: RED, fontSize: 13.5 }}>"From" date must be before "To" date.</div>
      ) : (
        <>
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase" }}>Total consumed — {dateFrom} to {dateTo}</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{totalConsumed} <span style={{ fontSize: 14, fontWeight: 500 }}>{unit}</span></div>
          </div>

          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>DAILY CONSUMPTION</div>
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, marginBottom: 26 }}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="day" fontSize={11} stroke={MUTED} interval="preserveStartEnd" />
                <YAxis fontSize={11} stroke={MUTED} />
                <Tooltip formatter={(v) => [`${v} ${unit}`, "Consumed"]} labelFormatter={(d, p) => (p && p[0] ? p[0].payload.full : d)} />
                <Bar dataKey="amount" fill="#0F7173" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>BY DEVICE — {dateFrom} to {dateTo}</div>
          <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={deviceData}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="device" fontSize={11} stroke={MUTED} />
                <YAxis fontSize={11} stroke={MUTED} />
                <Tooltip formatter={(v, n) => [`${v} ${unit}`, n]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="consumed" name="Consumed" fill={RED} radius={[4, 4, 0, 0]} />
                <Bar dataKey="received" name="Received" fill={GREEN} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

// A lot counts as "wasted" only when it was explicitly discarded as expired
// (discard_reason === "Expired") — damaged/contaminated/other discards are a
// different problem, not a demand-planning one.
//
// The lab-wide and per-department ratios are computed by LOT COUNT
// (unit-agnostic) since a department spans reagents with different units
// (box/piece/bottle) that can't be summed. The per-reagent ratio is the only
// one computed by QUANTITY, since a single reagent's lots always share one
// unit — and discarding never zeroes current_quantity, so it still holds
// exactly what was left over at the moment of discard.
function WasteRatioView({ reagents, departments }) {
  const [detailLevel, setDetailLevel] = useState("department"); // department | reagent
  const [deptFilter, setDeptFilter] = useState("");
  const today = todayISO();

  // Lab-wide numbers always use the full, unfiltered list.
  const totalLots = reagents.length;
  const wastedLots = reagents.filter((r) => r.discard_reason === "Expired");
  const wasteRatio = totalLots ? (wastedLots.length / totalLots) * 100 : 0;
  const notYetDiscarded = reagents.filter((r) => !r.deleted && r.expiry_date && r.expiry_date < today && r.current_quantity > 0);

  const monthlyData = useMemo(() => {
    const map = {};
    wastedLots.forEach((r) => {
      if (!r.deleted_at) return;
      const month = r.deleted_at.slice(0, 7);
      map[month] = (map[month] || 0) + 1;
    });
    const months = [];
    const cursor = new Date();
    cursor.setDate(1);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(cursor);
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push({ month: d.toLocaleDateString("en-US", { month: "short" }), full: key, wasted: map[key] || 0 });
    }
    return months;
  }, [wastedLots]);

  const byDepartment = useMemo(() => {
    const map = {};
    reagents.forEach((r) => {
      const dept = r.department || "Unspecified";
      if (!map[dept]) map[dept] = { name: dept, lotsReceived: 0, lotsWasted: 0 };
      map[dept].lotsReceived += 1;
      if (r.discard_reason === "Expired") map[dept].lotsWasted += 1;
    });
    return Object.values(map)
      .map((d) => ({ ...d, pct: d.lotsReceived ? (d.lotsWasted / d.lotsReceived) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }, [reagents]);

  const byReagent = useMemo(() => {
    const scoped = deptFilter ? reagents.filter((r) => r.department === deptFilter) : reagents;
    const map = {};
    scoped.forEach((r) => {
      if (!map[r.name]) map[r.name] = { name: r.name, department: r.department, unit: r.unit, lotsReceived: 0, lotsWasted: 0, qtyReceived: 0, qtyWasted: 0 };
      const row = map[r.name];
      row.lotsReceived += 1;
      row.qtyReceived += Number(r.quantity_received || 0);
      if (r.discard_reason === "Expired") {
        row.lotsWasted += 1;
        row.qtyWasted += Number(r.current_quantity || 0);
      }
    });
    return Object.values(map)
      .filter((r) => r.lotsWasted > 0)
      .map((r) => ({ ...r, pct: r.qtyReceived ? (r.qtyWasted / r.qtyReceived) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }, [reagents, deptFilter]);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 20 }}>
        How much of what's ever been received expired before it could be fully used — based on lots discarded specifically as "Expired" (damaged/contaminated discards aren't counted here, that's a different problem).
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase" }}>Expired unused — whole lab</div>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: wasteRatio > 5 ? RED : wasteRatio > 0 ? AMBER : GREEN }}>{wasteRatio.toFixed(1)}%</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{wastedLots.length} of {totalLots} lots ever received</div>
        </div>
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: "uppercase" }}>Not yet discarded</div>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: notYetDiscarded.length > 0 ? AMBER : GREEN }}>{notYetDiscarded.length}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>expired on the calendar, still sitting in the system</div>
        </div>
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>WASTED LOTS PER MONTH — WHOLE LAB</div>
      <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, marginBottom: 26 }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={monthlyData}>
            <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
            <XAxis dataKey="month" fontSize={11} stroke={MUTED} />
            <YAxis fontSize={11} stroke={MUTED} allowDecimals={false} />
            <Tooltip formatter={(v) => [`${v} lot${v === 1 ? "" : "s"}`, "Wasted"]} />
            <Bar dataKey="wasted" fill={AMBER} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.3 }}>BREAK DOWN BY</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setDetailLevel("department")}
            style={{ background: detailLevel === "department" ? "#0F7173" : "#fff", color: detailLevel === "department" ? "#fff" : "#516361", border: `1px solid ${BORDER}`, borderRadius: 7, padding: "6px 12px", fontSize: 12.5, fontWeight: 700 }}
          >
            Department
          </button>
          <button
            onClick={() => setDetailLevel("reagent")}
            style={{ background: detailLevel === "reagent" ? "#0F7173" : "#fff", color: detailLevel === "reagent" ? "#fff" : "#516361", border: `1px solid ${BORDER}`, borderRadius: 7, padding: "6px 12px", fontSize: 12.5, fontWeight: 700 }}
          >
            Reagent
          </button>
        </div>
      </div>

      {detailLevel === "department" ? (
        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: MUTED, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3, background: "#F7F9F8" }}>
                <th style={{ padding: "10px 12px" }}>Department</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Lots received</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Lots wasted</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>% wasted</th>
              </tr>
            </thead>
            <tbody>
              {byDepartment.map((d) => (
                <tr key={d.name} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={{ padding: "9px 12px", fontWeight: 600 }}>{d.name}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", color: MUTED }}>{d.lotsReceived}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", color: MUTED }}>{d.lotsWasted}</td>
                  <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, color: d.pct > 5 ? RED : d.pct > 0 ? AMBER : GREEN }}>{d.pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {departments && departments.length > 0 && (
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ ...inputStyle, marginBottom: 12, minWidth: 200 }}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {byReagent.length === 0 ? (
            <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 20, textAlign: "center", color: MUTED, fontSize: 13.5 }}>
              Nothing has been discarded as expired{deptFilter ? ` in ${deptFilter}` : ""} — no waste on record.
            </div>
          ) : (
            <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: MUTED, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.3, background: "#F7F9F8" }}>
                    <th style={{ padding: "10px 12px" }}>Reagent</th>
                    <th style={{ padding: "10px 12px" }}>Department</th>
                    <th style={{ padding: "10px 12px", textAlign: "right" }}>Lots received</th>
                    <th style={{ padding: "10px 12px", textAlign: "right" }}>Lots wasted</th>
                    <th style={{ padding: "10px 12px", textAlign: "right" }}>Qty wasted</th>
                    <th style={{ padding: "10px 12px", textAlign: "right" }}>% wasted</th>
                  </tr>
                </thead>
                <tbody>
                  {byReagent.map((r) => (
                    <tr key={r.name} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <td style={{ padding: "9px 12px", fontWeight: 600 }}>{r.name}</td>
                      <td style={{ padding: "9px 12px", color: MUTED }}>{r.department}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: MUTED }}>{r.lotsReceived}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", color: MUTED }}>{r.lotsWasted}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{r.qtyWasted} {r.unit}</td>
                      <td style={{ padding: "9px 12px", textAlign: "right", fontWeight: 700, color: r.pct > 20 ? RED : AMBER }}>{r.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
