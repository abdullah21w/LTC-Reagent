// Runs once a day via Vercel Cron (see vercel.json). Not called by the app itself.
// If monthly reports are enabled and a new calendar month has started since the
// last one sent, builds last month's PDF report and emails it.

import { buildMonthlyReport } from "./_reportBuilder.js";

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || "";
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "Missing Supabase env vars." });
  if (!RESEND_API_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY env var." });

  try {
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?id=eq.1&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const configRows = await configRes.json();
    const config = configRows && configRows[0];

    if (!config || !config.monthly_report_enabled || !config.monthly_report_email) {
      return res.status(200).json({ skipped: "Monthly reports are off." });
    }

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (config.monthly_report_last_sent === currentMonthKey) {
      return res.status(200).json({ skipped: "Already sent for this month." });
    }

    // Report covers the previous full calendar month.
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = prev.getFullYear();
    const month = prev.getMonth() + 1;

    const { buffer, monthLabel } = await buildMonthlyReport({ SUPABASE_URL, SUPABASE_KEY, year, month });
    const base64 = buffer.toString("base64");
    const filename = `LTC-Lab-Report-${monthLabel.replace(" ", "-")}.pdf`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "LTC Lab Inventory <onboarding@resend.dev>",
        to: [config.monthly_report_email],
        subject: `LTC Lab Inventory — Monthly Report (${monthLabel})`,
        html: `<p>Attached is the inventory report for ${monthLabel}.</p>`,
        attachments: [{ filename, content: base64 }],
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      return res.status(500).json({ error: "Resend failed", detail: errText });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/app_config?id=eq.1`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ monthly_report_last_sent: currentMonthKey }),
    });

    return res.status(200).json({ sent: true, month: monthLabel });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
