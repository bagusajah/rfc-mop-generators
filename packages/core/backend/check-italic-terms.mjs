// Self-check for italic-terms.js: mark → simulate docxtemplater's run
// substitution → verify the marker is split into an italic run cloning the
// original run's <w:rPr>, and that unmarked runs are left byte-identical.
import assert from "node:assert/strict";
import PizZip from "pizzip";
import { markItalicTerms, applyItalicMarkers } from "./italic-terms.js";

// Sentinel chars are private-use-area; referenced by code point (never typed
// literally) so they can't be mangled by editor/tool encoding round-trips.
const MARK_OPEN = String.fromCharCode(0xe000);
const markCount = (s) => (s.match(new RegExp(MARK_OPEN, "g")) || []).length;

// Phrase should win over its component word ("load balancer" not "load").
const marked = markItalicTerms("Setelah restart server, cek load balancer dan database.");
assert.match(marked, /server/);
assert.equal(markCount(marked), 3, "server, load balancer, database each marked once");

// Simulate the exact run shape docxtemplater emits for a plain-text tag.
const run = (text) =>
  `<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const untouched = run("Tidak ada istilah asing di sini.");
const doc = `<w:document><w:body><w:p>${run(marked)}${untouched}</w:p></w:body></w:document>`;

const zip = new PizZip();
zip.file("word/document.xml", doc);
applyItalicMarkers(zip);
const out = zip.file("word/document.xml").asText();

assert.equal(out.includes(untouched), true, "run without markers is untouched");
assert.equal(markCount(out), 0, "no sentinel chars leak into the output");
assert.equal(/xml:space="preserve"[^>]*xml:space="preserve"/.test(out), false,
  "xml:space isn't duplicated when the source run already carried it");
assert.match(out, /<w:i\/><w:iCs\/>[\s\S]*?<w:t[^>]*>server<\/w:t>/, "server becomes its own italic run");
assert.match(out, /<w:t[^>]*>load balancer<\/w:t>/, "multi-word phrase kept whole");
const runs = out.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g);
assert.ok(runs.some((r) => r.includes("Setelah restart") && !r.includes("<w:i/>")),
  "surrounding Indonesian text stays non-italic and keeps the original <w:rPr>");

console.log("italic-terms: ok");
