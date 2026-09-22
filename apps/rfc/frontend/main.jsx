// RFC app entry point. Wires the shared AppShell to the RFC form + config.
import React from "react";
import { Server } from "lucide-react";
import { mountApp } from "../../../packages/core/frontend/mountApp.jsx";
import AppShell from "../../../packages/core/frontend/AppShell.jsx";
import { AppProvider } from "../../../packages/core/frontend/app-context.js";
import RfcForm from "./RfcForm.jsx";
import { BLANK, newBlank, normalizeSystem } from "./form-data.js";
import { REVIEW_SECTIONS, govCheck, scopeWarnings } from "../rfc-schema.js";

// The localStorage namespace (globalThis.__APP_PREFIX__ = "rfc.") is set in
// index.html — it must exist before this module graph evaluates, because
// localStore.js / use-theme.js read it at import time (i.e. before any
// statement in this file runs).

// A form counts as "started" when any meaningful field differs from blank —
// used to confirm before replacing it (Form baru / restore from riwayat).
const isStarted = (f) =>
  !!(f.title || f.description || f.tujuan || f.system?.length || f.changeType
     || f.risks?.length || f.tasks?.length || f.rollback?.length || f.komponen?.length);

const config = {
  title: "Form Permintaan Perubahan",
  subtitle: "Isi manual atau draft dengan AI → tinjau → unduh .docx / Google Doc",
  HeaderIcon: Server,
  blank: BLANK,
  newBlank,
  normalize: normalizeSystem,
  isStarted,
};

// Inject RFC's domain hooks into the shared core UI (components.jsx).
const appValue = { REVIEW_SECTIONS, govCheck, scopeWarnings };

mountApp(
  document.getElementById("root"),
  <AppProvider value={appValue}>
    <AppShell config={config} renderForm={({ form, setForm, onGenerated }) => (
      <RfcForm f={form} setF={setForm} onGenerated={onGenerated} />
    )} />
  </AppProvider>
);
