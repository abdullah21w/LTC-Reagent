// Shared logic for building the monthly PDF report. Used by both
// /api/generate-report.js (on-demand download) and
// /api/send-monthly-report.js (automatic monthly email).

import PDFDocument from "pdfkit";

const TEAL = "#0F7173";
const NAVY = "#1B2B2E";
const MUTED = "#7B8E8A";
const RED = "#C1432B";
const AMBER = "#B8860B";
const GREEN = "#2F6B4F";
const BORDER = "#E1E8E5";

async function fetchTable(SUPABASE_URL, SUPABASE_KEY, table, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

function daysBetween(dateStr, fromStr) {
  const d = new Date(dateStr);
  const f = new Date(fromStr);
  return Math.round((d - f) / (1000 * 60 * 60 * 24));
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

  // ---- Build the PDF ----
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  function sectionTitle(text) {
    doc.moveDown(0.6);
    doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(text);
    doc.moveTo(doc.x, doc.y + 2).lineTo(555, doc.y + 2).strokeColor(BORDER).stroke();
    doc.moveDown(0.5);
  }

  function row(cells, widths, opts = {}) {
    const startX = 40;
    const y = doc.y;
    doc.fontSize(opts.size || 9).font(opts.bold ? "Helvetica-Bold" : "Helvetica").fillColor(opts.color || NAVY);
    let x = startX;
    cells.forEach((c, i) => {
      doc.text(String(c), x, y, { width: widths[i], continued: false });
      x += widths[i];
    });
    doc.moveDown(0.3);
  }

  // Header
  doc.fillColor(TEAL).fontSize(20).font("Helvetica-Bold").text("LTC Lab Inventory", { align: "left" });
  doc.fillColor(NAVY).fontSize(15).font("Helvetica-Bold").text(`Monthly Report — ${monthLabel}`);
  doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(`Generated on ${today}`);
  doc.moveDown(1);

  // Summary cards (simple boxed numbers)
  const stats = [
    { label: "Active reagents", value: active.length, color: TEAL },
    { label: "Critical now", value: criticalNow.length, color: RED },
    { label: "Low stock now", value: lowStockNow.length, color: AMBER },
    { label: "Used this month", value: logsThisMonth.length, color: TEAL },
    { label: "Discarded this month", value: discardsThisMonth.length, color: AMBER },
    { label: "Received this month", value: receivedThisMonth.length, color: GREEN },
  ];
  const boxW = 82, boxH = 50, gap = 8;
  let bx = 40, by = doc.y;
  stats.forEach((s, i) => {
    if (i === 3) { bx = 40; by += boxH + gap; }
    doc.roundedRect(bx, by, boxW, boxH, 6).fillAndStroke("#F7F9F8", BORDER);
    doc.fillColor(s.color).fontSize(18).font("Helvetica-Bold").text(String(s.value), bx + 8, by + 8, { width: boxW - 16 });
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica").text(s.label, bx + 8, by + 30, { width: boxW - 16 });
    bx += boxW + gap;
  });
  doc.y = by + boxH + 10;
  doc.x = 40;

  // Most used
  sectionTitle("Most Used This Month");
  if (mostUsed.length === 0) {
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("No consumption logged this month.");
  } else {
    row(["Reagent", "Total used"], [400, 115], { bold: true, color: MUTED });
    mostUsed.forEach((m) => row([m.name, `${m.qty} ${m.unit}`], [400, 115]));
  }

  // Alerts
  sectionTitle("Needs Attention");
  if (expiringSoonNow.length === 0 && lowStockNow.length === 0) {
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("Nothing currently expiring soon or low on stock.");
  } else {
    row(["Reagent", "Lot", "Issue"], [220, 140, 155], { bold: true, color: MUTED });
    expiringSoonNow.slice(0, 15).forEach((r) => row([r.name, r.lot_number, `Expires in ${daysBetween(r.expiry_date, today)}d`], [220, 140, 155], { color: AMBER }));
    lowStockNow.slice(0, 15).forEach((r) => row([r.name, r.lot_number, `Low stock (${r.current_quantity} left)`], [220, 140, 155], { color: AMBER }));
  }

  // Discard log
  sectionTitle("Discarded This Month");
  if (discardsThisMonth.length === 0) {
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("Nothing discarded this month.");
  } else {
    row(["Reagent", "Lot", "Reason", "By"], [170, 110, 140, 95], { bold: true, color: MUTED });
    discardsThisMonth.forEach((r) => row([r.name, r.lot_number, r.discard_reason || "", r.deleted_by || ""], [170, 110, 140, 95]));
  }

  // Received log
  if (doc.y > 680) doc.addPage();
  sectionTitle("Received This Month");
  if (receivedThisMonth.length === 0) {
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text("Nothing received this month.");
  } else {
    row(["Reagent", "Lot", "Qty", "Date"], [200, 130, 90, 95], { bold: true, color: MUTED });
    receivedThisMonth.forEach((r) => row([r.name, r.lot_number, `${r.quantity_received} ${r.unit}`, r.date_added], [200, 130, 90, 95]));
  }

  doc.moveDown(1.5);
  doc.fillColor(MUTED).fontSize(8).font("Helvetica").text("Automated report from LTC Lab Inventory.", { align: "center" });

  doc.end();
  const buffer = await done;
  return { buffer, monthLabel };
}
