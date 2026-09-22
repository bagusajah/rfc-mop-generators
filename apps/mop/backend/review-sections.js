// Per-section review definitions for MOP. Section ids/labels/order/fields/
// context are single-sourced in apps/mop/mop-schema.js (REVIEW_SECTIONS); this
// table adds the prompt-only metadata (rubric, whether to include corpus
// examples). The review runs one focused LLM call per section, strictly in
// sequence.
import { REVIEW_SECTIONS } from "../mop-schema.js";
import { rulePromptBlock } from "./review-checks.js";

// Language rule, shared across every MOP LLM prompt: respond in Bahasa
// Indonesia, keep standard technical/governance/security jargon in English.
export const LANG_RULE = "Jawab dalam Bahasa Indonesia formal. Istilah teknis, governance, dan security yang lazim dipakai dalam Bahasa Inggris (mis. rollback, downtime, production environment, security group, compensating control, compliance, encryption, load balancer, command line, evidence, maintenance window, serta nama produk/sistem) BOLEH tetap dalam Bahasa Inggris — jangan paksa menerjemahkannya ke Bahasa Indonesia yang malah janggal atau ambigu.";

const PROMPT_META = {
  tujuan: {
    useExamples: true,
    rubric: `FOKUS: Tujuan & ruang lingkup.
1. Tujuan jelas: hasil yang ingin dicapai setelah prosedur selesai — bukan sekadar mengulang judul.
2. Ruang lingkup membatasi prosedur: in-scope dan out-of-scope eksplisit. Ruang lingkup yang terlalu luas/tak jelas berisiko eksekusi melebar.
3. Sistem terpengaruh dan ringkasan dampak selaras dengan tujuan (area "Konsistensi"). Dampak harus menyebutkan jenis (degradasi/outage/tidak ada) dan durasi.`,
  },
  prasyarat: {
    useExamples: true,
    rubric: `FOKUS: Prasyarat & pre-check.
1. Prasyarat mencakup hal yang HARUS dipenuhi SEBELUM eksekusi: backup/snapshot tersedia, kapasitas target, akses granted, notifikasi terkirim, sistem sehat (green-state).
2. Setiap prasyarat punya kriteria lolos yang terukur — bisa diverifikasi (bukan asumsi). Prasyarat kritis untuk rollback (mis. snapshot DB, free storage) WAJIB eksplisit.
3. Pemverifikasi (owner) diisi untuk prasyarat yang membutuhkan orang spesifik.`,
  },
  prosedur: {
    // No examples here on purpose: corpus step arrays are large, and on local
    // reasoning models the extra material reliably blows the per-call deadline.
    useExamples: false,
    rubric: `FOKUS: Prosedur eksekusi (inti MOP).
1. Setiap langkah WAJIB punya aksi (apa yang dilakukan) dan hasil harapan (output/indikator sukses langkah ini). Langkah tanpa keduanya tidak executable.
2. Perintah (command) harus tepat dan siap tempel — bukan deskripsi naratif. Bila perintah berbahaya (hapus resource), pastikan ada langkah verifikasi sebelumnya.
3. SETIAP langkah berphase Eksekusi WAJIB punya aksi rollback (cara mengubah langkah tersebut bila gagal). Ini inti dari MOP yang reversible — tandai bila ada langkah eksekusi tanpa rollback.
4. Pengelompokan via kolom Tahap (Pre-check → Eksekusi → Verifikasi → Rollback → Sign-off); urutan logis dan berurutan.
5. Target sistem dan PIC diisi agar eksekusi terdistribusi jelas.`,
  },
  verifikasi: {
    useExamples: true,
    rubric: `FOKUS: Verifikasi & kriteria penerimaan.
1. Kriteria konkret dan terukur: cek apa yang dijalankan pasca-eksekusi untuk membuktikan MOP berhasil (mis. "utilisasi storage 40TB", "query test normal", "tidak ada alert 30 menit").
2. Metode menjelaskan BAGAIMANA mengukur kriteria; target menyebutkan nilai/rentang yang berarti lolos.
3. Kriteria harus cukup untuk menyatakan MOP selesai & sukses, bukan sekadar "eksekusi selesai tanpa error".`,
  },
  rollback: {
    useExamples: false,
    rubric: `FOKUS: Rencana rollback.
1. Deadline keputusan rollback adalah wall-clock yang konkret (mis. "03:30 WIB" atau "T-30 menit sebelum window selesai") — bukan samar seperti "nanti jika perlu".
2. Pemicu rollback spesifik dan observable: langkah gagal, alert/KPI keluar batas, error tak terduga. Hindari pemicu generik ("bila ada masalah").
3. Deadline harus masuk akal terhadap window (tidak boleh setelah window selesai); pemicu harus sejalan dengan langkah dan kriteria verifikasi di konteks.`,
  },
  bahasa: {
    useExamples: false,
    rubric: `FOKUS: Bahasa & penulisan — sapuan typo atas teks form di bawah.
1. Laporkan typo HANYA dengan pasangan persis "salah" → "benar" di issue. Tanpa pasangan persis yang Anda yakini, JANGAN laporkan.
2. JANGAN menandai nama produk/sistem/istilah teknis/command yang memang ditulis begitu (mis. nama database, nama tools, command CLI seperti kubectl, grep) dan JANGAN melaporkan preferensi gaya sebagai kesalahan.
3. Ejaan Bahasa Indonesia baku dan konsisten; hindari bahasa informal/singkatan chat.
Area "Bahasa", severity "info" — "warn" hanya bila salah tulisnya mengubah makna teknis (nama host, angka, command, deadline).`,
  },
};

