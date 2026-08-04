// Called by the app (Login screen) right after the Owner's username/password
// are verified, if two-factor auth is enabled. Generates a 6-digit code,
// stores it (with a 10-minute expiry) in app_config, and emails it.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "Missing Supabase env vars." });
  if (!RESEND_API_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY env var." });

  try {
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?id=eq.1&select=owner_2fa_enabled,owner_2fa_email`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const configRows = await configRes.json();
    const config = configRows && configRows[0];

    if (!config || !config.owner_2fa_enabled || !config.owner_2fa_email) {
      return res.status(400).json({ error: "Two-factor authentication is not enabled." });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/app_config?id=eq.1`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ owner_2fa_code: code, owner_2fa_code_expires: expires }),
    });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "LTC Lab Inventory <onboarding@resend.dev>",
        to: [config.owner_2fa_email],
        subject: `Your sign-in code: ${code}`,
        html: `<p>Your LTC Lab Inventory sign-in code is:</p><h2 style="letter-spacing:4px;">${code}</h2><p>This code expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p>`,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      return res.status(500).json({ error: "Resend failed", detail: errText });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
