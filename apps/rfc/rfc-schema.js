// Single source of truth for the RFC record shape, enums, and the security
// requirement list. Imported by both backend/ (ajv validation) and frontend/
// (dropdown options). tools/apply_template.py remains the template-side
// authority for .docx wording and already prints drift warnings; this list is
// the app-side authority and the two must match.

export const SEC_REQUIREMENTS = [
  "Tidak menggunakan IP Publik langsung",
  "Menggunakan bastion host, bukan koneksi langsung",
  "Tidak mengekspos RDP/SSH ke Internet (0.0.0.0/0)",
  "Tidak membuka SSH atau management port atau non-standar port ke Internet (0.0.0.0/0)",
  "Menggunakan SSH key-based login, bukan password-based",
  "Tidak diberikan akses ke internet (outbound)",
  "Penerapan WAF sebagai layer security pertama",
];

export const ENUMS = {
  urgensi: ["Low", "Medium", "High", "Critical"],
  riskLevel: ["Low", "Medium", "High"],
  klasifikasi: ["Minor", "Major"],
  secStatus: ["Dapat Dipenuhi", "Tidak Dapat Dipenuhi", "Tidak Relevan"], // template wording: "Tidak Relevan" for N/A
  // Tasklist/rollback phase section headers (rendered as grey merged rows).
  taskPhase: ["Pengecekan Awal/Persiapan", "Pengerjaan Inti", "Testing + Capture Evidence", "Approval", "Review/Evaluasi"],
  changeType: [
    "Storage expansion", "Compute resize / scaling", "Network / ACL / firewall",
    "DNS record change", "Security patching", "SSL / certificate / DNS",
    "DB optimization / tuning", "DB schema change", "Data fix / correction",
    "Access / workflow mgmt", "Migration / provisioning", "Decommission / deletion",
    "OSS / NAS / object storage", "Backup / DR", "Kubernetes / container", "Other",
  ],
};

// Top-level grouping above changeType, derived from a review of the full
// historical corpus (~70 approved RFCs, Nov 2025 – Jun 2026) — see
// RFC/KATEGORI.md for the per-RFC classification and boundary decisions.
// Derived (not stored): records keep only changeType; category is computed,
// so no form field and no data migration.
export const CATEGORIES = [
  "Kapasitas & Skalabilitas",
  "Koreksi Data & Operasi Aplikasi",
  "Lifecycle Infrastruktur",
  "Keamanan, Patching & Upgrade",
  "Jaringan & Konektivitas",
  "Perubahan Basis Data",
  "Konfigurasi Aplikasi & Workflow",
  "Backup, DR & Maintenance",
  "Lainnya",
];

export const CATEGORY_OF = {
  "Storage expansion":          "Kapasitas & Skalabilitas",
  "Compute resize / scaling":   "Kapasitas & Skalabilitas",
  "Data fix / correction":      "Koreksi Data & Operasi Aplikasi",
  "Migration / provisioning":   "Lifecycle Infrastruktur",
  "Decommission / deletion":    "Lifecycle Infrastruktur",
  "OSS / NAS / object storage": "Lifecycle Infrastruktur",
  "Kubernetes / container":     "Lifecycle Infrastruktur",
  "Security patching":          "Keamanan, Patching & Upgrade",
  "SSL / certificate / DNS":    "Keamanan, Patching & Upgrade",
  "Network / ACL / firewall":   "Jaringan & Konektivitas",
  "DNS record change":          "Jaringan & Konektivitas",
  "DB optimization / tuning":   "Perubahan Basis Data",
  "DB schema change":           "Perubahan Basis Data",
  "Access / workflow mgmt":     "Konfigurasi Aplikasi & Workflow",
  "Backup / DR":                "Backup, DR & Maintenance",
  "Other":                      "Lainnya",
};

// Accepts a record or a changeType string; unknown/empty → "Lainnya".
export const categoryOf = (v) => {
  const ct = typeof v === "string" ? v : (v && v.changeType) || "";
  return CATEGORY_OF[ct] || "Lainnya";
};

// The 16 changeType values grouped under their category, in CATEGORIES'
// frequency order — feeds the "Jenis Perubahan" dropdown's <optgroup>s so the
// picker surfaces the same corpus-derived taxonomy exampleScore() already
// uses for grounding. Derived, not hand-picked, so it can't drift from
// CATEGORY_OF; a category with no members (shouldn't happen today) is
// dropped rather than rendered empty.
export const CHANGE_TYPE_GROUPS = CATEGORIES
  .map((label) => ({ label, items: ENUMS.changeType.filter((ct) => categoryOf(ct) === label) }))
  .filter((g) => g.items.length);

