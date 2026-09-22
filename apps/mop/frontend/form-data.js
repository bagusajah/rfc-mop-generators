// Domain data for the MOP form: reference lists, the blank form shape, and the
// dynamic-table column definitions. The step table (STEP_COLS) is the heart of
// the document — plan + execution-log + per-step rollback, so the generated
// .docx doubles as the execution record an engineer fills in during the window.
import { ENUMS } from "../mop-schema.js";
import { ACCENT, WARN_FG, mono } from "../../../packages/core/frontend/tokens.js";

/* ── Reference data ── */

// Canonical system list — datalist suggestions for the free-text system field,
// not a strict enum; users can type a system not listed here. Empty by
// default — fill in with your team's system names.
export const SYSTEMS = [];

// Sites / datacenter locations a MOP executes at.
export const SITES = [
  "DC Utama (Primary)", "DC Cadangan (DR)", "Cloud (Alibaba)", "On-prem", "Lainnya",
];

export const EXECUTORS = [
  { name: "Engineer SRE 1", team: "SRE" },
  { name: "Engineer SRE 2", team: "SRE" },
  { name: "Engineer DBA 1", team: "DBA" },
];
export const teamOf = (name) => (EXECUTORS.find((e) => e.name === name) || {}).team;

export const TIMEZONES = ["WIB (UTC+7)", "WITA (UTC+8)", "WIT (UTC+9)", "UTC"];

export const STEP_PHASES  = ENUMS.stepPhase;
export const STEP_STATUS  = ENUMS.stepStatus;
export const APPROVAL_TYPES    = ENUMS.approvalType;
export const APPROVAL_DECISIONS = ENUMS.approvalDecision;

/* ── Blank form ── */

export const BLANK = {
  title: "", mop_id: "", author: "", site: "",
  requester_dept: "Information & Digital Technology",
  purpose: "", in_scope: [], out_of_scope: [],
  affected_systems: [], impact_summary: "", dependencies: [],
  window_start: "", window_end: "", impact_start: "", impact_end: "",
  timezone: "WIB (UTC+7)",
  prerequisites: [],
  steps: [],
  verification: [],
  rollback_deadline: "", rollback_triggers: "",
  approvals: [
    { type: "Technical review", signer: "", role: "Reviewer", decision: "pending", at: "", comment: "" },
    { type: "Business approval", signer: "Approver 1", role: "Approver", decision: "pending", at: "", comment: "" },
  ],
};

// New forms prefill the author with whoever generated last.
export const newBlank = () => ({
  ...BLANK,
  author: localStorage.getItem("mop.lastAuthor") || "",
});

/* ── Security-requirement helpers & governance checks ──
   Re-exported from mop-schema.js so the backend review applies the exact same
   rules; imported here so the form UI has a single import for reference data. */
export { govCheck, scopeWarnings } from "../mop-schema.js";

/* ── Dynamic-table column definitions ── */

// The MOP step table — plan + execution-log + per-step rollback. Wide, so it
// scrolls horizontally on narrow screens. Grouped by phase when rendered.
// `rollback_action` is the structural fix: every EXECUTION step needs an undo.
export const STEP_COLS = [
  { key: "step_no",         label: "No",            flex: "44px" },
  { key: "phase",           label: "Tahap",         flex: "1.1fr", options: STEP_PHASES },
  { key: "action",          label: "Aksi",          flex: "1.6fr" },
  { key: "command",         label: "Perintah",      flex: "1.8fr", cellStyle: { ...mono, color: ACCENT } },
  { key: "expected_result", label: "Hasil harapan", flex: "1.4fr" },
  { key: "target_system",   label: "Sistem target", flex: "1fr" },
  { key: "duration_min",    label: "Durasi (mnt)",  flex: "0.7fr" },
  { key: "owner",           label: "PIC",           flex: "0.8fr" },
  { key: "rollback_action", label: "Aksi rollback", flex: "1.4fr", cellStyle: { color: WARN_FG } },
  // execution-log columns (filled during the window):
  { key: "status",          label: "Status",        flex: "0.9fr", options: STEP_STATUS },
  { key: "actual_result",   label: "Hasil aktual",  flex: "1.2fr" },
  { key: "executed_by",     label: "Dieksekusi oleh", flex: "0.8fr" },
];

// Prerequisite / pre-check checklist: what to verify before execution begins.
export const PREREQ_COLS = [
  { key: "description",   label: "Yang dicek",     flex: "2fr" },
  { key: "pass_criteria", label: "Kriteria lolos", flex: "2fr" },
  { key: "owner",         label: "Pemverifikasi",  flex: "1fr" },
];

// End-state verification & acceptance criteria.
export const VERIFY_COLS = [
  { key: "criterion", label: "Kriteria",   flex: "1.6fr" },
  { key: "method",    label: "Metode",     flex: "1.6fr" },
  { key: "target",    label: "Target",     flex: "1.2fr" },
  { key: "owner",     label: "Pemverifikasi", flex: "1fr" },
];

// Multi-gate sign-offs. `decision` is a select (approved/rejected/pending);
// the rest are free text. The lean default ships 2 rows; users add more.
export const APPROVAL_COLS = [
  { key: "type",     label: "Gate",      flex: "1.2fr", options: APPROVAL_TYPES },
  { key: "signer",   label: "Penandatangan", flex: "1.2fr" },
  { key: "role",     label: "Jabatan",   flex: "1.4fr" },
  { key: "decision", label: "Keputusan", flex: "1fr", options: APPROVAL_DECISIONS },
  { key: "comment",  label: "Catatan",   flex: "1.6fr" },
];
