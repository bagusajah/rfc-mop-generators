// Maps a stored RFC record to the flat placeholder data the .docx template
// expects. Kept separate from server.js so it can be unit/fixture-tested
// without booting the HTTP server.
import { formatDateID, dayNameID } from "../rfc-schema.js";
import { buildSignoffXml } from "../../../packages/core/backend/signoff-xml.js";
import { markItalicTerms as I } from "../../../packages/core/backend/italic-terms.js";

// Security "Pemenuhan" value → display string.
// Accepts the structured shape { status, reason } and the legacy "Ya"/"Tidak"/
// "N/A" strings, so old saved records still render.
export function secText(v) {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  const status = (v.status || "").trim();
  const reason = (v.reason || "").trim();
  if (status && reason) return `${status} — ${reason}`;
  return status || reason;
}

const dateOnly = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : (s || ""));

// formatDateID ("29 Juni 2026") is imported from apps/rfc/rfc-schema.js so the
// .docx output and the on-screen preview format dates identically.
const todayISO = () => new Date().toISOString().slice(0, 10);

// Build the signatory list for a sign-off loop. Uses the dynamic array when the
// record has one; otherwise falls back to the legacy fixed fields. Rows with
// neither a name nor a title are dropped (an empty slot adds nothing).
// Group tasklist/rollback rows into phase sections for the {#task_groups} loop.
// Consecutive rows sharing a phase form one section; a missing phase defaults to
// "Pengerjaan Inti" (the core-work phase) so every section has a header row.
const groupByPhase = (list) => {
  const groups = [];
  for (const t of Array.isArray(list) ? list : []) {
    const group_label = String(t?.phase || "").trim() || "Pengerjaan Inti";
    const item = {
      waktu: String(t?.waktu || "").trim(),
      pengerjaan: I(String(t?.pengerjaan || "").trim()),
      pic: String(t?.pic || "").trim(),
    };
    const last = groups[groups.length - 1];
    if (last && last.group_label === group_label) last.items.push(item);
    else groups.push({ group_label, items: [item] });
  }
  return groups;
};

const signatoryList = (arr, legacy) => {
  const src = Array.isArray(arr) && arr.length ? arr : legacy;
  return (src || [])
    .map((s) => ({ name: String(s?.name || "").trim(), title: String(s?.title || "").trim() }))
    .filter((s) => s.name || s.title);
};
// Exported so check-fixture.mjs can compute the expected signatory counts from
// a record exactly the way the sign-off builder sees them.
export const reviewersOf = (r) => signatoryList(r.reviewers, [
  { name: r.reviewer1_name, title: r.reviewer1_title },
  { name: r.reviewer2_name, title: r.reviewer2_title },
]);
export const approversOf = (r) => signatoryList(r.approvers, [
  { name: r.approver1_name, title: r.approver1_title },
  { name: r.approver2_name, title: r.approver2_title },
]);
const projectName = (t) => String(t || "").replace(/^form\s+permintaan\s+perubahan\s*[-–:]\s*/i, "").trim();

// Render a value as a bulleted list ("● item" per line). Accepts an array, or a
// string with newline- / comma-separated items; strips any existing bullet
// marker so re-running is idempotent. The template renders with linebreaks:true,
// so the "\n"-joined result becomes multiple lines.
const bulletList = (v) => {
  const raw = Array.isArray(v) ? v : String(v || "").split(/\r?\n|·|;/);
  const items = raw.map((s) => String(s).trim().replace(/^[●•\-*▪]\s*/, "")).filter(Boolean);
  return items.map((s) => `● ${s}`).join("\n");
};
// Bullet list, but keep the conventional "-" when there's nothing to list.
const bulletOrDash = (v) => bulletList(v) || "-";

// Render the three urgency levels as checkboxes, the selected one ticked.
// The header has High / Medium / Low; "Critical" maps to High (the top level).
const urgensiBoxes = (u) => {
  const sel = u === "Critical" ? "High" : u;
  return ["High", "Medium", "Low"].map((l) => `${l === sel ? "☑" : "☐"} ${l}`).join("   ");
};

