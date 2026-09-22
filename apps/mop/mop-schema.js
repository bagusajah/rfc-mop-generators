// Single source of truth for the MOP (Method of Procedure) record shape.
// Imported by both the MOP backend (ajv validation, prompts) and the MOP
// frontend (dropdown options, governance checklist, review sections).
//
// A Method of Procedure is a formal, step-by-step instruction set that
// documents exactly how to execute ONE specific operational task — how to do
// it safely, in what sequence, with what expected outcome at each step, and
// how to undo it if it goes wrong. It is the document an engineer follows in
// real time during a maintenance window, cut-over, or intervention. The same
// document doubles as the execution record: its step rows carry execution-log
// columns (status, actual result, executed by) filled in during the window.
//
// This model is deliberately LEAN (the execution-focused core) and structured
// so ops-metadata sections (risk assessment, communications, escalation
// contacts) can be added later without restructuring what's here.

export const ENUMS = {
  // Step phases — the lifecycle of a procedure within the window. Every step
  // belongs to exactly one phase; the table is grouped by phase when rendered.
  stepPhase: ["Pre-check", "Eksekusi", "Verifikasi", "Rollback", "Sign-off"],
  // Step status — the execution-log column, filled in during the window.
  // "pending" is the plan-time default; the rest are recorded as work happens.
  stepStatus: ["pending", "in_progress", "pass", "fail", "skipped"],
  // Approval gates — a MOP accumulates sign-offs at distinct gates, not one
  // approval. The lean default ships tech_review + business_approval; the rest
  // are available when ops-metadata lands.
  approvalType: [
    "Technical review", "Risk / safety review",
    "Business approval", "Implementation start (go/no-go)", "Completion",
  ],
  approvalDecision: ["approved", "rejected", "pending"],
};

