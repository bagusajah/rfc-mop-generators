// Domain data for the RFC form: reference lists, the blank form shape,
// governance checks, and the dynamic-table column definitions.
import { SEC_REQUIREMENTS, ENUMS, CHANGE_TYPE_GROUPS } from "../rfc-schema.js";

/* ── Reference data ── */

// Canonical system list — datalist suggestions for the free-text system field,
// not a strict enum; users can type a system that isn't listed here. Empty by
// default — fill in with your team's system names.
export const SYSTEMS = [];

export const EXECUTORS = [
  { name: "Engineer SRE 1", team: "SRE" },
  { name: "Engineer SRE 2", team: "SRE" },
  { name: "Engineer DBA 1", team: "DBA" },
];
export const teamOf = (name) => (EXECUTORS.find((e) => e.name === name) || {}).team;

// Grouped view of the 16 changeType values (see apps/rfc/rfc-schema.js for how
// the categories were derived from the historical corpus) — re-exported here
// so RfcForm.jsx imports form-data.js exclusively for reference data.
export { CHANGE_TYPE_GROUPS };
export const URGENSI      = ENUMS.urgensi;
export const RISK_LEVELS  = ENUMS.riskLevel;
export const KLASIFIKASI  = ENUMS.klasifikasi;
export const TASK_PHASES  = ENUMS.taskPhase;
export const SEC_STATUS   = ENUMS.secStatus;
export const DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

/* ── Blank form ── */

export const BLANK = {
  system: [], title: "", changeType: "", description: "",
  executor: "", requester: "Information & Digital Technology",
  execDate: "",
  urgensi: "Medium", tujuan: "",
  jadwal_hari: "", jadwal_jam: "", jadwal_estimasi: "",
  jadwal_downtime: "", jadwal_pulih: "",
  sistem_terpengaruh: "",
  komponen: [],
  risks: [], mitigasi: "", klasifikasi: "",
  sec_requirements: SEC_REQUIREMENTS.map(() => ({ status: "", reason: "" })),
  tasks: [], rollback: [],
  alasan_pengecualian: "", compensating_control: "",
  prepared_title: "Engineer",
  reviewers: [
    { name: "", title: "Reviewer 1" },
    { name: "", title: "Reviewer 2" },
  ],
  approvers: [
    { name: "Approver 1", title: "Approver" },
    { name: "Approver 2", title: "Approver" },
  ],
};

// New forms prefill the pelaksana with whoever generated last — on this
// internal tool that's almost always the same person filling a row of RFCs.
export const newBlank = () => ({
  ...BLANK,
  executor: localStorage.getItem("rfc.lastExecutor") || "",
});

// `system` used to be a single free-text string; drafts/riwayat saved before
// the multi-system change may still have that shape in localStorage — fold
// it into an array here, the one place form state enters the app.
export const normalizeSystem = (f) => ({
  ...f,
  system: Array.isArray(f.system) ? f.system : (f.system ? [f.system] : []),
});

/* ── Security-requirement cell helpers & governance checks ──
   Moved to rfc-schema.js so the backend review applies the exact same
   rules; re-exported here so existing imports keep working. */

export {
  secCell, secFilled, secReasonRequired, secMissingReasons,
  govCheck, scopeWarnings,
} from "../rfc-schema.js";

export function calcRiskLevel(likelihood, impact) {
  const lvl = { Low: 0, Medium: 1, High: 2 };
  const s = (lvl[likelihood] ?? 0) + (lvl[impact] ?? 0);
  return s <= 1 ? "Low" : s === 2 ? "Medium" : "High";
}

export const riskTransform = (row) => ({
  ...row,
  risk_level: calcRiskLevel(row.likelihood, row.impact),
});

// Apply one {field, value} patch to form state — the same whole-field-
// replacement normalisation a hand-typed value gets, shared by every patch
// source (Tinjau findings, imported Governance feedback, chat). Array fields
// need their per-row shape/derived columns recomputed (risk_level, the
// sec_requirements padding to a fixed length) rather than trusting the raw
// patch value verbatim.
export function applyFieldPatch(setF, field, value) {
  let v = value;
  if (Array.isArray(v)) {
    if (field === "risks") v = v.map(riskTransform);
    if (field === "sec_requirements") {
      v = v.map(secCell);
      while (v.length < SEC_REQUIREMENTS.length) v.push({ status: "", reason: "" });
    }
    if (field === "komponen") v = v.map((s) => String(s ?? "").trim()).filter(Boolean);
  } else {
    v = v ?? "";
  }
  setF((p) => ({ ...p, [field]: v }));
}

/* ── Dynamic-table column definitions ── */

export const RISK_COLS = [
  { key: "risiko",      label: "Risiko",       flex: "2fr" },
  { key: "likelihood",  label: "Kemungkinan",  flex: "1fr", options: RISK_LEVELS },
  { key: "impact",      label: "Dampak",       flex: "1fr", options: RISK_LEVELS },
  { key: "risk_level",  label: "Tingkat",      flex: "80px", readOnly: true },
];

export const TASK_COLS = [
  { key: "phase",      label: "Tahap",       flex: "1.2fr", options: TASK_PHASES },
  { key: "waktu",      label: "Waktu",       flex: "1fr" },
  { key: "pengerjaan", label: "Pengerjaan",  flex: "2fr" },
  { key: "pic",        label: "PIC",         flex: "1fr" },
];

export const ROLLBACK_COLS = [
  { key: "phase",      label: "Tahap",             flex: "1.2fr", options: TASK_PHASES },
  { key: "waktu",      label: "Waktu",             flex: "1fr" },
  { key: "pengerjaan", label: "Langkah rollback",  flex: "2fr" },
  { key: "pic",        label: "PIC",               flex: "1fr" },
];

export const SIGNATORY_COLS = [
  { key: "name",  label: "Nama",    flex: "1fr" },
  { key: "title", label: "Jabatan", flex: "1fr" },
];