export function recordToTemplateData(r) {
  // Format komponen array as a readable string for the "siapa dan sistem" field
  const sec = (i) => secText(r.sec_requirements?.[i]) || "-";

  return {
    // Page header (repeating block at the top of every page)
    // Left blank on purpose — the governance team assigns the document number
    // after the request is submitted, so it's filled in manually later.
    nomor_dokumen:       r.nomor_dokumen || "",
    tanggal_permintaan:  formatDateID(r.tanggal_permintaan || dateOnly(r.createdAt) || todayISO()),
    nama_proyek:         projectName(r.title) || r.title || "",
    target_penyelesaian: formatDateID(r.target_penyelesaian || r.execDate || ""),
    departemen:          r.departemen || r.requester || "Information & Digital Technology",
    urgensi:             urgensiBoxes(r.urgensi),
    nama_pemohon:        r.nama_pemohon || r.executor || r.requester || "",

    // Body fields
    deskripsi:          I(r.description || ""),
    tujuan:             I(r.tujuan      || ""),

    // Schedule
    jadwal_hari:        dayNameID(r.execDate) || r.jadwal_hari || "",
    jadwal_tanggal:     formatDateID(r.execDate || ""),
    jadwal_jam:         r.jadwal_jam       || "",
    jadwal_estimasi:    I(r.jadwal_estimasi  || ""),
    jadwal_downtime:    I(r.jadwal_downtime  || ""),
    jadwal_pulih:       I(r.jadwal_pulih     || ""),

    // Affected parties / components — TWO separate labeled lists in the one
    // template cell (parties first, then components), never merged into a
    // single bullet run. Labels only when both groups exist (with one group
    // the section header already says what the list is); falls back to the
    // system name when both are empty.
    sistem_terpengaruh: (() => {
      const pihak = bulletList(r.sistem_terpengaruh);
      const komp  = bulletList(r.komponen);
      if (pihak && komp) {
        return I(`Pihak & sistem yang terdampak:\n${pihak}\n\nKomponen yang terpengaruh:\n${komp}`);
      }
      return I(pihak || komp || bulletList(r.system || ""));
    })(),

    // Risk register — bridge old Indonesian field names → template field names
    risks: (r.risks || []).map((row, i) => ({
      no:          String(i + 1),
      risiko:      I(row.risiko      || ""),
      likelihood:  row.likelihood  || row.kemungkinan || "",
      impact:      row.impact      || row.dampak      || "",
      risk_level:  row.risk_level  || row.tingkat     || "",
    })),
    mitigasi:          I(bulletList(r.mitigasi)),
    klasifikasi:       r.klasifikasi  || "Minor",

    // Tasklist & rollback — grouped into phase sections ({#task_groups} loop).
    task_groups:     groupByPhase(r.tasks),
    rollback_groups: groupByPhase(r.rollback),

    // Security requirements (7 fixed checks)
    sec_1: I(sec(0)), sec_2: I(sec(1)), sec_3: I(sec(2)), sec_4: I(sec(3)),
    sec_5: I(sec(4)), sec_6: I(sec(5)), sec_7: I(sec(6)),

    // Testing exceptions — bulleted list, "-" when empty.
    alasan_pengecualian:  I(bulletOrDash(r.alasan_pengecualian)),
    compensating_control: I(bulletOrDash(r.compensating_control)),

    // Sign-off. "Disusun oleh" is the executor (single). Reviewers ("Direview
    // oleh") and approvers ("Disetujui oleh") are dynamic {name, title} lists.
    // The horizontal signature-box tables are built as raw OOXML at render time
    // (signoff-xml.js) and injected via the template's {@signoff} tag, because
    // docxtemplater loops can't produce a dynamic number of columns. Legacy
    // records (reviewer1_*/approver1_*) are bridged so old data still renders.
    signoff: buildSignoffXml({
      prepared: {
        name:  r.executor || "",
        title: r.prepared_title || "Engineer",
      },
      reviewers: reviewersOf(r),
      approvers: approversOf(r),
    }),
  };
}
