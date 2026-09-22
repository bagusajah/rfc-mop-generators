// LLM-assisted endpoints for MOP: /api/draft, /api/review/section,
// /api/review/import, /api/chat. Per-section review streaming, best-effort
// grounding (corpus + Company IT Policy), and patch validation. Prompts target
// the MOP shape: a step table that is plan + execution-log + per-step rollback,
// structured pre-checks and verification criteria, and an explicit rollback
// decision deadline + triggers.
import Ajv from "ajv";
import { chat, extractJson, llmConfigured } from "../../../packages/core/backend/llm.js";
import { recordToEmbeddingText } from "./vector-mop.js";
import { pickExamples } from "./examples.js";
import { searchPolicy } from "../../../packages/core/backend/policy.js";
import { ruleFindingsFor } from "./review-checks.js";
import { SECTIONS, buildSectionPrompt, LANG_RULE } from "./review-sections.js";
import {
  ENUMS, MOP_RECORD_SCHEMA, DRAFT_INPUT_SCHEMA, IMPORT_INPUT_SCHEMA,
  REVIEW_SECTIONS, govCheck,
} from "../mop-schema.js";

// Step phase order — enforced on the model's output so phases read in the
// canonical execution lifecycle regardless of how the model emitted them.
const PHASE_RANK = Object.fromEntries(ENUMS.stepPhase.map((p, i) => [p, i]));
export function sortByPhase(stepRows) {
  return [...stepRows].sort((a, b) =>
    (PHASE_RANK[a.phase] ?? ENUMS.stepPhase.length) - (PHASE_RANK[b.phase] ?? ENUMS.stepPhase.length));
}

const ajv = new Ajv({ coerceTypes: true, useDefaults: false, removeAdditional: false, allErrors: true });
export const validateMop = ajv.compile(MOP_RECORD_SCHEMA);
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

// Completeness gate for document generation — server.js's /api/document and
// /api/document/gdoc re-run schema + govCheck so the render endpoint can't be
// handed an incomplete record, whatever called it.
export function documentBlockers(record) {
  const f = record || {};
  const blockers = [];
  if (!validateMop(f)) {
    blockers.push(...(validateMop.errors || []).map((e) => `${e.instancePath || "value"} ${e.message}`));
  }
  for (const c of govCheck(f)) {
    if (!c.ok) blockers.push(c.label);
  }
  return blockers;
}

/* ── /api/draft ──────────────────────────────────────────────────────────── */

const DRAFT_SYSTEM = `You are an SRE / ops assistant for the company. You draft "Method of Procedure" (MOP) content in formal Bahasa Indonesia — a step-by-step runbook an engineer follows in real time during a maintenance window. The MOP is a STANDALONE operational document: it describes ONE specific procedure, with exact steps, exact expected results, and a per-step rollback so the work is reversible.

Return ONLY a JSON object with exactly these keys:
{
  "title": string,                 // imperative, describes the procedure
  "purpose": string,               // 1-2 kalimat: hasil yang dicapai setelah selesai
  "in_scope": string[],            // apa yang termasuk; satu poin per elemen
  "out_of_scope": string[],        // apa yang TIDAK termasuk
  "impact_summary": string,        // dampak yang diharapkan (degradasi/outage/tidak ada) + durasi
  "dependencies": string[],        // sistem/upstream yang bergantung pada atau dipakai prosedur
  "rollback_deadline": string,     // wall-clock deadline keputusan rollback (mis. "03:30 WIB")
  "rollback_triggers": string,     // kondisi yang memaksa rollback, satu per baris
  "prerequisites": [ { "description": string, "pass_criteria": string, "owner": string } ],
  "steps": [ { "phase": string, "action": string, "command": string, "expected_result": string, "target_system": string, "duration_min": string, "owner": string, "rollback_action": string } ],
  "verification": [ { "criterion": string, "method": string, "target": string, "owner": string } ]
}

Rules:
- ${LANG_RULE}
- Concise, no marketing language.
- "steps" — the heart of the MOP. EVERY step MUST have non-empty "action" and "expected_result". "command" is the exact paste-ready command (bukan narasi). "phase" salah satu dari ${ENUMS.stepPhase.map((p) => `"${p}"`).join(", ")}; urutan SELALU Pre-check → Eksekusi → Verifikasi → Rollback → Sign-off.
- SETIAP langkah berphase "Eksekusi" WAJIB punya "rollback_action" (cara mengubah langkah tsb bila gagal). Ini inti MOP yang reversible — jangan kosongkan.
- "prerequisites": hal yang HARUS dipenuhi SEBELUM eksekusi (backup/snapshot, kapasitas target, akses granted, notifikasi terkirim, sistem sehat). Setiap prasyarat punya "pass_criteria" yang terukur.
- "verification": cek pasca-eksekusi yang membuktikan MOP berhasil — terukur, dengan "method" (cara mengukur) dan "target" (nilai/rentang lolos).
- "rollback_deadline": wall-clock konkret (bukan "nanti bila perlu"). "rollback_triggers": pemicu observable (langkah gagal, alert/KPI keluar batas), satu per baris.
- JANGAN mengarang nama orang; gunakan "owner"/"author" bila diberikan, jika tidak biarkan "".
- Output JSON only — no prose, no code fences.`;

