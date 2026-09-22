// Per-section review definitions. The review runs one focused LLM call per
// section, strictly in sequence: each call sees a shared reviewer preamble,
// the section's own rubric, only the section's fields (plus labelled
// read-only context), its "Hasil cek otomatis" lines, and — where style
// matters — corpus examples sliced to the section's fields.
//
// Section ids/labels/order/fields/context are single-sourced in
// apps/rfc/rfc-schema.js (REVIEW_SECTIONS) — also consumed by the frontend for
// incremental re-review. This table adds the prompt-only metadata (rubric,
// whether to include corpus examples); `patchable` always equals `fields`
// here, so it's derived rather than duplicated. check-review.mjs asserts
// section ids stay in sync and that `patchable` covers every PATCHABLE field.
import { SEC_REQUIREMENTS, REVIEW_SECTIONS } from "../rfc-schema.js";
import { rulePromptBlock } from "./review-checks.js";

// Shared across every LLM system prompt (draft/review/chat/feedback-import,
// see ai.js) so the language rule stays consistent instead of four separate
// "write in Bahasa Indonesia" lines drifting apart. The audience is Indonesian
// SREs who already say "rollback"/"downtime"/"security group" in English day
// to day — forcing a translation reads as more foreign than the loanword.
export const LANG_RULE = "Jawab dalam Bahasa Indonesia formal. Istilah teknis, governance, dan security yang lazim dipakai dalam Bahasa Inggris (mis. rollback, downtime, production environment, security group, compensating control, compliance, encryption, load balancer, serta nama produk/sistem) BOLEH tetap dalam Bahasa Inggris — jangan paksa menerjemahkannya ke Bahasa Indonesia yang malah janggal atau ambigu. Untuk kata serapan yang SUDAH punya ejaan baku Bahasa Indonesia (KBBI), gunakan ejaan bakunya, BUKAN ejaan Inggrisnya (mis. \"standar\"/\"non-standar\", bukan \"standard\"/\"non-standard\").";

