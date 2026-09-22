// Company IT Policy corpus: chunk + embed policy documents into their own
// Qdrant collection, separate from rfc_examples (policy prose is long-form,
// unlike the short structured RFC records that collection assumes — see
// vector.js's collection-agnostic upsertPoints/searchPoints).
//
// Source PDFs: policy/pdfs/*.pdf (git-ignored, local-only — internal policy
// text). To add another policy PDF later: drop it in policy/pdfs/, then
// `npm run policy:all` (parses + (re-)embeds; safe to re-run, chunk ids are
// deterministic per source+index so unchanged docs just overwrite in place).

import { vectorConfigured, embed, upsertPoints, searchPoints, pointIdFor } from "./vector.js";

const COLLECTION = "it_policy";
const CHUNK_SIZE = 1200;   // chars; bge-m3 handles ~8k tokens, this keeps
const CHUNK_OVERLAP = 150; // chunks focused enough for precise retrieval

// Split policy text into overlapping chunks on paragraph boundaries where
// possible, so a chunk rarely cuts a sentence mid-way.
// ponytail: a single paragraph longer than CHUNK_SIZE stays as one (over-size)
// chunk rather than being hard-split — fine for policy prose; revisit if a
// doc has pathologically long unbroken paragraphs.
export function chunkText(text) {
  const paras = String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const p of paras) {
    if (current && (current.length + p.length + 2) > CHUNK_SIZE) {
      chunks.push(current);
      current = current.slice(-CHUNK_OVERLAP) + "\n\n" + p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Embed + upsert every chunk of one parsed policy doc. `doc` = { source,
// title, text } (see tools/parse_policy_pdf.py output). Returns the chunk
// count on success, -1 on failure.
export async function upsertPolicyDoc(doc) {
  if (!vectorConfigured() || !doc?.source || !doc?.text) return -1;
  try {
    const chunks = chunkText(doc.text);
    const vectors = await embed(chunks);
    const points = chunks.map((text, i) => ({
      id: pointIdFor(`${doc.source}#${i}`),
      vector: vectors[i],
      payload: { source: doc.source, title: doc.title || doc.source, chunkIndex: i, text },
    }));
    await upsertPoints(COLLECTION, points);
    return chunks.length;
  } catch (err) {
    console.error("[policy] upsert failed:", err.message);
    return -1;
  }
}

// Semantic search over the policy corpus. Returns [{ source, title, text }].
export async function searchPolicy(queryText, { limit = 3 } = {}) {
  if (!vectorConfigured() || !queryText) return [];
  try {
    const [vec] = await embed([queryText]);
    const hits = await searchPoints(COLLECTION, vec, { limit });
    return hits.map((hit) => hit.payload).filter(Boolean);
  } catch (err) {
    console.error("[policy] search failed:", err.message);
    return [];
  }
}