/* ── /api/chat ────────────────────────────────────────────────────────────── */

const CHAT_SYSTEM = `You are an SRE / ops assistant for the company helping an engineer write a "Method of Procedure" (MOP) — a step-by-step runbook for a maintenance window. Answer grounded in the example MOPs, the current draft, and any Company IT Policy excerpts provided. Cite the policy source filename when relevant. If you don't know or no excerpt covers it, say so — never invent policy or field values. Keep answers short. ${LANG_RULE}`;

/* ── /api/review ─────────────────────────────────────────────────────────── */

// Fields a review `patch` may replace — the editable MOP form fields.
export const PATCHABLE = [
  "title", "purpose", "in_scope", "out_of_scope",
  "affected_systems", "impact_summary", "dependencies",
  "window_start", "window_end", "impact_start", "impact_end", "timezone",
  "prerequisites", "steps", "verification",
  "rollback_deadline", "rollback_triggers", "approvals",
];
const patchValidators = Object.fromEntries(
  PATCHABLE.map((f) => [f, ajv.compile(MOP_RECORD_SCHEMA.properties[f])]),
);

const REVIEW_AREAS = ["Governance", "Security", "Konsistensi", "Bahasa"];

// Keep a finding's patch only when it names a patchable field and validates.
// Guards: no-op (value identical to current), data-loss (array shrink).
function sanitisePatch(p, f, allowed = PATCHABLE) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const field = String(p.field || "");
  if (!allowed.includes(field) || !patchValidators[field]) return null;
  if (!patchValidators[field](p.value)) return null;
  const current = f?.[field];
  if (JSON.stringify(p.value ?? "") === JSON.stringify(current ?? "")) return null;
  if (Array.isArray(current) && current.length >= 2 &&
      Array.isArray(p.value) && p.value.length < Math.ceil(current.length / 2)) return null;
  return { field, value: p.value };
}

// Drop deterministic rule findings the LLM also reported (the LLM version may
// carry a patch). Keyed by govCheck id.
const RULE_DUP_RE = {
  1: /tujuan|ruang lingkup|purpose|scope/i,
  2: /sistem terpengaruh|dampak|impact/i,
  3: /maintenance window|window mulai|window selesai/i,
  4: /prasyarat|pre-check/i,
  5: /aksi|hasil harapan|expected/i,
  6: /rollback_action|aksi rollback/i,
  7: /verifikasi|kriteria penerimaan/i,
  8: /deadline rollback|pemicu rollback/i,
};

