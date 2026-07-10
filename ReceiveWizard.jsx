import React, { useState } from "react";
import { X, ScanLine, Check } from "lucide-react";
import BarcodeScanner from "./BarcodeScanner";

const INSPECTION_ITEMS = [
  { key: "intact_container", label: "Intact container" },
  { key: "complete_compound", label: "Complete components" },
  { key: "expiration_validity", label: "Expiration validity" },
  { key: "lot_matches_kit", label: "The lot number of the kit is the same lot number of components" },
  { key: "storage_condition_ok", label: "Storage condition during transport" },
];

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 14, marginTop: 4, boxSizing: "border-box" };
const labelStyle = { fontSize: 12.5, fontWeight: 600, color: "#516361" };

export default function ReceiveWizard({ presets, devices, role, departments, onClose, onSubmit }) {
  const [step, setStep] = useState(1);
  const [showScanner, setShowScanner] = useState(false);

  const [form, setForm] = useState({
    name: "", department: departments[0] || "", unit: "mL", itemType: "Reagent", device: "",
    lotNumber: "", quantityReceived: "", expiryDate: "",
    receivedBy: "", receivedDate: new Date().toISOString().slice(0, 10),
    lowStockThreshold: "",
    intact_container: true,
    complete_compound: true,
    expiration_validity: true,
    lot_matches_kit: true,
    storage_condition_ok: true,
    receivingNotes: "",
    inspectionNotes: "",
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function handleNameChange(e) {
    const value = e.target.value;
    const p = presets.find((x) => x.name === value);
    if (p) setForm((f) => ({ ...f, name: p.name, department: p.department, unit: p.unit }));
    else setForm((f) => ({ ...f, name: value }));
  }

  function toggle(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const devicesForDept = (devices || []).filter((d) => d.department === form.department);

  const step1Valid = form.name && form.lotNumber && form.quantityReceived && form.expiryDate && form.receivedBy && form.receivedDate;

  function finish() {
    onSubmit({
      ...form,
      quantityReceived: Number(form.quantityReceived),
      lowStockThreshold: Number(form.lowStockThreshold) || Math.ceil(Number(form.quantityReceived) * 0.15),
    });
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,25,26,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>Receive new stock</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A9694" }}><X size={18} /></button>
        </div>
        <StepIndicator step={step} />

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            <label style={labelStyle}>Item (type to search)
              <input list="reagent-presets-list" style={inputStyle} value={form.name} onChange={handleNameChange} placeholder="Search or type a new name" />
              <datalist id="reagent-presets-list">
                {presets.map((p) => <option key={p.id} value={p.name} />)}
              </datalist>
            </label>
            <label style={labelStyle}>Department
              <select style={inputStyle} value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value, device: "" }))}>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label style={labelStyle}>Device / analyzer (optional, type to search)
              <input list="devices-list" style={inputStyle} value={form.device} onChange={set("device")} placeholder="e.g. Cobas c311" />
              <datalist id="devices-list">
                {devicesForDept.map((d) => <option key={d.id} value={d.name} />)}
              </datalist>
            </label>
            <label style={labelStyle}>Type
              <select style={inputStyle} value={form.itemType} onChange={set("itemType")}>
                <option value="Reagent">Reagent</option>
                <option value="QC">QC</option>
                <option value="Cal">Cal</option>
              </select>
            </label>
            <label style={labelStyle}>Received by (your name)<input style={inputStyle} value={form.receivedBy} onChange={set("receivedBy")} /></label>
            <label style={labelStyle}>Date of receipt<input type="date" style={inputStyle} value={form.receivedDate} onChange={set("receivedDate")} /></label>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <label style={{ ...labelStyle, flex: 1 }}>Lot number<input style={inputStyle} value={form.lotNumber} onChange={set("lotNumber")} /></label>
              <button type="button" onClick={() => setShowScanner(true)} style={{ background: "#F0F3F2", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 10px" }}>
                <ScanLine size={16} />
              </button>
              <label style={{ ...labelStyle, width: 80 }}>Unit<input style={inputStyle} value={form.unit} onChange={set("unit")} /></label>
            </div>
            <label style={labelStyle}>Expiry date<input type="date" style={inputStyle} value={form.expiryDate} onChange={set("expiryDate")} /></label>
            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ ...labelStyle, flex: 1 }}>Quantity received<input type="number" style={inputStyle} value={form.quantityReceived} onChange={set("quantityReceived")} /></label>
              <label style={{ ...labelStyle, flex: 1 }}>Low stock alert below<input type="number" style={inputStyle} value={form.lowStockThreshold} onChange={set("lowStockThreshold")} placeholder="auto" /></label>
            </div>
            <label style={labelStyle}>Notes (optional)
              <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.receivingNotes} onChange={set("receivingNotes")} placeholder="Any additional comment about this delivery" />
            </label>

            <button
              disabled={!step1Valid}
              onClick={() => setStep(2)}
              style={{ marginTop: 6, background: step1Valid ? "#0F7173" : "#C7D1CE", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}
            >
              Next: Inspection
            </button>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
            <div style={{ fontSize: 12.5, color: "#7B8E8A", marginBottom: 4 }}>Check each item on arrival.</div>
            {INSPECTION_ITEMS.map((item) => (
              <YesNoRow key={item.key} label={item.label} value={form[item.key]} onChange={(v) => toggle(item.key, v)} />
            ))}
            <label style={labelStyle}>Inspection notes (optional)
              <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.inspectionNotes} onChange={set("inspectionNotes")} placeholder="Any comment about a failed check or condition" />
            </label>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(1)} style={{ flex: 1, background: "#F0F3F2", color: "#1B2B2E", border: "1px solid #C7D1CE", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}>Back</button>
              <button onClick={finish} style={{ flex: 2, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <Check size={15} /> Add to inventory
              </button>
            </div>
          </div>
        )}
      </div>
      {showScanner && (
        <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={(text) => { setForm((f) => ({ ...f, lotNumber: text })); setShowScanner(false); }} />
      )}
    </div>
  );
}

function StepIndicator({ step }) {
  const labels = ["Details", "Inspection"];
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
      {labels.map((l, i) => (
        <div key={l} style={{ flex: 1 }}>
          <div style={{ height: 4, borderRadius: 2, background: i + 1 <= step ? "#0F7173" : "#E1E8E5" }} />
          <div style={{ fontSize: 10.5, color: i + 1 === step ? "#0F7173" : "#8A9694", fontWeight: i + 1 === step ? 700 : 500, marginTop: 4 }}>{l}</div>
        </div>
      ))}
    </div>
  );
}

export function YesNoRow({ label, value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#F7F9F8", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ flex: 1, fontSize: 13.5 }}>{label}</div>
      <button
        type="button"
        onClick={() => onChange(true)}
        style={{ background: value ? "#2F6B4F" : "#fff", color: value ? "#fff" : "#516361", border: "1px solid #C7D1CE", borderRadius: 6, padding: "6px 14px", fontSize: 12.5, fontWeight: 700 }}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        style={{ background: !value ? "#C1432B" : "#fff", color: !value ? "#fff" : "#516361", border: "1px solid #C7D1CE", borderRadius: 6, padding: "6px 14px", fontSize: 12.5, fontWeight: 700 }}
      >
        No
      </button>
    </div>
  );
}
