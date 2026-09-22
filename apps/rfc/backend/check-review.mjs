// Deterministic checks for the review pipeline — no live LLM needed.
// Covers extractJson (fence/prose/trailing-comma/truncation handling),
// ruleFindings (the deterministic governance/security checks), and
// sanitiseSection (LLM-output coercion, patch guards, rule merging).
// Run: npm run review:check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson } from "../../../packages/core/backend/llm.js";
import { ruleFindings, ruleFindingsFor, RULE_SECTION } from "./review-checks.js";
import { SECTIONS, buildSectionPrompt } from "./review-sections.js";
import { sanitiseSection, sanitiseImportedFindings, alignMitigasi, sortByPhase, PATCHABLE, documentBlockers } from "./ai.js";
import { REVIEW_SECTIONS, summarizeReview, dedupeCrossSectionPatches } from "../rfc-schema.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`✓ ${name}`);
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

/* ── extractJson ── */

check("extractJson: bare object", extractJson('{"a":1}').a === 1);
check("extractJson: ```json fence", extractJson('```json\n{"a":2}\n```').a === 2);
check("extractJson: prose around it, } inside a string",
  extractJson('Berikut hasilnya:\n{"summary":"tutup } kurung","findings":[]}\nSemoga membantu.').summary === "tutup } kurung");
check("extractJson: trailing commas repaired",
  extractJson('{"findings":[{"issue":"x",},],}').findings[0].issue === "x");
{
  // finish_reason=length — cut mid-string: close the string and the scopes.
  const out = extractJson('{"ready":false,"findings":[{"severity":"warn","issue":"typo databse');
  check("extractJson: truncated mid-string salvaged",
    out?.findings?.[0]?.issue?.startsWith("typo"), JSON.stringify(out));
}
{
  // Cut right after a complete element: the dangling comma must not kill it.
  const out = extractJson('{"ready":false,"findings":[{"issue":"a"},{"issue":"b"},');
  check("extractJson: truncated after element keeps both findings",
    out?.findings?.length === 2 && out.findings[1].issue === "b", JSON.stringify(out));
}
{
  // Cut mid-key: dropping the dangling fragment keeps the complete findings.
  const out = extractJson('{"ready":false,"findings":[{"issue":"a"}],"summ');
  check("extractJson: truncated mid-key drops the fragment",
    out?.findings?.[0]?.issue === "a", JSON.stringify(out));
}
check("extractJson: no JSON throws", throws(() => extractJson("maaf, tidak bisa")));

/* ── ruleFindings ── */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "example-record.json"), "utf-8"));
check("ruleFindings: approved fixture has no block findings",
  ruleFindings(fixture).filter((x) => x.severity === "block").length === 0,
  JSON.stringify(ruleFindings(fixture)));

const gutted = {
  title: "Perubahan", description: "", sistem_terpengaruh: "", komponen: ["ECS"],
  urgensi: "", jadwal_hari: "", jadwal_jam: "", jadwal_estimasi: "", jadwal_downtime: "", jadwal_pulih: "",
  risks: [], mitigasi: "", klasifikasi: "",
  tasks: [{ phase: "", waktu: "", pengerjaan: "restart service", pic: "" }],
  rollback: [],
  sec_requirements: [{ status: "Tidak Relevan", reason: "" }],
};
{
  const out = ruleFindings(gutted);
  check("ruleFindings: gutted record fails 7 checks as block",
    out.length === 7 && out.every((x) => x.severity === "block"), JSON.stringify(out.map((x) => x.issue)));
  check("ruleFindings: names the missing rollback", out.some((x) => /rollback/i.test(x.issue)));
  check("ruleFindings: names the PIC-less task", out.some((x) => /PIC/.test(x.issue)));
  check("ruleFindings: sec reason lists the row number", out.some((x) => /baris 1/.test(x.issue)));
}

