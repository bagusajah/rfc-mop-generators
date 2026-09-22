// Maps a stored MOP record to the flat placeholder data the .docx template
// expects. The record→placeholder keys are MOP-native ({purpose}, {in_scope},
// {#prereq_items}, {#step_groups}, {rollback_deadline}, {#approval_groups}) —
// the template mirrors mop-schema.js's own 9 sections, not RFC's shape.
import { formatDateID } from "../mop-schema.js";
import { markItalicTerms as I } from "../../../packages/core/backend/italic-terms.js";

const str = (v) => String(v ?? "").trim();
const dateOnly = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : (s || ""));
const todayISO = () => new Date().toISOString().slice(0, 10);

// "2026-07-25T22:00" (datetime-local input value) → "25 Juli 2026, 22:00".
const formatDateTimeID = (s) => {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return str(s);
  return `${formatDateID(`${m[1]}-${m[2]}-${m[3]}`)}, ${m[4]}:${m[5]}`;
};

// Render a value as a bulleted list ("● item" per line). Accepts an array, or a
// string with newline-separated items; strips any existing bullet marker.
const bulletList = (v) => {
  const raw = Array.isArray(v) ? v : String(v || "").split(/\r?\n|·|;/);
  const items = raw.map((s) => String(s).trim().replace(/^[●•\-*▪]\s*/, "")).filter(Boolean);
  return items.map((s) => `● ${s}`).join("\n");
};
const bulletOrDash = (v) => bulletList(v) || "-";

// Group step rows into phase sections for the {#step_groups} loop. Consecutive
// rows sharing a phase form one section; a missing phase defaults to "Ekseksi".
const groupStepsByPhase = (list) => {
  const groups = [];
  for (const s of Array.isArray(list) ? list : []) {
    const group_label = str(s?.phase) || "Eksekusi";
    const item = {
      step_no: str(s?.step_no),
      action: I(str(s?.action)),
      command: str(s?.command),
      expected_result: I(str(s?.expected_result)),
      target_system: str(s?.target_system),
      duration_min: str(s?.duration_min),
      owner: str(s?.owner),
      rollback_action: I(str(s?.rollback_action)),
      status: str(s?.status),
      actual_result: I(str(s?.actual_result)),
      executed_by: str(s?.executed_by),
    };
    const last = groups[groups.length - 1];
    if (last && last.group_label === group_label) last.items.push(item);
    else groups.push({ group_label, items: [item] });
  }
  return groups;
};

// Group approvals by gate type for the {#approval_groups} loop.
const groupApprovalsByType = (list) => {
  const groups = [];
  for (const a of Array.isArray(list) ? list : []) {
    const group_label = str(a?.type) || "Approval";
    const item = { signer: str(a?.signer), role: str(a?.role), decision: str(a?.decision), comment: I(str(a?.comment)) };
    const last = groups[groups.length - 1];
    if (last && last.group_label === group_label) last.items.push(item);
    else groups.push({ group_label, items: [item] });
  }
  return groups;
};

export function recordToTemplateData(r) {
  return {
    // Header
    mop_id:           r.mop_id || "",
    title:            str(r.title),
    author:           str(r.author),
    site:             str(r.site),
    requester_dept:   str(r.requester_dept) || "Information & Digital Technology",
    tanggal_permintaan: formatDateID(dateOnly(r.createdAt) || todayISO()),

    // Tujuan & ruang lingkup
    purpose:          I(str(r.purpose)),
    in_scope:         I(bulletOrDash(r.in_scope)),
    out_of_scope:     I(bulletOrDash(r.out_of_scope)),

    // Sistem terpengaruh
    affected_systems: I(bulletOrDash(r.affected_systems)),
    impact_summary:   I(str(r.impact_summary)),
    dependencies:     I(bulletOrDash(r.dependencies)),

    // Maintenance window
    window_start: formatDateTimeID(r.window_start),
    window_end:   formatDateTimeID(r.window_end),
    impact_start: formatDateTimeID(r.impact_start),
    impact_end:   formatDateTimeID(r.impact_end),
    timezone:     str(r.timezone),

    // Prasyarat (rows)
    prereq_items: (r.prerequisites || []).map((p, i) => ({
      no: String(i + 1),
      description: I(str(p?.description)),
      pass_criteria: I(str(p?.pass_criteria)),
      owner: str(p?.owner),
    })),

    // Steps grouped by phase ({#step_groups} loop)
    step_groups: groupStepsByPhase(r.steps),

    // Verification (rows)
    verify_items: (r.verification || []).map((v, i) => ({
      no: String(i + 1),
      criterion: I(str(v?.criterion)),
      method: I(str(v?.method)),
      target: str(v?.target),
      owner: str(v?.owner),
    })),

    // Rollback
    rollback_deadline: str(r.rollback_deadline),
    rollback_triggers: I(bulletOrDash(r.rollback_triggers)),

    // Pengesahan — the typed multi-gate approvals list, grouped by gate type
    // ({#approval_groups} loop). MOP has no fixed reviewer/approver pair like
    // RFC; a gate table is the native shape for an arbitrary number of gates.
    approval_groups: groupApprovalsByType(r.approvals),
  };
}
