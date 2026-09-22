// MOP-specific vector store — the mop_examples Qdrant collection. Builds on
// the generic primitives + makeExampleStore factory in packages/core/backend/
// vector.js. The record→embedding-text projection concatenates the MOP's Bahasa
// prose fields so two MOPs with similar *meaning* embed close together
// (deliberately excludes people names, datetimes, ids as similarity noise).
import {
  vectorConfigured, makeExampleStore,
} from "../../../packages/core/backend/vector.js";

// Render a MOP record as the text that gets embedded.
export function recordToEmbeddingText(r) {
  const lines = [];
  const push = (s) => { if (s) lines.push(String(s).trim()); };
  push(r.title);
  if (Array.isArray(r.affected_systems)) r.affected_systems.forEach((s) => push(s));
  push(r.purpose);
  if (Array.isArray(r.in_scope)) r.in_scope.forEach((s) => push(s));
  push(r.impact_summary);
  if (Array.isArray(r.prerequisites)) r.prerequisites.forEach((p) => push(p && p.description));
  if (Array.isArray(r.steps)) r.steps.forEach((s) => push(s && s.action));
  if (Array.isArray(r.verification)) r.verification.forEach((v) => push(v && v.criterion));
  push(r.rollback_triggers);
  return lines.filter(Boolean).join("\n");
}

const store = makeExampleStore({
  collection: "mop_examples",
  toText: recordToEmbeddingText,
  payload: (record, example) => ({
    id: record.id,
    status: record.status || "Draft",
    affected_systems: record.affected_systems || [],
    example,
  }),
});

// Public surface: upsertMop / searchSimilar / deleteMop + vectorConfigured,
// consumed by ai.js / server.js / examples.js.
export const upsertMop = (record, example) => store.upsert(record, example);
export const searchSimilar = (queryText, opts) => store.search(queryText, opts);
export const deleteMop = (id) => store.delete(id);

export { vectorConfigured };
