// Lets anyone with the app link download the monthly report PDF directly,
// e.g. from a "Download this month's report" button in the app.
// Optional query params: ?year=2026&month=7 (defaults to the current month).

import { buildMonthlyReport } from "./_reportBuilder.js";

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase env vars." });
  }

  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;

    const { buffer, monthLabel } = await buildMonthlyReport({ SUPABASE_URL, SUPABASE_KEY, year, month });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="LTC-Lab-Report-${monthLabel.replace(" ", "-")}.pdf"`);
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