// All 8 checks pass; komponen mentioned in the description → nothing to report.
const complete = {
  description: "Peningkatan kapasitas memori instance PolarDB.", sistem_terpengaruh: "Tim SRE",
  urgensi: "Medium", jadwal_hari: "Senin", jadwal_jam: "10:00", jadwal_estimasi: "45 menit",
  jadwal_downtime: "Tidak ada downtime", jadwal_pulih: "10:45",
  risks: [{ risiko: "resize gagal", likelihood: "Low", impact: "Low" }], mitigasi: "Rollback ke ukuran awal",
  klasifikasi: "Minor",
  tasks: [
    { phase: "Pengerjaan Inti", waktu: "10:00-10:30", pengerjaan: "Resize instance", pic: "Engineer 1" },
    { phase: "Pengerjaan Inti", waktu: "10:30-10:45", pengerjaan: "Verifikasi", pic: "Engineer 1" },
  ],
  rollback: [{ phase: "Pengerjaan Inti", waktu: "-", pengerjaan: "Resize kembali", pic: "Engineer 1" }],
  sec_requirements: [{ status: "Dapat Dipenuhi", reason: "" }],
  komponen: ["PolarDB"],
};
check("ruleFindings: complete record is clean", ruleFindings(complete).length === 0,
  JSON.stringify(ruleFindings(complete)));

// Komponen never mentioned in the description → scope-drift warning.
const drifty = { ...complete, description: "Peningkatan kapasitas memori instance." };
{
  const out = ruleFindings(drifty);
  check("ruleFindings: scope drift is a Konsistensi warn",
    out.length === 1 && out[0].severity === "warn" && out[0].area === "Konsistensi" && /PolarDB/.test(out[0].issue),
    JSON.stringify(out));
}

// jadwal_hari/jadwal_estimasi out of sync with execDate/tasks → deterministic
// warn with a ready-to-apply patch (no LLM day-of-week/duration math needed).
{
  const out = ruleFindings({ ...complete, execDate: "2026-07-09", jadwal_hari: "Senin" }); // 2026-07-09 is a Kamis
  const hari = out.find((x) => /Hari/.test(x.issue));
  check("ruleFindings: hari mismatch vs execDate flagged with patch",
    hari?.section === "jadwal" && hari.patch?.field === "jadwal_hari" && hari.patch?.value === "Kamis",
    JSON.stringify(out));
}
check("ruleFindings: hari/estimasi consistent with execDate/tasks is clean",
  ruleFindings({ ...complete, execDate: "2026-07-06", jadwal_hari: "Senin" }).length === 0); // 2026-07-06 is a Senin

/* ── duplicate resource-name warning (real case: two AZ subnets given the
   exact same name inside one tasklist step) ── */

{
  // Reproduces the actual RFC that reached Governance with this error:
  // "Zone A: 10.10.0.0/24 (app-server-prod01) / Zone B:
  // 10.10.1.0/24 (app-server-prod01)" — same name, two zones.
  const record = { ...complete, tasks: [{
    phase: "Pengerjaan Inti", waktu: "10:40-10:55", pic: "Engineer 1",
    pengerjaan: "Membuat subnet baru.\nZone A: 10.10.0.0/24 (app-server-prod01)\n"
      + "Zone B: 10.10.1.0/24 (app-server-prod01)",
  }] };
  const out = ruleFindingsFor(record, "pengerjaan");
  check("duplicateNameWarnings: same name across two zones flagged",
    out.some((x) => x.severity === "warn" && x.area === "Konsistensi" && /app-server-prod01/.test(x.issue)),
    JSON.stringify(out));
}
{
  // Unique per-zone names (the fixed version) → clean.
  const record = { ...complete, tasks: [{
    phase: "Pengerjaan Inti", waktu: "10:40-10:55", pic: "Engineer 1",
    pengerjaan: "Zone A: 10.10.0.0/24 (app-server-prod01)\n"
      + "Zone B: 10.10.1.0/24 (app-server-prod02)",
  }] };
  check("duplicateNameWarnings: unique per-zone names are clean",
    ruleFindingsFor(record, "pengerjaan").length === 0,
    JSON.stringify(ruleFindingsFor(record, "pengerjaan")));
}
{
  // The same resource name legitimately appearing in two UNRELATED steps
  // (e.g. referencing an existing shared Jumpserver twice) is not a
  // duplicate-enumeration bug — the check is scoped within one step's text.
  const record = { ...complete, tasks: [
    { phase: "Pengerjaan Inti", waktu: "10:00-10:10", pic: "Engineer 1", pengerjaan: "Login via (jumpserver-prod01)." },
    { phase: "Pengerjaan Inti", waktu: "10:10-10:20", pic: "Engineer 1", pengerjaan: "Konfigurasi lewat (jumpserver-prod01)." },
  ] };
  check("duplicateNameWarnings: same name across unrelated steps is not flagged",
    ruleFindingsFor(record, "pengerjaan").length === 0,
    JSON.stringify(ruleFindingsFor(record, "pengerjaan")));
}

