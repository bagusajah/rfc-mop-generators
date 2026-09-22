// Deterministic pre-review checks for MOP, mapped to the 8-point govCheck.
// Completeness gaps get advisory findings (no sensible auto-write); the
// rollback-readiness check (every execution step needs a rollback_action) is
// the load-bearing one — it's what makes a MOP executable & reversible.
import { govCheck, scopeWarnings } from "../mop-schema.js";

// Issue/fix wording per failed govCheck item. `section` = the review section
// (REVIEW_SECTIONS id) each check belongs to.
const GOV_FINDING = {
  1: { area: "Governance", section: "tujuan",
       issue: "Tujuan atau ruang lingkup (dalam/luar) masih kosong.",
       fix: "Isi tujuan (hasil yang dicapai) dan sebutkan apa yang in-scope / out-of-scope." },
  2: { area: "Governance", section: "tujuan",
       issue: "Sistem terpengaruh atau ringkasan dampak belum diisi.",
       fix: "Sebutkan sistem yang terpengaruh dan ringkasan dampaknya (degradasi/outage + durasi)." },
  3: { area: "Governance", section: "tujuan",
       issue: "Maintenance window belum lengkap (window/dampak mulai-selesai, atau zona waktu kosong).",
       fix: "Lengkapi window mulai/selesai, dampak mulai/selesai, dan zona waktu." },
  4: { area: "Governance", section: "prasyarat",
       issue: "Prasyarat & pre-check belum diisi.",
       fix: "Tambahkan minimal satu prasyarat (apa yang dicek sebelum eksekusi, dengan kriteria lolos)." },
  5: { area: "Governance", section: "prosedur",
       issue: "Ada langkah tanpa aksi atau tanpa hasil harapan.",
       fix: "Lengkapi setiap langkah: aksi (apa yang dilakukan) dan hasil harapan (indikator sukses langkah ini)." },
  6: { area: "Security", section: "prosedur",
       issue: "Ada langkah eksekusi tanpa aksi rollback.",
       fix: "Setiap langkah berphase Eksekusi WAJIB punya aksi rollback (cara mengubah langkah tersebut bila gagal)." },
  7: { area: "Governance", section: "verifikasi",
       issue: "Kriteria verifikasi belum diisi.",
       fix: "Tambahkan minimal satu kriteria verifikasi (cek pasca-eksekusi yang membuktikan MOP berhasil)." },
  8: { area: "Governance", section: "rollback",
       issue: "Deadline atau pemicu rollback belum diisi.",
       fix: "Isi deadline keputusan rollback (wall-clock) dan pemicu rollback (kondisi yang memaksa rollback)." },
};

export const RULE_SECTION = Object.fromEntries(
  Object.entries(GOV_FINDING).map(([id, t]) => [id, t.section]),
);

// Failed deterministic checks as review findings.
export function ruleFindings(f) {
  const out = [];
  for (const c of govCheck(f)) {
    if (c.ok) continue;
    const t = GOV_FINDING[c.id];
    out.push({ severity: "block", area: t.area, section: t.section, issue: t.issue, fix: t.fix, patch: null, rule: c.id });
  }
  const drift = scopeWarnings(f);
  if (drift.length) {
    out.push({
      severity: "warn", area: "Konsistensi", section: "tujuan",
      issue: `Sistem ${drift.map((k) => `"${k}"`).join(", ")} tidak disinggung di tujuan MOP.`,
      fix: "Sebut sistem tersebut di tujuan, atau keluarkan dari daftar sistem terpengaruh bila memang di luar scope.",
      patch: null,
    });
  }
  return out;
}

export const ruleFindingsFor = (f, sectionId) =>
  ruleFindings(f).filter((x) => x.section === sectionId);

// The "Hasil cek otomatis" block for a section's LLM prompt: which of ITS
// checks passed and which are already reported, so the model doesn't repeat them.
export function rulePromptBlock(f, sectionId) {
  const checks = govCheck(f).filter((c) => GOV_FINDING[c.id].section === sectionId);
  if (!checks.length) return "";
  const passed = checks.filter((c) => c.ok).map((c) => c.label);
  const failed = checks.filter((c) => !c.ok).map((c) => c.label);
  const lines = ["Hasil cek otomatis (deterministik):"];
  if (passed.length) lines.push(`- Lolos: ${passed.join("; ")}.`);
  if (failed.length) lines.push(`- Gagal & SUDAH dilaporkan sebagai finding: ${failed.join("; ")}.`);
  lines.push(
    "JANGAN mengulangi hasil cek di atas sebagai finding. Fokus pada substansi yang tidak bisa dicek mesin: kualitas dan konsistensi isi, bukan sekadar terisi.",
  );
  return lines.join("\n");
}
