// Imperative confirm dialog.
//
// Usage:
//   const confirm = useConfirm();
//   const ok = await confirm({
//     title: "Delete draft?",
//     message: "This cannot be undone.",
//     confirmLabel: "Delete",
//     danger: true,
//   });
//   if (ok) await remove(...);
//
// Mount <ConfirmProvider> once near the root. The dialog traps focus (Tab
// cycles within it), closes on Escape and on backdrop click, and renders into
// a portal on document.body.

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

const ConfirmCtx = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { opts, resolve }
  const cancelBtnRef = useRef(null);
  const dialogRef = useRef(null);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      setState({ opts, resolve });
    });
  }, []);

  const close = useCallback((result) => {
    setState((cur) => {
      if (cur) cur.resolve(result);
      return null;
    });
  }, []);

  // Focus the cancel button when the dialog opens (safe default; the destructive
  // action should be a deliberate click, not Enter on a focused confirm button).
  useEffect(() => {
    if (state && cancelBtnRef.current) cancelBtnRef.current.focus();
  }, [state]);

  // Escape to dismiss = cancel; Tab cycles within the dialog (focus trap).
  // Lock body scroll while open.
  useEffect(() => {
    if (!state) return;
    const onKey = (e) => {
      if (e.key === "Escape") { close(false); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll("button");
      if (!focusables.length) return;
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, close]);

  const o = state?.opts || {};
  const accent = "var(--accent)";
  const danger = o.danger;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            background: "rgba(0,0,0,0.42)",
          }}
        >
          <div
            ref={dialogRef}
            style={{
              width: "min(92vw, 420px)",
              background: "var(--card)",
              color: "var(--ink)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "18px 20px 8px", display: "flex", gap: 12 }}>
              {danger && (
                <AlertTriangle size={20} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="confirm-title" style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
                  {o.title || "Anda yakin?"}
                </div>
                {o.message && (
                  <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginTop: 6 }}>
                    {o.message}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px 18px" }}>
              <button
                type="button"
                ref={cancelBtnRef}
                onClick={() => close(false)}
                style={{
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: "var(--muted)",
                  fontSize: 13,
                  fontWeight: 500,
                  padding: "8px 14px",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                {o.cancelLabel || "Batal"}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                style={{
                  border: "1px solid " + (danger ? "transparent" : accent),
                  background: danger ? "var(--danger)" : accent,
                  color: danger ? "#fff" : "var(--on-accent)",
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "8px 16px",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                {o.confirmLabel || "Konfirmasi"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
