// RFC-specific vector store — the rfc_examples Qdrant collection.
//
// Builds on the generic primitives + makeExampleStore factory in
// packages/core/backend/vector.js. The record→embedding-text projection here
// is what makes two RFCs with similar *meaning* embed close together: it
// concatenates the Bahasa prose fields that carry "what this change looks
// like" and deliberately excludes people names, dates, ticket ids (noise for
// similarity).

import {
  vectorConfigured, makeExampleStore,
} from "../../../packages/core/backend/vector.js";

// Render an RFC record as the text that gets embedded.
export function recordToEmbeddingText(r) {
  const lines = [];
  const push = (s) => { if (s) lines.push(String(s).trim()); };
  push(r.title); push(r.changeType); push(r.system);
  push(r.description); push(r.tujuan); push(r.sistem_terpengaruh);
  if (Array.isArray(r.risks))    r.risks.forEach((x)    => push(x && x.risiko));
  push(r.mitigasi); push(r.klasifikasi);
  if (Array.isArray(r.tasks))    r.tasks.forEach((x)    => push(x && x.pengerjaan));
  if (Array.isArray(r.rollback)) r.rollback.forEach((x) => push(x && x.pengerjaan));
  return lines.filter(Boolean).join("\n");
}

const store = makeExampleStore({
  collection: "rfc_examples",
  toText: recordToEmbeddingText,
  payload: (record, example) => ({
    ticket: record.ticket || "",
    id: record.id,
    status: record.status || "Draft",
    system: record.system || "",
    changeType: record.changeType || "",
    klasifikasi: record.klasifikasi || "",
    example,                            // precomputed by caller (exampleOf)
  }),
});

// Public surface kept identical to the old monolithic vector.js so ai.js /
// server.js / examples.js import unchanged: upsertRfc / searchSimilar /
// deleteRfc + a re-export of vectorConfigured.
export const upsertRfc = (record, example) => store.upsert(record, example);
export const searchSimilar = (queryText, opts) => store.search(queryText, opts);
export const deleteRfc = (id) => store.delete(id);

export { vectorConfigured };