export const SECTIONS = Object.fromEntries(REVIEW_SECTIONS.map((s) => [s.id, {
  fields: s.fields,
  context: s.context,
  patchable: s.fields,
  ...PROMPT_META[s.id],
}]));

// Shared reviewer preamble: role, output contract, severity meanings, patch rules.
const PREAMBLE = `Anda adalah reviewer MOP (Method of Procedure) di perusahaan — gerbang yang menyetujui prosedur sebelum dijalankan selama maintenance window. Anda meninjau SATU bagian form per permintaan. Tugas Anda: menemukan apa pun di bagian ini yang akan menyebabkan MOP DIKEMBALIKAN untuk revisi (atau berisiko gagal/gagal rollback saat eksekusi), agar engineer memperbaikinya sebelum window. Bila kutipan Company IT Policy diberikan di bawah, itu adalah SUMBER KEBENARAN.

Kembalikan HANYA JSON:
{
  "findings": [ { "severity": "block"|"warn"|"info", "area": "Governance"|"Security"|"Konsistensi"|"Bahasa", "issue": string, "fix": string, "patch": { "field": string, "value": <nilai pengganti> } | null } ]
}
"block" = pasti dikembalikan reviewer / berisiko eksekusi gagal; "warn" = berisiko ditanya/revisi; "info" = saran penguat. Jika bagian ini sudah baik, kembalikan {"findings": []}. Tulis issue & fix spesifik dan langsung bisa dikerjakan. ${LANG_RULE}

Aturan "patch" (perbaikan yang bisa diterapkan satu klik):
- Sertakan "patch" HANYA bila perbaikannya konkret dan Anda yakin; jika ragu, set null dan jelaskan di "fix".
- "field" = nama field PERSIS seperti pada JSON "Bagian yang ditinjau". JANGAN membuat patch untuk field konteks.
- "value" = nilai pengganti UTUH untuk field itu; untuk field array kirim ARRAY LENGKAP yang sudah diperbaiki.
- Untuk field array: jumlah elemen hasil TIDAK BOLEH berkurang, kecuali issue-nya memang menghapus duplikat.
- JANGAN sertakan patch yang nilainya sama dengan nilai saat ini.
- Pertahankan semua isi yang sudah benar — patch memperbaiki masalah, bukan menulis ulang gaya.`;

const slice = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? ""]));

export function buildSectionPrompt(f, sectionId, examples = [], policyHits = []) {
  const sec = SECTIONS[sectionId];
  const exampleKeys = ["title", "affected_systems", ...sec.fields];
  const parts = [];
  if (sec.useExamples) {
    parts.push(examples.length
      ? `Contoh MOP sebelumnya (acuan gaya & kelengkapan untuk bagian ini):\n${JSON.stringify(examples.map((e) => slice(e, exampleKeys.filter((k) => e?.[k] !== undefined))), null, 2)}`
      : "Belum ada contoh MOP sebelumnya — gunakan praktik SRE & ops yang baik.");
    parts.push("");
  }
  if (policyHits.length) {
    const sources = [...new Set(policyHits.map((h) => h.source))].join(", ");
    parts.push(`Kutipan Company IT Policy terkait bagian ini (sumber: ${sources}) — jadikan acuan utama:\n${policyHits.map((h) => h.text).join("\n---\n")}`);
    parts.push("");
  }
  const rules = rulePromptBlock(f, sectionId);
  if (rules) { parts.push(rules, ""); }
  parts.push('Bagian yang ditinjau (nama field di JSON ini = nama yang dipakai di "patch"):');
  parts.push(JSON.stringify(slice(f, sec.fields), null, 2));
  if (sec.context.length) {
    parts.push("");
    parts.push("Konteks (hanya referensi — JANGAN membuat patch untuk field ini):");
    parts.push(JSON.stringify(slice(f, sec.context), null, 2));
  }
  return {
    system: `${PREAMBLE}\n\n${sec.rubric}`,
    user: parts.join("\n"),
  };
}

// Sanity: every shared section id has a definition here and vice versa.
for (const { id } of REVIEW_SECTIONS) {
  if (!SECTIONS[id]) throw new Error(`mop review-sections.js is missing section "${id}"`);
}
for (const id of Object.keys(SECTIONS)) {
  if (!REVIEW_SECTIONS.some((s) => s.id === id)) throw new Error(`mop REVIEW_SECTIONS is missing section "${id}"`);
}
