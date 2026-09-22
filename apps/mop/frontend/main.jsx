// MOP app entry point. Wires the shared AppShell to the MOP form + config.
import React from "react";
import { ClipboardList } from "lucide-react";
import { mountApp } from "../../../packages/core/frontend/mountApp.jsx";
import AppShell from "../../../packages/core/frontend/AppShell.jsx";
import { AppProvider } from "../../../packages/core/frontend/app-context.js";
import MopForm from "./MopForm.jsx";
import { BLANK, newBlank } from "./form-data.js";
import { REVIEW_SECTIONS, govCheck, scopeWarnings } from "../mop-schema.js";

// Namespace this app's localStorage keys (draft / history / theme) so MOP and
// RFC served from the same origin never collide.
globalThis.__APP_PREFIX__ = "mop.";

const ARRAY_KEYS = Object.keys(BLANK).filter((k) => Array.isArray(BLANK[k]));

// A MOP counts as "started" when any meaningful field differs from blank.
const isStarted = (f) =>
  !!(f.title || f.purpose || f.affected_systems?.length
     || f.steps?.length || f.prerequisites?.length || f.in_scope?.length);

const config = {
  title: "Method of Procedure",
  subtitle: "Isi → tinjau AI → unduh .docx / Google Doc",
  HeaderIcon: ClipboardList,
  blank: BLANK,
  newBlank,
  // Backfill/coerce fields from an older draft (localStorage/JSON import
  // predating a schema field, or carrying a stale non-array value for one) so
  // every array-shaped field (steps, verification, …) is trustworthy from
  // here on — govCheck/rollbackStatus/RowTable all assume that.
  normalize: (f) => {
    const merged = { ...BLANK, ...f };
    for (const k of ARRAY_KEYS) if (!Array.isArray(merged[k])) merged[k] = BLANK[k];
    return merged;
  },
  isStarted,
};

// Section nav pills — MOP's 9 form sections with a govCheck completion dot
// each (checks[i] = govCheck id i+1). Overrides the core's default nav layout.
const navItems = (checks) => [
  { id: "sec-identitas", label: "Identitas",    ok: null },
  { id: "sec-tujuan",    label: "Tujuan",       ok: checks[0].ok },
  { id: "sec-sistem",    label: "Sistem",       ok: checks[1].ok },
  { id: "sec-window",    label: "Window",       ok: checks[2].ok },
  { id: "sec-prasyarat", label: "Prasyarat",    ok: checks[3].ok },
  { id: "sec-prosedur",  label: "Prosedur",     ok: checks[4].ok && checks[5].ok },
  { id: "sec-verifikasi", label: "Verifikasi",  ok: checks[6].ok },
  { id: "sec-rollback",  label: "Rollback",     ok: checks[7].ok },
  { id: "sec-pengesahan", label: "Pengesahan",  ok: null },
];

// Review panel: review-section id → form anchor. "bahasa" has no single anchor
// (it sweeps every text field) so it's intentionally absent.
const sectionAnchor = {
  tujuan: "sec-tujuan", prasyarat: "sec-prasyarat", prosedur: "sec-prosedur",
  verifikasi: "sec-verifikasi", rollback: "sec-rollback",
};

// Inject MOP's domain hooks into the shared core UI (components.jsx).
const appValue = { REVIEW_SECTIONS, govCheck, scopeWarnings, navItems, sectionAnchor };

mountApp(
  document.getElementById("root"),
  <AppProvider value={appValue}>
    <AppShell config={config} renderForm={({ form, setForm, onGenerated }) => (
      <MopForm f={form} setF={setForm} onGenerated={onGenerated} />
    )} />
  </AppProvider>
);