// Indonesian date/time helpers — shared format so .docx output and on-screen
// preview render consistently.
export const ID_MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                          "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export const formatDateID = (s) => {
  const str = String(s || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return str;
  return `${parseInt(m[3], 10)} ${ID_MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
};
export const ID_DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const dayNameID = (s) => {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return ID_DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
};

/* ── Rule checks (shared by the form UI and the backend review) ── */

// The 8 deterministic governance checks for a MOP. These are the completeness
// gates that make a procedure executable: purpose & scope known, affected
// systems + impact stated, a real maintenance window, pre-checks defined,
// every step actionable with an expected result, every EXECUTION step paired
// with a rollback action (the key rollback-readiness check), end-state
// verification criteria, and an explicit rollback decision deadline + trigger.
// Execution-phase steps and how many still lack a rollback_action — the
// single load-bearing rollback-readiness fact. Shared by govCheck (pass/fail)
// and the Prosedur section badge (a live count) so both read one source.
export function rollbackStatus(f) {
  const exec = (f.steps || []).filter((s) => (s.phase || "Eksekusi") === "Eksekusi");
  return { total: exec.length, missing: exec.filter((s) => !s.rollback_action?.trim()).length };
}

export function govCheck(f) {
  const steps = f.steps || [];
  const { total: execTotal, missing: execMissing } = rollbackStatus(f);
  return [
    { id: 1, label: "Tujuan & ruang lingkup",
      ok: !!(f.purpose?.trim() && (f.in_scope?.length || f.out_of_scope?.length)) },
    { id: 2, label: "Sistem terpengaruh & dampak",
      ok: !!(f.affected_systems?.length && f.impact_summary?.trim()) },
    { id: 3, label: "Maintenance window lengkap",
      ok: !!(f.window_start && f.window_end && f.impact_start && f.impact_end && f.timezone?.trim()) },
    { id: 4, label: "Prasyarat & pre-check terisi",
      ok: (f.prerequisites?.length ?? 0) > 0 },
    { id: 5, label: "Setiap langkah punya aksi & hasil harapan",
      ok: steps.length > 0 && steps.every((s) => s.action?.trim() && s.expected_result?.trim()) },
    { id: 6, label: "Setiap langkah eksekusi punya aksi rollback",
      ok: execTotal > 0 && execMissing === 0 },
    { id: 7, label: "Kriteria verifikasi terisi",
      ok: (f.verification?.length ?? 0) > 0 },
    { id: 8, label: "Rollback deadline & pemicu terisi",
      ok: !!(f.rollback_deadline?.trim() && f.rollback_triggers?.trim()) },
  ];
}

// Komponen/sistem yang disebut di affected_systems tapi tidak disinggung di
// ruang lingkup — petunjuk scope dan daftar sistem meleset.
export function scopeWarnings(f) {
  if (!f.affected_systems?.length || !f.purpose) return [];
  return f.affected_systems.filter((s) => {
    const kw = s.toLowerCase().split(/[\s/,]+/)[0];
    return kw.length > 2 && !f.purpose.toLowerCase().includes(kw);
  });
}

/* ── Review sections ──
   One focused LLM call per section, strictly in sequence. Single source for
   section ids, labels, order, and which form fields each covers — the frontend
   loops it and the backend keys its rubrics/patchable lists by the same fields.
   `context` = fields shown to the LLM read-only, never patched. */
export const REVIEW_SECTIONS = [
  { id: "tujuan",     label: "Tujuan & ruang lingkup",
    fields: ["purpose", "in_scope", "out_of_scope"], context: ["affected_systems"] },
  { id: "prasyarat",  label: "Prasyarat & pre-check",
    fields: ["prerequisites"], context: ["purpose", "affected_systems"] },
  { id: "prosedur",   label: "Prosedur (langkah & rollback)",
    fields: ["steps"], context: ["purpose", "author"] },
  { id: "verifikasi", label: "Verifikasi & penerimaan",
    fields: ["verification"], context: ["steps"] },
  { id: "rollback",   label: "Rencana rollback",
    fields: ["rollback_deadline", "rollback_triggers"], context: ["steps"] },
  { id: "bahasa",     label: "Bahasa & penulisan",
    fields: ["purpose", "impact_summary", "rollback_triggers"],
    context: [] },
];

// Deterministic verdict + summary over a findings list.
export function summarizeReview(findings) {
  const n = { block: 0, warn: 0, info: 0 };
  for (const x of findings || []) n[x.severity] = (n[x.severity] || 0) + 1;
  const ready = !n.block;
  const parts = [];
  if (n.block) parts.push(`${n.block} wajib diperbaiki`);
  if (n.warn)  parts.push(`${n.warn} berisiko revisi`);
  if (n.info)  parts.push(`${n.info} saran`);
  const summary = parts.length
    ? `${parts.join(", ")} — ${ready ? "tidak ada blocker, tinjau saran sebelum diajukan." : "perbaiki blocker sebelum diajukan."}`
    : "Tidak ada temuan — siap diajukan.";
  return { ready, summary };
}

// Keep only the first patch per field across sections (content sections run
// before "bahasa" so a substantive fix wins over a same-field typo rewrite).
export function dedupeCrossSectionPatches(findings) {
  const seen = new Set();
  return (findings || []).map((x) => {
    if (!x.patch) return x;
    if (seen.has(x.patch.field)) return { ...x, patch: null };
    seen.add(x.patch.field);
    return x;
  });
}

// ── ajv JSON Schema for a full MOP record. Lenient: known fields type/enum-
// checked, nothing required, unknown props kept (so an in-progress draft
// validates at any stage of filling).
const strOrNull = { type: ["string", "null"] };
const lenientEnum = (vals) => ({ type: ["string", "null"], enum: [...vals, "", null] });
const strArray = { type: "array", items: { type: "string" } };

export const MOP_RECORD_SCHEMA = {
  type: "object",
  properties: {
    // identity / meta (corpus records carry these; the form has no identity)
    id: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },

    // 1. Identitas — MOP stands alone (no parent-change reference field)
    mop_id: strOrNull,        // assigned later, like a document number
    title: { type: "string" },
    author: strOrNull,        // engineer who wrote it (the SME)
    site: strOrNull,          // datacenter / location
    requester_dept: strOrNull,

    // 2. Tujuan & ruang lingkup
    purpose: strOrNull,
    in_scope: strArray,
    out_of_scope: strArray,

    // 3. Sistem terpengaruh
    affected_systems: strArray,
    impact_summary: strOrNull,    // expected degradation/outage + duration
    dependencies: strArray,

    // 4. Maintenance window — structured datetimes (impact_* ⊆ window_*)
    window_start: strOrNull,
    window_end: strOrNull,
    impact_start: strOrNull,
    impact_end: strOrNull,
    timezone: strOrNull,

    // 5. Prasyarat & pre-check — structured checklist
    prerequisites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: strOrNull,    // what to check
          pass_criteria: strOrNull,  // what "pass" looks like
          owner: strOrNull,          // who verifies
        },
      },
    },

    // 6. Prosedur — the step table. Plan + execution log + per-step rollback.
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step_no: { type: ["string", "number", "null"] },
          phase: lenientEnum(ENUMS.stepPhase),
          action: strOrNull,            // what to do (imperative)
          command: strOrNull,           // exact CLI/script/instruction (siap tempel)
          expected_result: strOrNull,   // verifiable success criterion for THIS step
          target_system: strOrNull,
          duration_min: strOrNull,
          owner: strOrNull,             // who executes
          rollback_action: strOrNull,   // per-step undo — the structural fix
          // execution-log columns (filled during the window):
          status: lenientEnum(ENUMS.stepStatus),
          actual_result: strOrNull,
          executed_by: strOrNull,
        },
      },
    },

    // 7. Verifikasi & penerimaan — structured end-state criteria
    verification: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: strOrNull,   // what to prove
          method: strOrNull,      // how to measure it
          target: strOrNull,      // the value/range that means pass
          owner: strOrNull,       // who verifies
        },
      },
    },

    // 8. Rollback — first-class section
    rollback_deadline: strOrNull,        // wall-clock decision deadline
    rollback_triggers: strOrNull,        // what forces rollback

    // 9. Pengesahan — multi-gate sign-offs
    approvals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: lenientEnum(ENUMS.approvalType),
          signer: strOrNull,
          role: strOrNull,
          decision: lenientEnum(ENUMS.approvalDecision),
          at: strOrNull,
          comment: strOrNull,
        },
      },
    },
  },
};

// POST /api/draft — one-line intent → AI draft request.
export const DRAFT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string" },
    affected_systems: strArray,
    author: { type: "string" },
    examples: { type: "array" },
  },
};

// POST /api/review/import — current record + raw feedback text → findings.
export const IMPORT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    record: { type: "object" },
    feedback: { type: "string" },
  },
};
