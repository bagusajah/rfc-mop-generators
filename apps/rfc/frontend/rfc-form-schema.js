// Declarative form schema for the RFC form body — the source of truth for the
// FormEngine's section/field layout.
//
// Each section: { id, anchorId, icon, label, fields: [...] }
// Each field: { key, kind, label, hint?, required?, fieldId?, ...kind-opts }
//   - `key`        the form-state property this field reads/writes
//   - `fieldId`    the DOM id (for scroll-to-error + the <FormNav> anchors)
//   - `kind`       one of: text|textarea|date|time|select|radio|taginput|
//                            rowtable|group|custom
//
// Controller-level UI (AI draft bar, preview aside, review/action panels) is
// NOT here — that stays in RfcForm.jsx since it's workflow, not layout.
import {
  CalendarClock, Server, ShieldAlert, ListChecks, RotateCcw, AlertCircle, User,
} from "lucide-react";
import { CHANGE_TYPE_GROUPS, URGENSI, KLASIFIKASI, DAYS, EXECUTORS, SYSTEMS,
  RISK_COLS, TASK_COLS, ROLLBACK_COLS, SIGNATORY_COLS, riskTransform } from "./form-data.js";
import { URGENSI_STYLE } from "../../../packages/core/frontend/tokens.js";
import { dayNameID } from "../rfc-schema.js";

// The changeType dropdown's optgroups, sourced from the corpus-derived
// taxonomy in rfc-schema.js.
const CHANGE_TYPE_SELECT = { groups: CHANGE_TYPE_GROUPS, placeholder: "Pilih jenis…" };

