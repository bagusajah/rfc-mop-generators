// Declarative form schema for the MOP form body — the source of truth for the
// FormEngine's section/field layout. Rendered by the shared FormEngine in
// packages/core/frontend.
//
// 9 sections, lean + execution-focused, ordered the way an engineer reads a
// MOP: what it is → what it touches → when → pre-checks → the procedure →
// verification → rollback plan → sign-off.
import {
  ClipboardList, Target, Server, CalendarClock, CheckSquare,
  ListChecks, Crosshair, RotateCcw, PenSquare,
} from "lucide-react";
import {
  SYSTEMS, SITES, TIMEZONES, EXECUTORS,
  STEP_COLS, PREREQ_COLS, VERIFY_COLS, APPROVAL_COLS,
} from "./form-data.js";
import { rollbackStatus } from "../mop-schema.js";
import { WARN_BG, WARN_FG, SUCCESS_BG, SUCCESS_FG } from "../../../packages/core/frontend/tokens.js";

export const MOP_FORM_SCHEMA = [
  /* ── 1. Identitas ── */
  {
    id: "identitas", anchorId: "sec-identitas", icon: ClipboardList, label: "Identitas",
    fields: [
      { key: "title", kind: "text", fieldId: "field-title",
        label: "Judul MOP", required: true,
        placeholder: "cth: Perluasan storage database 35TB → 40TB" },
      { key: "mop_id", kind: "text",
        label: "Nomor MOP",
        hint: "Opsional — biasanya diberikan saat disetujui. Kosongkan bila belum ada.",
        placeholder: "cth: MOP-2026-014" },
      { kind: "group", cols: 2, fields: [
        { key: "author", kind: "text", fieldId: "field-author",
          label: "Penyusun (SME)", required: true, datalist: "executor-list",
          hint: "Engineer yang menyusun dan/atau menjalankan prosedur ini.",
          placeholder: "Pilih atau ketik nama…" },
        { key: "site", kind: "select", label: "Lokasi / site", options: SITES },
      ]},
      { key: "requester_dept", kind: "text",
        label: "Departemen pemohon",
        placeholder: "Information & Digital Technology" },
    ],
  },

  /* ── 2. Tujuan & Ruang Lingkup ── */
  {
    id: "tujuan", anchorId: "sec-tujuan", icon: Target, label: "Tujuan & Ruang Lingkup",
    fields: [
      { key: "purpose", kind: "textarea",
        label: "Tujuan", minHeight: 90,
        hint: "Hasil yang ingin dicapai setelah prosedur ini selesai dijalankan.",
        placeholder: "Tujuan dijalankannya MOP ini…" },
      { key: "in_scope", kind: "taginput", fieldId: "field-scope",
        label: "Dalam ruang lingkup",
        hint: "Apa yang termasuk dalam prosedur ini — satu poin per baris.",
        placeholder: "cth: perluasan storage, validasi kapasitas" },
      { key: "out_of_scope", kind: "taginput",
        label: "Di luar ruang lingkup",
        hint: "Apa yang TIDAK termasuk — batasi agar eksekusi tetap terfokus.",
        placeholder: "cth: migrasi data historis, perubahan aplikasi" },
    ],
  },

  /* ── 3. Sistem Terpengaruh ── */
  {
    id: "sistem", anchorId: "sec-sistem", icon: Server, label: "Sistem & Dampak Terpengaruh",
    fields: [
      { key: "affected_systems", kind: "taginput", fieldId: "field-system",
        label: "Sistem terpengaruh", required: true, options: SYSTEMS,
        placeholder: "Pilih atau ketik sistem…" },
      { key: "impact_summary", kind: "textarea",
        label: "Ringkasan dampak", minHeight: 80, required: true,
        hint: "Dampak yang diharapkan: degradasi / outage / tidak ada, dan berapa lama.",
        placeholder: "cth: Layanan X mengalami downtime ±5 menit selama cut-over; pengguna akan diberi tahu sebelumnya." },
      { key: "dependencies", kind: "taginput",
        label: "Dependensi",
        hint: "Sistem/upstream lain yang bergantung pada sistem ini, atau yang prosedur ini andalkan.",
        placeholder: "cth: Aplikasi core, replikasi DR" },
    ],
  },

  /* ── 4. Maintenance Window ── */
  {
    id: "window", anchorId: "sec-window", icon: CalendarClock, label: "Maintenance Window",
    fields: [
      { kind: "group", cols: 2, fields: [
        { key: "window_start", kind: "datetime", label: "Window mulai", required: true },
        { key: "window_end",   kind: "datetime", label: "Window selesai", required: true },
        { key: "impact_start", kind: "datetime", label: "Dampak mulai",
          hint: "Subset window saat layanan benar-benar terdegradasi (biasanya lebih sempit)." },
        { key: "impact_end",   kind: "datetime", label: "Dampak selesai" },
      ]},
      { key: "timezone", kind: "select", label: "Zona waktu", required: true, options: TIMEZONES },
    ],
  },

  /* ── 5. Prasyarat & Pre-check ── */
  {
    id: "prasyarat", anchorId: "sec-prasyarat", icon: CheckSquare, label: "Prasyarat & Pre-check",
    fields: [
      { key: "prerequisites", kind: "rowtable", columns: PREREQ_COLS,
        addLabel: "Tambah prasyarat",
        hint: "Yang HARUS dipenuhi/dicek SEBELUM eksekusi: backup, kapasitas, akses, notifikasi, kesehatan sistem.",
        minWidth: 560 },
    ],
  },

  /* ── 6. Prosedur (the step table) ── */
  {
    id: "prosedur", anchorId: "sec-prosedur", icon: ListChecks, label: "Prosedur Eksekusi",
    badge: (f) => {
      const { total, missing } = rollbackStatus(f);
      if (!total) return null;
      return missing
        ? { label: `${missing} tanpa rollback`, style: { background: WARN_BG, color: WARN_FG } }
        : { label: "Rollback lengkap", style: { background: SUCCESS_BG, color: SUCCESS_FG } };
    },
    fields: [
      { key: "steps", kind: "rowtable", columns: STEP_COLS, addLabel: "Tambah langkah",
        hint: "Setiap langkah eksekusi WAJIB punya aksi, hasil harapan, DAN aksi rollback. Kolom status/hasil aktual/dieksekusi oleh diisi saat window berjalan.",
        minWidth: 1180 },
    ],
  },

  /* ── 7. Verifikasi & Penerimaan ── */
  {
    id: "verifikasi", anchorId: "sec-verifikasi", icon: Crosshair, label: "Verifikasi & Kriteria Penerimaan",
    fields: [
      { key: "verification", kind: "rowtable", columns: VERIFY_COLS, addLabel: "Tambah kriteria",
        hint: "Cek pasca-eksekusi yang membuktikan MOP berhasil — terukur (mis. 'utilisasi 40TB', 'query test normal', 'tidak ada alert 30 menit').",
        minWidth: 620 },
    ],
  },

  /* ── 8. Rollback ── */
  {
    id: "rollback", anchorId: "sec-rollback", icon: RotateCcw, label: "Rencana Rollback",
    fields: [
      { key: "rollback_deadline", kind: "text",
        label: "Deadline keputusan rollback", required: true,
        hint: "Wall-clock: bila belum sukses pada saat ini, eksekusi dihentikan dan rollback dijalankan.",
        placeholder: "cth: 03:30 WIB (T-30 menit sebelum window selesai)" },
      { key: "rollback_triggers", kind: "textarea",
        label: "Pemicu rollback", minHeight: 80, required: true,
        hint: "Kondisi yang memaksa rollback segera — langkah gagal, alert/kpi keluar batas, error tak terduga.",
        placeholder: "cth:\n- Langkah gagal dan tidak bisa dimitigasi dalam 5 menit\n- Error rate layanan naik > 1%\n- Replication lag tidak pulih dalam 10 menit" },
    ],
  },

  /* ── 9. Pengesahan (multi-gate) ── */
  {
    id: "pengesahan", anchorId: "sec-pengesahan", icon: PenSquare, label: "Pengesahan",
    fields: [
      { key: "approvals", kind: "rowtable", columns: APPROVAL_COLS, addLabel: "Tambah gate",
        hint: "Sebuah MOP ditandatangani di beberapa gate berbeda (technical review, business approval, dst). Tambah/tambah sesuai kebutuhan.",
        minWidth: 760 },
    ],
  },
];

// Datalists referenced by the schema (by id).
export const MOP_DATALISTS = {
  "executor-list": EXECUTORS.map((e) => e.name),
};
