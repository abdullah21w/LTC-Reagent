import React, { useEffect, useRef, useState } from "react";
import { X, Camera } from "lucide-react";

export default function BarcodeScanner({ onDetected, onClose }) {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    import("html5-qrcode")
      .then(({ Html5Qrcode }) => {
        if (cancelled) return;
        const scanner = new Html5Qrcode("barcode-scanner-view");
        scannerRef.current = scanner;
        scanner
          .start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 240, height: 140 } },
            (decodedText) => {
              scanner.stop().catch(() => {});
              onDetected(decodedText);
            },
            () => {}
          )
          .catch(() => setError("Could not access the camera. Check camera permission."));
      })
      .catch(() => setError("Barcode scanning is not available."));

    return () => {
      cancelled = true;
      if (scannerRef.current) scannerRef.current.stop().catch(() => {});
    };
  }, [onDetected]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,25,26,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 380, padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}><Camera size={16} /> Scan barcode or QR</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#8A9694" }}><X size={18} /></button>
        </div>
        <div id="barcode-scanner-view" ref={containerRef} style={{ width: "100%", borderRadius: 8, overflow: "hidden", background: "#000", minHeight: 220 }} />
        {error && <div style={{ color: "#C1432B", fontSize: 12.5, marginTop: 10 }}>{error}</div>}
        <div style={{ fontSize: 12, color: "#8A9694", marginTop: 10 }}>Point the camera at the barcode or QR code printed on the reagent bottle.</div>
      </div>
    </div>
  );
}
