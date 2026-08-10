// Shared logic for building the monthly PDF report. Used by both
// /api/generate-report.js (on-demand download) and
// /api/send-monthly-report.js (automatic monthly email).
//
// Built with @react-pdf/renderer instead of raw pdfkit: pages auto-paginate
// (no more manual doc.y > N checks), the header/footer repeat on every page
// via the `fixed` prop, and layout is real flexbox instead of hand-placed
// x/y coordinates. No JSX here on purpose — this file ships to a Vercel
// Node function as plain .js, so it's written with React.createElement to
// avoid depending on a JSX transform being available at build time.

import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

const h = React.createElement;

const TEAL = "#0F7173";
const NAVY = "#1B2B2E";
const MUTED = "#7B8E8A";
const RED = "#C1432B";
const AMBER = "#B8860B";
const GREEN = "#2F6B4F";
const BORDER = "#E1E8E5";
const STRIPE = "#F7F9F8";

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontSize: 9, fontFamily: "Helvetica", color: NAVY },

  headerBrand: { fontSize: 18, fontFamily: "Helvetica-Bold", color: TEAL },
  headerTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", color: NAVY, marginTop: 2 },
  headerMeta: { fontSize: 8.5, color: MUTED, marginTop: 2 },
  headerRule: { borderBottomWidth: 1, borderBottomColor: BORDER, marginTop: 10, marginBottom: 16 },

  footer: {
    position: "absolute", bottom: 24, left: 40, right: 40,
    flexDirection: "row", justifyContent: "space-between",
    borderTopWidth: 1, borderTopColor: BORDER, paddingTop: 6,
    fontSize: 7.5, color: MUTED,
  },

  statRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 18 },
  statCard: {
    width: "31.5%", marginRight: "2.75%", marginBottom: 10,
    backgroundColor: STRIPE, borderWidth: 1, borderColor: BORDER, borderRadius: 5,
    padding: 10,
  },
  statValue: { fontSize: 17, fontFamily: "Helvetica-Bold" },
  statLabel: { fontSize: 7.5, color: MUTED, marginTop: 3 },

  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 11, fontFamily: "Helvetica-Bold", color: NAVY,
    borderBottomWidth: 1, borderBottomColor: BORDER, paddingBottom: 4, marginBottom: 8,
  },
  emptyNote: { fontSize: 9, color: MUTED, fontStyle: "italic" },

  tableHeadRow: { flexDirection: "row", backgroundColor: NAVY, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 6, marginBottom: 2 },
  tableHeadCell: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 0.4 },
  tableRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 6, borderRadius: 3 },
  tableRowStripe: { backgroundColor: STRIPE },
  cell: { fontSize: 9 },

  footerText: { fontSize: 8, color: MUTED, textAlign: "center", marginTop: 8 },
});

function daysBetween(dateStr, fromStr) {
  const d = new Date(dateStr);
  const f = new Date(fromStr);
  return Math.round((d - f) / (1000 * 60 * 60 * 24));
}

