import { useState, useEffect, useCallback } from "react";

// Theme keys: "light" | "dark". Persisted to localStorage under THEME_KEY.
// On first visit (no stored value), falls back to the OS color scheme.
// The key is namespaced per app via globalThis.__APP_PREFIX__ (e.g. "rfc." vs
// "mop.") so two apps on the same origin keep independent theme choices.
const THEME_KEY = `${(globalThis.__APP_PREFIX__) || "rfc."}theme`;
const DARK_CLASS = "dark";

function systemPrefersDark() {
  return typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Read the effective theme: stored choice, else OS preference.
export function readTheme() {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark() ? "dark" : "light";
}

// Apply a theme to <html>. Called before React mounts (index.html inline
// script) to avoid a flash, and again from the hook on changes.
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add(DARK_CLASS);
  else root.classList.remove(DARK_CLASS);
}

export function useTheme() {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS preference live, but only while the user hasn't chosen.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!localStorage.getItem(THEME_KEY)) setTheme(systemPrefersDark() ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

// Expose the resolved storage key so index.html's inline pre-paint script can
// read the same key before React mounts (it can't import this module yet).
export const themeStorageKey = () => THEME_KEY;
