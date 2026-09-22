// Deterministic pre-review checks. These mirror the form's governance
// checklist (govCheck / secMissingReasons / scopeWarnings — single-sourced in
// apps/rfc/rfc-schema.js) and serve the per-section review two ways:
//   1. failures become guaranteed findings, merged ahead of the LLM's — so the
//      machine-checkable basics never depend on the model noticing them;
//   2. the results are shown to the LLM ("Hasil cek otomatis") so it skips the
//      basics and spends its findings on substance instead.
// They are also a section's whole result when the LLM is unreachable.
import { govCheck, secMissingReasons, scopeWarnings, dayNameID, estimasiFromTasks, REVIEW_SECTIONS } from "../rfc-schema.js";

// Issue/fix wording per failed govCheck item, matching the LLM findings' tone
// (Bahasa Indonesia, spesifik, langsung bisa dikerjakan). `section` is the
// review section (shared REVIEW_SECTIONS id) each check belongs to.
const GOV_FINDING = {
  1: { area: "Governance", section: "deskripsi",
       issue: "Deskripsi perubahan masih kosong.",
       fix: "Isi deskripsi: apa yang diubah, mengapa, dan dari kondisi apa ke kondisi apa." },
  2: { area: "Governance", section: "dampak",
       issue: 'Seksi "Siapa dan Sistem yang Terpengaruh" belum terisi (tidak ada pihak/sistem maupun komponen).',
       fix: "Sebutkan pihak-pihak yang terdampak dan sistem yang terpengaruh, atau isi daftar komponen." },
  3: { area: "Governance", section: "jadwal",
       issue: "Urgensi atau jadwal belum lengkap (hari, jam, estimasi, downtime, atau waktu layanan pulih kosong).",
       fix: "Lengkapi urgensi, hari, jam, lama estimasi pengerjaan, estimasi downtime, dan perkiraan waktu layanan pulih (isi \"Tidak ada downtime\" bila memang tidak ada)." },
  4: { area: "Governance", section: "risiko",
       issue: "Risk register kosong atau mitigasi belum diisi.",
       fix: "Isi minimal satu risiko (dengan likelihood & impact) dan mitigasinya." },
  5: { area: "Governance", section: "risiko",
       issue: "Klasifikasi perubahan (Minor/Major) belum dipilih.",
       fix: "Pilih klasifikasi sesuai kompleksitas dan dampak layanan." },
  6: { area: "Governance", section: "pengerjaan",
       issue: "Tasklist kosong atau ada langkah tanpa PIC.",
       fix: "Isi tasklist dan pastikan setiap langkah punya PIC." },
  7: { area: "Governance", section: "pengerjaan",
       issue: "Rencana rollback belum diisi.",
       fix: "Tambahkan langkah rollback yang benar-benar membatalkan perubahan." },
  8: { area: "Security", section: "security",
       issue: "Security requirement belum terjawab lengkap.",
       fix: "Jawab ke-7 baris security requirement; beri alasan untuk jawaban \"Tidak Dapat Dipenuhi\" / \"Tidak Relevan\"." },
};

export const RULE_SECTION = Object.fromEntries(
  Object.entries(GOV_FINDING).map(([id, t]) => [id, t.section]),
);