async function fetchTable(SUPABASE_URL, SUPABASE_KEY, table, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

function Table({ columns, rows }) {
  return h(View, null,
    h(View, { style: styles.tableHeadRow },
      columns.map((c, i) => h(Text, { key: i, style: [styles.tableHeadCell, { width: c.width }] }, c.label))
    ),
    rows.map((row, ri) =>
      h(View, { key: ri, style: [styles.tableRow, ri % 2 === 1 && styles.tableRowStripe] },
        columns.map((c, ci) => h(Text, {
          key: ci,
          style: [styles.cell, { width: c.width, color: c.color ? c.color(row) : NAVY, fontFamily: c.bold ? "Helvetica-Bold" : "Helvetica" }],
        }, c.value(row)))
      )
    )
  );
}

function Section(title, body) {
  return h(View, { style: styles.section },
    h(Text, { style: styles.sectionTitle }, title),
    body
  );
}

export async function buildMonthlyReport({ SUPABASE_URL, SUPABASE_KEY, year, month }) {
  // month is 1-12
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonthDate = new Date(year, month, 1); // month is 1-based, so this rolls to next month
  const monthEnd = nextMonthDate.toISOString().slice(0, 10);
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const today = new Date().toISOString().slice(0, 10);

  const [config, reagents, logs] = await Promise.all([
    fetchTable(SUPABASE_URL, SUPABASE_KEY, "app_config", "&id=eq.1").then((r) => r[0] || {}),
    fetchTable(SUPABASE_URL, SUPABASE_KEY, "reagents"),
    fetchTable(SUPABASE_URL, SUPABASE_KEY, "consumption_logs"),
  ]);

  const warnDays = config.expiry_warning_days || 30;
  const active = reagents.filter((r) => !r.deleted);

  const criticalNow = active.filter((r) => r.current_quantity <= 0 || (r.expiry_date && daysBetween(r.expiry_date, today) < 0));
  const lowStockNow = active.filter((r) => r.current_quantity > 0 && r.current_quantity <= r.low_stock_threshold);
  const expiringSoonNow = active.filter((r) => r.expiry_date && daysBetween(r.expiry_date, today) >= 0 && daysBetween(r.expiry_date, today) <= warnDays);

  const logsThisMonth = logs.filter((l) => !l.deleted && l.date >= monthStart && l.date < monthEnd);
  const discardsThisMonth = reagents.filter((r) => r.discard_reason && r.deleted_at && r.deleted_at.slice(0, 10) >= monthStart && r.deleted_at.slice(0, 10) < monthEnd);
  const receivedThisMonth = reagents.filter((r) => r.date_added >= monthStart && r.date_added < monthEnd);

  const reagentById = {};
  reagents.forEach((r) => { reagentById[r.id] = r; });

  const mostUsedMap = {};
  logsThisMonth.forEach((l) => {
    const r = reagentById[l.reagent_id];
    const name = r ? r.name : "Unknown";
    const unit = r ? r.unit : "";
    if (!mostUsedMap[name]) mostUsedMap[name] = { qty: 0, unit };
    mostUsedMap[name].qty += Number(l.amount || 0);
  });
  const mostUsed = Object.entries(mostUsedMap)
    .map(([name, v]) => ({ name, qty: v.qty, unit: v.unit }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  // Unified alert list: critical items first (out of stock / expired), then
  // expiring-soon, then low-stock — so the report reads most-urgent-first
  // instead of the three states being scattered or, in critical's case,
  // counted on a stat card but never actually listed anywhere.
  const attentionRows = [
    ...criticalNow.map((r) => ({
      type: "Critical", color: RED, name: r.name, lot: r.lot_number,
      issue: r.current_quantity <= 0 ? "Out of stock" : `Expired ${Math.abs(daysBetween(r.expiry_date, today))}d ago`,
    })),
    ...expiringSoonNow.map((r) => ({
      type: "Expiring", color: AMBER, name: r.name, lot: r.lot_number,
      issue: `Expires in ${daysBetween(r.expiry_date, today)}d`,
    })),
    ...lowStockNow.map((r) => ({
      type: "Low stock", color: AMBER, name: r.name, lot: r.lot_number,
      issue: `${r.current_quantity} ${r.unit} left (min ${r.low_stock_threshold})`,
    })),
  ];

  const stats = [
    { label: "Active reagents", value: active.length, color: TEAL },
    { label: "Critical now", value: criticalNow.length, color: RED },
    { label: "Low stock now", value: lowStockNow.length, color: AMBER },
    { label: "Used this month", value: logsThisMonth.length, color: TEAL },
    { label: "Discarded this month", value: discardsThisMonth.length, color: AMBER },
    { label: "Received this month", value: receivedThisMonth.length, color: GREEN },
  ];

  const doc = h(Document, null,
    h(Page, { size: "A4", style: styles.page, wrap: true },
      // Header — fixed so it repeats on every page
      h(View, { fixed: true },
        h(Text, { style: styles.headerBrand }, "LTC Lab Inventory"),
        h(Text, { style: styles.headerTitle }, `Monthly Report — ${monthLabel}`),
        h(Text, { style: styles.headerMeta }, `Generated on ${today}`),
        h(View, { style: styles.headerRule })
      ),

      // Stat cards
      h(View, { style: styles.statRow },
        stats.map((s, i) => h(View, { key: i, style: styles.statCard },
          h(Text, { style: [styles.statValue, { color: s.color }] }, String(s.value)),
          h(Text, { style: styles.statLabel }, s.label)
        ))
      ),

      // Needs attention (critical + expiring + low stock, most urgent first)
      Section("Needs Attention",
        attentionRows.length === 0
          ? h(Text, { style: styles.emptyNote }, "Nothing critical, expiring, or low on stock right now.")
          : h(Table, {
              columns: [
                { label: "Type", width: "15%", value: (r) => r.type, color: (r) => r.color, bold: true },
                { label: "Reagent", width: "35%", value: (r) => r.name },
                { label: "Lot", width: "20%", value: (r) => r.lot },
                { label: "Issue", width: "30%", value: (r) => r.issue, color: (r) => r.color },
              ],
              rows: attentionRows,
            })
      ),

      // Most used
      Section("Most Used This Month",
        mostUsed.length === 0
          ? h(Text, { style: styles.emptyNote }, "No consumption logged this month.")
          : h(Table, {
              columns: [
                { label: "Reagent", width: "70%", value: (r) => r.name },
                { label: "Total used", width: "30%", value: (r) => `${r.qty} ${r.unit}`, bold: true },
              ],
              rows: mostUsed,
            })
      ),

      // Discarded
      Section("Discarded This Month",
        discardsThisMonth.length === 0
          ? h(Text, { style: styles.emptyNote }, "Nothing discarded this month.")
          : h(Table, {
              columns: [
                { label: "Reagent", width: "30%", value: (r) => r.name },
                { label: "Lot", width: "20%", value: (r) => r.lot_number },
                { label: "Reason", width: "30%", value: (r) => r.discard_reason || "—" },
                { label: "By", width: "20%", value: (r) => r.deleted_by || "—" },
              ],
              rows: discardsThisMonth,
            })
      ),

      // Received
      Section("Received This Month",
        receivedThisMonth.length === 0
          ? h(Text, { style: styles.emptyNote }, "Nothing received this month.")
          : h(Table, {
              columns: [
                { label: "Reagent", width: "35%", value: (r) => r.name },
                { label: "Lot", width: "25%", value: (r) => r.lot_number },
                { label: "Qty", width: "20%", value: (r) => `${r.quantity_received} ${r.unit}` },
                { label: "Date", width: "20%", value: (r) => r.date_added },
              ],
              rows: receivedThisMonth,
            })
      ),

      // Footer — fixed, repeats on every page with live page numbers
      h(View, { style: styles.footer, fixed: true },
        h(Text, null, "Automated report from LTC Lab Inventory"),
        h(Text, { render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` })
      )
    )
  );

  const buffer = await renderToBuffer(doc);
  return { buffer, monthLabel };
}
