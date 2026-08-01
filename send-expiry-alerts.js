// Runs once a day via Vercel Cron (see vercel.json). Not called by the app itself.
// Reads app_config for the alert email + alert day thresholds, finds every active
// reagent whose days-until-expiry exactly matches one of those thresholds today,
// and sends ONE combined email listing all of them.

export default async function handler(req, res) {
  // Vercel signs its own cron requests with this header — reject anything else
  // so a random visitor can't trigger emails by hitting the URL.
  const authHeader = req.headers.authorization || "";
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing Supabase env vars." });
  }
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: "Missing RESEND_API_KEY env var." });
  }

  try {
    // 1. Load config (alert email + day thresholds)
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?id=eq.1&select=alert_email,expiry_alert_days`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const configRows = await configRes.json();
    const config = configRows && configRows[0];

    if (!config || !config.alert_email) {
      return res.status(200).json({ skipped: "No alert email configured." });
    }
    const alertDays = Array.isArray(config.expiry_alert_days) && config.expiry_alert_days.length ? config.expiry_alert_days : [3, 1];

    // 2. Load active reagents
    const reagentsRes = await fetch(`${SUPABASE_URL}/rest/v1/reagents?deleted=eq.false&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const reagents = await reagentsRes.json();

    // 3. Find today's exact matches
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const matches = [];
    for (const r of reagents) {
      if (!r.expiry_date || r.current_quantity <= 0) continue;
      const expiry = new Date(r.expiry_date);
      expiry.setHours(0, 0, 0, 0);
      const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
      if (alertDays.includes(daysLeft)) {
        matches.push({ ...r, daysLeft });
      }
    }

    if (matches.length === 0) {
      return res.status(200).json({ skipped: "No reagents hit an alert point today." });
    }

    matches.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));

    // 4. Build and send one combined email
    const rows = matches
      .map(
        (r) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #E1E8E5;">${escapeHtml(r.name)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #E1E8E5;">${escapeHtml(r.device || "—")}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #E1E8E5;">${escapeHtml(r.lot_number)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #E1E8E5;">${escapeHtml(r.expiry_date)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #E1E8E5;font-weight:700;color:${r.daysLeft <= 1 ? "#C1432B" : "#B8860B"};">${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}</td>
        </tr>`
      )
      .join("");

    const html = `
      <div style="font-family:sans-serif;color:#1B2B2E;max-width:640px;">
        <h2 style="color:#0F7173;">LTC Lab Inventory — Expiry Alert</h2>
        <p>${matches.length} reagent lot(s) reached an alert point today:</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px;">
          <thead>
            <tr style="background:#F0F3F2;text-align:left;">
              <th style="padding:8px 10px;">Reagent</th>
              <th style="padding:8px 10px;">Device</th>
              <th style="padding:8px 10px;">Lot</th>
              <th style="padding:8px 10px;">Expiry date</th>
              <th style="padding:8px 10px;">Days left</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#7B8E8A;font-size:12px;margin-top:20px;">Automated message from LTC Lab Inventory.</p>
      </div>`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "LTC Lab Inventory <onboarding@resend.dev>",
        to: [config.alert_email],
        subject: `Expiry alert — ${matches.length} reagent(s) need attention`,
        html,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      return res.status(500).json({ error: "Resend failed", detail: errText });
    }

    return res.status(200).json({ sent: matches.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