// Indonesian month names + date formatter. Shared so the backend (.docx
// output) and the frontend (on-screen preview/dashboard) render dates
// identically. ISO (YYYY-MM-DD) → "29 Juni 2026"; anything else (already
// formatted, or freeform) passes through unchanged.
export const ID_MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                          "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export const formatDateID = (s) => {
  const str = String(s || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return str;
  return `${parseInt(m[3], 10)} ${ID_MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
};

// Day-of-week name derived from the execution date — the date is the ground
// truth, so this replaces a manually-picked "Hari" that can silently drift
// out of sync with it (mismatched or left blank). ISO (YYYY-MM-DD) → "Kamis".
export const ID_DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const dayNameID = (s) => {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return ID_DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
};

// "Lama estimasi pengerjaan" derived from the tasklist — the wall-clock span
// from the earliest task start to the latest task end (each "waktu" row is a
// "HH:MM-HH:MM" range). Rows without a recognisable range are ignored.
// Maintenance windows often cross midnight (e.g. 23:30-00:30), so times are
// normalised to be monotonic in row order (rows are chronological — it's a
// runbook): whenever a time goes backwards, it rolled into the next day.
export const estimasiFromTasks = (tasks) => {
  const ranges = (Array.isArray(tasks) ? tasks : [])
    .map((t) => [...String(t?.waktu || "").matchAll(/(\d{1,2}):(\d{2})/g)].map((m) => (+m[1]) * 60 + (+m[2])))
    .filter((times) => times.length >= 2)
    .map((times) => [times[0], times[times.length - 1]]);
  if (!ranges.length) return "";
  // Starts may legitimately overlap (parallel tasks), so only roll to the next
  // day when a START goes backwards vs the previous start, or when a range's
  // end precedes its own start (that range crosses midnight).
  let offset = 0, prevStart = -1;
  for (const r of ranges) {
    if (r[0] + offset < prevStart) offset += 24 * 60;
    r[0] += offset;
    if (r[1] + offset < r[0]) offset += 24 * 60;
    r[1] += offset;
    prevStart = r[0];
  }
  const start = ranges[0][0];
  const end   = Math.max(...ranges.map((r) => r[1]));
  const total = end - start;
  if (total <= 0) return "";
  const h = Math.floor(total / 60), m = total % 60;
  if (h && m) return `${h} jam ${m} menit`;
  if (h) return `${h} jam`;
  return `${m} menit`;
};

/* ── Rule checks (shared by the form UI and the backend review) ── */

// Normalise a stored pemenuhan value to { status, reason }.
// Accepts the object shape and the legacy "Ya"/"Tidak"/"N/A" strings.
export const secCell = (v) => {
  if (v && typeof v === "object") return { status: v.status || "", reason: v.reason || "" };
  return { status: typeof v === "string" ? v : "", reason: "" };
};
export const secFilled = (v) => {
  const c = secCell(v);
  return !!(c.status.trim() || c.reason.trim());
};

// A reason is mandatory only when the requirement is NOT met as-is —
// "Dapat Dipenuhi" needs no justification, the other two always do.
export const secReasonRequired = (status) =>
  status === "Tidak Dapat Dipenuhi" || status === "Tidak Relevan";

// Row indexes (1-based, for display) whose required reason is still empty.
export const secMissingReasons = (f) =>
  SEC_REQUIREMENTS
    .map((_, i) => ({ i, c: secCell((f.sec_requirements || [])[i]) }))
    .filter(({ c }) => secReasonRequired(c.status) && !c.reason.trim())
    .map(({ i }) => i + 1);

// The 8 deterministic governance checks shown in the form's checklist panel;
// the backend review reports failures as findings and tells the LLM they are
// already covered.
export function govCheck(f) {
  return [
    { id: 1, label: "Deskripsi perubahan",      ok: !!f.description?.trim() },
    { id: 2, label: "Sistem & pihak terpengaruh", ok: !!(f.sistem_terpengaruh?.trim() || f.komponen?.length) },
    { id: 3, label: "Urgensi & jadwal lengkap",  ok: !!(f.urgensi && (f.execDate || f.jadwal_hari) && f.jadwal_jam && f.jadwal_estimasi && f.jadwal_downtime?.trim() && f.jadwal_pulih?.trim()) },
    { id: 4, label: "Risk register & mitigasi",  ok: (f.risks?.length ?? 0) > 0 && !!f.mitigasi?.trim() },
    { id: 5, label: "Klasifikasi perubahan",     ok: !!f.klasifikasi },
    { id: 6, label: "Tasklist dengan PIC",       ok: (f.tasks?.length ?? 0) > 0 && f.tasks.every(t => t.pic?.trim()) },
    { id: 7, label: "Rencana rollback tersedia", ok: (f.rollback?.length ?? 0) > 0 },
    { id: 8, label: "Security requirement diisi", ok: (f.sec_requirements || []).some(secFilled) && secMissingReasons(f).length === 0 },
  ];
}

// Komponen entries whose first word never appears in the description — a hint
// the scope and the narrative drifted apart.
export function scopeWarnings(f) {
  if (!f.komponen?.length || !f.description) return [];
  return f.komponen.filter(k => {
    const kw = k.toLowerCase().split(/[\s/,]+/)[0];
    return kw.length > 2 && !f.description.toLowerCase().includes(kw);
  });
}

/* ── Review sections ──
   The review runs one focused LLM call per section, strictly in sequence.
   This list is the single source for section ids, labels, order, and which
   form fields each section covers — the frontend loops it (and uses
   fields+context to know when a section's content changed, for incremental
   re-review) and the backend keys its rubrics/patchable lists by the same
   fields (backend/review-sections.js; check-review.mjs asserts they stay in
   sync). `context` = fields shown to the LLM read-only, never patched. */
export const REVIEW_SECTIONS = [
  { id: "deskripsi",  label: "Deskripsi & tujuan",
    fields: ["title", "description", "tujuan"], context: ["system", "changeType"] },
  { id: "dampak",     label: "Sistem terpengaruh & komponen",
    fields: ["sistem_terpengaruh", "komponen"], context: ["system", "description"] },
  { id: "jadwal",     label: "Urgensi & jadwal",
    fields: ["urgensi", "jadwal_hari", "jadwal_jam", "jadwal_estimasi", "jadwal_downtime", "jadwal_pulih", "execDate"], context: ["description", "tasks"] },
  { id: "risiko",     label: "Risiko, mitigasi & klasifikasi",
    fields: ["risks", "mitigasi", "klasifikasi"], context: ["description"] },
  { id: "pengerjaan", label: "Tasklist & rollback",
    fields: ["tasks", "rollback"], context: ["description", "executor"] },
  { id: "security",   label: "Security requirement",
    fields: ["sec_requirements", "alasan_pengecualian", "compensating_control"], context: ["description", "tasks"] },
  { id: "bahasa",     label: "Bahasa & penulisan",
    fields: ["title", "description", "tujuan", "sistem_terpengaruh", "mitigasi", "alasan_pengecualian", "compensating_control"],
    context: [] },
];

// Deterministic verdict + one-sentence summary over a findings list. Replaces
// the LLM-written summary: both the legacy /api/review aggregator and the
// frontend's per-section loop compose their result through this.
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

// A handful of prose fields (title, description, tujuan, sistem_terpengaruh,
// mitigasi, alasan_pengecualian, compensating_control — see the "bahasa"
// section above) are patchable by BOTH their content section and "bahasa"
// (typo sweep). Every section is prompted against the same form snapshot, so
// two independent full-field patches for the same field are never composed —
// applying both would let whichever is applied second silently discard the
// first. Keep only the first finding's patch per field (content sections run
// before "bahasa" in REVIEW_SECTIONS order, so a substantive fix wins over a
// same-field typo-only rewrite); later duplicates fall back to advisory-only
// (their issue/fix text still shows, just without a one-click "Terapkan").
export function dedupeCrossSectionPatches(findings) {
  const seen = new Set();
  return (findings || []).map((x) => {
    if (!x.patch) return x;
    if (seen.has(x.patch.field)) return { ...x, patch: null };
    seen.add(x.patch.field);
    return x;
  });
}

// Nullable string shortcut. Optional text fields accept null OR "" OR a string.
const strOrNull = { type: ["string", "null"] };
// Enum that also tolerates empty + null so an in-progress draft saves cleanly.
const lenientEnum = (vals) => ({ type: ["string", "null"], enum: [...vals, "", null] });

// "Sistem terdampak" is an array of strings today; legacy corpus/draft records
// still have it as a single string, so both shapes validate.
const systemField = { type: ["array", "string", "null"], items: { type: "string" } };

// ajv-ready JSON Schema for a full RFC record (the form, plus the corpus of
// historical examples the LLM grounds in).
// Lenient policy:
//   - Known fields are type/enum-checked; nothing is required (an in-progress
//     draft validates at any stage of filling).
//   - Unknown extra fields are KEPT (additionalProperties not forbidden) so
//     legacy corpus records (status/ticket/docLink from the tracker era) and
//     forward-compatible fields pass unchanged.
//   - Legacy field names (kemungkinan/dampak/tingkat) and legacy string-form
//     sec_requirements entries are accepted alongside the canonical shapes.
export const RFC_RECORD_SCHEMA = {
  type: "object",
  properties: {
    // identity / meta (corpus records; the form itself has no identity)
    id: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },

    // header
    system: systemField,
    title: { type: "string" },
    changeType: lenientEnum(ENUMS.changeType),
    description: strOrNull,
    executor: strOrNull,
    requester: strOrNull,
    execDate: strOrNull,
    urgensi: lenientEnum(ENUMS.urgensi),
    tujuan: strOrNull,

    // schedule
    jadwal_hari: strOrNull,
    jadwal_jam: strOrNull,
    jadwal_estimasi: strOrNull,
    // Pre-implementation notice per Kebijakan Operasional TI VII.4.G.h: users
    // affected by a change must be told the expected downtime and when the
    // service is back — kept separate from jadwal_estimasi (work duration).
    jadwal_downtime: strOrNull,
    jadwal_pulih: strOrNull,

    // affected parties / components
    sistem_terpengaruh: strOrNull,
    komponen: { type: "array", items: { type: "string" } },

    // risk register + mitigation
    risks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          risiko: strOrNull,
          likelihood: lenientEnum(ENUMS.riskLevel),
          impact: lenientEnum(ENUMS.riskLevel),
          risk_level: lenientEnum(ENUMS.riskLevel),
          // legacy Indonesian field names — still accepted, bridged at render time
          kemungkinan: strOrNull,
          dampak: strOrNull,
          tingkat: strOrNull,
        },
      },
    },
    mitigasi: strOrNull,
    klasifikasi: lenientEnum(ENUMS.klasifikasi),

    // security requirements — accept new {status, reason} OR legacy string
    sec_requirements: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              status: lenientEnum(ENUMS.secStatus),
              reason: strOrNull,
            },
          },
          { type: "string" }, // legacy "Ya" / "Tidak" / "N/A"
        ],
      },
    },

    // tasklist + rollback
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase: strOrNull,   // section header (e.g. "Pengerjaan Inti"); groups rows
          waktu: strOrNull,
          pengerjaan: strOrNull,
          pic: strOrNull,
        },
      },
    },
    rollback: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase: strOrNull,
          waktu: strOrNull,
          pengerjaan: strOrNull,
          pic: strOrNull,
        },
      },
    },

    // testing exceptions
    alasan_pengecualian: strOrNull,
    compensating_control: strOrNull,

    // sign-off — "Disusun oleh" is the executor (single); reviewers ("Direview
    // oleh") and approvers ("Disetujui oleh") are dynamic lists of {name, title}.
    prepared_title: strOrNull,
    reviewers: {
      type: "array",
      items: {
        type: "object",
        properties: { name: strOrNull, title: strOrNull },
      },
    },
    approvers: {
      type: "array",
      items: {
        type: "object",
        properties: { name: strOrNull, title: strOrNull },
      },
    },
    // legacy fixed sign-off fields — still accepted, bridged at render time
    prepared_name: strOrNull, prepared_date: strOrNull,
    reviewer1_name: strOrNull, reviewer1_date: strOrNull, reviewer1_title: strOrNull,
    reviewer2_name: strOrNull, reviewer2_date: strOrNull, reviewer2_title: strOrNull,
    approver1_name: strOrNull, approver1_date: strOrNull, approver1_title: strOrNull,
    approver2_name: strOrNull, approver2_date: strOrNull, approver2_title: strOrNull,

    // optional page-header echoes
    nomor_dokumen: strOrNull,
    tanggal_permintaan: strOrNull,
    target_penyelesaian: strOrNull,
    departemen: strOrNull,
    nama_pemohon: strOrNull,
  },
};

// POST /api/draft — one-line intent → AI draft request.
export const DRAFT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string" },
    system: systemField,
    changeType: lenientEnum(ENUMS.changeType),
    executor: { type: "string" },
    examples: { type: "array" },
  },
};

// POST /api/review/import — current record + raw IT Governance & Security
// feedback text (pasted, or read from an uploaded .csv/.txt) → findings.
export const IMPORT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    record: { type: "object" },
    feedback: { type: "string" },
  },
};