/* ── alignMitigasi ── */

check("alignMitigasi: array index-aligned to risk count",
  alignMitigasi(["a", "b", "c"], 2) === "a\nb");
check("alignMitigasi: string fallback split by line",
  alignMitigasi("a\nb\nc", 2) === "a\nb");
check("alignMitigasi: short array not padded with blanks",
  alignMitigasi(["a"], 3) === "a");

/* ── sortByPhase ── */

{
  // Model put Approval before the work it's approving — must be reordered.
  const out = sortByPhase([
    { phase: "Approval", pengerjaan: "Approve" },
    { phase: "Pengerjaan Inti", pengerjaan: "Resize" },
    { phase: "Pengecekan Awal/Persiapan", pengerjaan: "Cek" },
  ]);
  check("sortByPhase: Approval moves after Pengerjaan Inti",
    out.map((t) => t.phase).join(",") === "Pengecekan Awal/Persiapan,Pengerjaan Inti,Approval",
    JSON.stringify(out.map((t) => t.phase)));
}
check("sortByPhase: unknown/blank phase sorts last, order preserved",
  sortByPhase([{ phase: "" }, { phase: "Review/Evaluasi" }, { phase: "Huh" }])
    .map((t) => t.phase).join(",") === "Review/Evaluasi,,Huh");

/* ── sanitiseSection ── */

