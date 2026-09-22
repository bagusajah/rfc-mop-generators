// Regression guard: render every record in backend/fixtures/ through the real
// template and assert the .docx comes out valid with its actual content.
// These fixtures are real approved RFCs — if a template or mapping change breaks
// them, this fails loudly. Run: npm run fixture:check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { recordToTemplateData, reviewersOf, approversOf } from "./template-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const templatePath = path.join(here, "rfc_template.docx");

const files = fs.existsSync(fixturesDir)
  ? fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))
  : [];

if (!files.length) {
  console.log("No fixtures found in backend/fixtures/ — nothing to check.");
  process.exit(0);
}

// Synthetic sign-off stress case (kept out of fixtures/ — those stay real
// approved RFCs): 1 + 4 reviewers overflows MAX_PER_ROW so the boxes must wrap
// into stacked tables, and all 8 signatories must come out labelled.
const wrapStress = {
  title: "Sign-off wrap stress",
  description: "Synthetic record exercising sign-off box wrapping.",
  executor: "Penyusun Satu",
  sec_requirements: [{ status: "Dapat Dipenuhi", reason: "" }],
  reviewers: [1, 2, 3, 4].map((i) => ({ name: `Reviewer ${i}`, title: `Jabatan R${i}` })),
  approvers: [1, 2, 3].map((i) => ({ name: `Approver ${i}`, title: `Jabatan A${i}` })),
};

const jobs = [
  ...files.map((file) => ({
    file,
    record: JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf-8")),
  })),
  { file: "(synthetic) sign-off wrap stress", record: wrapStress },
];

let failed = 0;
for (const { file, record } of jobs) {
  try {
    const zip = new PizZip(fs.readFileSync(templatePath, "binary"));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(recordToTemplateData(record));
    const buf = doc.getZip().generate({ type: "nodebuffer" });

    // Pull the rendered document text back out to assert real content landed.
    // Decode the common XML entities so values like "A & B" match their escaped
    // form ("A &amp; B") in the part XML.
    const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const outZip = new PizZip(buf);
    const xml = outZip.file("word/document.xml").asText();
    const text = decode(xml.replace(/<[^>]+>/g, " "));

    const must = [
      record.description?.slice(0, 25),            // deskripsi rendered
      record.tasks?.[0]?.pengerjaan?.slice(0, 20), // first task text
      record.risks?.[0]?.risiko?.slice(0, 15),     // first risk
      "Dapat Dipenuhi",                            // composed security status
      record.reviewers?.[0]?.name,                 // dynamic reviewer loop rendered
      record.reviewers?.[1]?.title,                // reviewer job title rendered
      record.approvers?.at(-1)?.name,              // dynamic approver loop rendered
      record.tasks?.find((t) => t.phase)?.phase,   // tasklist phase section header rendered
    ].filter(Boolean);
    const missing = must.filter((m) => !text.includes(m));

    // Sign-off boxes: the {@signoff} raw XML must yield one labelled box per
    // signatory — "Disusun oleh" exactly once, one "Direview oleh" /
    // "Disetujui oleh" per (bridged) reviewer/approver, under the header.
    const count = (s) => (text.match(new RegExp(s, "g")) || []).length;
    const boxErrors = [
      ["Pengesahan Dokumen", 1],
      ["Disusun oleh", 1],
      ["Direview oleh", reviewersOf(record).length],
      ["Disetujui oleh", approversOf(record).length],
    ]
      .filter(([label, n]) => count(label) !== n)
      .map(([label, n]) => `"${label}" ×${count(label)} (expected ${n})`);

    // No unresolved {placeholders} should remain.
    const leftover = (text.match(/\{[a-z_#/@][^}]*\}/g) || []).filter(
      (t) => !/\{\s*\}/.test(t),
    );

    // ── Header coverage ──
    // The repeating page header holds the identity fields (Nomor Dokumen, Nama
    // Proyek, Target Penyelesaian, Departemen, Urgensi, Nama Pemohon). Assert no
    // header placeholder is left unresolved and that the executor/requester
    // actually rendered into Nama Pemohon / Departemen — these have historically
    // been silently broken because document.xml checks never reach headerN.xml.
    const headerTexts = Object.keys(outZip.files)
      .filter((n) => /^word\/header\d+\.xml$/.test(n))
      .map((n) => decode(outZip.file(n).asText().replace(/<[^>]+>/g, " ")));
    const headerMust = [
      record.executor,                                  // → Nama Pemohon
      record.requester || "Information & Digital Technology", // → Departemen
    ].filter(Boolean);
    // A value passes if it landed in ANY header part.
    const headerMustMissing = headerMust.filter(
      (m) => !headerTexts.some((ht) => ht.includes(m)),
    );
    const headerLeftover = [];
    for (const ht of headerTexts) {
      headerLeftover.push(...(ht.match(/\{[a-z_#/][^}]*\}/g) || []).filter(
        (t) => !/\{\s*\}/.test(t),
      ));
    }

    if (missing.length || leftover.length || boxErrors.length || headerMustMissing.length || headerLeftover.length) {
      failed++;
      console.log(`✗ ${file}`);
      if (missing.length) console.log(`   missing expected text: ${missing.join(" | ")}`);
      if (leftover.length) console.log(`   unresolved placeholders: ${[...new Set(leftover)].join(", ")}`);
      if (boxErrors.length) console.log(`   sign-off boxes: ${boxErrors.join(", ")}`);
      if (headerMustMissing.length) console.log(`   header missing: ${headerMustMissing.join(" | ")}`);
      if (headerLeftover.length) console.log(`   header unresolved placeholders: ${[...new Set(headerLeftover)].join(", ")}`);
    } else {
      console.log(`✓ ${file}  (${buf.length.toLocaleString()} bytes)`);
    }
  } catch (err) {
    failed++;
    console.log(`✗ ${file}  — render error: ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} fixture(s) failed.`);
  process.exit(1);
}
console.log(`\n✓ All ${jobs.length} fixture(s) render cleanly.`);
