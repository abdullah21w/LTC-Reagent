import React, { useState, useRef, useEffect } from "react";
import { X, ScanLine, Check } from "lucide-react";
import BarcodeScanner from "./BarcodeScanner";
import { newReceiptId } from "./receiveSave";
import { planReceipt, describeReceipt, findPossibleDuplicates, SUGGESTED_BASE_UNITS } from "./receivePlan";
import { SUGGESTED_PACK_UNITS, normalizeUnit, unitLabel } from "./units";

const INSPECTION_ITEMS = [
  { key: "intact_container", label: "Intact container" },
  { key: "complete_compound", label: "Complete components" },
  { key: "expiration_validity", label: "Expiration validity" },
  { key: "lot_matches_kit", label: "The lot number of the kit is the same lot number of components" },
  { key: "storage_condition_ok", label: "Storage condition during transport" },
];

const inputStyle = { width: "100%", border: "1px solid #C7D1CE", borderRadius: 7, padding: "9px 11px", fontSize: 16, marginTop: 4, boxSizing: "border-box" };
const labelStyle = { fontSize: 12.5, fontWeight: 600, color: "#516361" };

const isSuggested = (list, v) => !!String(v ?? "").trim() && list.some((x) => normalizeUnit(x).key === normalizeUnit(v).key);
const chip = (on) => ({ padding: "6px 11px", borderRadius: 16, fontSize: 12.5, fontWeight: 600, border: `1px solid ${on ? "#0F7173" : "#CBD5D3"}`, background: on ? "#0F7173" : "#fff", color: on ? "#fff" : "#3A4A48", cursor: "pointer" });
// Capitalise a label for the start of a sentence — but never a measured unit ("mL" stays "mL").
const cap = (w) => (w && normalizeUnit(w).countable ? w[0].toUpperCase() + w.slice(1) : w);