{
  const out = sanitiseSection({ ready: true, summary: "ok", findings: null }, complete, "deskripsi");
  check("sanitiseSection: findings:null tolerated", out.length === 0);
}
{
  const out = sanitiseSection({ findings: [{ severity: "critical", area: "Lainnya", issue: "x", fix: "" }] }, complete, "deskripsi");
  check("sanitiseSection: bad severity/area coerced",
    out[0].severity === "warn" && out[0].area === "Governance");
}
{
  const noop = { severity: "info", area: "Bahasa", issue: "typo", fix: "",
                 patch: { field: "description", value: complete.description } };
  const out = sanitiseSection({ findings: [noop] }, complete, "deskripsi");
  check("sanitiseSection: no-op patch stripped", out[0].patch === null);
}
{
  // 4-row original replaced by a single row — the classic "model returned
  // only the changed element" failure the guard exists for.
  const shrink = { severity: "warn", area: "Governance", issue: "task kurang jelas", fix: "",
                   patch: { field: "tasks", value: [complete.tasks[0]] } };
  const rec = { ...complete, tasks: [0, 1, 2, 3].map((i) => ({ ...complete.tasks[0], pengerjaan: `step ${i}` })) };
  const out = sanitiseSection({ findings: [shrink] }, rec, "pengerjaan");
  check("sanitiseSection: row-dropping array patch stripped", out[0].patch === null);
}
{
  const good = { severity: "info", area: "Bahasa", issue: '"memori" → "memory"', fix: "perbaiki",
                 patch: { field: "description", value: "Peningkatan kapasitas memory instance PolarDB." } };
  const out = sanitiseSection({ findings: [good] }, complete, "deskripsi");
  check("sanitiseSection: legitimate patch kept", out[0].patch?.field === "description");
}
{
  const bad = { severity: "info", area: "Bahasa", issue: "x", fix: "",
                patch: { field: "executor", value: "Someone Else" } };
  const out = sanitiseSection({ findings: [bad] }, complete, "deskripsi");
  check("sanitiseSection: non-patchable field stripped", out[0].patch === null);
}
{
  // "risiko" carries 2 rule findings for `gutted` (risk register, klasifikasi).
  const out = sanitiseSection({ findings: [{ severity: "warn", area: "Bahasa", issue: "llm", fix: "" }] }, gutted, "risiko");
  check("sanitiseSection: rule findings merged first",
    out.length === 3 && out[0].severity === "block" && out.at(-1).issue === "llm",
    JSON.stringify(out.map((x) => `${x.severity}:${x.issue.slice(0, 20)}`)));
}
{
  // The model repeated a rule-checked gap (with a patch): its version wins,
  // the rule duplicate is dropped, the section's other rule finding stays.
  const dup = {
    severity: "block", area: "Governance",
    issue: "Rollback plan kosong - harus ada rencana rollback", fix: "Isi langkah rollback.",
    patch: { field: "rollback", value: [{ phase: "Pengerjaan Inti", waktu: "-", pengerjaan: "Undo restart", pic: "Engineer 1" }] },
  };
  const out = sanitiseSection({ findings: [dup] }, gutted, "pengerjaan");
  const rollback = out.filter((x) => /rollback/i.test(x.issue));
  check("sanitiseSection: LLM duplicate replaces the rule finding",
    out.length === 2 && rollback.length === 1 && rollback[0].patch?.field === "rollback",
    JSON.stringify(out.map((x) => x.issue.slice(0, 30))));
}
{
  // Same dedup, for the jadwal drift rule checks: a live DeepSeek call
  // reported "Hari dalam jadwal_hari (Senin) tidak sesuai dengan execDate
  // (... Kamis)" as a block finding despite the rubric telling it not to —
  // that must replace the rule's own "warn" duplicate, not stack alongside it.
  const record = { ...complete, execDate: "2026-07-09", jadwal_hari: "Senin" }; // 2026-07-09 is a Kamis
  const dup = {
    severity: "block", area: "Konsistensi",
    issue: "Hari dalam jadwal_hari (Senin) tidak sesuai dengan execDate (2026-07-09 yang jatuh pada hari Kamis).",
    fix: "Ubah jadwal_hari menjadi 'Kamis'.",
    patch: { field: "jadwal_hari", value: "Kamis" },
  };
  const out = sanitiseSection({ findings: [dup] }, record, "jadwal");
  const hari = out.filter((x) => /hari/i.test(x.issue));
  check("sanitiseSection: LLM jadwal-drift duplicate replaces the rule finding",
    hari.length === 1 && hari[0].severity === "block",
    JSON.stringify(out.map((x) => `${x.severity}:${x.issue.slice(0, 40)}`)));
}

/* ── sanitiseImportedFindings (imported Governance feedback) ── */

{
  // Unlike sanitiseSection, the model tags each finding's own section — a
  // single feedback upload can span the whole form.
  const out = sanitiseImportedFindings({ findings: [
    { severity: "block", area: "Security", section: "security", issue: "7 poin ditandai Tidak Relevan tanpa alasan cukup jelas.", fix: "Jelaskan tiap poin berdasarkan jenis aktivitas.", patch: null },
    { severity: "warn", area: "Governance", section: "jadwal", issue: "Window time perlu dipastikan low-traffic.", fix: "Tambahkan catatan monitoring SRE pada jadwal.", patch: null },
  ] }, complete);
  check("sanitiseImportedFindings: each finding keeps its own tagged section",
    out.length === 2 && out.some((x) => x.section === "security") && out.some((x) => x.section === "jadwal"),
    JSON.stringify(out.map((x) => x.section)));
}
{
  // Unknown/missing "section" from the model falls back to "deskripsi"
  // rather than being dropped or crashing the sanitiser.
  const out = sanitiseImportedFindings({ findings: [
    { severity: "info", area: "Bahasa", section: "not-a-real-section", issue: "x", fix: "", patch: null },
  ] }, complete);
  check("sanitiseImportedFindings: unrecognised section falls back to deskripsi",
    out[0]?.section === "deskripsi", JSON.stringify(out));
}
{
  // A patch is scoped to the finding's OWN claimed section's patchable
  // fields — a "jadwal" finding may not patch "tasks".
  const out = sanitiseImportedFindings({ findings: [
    { severity: "warn", area: "Governance", section: "jadwal", issue: "x", fix: "",
      patch: { field: "tasks", value: [{ phase: "Pengerjaan Inti", waktu: "10:00-10:10", pengerjaan: "Lain", pic: "Engineer 1" }] } },
  ] }, complete);
  check("sanitiseImportedFindings: patch outside the finding's own section is stripped",
    out[0]?.patch === null, JSON.stringify(out));
}
{
  // A row Governance's own Remark marks as already resolved should produce
  // no finding at all — the model is instructed not to re-flag it, and an
  // empty findings array must round-trip cleanly (not error/coerce to junk).
  const out = sanitiseImportedFindings({ findings: [] }, complete);
  check("sanitiseImportedFindings: empty findings (all feedback already resolved) is clean", out.length === 0);
}