export function sanitiseSection(out, f, sectionId) {
  const sec = SECTIONS[sectionId];
  const sev = (s) => (["block", "warn", "info"].includes(s) ? s : "warn");
  const rawFindings = Array.isArray(out?.findings) ? out.findings : [];
  const llmFindings = rawFindings.map((x) => ({
    severity: sev(x?.severity),
    area:     REVIEW_AREAS.includes(x?.area) ? x.area : "Governance",
    section:  sectionId,
    issue:    String(x?.issue || "").trim(),
    fix:      String(x?.fix || "").trim(),
    patch:    sanitisePatch(x?.patch, f, sec.patchable),
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

export function sanitiseImportedFindings(out, f) {
  const sev = (s) => (["block", "warn", "info"].includes(s) ? s : "warn");
  const rawFindings = Array.isArray(out?.findings) ? out.findings : [];
  const findings = rawFindings.map((x) => {
    const sectionId = SECTIONS[x?.section] ? x.section : "tujuan";
    return {
      severity: sev(x?.severity),
      area:     REVIEW_AREAS.includes(x?.area) ? x.area : "Governance",
      section:  sectionId,
      issue:    String(x?.issue || "").trim(),
      fix:      String(x?.fix || "").trim(),
      patch:    sanitisePatch(x?.patch, f, SECTIONS[sectionId].patchable),
    };
  }).filter((x) => x.issue);
  const order = { block: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

// Ask the LLM for JSON with the bounded retry policy (reformat on bad JSON /
// plain retry on transient — max 2 calls).
async function chatJson({ system, user, log }) {
  let calls = 0;
  const ask = (u) => {
    calls++;
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
      if (first.finish === "length" && !(Array.isArray(out.findings) && out.findings.length)) {
        out = null;
        throw new Error("length-truncated");
      }
    } catch {
      out = extractJson((await ask(
        `${user}\n\nKeluaran Anda sebelumnya terpotong atau BUKAN JSON valid:\n${String(first.content).slice(0, 4000)}\n\n` +
        "Kirim ulang HANYA JSON valid sesuai skema — langsung JSON, tanpa penjelasan, tanpa code fence.",
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

async function reviewSection(f, sectionId, log) {
  const sec = SECTIONS[sectionId];
  const [examples, policyHits] = await Promise.all([
    sec.useExamples
      ? pickExamples(
          { affected_systems: f.affected_systems, provided: f.examples || [], queryText: recordToEmbeddingText(f) },
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

const IMPORT_SYSTEM = `Anda adalah asisten SRE di perusahaan yang membantu merevisi MOP (Method of Procedure) berdasarkan feedback yang BENAR-BENAR diterima dari reviewer setelah MOP ini diajukan.

Anda diberi (1) seluruh isi form MOP SAAT INI dalam JSON, dan (2) teks feedback mentah — biasanya ekspor CSV, bisa juga teks bebas. Tugas: ubah SETIAP poin feedback yang MASIH menjadi pekerjaan tersisa menjadi finding actionable, format yang sama dengan review internal aplikasi ini.

ATURAN PENTING:
1. Bandingkan tiap poin dengan isi field yang bersangkutan di form SAAT INI — bila SUDAH menjawab poin tsb, JANGAN buat finding.
2. Bila kolom Remark menunjukkan sudah dikerjakan ATAU sengaja tidak diikuti, JANGAN buat finding.
3. Satu baris bisa menghasilkan 0, 1, atau beberapa finding.
4. JANGAN mengarang temuan yang tidak berasal dari teks feedback.
5. "section" WAJIB salah satu dari: ${REVIEW_SECTIONS.map((s) => `"${s.id}" (${s.label})`).join(", ")}.

Kembalikan HANYA JSON:
{ "findings": [ { "severity": "block"|"warn"|"info", "area": "Governance"|"Security"|"Konsistensi"|"Bahasa", "section": string, "issue": string, "fix": string, "patch": { "field": string, "value": <nilai pengganti> } | null } ] }

"severity": "block" bila reviewer eksplisit meminta diperbaiki; "warn" concern berisiko; "info" saran. ${LANG_RULE}

Aturan "patch":
- Sertakan HANYA bila konkret dan yakin; jika ragu set null dan jelaskan di "fix".
- "field" = nama field PERSIS seperti pada JSON form SAAT INI.
- "value" = nilai pengganti UTUH; untuk array kirim ARRAY LENGKAP.
- JANGAN sertakan patch yang nilainya sama dengan nilai saat ini.`;

/* ── Routes ──────────────────────────────────────────────────────────────── */

// Coerce a raw step from the model into the full step shape. A real step has
// a non-empty action; blank/filler rows are dropped. Status defaults to
// "pending" (the plan-time value). rollback_action kept as-is (empty flagged
// by govCheck, not forced here).
const str = (v) => String(v ?? "").trim();
const coerceStep = (s, fallbackOwner) => ({
  step_no: str(s?.step_no),
  phase: ENUMS.stepPhase.includes(s?.phase) ? s.phase : "Eksekusi",
  action: str(s?.action),
  command: str(s?.command),
  expected_result: str(s?.expected_result),
  target_system: str(s?.target_system),
  duration_min: str(s?.duration_min),
  owner: str(s?.owner) || fallbackOwner,
  rollback_action: str(s?.rollback_action),
  status: "pending",
  actual_result: "",
  executed_by: "",
});
const coerceRow = (r, keys) => Object.fromEntries(keys.map((k) => [k, str(r?.[k])]));

export default async function aiRoutes(app) {
  app.post("/api/draft", async (req, reply) => {
    if (invalid(reply, validateDraftInput, req.body || {})) return;
    if (!llmConfigured("draft")) return llmUnconfigured(reply);

    const { intent = "", affected_systems = [], author = "", examples = [] } = req.body || {};
    if (!intent.trim() && !affected_systems.length) {
      return reply.code(400).send({ error: "Provide at least an intent or affected systems." });
    }

    const draftQuery = [intent, affected_systems.join(", ")].filter(Boolean).join(" \n");
    const [picked, policyHits] = await Promise.all([
      pickExamples({ affected_systems, provided: examples, queryText: draftQuery }),
      searchPolicy(draftQuery),
    ]);
    const userPrompt = [
      picked.length
        ? `Contoh MOP sebelumnya (untuk meniru gaya & struktur):\n${JSON.stringify(picked, null, 2)}`
        : "Belum ada contoh MOP sebelumnya — gunakan praktik SRE & ops yang baik.",
      "",
      policyHits.length
        ? `Kutipan Company IT Policy terkait (sumber: ${[...new Set(policyHits.map((h) => h.source))].join(", ")}) — patuhi ini:\n${policyHits.map((h) => h.text).join("\n---\n")}`
        : "",
      "",
      "Buat draft MOP baru untuk prosedur berikut:",
      `- Intent: ${intent || "(tidak disebutkan)"}`,
      `- Sistem terpengaruh: ${affected_systems.join(", ") || "(tidak disebutkan)"}`,
      `- Penyusun/PIC default: ${author || "(tidak disebutkan)"}`,
    ].join("\n");

    try {
      const raw = await chat({ system: DRAFT_SYSTEM, user: userPrompt, temperature: 0.4, json: true, task: "draft" });
      const draft = extractJson(raw);
      const owner = str(author);
      const clean = {
        title:           str(draft.title),
        purpose:         str(draft.purpose),
        in_scope:        (Array.isArray(draft.in_scope) ? draft.in_scope : []).map(str).filter(Boolean),
        out_of_scope:    (Array.isArray(draft.out_of_scope) ? draft.out_of_scope : []).map(str).filter(Boolean),
        impact_summary:  str(draft.impact_summary),
        dependencies:    (Array.isArray(draft.dependencies) ? draft.dependencies : []).map(str).filter(Boolean),
        rollback_deadline:  str(draft.rollback_deadline),
        rollback_triggers:  str(draft.rollback_triggers),
        prerequisites: (Array.isArray(draft.prerequisites) ? draft.prerequisites : [])
          .map((r) => coerceRow(r, ["description", "pass_criteria", "owner"]))
          .filter((r) => r.description),
        steps: sortByPhase((Array.isArray(draft.steps) ? draft.steps : [])
          .map((s) => coerceStep(s, owner))
          .filter((s) => s.action)),
        verification: (Array.isArray(draft.verification) ? draft.verification : [])
          .map((r) => coerceRow(r, ["criterion", "method", "target", "owner"]))
          .filter((r) => r.criterion),
      };
      return { draft: clean, examplesUsed: picked.length, policyUsed: policyHits.length };
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: `Draft generation failed: ${err.message}` });
    }
  });

  app.post("/api/chat", async (req, reply) => {
    if (!llmConfigured("chat")) return llmUnconfigured(reply);
    const { question = "", record = {}, history = [] } = req.body || {};
    if (!String(question).trim()) return reply.code(400).send({ error: "question is required" });

    const systems = Array.isArray(record.affected_systems) ? record.affected_systems : [];
    const chatQuery = `${question}\n${recordToEmbeddingText(record)}`;
    const [picked, policyHits] = await Promise.all([
      pickExamples({ affected_systems: systems, queryText: chatQuery }),
      searchPolicy(chatQuery),
    ]);

    const userPrompt = [
      picked.length ? `Contoh MOP terkait:\n${JSON.stringify(picked, null, 2)}` : "Belum ada contoh MOP terkait.",
      "",
      policyHits.length
        ? `Kutipan Company IT Policy terkait (sumber: ${[...new Set(policyHits.map((h) => h.source))].join(", ")}):\n${policyHits.map((h) => h.text).join("\n---\n")}`
        : "",
      "Setiap key di JSON draft di bawah adalah field form yang benar-benar ada, meski nilainya kosong (\"\") — field kosong BUKAN berarti field itu tidak ada.",
      `Draft MOP yang sedang dikerjakan user:\n${JSON.stringify(record, null, 2)}`,
      history.length ? `\nRiwayat percakapan:\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}` : "",
      `\nPertanyaan user: ${question}`,
    ].filter(Boolean).join("\n");

    try {
      const answer = await chat({ system: CHAT_SYSTEM, user: userPrompt, temperature: 0.3, json: false, task: "chat" });
      return { answer, examplesUsed: picked.length, policyUsed: policyHits.length };
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: `Chat failed: ${err.message}` });
    }
  });

  app.post("/api/review/section", async (req, reply) => {
    const sectionId = String(req.query?.section || "");
    if (!SECTIONS[sectionId]) {
      return reply.code(400).send({
        error: `Unknown section "${sectionId}". Valid: ${REVIEW_SECTIONS.map((s) => s.id).join(", ")}`,
      });
    }
    if (invalid(reply, validateMop, req.body || {})) return;
    if (!llmConfigured("review")) return llmUnconfigured(reply);
    return reviewSection(req.body || {}, sectionId, app.log);
  });

  app.post("/api/review/import", async (req, reply) => {
    if (invalid(reply, validateImportInput, req.body || {})) return;
    if (!llmConfigured("review")) return llmUnconfigured(reply);
    const { record = {}, feedback = "" } = req.body || {};
    if (!feedback.trim()) {
      return reply.code(400).send({ error: "Feedback kosong — tempel atau unggah teks feedback terlebih dahulu." });
    }
    const user = [
      "Form MOP SAAT INI:",
      JSON.stringify(record, null, 2),
      "",
      "Teks feedback (mentah):",
      feedback.slice(0, 20000),
    ].join("\n");
    const { out, error } = await chatJson({ system: IMPORT_SYSTEM, user, log: app.log });
    if (!out) return reply.code(502).send({ error: `Impor feedback gagal: ${error}` });
    return { findings: sanitiseImportedFindings(out, record) };
  });
}
