import React, { useState, useRef, useEffect } from "react";
import { X, ScanLine, Check } from "lucide-react";
import BarcodeScanner from "./BarcodeScanner";
import { newReceiptId } from "./receiveSave";

const INSPECTION_ITEMS = [
  { key: "intact_container", label: "Intact container" },
  { key: "complete_compound", label: "Complete components" },
  { key: "expiration_validity", label: "Expiration validity" },
  { key: "lot_matches_kit", label: "The lot number of the kit is the same lot number of components" },
  { key: "storage_condition_ok", label: "Storage condition during transport" },
];

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
const labelStyle = { fontSize: 12.5, fontWeight: 600, color: "#516361" };

export default function ReceiveWizard({ presets, devices, role, username, departments, defaultLowStock, onClose, onSubmit }) {
  const [step, setStep] = useState(1);
  const [showScanner, setShowScanner] = useState(false);

  const [form, setForm] = useState({
    name: "", department: departments[0] || "", unit: "mL", itemType: "Reagent", device: "",
    lotNumber: "", quantityReceived: "", expiryDate: "",
    receivedBy: username || "", receivedDate: new Date().toISOString().slice(0, 10),
    lowStockThreshold: "",
    intact_container: true,
    complete_compound: true,
    expiration_validity: true,
    lot_matches_kit: true,
    storage_condition_ok: true,
    receivingNotes: "",
    inspectionNotes: "",
  });
  const [usePackaging, setUsePackaging] = useState(false);
  const [unitsPerCarton, setUnitsPerCarton] = useState("");
  const [cartonsReceived, setCartonsReceived] = useState("");

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

  const packagingValid = !usePackaging || (unitsPerCarton && cartonsReceived);
  const step1Valid = form.name && form.lotNumber && (usePackaging ? packagingValid : form.quantityReceived) && form.receivedBy && form.receivedDate;

  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // One reference per Receive window: a retry of the same receipt can never create a second Lot.
  const [receiptId] = useState(newReceiptId);
  const inFlight = useRef(false); // blocks repeated taps before React re-renders
  // The latest attempt ended without a confirmed answer (it may already be saved): leaving
  // now and receiving the delivery again in a new window would use a new receipt id.
  const [uncertain, setUncertain] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leaveRef = useRef(null), stayRef = useRef(null);
  // The window is often scrolled down to its buttons: bring the confirmation into view.
  useEffect(() => {
    if (!confirmLeave) return;
    leaveRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    stayRef.current?.focus?.();
  }, [confirmLeave]);
  function requestClose() {
    if (uncertain) setConfirmLeave(true);
    else onClose();
  }
  async function finish() {
    if (inFlight.current || submitting) return;
    inFlight.current = true;
    setSubmitting(true);
    setSaveError(null);
    const finalQty = usePackaging ? Number(unitsPerCarton) * Number(cartonsReceived) : Number(form.quantityReceived);
    let result;
    try {
      result = await onSubmit({
        ...form,
        receiptId,
        quantityReceived: finalQty,
        unitsPerCarton: usePackaging ? Number(unitsPerCarton) : null,
        lowStockThreshold: Number(form.lowStockThreshold) || Number(defaultLowStock) || 5,
      });
    } catch {
      result = { outcome: "unknown", ok: false, message: "The receipt couldn't be confirmed. Your entries are kept. Keep this window open and press \"Add to inventory\" again — in this same window it is safe: this receipt can only ever be saved once. Don't start a new receipt for it." };
    }
    // On success the parent closes the window; otherwise it stays open with every entry kept.
    if (!result || !result.ok) {
      setUncertain(!result || result.outcome === "unknown" || result.outcome === "not_confirmed");
      setSaveError(result?.message || "The receipt couldn't be saved. Your entries are kept.");
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,25,26,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto", padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>Receive new stock</div>
          <button aria-label="Close" onClick={requestClose} style={{ background: "none", border: "none", color: "#8A9694" }}><X size={18} /></button>
        </div>
        <StepIndicator step={step} />
        {confirmLeave && (
          <div ref={leaveRef} role="alertdialog" aria-label="Leave this receipt?" style={{ marginTop: 14, background: "#FFF7ED", border: "1px solid #FDBA74", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: "#7C3E00" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>This receipt may already have been saved.</div>
            <div>The last attempt didn't get a confirmed answer from the database. If you close this window and receive the same delivery again, the new window uses a different receipt reference, so the stock could be added twice.</div>
            <div style={{ marginTop: 6 }}>The safest choice is to stay here and press "Add to inventory" again — this window can only ever save this receipt once.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button ref={stayRef} type="button" onClick={() => setConfirmLeave(false)} style={{ flex: 2, background: "#0F7173", color: "#fff", border: "none", borderRadius: 7, padding: "9px", fontWeight: 700, fontSize: 13 }}>Stay in this window</button>
              <button type="button" onClick={onClose} style={{ flex: 1, background: "#fff", color: "#A33A26", border: "1px solid #F5C2BB", borderRadius: 7, padding: "9px", fontWeight: 700, fontSize: 13 }}>Leave anyway</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
            <label style={labelStyle}>Item (type to search)
              <div style={{ position: "relative" }}>
                <input style={inputStyle} value={form.name} onChange={handleNameChange} placeholder="Search or type a new name" autoComplete="off" />
                {form.name.trim() && !presets.some((p) => p.name === form.name) && presets.filter((p) => p.name.toLowerCase().includes(form.name.trim().toLowerCase())).length > 0 && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #C7D1CE", borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.12)" }}>
                    {presets.filter((p) => p.name.toLowerCase().includes(form.name.trim().toLowerCase())).slice(0, 8).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleNameChange({ target: { value: p.name } })}
                        style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #EEF2F0", padding: "10px 12px", fontSize: 14 }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>
            <label style={labelStyle}>Department
              <select style={inputStyle} value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value, device: "" }))}>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label style={labelStyle}>Device / analyzer (optional, type to search)
              <div style={{ position: "relative" }}>
                <input style={inputStyle} value={form.device} onChange={set("device")} placeholder="e.g. Cobas c311" autoComplete="off" />
                {form.device.trim() && !devicesForDept.some((d) => d.name === form.device) && devicesForDept.filter((d) => d.name.toLowerCase().includes(form.device.trim().toLowerCase())).length > 0 && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #C7D1CE", borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.12)" }}>
                    {devicesForDept.filter((d) => d.name.toLowerCase().includes(form.device.trim().toLowerCase())).slice(0, 8).map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, device: d.name }))}
                        style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid #EEF2F0", padding: "10px 12px", fontSize: 14 }}
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>
            <label style={labelStyle}>Type
              <select style={inputStyle} value={form.itemType} onChange={set("itemType")}>
                <option value="Reagent">Reagent</option>
                <option value="QC">QC</option>
                <option value="Cal">Cal</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label style={labelStyle}>Received by
              <div style={{ ...inputStyle, background: "#F0F3F2", color: "#516361", display: "flex", alignItems: "center" }}>{username}</div>
            </label>
            <label style={labelStyle}>Date of receipt<input type="date" style={inputStyle} value={form.receivedDate} onChange={set("receivedDate")} /></label>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <label style={{ ...labelStyle, flex: 1 }}>Lot number<input style={inputStyle} value={form.lotNumber} onChange={set("lotNumber")} /></label>
              <button type="button" onClick={() => setShowScanner(true)} style={{ background: "#F0F3F2", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 10px" }}>
                <ScanLine size={16} />
              </button>
              <label style={{ ...labelStyle, width: 80 }}>Unit<input style={inputStyle} value={form.unit} onChange={set("unit")} /></label>
            </div>
            <label style={labelStyle}>Expiry date (leave blank if not applicable)<input type="date" style={inputStyle} value={form.expiryDate} onChange={set("expiryDate")} /></label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: "#3A4A48", cursor: "pointer" }}>
              <input type="checkbox" checked={usePackaging} onChange={(e) => setUsePackaging(e.target.checked)} />
              This item comes in boxes containing multiple {form.unit || "units"}
            </label>

            {usePackaging ? (
              <div style={{ display: "flex", gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>{form.unit || "Units"} per box<input type="number" style={inputStyle} value={unitsPerCarton} onChange={(e) => setUnitsPerCarton(e.target.value)} /></label>
                <label style={{ ...labelStyle, flex: 1 }}>Boxes received<input type="number" style={inputStyle} value={cartonsReceived} onChange={(e) => setCartonsReceived(e.target.value)} /></label>
              </div>
            ) : (
              <label style={labelStyle}>Quantity received<input type="number" style={inputStyle} value={form.quantityReceived} onChange={set("quantityReceived")} /></label>
            )}
            {usePackaging && unitsPerCarton && cartonsReceived && (
              <div style={{ fontSize: 11.5, color: "#0F7173" }}>= {Number(unitsPerCarton) * Number(cartonsReceived)} {form.unit} total</div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ ...labelStyle, flex: 1 }}>Low stock alert below<input type="number" style={inputStyle} value={form.lowStockThreshold} onChange={set("lowStockThreshold")} placeholder={`default: ${defaultLowStock || 5}`} /></label>
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
            {saveError && (
              <div role="alert" style={{ background: "#FDECEA", border: "1px solid #F5C2BB", borderRadius: 7, padding: "9px 12px", fontSize: 12.5, color: "#A33A26" }}>{saveError}</div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(1)} disabled={submitting} style={{ flex: 1, background: "#F0F3F2", color: "#1B2B2E", border: "1px solid #C7D1CE", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}>Back</button>
              <button onClick={finish} disabled={submitting} style={{ flex: 2, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: submitting ? 0.6 : 1 }}>
                <Check size={15} /> {submitting ? "Saving…" : "Add to inventory"}
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
