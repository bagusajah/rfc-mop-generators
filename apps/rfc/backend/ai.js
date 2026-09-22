// LLM-assisted endpoints: /api/draft (fill the form from a one-line intent)
// and /api/review (pre-submission Governance & Security review).
//
// The review simulates the IT Governance & Security gate — which reviews
// submissions with an LLM and returns forms for missing information or typos —
// so the engineer fixes everything BEFORE submitting. Findings may carry a
// machine-applicable `patch` ({ field, value }: whole-field replacement) that
// the frontend applies with one click.

import Ajv from "ajv";
import { chat, extractJson, llmConfigured } from "../../../packages/core/backend/llm.js";
import { recordToEmbeddingText } from "./vector-rfc.js";
import { pickExamples } from "./examples.js";
import { searchPolicy } from "../../../packages/core/backend/policy.js";
import { ruleFindingsFor } from "./review-checks.js";
import { SECTIONS, buildSectionPrompt, LANG_RULE } from "./review-sections.js";
import {
  SEC_REQUIREMENTS, ENUMS, RFC_RECORD_SCHEMA, DRAFT_INPUT_SCHEMA, IMPORT_INPUT_SCHEMA,
  REVIEW_SECTIONS, govCheck,
} from "../rfc-schema.js";

const RISK_LEVELS = ["Low", "Medium", "High"];

