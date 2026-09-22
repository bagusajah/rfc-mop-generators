// One-off backfill: correct titles on imported historical RFCs.
//
// The PDF import ran with a title-extraction bug (the header regex captured
// fragments of neighbouring table cells, copying e.g. "Tiket Manajemen Akses
// - Penambahan Opsi System" across many records). tools/parse_pdf.py now
// reads the title from the header-table cell itself; this script pushes the
// re-parsed titles from RFC/imported/*.json into the DB, keyed by ticket.
//
// Goes through PUT /api/rfcs/:id (not the DB directly) so the vector store is
// re-embedded. Idempotent: skips records whose title already matches.
//
// Usage: backend must be running, then  node tools/backfill-titles.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.RFC_API || "http://localhost:3001";
const IMPORTED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "RFC", "imported");

// ticket → title from the re-parsed JSONs. The one PDF without a ticket
// number was imported as "IMPORT-noticket".
const TITLE_BY_TICKET = {};
for (const f of fs.readdirSync(IMPORTED)) {
  if (!f.endsWith(".json") || f === "_tracker.json") continue;
  const rec = JSON.parse(fs.readFileSync(path.join(IMPORTED, f), "utf8"));
  const ticket = rec.ticket || "IMPORT-noticket";
  if (rec.title) TITLE_BY_TICKET[ticket] = rec.title;
}

// Imported records were inserted directly (no ajv), so some carry Indonesian
// risk levels ("Rendah"/"Sedang"/"Tinggi") in the enum-checked English fields
// and fail PUT validation. Translate; anything untranslatable moves to the
// legacy free-text field (kemungkinan/dampak/tingkat) so no data is lost.
const RISK_ID_EN = { rendah: "Low", sedang: "Medium", menengah: "Medium", tinggi: "High" };
const ENUM_OK = new Set(["Low", "Medium", "High", "", null, undefined]);
function normalizeRisks(risks) {
  if (!Array.isArray(risks)) return risks;
  return risks.map((risk) => {
    const out = { ...risk };
    for (const [en, legacy] of [["likelihood", "kemungkinan"], ["impact", "dampak"], ["risk_level", "tingkat"]]) {
      const v = out[en];
      if (ENUM_OK.has(v)) continue;
      const mapped = RISK_ID_EN[String(v).trim().toLowerCase()];
      if (mapped) out[en] = mapped;
      else { out[legacy] = out[legacy] || String(v); out[en] = ""; }
    }
    return out;
  });
}

const res = await fetch(`${API}/api/rfcs`);
if (!res.ok) throw new Error(`GET /api/rfcs → ${res.status}`);
const records = await res.json();

let updated = 0, skipped = 0, unmapped = [];
for (const r of records) {
  const want = TITLE_BY_TICKET[r.ticket];
  if (!want) { unmapped.push(r.ticket); continue; }
  if (r.title === want) { skipped++; continue; }
  const put = await fetch(`${API}/api/rfcs/${encodeURIComponent(r.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...r, title: want, risks: normalizeRisks(r.risks) }),
  });
  if (!put.ok) throw new Error(`PUT ${r.ticket} → ${put.status}: ${await put.text()}`);
  console.log(`${r.ticket}:\n  ${r.title || "(kosong)"}\n  → ${want}`);
  updated++;
}
console.log(`\n${updated} diperbarui, ${skipped} sudah sesuai, ${unmapped.length} tanpa mapping.`);
if (unmapped.length) console.log("Tanpa mapping (dibiarkan):", unmapped.join(", "));
