#!/usr/bin/env node
// (Re-)seed the Qdrant vector store from the file corpus: every example RFC in
// backend/fixtures/*.json and RFC/corpus/*.json. Safe to re-run (upserts are
// idempotent on RFC id).
//
// Run from the backend/ dir:
//   node scripts/seed-vector.js
//
// From the host against the compose services, override the container hostnames:
//   QDRANT_URL=http://localhost:6333 EMBED_BASE_URL=http://localhost:11434/v1 \
//   EMBED_API_KEY=ollama EMBED_MODEL=bge-m3 node scripts/seed-vector.js
//
// Requires the qdrant + embedding (ollama bge-m3) services to be up and
// EMBED_MODEL already pulled (`docker compose exec ollama ollama pull bge-m3`).

import "dotenv/config";
import * as vector from "../vector-rfc.js";
import { loadCorpus, exampleOf } from "../examples.js";

async function main() {
  if (!vector.vectorConfigured()) {
    console.error("Vector store not configured. Set QDRANT_URL, EMBED_BASE_URL, EMBED_MODEL (see .env.example).");
    process.exit(1);
  }

  const records = loadCorpus();
  console.log(`Embedding ${records.length} RFC(s) into Qdrant…`);

  let ok = 0, failed = 0;
  for (const rec of records) {
    const success = await vector.upsertRfc(rec, exampleOf(rec));
    if (success) {
      ok++;
      console.log(`  ✓ ${rec.ticket || rec.id} — ${(rec.title || "").trim()}`.trim());
    } else {
      failed++;
      console.log(`  ✗ ${rec.ticket || rec.id} — upsert failed (see [vector] error above)`);
    }
  }
  console.log(`Done. ${ok} upserted, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