/* ── Per-section review ── */

{
  const shared = REVIEW_SECTIONS.map((s) => s.id).sort();
  const backend = Object.keys(SECTIONS).sort();
  check("sections: shared ids match backend table", JSON.stringify(shared) === JSON.stringify(backend),
    `${shared} vs ${backend}`);
}
{
  const union = new Set(Object.values(SECTIONS).flatMap((s) => s.patchable));
  const missing = PATCHABLE.filter((f) => !union.has(f));
  const extra = [...union].filter((f) => !PATCHABLE.includes(f));
  check("sections: patchable lists cover every PATCHABLE field", !missing.length && !extra.length,
    `missing=${missing} extra=${extra}`);
}
check("sections: every rule check maps to a valid section",
  Object.values(RULE_SECTION).every((id) => SECTIONS[id]));

{
  const p = buildSectionPrompt(complete, "deskripsi", []);
  check("buildSectionPrompt: deskripsi excludes tasks", !p.user.includes('"tasks"'), p.user.slice(0, 200));
  check("buildSectionPrompt: deskripsi reviews description", p.user.includes('"description"'));
}
{
  const p = buildSectionPrompt(complete, "pengerjaan", []);
  check("buildSectionPrompt: pengerjaan includes tasks & rollback",
    p.user.includes('"tasks"') && p.user.includes('"rollback"'));
  check("buildSectionPrompt: rubric in system prompt", p.system.includes("Task ↔ rollback simetris"));
}
check("buildSectionPrompt: security carries the requirement legend",
  buildSectionPrompt(complete, "security", []).user.includes("1. Tidak menggunakan IP Publik"));

