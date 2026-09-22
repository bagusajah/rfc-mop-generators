// Browser-side persistence — a stateless app keeps NO server-side records, so
// this is the entire "storage layer":
//   draft    — the in-progress form, autosaved so a refresh never loses work
//   riwayat  — the last generated forms (capped), so a Governance rejection can
//              be revised without retyping the whole form
//   JSON in/out — file-level escape hatch for sharing / archiving a form
//
// Each app gets its own keyspace via PREFIX (e.g. "rfc." vs "mop.") so two
// apps served from the same origin never collide. The version suffix stays
// constant; bump it only on a breaking draft-shape change.

const PREFIX = (typeof globalThis !== "undefined" && globalThis.__APP_PREFIX__) || "rfc.";
const DRAFT_KEY = `${PREFIX}form.draft.v1`;
const HIST_KEY  = `${PREFIX}form.history.v1`;
const HIST_MAX  = 20;

/* ── Draft autosave ── */

export function loadDraft() {
  try {
    const v = localStorage.getItem(DRAFT_KEY);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

export function saveDraft(form) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch { /* private mode / quota */ }
}

/* ── Riwayat (generated forms, newest first) ── */

export function loadHistory() {
  try {
    const v = localStorage.getItem(HIST_KEY);
    const arr = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Record a successful generation. Re-generating the same form content (e.g.
// .docx download followed by Google Doc export) updates the existing entry
// instead of duplicating it.
export function pushHistory({ form, kind, link, title }) {
  const list = loadHistory();
  const key  = JSON.stringify(form);
  const now  = new Date().toISOString();
  const idx  = list.findIndex((e) => JSON.stringify(e.form) === key);
  const prev = idx >= 0 ? list.splice(idx, 1)[0] : null;
  list.unshift({
    id: prev?.id || crypto.randomUUID(),
    savedAt: now,
    title: title || form.title || "(tanpa judul)",
    kinds: [...new Set([...(prev?.kinds || []), kind])],
    link: link || prev?.link || "",
    form,
  });
  const capped = list.slice(0, HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(capped)); } catch { /* ignore */ }
  return capped;
}

export function removeHistory(id) {
  const capped = loadHistory().filter((e) => e.id !== id);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(capped)); } catch { /* ignore */ }
  return capped;
}

/* ── Form JSON export / import ── */

export function downloadFormJson(form, { fallbackName = "form" } = {}) {
  const name = (form.title || fallbackName).replace(/[\/\\:*?"<>|]+/g, " ").trim().slice(0, 100);
  const url = URL.createObjectURL(new Blob([JSON.stringify(form, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readFormJson(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Gagal membaca file"));
    r.onload = () => {
      try {
        const obj = JSON.parse(r.result);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("bukan objek form");
        resolve(obj);
      } catch (e) { reject(new Error(`File bukan JSON form yang valid (${e.message})`)); }
    };
    r.readAsText(file);
  });
}
