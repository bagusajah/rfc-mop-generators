// Lightweight toast system.
//
// Usage:
//   const toast = useToast();
//   toast.success("Saved");
//   toast.error("Something went wrong: " + err.message);
//   toast.info("Regenerated");
//
// Mount <ToastProvider> once near the root. The stack renders fixed top-right,
// is theme-aware (uses the same CSS custom properties as the rest of the app),
// and is screen-reader friendly: success/info use role="status" (polite),
// errors use role="alert" (assertive). Auto-dismiss after `duration` ms.

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

const ToastCtx = createContext(null);

const DURATION = 4000;
const MAX_STACK = 5;

const VARIANTS = {
  success: {
    role: "status",
    icon: CheckCircle2,
    accent: "var(--success-icon)",
    bg: "var(--success-panel)",
    border: "var(--success-border)",
    fg: "var(--success-fg)",
  },
  error: {
    role: "alert",
    icon: AlertCircle,
    accent: "var(--danger)",
    bg: "var(--danger-bg)",
    border: "var(--line)",
    fg: "var(--danger-fg-strong)",
  },
  info: {
    role: "status",
    icon: Info,
    accent: "var(--info-dot)",
    bg: "var(--card)",
    border: "var(--line)",
    fg: "var(--ink)",
  },
};

let _id = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  // Mirror of `toasts` for duplicate checks inside stable callbacks. Updated
  // synchronously in push/dismiss — waiting for a re-render would let two
  // identical toasts pushed in the same tick both pass the dedupe check.
  const listRef = useRef([]);

  const dismiss = useCallback((id) => {
    listRef.current = listRef.current.filter((t) => t.id !== id);
    setToasts(listRef.current);
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((variant, message, opts = {}) => {
    // Dedupe: re-pushing an identical visible toast returns the existing one.
    const dup = listRef.current.find((t) => t.variant === variant && t.message === message);
    if (dup) return dup.id;
    const id = ++_id;
    const duration = opts.duration ?? DURATION;
    const next = [...listRef.current, { id, variant, message }];
    listRef.current = next.length > MAX_STACK ? next.slice(next.length - MAX_STACK) : next;
    setToasts(listRef.current);
    if (duration > 0) {
      const handle = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    }
    return id;
  }, [dismiss]);

  // Stable identity: consumers hold `toast` in hook deps (e.g. App's refresh
  // effect); a fresh object per render would re-trigger those effects on every
  // toast and could loop error → toast → re-render → error forever.
  const api = useMemo(() => ({
    success: (msg, opts) => push("success", msg, opts),
    error:   (msg, opts) => push("error",   msg, { duration: 0, ...opts }), // errors persist until dismissed
    info:    (msg, opts) => push("info",    msg, opts),
    dismiss,
  }), [push, dismiss]);

  // Clean up any lingering timers on unmount.
  useEffect(() => () => {
    timers.current.forEach((h) => clearTimeout(h));
    timers.current.clear();
  }, []);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 1000,
          maxWidth: "min(92vw, 380px)",
        }}
      >
        {toasts.map((t) => {
          const v = VARIANTS[t.variant] || VARIANTS.info;
          const Icon = v.icon;
          return (
            <div
              key={t.id}
              role={v.role}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                background: v.bg,
                border: `1px solid ${v.border}`,
                color: v.fg,
                fontSize: 13,
                lineHeight: 1.45,
                boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
              }}
            >
              <Icon size={16} style={{ color: v.accent, flexShrink: 0, marginTop: 1 }} />
              <span style={{ flex: 1, wordBreak: "break-word" }}>{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Tutup notifikasi"
                className="icon-btn-sm"
                style={{ color: "var(--muted)", marginTop: -2, marginRight: -4 }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
