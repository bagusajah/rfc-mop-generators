#!/usr/bin/env node
// Bulk-import historical approved RFCs (parsed from PDF + joined with the
// tracker) into the file corpus (RFC/corpus/*.json) + Qdrant, so the AI
// draft/review features ground in the full corpus.
//
// Pipeline (each step re-runnable / idempotent):
//   1. python3 ../tools/read_tracker.py   → RFC/imported/_tracker.json
//   2. python3 ../tools/parse_pdf.py       → RFC/imported/<ticket>.json (per PDF)
//   3. THIS SCRIPT: join + LLM-classify changeType + write corpus + embed
//
// Run from the backend/ dir (or anywhere — it resolves paths from the repo root):
//   node scripts/import-rfcs.js
//
// The tracker supplies title/system/executor/execDate (fields the
// PDF form doesn't contain); the PDF supplies the prose (description/risks/tasks/
// rollback). Records merge on a filename-prefix match. changeType is classified
// by one cheap LLM call per record (left "Other" when LLM is unconfigured).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat, llmConfigured } from "../../../../packages/core/backend/llm.js";
import { ENUMS } from "../../rfc-schema.js";
import { upsertRfc } from "../vector-rfc.js";
import { exampleOf } from "../examples.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const IMPORT_DIR = path.join(REPO, "RFC", "imported");
const TRACKER_JSON = path.join(IMPORT_DIR, "_tracker.json");
const CORPUS_DIR = path.join(REPO, "RFC", "corpus");

const safeName = (s) =>
  String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "record";

// Normalise a filename/string to a prefix key for fuzzy matching.
function norm(s) {
  return String(s || "").toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 30);
}

// Derive a readable title from the source PDF filename as a last-resort
// fallback (used when the tracker has no entry AND the PDF-parsed title is
// garbage from header-layout bleed).
function titleFromFile(filename) {
  const base = path.basename(filename || "", ".pdf");
  return base
    .replace(/^[\d\-_]+\s*[-_]?\s*/, "")            // leading date / index prefix
    .replace(/_signe[^_]*$/i, "")                    // digital-sign suffix
    .replace(/^Form Permintaan (Perubahan|Pembuatan)\b[-:\s]*/i, "")
    .replace(/^Formulir\b[-:\s]*/i, "")
    .replace(/^RFC\b[-:\s]*/i, "")
    .trim();
}
function looksLikeHeaderBleed(t) {
  return /Target Penyelesaian|Nama Proyek|Departemen Pemohon|Tanggal Permintaan|Nomor Permintaan/i.test(t || "");
}

// Find the best tracker row for a parsed PDF record (by source filename prefix).
function joinTracker(parsed, tracker) {
  const srcKey = norm(parsed.source_file);
  let best = null;
  for (const t of tracker) {
    const tKey = norm(t.filename);
    if (!tKey) continue;
    // match if one prefix contains the other (tracker cells are often truncated)
    if (srcKey && (srcKey.startsWith(tKey.slice(0, 20)) || tKey.startsWith(srcKey.slice(0, 20)))) {
      best = t;
      break;
    }
  }
  return best;
}