{
  const per = Object.fromEntries(REVIEW_SECTIONS.map((s) => [s.id, ruleFindingsFor(gutted, s.id).length]));
  check("ruleFindingsFor: gutted findings land in their sections",
    per.deskripsi === 1 && per.jadwal === 1 && per.risiko === 2 && per.pengerjaan === 2 &&
    per.security === 1 && per.dampak === 0 && per.bahasa === 0,
    JSON.stringify(per));
}
{
  // A patch may only touch the section's own fields: the same description
  // patch is kept in `deskripsi` but stripped in `pengerjaan`.
  const out = { findings: [{ severity: "warn", area: "Governance", issue: "x", fix: "",
    patch: { field: "description", value: "Deskripsi yang diperbaiki." } }] };
  const inOwn = sanitiseSection(out, complete, "deskripsi");
  const inOther = sanitiseSection(out, complete, "pengerjaan");
  check("sanitiseSection: patch restricted to the section's fields",
    inOwn[0].patch?.field === "description" && inOther[0].patch === null);
  check("sanitiseSection: findings tagged with their section",
    inOwn[0].section === "deskripsi");
}
{
  // mitigasi is index-aligned to risks (alignMitigasi) — a patch whose line
  // count doesn't match risks.length would silently desync that alignment.
  const mismatched = { findings: [{ severity: "warn", area: "Governance", issue: "x", fix: "",
    patch: { field: "mitigasi", value: "Baris 1\nBaris 2" } }] }; // complete.risks has 1 entry
  const out = sanitiseSection(mismatched, complete, "risiko");
  check("sanitiseSection: mitigasi patch with wrong line count stripped", out[0].patch === null);

  const matched = { findings: [{ severity: "warn", area: "Governance", issue: "x", fix: "",
    patch: { field: "mitigasi", value: "Mitigasi baru" } }] };
  check("sanitiseSection: mitigasi patch matching risks count kept",
    sanitiseSection(matched, complete, "risiko")[0].patch?.field === "mitigasi");

  // Paired rewrite: risks grows to 2 entries in the same response, so the
  // mitigasi patch must be checked against ITS length, not complete.risks.length.
  const paired = { findings: [
    { severity: "warn", area: "Governance", issue: "risks", fix: "",
      patch: { field: "risks", value: [
        { risiko: "resize gagal", likelihood: "Low", impact: "Low" },
        { risiko: "downtime", likelihood: "Low", impact: "Medium" },
      ] } },
    { severity: "warn", area: "Governance", issue: "mitigasi", fix: "",
      patch: { field: "mitigasi", value: "Rollback ke ukuran awal\nJadwalkan di luar jam sibuk" } },
  ] };
  const pairedOut = sanitiseSection(paired, complete, "risiko");
  check("sanitiseSection: paired risks+mitigasi patch checks against the new risks length",
    pairedOut.every((x) => x.patch !== null), JSON.stringify(pairedOut));
}
{
  // "bahasa" reviews the same prose fields (title/description/...) as their
  // content sections; both are prompted against the same form snapshot, so a
  // same-field patch from each isn't composed. Keep the first, strip the rest.
  const findings = [
    { severity: "warn", area: "Governance", section: "deskripsi", issue: "isi", fix: "",
      patch: { field: "description", value: "Deskripsi lengkap yang diperbaiki." } },
    { severity: "info", area: "Bahasa", section: "bahasa", issue: "typo", fix: "",
      patch: { field: "description", value: "Deskripsi asli dengan typo diperbaiki." } },
    { severity: "info", area: "Bahasa", section: "bahasa", issue: "typo lain", fix: "",
      patch: { field: "title", value: "Judul diperbaiki" } },
  ];
  const out = dedupeCrossSectionPatches(findings);
  check("dedupeCrossSectionPatches: first patch per field kept",
    out[0].patch?.field === "description" && out[1].patch === null && out[2].patch?.field === "title",
    JSON.stringify(out.map((x) => x.patch)));
  check("dedupeCrossSectionPatches: deduped finding keeps its issue/fix text (advisory-only)",
    out[1].issue === "typo");
}
{
  const zero = summarizeReview([]);
  const mixed = summarizeReview([{ severity: "block" }, { severity: "warn" }, { severity: "warn" }]);
  check("summarizeReview: empty → ready", zero.ready === true && /Tidak ada temuan/.test(zero.summary));
  check("summarizeReview: block → not ready with counts",
    mixed.ready === false && /1 wajib diperbaiki, 2 berisiko revisi/.test(mixed.summary), mixed.summary);
}

/* ── documentBlockers (server-side gate on /api/document, /api/document/gdoc) ── */

check("documentBlockers: complete record has no blockers",
  documentBlockers(complete).length === 0, JSON.stringify(documentBlockers(complete)));
{
  // The actual real-world gap: 6 of 7 "Tidak Relevan" security rows had no
  // reason, yet a .docx reached Governance — govCheck #8 already covers
  // this, it just wasn't being re-checked at the render endpoint.
  const out = documentBlockers(gutted);
  check("documentBlockers: gutted record is blocked",
    out.length > 0 && out.some((b) => /Security requirement/i.test(b)), JSON.stringify(out));
}
check("documentBlockers: missing body treated as empty record, not a throw",
  documentBlockers(undefined).length > 0);

if (failed) { console.log(`\n${failed} check(s) failed.`); process.exit(1); }
console.log("\n✓ Review pipeline checks all pass.");