export const RFC_FORM_SCHEMA = [
  /* ── 1. Identitas Perubahan ──
     The 4 fields "Draft dengan AI" needs before it can run (system,
     changeType, execDate, executor) — every RFC needs these regardless of
     path, so they lead the form; the AI panel renders right after this
     section (see RfcForm.jsx), then the narrative fields AI actually writes
     (title/description/tujuan, below in "info") follow. */
  {
    id: "identitas", anchorId: "sec-identitas", label: "Identitas Perubahan",
    fields: [
      { key: "system", kind: "taginput", fieldId: "field-system",
        label: "Sistem terdampak", required: true, options: SYSTEMS, placeholder: "Pilih atau ketik sistem…" },
      { key: "changeType", kind: "select", fieldId: "field-changetype",
        label: "Jenis perubahan", required: true,
        hint: "Menentukan contoh RFC serupa yang dipakai AI.",
        groups: CHANGE_TYPE_GROUPS, placeholder: "Pilih jenis…" },
      { kind: "group", cols: 2, fields: [
        { key: "executor", kind: "text", fieldId: "field-executor",
          label: "Pelaksana (Nama Pemohon)", required: true, datalist: "executor-list",
          hint: "Pelaksana — namanya menjadi Nama Pemohon di header & 'Disusun oleh'. Pilih atau ketik nama.",
          placeholder: "Pilih atau ketik nama…" },
        { key: "requester", kind: "text",
          label: "Departemen Pemohon",
          hint: "Departemen / tim pemohon (mis. Information & Digital Technology).",
          placeholder: "Information & Digital Technology" },
      ]},
      { key: "execDate", kind: "date", fieldId: "field-execdate",
        label: "Tanggal pelaksanaan", required: true,
        hint: "Wajib diisi sebelum draft AI bisa dibuat.",
        // Hari is derived from the date (ground truth) — keep in lockstep.
        derive: (execDate) => ({ jadwal_hari: dayNameID(execDate) || "" }) },
    ],
  },

  /* ── 2. Informasi Dasar ── */
  {
    id: "info", anchorId: "sec-info", label: "Informasi Dasar",
    fields: [
      { key: "title", kind: "text", fieldId: "field-title",
        label: "Judul RFC", required: true, placeholder: "Ketik judul, atau gunakan Draft AI di atas" },
      { key: "description", kind: "textarea",
        label: "Deskripsi perubahan", minHeight: 110,
        placeholder: "Tulis deskripsi perubahan, atau gunakan Draft AI di atas untuk membuatnya sesuai gaya baku." },
      { key: "tujuan", kind: "textarea",
        label: "Tujuan perubahan", minHeight: 72,
        hint: "Sasaran / tujuan dilakukannya perubahan ini.",
        placeholder: "Tujuan dilakukannya perubahan ini…" },
    ],
  },

  /* ── 3. Urgensi & Jadwal ── */
  {
    id: "urgensi", anchorId: "sec-urgensi", icon: CalendarClock, label: "Urgensi & Jadwal",
    badge: (f) => f.urgensi && { label: f.urgensi, style: URGENSI_STYLE[f.urgensi] },
    fields: [
      { kind: "group", cols: 4, fields: [
        { key: "urgensi", kind: "select", label: "Urgensi", options: URGENSI },
        { key: "jadwal_hari", kind: "select", label: "Hari", options: DAYS, placeholder: "Pilih hari…" },
        { key: "jadwal_jam", kind: "time", label: "Jam mulai" },
        { key: "jadwal_estimasi", kind: "text", label: "Estimasi durasi", placeholder: "e.g. 30 menit" },
        { key: "jadwal_downtime", kind: "text", label: "Estimasi downtime",
          hint: "Wajib diisi eksplisit — kebijakan mewajibkan pengguna terdampak diberi tahu perkiraan downtime sebelum pelaksanaan.",
          placeholder: "e.g. 5 menit, atau 'Tidak ada downtime'" },
        { key: "jadwal_pulih", kind: "text", label: "Layanan pulih pada",
          hint: "Perkiraan waktu layanan bisa digunakan kembali oleh pengguna.",
          placeholder: "e.g. 10:35 WIB" },
      ]},
    ],
  },

  /* ── 4. Siapa & Sistem Terpengaruh ── */
  {
    id: "sistem", anchorId: "sec-sistem", icon: Server, label: "Siapa dan Sistem yang Terpengaruh",
    fields: [
      { key: "sistem_terpengaruh", kind: "textarea",
        label: "Pihak & sistem yang terdampak", minHeight: 80,
        hint: "Siapa saja/pihak-pihak yang terdampak dari perubahan, dan sistem apa saja yang terpengaruh — satu poin per baris. Di dokumen tampil sebagai daftar tersendiri, terpisah dari Komponen di bawah, jadi jangan tulis ulang komponen di sini.",
        placeholder: "Satu poin per baris, mis.\nTim DBA\nLayanan yang menggunakan database ini" },
      { key: "komponen", kind: "taginput",
        label: "Komponen yang terpengaruh",
        hint: "Cukup nama komponen (tanpa detail OS/vCPU/RAM/storage — itu milik kondisi awal/target & tasklist). Di dokumen tampil sebagai daftar terpisah di bawah daftar pihak & sistem.",
        placeholder: "Ketik nama komponen, tekan Enter untuk menambah" },
    ],
  },

  /* ── 5. Analisis Risiko ── */
  {
    id: "risiko", anchorId: "sec-risiko", icon: ShieldAlert, label: "Analisis Risiko Perubahan",
    fields: [
      { key: "risks", kind: "rowtable", columns: RISK_COLS, addLabel: "Tambah risiko", transform: riskTransform },
      { key: "mitigasi", kind: "textarea",
        label: "Mitigasi risiko", minHeight: 72,
        hint: "Satu poin per baris — ditampilkan sebagai daftar berpoin di dokumen.",
        placeholder: "Satu poin per baris, mis.\nValidasi requirement saat persiapan\nMonitoring aktif selama pengerjaan" },
      { key: "klasifikasi", kind: "radio", label: "Klasifikasi perubahan",
        options: KLASIFIKASI.map((k) => ({
          value: k,
          dangerStyle: k === "Major",
          note: k === "Major" ? "(approval sampai Direktur TI)" : null,
        })) },
    ],
  },

  /* ── 6. Security Requirement ── */
  {
    id: "security", anchorId: "sec-security", icon: ShieldAlert, label: "Security Requirement",
    fields: [
      { key: "sec_requirements", kind: "custom", widget: "SecurityGrid" },
    ],
  },

  /* ── 7. Rencana Pengerjaan ── */
  {
    id: "pengerjaan", anchorId: "sec-pengerjaan", icon: ListChecks, label: "Rencana Pengerjaan",
    fields: [
      { key: "tasks", kind: "rowtable", columns: TASK_COLS, addLabel: "Tambah langkah", minWidth: 620 },
    ],
  },

  /* ── 8. Rencana Rollback ── */
  {
    id: "rollback", anchorId: "sec-rollback", icon: RotateCcw, label: "Rencana Rollback",
    fields: [
      { key: "rollback", kind: "rowtable", columns: ROLLBACK_COLS, addLabel: "Tambah langkah rollback", minWidth: 620 },
    ],
  },

  /* ── 9. Pengecualian Pengujian ── */
  {
    id: "pengecualian", anchorId: "sec-pengecualian", icon: AlertCircle, label: "Pengecualian Pengujian",
    fields: [
      { key: "alasan_pengecualian", kind: "textarea",
        label: "Alasan pengecualian pengujian", minHeight: 72,
        hint: "Satu poin per baris — ditampilkan sebagai daftar berpoin. Kosongkan jika tidak ada (akan tampil '-').",
        placeholder: "Satu poin per baris, atau kosongkan" },
      { key: "compensating_control", kind: "textarea",
        label: "Compensating control", minHeight: 72,
        hint: "Satu poin per baris — ditampilkan sebagai daftar berpoin. Kosongkan jika tidak ada (akan tampil '-').",
        placeholder: "Satu poin per baris, atau kosongkan" },
    ],
  },

  /* ── 10. Pengesahan Dokumen ── */
  {
    id: "pengesahan", anchorId: "sec-pengesahan", icon: User, label: "Pengesahan Dokumen",
    fields: [
      { key: "prepared", kind: "custom", widget: "PreparedSignoff",
        label: "Disusun oleh", hint: "Nama mengikuti Pelaksana (Nama Pemohon). Isi jabatannya." },
      { key: "reviewers", kind: "rowtable", columns: SIGNATORY_COLS, addLabel: "Tambah reviewer",
        label: "Direview oleh", hint: "Tambahkan reviewer sesuai kebutuhan — nama & jabatan. Tiap baris menjadi satu kolom tanda tangan." },
      { key: "approvers", kind: "rowtable", columns: SIGNATORY_COLS, addLabel: "Tambah approver",
        label: "Disetujui oleh", hint: "Tambahkan approver sesuai kebutuhan — nama & jabatan." },
    ],
  },
];

// Datalists the schema references (by id). Built once and passed to the
// FormEngine's tools so text fields can render <datalist> suggestions.
// (The system field uses TagInput's own `options` instead — see above.)
export const RFC_DATALISTS = {
  "executor-list": EXECUTORS.map((e) => e.name),
};

// The full set of custom widgets RFC registers with the FormEngine.
export { rfcWidgets } from "./rfc-widgets.jsx";