const PROMPT_META = {
  deskripsi: {
    useExamples: true,
    rubric: `FOKUS: Deskripsi & tujuan.
1. Deskripsi jelas: apa yang diubah, mengapa, dan dari kondisi apa ke kondisi apa.
2. "tujuan" menjelaskan justifikasi perubahan, bukan sekadar mengulang deskripsi.
3. Judul mencerminkan isi perubahan.`,
  },
  dampak: {
    useExamples: true,
    rubric: `FOKUS: Siapa dan sistem yang terpengaruh.
1. "sistem_terpengaruh" sesuai definisinya di form: siapa saja/pihak-pihak yang terdampak DAN sistem apa saja yang terpengaruh — bukan salinan daftar komponen; tanpa baris judul; tidak menduplikasi isi "komponen" (di dokumen keduanya tampil sebagai dua daftar terpisah).
2. "komponen" = NAMA komponen saja, singkat, tanpa spesifikasi resource.
3. Komponen selaras dengan deskripsi (konteks): komponen yang diubah disinggung di deskripsi, dan sebaliknya (area "Konsistensi").`,
  },
  jadwal: {
    useExamples: false,
    rubric: `FOKUS: Urgensi & jadwal.
1. Urgensi mengukur seberapa MENDESAK/time-sensitive permintaan ini (mis. ada tenggat, insiden, kerentanan aktif, tekanan bisnis) — BUKAN seberapa besar dampaknya; besar-kecilnya dampak/kompleksitas sudah dinilai terpisah lewat "klasifikasi" (Minor/Major, di bagian Risiko). Perubahan besar/berdampak yang dijadwalkan jauh-jauh hari dan terencana (bukan mendadak) boleh tetap Low/Medium meski klasifikasinya Major — JANGAN menaikkan urgensi hanya karena downtime lama atau klasifikasi Major; nilai dari tekanan waktu permintaannya, bukan dari besar-kecilnya dampak (lihat deskripsi di konteks).
2. jadwal_jam dan tanggal eksekusi masuk akal terhadap deskripsi perubahan.
3. Kebijakan Operasional TI (VII.4.G.h) mewajibkan pengguna terdampak diinformasikan soal perkiraan downtime dan perkiraan waktu layanan pulih SEBELUM pelaksanaan. "jadwal_downtime" dan "jadwal_pulih" TIDAK BOLEH kosong — bila perubahan memang tidak menimbulkan downtime, field itu harus menyatakan itu secara eksplisit (mis. "Tidak ada downtime") alih-alih dibiarkan kosong. Nilai keduanya harus masuk akal terhadap deskripsi/tasklist di konteks.
JANGAN mengecek kecocokan "Hari"/estimasi terhadap tanggal eksekusi/tasklist — itu sudah dicek otomatis (deterministik).`,
  },
  risiko: {
    useExamples: true,
    rubric: `FOKUS: Risiko, mitigasi & klasifikasi.
1. Risiko relevan dengan perubahan yang dideskripsikan (konteks), dengan likelihood & impact yang wajar.
2. Mitigasi benar-benar menjawab risiko yang terdaftar — bukan kalimat generik. Jumlah baris "mitigasi" harus sama dengan jumlah "risks", urutan sama; tandai bila mitigasi beberapa risiko digabung jadi satu baris.
3. Klasifikasi Minor/Major — gunakan PERSIS kriteria Kebijakan Operasional TI (POL/IT/25/2025/VIII/04, bagian Pengelolaan Perubahan) di bawah, jangan menilai bebas:
   - Major: kompleksitas implementasi TINGGI, risiko penundaan TINGGI, ADA dampak pada tingkat layanan.
   - Minor: kompleksitas implementasi RENDAH, risiko penundaan RENDAH, TIDAK ADA dampak pada tingkat layanan.
   Klasifikasi harus Major bila salah satu dari ketiga faktor di atas mengarah ke Major (mis. dampak layanan ada meski kompleksitas rendah).`,
  },
  pengerjaan: {
    // No examples here on purpose: corpus task/rollback arrays are the largest
    // fields, and on local reasoning models the extra material to compare
    // against reliably blows the per-call deadline. Symmetry is checked
    // against the record's own tasks/rollback, which needs no exemplar.
    useExamples: false,
    rubric: `FOKUS: Tasklist & rollback.
1. Setiap langkah punya PIC; "waktu" berupa rentang waktu (mis. "10:00-10:30"), bukan nama fase.
2. Langkah pengerjaan jelas, spesifik, dan berurutan logis.
3. Task ↔ rollback simetris: semua yang dibuat/diubah oleh tasklist dibatalkan oleh rollback (mis. task membuat security group / membuka port → rollback menghapusnya), dan rollback tidak membatalkan hal yang tidak pernah dikerjakan (area "Konsistensi"). Dasarkan simetri HANYA pada apa yang eksplisit tertulis di tasklist/rollback/konteks — JANGAN mengasumsikan target atau state "sebelumnya" yang tidak disebutkan di form manapun (mis. mengklaim ada "instance production lama" padahal tasklist sendiri menyatakan instance itu berada di testing environment).
4. Urutan fase SELALU: Pengecekan Awal/Persiapan → Pengerjaan Inti → Testing + Capture Evidence → Approval → Review/Evaluasi — ini urutan kanonik yang benar dan ditegakkan otomatis oleh sistem, JANGAN menandainya sebagai temuan. "Approval" (langkah Go/No-Go) MEMANG diletakkan SETELAH Pengerjaan Inti/Testing, BUKAN sebelumnya — perannya adalah checkpoint pasca-eksekusi yang memutuskan lanjut ke Review/Evaluasi atau menjalankan Rollback, BUKAN otorisasi pra-eksekusi (otorisasi itu sudah terjadi lewat daftar tanda tangan persetujuan sebelum RFC ini diajukan, di luar tasklist). JANGAN mengusulkan memindahkan Approval/Go-No-Go ke awal tasklist.`,
  },
  security: {
    useExamples: false,
    rubric: `FOKUS: Security requirement (7 baris; tiap baris harus terjawab).
1. Alasan WAJIB hanya untuk jawaban "Tidak Dapat Dipenuhi" dan "Tidak Relevan"; jawaban "Dapat Dipenuhi" TIDAK memerlukan alasan (jangan jadikan finding).
2. "Tidak Dapat Dipenuhi" yang menambah risiko keamanan harus menyebutkan compensating control.
3. Jika tasklist (konteks) membuka port atau membuat security group, jawaban security requirement harus konsisten (mis. port hanya dari bastion host, bukan 0.0.0.0/0).`,
  },
  bahasa: {
    useExamples: false,
    rubric: `FOKUS: Bahasa & penulisan — sapuan typo atas teks form di bawah.
1. Laporkan typo HANYA dengan pasangan persis "salah" → "benar" di issue (mis. "databse" → "database", "konfigursi" → "konfigurasi"). Tanpa pasangan persis yang Anda yakini, JANGAN laporkan.
2. JANGAN menandai nama produk/sistem/istilah teknis yang memang ditulis begitu (mis. nama database, nama tools, singkatan teknis seperti SNAT) dan JANGAN melaporkan preferensi gaya sebagai kesalahan.
3. Ejaan Bahasa Indonesia baku dan konsisten; hindari bahasa informal/singkatan chat.
Area "Bahasa", severity "info" — "warn" hanya bila salah tulisnya mengubah makna teknis (nama host, angka, port).`,
  },
};

export const SECTIONS = Object.fromEntries(REVIEW_SECTIONS.map((s) => [s.id, {
  fields: s.fields,
  context: s.context,
  patchable: s.fields,
  ...PROMPT_META[s.id],
}]));

