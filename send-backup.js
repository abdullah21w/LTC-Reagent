// Runs once a day via Vercel Cron (see vercel.json). Not called by the app itself.
// Checks app_config for automatic-backup settings; if enabled and the configured
// number of days has passed since the last backup, exports every table as JSON
// and emails it as an attachment.

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

    if (!config || !config.backup_enabled || !config.backup_email) {
      return res.status(200).json({ skipped: "Automatic backups are off." });
    }

    const freqDays = config.backup_frequency_days || 7;
    if (config.backup_last_sent) {
      const last = new Date(config.backup_last_sent);
      const today = new Date();
      const daysSince = Math.floor((today - last) / (1000 * 60 * 60 * 24));
      if (daysSince < freqDays) {
        return res.status(200).json({ skipped: `Not due yet (${daysSince}/${freqDays} days).` });
      }
    }

    const tables = ["reagents", "consumption_logs", "reagent_presets", "staff_accounts", "devices", "audit_log", "lot_to_lot_pending"];
    const backup = { exported_at: new Date().toISOString() };
    for (const t of tables) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      backup[t] = await r.json();
    }
    // Config is included without credentials for safety.
    const { owner_username, owner_password, ...safeConfig } = config;
    backup.app_config = safeConfig;

    const jsonStr = JSON.stringify(backup, null, 2);
    const base64 = Buffer.from(jsonStr, "utf-8").toString("base64");
    const filename = `ltc-lab-backup-${new Date().toISOString().slice(0, 10)}.json`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "LTC Lab Inventory <onboarding@resend.dev>",
        to: [config.backup_email],
        subject: `LTC Lab Inventory — automatic backup (${new Date().toISOString().slice(0, 10)})`,
        html: `<p>Attached is your automatic backup covering ${tables.length} tables. Keep it somewhere safe.</p>`,
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
      body: JSON.stringify({ backup_last_sent: new Date().toISOString().slice(0, 10) }),
    });

    return res.status(200).json({ sent: true, tables: tables.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
