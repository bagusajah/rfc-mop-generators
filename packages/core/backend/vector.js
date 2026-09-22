// Generic Qdrant + OpenAI-compatible embeddings primitives.
//
// Collection-agnostic: any corpus (RFC examples, MOP examples, IT-policy
// chunks, …) calls these with its own collection name. App-specific wrappers
// (see apps/rfc/backend/vector-rfc.js) supply the collection name + the
// record→embedding-text projection specific to that corpus.
//
// All calls are best-effort: failures are logged and swallowed so vector-store
// hiccups never break an HTTP request. When unconfigured, vectorConfigured()
// is false and callers fall back to their own non-vector logic.
//
// Configuration (env):
//   QDRANT_URL       e.g. http://qdrant:6333
//   EMBED_BASE_URL   OpenAI-compatible base, e.g. http://ollama:11434/v1
//   EMBED_API_KEY    bearer (any non-empty value for Ollama)
//   EMBED_MODEL      e.g. bge-m3  (1024-dim, multilingual incl. Bahasa Indonesia)
//   EMBED_DIM        vector size (default 1024, must match the model)

import crypto from "node:crypto";

const QDRANT_URL   = process.env.QDRANT_URL || "";
const EMBED_BASE   = (process.env.EMBED_BASE_URL || "").replace(/\/+$/, "");
const EMBED_KEY    = process.env.EMBED_API_KEY || "";
const EMBED_MODEL  = process.env.EMBED_MODEL || "";
const EMBED_DIM    = Number(process.env.EMBED_DIM) || 1024;

export function vectorConfigured() {
  return Boolean(QDRANT_URL && EMBED_BASE && EMBED_MODEL);
}

// Qdrant point IDs must be uint64 or UUID. Source ids aren't guaranteed to be
// UUIDs (an RFC fixture id, a MOP id, or "<policy-slug>#<chunk-index>"), so
// derive a deterministic 48-bit positive integer from the id string — stable
// across upsert/delete, collision-free for any realistic corpus size.
export function pointIdFor(id) {
  const hex = crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 12);
  return parseInt(hex, 16);
}

// ── Embeddings ──────────────────────────────────────────────────────────────

export async function embed(texts) {
  const res = await fetch(`${EMBED_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(EMBED_KEY ? { Authorization: `Bearer ${EMBED_KEY}` } : {}),
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // OpenAI-compatible: { data: [{ embedding: [...] }] }
  return json.data.map((d) => d.embedding);
}

// ── Qdrant REST client (raw fetch, no SDK) ──────────────────────────────────

const _ensured = new Set();
export async function ensureCollection(collection) {
  if (_ensured.has(collection)) return;
  const res = await fetch(`${QDRANT_URL}/collections/${collection}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: EMBED_DIM, distance: "Cosine" } }),
  });
  // 200 = created; 409 = already exists (e.g. a previous process / the seed
  // script). Either way the collection is usable.
  if (!res.ok && res.status !== 409) {
    throw new Error(`qdrant create-collection HTTP ${res.status}: ${await res.text()}`);
  }
  _ensured.add(collection);
}

// Upsert points into a collection. `points` = [{ id, vector, payload }].
export async function upsertPoints(collection, points) {
  await ensureCollection(collection);
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) throw new Error(`qdrant upsert HTTP ${res.status}: ${await res.text()}`);
}

// Semantic nearest-neighbours. Returns raw Qdrant hits
// ({ id, score, payload }) — callers pick the payload shape they stored.
export async function searchPoints(collection, vector, { limit = 3 } = {}) {
  await ensureCollection(collection);
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, limit, with_payload: true }),
  });
  if (!res.ok) throw new Error(`qdrant search HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.result || [];
}

export async function deletePoints(collection, id) {
  if (!vectorConfigured() || !id) return;
  try {
    await fetch(`${QDRANT_URL}/collections/${collection}/points/delete?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [pointIdFor(id)] }),
    });
  } catch (err) {
    console.error(`[vector] delete from ${collection} failed:`, err.message);
  }
}

// ── Collection-bound store factory ──────────────────────────────────────────
// App code builds a store for its own collection + record→text projection,
// instead of every corpus re-implementing the embed/upsert/search plumbing.
//
//   const rfcStore = makeExampleStore({
//     collection: "rfc_examples",
//     toText: (r) => [r.title, r.description, ...].join("\n"),
//     // optional payload projection (defaults to the whole record)
//     payload: (record, example) => ({ id: record.id, ticket: record.ticket, example }),
//   });

export function makeExampleStore({ collection, toText, payload }) {
  return {
    collection,

    // Upsert one record as a point. `extra` is whatever the caller precomputes
    // (e.g. exampleOf(record)) to store alongside. Returns true on success.
    async upsert(record, extra) {
      if (!vectorConfigured() || !record || !record.id) return false;
      try {
        const [vec] = await embed([toText(record)]);
        await upsertPoints(collection, [{
          id: pointIdFor(record.id),
          vector: vec,
          payload: payload ? payload(record, extra) : { ...record, example: extra },
        }]);
        return true;
      } catch (err) {
        console.error(`[vector] upsert to ${collection} failed:`, err.message);
        return false;
      }
    },

    // Semantic nearest-neighbours. Returns the stored `example` payloads for
    // the top-k most similar records to `queryText`.
    async search(queryText, { limit = 3 } = {}) {
      if (!vectorConfigured() || !queryText) return [];
      try {
        const [vec] = await embed([queryText]);
        const hits = await searchPoints(collection, vec, { limit });
        return hits.map((hit) => hit.payload && hit.payload.example).filter(Boolean);
      } catch (err) {
        console.error(`[vector] search on ${collection} failed:`, err.message);
        return [];
      }
    },

    delete: (id) => deletePoints(collection, id),
  };
}