// Shared reviewer preamble: role, output contract, severity meanings, and the
// patch rules — everything that is identical across sections.
const PREAMBLE = `Anda adalah reviewer IT Governance & Security di perusahaan — gerbang yang menyetujui RFC (Form Permintaan Perubahan). Anda meninjau SATU bagian form per permintaan. Tugas Anda: menemukan apa pun di bagian ini yang akan menyebabkan RFC DIKEMBALIKAN untuk revisi, agar engineer memperbaikinya sebelum diajukan. Bila kutipan Company IT Policy diberikan di bawah, itu adalah SUMBER KEBENARAN — nilai kepatuhan terhadap teks kutipan tersebut, bukan dari ingatan Anda sendiri soal kebijakan.

Kembalikan HANYA JSON:
{
  "findings": [ { "severity": "block"|"warn"|"info", "area": "Governance"|"Security"|"Konsistensi"|"Bahasa", "issue": string, "fix": string, "patch": { "field": string, "value": <nilai pengganti> } | null } ]
}
"block" = pasti dikembalikan reviewer; "warn" = berisiko ditanya/revisi; "info" = saran penguat. Jika bagian ini sudah baik, kembalikan {"findings": []}. Tulis issue & fix spesifik dan langsung bisa dikerjakan. ${LANG_RULE}

Aturan "patch" (perbaikan yang bisa diterapkan satu klik):
- Sertakan "patch" HANYA bila perbaikannya konkret dan Anda yakin; jika ragu, set null dan jelaskan di "fix".
- "field" = nama field PERSIS seperti pada JSON "Bagian yang ditinjau". JANGAN membuat patch untuk field konteks.
- "value" = nilai pengganti UTUH untuk field itu; untuk field array kirim ARRAY LENGKAP yang sudah diperbaiki, bukan hanya elemen yang berubah.
- Untuk field array: jumlah elemen hasil TIDAK BOLEH berkurang, kecuali issue-nya memang menghapus duplikat (patch yang kehilangan baris akan DITOLAK).
- JANGAN sertakan patch yang nilainya sama dengan nilai saat ini.
- Pertahankan semua isi yang sudah benar — patch memperbaiki masalah yang disebut di "issue", bukan menulis ulang gaya.`;

const secLine = (v) => {
  if (!v) return "(kosong)";
  if (typeof v === "string") return v || "(kosong)";
  const s = (v.status || "").trim(), r = (v.reason || "").trim();
  return [s, r].filter(Boolean).join(" — ") || "(kosong)";
};

const slice = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? ""]));

// {system, user} for one section's LLM call. Examples are sliced to the
// fields this section reviews (plus title/system for orientation) so the
// prompt stays small — the whole point of reviewing per section. `policyHits`
// are Company IT Policy excerpts (backend/policy.js searchPolicy) relevant to
// this section's rubric — several rubrics above already cite specific policy
// clauses from memory (VII.4.G.h, POL/IT/25/2025/VIII/04); grounding them
// in the actual retrieved text catches drift if the transcribed clause is
// wrong or the policy gets revised.
export function buildSectionPrompt(f, sectionId, examples = [], policyHits = []) {
  const sec = SECTIONS[sectionId];
  const exampleKeys = ["title", "system", "changeType", ...sec.fields];
  const parts = [];
  if (sec.useExamples) {
    parts.push(examples.length
      ? `Contoh RFC sebelumnya (acuan gaya & kelengkapan untuk bagian ini):\n${JSON.stringify(examples.map((e) => slice(e, exampleKeys.filter((k) => e?.[k] !== undefined))), null, 2)}`
      : "Belum ada contoh RFC sebelumnya — gunakan praktik governance & security yang baik.");
    parts.push("");
  }
  if (policyHits.length) {
    const sources = [...new Set(policyHits.map((h) => h.source))].join(", ");
    parts.push(`Kutipan Company IT Policy terkait bagian ini (sumber: ${sources}) — jadikan acuan utama, jangan menilai dari ingatan sendiri bila bertentangan:\n${policyHits.map((h) => h.text).join("\n---\n")}`);
    parts.push("");
  }
  if (sectionId === "security") {
    parts.push("Daftar Security Requirement (sec_requirements[i] menjawab baris ke-i+1):");
    parts.push(...SEC_REQUIREMENTS.map((s, i) => `${i + 1}. ${s} → ${secLine(f.sec_requirements?.[i])}`));
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
  if (!SECTIONS[id]) throw new Error(`review-sections.js is missing section "${id}"`);
}
for (const id of Object.keys(SECTIONS)) {
  if (!REVIEW_SECTIONS.some((s) => s.id === id)) throw new Error(`shared REVIEW_SECTIONS is missing section "${id}"`);
}
