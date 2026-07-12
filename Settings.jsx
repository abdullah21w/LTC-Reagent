import React, { useState } from "react";
import { Trash2, Plus, Save } from "lucide-react";
import { supabase } from "./supabaseClient";

const PERMISSION_FIELDS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "reports", label: "Reports" },
  { key: "charts", label: "Charts" },
  { key: "settings", label: "Settings" },
  { key: "receive", label: "Receive stock" },
  { key: "log_use", label: "Log use" },
  { key: "edit", label: "Edit entries" },
  { key: "delete", label: "Delete entries" },
];

const BLANK_PERMISSIONS = { dashboard: true, reports: true, charts: false, settings: false, receive: false, log_use: false, edit: false, delete: false };

function PermissionGrid({ value, onToggle }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 }}>
      {PERMISSION_FIELDS.map((f) => (
        <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#3A4A48", cursor: "pointer" }}>
          <input type="checkbox" checked={!!value[f.key]} onChange={() => onToggle(f.key)} />
          {f.label}
        </label>
      ))}
    </div>
  );
}

function StaffAccountRow({ account, onSave, onRemove }) {
  const [perms, setPerms] = useState({ ...BLANK_PERMISSIONS, ...(account.permissions || {}) });
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  function toggle(key) {
    setPerms((p) => ({ ...p, [key]: !p[key] }));
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    await onSave(account.id, perms);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>{account.username}</div>
        {dirty && (
          <button onClick={save} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
            <Save size={12} /> Save
          </button>
        )}
        {saved && <span style={{ fontSize: 11.5, color: "#2F6B4F" }}>Saved</span>}
        <button onClick={() => onRemove(account.id)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={15} /></button>
      </div>
      <PermissionGrid value={perms} onToggle={toggle} />
    </div>
  );
}

export default function Settings({ config, presets, role, staffAccounts, devices, reload }) {
  const departments = config.departments || [];
  const [newPreset, setNewPreset] = useState({ name: "", department: departments[0] || "", unit: "mL" });
  const [newDept, setNewDept] = useState("");
  const [newDevice, setNewDevice] = useState({ name: "", department: departments[0] || "" });
  const [newStaff, setNewStaff] = useState({ username: "", password: "", permissions: { ...BLANK_PERMISSIONS } });
  const [staffMsg, setStaffMsg] = useState("");
  const [creds, setCreds] = useState({
    owner_username: config.owner_username,
    owner_password: config.owner_password,
    low_stock_default_percent: config.low_stock_default_percent,
    expiry_warning_days: config.expiry_warning_days ?? 30,
  });
  const [msg, setMsg] = useState("");

  async function addDevice() {
    if (!newDevice.name) return;
    await supabase.from("devices").insert(newDevice);
    setNewDevice({ name: "", department: departments[0] || "" });
    reload();
  }

  async function deleteDevice(id) {
    await supabase.from("devices").delete().eq("id", id);
    reload();
  }

  async function addStaffAccount() {
    if (!newStaff.username || !newStaff.password) return;
    const { error } = await supabase.from("staff_accounts").insert(newStaff);
    if (error) {
      console.error("addStaffAccount error:", error);
      setStaffMsg(`Could not save: ${error.message}`);
    } else {
      setStaffMsg("Account created.");
      setNewStaff({ username: "", password: "", permissions: { ...BLANK_PERMISSIONS } });
      reload();
    }
    setTimeout(() => setStaffMsg(""), 6000);
  }

  async function saveStaffPermissions(id, permissions) {
    await supabase.from("staff_accounts").update({ permissions }).eq("id", id);
    reload();
  }

  async function removeStaffAccount(id) {
    if (!confirm("Remove this employee's account? They will no longer be able to sign in.")) return;
    await supabase.from("staff_accounts").delete().eq("id", id);
    reload();
  }

  async function addPreset() {
    if (!newPreset.name) return;
    await supabase.from("reagent_presets").insert(newPreset);
    setNewPreset({ name: "", department: departments[0] || "", unit: "mL" });
    reload();
  }

  async function deletePreset(id) {
    await supabase.from("reagent_presets").delete().eq("id", id);
    reload();
  }

  async function addDepartment() {
    const name = newDept.trim();
    if (!name || departments.includes(name)) return;
    await supabase.from("app_config").update({ departments: [...departments, name] }).eq("id", 1);
    setNewDept("");
    reload();
  }

  async function removeDepartment(name) {
    if (!confirm(`Remove "${name}"? Existing reagents already using it are not affected.`)) return;
    await supabase.from("app_config").update({ departments: departments.filter((d) => d !== name) }).eq("id", 1);
    reload();
  }

  async function saveCreds() {
    const { error } = await supabase.from("app_config").update(creds).eq("id", 1);
    setMsg(error ? "Could not save." : "Saved.");
    reload();
    setTimeout(() => setMsg(""), 2500);
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Settings</h2>
      <div style={{ fontSize: 13, color: "#7B8E8A", marginBottom: 24 }}>
        {role === "owner" ? "Full access — you can manage users, permissions, credentials, and inventory setup." : "You can manage departments, presets, and devices here."}
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>DEPARTMENTS</div>
      <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="e.g. Molecular Biology"
            value={newDept}
            onChange={(e) => setNewDept(e.target.value)}
            style={{ ...inputStyle, flex: 1, marginTop: 0 }}
          />
          <button onClick={addDepartment} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "0 14px", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 30 }}>
        {departments.map((d) => (
          <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #E1E8E5", borderRadius: 20, padding: "6px 8px 6px 14px" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{d}</span>
            <button onClick={() => removeDepartment(d)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>REAGENT PRESET LIST</div>
      <div style={{ fontSize: 12.5, color: "#7B8E8A", marginBottom: 12 }}>
        This is the list staff pick from at the "Details" step when receiving stock.
      </div>

      <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Reagent name"
            value={newPreset.name}
            onChange={(e) => setNewPreset((p) => ({ ...p, name: e.target.value }))}
            style={{ ...inputStyle, flex: 2, minWidth: 140, marginTop: 0 }}
          />
          <select
            value={newPreset.department}
            onChange={(e) => setNewPreset((p) => ({ ...p, department: e.target.value }))}
            style={{ ...inputStyle, flex: 1, minWidth: 120, marginTop: 0 }}
          >
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input
            placeholder="Unit"
            value={newPreset.unit}
            onChange={(e) => setNewPreset((p) => ({ ...p, unit: e.target.value }))}
            style={{ ...inputStyle, width: 80, marginTop: 0 }}
          />
          <button onClick={addPreset} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "0 14px", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 30 }}>
        {presets.length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No presets yet — add your first reagent name above.</div>}
        {presets.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "9px 14px" }}>
            <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{p.name}</div>
            <div style={{ fontSize: 12.5, color: "#7B8E8A" }}>{p.department} · {p.unit}</div>
            <button onClick={() => deletePreset(p.id)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>DEVICES / ANALYZERS</div>
      <div style={{ fontSize: 12.5, color: "#7B8E8A", marginBottom: 12 }}>
        Each device belongs to a department. Staff only see devices matching the department they picked when receiving stock.
      </div>
      <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Device name, e.g. Cobas c311"
            value={newDevice.name}
            onChange={(e) => setNewDevice((d) => ({ ...d, name: e.target.value }))}
            style={{ ...inputStyle, flex: 2, minWidth: 160, marginTop: 0 }}
          />
          <select
            value={newDevice.department}
            onChange={(e) => setNewDevice((d) => ({ ...d, department: e.target.value }))}
            style={{ ...inputStyle, flex: 1, minWidth: 120, marginTop: 0 }}
          >
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={addDevice} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "0 14px", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 30 }}>
        {(devices || []).length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No devices yet — add your lab's analyzers above.</div>}
        {(devices || []).map((d) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #E1E8E5", borderRadius: 8, padding: "9px 14px" }}>
            <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{d.name}</div>
            <div style={{ fontSize: 12.5, color: "#7B8E8A" }}>{d.department}</div>
            <button onClick={() => deleteDevice(d.id)} style={{ background: "none", border: "none", color: "#C1432B" }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>

      {role === "owner" && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>EMPLOYEE ACCOUNTS & PERMISSIONS</div>
          <div style={{ fontSize: 12.5, color: "#7B8E8A", marginBottom: 12 }}>
            Create a personal login for each employee, and pick exactly what they can reach — pages and actions are all opt-in. Only the owner account can manage users, do permanent erase, and view the Activity log.
          </div>
          <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <input
                placeholder="Username"
                value={newStaff.username}
                onChange={(e) => setNewStaff((s) => ({ ...s, username: e.target.value }))}
                style={{ ...inputStyle, flex: 1, minWidth: 140, marginTop: 0 }}
              />
              <input
                placeholder="Password"
                value={newStaff.password}
                onChange={(e) => setNewStaff((s) => ({ ...s, password: e.target.value }))}
                style={{ ...inputStyle, flex: 1, minWidth: 140, marginTop: 0 }}
              />
              <button onClick={addStaffAccount} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "0 14px", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
                <Plus size={14} /> Add
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "#8A9694", marginBottom: 6 }}>Starting permissions for this new account (you can change them anytime below after creating it):</div>
            <PermissionGrid
              value={newStaff.permissions}
              onToggle={(key) => setNewStaff((s) => ({ ...s, permissions: { ...s.permissions, [key]: !s.permissions[key] } }))}
            />
            {staffMsg && <div style={{ fontSize: 12, color: "#516361", marginTop: 8 }}>{staffMsg}</div>}
          </div>
          <div style={{ marginBottom: 30 }}>
            {(staffAccounts || []).length === 0 && <div style={{ fontSize: 13, color: "#8A9694" }}>No employee accounts yet — add one above.</div>}
            {(staffAccounts || []).map((s) => (
              <StaffAccountRow key={s.id} account={s} onSave={saveStaffPermissions} onRemove={removeStaffAccount} />
            ))}
          </div>
        </>
      )}

      {role === "owner" && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 0.3 }}>LOGIN & DEFAULTS</div>
          <div style={{ background: "#fff", border: "1px solid #E1E8E5", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ ...labelStyle, flex: 1 }}>Owner username<input style={inputStyle} value={creds.owner_username} onChange={(e) => setCreds((c) => ({ ...c, owner_username: e.target.value }))} /></label>
              <label style={{ ...labelStyle, flex: 1 }}>Owner password<input style={inputStyle} value={creds.owner_password} onChange={(e) => setCreds((c) => ({ ...c, owner_password: e.target.value }))} /></label>
            </div>
            <label style={labelStyle}>Default low-stock alert (units remaining)
              <input type="number" min="1" style={inputStyle} value={creds.low_stock_default_percent} onChange={(e) => setCreds((c) => ({ ...c, low_stock_default_percent: Number(e.target.value) }))} />
              <div style={{ fontSize: 11.5, color: "#8A9694", fontWeight: 400, marginTop: 4 }}>New reagents get this as their default "low stock" number unless you type a different one at receiving time.</div>
            </label>
            <label style={labelStyle}>Expiry warning threshold (days before expiry to mark "Watch")
              <input type="number" min="1" style={inputStyle} value={creds.expiry_warning_days} onChange={(e) => setCreds((c) => ({ ...c, expiry_warning_days: Number(e.target.value) }))} />
            </label>
            <button onClick={saveCreds} style={{ background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Save size={14} /> Save settings
            </button>
            {msg && <div style={{ fontSize: 12.5, color: "#2F6B4F" }}>{msg}</div>}
          </div>

          <div style={{ fontSize: 11.5, color: "#8A9694", marginTop: 14 }}>
            Note: these credentials are stored as plain text and are visible to anyone with the app link — fine for internal use, not for sensitive data.
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
const labelStyle = { fontSize: 12.5, fontWeight: 600, color: "#516361" };
