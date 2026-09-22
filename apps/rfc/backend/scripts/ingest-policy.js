#!/usr/bin/env node
// Chunk + embed every parsed policy doc (policy/parsed/*.json, written by
// tools/parse_policy_pdf.py) into the it_policy Qdrant collection.
//
// Run from the backend/ dir (after parsing):
//   node scripts/ingest-policy.js
// Or both steps: npm run policy:all
//
// Idempotent: chunk ids are deterministic (source + chunk index), so
// re-running after adding a new PDF only adds its chunks.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorConfigured } from "../../../../packages/core/backend/vector.js";
import { upsertPolicyDoc } from "../../../../packages/core/backend/policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSED_DIR = path.resolve(__dirname, "..", "..", "..", "..", "policy", "parsed");

async function main() {
  if (!vectorConfigured()) {
    console.error("Vector store not configured. Set QDRANT_URL, EMBED_BASE_URL, EMBED_MODEL (see .env.example).");
    process.exit(1);
  }
  if (!fs.existsSync(PARSED_DIR)) {
    console.error(`No ${PARSED_DIR} — run \`npm run policy:parse\` first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(PARSED_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    console.error(`No parsed policy docs in ${PARSED_DIR}.`);
    process.exit(1);
  }

  console.log(`Embedding ${files.length} policy doc(s) into Qdrant…`);
  let ok = 0, failed = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, f), "utf8"));
    const n = await upsertPolicyDoc(doc);
    if (n >= 0) { ok++; console.log(`  ✓ ${doc.source} — ${n} chunk(s)`); }
    else { failed++; console.log(`  ✗ ${doc.source} — upsert failed (see [policy] error above)`); }
  }
  console.log(`Done. ${ok} doc(s) upserted, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