// lookupLots(lotNumber) → { data, error }: a read-only lookup of existing Lots with that
// Lot number, used only for the duplicate advisory (optional).
export default function ReceiveWizard({ presets, devices, role, username, departments, defaultLowStock, onClose, onSubmit, lookupLots }) {
  const [step, setStep] = useState(1);
  const [showScanner, setShowScanner] = useState(false);

  const [form, setForm] = useState({
    name: "", department: departments[0] || "", unit: "", itemType: "Reagent", device: "",
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
  // Base unit (required, no default) and packaging (U2d-2).
  const [otherUnit, setOtherUnit] = useState(false);
  const [packaged, setPackaged] = useState(false);
  const [packUnit, setPackUnit] = useState("");
  const [otherPack, setOtherPack] = useState(false);
  const [unitsPerPackage, setUnitsPerPackage] = useState("");
  const [packages, setPackages] = useState("");
  const [loose, setLoose] = useState("");
  const [copiedNote, setCopiedNote] = useState(null);
  // Duplicate advisory: idle | checking | done | error (read-only, never blocks saving).
  const [dup, setDup] = useState({ status: "idle", matches: [] });
  const dupSeq = useRef(0);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function handleNameChange(e) {
    const value = e.target.value;
    const p = presets.find((x) => x.name === value);
    if (p) { setForm((f) => ({ ...f, name: p.name, department: p.department, unit: p.unit })); setOtherUnit(!isSuggested(SUGGESTED_BASE_UNITS, p.unit)); }
    else setForm((f) => ({ ...f, name: value }));
  }

  function toggle(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const devicesForDept = (devices || []).filter((d) => d.department === form.department);

  // One plan drives the checks, the live total, the review and the saved values.
  const plan = planReceipt({ unit: form.unit, packaged, packUnit, unitsPerPackage, packages, loose, quantity: form.quantityReceived, lowStock: form.lowStockThreshold }, defaultLowStock);
  const v = plan.value;
  const baseUnit = String(form.unit || "").trim();
  const unitWord = (n) => unitLabel(baseUnit || "unit", n);
  const packWord = (n) => unitLabel(String(packUnit || "").trim() || "package", n);
  const step1Valid = !!(form.name.trim() && form.lotNumber.trim() && form.receivedBy && form.receivedDate && plan.status === "ok");

  async function runDuplicateCheck() {
    const lot = form.lotNumber.trim();
    const seq = ++dupSeq.current;
    if (!lookupLots || !lot) { setDup({ status: "idle", matches: [] }); return; }
    setDup({ status: "checking", matches: [] });
    try {
      const r = await lookupLots(lot);
      if (seq !== dupSeq.current) return;
      if (r?.error) throw r.error;
      setDup({ status: "done", matches: findPossibleDuplicates(r?.data || [], { lotNumber: lot, department: form.department, device: form.device, unit: form.unit }) });
    } catch { if (seq === dupSeq.current) setDup({ status: "error", matches: [] }); }
  }
  function goToInspection() { setStep(2); runDuplicateCheck(); }
  // Copies an existing Lot's packaging into this form only (the existing Lot is never changed).
  function copyPackaging(m) {
    const l = m.lot;
    setPackaged(true);
    const name = String(l.pack_unit || "").trim();
    setPackUnit(name);
    setOtherPack(!!name && !isSuggested(SUGGESTED_PACK_UNITS, name));
    setUnitsPerPackage(String(Number(l.units_per_carton)));
    if (!baseUnit) { setForm((f) => ({ ...f, unit: String(l.unit || "").trim() })); setOtherUnit(!isSuggested(SUGGESTED_BASE_UNITS, l.unit)); }
    setCopiedNote(`Packaging copied from Lot ${l.lot_number}: ${name ? `1 ${unitLabel(name, 1)}` : "1 package"} = ${Number(l.units_per_carton)} ${unitLabel(l.unit, Number(l.units_per_carton))}${name ? "" : " (its package name isn't recorded — choose one)"}. Check the package count and loose units before saving. Lot ${l.lot_number} itself is not changed.`);
    setStep(1);
  }

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
    if (inFlight.current || submitting || plan.status !== "ok") return;
    inFlight.current = true;
    setSubmitting(true);
    setSaveError(null);
    let result;
    try {
      result = await onSubmit({
        ...form,
        receiptId,
        unit: v.unit,
        quantityReceived: v.total,
        unitsPerCarton: v.packaged ? v.perPackage : null,
        packUnit: v.packaged ? v.packUnit : null,
        lowStockThreshold: v.lowStock,
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
            </div>
            <label style={labelStyle}>Expiry date (leave blank if not applicable)<input type="date" style={inputStyle} value={form.expiryDate} onChange={set("expiryDate")} /></label>

            <div style={labelStyle}>Base unit — the unit you count and use (stock is stored in it)
              <div role="group" aria-label="Base unit" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {SUGGESTED_BASE_UNITS.map((u) => {
                  const on = !otherUnit && !!baseUnit && normalizeUnit(baseUnit).key === normalizeUnit(u).key;
                  return <button type="button" key={u} aria-pressed={on} style={chip(on)} onClick={() => { setOtherUnit(false); setForm((f) => ({ ...f, unit: u })); }}>{u}</button>;
                })}
                <button type="button" aria-pressed={otherUnit} style={chip(otherUnit)} onClick={() => { if (!otherUnit) { setOtherUnit(true); if (isSuggested(SUGGESTED_BASE_UNITS, form.unit)) setForm((f) => ({ ...f, unit: "" })); } }}>Other…</button>
              </div>
              {otherUnit && <input aria-label="Other base unit" style={{ ...inputStyle, marginTop: 6 }} value={form.unit} onChange={set("unit")} placeholder="e.g. cassette" />}
            </div>

            <div style={labelStyle}>Packaging
              <div role="group" aria-label="Packaging" style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button type="button" aria-pressed={!packaged} style={chip(!packaged)} onClick={() => setPackaged(false)}>No packaging</button>
                <button type="button" aria-pressed={packaged} style={chip(packaged)} onClick={() => setPackaged(true)}>Packaged (box, carton, kit …)</button>
              </div>
            </div>
            {copiedNote && <div role="status" style={{ fontSize: 12, color: "#0F5F5B", background: "#EAF6F4", border: "1px solid #C6E8E3", borderRadius: 7, padding: "8px 10px" }}>{copiedNote}</div>}

            {packaged ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, borderLeft: "3px solid #CFE3E2", paddingLeft: 10 }}>
                <div style={labelStyle}>Package name
                  <div role="group" aria-label="Package name" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {SUGGESTED_PACK_UNITS.map((s) => {
                      const on = !otherPack && normalizeUnit(packUnit).key === s;
                      return <button type="button" key={s} aria-pressed={on} style={chip(on)} onClick={() => { setOtherPack(false); setPackUnit(s); }}>{cap(s)}</button>;
                    })}
                    <button type="button" aria-pressed={otherPack} style={chip(otherPack)} onClick={() => { if (!otherPack) { setOtherPack(true); if (isSuggested(SUGGESTED_PACK_UNITS, packUnit)) setPackUnit(""); } }}>Other…</button>
                  </div>
                  {otherPack && <input aria-label="Other package name" style={{ ...inputStyle, marginTop: 6 }} value={packUnit} maxLength={60} placeholder="e.g. sachet" onChange={(e) => setPackUnit(e.target.value)} />}
                </div>
                <label style={labelStyle}>{cap(unitWord(2))} per {packWord(1)}<input type="number" inputMode="numeric" style={inputStyle} value={unitsPerPackage} onChange={(e) => setUnitsPerPackage(e.target.value)} /></label>
                <div style={{ display: "flex", gap: 10 }}>
                  <label style={{ ...labelStyle, flex: 1 }}>{cap(packWord(2))} received<input type="number" inputMode="numeric" style={inputStyle} value={packages} onChange={(e) => setPackages(e.target.value)} /></label>
                  <label style={{ ...labelStyle, flex: 1 }}>Loose {unitWord(2)} (optional)<input type="number" inputMode="decimal" style={inputStyle} value={loose} onChange={(e) => setLoose(e.target.value)} placeholder="0" /></label>
                </div>
              </div>
            ) : (
              <label style={labelStyle}>Quantity received ({unitWord(2)})<input type="number" inputMode="decimal" style={inputStyle} value={form.quantityReceived} onChange={set("quantityReceived")} /></label>
            )}
            {v && <div data-testid="receipt-total" style={{ fontSize: 12.5, fontWeight: 600, color: "#0F7173" }}>Total to store: {describeReceipt(v)}</div>}
            {plan.status === "invalid" && (
              <div data-testid="receipt-errors" style={{ fontSize: 12, color: "#A33A26" }}>{plan.errors.map((e) => <div key={e}>{e}</div>)}</div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ ...labelStyle, flex: 1 }}>Low stock alert below ({unitWord(2)})<input type="number" inputMode="decimal" style={inputStyle} value={form.lowStockThreshold} onChange={set("lowStockThreshold")} placeholder={`default: ${defaultLowStock || 5}`} />
                <div style={{ fontSize: 11, color: "#7B8E8A", fontWeight: 400, marginTop: 3 }}>Leave blank for the default ({defaultLowStock || 5}); 0 is kept as 0.</div>
              </label>
            </div>
            <label style={labelStyle}>Notes (optional)
              <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} value={form.receivingNotes} onChange={set("receivingNotes")} placeholder="Any additional comment about this delivery" />
            </label>

            <button
              disabled={!step1Valid}
              onClick={goToInspection}
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
            {v && (
              <div data-testid="receipt-review" style={{ background: "#F7F9F8", border: "1px solid #E1E8E5", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#1B2B2E" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Review — this is what will be saved</div>
                {[
                  ["Item", form.name.trim()],
                  ["Lot number", form.lotNumber.trim()],
                  ["Department", form.department],
                  ["Device", form.device.trim() || "—"],
                  ["Base unit", v.unit],
                  ["Packaging", v.packaged ? `1 ${unitLabel(v.packUnit, 1)} = ${v.perPackage} ${unitLabel(v.unit, v.perPackage)}` : "None"],
                  ...(v.packaged ? [["Received", `${v.packages} ${unitLabel(v.packUnit, v.packages)} + ${v.loose} loose ${unitLabel(v.unit, v.loose)}`]] : []),
                  ["Total stored", `${v.total} ${unitLabel(v.unit, v.total)}`],
                  ["Expiry", form.expiryDate || "None"],
                  ["Received on", form.receivedDate],
                  ["Low stock alert below", `${v.lowStock} ${unitLabel(v.unit, v.lowStock)}${v.lowStockIsDefault ? " (default)" : ""}`],
                ].map(([k, val]) => (
                  <div key={k} style={{ display: "flex", gap: 8, padding: "2px 0" }}><span style={{ width: 128, flexShrink: 0, color: "#516361" }}>{k}</span><b data-review={k} style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{val}</b></div>
                ))}
              </div>
            )}
            {dup.status === "checking" && <div style={{ fontSize: 12, color: "#516361" }}>Checking for an existing Lot with this number…</div>}
            {dup.status === "error" && <div data-testid="duplicate-advisory" style={{ fontSize: 12, color: "#7C3E00" }}>Couldn't check for an existing Lot with this number. You can still save; check the inventory if this delivery may already be recorded.</div>}
            {dup.status === "done" && dup.matches.length > 0 && (
              <div data-testid="duplicate-advisory" role="note" style={{ background: "#FFF7ED", border: "1px solid #FDBA74", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#7C3E00" }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{dup.matches.some((m) => m.sameIdentity) ? "Possible duplicate: this Lot number is already recorded for this department and device." : "This Lot number is already recorded elsewhere."}</div>
                <div style={{ marginBottom: 6 }}>Check it isn't the same delivery. If it is a new delivery of the same Lot, you can save — nothing is merged and the existing Lot isn't changed. (This is a check of what is recorded now, not a lock.)</div>
                {dup.matches.map((m) => {
                  const l = m.lot, per = Number(l.units_per_carton);
                  return (
                    <div key={l.id} data-testid="duplicate-match" style={{ borderTop: "1px solid #FDE3C4", paddingTop: 6, marginTop: 6 }}>
                      <div><b>{l.name}</b> — Lot {l.lot_number}{l.deleted ? " (removed)" : ""}{m.sameIdentity ? " · same department and device" : ""}</div>
                      <div>{l.department || "—"} · {String(l.device || "").trim() || "no device"} · received {l.date_added || "—"}{l.added_by ? ` by ${l.added_by}` : ""}</div>
                      <div>{Number(l.current_quantity)} of {Number(l.quantity_received)} {unitLabel(l.unit, 2)} left · packaging: {l.units_per_carton ? `${l.pack_unit ? `1 ${unitLabel(l.pack_unit, 1)}` : "1 package"} = ${per} ${unitLabel(l.unit, per)}${l.pack_unit ? "" : " (name not recorded)"}` : "none"}</div>
                      {m.packagingNote && <div>{m.packagingNote}</div>}
                      {m.packagingCopyable && <button type="button" onClick={() => copyPackaging(m)} style={{ marginTop: 6, background: "#fff", border: "1px solid #FDBA74", color: "#7C3E00", borderRadius: 7, padding: "6px 10px", fontSize: 12, fontWeight: 700 }}>Use the same packaging</button>}
                    </div>
                  );
                })}
              </div>
            )}
            {saveError && (
              <div role="alert" style={{ background: "#FDECEA", border: "1px solid #F5C2BB", borderRadius: 7, padding: "9px 12px", fontSize: 12.5, color: "#A33A26" }}>{saveError}</div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(1)} disabled={submitting} style={{ flex: 1, background: "#F0F3F2", color: "#1B2B2E", border: "1px solid #C7D1CE", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14 }}>Back</button>
              <button onClick={finish} disabled={submitting || plan.status !== "ok"} style={{ flex: 2, background: "#0F7173", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: submitting ? 0.6 : 1 }}>
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
