import React, { useState } from "react";
import { Beaker, Lock, ShieldCheck } from "lucide-react";
import { supabase } from "./supabaseClient";
import { verifyPassword, hashPassword, isHashed } from "./passwordUtils";

export default function Login({ config, staffAccounts, onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  // Two-factor step (Owner only, when enabled)
  const [awaiting2fa, setAwaiting2fa] = useState(false);
  const [code, setCode] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    setError("");

    if (username === config.owner_username && (await verifyPassword(password, config.owner_password))) {
      if (!isHashed(config.owner_password)) {
        const newHash = await hashPassword(password);
        await supabase.from("app_config").update({ owner_password: newHash }).eq("id", 1);
      }
      if (config.owner_2fa_enabled && config.owner_2fa_email) {
        try {
          const res = await fetch("/api/send-2fa-code", { method: "POST" });
          if (!res.ok) throw new Error("send failed");
          setAwaiting2fa(true);
          setChecking(false);
        } catch {
          setChecking(false);
          setError("Could not send the sign-in code. Try again in a moment.");
        }
        return;
      }
      onLogin("owner", username, null, null);
      return;
    }

    for (const s of staffAccounts || []) {
      if (s.username === username && (await verifyPassword(password, s.password))) {
        if (!isHashed(s.password)) {
          const newHash = await hashPassword(password);
          await supabase.from("staff_accounts").update({ password: newHash }).eq("id", s.id);
        }
        onLogin("staff", username, s.permissions || {}, s.id);
        return;
      }
    }

    setChecking(false);
    setError("Incorrect username or password.");
  }

  async function submitCode(e) {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    setError("");

    const { data } = await supabase.from("app_config").select("owner_2fa_code,owner_2fa_code_expires").eq("id", 1).maybeSingle();
    const validCode = data && data.owner_2fa_code && data.owner_2fa_code === code.trim();
    const notExpired = data && data.owner_2fa_code_expires && new Date(data.owner_2fa_code_expires) > new Date();

    if (validCode && notExpired) {
      await supabase.from("app_config").update({ owner_2fa_code: null, owner_2fa_code_expires: null }).eq("id", 1);
      onLogin("owner", username, null, null);
      return;
    }

    setChecking(false);
    setError(!data?.owner_2fa_code ? "No code was requested. Go back and sign in again." : !notExpired ? "This code expired. Go back and sign in again to get a new one." : "Incorrect code.");
  }

  if (awaiting2fa) {
    return (
      <div style={{ minHeight: "100vh", background: "#F0F3F2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Sans', sans-serif", padding: 16 }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');`}</style>
        <form onSubmit={submitCode} style={{ background: "#fff", borderRadius: 14, padding: 32, width: "100%", maxWidth: 360, border: "1px solid #E1E8E5" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <div style={{ background: "#1B2B2E", borderRadius: 8, padding: 8 }}>
              <ShieldCheck size={20} color="#5FBFB0" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Enter your code</div>
              <div style={{ fontSize: 12, color: "#7B8E8A" }}>Sent to {config.owner_2fa_email}</div>
            </div>
          </div>

          <label style={{ fontSize: 12.5, fontWeight: 600, color: "#516361" }}>6-digit code
            <input style={{ ...inputStyle, letterSpacing: 4, fontSize: 20, textAlign: "center" }} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoFocus />
          </label>

          {error && <div style={{ color: "#C1432B", fontSize: 12.5, marginTop: 10 }}>{error}</div>}

          <button type="submit" disabled={checking || code.length !== 6} style={{ marginTop: 18, width: "100%", background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: checking || code.length !== 6 ? 0.6 : 1 }}>
            {checking ? "Checking…" : "Verify and sign in"}
          </button>
          <button type="button" onClick={() => { setAwaiting2fa(false); setCode(""); setError(""); }} style={{ marginTop: 10, width: "100%", background: "none", border: "none", color: "#7B8E8A", fontSize: 12.5 }}>
            ← Back to sign in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#F0F3F2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Sans', sans-serif", padding: 16 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');`}</style>
      <form onSubmit={submit} style={{ background: "#fff", borderRadius: 14, padding: 32, width: "100%", maxWidth: 360, border: "1px solid #E1E8E5" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <div style={{ background: "#1B2B2E", borderRadius: 8, padding: 8 }}>
            <Beaker size={20} color="#5FBFB0" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Reagent Log</div>
            <div style={{ fontSize: 12, color: "#7B8E8A" }}>LTC Lab Inventory</div>
          </div>
        </div>

        <label style={{ fontSize: 12.5, fontWeight: 600, color: "#516361" }}>Username
          <input style={inputStyle} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label style={{ fontSize: 12.5, fontWeight: 600, color: "#516361", display: "block", marginTop: 12 }}>Password
          <input type="password" style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && <div style={{ color: "#C1432B", fontSize: 12.5, marginTop: 10 }}>{error}</div>}

        <button type="submit" disabled={checking} style={{ marginTop: 18, width: "100%", background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: checking ? 0.7 : 1 }}>
          <Lock size={14} /> {checking ? "Checking…" : "Sign in"}
        </button>
      </form>
      <div style={{ marginTop: 18, fontSize: 12, color: "#8A9694" }}>Made by Abdullah Ahmad</div>
    </div>
  );
}

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
