// Few-shot example selection for the MOP AI draft/review endpoints, plus the
// file-based corpus. MOP has no change-type taxonomy, so examples are matched
// by affected-system overlap only.
//
// Corpus (all optional; missing dirs contribute nothing; cached per process):
//   apps/mop/backend/fixtures/*.json  — hand-curated examples committed with the app
//   MOP/corpus/*.json                — bulk-imported records (local-only)
//
// Selection strategy:
//   vector path    — semantic search over Qdrant (vector-mop.js) when configured
//   fallback path  — the file corpus re-ranked by affected-system overlap
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorConfigured, searchSimilar } from "./vector-mop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Local fixtures sit next to this file; bulk-imported corpus is at <repo>/MOP/
// corpus (created on demand — not present until the user runs an import).
export const CORPUS_DIRS = [
  path.join(__dirname, "fixtures"),
  path.resolve(__dirname, "..", "..", "..", "MOP", "corpus"),
];

// Trim a record down to the fields useful as a few-shot example.
export function exampleOf(r) {
  return {
    title: r.title,
    affected_systems: r.affected_systems,
    purpose: r.purpose,
    in_scope: r.in_scope,
    out_of_scope: r.out_of_scope,
    impact_summary: r.impact_summary,
    prerequisites: r.prerequisites,
    steps: r.steps,
    verification: r.verification,
    rollback_deadline: r.rollback_deadline,
    rollback_triggers: r.rollback_triggers,
  };
}

// Relevance of a past MOP as a few-shot example: affected-system overlap.
const overlap = (a, b) => {
  const aa = Array.isArray(a) ? a : (a ? [a] : []);
  const bb = Array.isArray(b) ? b : (b ? [b] : []);
  return aa.some((s) => bb.includes(s)) ? 1 : 0;
};
export function exampleScore(r, { affected_systems }) {
  return overlap(r.affected_systems, affected_systems);
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
        if (rec && (rec.id || rec.title)) records.push(rec);
      } catch (e) {
        console.warn(`[corpus] skip ${f}: ${e.message}`);
      }
    }
  }
  records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const seen = new Set();
  _corpus = records.filter((r) => {
    const key = r.id || r.title;
    return seen.has(key) ? false : seen.add(key);
  });
  console.log(`[corpus] loaded ${_corpus.length} example MOP(s) from ${CORPUS_DIRS.filter((d) => fs.existsSync(d)).length} dir(s)`);
  return _corpus;
}

// Pick the most relevant past MOPs as few-shot examples. Vector path first
// (re-ranked with the system-overlap bonus), falling back to the file corpus.
export async function pickExamples({ affected_systems, provided = [], queryText = "" }, limit = 3) {
  // ── Vector path ──
  if (vectorConfigured() && queryText) {
    const similar = await searchSimilar(queryText, { limit: Math.max(limit * 3, 8) });
    const seen = new Set();
    const pool = [];
    for (const ex of [...similar, ...provided.map(exampleOf)]) {
      if (!ex) continue;
      const key = ex.title || JSON.stringify(ex).slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(ex);
    }
    const out = pool
      .map((ex) => ({ ex, s: exampleScore(ex, { affected_systems }) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.ex);
    if (out.length) return out;
  }

  // ── Fallback: system-overlap over the file corpus ──
  const seen = new Set();
  const pool = [];
  for (const r of [...loadCorpus(), ...provided]) {
    const key = r.id || r.title || JSON.stringify(r).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(r);
  }
  return pool
    .map((r) => ({ r, s: exampleScore(r, { affected_systems }) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => exampleOf(x.r));
}