// A single tasklist/rollback step that enumerates near-identical items (e.g.
// one subnet per Availability Zone) but reuses the same parenthesised
// identifier for more than one — a copy-paste-through-a-template mistake a
// real IT Governance review flagged as a fatal documentation error (two
// zones given the exact same subnet name). Scoped to WITHIN one step's own
// text (not across unrelated steps) so two rows that legitimately mention
// the same shared resource don't false-positive.
const NAME_TOKEN_RE = /\(([\w.-]{4,})\)/g;
function duplicateNameWarnings(f) {
  const rows = [...(f.tasks || []), ...(f.rollback || [])];
  const out = [];
  for (const row of rows) {
    const text = String(row?.pengerjaan || "");
    const counts = new Map();
    for (const m of text.matchAll(NAME_TOKEN_RE)) {
      const key = m[1].toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const dupeNames = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (dupeNames.length) {
      out.push({
        severity: "warn", area: "Konsistensi", section: "pengerjaan",
        issue: `Langkah "${text.slice(0, 70).trim()}${text.length > 70 ? "…" : ""}" memakai nama yang sama (${dupeNames.map((d) => `"${d}"`).join(", ")}) untuk lebih dari satu item — kemungkinan salah salin nama saat enumerasi (mis. per-zone/per-AZ).`,
        fix: "Berikan nama unik untuk tiap item (mis. akhiran -prod01, -prod02 sesuai zona/AZ).",
        patch: null,
      });
    }
  }
  return out;
}

// English loanword spellings that keep slipping into free-text fields instead
// of their KBBI-standard Indonesian spelling (IT Governance has flagged this
// class of error, e.g. "standard" → "standar"). Checked deterministically
// rather than left to the LLM's judgment, same reasoning as duplicateName-
// Warnings above. Extend this map as more get flagged; keys are matched
// longest-first so "non-standard" wins over the "standard" it contains.
const LOANWORD_FIXES = { "non-standard": "non-standar", "standard": "standar" };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOANWORD_RE = new RegExp(
  `\\b(?:${Object.keys(LOANWORD_FIXES).sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})\\b`,
  "gi",
);
const BAHASA_FIELD_LABELS = {
  title: "Judul RFC", description: "Deskripsi perubahan", tujuan: "Tujuan perubahan",
  sistem_terpengaruh: "Pihak & sistem yang terdampak", mitigasi: "Mitigasi risiko",
  alasan_pengecualian: "Alasan pengecualian pengujian", compensating_control: "Compensating control",
};
function loanwordWarnings(f) {
  const fields = REVIEW_SECTIONS.find((s) => s.id === "bahasa").fields;
  const out = [];
  for (const field of fields) {
    const text = String(f?.[field] || "");
    const seen = new Set();
    for (const m of text.matchAll(LOANWORD_RE)) {
      const wrong = m[0].toLowerCase();
      if (seen.has(wrong)) continue;
      seen.add(wrong);
      const correct = LOANWORD_FIXES[wrong];
      out.push({
        severity: "info", area: "Bahasa", section: "bahasa",
        issue: `${BAHASA_FIELD_LABELS[field] || field} memakai ejaan Inggris "${m[0]}" — ejaan baku Bahasa Indonesia (KBBI) adalah "${correct}".`,
        fix: `Ganti "${m[0]}" menjadi "${correct}".`,
        patch: null,
      });
    }
  }
  return out;
}

// Failed deterministic checks as review findings. Completeness gaps (govCheck,
// scopeWarnings) get {patch: null} — there is nothing sensible to auto-write.
// Drift checks with a known-correct value (e.g. hari/estimasi vs execDate/
// tasks) carry a real patch.
export function ruleFindings(f) {
  const out = [];
  for (const c of govCheck(f)) {
    if (c.ok) continue;
    const t = GOV_FINDING[c.id];
    let issue = t.issue;
    if (c.id === 8) {
      const rows = secMissingReasons(f);
      if (rows.length) issue = `Security requirement baris ${rows.join(", ")} berstatus "Tidak Dapat Dipenuhi"/"Tidak Relevan" tetapi alasannya kosong.`;
    }
    // `rule` = govCheck id; the sanitiser uses it to drop this finding when
    // the LLM reported the same gap anyway (its version may carry a patch).
    out.push({ severity: "block", area: t.area, section: t.section, issue, fix: t.fix, patch: null, rule: c.id });
  }
  const drift = scopeWarnings(f);
  if (drift.length) {
    out.push({
      severity: "warn", area: "Konsistensi", section: "dampak",
      issue: `Komponen ${drift.map((k) => `"${k}"`).join(", ")} tidak disinggung di deskripsi perubahan.`,
      fix: "Sebut komponen tersebut di deskripsi, atau keluarkan dari daftar komponen bila memang di luar scope.",
      patch: null,
    });
  }
  // Hari/estimasi are derivable from execDate/tasks (dayNameID, estimasiFromTasks
  // — same functions the form uses for its defaults). A mismatch means the
  // field was hand-edited out of sync, or execDate/tasks changed after; either
  // way this is exact arithmetic, not judgment, so check it deterministically
  // instead of asking the LLM to do day-of-week/duration math.
  const expectedHari = dayNameID(f.execDate);
  if (expectedHari && f.jadwal_hari && f.jadwal_hari !== expectedHari) {
    out.push({
      severity: "warn", area: "Konsistensi", section: "jadwal",
      issue: `"Hari" terisi "${f.jadwal_hari}" tapi tanggal eksekusi (${f.execDate}) jatuh pada hari ${expectedHari}.`,
      fix: `Ubah "Hari" menjadi "${expectedHari}", atau perbaiki tanggal eksekusi bila salah.`,
      patch: { field: "jadwal_hari", value: expectedHari },
      rule: "jadwal_hari_drift",
    });
  }
  const expectedEstimasi = estimasiFromTasks(f.tasks);
  if (expectedEstimasi && f.jadwal_estimasi && f.jadwal_estimasi !== expectedEstimasi) {
    out.push({
      severity: "warn", area: "Konsistensi", section: "jadwal",
      issue: `"Lama estimasi pengerjaan" terisi "${f.jadwal_estimasi}" tapi rentang waktu di tasklist menunjukkan ${expectedEstimasi}.`,
      fix: `Selaraskan estimasi dengan tasklist (mis. "${expectedEstimasi}"), atau perbaiki rentang waktu tasklist bila salah.`,
      patch: { field: "jadwal_estimasi", value: expectedEstimasi },
      rule: "jadwal_estimasi_drift",
    });
  }
  out.push(...duplicateNameWarnings(f));
  out.push(...loanwordWarnings(f));
  return out;
}

// The rule findings that belong to one review section.
export const ruleFindingsFor = (f, sectionId) =>
  ruleFindings(f).filter((x) => x.section === sectionId);

// The "Hasil cek otomatis" block for a section's LLM prompt: which of ITS
// checks passed and which are already reported, so the model doesn't repeat
// them. Empty string for sections with no deterministic checks (bahasa).
export function rulePromptBlock(f, sectionId) {
  const checks = govCheck(f).filter((c) => GOV_FINDING[c.id].section === sectionId);
  if (!checks.length) return "";
  const passed = checks.filter((c) => c.ok).map((c) => c.label);
  const failed = checks.filter((c) => !c.ok).map((c) => c.label);
  const lines = ["Hasil cek otomatis (deterministik):"];
  if (passed.length) lines.push(`- Lolos: ${passed.join("; ")}.`);
  if (failed.length) {
    lines.push(`- Gagal & SUDAH dilaporkan sebagai finding: ${failed.join("; ")}.`);
  }
  lines.push(
    "JANGAN mengulangi hasil cek di atas sebagai finding. Fokus pada substansi yang tidak bisa dicek mesin: kualitas dan konsistensi isi, bukan sekadar terisi.",
  );
  return lines.join("\n");
}