// One cheap LLM call → pick exactly one changeType from ENUMS.changeType.
// Best-effort: an unreachable LLM must not stall the whole import, so each
// call is bounded by a 45s timeout (reasoning models occasionally run long)
// and falls back to "Other" on failure. Only after 3 consecutive failures do
// we skip the LLM for the rest of the batch — one slow call isn't "down".
let _llmFails = 0;
async function classifyChangeType(rec) {
  if (!llmConfigured() || _llmFails >= 3) return "Other";
  const system = `You classify an IT change request into exactly one category. Reply with ONLY a JSON object {"changeType": "<one of the list>"} and nothing else.`;
  const user = `Categories: ${ENUMS.changeType.join(", ")}\n\nTitle: ${rec.title}\nSystem: ${rec.system || ""}\nDescription: ${(rec.description || "").slice(0, 300)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const raw = await chat({ system, user, temperature: 0, json: true, signal: ctrl.signal });
    const m = raw.match(/\{[\s\S]*\}/);
    const val = m ? JSON.parse(m[0]).changeType : "";
    _llmFails = 0;
    return ENUMS.changeType.includes(val) ? val : "Other";
  } catch (e) {
    _llmFails++;
    console.warn(`  ⚠ LLM classify failed (${_llmFails}/3${_llmFails >= 3 ? " — skipping for the rest of the batch" : ""}) → "Other". ${e.message.slice(0, 80)}`);
    return "Other";
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!fs.existsSync(TRACKER_JSON)) {
    console.error(`Tracker not found at ${TRACKER_JSON}.\nRun: python3 ../tools/read_tracker.py`);
    process.exit(1);
  }
  const tracker = JSON.parse(fs.readFileSync(TRACKER_JSON, "utf8"));
  const parsedFiles = fs.readdirSync(IMPORT_DIR)
    .filter((n) => n.endsWith(".json") && n !== "_tracker.json")
    .map((n) => path.join(IMPORT_DIR, n));

  if (!parsedFiles.length) {
    console.error(`No parsed PDF records in ${IMPORT_DIR}.\nRun: python3 ../tools/parse_pdf.py`);
    process.exit(1);
  }

  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  console.log(`Importing ${parsedFiles.length} parsed RFC(s) into ${path.relative(REPO, CORPUS_DIR)}/ …`);
  let ok = 0, skipped = 0, joined = 0, errors = 0;
  for (const file of parsedFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const ticket = parsed.ticket || `IMPORT-${path.basename(file, ".json")}`;
      const t = joinTracker(parsed, tracker);
      if (t) joined++;

      // Merge: tracker fields preferred (cleaner/curated), PDF prose retained.
      // Title: tracker (cleanest) → parsed PDF → filename fallback (if PDF is
      // header-bleed garbage and no tracker match exists).
      const execDate = (t && t.execDate) ? String(t.execDate).slice(0, 10) : (parsed.execDate || parsed.tanggal_permintaan || "");
      const isExecuted = execDate && new Date(execDate) < new Date() && (parsed.tasks?.length || 0) > 0;
      let title = (t && t.title) || parsed.title || "";
      if ((!title || looksLikeHeaderBleed(title)) && !t) title = titleFromFile(parsed.source_file);
      const rec = {
        id: "import-" + crypto.createHash("sha1").update(ticket).digest("hex").slice(0, 12),
        ticket,
        title,
        system:       (t && t.system) || "",
        changeType:   "",                       // filled below
        description:  parsed.description || "",
        tujuan:       parsed.tujuan || "",
        executor:     (t && t.executor) || parsed.executor || "",
        requester:    parsed.departemen || "Information & Digital Technology",
        execDate,
        urgensi:      parsed.urgensi || "Medium",
        jadwal_hari:  parsed.jadwal_hari || "",
        jadwal_jam:   parsed.jadwal_jam || "",
        jadwal_estimasi: parsed.jadwal_estimasi || "",
        sistem_terpengaruh: parsed.sistem_terpengaruh || "",
        komponen:     [],
        risks:        parsed.risks || [],
        mitigasi:     parsed.mitigasi || "",
        klasifikasi:  parsed.klasifikasi || "Minor",
        sec_requirements: parsed.sec_requirements || [],
        tasks:        parsed.tasks || [],
        rollback:     parsed.rollback || [],
        alasan_pengecualian: parsed.alasan_pengecualian || "",
        compensating_control: parsed.compensating_control || "",
        docLink:      (t && t.docLink) || "",
        gdocLinks:    [],
        status:       isExecuted ? "Executed" : "Approved",
        createdAt:    parsed.tanggal_permintaan || execDate || new Date().toISOString(),
        updatedAt:    new Date().toISOString(),
      };
      // Re-runs keep an existing usable classification (also preserves manual
      // corrections in the corpus file); only unclassified/"Other" records pay
      // an LLM call.
      const outFile = path.join(CORPUS_DIR, `${safeName(rec.ticket)}.json`);
      let prevType = "";
      if (fs.existsSync(outFile)) {
        try { prevType = JSON.parse(fs.readFileSync(outFile, "utf8")).changeType || ""; } catch {}
      }
      rec.changeType = (prevType && prevType !== "Other" && ENUMS.changeType.includes(prevType))
        ? prevType
        : await classifyChangeType(rec);

      fs.writeFileSync(outFile, JSON.stringify(rec, null, 2) + "\n");
      await upsertRfc(rec, exampleOf(rec));
      ok++;
      console.log(`  ✓ ${rec.ticket} — ${rec.title.slice(0, 60) || "(no title)"} [${rec.changeType}/${rec.status}]${t ? "" : " (no tracker match)"}`);
    } catch (e) {
      errors++;
      console.error(`  ✗ ${path.basename(file)}: ${e.message}`);
    }
  }

  console.log(`\nDone: ${ok} imported (${joined} joined with tracker, ${errors} errors).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
