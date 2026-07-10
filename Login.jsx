import React, { useState } from "react";
import { Beaker, Lock } from "lucide-react";

export default function Login({ config, staffAccounts, onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    if (username === config.owner_username && password === config.owner_password) {
      onLogin("owner", username, null, null);
      return;
    }
    const staffMatch = (staffAccounts || []).find((s) => s.username === username && s.password === password);
    if (staffMatch) {
      onLogin("staff", username, staffMatch.permissions || {}, staffMatch.id);
      return;
    }
    setError("Incorrect username or password.");
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

        <button type="submit" style={{ marginTop: 18, width: "100%", background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Lock size={14} /> Sign in
        </button>
      </form>
      <div style={{ marginTop: 18, fontSize: 12, color: "#8A9694" }}>Made by Abdullah Ahmad</div>
    </div>
  );
}

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