// mitigasi is asked as an array index-aligned to "risks" (arrays are far more
// reliably followed by the model than a "one per line" prose instruction —
// every other array field in the draft schema is complied with fine). Some
// models still return a lone string; split it as a fallback so that case
// degrades gracefully instead of collapsing to one bullet.
export function alignMitigasi(mitigasiRaw, riskCount) {
  const arr = Array.isArray(mitigasiRaw) ? mitigasiRaw : String(mitigasiRaw || "").split(/\r?\n/);
  return Array.from({ length: riskCount }, (_, i) => String(arr[i] ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

// Phase order is meaning, not just grouping (e.g. "Approval" must follow
// "Pengerjaan Inti", not precede it) — the prompt asks for this order but
// models don't reliably comply, so enforce it here. Unknown/blank phases sort
// last, after any recognised phase, stable within their own group.
const PHASE_RANK = Object.fromEntries(ENUMS.taskPhase.map((p, i) => [p, i]));
export function sortByPhase(taskRows) {
  return [...taskRows].sort((a, b) =>
    (PHASE_RANK[a.phase] ?? ENUMS.taskPhase.length) - (PHASE_RANK[b.phase] ?? ENUMS.taskPhase.length));
}

// Custom ajv instance (lenient policy): coerce scalar types, keep unknown
// additional properties, collect all errors. Schemas live in shared/.
const ajv = new Ajv({ coerceTypes: true, useDefaults: false, removeAdditional: false, allErrors: true });
export const validateRfc = ajv.compile(RFC_RECORD_SCHEMA);
const validateDraftInput = ajv.compile(DRAFT_INPUT_SCHEMA);
const validateImportInput = ajv.compile(IMPORT_INPUT_SCHEMA);

function invalid(reply, validator, body) {
  if (validator(body)) return false;
  reply.code(400).send({ error: "Invalid request body", details: validator.errors });
  return true;
}

const llmUnconfigured = (reply) => reply.code(503).send({
  error: "LLM belum dikonfigurasi. Tambahkan provider di Pengaturan LLM (ikon ⚙ di header), atau set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL di backend/.env.",
});

// Governance-completeness gate for document generation (server.js's
// /api/document and /api/document/gdoc). requireComplete() in RfcForm.jsx
// already blocks export on the same rules, but that is client-side only —
// a real submission reached Governance with 6 of 7 security requirements
// unreasoned because nothing re-checked the record at the render endpoint.
// Re-run the same schema + govCheck here so the render endpoint can't be
// handed an incomplete record, whatever called it.
export function documentBlockers(record) {
  const f = record || {};
  const blockers = [];
  if (!validateRfc(f)) {
    blockers.push(...(validateRfc.errors || []).map((e) => `${e.instancePath || "value"} ${e.message}`));
  }
  for (const c of govCheck(f)) {
    if (!c.ok) blockers.push(c.label);
  }
  return blockers;
}

/* ── /api/draft ──────────────────────────────────────────────────────────── */

const DRAFT_SYSTEM = `You are an SRE change-management assistant for the company.
You draft "Form Permintaan Perubahan" (Request for Change) content in formal Bahasa Indonesia,
matching the style, tone, and structure of the example forms provided. When Company IT Policy
excerpts are given, the draft must comply with them (e.g. classification criteria, required
notice fields) — never contradict a provided policy excerpt.

Return ONLY a JSON object with exactly these keys:
{
  "title": string,                 // "Form Permintaan Perubahan - <ringkasan>"
  "description": string,           // 2-4 kalimat: apa, mengapa, dari kondisi apa ke apa
  "tujuan": string,                // tujuan/justifikasi perubahan
  "sistem_terpengaruh": string,    // siapa saja/PIHAK yang terdampak (tim/pengguna) DAN sistem apa saja yang terpengaruh, satu per baris
  "komponen": string[],            // NAMA komponen terpengaruh, singkat, TANPA spesifikasi (mis. "ECS Instance", "Security Group", "Database Cluster")
  "urgensi": "Low"|"Medium"|"High"|"Critical",   // berdasarkan dampak & seberapa mendesak
  "risks": [ { "risiko": string, "likelihood": "Low"|"Medium"|"High", "impact": "Low"|"Medium"|"High" } ],
  "mitigasi": string[],             // SATU per risiko di "risks", index sama — mitigasi[i] menjawab risks[i], JANGAN digabung
  "klasifikasi": "Minor"|"Major",
  "sec_requirements": [ { "status": "Dapat Dipenuhi"|"Tidak Dapat Dipenuhi"|"Tidak Relevan", "reason": string } ],  // TEPAT 7 item, urut sesuai "Daftar Security Requirement" di bawah
  "tasks": [ { "phase": string, "waktu": string, "pengerjaan": string, "pic": string } ],
  "rollback": [ { "phase": string, "waktu": string, "pengerjaan": string, "pic": string } ]
}

Rules:
- ${LANG_RULE}
- Concise, no marketing language.
- Ground every section in the examples' conventions and naming.
- Do NOT invent PIC names you weren't given; reuse the requester/executor when known, else leave "".
- likelihood and impact MUST be exactly one of Low, Medium, High.
- Provide at least one risk, one task, and one rollback step.
- Bila tasklist melibatkan cutover/repointing resource bersama (domain, DNS, traffic, connection string) dari satu target ke target lain, SEBUTKAN eksplisit target/state SAAT INI (sebelum perubahan) — di description atau di langkah pertama yang relevan — jangan biarkan itu hanya tersirat. Ini mencegah rollback atau reviewer salah menebak topologi (mis. mengira ada "instance lama" yang sebenarnya tidak pernah disebutkan di form).
- Bila nama resource (instance/host/dsb) mengandung penanda environment (mis. "prod", "production") yang TIDAK sesuai dengan environment aktualnya SAAT INI (mis. nama mengandung "prod01" tapi environment saat ini adalah testing), tambahkan klarifikasi singkat dalam kurung saat nama itu PERTAMA KALI disebut di description (mis. "app-server-prod01 (environment aktual saat ini: testing)") — jangan biarkan pembaca/reviewer menyimpulkan environment hanya dari namanya.
- "phase": tahap pengerjaan sebagai judul seksi. Gunakan salah satu: ${ENUMS.taskPhase.map((p) => `"${p}"`).join(", ")}. Kelompokkan baris yang setahap secara berurutan (phase sama), dan urutkan fase persis seperti daftar di atas — "Approval" SETELAH "Pengerjaan Inti" (approve hasil pengerjaan), bukan sebelumnya.
- "waktu": HANYA rentang waktu (mis. "10:00-10:30") atau "-". JANGAN isi dengan nama fase/tahap — itu milik "phase".
- Setiap baris tasks/rollback WAJIB memiliki "pengerjaan" yang jelas. JANGAN hasilkan baris kosong atau baris judul fase.
- "pic": gunakan nama Pelaksana bila diberikan; jangan mengarang nama lain.
- "komponen": NAMA komponen saja, singkat (mis. "ECS Instance", "Security Group") — TANPA detail spesifikasi seperti OS, vCPU, RAM, storage, atau port; detail teknis itu milik description dan tasks. Kosongkan [] bila tidak jelas.
- "sistem_terpengaruh": jawaban untuk seksi "Siapa dan Sistem yang Terpengaruh" — siapa saja/pihak-pihak yang terdampak dari perubahan (tim/pengguna) DAN sistem/layanan apa saja yang terpengaruh, satu item per baris. JANGAN menulis baris judul (mis. "Komponen yang Terpengaruh:") dan JANGAN mengulang isi "komponen" — di dokumen keduanya tampil sebagai dua daftar terpisah dengan labelnya masing-masing.
- "mitigasi": array dengan PANJANG SAMA PERSIS dengan "risks" — mitigasi[i] adalah mitigasi untuk risks[i]. JANGAN menggabungkan beberapa risiko jadi satu elemen, JANGAN kurang/lebih dari jumlah risks.
- "sec_requirements": WAJIB tepat 7 item, satu per baris daftar (urutan tetap). Pilih "Dapat Dipenuhi" bila kontrol dipenuhi ("reason" TIDAK perlu — kosongkan ""), "Tidak Dapat Dipenuhi" bila tidak (WAJIB isi "reason"), "Tidak Relevan" bila tidak berlaku (WAJIB isi "reason" singkat). Default konservatif "Dapat Dipenuhi" hanya bila wajar.
- Output JSON only — no prose, no code fences.`;

/* ── /api/review ─────────────────────────────────────────────────────────── */

// Fields a review `patch` may replace — exactly the editable form fields.
// Values are validated against the field's own subschema before a patch is
// accepted; anything else is dropped and the finding stays advice-only.
export const PATCHABLE = [
  "title", "description", "tujuan", "sistem_terpengaruh", "komponen",
  "urgensi", "klasifikasi", "mitigasi", "risks", "tasks", "rollback",
  "sec_requirements", "jadwal_hari", "jadwal_jam", "jadwal_estimasi",
  "jadwal_downtime", "jadwal_pulih",
  "execDate", "alasan_pengecualian", "compensating_control",
];
const patchValidators = Object.fromEntries(
  PATCHABLE.map((f) => [f, ajv.compile(RFC_RECORD_SCHEMA.properties[f])]),
);

const REVIEW_AREAS = ["Governance", "Security", "Konsistensi", "Bahasa"];

// Keep a finding's patch only when it names a patchable field and the value
// validates against that field's schema; otherwise strip it (advice-only).
// Extra guards against model failure modes:
//   - no-op: a value identical to the current one would render a useless
//     "Terapkan" button;
//   - data-loss: a whole-array replacement that drops most rows is almost
//     always the model returning only the changed elements despite the
//     instructions — one click would wipe the user's work;
//   - mitigasi/risks desync: "mitigasi" is newline-joined text index-aligned
//     to "risks" (see alignMitigasi) — a patch whose line count doesn't match
//     riskCount would silently break that alignment. riskCount is normally
//     the record's current risks.length, but when the same LLM response also
//     patches "risks" (a paired rewrite), the sibling patch's new length is
//     used instead — see sanitiseSection.
function sanitisePatch(p, f, allowed = PATCHABLE, riskCount = f?.risks?.length ?? 0) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const field = String(p.field || "");
  if (!allowed.includes(field) || !patchValidators[field]) return null;
  if (!patchValidators[field](p.value)) return null;
  const current = f?.[field];
  if (JSON.stringify(p.value ?? "") === JSON.stringify(current ?? "")) return null;
  if (Array.isArray(current) && current.length >= 2 &&
      Array.isArray(p.value) && p.value.length < Math.ceil(current.length / 2)) return null;
  if (field === "mitigasi" && typeof p.value === "string" && riskCount > 0) {
    const lines = p.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length !== riskCount) return null;
  }
  return { field, value: p.value };
}

/* ── /api/chat ────────────────────────────────────────────────────────────── */

// Chat is Q&A grounded in the corpus + current draft — but when a question is
// really a direct "fill this field for me" request with a confident answer,
// let it carry a `patch` too, in the exact same shape/validation as a review
// finding's patch (sanitisePatch/PATCHABLE above), so the frontend can offer
// the same one-click "Terapkan" it already has for Tinjau findings. Most
// turns are plain Q&A with patch: null — this is additive, not a mode switch.
const CHAT_SYSTEM = `You are an SRE change-management assistant for the company helping an
engineer fill out a "Form Permintaan Perubahan" (RFC). Answer grounded in the example RFCs,
current draft state, and any Company IT Policy excerpts provided. When policy excerpts are given
and relevant, cite the policy source filename. If you don't know or no excerpt covers it, say so
— never invent policy or field values. Keep answers short.

If — and only if — the user is directly asking you to draft/fill the CONTENT of one specific
form field (not just asking a question about it) and you can confidently give a ready-to-use
value, include it as "patch". Field names, exactly as in the form JSON: ${PATCHABLE.join(", ")}.
Never include "patch" for a general question, an explanation, or advice with no single concrete
field value — leave it null and put the suggestion in "answer" instead. "value" must match that
field's shape (plain string for text fields; full replacement array for risks/tasks/rollback/
sec_requirements/komponen — send the complete array, not just new items).

Return ONLY JSON: {"answer": string, "patch": {"field": string, "value": <value>} | null}. ${LANG_RULE}`;

/* ── /api/review ─────────────────────────────────────────────────────────── */

// The model is told not to repeat the deterministic checks, but small models
// do anyway. When a block-level LLM finding clearly covers the same failed
// check, prefer it (it often carries a one-click patch; the rule finding never
// does) and drop the rule duplicate. Keyed by govCheck id for the 8
// completeness checks, or by the rule's own string id for other rule checks
// (e.g. the jadwal drift checks — see review-checks.js).
const RULE_DUP_RE = {
  1: /deskripsi/i,
  2: /sistem terpengaruh|pihak terdampak/i,
  3: /urgensi|jadwal/i,
  4: /risiko|risk register|mitigasi/i,
  5: /klasifikasi/i,
  6: /\bPIC\b/,
  7: /rollback/i,
  8: /security requirement/i,
  jadwal_hari_drift: /\bhari\b.*(execdate|tanggal eksekusi)/i,
  jadwal_estimasi_drift: /estimasi.*(tasklist|rentang waktu)/i,
};

// Coerce a raw LLM reply into clean findings and merge in the deterministic
// rule findings (first — they are guaranteed even when the model overlooks a
// gap). `sectionId` scopes everything to one review section: its rule
// findings, its patchable fields, its section tag on the LLM findings.
// Exported for check-review.mjs.
export function sanitiseSection(out, f, sectionId) {
  const sec = SECTIONS[sectionId];
  const sev = (s) => (["block", "warn", "info"].includes(s) ? s : "warn");
  const rawFindings = Array.isArray(out?.findings) ? out.findings : [];
  // A paired risks+mitigasi rewrite in the same response: validate mitigasi's
  // line count against the sibling risks patch's new length, not the record's
  // current one (see sanitisePatch).
  const risksPatch = rawFindings.find((x) => x?.patch?.field === "risks" && Array.isArray(x.patch.value));
  const riskCount = risksPatch ? risksPatch.patch.value.length : (f?.risks?.length ?? 0);
  const llmFindings = rawFindings.map((x) => ({
    severity: sev(x?.severity),
    area:     REVIEW_AREAS.includes(x?.area) ? x.area : "Governance",
    section:  sectionId,
    issue:    String(x?.issue || "").trim(),
    fix:      String(x?.fix || "").trim(),
    patch:    sanitisePatch(x?.patch, f, sec.patchable, riskCount),
  })).filter((x) => x.issue);
  const rules = ruleFindingsFor(f, sectionId).filter((r) => {
    const re = RULE_DUP_RE[r.rule];
    return !(re && llmFindings.some((x) => x.severity === "block" && re.test(x.issue)));
  });
  const findings = [...rules, ...llmFindings];
  const order = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

// Findings from imported Governance feedback aren't scoped to one section —
// a single upload can touch every part of the form — so unlike
// sanitiseSection this trusts the model's own "section" tag per finding
// (validated against SECTIONS) and scopes each patch to THAT finding's own
// section.patchable rather than one fixed section's. No rule findings here:
// this reflects feedback a human already gave, not a fresh deterministic
// check. Exported for check-review.mjs.
export function sanitiseImportedFindings(out, f) {
  const sev = (s) => (["block", "warn", "info"].includes(s) ? s : "warn");
  const rawFindings = Array.isArray(out?.findings) ? out.findings : [];
  const risksPatch = rawFindings.find((x) => x?.patch?.field === "risks" && Array.isArray(x.patch.value));
  const riskCount = risksPatch ? risksPatch.patch.value.length : (f?.risks?.length ?? 0);
  const findings = rawFindings.map((x) => {
    const sectionId = SECTIONS[x?.section] ? x.section : "deskripsi";
    return {
      severity: sev(x?.severity),
      area:     REVIEW_AREAS.includes(x?.area) ? x.area : "Governance",
      section:  sectionId,
      issue:    String(x?.issue || "").trim(),
      fix:      String(x?.fix || "").trim(),
      patch:    sanitisePatch(x?.patch, f, SECTIONS[sectionId].patchable, riskCount),
    };
  }).filter((x) => x.issue);
  const order = { block: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// Ask the LLM for JSON with the bounded retry policy every review call
// shares (reformat on bad JSON / plain retry on transient — max 2 calls).
// Both bounds exist for reasoning models (Qwen3.5 etc.) whose thinking chain
// can spiral: without them a single call can hold a provider's semaphore slot
// (llm.js — concurrency defaults to 1, configurable per provider) for tens of
// minutes. The wall-clock deadline is the effective bound;
// the token budget is a roomy backstop (reasoning tokens count toward it on
// LM Studio). Hitting either surfaces as a transient error → one retry.
// Returns { out, error } — `out` is null (with `error` set) when both
// attempts failed, so the caller can degrade to a non-LLM result.
async function chatJson({ system, user, log }) {
  let calls = 0;
  const ask = (u) => {
    calls++;
    // Two calls must fit inside nginx's LLM proxy_read_timeout (600s).
    return chat({
      system, user: u, temperature: 0.2, json: true, task: "review", meta: true,
      maxTokens: Number(process.env.REVIEW_MAX_TOKENS) || 12288,
      signal: AbortSignal.timeout(Number(process.env.REVIEW_LLM_TIMEOUT_MS) || 240_000),
    });
  };

  let out = null, lastErr = null;
  try {
    const first = await ask(user);
    try {
      out = extractJson(first.content);
      // A "length" stop that salvaged to zero findings usually means the
      // model burned the budget thinking and the answer never arrived —
      // don't report a falsely-clean result; re-ask once.
      if (first.finish === "length" && !(Array.isArray(out.findings) && out.findings.length)) {
        out = null;
        throw new Error("length-truncated");
      }
    } catch {
      out = extractJson((await ask(
        `${user}\n\nKeluaran Anda sebelumnya terpotong atau BUKAN JSON valid:\n${String(first.content).slice(0, 4000)}\n\n` +
        "Kirim ulang HANYA JSON valid sesuai skema pada instruksi — langsung JSON, tanpa penjelasan, tanpa code fence.",
      )).content);
    }
  } catch (err) {
    lastErr = err;
    const transient = /LLM 5\d\d|fetch failed|network|ECONN|ETIMEDOUT|abort|timeout|empty content/i;
    if (calls < 2 && transient.test(String(err.message))) {
      try { out = extractJson((await ask(user)).content); lastErr = null; }
      catch (err2) { lastErr = err2; }
    }
  }

  if (!out) {
    log?.error(lastErr);
    return { out: null, error: String(lastErr?.message || "kesalahan tak dikenal").slice(0, 160) };
  }
  return { out, error: null };
}

// One section's review: focused prompt, one chatJson call, degrading to the
// section's deterministic findings when the LLM stays unreachable. llm.js's
// per-provider semaphore bounds how many calls hit the provider at once
// (configurable, default 1) even if something else (a draft) runs
// concurrently against the same provider.
async function reviewSection(f, sectionId, log) {
  const sec = SECTIONS[sectionId];
  const [examples, policyHits] = await Promise.all([
    sec.useExamples
      ? pickExamples(
          { system: f.system, changeType: f.changeType, provided: f.examples || [], queryText: recordToEmbeddingText(f) },
          2,
        )
      : [],
    searchPolicy(`${sec.rubric}\n${recordToEmbeddingText(f)}`, { limit: 2 }),
  ]);
  const { system, user } = buildSectionPrompt(f, sectionId, examples, policyHits);
  const { out, error } = await chatJson({ system, user, log });
  if (!out) {
    return { section: sectionId, llm: false, findings: ruleFindingsFor(f, sectionId), examplesUsed: 0, policyUsed: 0, error };
  }
  return { section: sectionId, llm: true, findings: sanitiseSection(out, f, sectionId), examplesUsed: examples.length, policyUsed: policyHits.length };
}

/* ── /api/review/import ──────────────────────────────────────────────────── */

// Unlike the per-section review (a fresh audit against a rubric), this
// translates feedback a human reviewer ALREADY gave — after real submission —
// into the same findings/patch contract. The model must check each point
// against the CURRENT record (not just transcribe the sheet): content the
// user already fixed, or a recommendation the sheet itself notes was
// declined ("mengikuti standar dokumen"), must not become a finding.
const IMPORT_SYSTEM = `Anda adalah asisten SRE di perusahaan yang membantu merevisi RFC (Form Permintaan Perubahan) berdasarkan feedback yang BENAR-BENAR diterima dari reviewer IT Governance & Security setelah RFC ini diajukan.

Anda diberi (1) seluruh isi form RFC SAAT INI dalam JSON, dan (2) teks feedback mentah dari Governance — biasanya ekspor CSV dari Google Sheet dengan kolom seperti Item/Hasil Analisa/Rekomendasi Analisa/Remark, tapi bisa juga teks bebas (email, catatan rapat, dsb). Tugas Anda: ubah SETIAP poin feedback yang MASIH menjadi pekerjaan tersisa menjadi finding actionable, dalam format yang sama dengan review Governance & Security internal aplikasi ini.

ATURAN PENTING:
1. Bandingkan tiap poin feedback dengan isi field yang bersangkutan di form SAAT INI — JANGAN berasumsi dari ringkasan di feedback saja. Bila isi field saat ini SUDAH menjawab poin tsb, JANGAN buat finding untuknya.
2. Bila catatan/kolom Remark pada baris menunjukkan rekomendasi itu sudah dikerjakan (mis. "sudah direvisi") ATAU sengaja tidak diikuti (mis. "mengikuti standar dokumen", ditolak dengan alasan), JANGAN buat finding — itu keputusan yang sudah diambil, bukan pekerjaan tersisa.
3. Satu baris/poin feedback bisa menghasilkan 0 (sudah selesai/ditolak), 1, atau beberapa finding sekaligus (bila poin itu menyebut beberapa masalah).
4. JANGAN mengarang temuan yang tidak berasal dari teks feedback — ini menerjemahkan feedback yang sudah ada, BUKAN audit baru.
5. "section" WAJIB salah satu dari: ${REVIEW_SECTIONS.map((s) => `"${s.id}" (${s.label})`).join(", ")} — pilih yang paling sesuai dengan bagian form yang dibahas poin feedback tsb.

Kembalikan HANYA JSON:
{ "findings": [ { "severity": "block"|"warn"|"info", "area": "Governance"|"Security"|"Konsistensi"|"Bahasa", "section": string, "issue": string, "fix": string, "patch": { "field": string, "value": <nilai pengganti> } | null } ] }

"severity": "block" bila Governance eksplisit meminta ini diperbaiki sebelum disetujui; "warn" bila berupa concern/pertanyaan yang berisiko ditanyakan lagi; "info" bila saran penguat/opsional.
Aturan "patch" (perbaikan yang bisa diterapkan satu klik) — SAMA seperti review biasa:
- Sertakan "patch" HANYA bila perbaikannya konkret dan Anda yakin; jika ragu, set null dan jelaskan solusinya di "fix".
- "field" = nama field PERSIS seperti pada JSON form SAAT INI di atas.
- "value" = nilai pengganti UTUH untuk field itu; untuk field array kirim ARRAY LENGKAP yang sudah diperbaiki, bukan hanya elemen yang berubah.
- JANGAN sertakan patch yang nilainya sama dengan nilai saat ini.
Tulis "issue" & "fix" spesifik dan langsung bisa dikerjakan. "issue" merangkum apa kata Governance; "fix" adalah instruksi konkret untuk merevisi form. ${LANG_RULE}`;

/* ── Routes ──────────────────────────────────────────────────────────────── */

export default async function aiRoutes(app) {
  app.post("/api/draft", async (req, reply) => {
    if (invalid(reply, validateDraftInput, req.body || {})) return;
    if (!llmConfigured("draft")) return llmUnconfigured(reply);

    const { intent = "", system = "", changeType = "", executor = "", examples = [] } = req.body || {};
    const systems = Array.isArray(system) ? system : (system ? [system] : []);
    const systemText = systems.join(", ");
    if (!intent.trim() && !systems.length && !changeType) {
      return reply.code(400).send({ error: "Provide at least an intent, system, or change type." });
    }

    const draftQuery = [intent, systemText, changeType].filter(Boolean).join(" \n");
    const [picked, policyHits] = await Promise.all([
      pickExamples({ system: systems, changeType, provided: examples, queryText: draftQuery }),
      searchPolicy(draftQuery),
    ]);
    const userPrompt = [
      picked.length
        ? `Contoh RFC sebelumnya (untuk meniru gaya & struktur):\n${JSON.stringify(picked, null, 2)}`
        : "Belum ada contoh RFC sebelumnya — gunakan praktik SRE yang baik.",
      "",
      policyHits.length
        ? `Kutipan Company IT Policy terkait (sumber: ${[...new Set(policyHits.map((h) => h.source))].join(", ")}) — patuhi ini, jangan bertentangan dengannya:\n${policyHits.map((h) => h.text).join("\n---\n")}`
        : "",
      "",
      "Buat draft RFC baru untuk perubahan berikut:",
      `- Intent: ${intent || "(tidak disebutkan)"}`,
      `- Sistem: ${systemText || "(tidak disebutkan)"}`,
      `- Jenis perubahan: ${changeType || "(tidak disebutkan)"}`,
      `- Pelaksana (PIC default untuk tasklist/rollback): ${executor || "(tidak disebutkan)"}`,
      "",
      "Daftar Security Requirement (isi status untuk masing-masing, urutan TETAP, tepat 7):",
      ...SEC_REQUIREMENTS.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n");

    try {
      const raw = await chat({ system: DRAFT_SYSTEM, user: userPrompt, temperature: 0.4, json: true, task: "draft" });
      const draft = extractJson(raw);

      // Sanitise into the exact shape the frontend expects.
      const clampLevel = (v) => (RISK_LEVELS.includes(v) ? v : "Medium");
      const rows = (arr) => (Array.isArray(arr) ? arr : []);
      // Tasklist/rollback rows. Small models emit phase-header rows ("Persiapan",
      // "Approval", "Review/Evaluasi") in the Waktu column and blank filler rows.
      // Keep only rows that actually describe work; a real "waktu" is a time range
      // (has a digit) — anything else is a phase label, so blank it. PIC defaults
      // to the executor rather than being left empty.
      const execPic = String(executor || "").trim();
      const taskRows = (arr) =>
        sortByPhase(
          rows(arr)
            .map((t) => {
              const waktu = String(t?.waktu || "").trim();
              return {
                phase: String(t?.phase || "").trim(),
                waktu: /\d/.test(waktu) ? waktu : "",
                pengerjaan: String(t?.pengerjaan || "").trim(),
                pic: String(t?.pic || "").trim() || execPic,
              };
            })
            .filter((t) => t.pengerjaan),
        );
      // Coerce the model's 7 security statuses into exactly-7 {status, reason},
      // clamping status to the allowed enum (blank if the model returned junk).
      const secReq = Array.from({ length: SEC_REQUIREMENTS.length }, (_, i) => {
        const c = rows(draft.sec_requirements)[i] || {};
        const status = ENUMS.secStatus.includes(c.status) ? c.status : "";
        return { status, reason: String(c.reason || "").trim() };
      });
      // komponen = component NAMES only. The model likes appending resource
      // specs — "ECS Instance (Windows Server 2022, 16 vCPU, 128 GB RAM)",
      // "Security Group — Port 3389 dari bastion host" — which belong in
      // before/after/description/tasks. Strip a trailing parenthetical or
      // dash segment only when it clearly contains specs; legitimate name
      // qualifiers ("SLB (Load Balancer)", "Internal App (CMS)") don't match.
      const SPEC_RE = /\b(v?CPU|RAM|\d+\s*(GB|TB)|storage|Windows|Linux|Ubuntu|CentOS|Server\s*\d{4}|Port\s*\d+|64\s*bit)\b/i;
      const stripSpecs = (name) => {
        let s = name;
        for (const re of [/\s*\(([^)]*)\)$/, /\s+[—–-]\s+([^—–]+)$/]) {
          const m = s.match(re);
          if (m && SPEC_RE.test(m[1])) s = s.slice(0, m.index).trim();
        }
        return s;
      };
      // The model also sometimes fills sistem_terpengaruh with a heading line
      // ("Komponen yang Terpengaruh:") and/or repeats the komponen list —
      // keep only real, non-duplicate items (the docx renders the two lists
      // separately; duplicates would print twice).
      const seenKomp = new Set();
      const komponenClean = rows(draft.komponen)
        .map((k) => stripSpecs(String(k || "").trim()))
        .filter((k) => k && !seenKomp.has(k.toLowerCase()) && seenKomp.add(k.toLowerCase()));
      const komponenSet = new Set(komponenClean.map((k) => k.toLowerCase()));
      const affectedLines = String(draft.sistem_terpengaruh || "")
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^[●•\-*▪]\s*/, ""))
        .filter((s) => s && !/:$/.test(s) && !komponenSet.has(s.toLowerCase()));
      const risksClean = rows(draft.risks).map((r) => ({
        risiko:     String(r.risiko || "").trim(),
        likelihood: clampLevel(r.likelihood),
        impact:     clampLevel(r.impact),
      }));
      const mitigasi = alignMitigasi(draft.mitigasi, risksClean.length);
      const clean = {
        title:              String(draft.title || "").trim(),
        description:        String(draft.description || "").trim(),
        tujuan:             String(draft.tujuan || "").trim(),
        sistem_terpengaruh: affectedLines.join("\n"),
        komponen:           komponenClean,
        urgensi:            ENUMS.urgensi.includes(draft.urgensi) ? draft.urgensi : "Medium",
        sec_requirements:   secReq,
        mitigasi,
        klasifikasi:        draft.klasifikasi === "Major" ? "Major" : "Minor",
        risks:    risksClean,
        tasks:    taskRows(draft.tasks),
        rollback: taskRows(draft.rollback),
      };
      return { draft: clean, examplesUsed: picked.length, policyUsed: policyHits.length };
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: `Draft generation failed: ${err.message}` });
    }
  });

  // Free-form Q&A while the user fills the form — grounded in the same corpus
  // as /api/draft (pickExamples) plus the in-progress record, so answers cite
  // what past RFCs actually did instead of generic advice.
  app.post("/api/chat", async (req, reply) => {
    if (!llmConfigured("chat")) return llmUnconfigured(reply);
    const { question = "", record = {}, history = [] } = req.body || {};
    if (!String(question).trim()) return reply.code(400).send({ error: "question is required" });

    const systems = Array.isArray(record.system) ? record.system : (record.system ? [record.system] : []);
    const chatQuery = `${question}\n${recordToEmbeddingText(record)}`;
    const [picked, policyHits] = await Promise.all([
      pickExamples({ system: systems, changeType: record.changeType, queryText: chatQuery }),
      searchPolicy(chatQuery),
    ]);

    const userPrompt = [
      picked.length ? `Contoh RFC terkait:\n${JSON.stringify(picked, null, 2)}` : "Belum ada contoh RFC terkait.",
      "",
      policyHits.length
        ? `Kutipan Company IT Policy terkait (sumber: ${[...new Set(policyHits.map((h) => h.source))].join(", ")}):\n${policyHits.map((h) => h.text).join("\n---\n")}`
        : "",
      // The live draft (not exampleOf()'s trimmed shape — that drops
      // sec_requirements/komponen, which are exactly what users ask about).
      // Explicit note: "Contoh RFC" above is trimmed and won't show every
      // field — without this, models have answered "no such field exists"
      // for fields that ARE in the JSON below, just currently empty.
      "Setiap key di JSON draft di bawah adalah field form yang benar-benar ada, meski nilainya kosong (\"\") — field kosong BUKAN berarti field itu tidak ada di form. \"Contoh RFC terkait\" di atas hanya subset field, jangan jadikan acuan field apa saja yang ADA di form.",
      `Draft yang sedang dikerjakan user:\n${JSON.stringify(record, null, 2)}`,
      "",
      `Daftar Security Requirement (urutan tetap, tepat 7 — form SELALU punya bagian ini):\n${SEC_REQUIREMENTS.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      "",
      "Kebijakan Operasional TI (VII.4.G.h): field \"jadwal_downtime\" dan \"jadwal_pulih\" WAJIB diisi eksplisit sebelum pelaksanaan (pengguna terdampak harus diberi tahu perkiraan downtime dan perkiraan waktu layanan pulih); bila memang tidak ada downtime, field itu harus menyatakan itu secara eksplisit, bukan dibiarkan kosong.",
      history.length ? `\nRiwayat percakapan:\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}` : "",
      `\nPertanyaan user: ${question}`,
    ].filter(Boolean).join("\n");

    try {
      const raw = await chat({ system: CHAT_SYSTEM, user: userPrompt, temperature: 0.3, json: true, task: "chat" });
      const parsed = extractJson(raw);
      const answer = String(parsed.answer || "").trim() || "Maaf, saya tidak punya jawaban untuk itu.";
      const patch = sanitisePatch(parsed.patch, record);
      return { answer, patch, examplesUsed: picked.length, policyUsed: policyHits.length };
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: `Chat failed: ${err.message}` });
    }
  });

  // One review section per request. The frontend loops these in order
  // (REVIEW_SECTIONS) so findings stream in progressively; the llm.js queue
  // keeps actual LLM traffic at concurrency 1 regardless of callers.
  app.post("/api/review/section", async (req, reply) => {
    const sectionId = String(req.query?.section || "");
    if (!SECTIONS[sectionId]) {
      return reply.code(400).send({
        error: `Unknown section "${sectionId}". Valid: ${REVIEW_SECTIONS.map((s) => s.id).join(", ")}`,
      });
    }
    if (invalid(reply, validateRfc, req.body || {})) return;
    if (!llmConfigured("review")) return llmUnconfigured(reply);
    return reviewSection(req.body || {}, sectionId, app.log);
  });

  // Post-submission Governance & Security feedback (pasted, or read from an
  // uploaded .csv/.txt) → findings against the CURRENT record, same
  // findings/patch contract as /api/review/section so the frontend reuses
  // the same review panel and one-click "Terapkan".
  app.post("/api/review/import", async (req, reply) => {
    if (invalid(reply, validateImportInput, req.body || {})) return;
    if (!llmConfigured("review")) return llmUnconfigured(reply);
    const { record = {}, feedback = "" } = req.body || {};
    if (!feedback.trim()) {
      return reply.code(400).send({ error: "Feedback kosong — tempel atau unggah teks feedback Governance terlebih dahulu." });
    }
    const user = [
      "Form RFC SAAT INI:",
      JSON.stringify(record, null, 2),
      "",
      "Teks feedback dari IT Governance & Security (mentah, bisa CSV atau teks bebas):",
      feedback.slice(0, 20000),
    ].join("\n");
    const { out, error } = await chatJson({ system: IMPORT_SYSTEM, user, log: app.log });
    if (!out) return reply.code(502).send({ error: `Impor feedback gagal: ${error}` });
    return { findings: sanitiseImportedFindings(out, record) };
  });
}
