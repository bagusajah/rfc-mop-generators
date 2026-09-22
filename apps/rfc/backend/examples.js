// Few-shot example selection for the AI draft/review endpoints, plus the
// file-based corpus that replaced the SQLite tracker after the rewrite.
//
// The corpus is the set of historical approved RFCs the LLM grounds in:
//   backend/fixtures/*.json   — hand-curated examples committed with the app
//   RFC/corpus/*.json         — bulk-imported records (see scripts/import-rfcs.js)
// Both directories are optional; missing dirs simply contribute nothing. The
// corpus is static per process, so it's read once and cached.
//
// Selection strategy (unchanged from the tracker era):
//   vector path    — semantic search over Qdrant (vector.js), re-ranked by
//                    exact changeType/system match, when QDRANT_URL is set
//   fallback path  — the file corpus re-ranked by the same exact-match score

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { categoryOf } from "../rfc-schema.js";
import { vectorConfigured, searchSimilar } from "./vector-rfc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Local fixtures sit next to this file; the bulk-imported corpus is bind-mounted
// at <repo>/RFC/corpus in compose (mounted at /app/RFC/corpus in the container — see
// Dockerfile.backend + docker-compose.yml). Resolve both relative to the repo
// root so dev (file path) and container (cwd) both find them when present.
export const CORPUS_DIRS = [
  path.join(__dirname, "fixtures"),
  path.resolve(__dirname, "..", "..", "..", "RFC", "corpus"),
];

// Trim a record down to the fields useful as a few-shot example.
export function exampleOf(r) {
  return {
    system: r.system, changeType: r.changeType, title: r.title,
    description: r.description, tujuan: r.tujuan,
    sistem_terpengaruh: r.sistem_terpengaruh,
    risks: r.risks, mitigasi: r.mitigasi, klasifikasi: r.klasifikasi,
    tasks: r.tasks, rollback: r.rollback,
  };
}

// Relevance of a past RFC as a few-shot example: exact changeType match ranks
// highest, same category (see CATEGORY_OF in apps/rfc/rfc-schema.js) is a middle
// tier — e.g. a "Compute resize" draft still prefers "Storage expansion"
// examples over unrelated data fixes. Category bonus only when the target
// changeType is set, so two blank drafts don't count as a match.
export function exampleScore(r, { system, changeType }) {
  const ct = r.changeType === changeType ? 2
    : changeType && categoryOf(r) === categoryOf(changeType) ? 1 : 0;
  // `system` is an array on the request side; corpus records `r.system` is
  // still a single string (historical data) — check membership either way.
  const sys = Array.isArray(system) ? system : (system ? [system] : []);
  return ct + (sys.includes(r.system) ? 1 : 0);
}

let _corpus = null;
export function loadCorpus() {
  if (_corpus) return _corpus;
  const records = [];
  for (const dir of CORPUS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (rec && (rec.id || rec.ticket || rec.title)) records.push(rec);
      } catch (e) {
        console.warn(`[corpus] skip ${f}: ${e.message}`);
      }
    }
  }
  // Newest first so the fallback pool favours recent practice (mirrors the old
  // ORDER BY created_at DESC), then dedupe by id/ticket.
  records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const seen = new Set();
  _corpus = records.filter((r) => {
    const key = r.id || r.ticket || r.title;
    return seen.has(key) ? false : seen.add(key);
  });
  console.log(`[corpus] loaded ${_corpus.length} example RFC(s) from ${CORPUS_DIRS.filter((d) => fs.existsSync(d)).length} dir(s)`);
  return _corpus;
}

// Pick the most relevant past RFCs as few-shot examples. When the vector store
// is configured AND a queryText is supplied, uses semantic search over the
// corpus then re-ranks with the exact-field-match bonus; otherwise falls back
// to the file corpus with the same scoring.
export async function pickExamples({ system, changeType, provided = [], queryText = "" }, limit = 3) {
  // ── Vector path ──
  if (vectorConfigured() && queryText) {
    const similar = await searchSimilar(queryText, { limit: Math.max(limit * 3, 8) });
    const seen = new Set();
    const pool = [];
    // similar already holds exampleOf-shaped objects; normalize provided too.
    for (const ex of [...similar, ...provided.map(exampleOf)]) {
      if (!ex) continue;
      const key = ex.ticket || ex.title || JSON.stringify(ex).slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(ex);
    }
    const out = pool
      .map((ex) => ({ ex, s: exampleScore(ex, { system, changeType }) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.ex);
    if (out.length) return out;
    // If the vector store returned nothing (empty/missing), fall through.
  }

  // ── Fallback: exact-field-match over the file corpus ──
  const seen = new Set();
  const pool = [];
  for (const r of [...loadCorpus(), ...provided]) {
    const key = r.ticket || r.id || JSON.stringify(r).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(r);
  }
  return pool
    .map((r) => ({ r, s: exampleScore(r, { system, changeType }) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => exampleOf(x.r));
}
