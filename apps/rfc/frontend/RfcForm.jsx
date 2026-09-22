// The RFC form: fill (or AI-draft) the official "Form Permintaan Perubahan",
// pre-review it against the Governance & Security rubric, then generate the
// document (.docx download / Google Doc). No server-side record is kept —
// the form state lives in App and autosaves to localStorage.
import React, { useRef, useState, useEffect } from "react";
import {
  FileText, Server, CalendarClock, User, AlertCircle,
  ShieldAlert, RotateCcw, ListChecks, FileDown, CheckCircle2, Sparkles,
  ExternalLink, Upload, Download, ChevronDown, ChevronLeft, ChevronRight,
  Circle, RefreshCw, Briefcase,
} from "lucide-react";
import { apiUrl, useToast } from "./core.js";
import { SEC_REQUIREMENTS, formatDateID, dayNameID, estimasiFromTasks, REVIEW_SECTIONS, summarizeReview, dedupeCrossSectionPatches } from "../rfc-schema.js";
import {
  INK, MUTED, FAINT, ACCENT, SURFACE, CARD, HOVER, GOOGLE,
  ACCENT_DISABLED, ON_ACCENT, ON_ACCENT_DISABLED,
  DANGER, DANGER_BG, DANGER_FG,
  NEUTRAL_BG, NEUTRAL_FG, WARN_BG, WARN_FG, SUCCESS_BG,
  SUCCESS_FG, SUCCESS_PANEL, TAG_BG, TAG_FG,
  FS_XS, FS_SM, FS_MD, FS_BASE, FS_XL, FW_MEDIUM, FW_SEMIBOLD,
  BORDER, URGENSI_STYLE, TEAM_FG, R_PILL, FONT_DISPLAY,
  mono, inputCls, inputStyle,
} from "./core.js";
import {
  teamOf, BLANK, secCell, secMissingReasons, riskTransform, applyFieldPatch,
} from "./form-data.js";
import {
  RowTable, TagInput, GovernancePanel, PreviewRow,
  ReviewPanel, ChatPanel, withFindingIds,
} from "./core.js";
import { FormEngine, errKeysFrom } from "../../../packages/core/frontend/FormEngine.jsx";
import { RFC_FORM_SCHEMA, RFC_DATALISTS, rfcWidgets } from "./rfc-form-schema.js";
import { downloadFormJson, readFormJson } from "./core.js";

// The 9 RFC_FORM_SCHEMA sections grouped into the 4 wizard steps from
// redesign_strategy_prd.txt. Free navigation (nothing gated) — this is a
// grouping of the existing schema/review sections, not a parallel structure.
const STEPS = [
  { label: "Detail Inti", icon: FileText,
    sections: ["identitas", "info", "urgensi"], reviewSections: ["deskripsi", "jadwal"] },
  { label: "Risiko & Dampak", icon: ShieldAlert,
    sections: ["sistem", "risiko", "security"],
    // "security" review findings are split across two steps by field (see
    // findingVisibleOnStep below) — sec_requirements lives here, but
    // alasan_pengecualian/compensating_control live on "Rencana Eksekusi".
    // Both steps list "security" so ReviewPanel renders the group on either.
    reviewSections: ["dampak", "risiko", "security"] },
  { label: "Rencana Eksekusi", icon: ListChecks,
    sections: ["pengerjaan", "rollback", "pengecualian"], reviewSections: ["pengerjaan", "security"] },
  { label: "Tinjau & Pengesahan", icon: User,
    sections: ["pengesahan"], reviewSections: ["bahasa"] },
];

// field key -> schema section id, for bucketing errKeys/missing fields per
// step (the wizard-tab error dot, and requireComplete()'s scroll target).
const FIELD_TO_SECTION = {};
for (const section of RFC_FORM_SCHEMA) {
  for (const field of section.fields) {
    const keys = field.kind === "group" ? field.fields.map((g) => g.key) : [field.key];
    for (const k of keys) if (k) FIELD_TO_SECTION[k] = section.id;
  }
}
const stepOf = (sectionId) => STEPS.findIndex((s) => s.sections.includes(sectionId));

// Fallback step for a finding with no identifiable target field (most
// findings are advisory-only, not tied to one patchable field) — the review
// section's single original "home" step, kept fixed regardless of which
// steps list that section in their reviewSections, so a fieldless finding
// shows exactly once instead of on every step that mentions its section.
const SECTION_HOME_STEP = { deskripsi: 0, jadwal: 0, dampak: 1, risiko: 1, security: 1, pengerjaan: 2, bahasa: 3 };

// Route one finding to the step that owns its actual target field (reusing
// FIELD_TO_SECTION/stepOf, the same maps the error-dot routing above uses),
// falling back to the section's home step when the finding isn't tied to a
// specific field. Fixes "security" findings about alasan_pengecualian/
// compensating_control (step "Rencana Eksekusi") being invisible because the
// whole "security" section used to be pinned to "Risiko & Dampak" only.
function findingVisibleOnStep(x, step) {
  const fieldSection = x.patch?.field != null ? FIELD_TO_SECTION[x.patch.field] : null;
  const targetStep = fieldSection != null ? stepOf(fieldSection) : SECTION_HOME_STEP[x.section] ?? -1;
  return targetStep === step;
}

function stepHasError(s, errKeys) {
  for (const k of errKeys) if (s.sections.includes(FIELD_TO_SECTION[k])) return true;
  return false;
}

// Widget deps FieldRenderer needs — static, so this lives outside the
// component instead of being rebuilt as a fresh object on every render.
const formTools = { TagInput, RowTable, datalists: RFC_DATALISTS, widgets: rfcWidgets };

// Sticky title + derived review-status chip + step tabs. Replaces the old
// FormNav (9 anchor pills) now that the form is split into 4 steps — no
// invented id/status field, the chip is computed straight from `review`
// (the same state the sticky action bar's "Tinjau" button already produces).
function WizardHeader({ f, step, setStep, review, errKeys, touched }) {
  const status = !review
    ? { bg: NEUTRAL_BG, fg: NEUTRAL_FG, icon: Circle, label: "Belum ditinjau" }
    : review.inProgress
    ? { bg: NEUTRAL_BG, fg: NEUTRAL_FG, icon: RefreshCw, spin: true, label: "Meninjau…" }
    : review.ready
    ? { bg: SUCCESS_BG, fg: SUCCESS_FG, icon: CheckCircle2, label: "Siap diajukan" }
    : { bg: WARN_BG, fg: WARN_FG, icon: ShieldAlert,
        label: `Perlu perbaikan (${review.findings.filter((x) => x.severity === "block").length})` };
  const StatusIcon = status.icon;

  return (
    <div className="sticky-bar top-0 flex flex-col gap-1.5 py-2" style={{ borderBottom: BORDER }}>
      {/* Status as a small eyebrow above the title, not sharing a row with
          it — a real RFC title can run long (full change descriptions, not
          just short names), and squeezing an actionable status chip into
          whatever space is left after it buries the one thing that tells
          the user what to do next. The title gets its own full-width line
          and wraps freely instead of fighting the chip for space. */}
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 self-start"
        style={{ background: status.bg, color: status.fg, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
        <StatusIcon size={12} className={status.spin ? "animate-spin" : ""} /> {status.label}
      </span>
      <span style={{ fontSize: FS_XL, fontWeight: FW_SEMIBOLD, color: INK, fontFamily: FONT_DISPLAY, lineHeight: 1.3 }}>
        {f.title || "RFC baru"}
      </span>
      <div className="flex items-center gap-1.5 mt-0.5">
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
          className="icon-btn-sm flex-shrink-0" aria-label="Langkah sebelumnya"
          style={{ opacity: step === 0 ? 0.4 : 1 }}>
          <ChevronLeft size={15} />
        </button>
        {/* Only the pill list scrolls — prev/next stay pinned so they're
            reachable even when narrow screens can't fit all 4 pills. */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const active = i === step;
            return (
              <button key={s.label} onClick={() => setStep(i)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 whitespace-nowrap flex-shrink-0"
                style={{
                  border: active ? `1px solid ${ACCENT}` : BORDER,
                  background: active ? TAG_BG : CARD,
                  color: active ? ACCENT : INK, fontSize: FS_SM, fontWeight: active ? FW_SEMIBOLD : FW_MEDIUM,
                }}>
                <Icon size={13} /> {i + 1}. {s.label}
                {touched && stepHasError(s, errKeys) && (
                  <span style={{ width: 6, height: 6, borderRadius: R_PILL, background: DANGER, flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
        <button onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} disabled={step === STEPS.length - 1}
          className="icon-btn-sm flex-shrink-0" aria-label="Langkah berikutnya"
          style={{ opacity: step === STEPS.length - 1 ? 0.4 : 1 }}>
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

// Poll the backend until the Google OAuth popup has stored a connection.
async function waitForGoogle(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const s = await (await fetch(apiUrl("/api/google/status"))).json();
      if (s.connected) return true;
    } catch (_) { /* keep polling */ }
  }
  return false;
}

export default function RfcForm({ f, setF, onGenerated }) {
  const toast = useToast();
  const [step, setStep]             = useState(0);
  const [touched, setTouched]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drafting, setDrafting]     = useState(false);
  const [intent, setIntent]         = useState("");
  // Collapsible for manual-fill users; persisted like rfc.lastExecutor below
  // so the choice sticks across sessions instead of resetting every reload.
  const [aiOpen, setAiOpen] = useState(() => localStorage.getItem("rfc.aiOpen") !== "0");
  const toggleAiOpen = () => setAiOpen((p) => {
    try { localStorage.setItem("rfc.aiOpen", p ? "0" : "1"); } catch { /* private mode */ }
    return !p;
  });
  const [reviewing, setReviewing]   = useState(false);
  const [review, setReview]         = useState(null);
  const [applied, setApplied]       = useState(new Set());
  // Sidebar preview/checklist auto-minimize once Tinjau findings show up —
  // three full panels stacked in a 340px column is too much at once, and the
  // findings are what matters most right after a review runs. Still user-
  // toggleable afterward (e.g. to peek the live preview again mid-review).
  // Reopen on the reverse transition too: a review that fails outright resets
  // `review` back to null (runReview's fatal/resolvedCount===0 path), and
  // without this the sidebar was left as two empty collapsed headers with no
  // ReviewPanel to show in their place.
  const [previewOpen, setPreviewOpen] = useState(true);
  const [checklistOpen, setChecklistOpen] = useState(true);
  useEffect(() => {
    setPreviewOpen(!review);
    setChecklistOpen(!review);
  }, [Boolean(review)]);
  // Post-submission Governance & Security feedback import (paste or upload a
  // .csv/.txt) — a distinct source of findings from Tinjau's own audit, shown
  // in the same review panel.
  const [feedbackOpen, setFeedbackOpen]           = useState(false);
  const [feedbackText, setFeedbackText]           = useState("");
  const [importingFeedback, setImportingFeedback] = useState(false);
  const feedbackFileRef = useRef(null);
  const [gdocing, setGdocing]       = useState(false);
  const [gdocError, setGdocError]   = useState(null);
  // Google Docs created in this session (shown for quick access; the riwayat
  // entry keeps the newest link across sessions).
  const [gdocs, setGdocs]           = useState([]);
  const importRef = useRef(null);


  // The AI draft is grounded on system + change type (they drive example
  // matching) and needs a one-line intent — require all three before drafting.
  // Pelaksana is required too: /api/draft only fills task/rollback PIC when
  // executor is already set, so drafting without it guarantees a blank-PIC
  // Governance blocker on review. Each prereq carries the DOM id of its real
  // input in "Identitas Perubahan" above (the AI panel renders right after
  // that section — see the step-1 layout below) so the hint can scroll there.
  const draftPrereqs = [
    !f.system?.length && { id: "field-system", label: "sistem terdampak" },
    !f.changeType     && { id: "field-changetype", label: "jenis perubahan" },
    !f.execDate       && { id: "field-execdate", label: "tanggal pelaksanaan" },
    !f.executor       && { id: "field-executor", label: "pelaksana" },
    !intent.trim()    && { id: null, label: "kalimat perubahan" },
  ].filter(Boolean);
  const canDraft = draftPrereqs.length === 0;
  const scrollToField = (id) =>
    id && document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

  const draftWithAI = async () => {
    setDrafting(true);
    try {
      const res = await fetch(apiUrl("/api/draft"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent,
          system:     f.system,
          changeType: f.changeType,
          executor:   f.executor,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const { draft, examplesUsed = 0 } = await res.json();
      // Fill-empty-only: never overwrite fields/rows the user already entered.
      // The AI draft fills blanks; everything you typed is preserved.
      setF((p) => {
        const effTasks = p.tasks.length ? p.tasks : (draft.tasks?.length ? draft.tasks : []);
        return {
          ...p,
          title:              p.title              || draft.title              || "",
          description:        p.description        || draft.description        || "",
          tujuan:             p.tujuan             || draft.tujuan             || "",
          sistem_terpengaruh: p.sistem_terpengaruh || draft.sistem_terpengaruh || "",
          mitigasi:           p.mitigasi           || draft.mitigasi           || "",
          // Single-selects have a default, so "still at the default" counts as
          // empty — apply the AI's assessment; a value the user changed is kept.
          klasifikasi: p.klasifikasi === BLANK.klasifikasi ? (draft.klasifikasi || p.klasifikasi) : p.klasifikasi,
          urgensi:     p.urgensi     === BLANK.urgensi     ? (draft.urgensi     || p.urgensi)     : p.urgensi,
          komponen:    p.komponen.length ? p.komponen : (draft.komponen || []),
          // Per-requirement fill-empty: keep any security cell the user filled.
          sec_requirements: (p.sec_requirements || []).map((cell, i) => {
            const c = secCell(cell);
            const d = (draft.sec_requirements || [])[i];
            return (c.status.trim() || c.reason.trim() || !d) ? cell : { status: d.status || "", reason: d.reason || "" };
          }),
          risks:    p.risks.length    ? p.risks    : (draft.risks?.length    ? draft.risks.map(riskTransform)    : []),
          tasks:    effTasks,
          rollback: p.rollback.length ? p.rollback : (draft.rollback?.length ? draft.rollback                    : []),
          // Hari comes straight from the execution date (ground truth); estimasi
          // is derived from whichever tasklist ends up in effect above.
          jadwal_hari:     p.jadwal_hari     || dayNameID(p.execDate)       || "",
          jadwal_estimasi: p.jadwal_estimasi || estimasiFromTasks(effTasks) || "",
        };
      });
      toast.success(
        examplesUsed > 0
          ? `Draf AI diterapkan — berdasarkan ${examplesUsed} form serupa. Tinjau sebelum membuat dokumen.`
          : "Draf AI diterapkan (tidak ada form serupa — draf generik). Tinjau sebelum membuat dokumen.",
      );
    } catch (err) {
      toast.error(
        "Gagal membuat draft AI. Pastikan backend berjalan dan LLM dikonfigurasi " +
          "(backend/.env). Error: " + err.message,
      );
    } finally {
      setDrafting(false);
    }
  };

  // Reasons are mandatory only for "Tidak Dapat Dipenuhi" / "Tidak Relevan" —
  // Governance returns forms where those rows lack a justification.
  // Keyed in form (top-to-bottom) order so a failed submit can scroll to the
  // first offender instead of just naming it in a toast.
  const noReason = secMissingReasons(f);
  const missingFields = [
    !f.system?.length && { id: "field-system", field: "system", label: "sistem" },
    !f.changeType && { id: "field-changetype", field: "changeType", label: "jenis perubahan" },
    !f.title      && { id: "field-title", field: "title", label: "judul" },
    !f.executor   && { id: "field-executor", field: "executor", label: "pelaksana" },
    noReason.length > 0 && { id: "sec-security", label: `alasan security requirement no. ${noReason.join(", ")}` },
  ].filter(Boolean);
  const missing = missingFields.map((m) => m.label);
  // Field keys to flag red in-place after a failed generate (FormEngine reads
  // this set via errKeys). Security-requirement rows are flagged by the widget
  // itself (it knows which rows are missing reasons), so no key here for those.
  const errKeys = errKeysFrom(missingFields);


  const requireComplete = () => {
    setTouched(true);
    if (missingFields.length) {
      toast.error("Lengkapi dulu: " + missing.join(", ") + ".");
      const target = missingFields[0];
      const scrollToTarget = () => document.getElementById(target.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      // The target field's section may live on a step that isn't currently
      // rendered (FormEngine only mounts the active step) — switch first, then
      // scroll once that step's DOM has committed, or the id lookup no-ops silently.
      const targetStep = stepOf(FIELD_TO_SECTION[target.field] ?? "security");
      if (targetStep !== -1 && targetStep !== step) {
        setStep(targetStep);
        requestAnimationFrame(scrollToTarget);
      } else {
        scrollToTarget();
      }
      return false;
    }
    try { localStorage.setItem("rfc.lastExecutor", f.executor); } catch { /* private mode */ }
    return true;
  };

  // One focused LLM review per form section. Sections are independent (none
  // feeds another's prompt), so they fire CONCURRENTLY up to the active
  // provider's concurrency limit (enforced server-side in llm.js). Findings
  // stream in as each section lands; the merged list is always rebuilt in
  // REVIEW_SECTIONS index order before dedupe so the "content sections before
  // bahasa" patch-wins rule holds regardless of which section finishes first.
  // While running, the review button doubles as cancel.
  const reviewAbort = useRef(null);
  // Section → { hash, findings, llm } from the last time that section was
  // actually reviewed. A section whose fields+context haven't changed since
  // then is skipped on the next "Tinjau" click and its prior findings reused
  // — the common case (fix one finding, re-review) doesn't need to re-run
  // sections whose content is untouched. Naturally invalidated whenever the
  // record's own content changes, since the hash is over the actual fields.
  const reviewCache = useRef({});
  const sectionSnapshot = (s) =>
    JSON.stringify([...s.fields, ...s.context].map((k) => f[k]));
  const runReview = async () => {
    if (reviewing) { reviewAbort.current?.abort(); return; }
    const ctrl = new AbortController();
    reviewAbort.current = ctrl;
    setReviewing(true);
    setApplied(new Set());
    const total = REVIEW_SECTIONS.length;
    // results[k] = { id, label, findings, llm } once section k resolves (cache
    // hit or fetch). Indexed by REVIEW_SECTIONS position so the panel merge is
    // section-ordered, not arrival-ordered.
    const results = new Array(total);
    let done = 0, degraded = 0, reused = 0, aborted = false, fatal = null;
    const running = new Set();   // in-flight section ids (for the "active" chip)

    // Rebuild findings+sections from whatever has resolved so far, always in
    // REVIEW_SECTIONS order, then dedupe patches in that order.
    const snapshot = () => {
      const ordered = [];
      const sections = [];
      for (let k = 0; k < total; k++) {
        const r = results[k];
        if (!r) continue;
        ordered.push(...r.findings);
        sections.push({ id: r.id, label: r.label, llm: r.llm });
      }
      return { findings: withFindingIds(dedupeCrossSectionPatches(ordered)), sections };
    };
    const refresh = () => {
      const { findings, sections } = snapshot();
      setReview((p) => ({
        ...p, running: [...running], done,
        findings, sections, ready: summarizeReview(findings).ready,
      }));
    };

    setReview({ inProgress: true, running: [], done: 0, total, findings: [], sections: [], ready: true, summary: "" });

    const inFlight = [];
    for (let k = 0; k < total; k++) {
      const s = REVIEW_SECTIONS[k];
      const hash = sectionSnapshot(s);
      const cached = reviewCache.current[s.id];
      if (cached?.hash === hash) {
        reused++;
        results[k] = { id: s.id, label: s.label, findings: cached.findings || [], llm: cached.llm };
        if (!cached.llm) degraded++;
        done++;
        continue;
      }
      running.add(s.id);
      inFlight.push((async () => {
        try {
          const res = await fetch(apiUrl(`/api/review/section?section=${s.id}`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(f),
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            const err = new Error(e.error || `HTTP ${res.status}`);
            err.status = res.status;
            throw err;
          }
          const data = await res.json();
          reviewCache.current[s.id] = { hash, findings: data.findings || [], llm: data.llm !== false };
          results[k] = { id: s.id, label: s.label, findings: data.findings || [], llm: data.llm !== false };
          if (data.llm === false) degraded++;
        } catch (err) {
          if (err?.name === "AbortError") { aborted = true; ctrl.abort(); }
          // 503 = LLM not configured / backend down: every section would fail
          // identically, so abort the rest and surface it once.
          else if (err?.status === 503 || /Failed to fetch/i.test(String(err?.message))) { fatal = err; ctrl.abort(); }
          else {
            degraded++;
            results[k] = { id: s.id, label: s.label, findings: [], llm: false };
          }
        } finally {
          running.delete(s.id);
          done++;
          refresh();
        }
      })());
    }
    refresh();   // show cache hits + the in-flight set immediately
    await Promise.allSettled(inFlight);

    const resolvedCount = results.filter(Boolean).length;
    if (fatal && resolvedCount === 0) {
      setReview(null);
      toast.error("Gagal menjalankan review. Pastikan backend berjalan dan LLM dikonfigurasi. Error: " + fatal.message);
    } else {
      const { findings, sections } = snapshot();
      const { ready, summary } = summarizeReview(findings);
      const note =
        aborted ? `Dibatalkan setelah ${sections.length}/${total} bagian. ` :
        fatal   ? `Terhenti setelah ${sections.length}/${total} bagian (${fatal.message}). ` :
        reused  ? `${reused} bagian tidak berubah sejak tinjauan terakhir (dipakai ulang). ` : "";
      setReview({ inProgress: false, running: [], ready, summary: note + summary, findings, sections, done: sections.length, total });
      const p = findings.filter((x) => x.patch).length;
      if (degraded) {
        toast.error(`Pemeriksaan AI tidak tersedia untuk ${degraded} dari ${sections.length} bagian — sebagian hasil dari cek otomatis saja.`);
      } else toast.info(
        findings.length === 0 ? "Tinjauan selesai — tidak ada temuan"
        : p > 0 ? `Tinjauan selesai: ${findings.length} temuan, ${p} bisa diperbaiki satu klik`
        : `Tinjauan selesai: ${findings.length} temuan`,
      );
    }
    setReviewing(false);
    reviewAbort.current = null;
  };

  // Apply one review patch: whole-field replacement, with the same
  // normalisation the form applies to hand-entered values. Keyed by the
  // finding's stable id (not its position in review.findings), since that
  // array is rebuilt in section order every time another section resolves —
  // a raw array index would drift to a different finding mid-review.
  const applyPatch = (id) => {
    const x = review?.findings?.find((f) => f.id === id);
    if (!x?.patch) return;
    applyFieldPatch(setF, x.patch.field, x.patch.value);
    setApplied((s) => new Set([...s, id]));
  };

  const applyAll = (ids) => {
    ids.forEach(applyPatch);
    toast.success(`${ids.length} perbaikan diterapkan`);
  };

  // Review is advisory (never blocks generation), but exporting with it
  // skipped or with unresolved blockers should be a deliberate choice, not
  // a silent gap — so ask once, right before the doc is actually produced.
  const confirmExportRisk = () => {
    if (!review) return window.confirm("Anda belum menjalankan Tinjau Governance & Security. Lanjutkan tanpa meninjau?");
    if (review.inProgress) return window.confirm("Tinjauan masih berjalan. Lanjutkan sebelum selesai?");
    if (!review.ready) {
      const n = review.findings.filter((x) => x.severity === "block").length;
      return window.confirm(`${n} temuan wajib diperbaiki belum diselesaikan. Lanjutkan export?`);
    }
    return true;
  };

  // Tags the generate request with the unresolved-block count so the backend
  // can skip feeding this record into the AI corpus (self-enrichment) when
  // the user exports anyway despite open blockers — the export itself is
  // still allowed (advisory-only), only the future-few-shot-example path is
  // gated. Not part of the RFC record; stripped by exampleOf before storage.
  const reviewBlockCount = () => review?.findings?.filter((x) => x.severity === "block").length || 0;

  const generateDocx = async () => {
    if (!requireComplete()) return;
    if (!confirmExportRisk()) return;
    setGenerating(true);
    try {
      const res = await fetch(apiUrl("/api/document"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, __reviewBlockCount: reviewBlockCount() }),
      });
      // 400 carries { error, blockers[] } — the server's completeness gate.
      // Surface the blocker list so the user knows WHAT to fill, not just
      // "HTTP 400". Without this the govCheck failures are silent.
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.blockers?.length) {
          toast.error(`${e.error || "RFC belum lengkap."} Lengkapi: ${e.blockers.join(", ")}.`);
          return;
        }
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${(f.title || "rfc").replace(/[\/\\:*?"<>|]+/g, " ").trim().slice(0, 120)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
      onGenerated({ form: f, kind: "docx" });
      toast.success("Dokumen Word diunduh — tersimpan di Riwayat");
    } catch (err) {
      toast.error(
        "Gagal mengunduh .docx. Pastikan backend berjalan (cd backend && npm run dev). Error: " +
          err.message,
      );
    } finally {
      setGenerating(false);
    }
  };

  const createGoogleDoc = async () => {
    if (!requireComplete()) return;
    if (!confirmExportRisk()) return;
    setGdocing(true);
    setGdocError(null);
    try {
      const post = () => fetch(apiUrl("/api/document/gdoc"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, __reviewBlockCount: reviewBlockCount() }),
      });
      let res = await post();
      if (res.status === 401) {
        // Not connected yet — open Google consent in a popup, wait, then retry.
        const popup = window.open(apiUrl("/api/google/auth"), "gauth", "width=500,height=660");
        const ok = await waitForGoogle();
        if (popup && !popup.closed) popup.close();
        if (!ok) { setGdocError("Login Google dibatalkan atau timeout."); return; }
        res = await post();
      }
      if (res.status === 503) { setGdocError((await res.json()).error); return; }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        // 400 carries { error, blockers[] } — the server's completeness gate.
        if (e.blockers?.length) {
          setGdocError(`${e.error || "RFC belum lengkap."} Lengkapi: ${e.blockers.join(", ")}.`);
          return;
        }
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const { id, link, name } = await res.json();
      setGdocs((p) => [{ id, link, name, createdAt: new Date().toISOString() }, ...p]);
      onGenerated({ form: f, kind: "gdoc", link });
      window.open(link, "_blank");
      toast.success("Google Doc dibuat — tersimpan di Riwayat");
    } catch (err) {
      setGdocError(
        "Gagal membuat Google Doc. Pastikan backend berjalan dan Google OAuth " +
          "dikonfigurasi (backend/.env — lihat .env.example). Error: " + err.message,
      );
    } finally {
      setGdocing(false);
    }
  };

  const importJson = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const obj = await readFormJson(file);
      setF({ ...BLANK, ...obj });
      setReview(null);
      setApplied(new Set());
      reviewCache.current = {};
      toast.success("Form dimuat dari JSON");
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Read an uploaded feedback file (.csv/.txt export of the Governance sheet)
  // straight into the textarea — the user can still see/edit it before
  // sending, rather than a blind upload with no visibility into what the
  // server received.
  const importFeedbackFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setFeedbackText(await file.text());
    } catch {
      toast.error("Gagal membaca file.");
    }
  };

  // Translate real Governance & Security feedback (received after
  // submission) into the same findings/patch shape as Tinjau, against the
  // CURRENT form content — reuses the review panel and one-click "Terapkan"
  // wholesale. Replaces whatever the panel currently shows (a fresh Tinjau
  // run does the same), since the two are alternative sources for the same
  // panel, not meant to be merged.
  const importFeedback = async () => {
    if (!feedbackText.trim()) { toast.error("Tempel atau unggah teks feedback terlebih dahulu."); return; }
    setImportingFeedback(true);
    try {
      const res = await fetch(apiUrl("/api/review/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record: f, feedback: feedbackText }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const { findings: raw = [] } = await res.json();
      const findings = withFindingIds(dedupeCrossSectionPatches(raw));
      const { ready, summary } = summarizeReview(findings);
      setReview({
        inProgress: false, ready, summary, findings,
        sections: REVIEW_SECTIONS.map((s) => ({ id: s.id, label: s.label, llm: true })),
        done: REVIEW_SECTIONS.length, total: REVIEW_SECTIONS.length,
      });
      setApplied(new Set());
      setFeedbackText("");
      setFeedbackOpen(false);
      toast.info(
        findings.length === 0
          ? "Tidak ada temuan actionable — feedback tampaknya sudah tertangani."
          : `${findings.length} temuan dari feedback Governance dimuat.`,
      );
    } catch (err) {
      toast.error("Gagal mengimpor feedback. " + err.message);
    } finally {
      setImportingFeedback(false);
    }
  };

  const scheduleLabel = [dayNameID(f.execDate) || f.jadwal_hari, formatDateID(f.execDate), f.jadwal_jam, f.jadwal_estimasi ? `(${f.jadwal_estimasi})` : ""]
    .filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-6">

      {/* ─── Sticky title + status + step tabs ─── */}
      <WizardHeader f={f} step={step} setStep={setStep} review={review} errKeys={errKeys} touched={touched} />

      {/* ─── Two-column body: sections (left) + sticky preview/governance (right) ───
           minmax(0,…) + min-w-0 let the columns shrink below their content's
           intrinsic width on narrow screens, so wide tables scroll inside
           .scroll-x instead of widening the whole page. The section bodies are
           rendered declaratively from RFC_FORM_SCHEMA by the shared FormEngine;
           the controller logic (AI draft, review, generation) lives in this
           component, above and below this grid. */}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="flex flex-col gap-6 min-w-0">

        {step === 0 ? (
          <>
            {/* "Identitas Perubahan" leads step 1 — every RFC needs these 4
                fields regardless of path, and they're exactly what "Draft
                dengan AI" needs before it can run, so the AI panel sits right
                after this section: fill identity once, then either use AI
                right here or keep filling the narrative fields below by hand. */}
            <FormEngine
              schema={RFC_FORM_SCHEMA.filter((s) => s.id === "identitas")}
              f={f} setF={setF} touched={touched} errKeys={errKeys} tools={formTools}
            />

            <div className="flex flex-col gap-2 rounded-lg p-4"
              style={{ background: HOVER, border: BORDER }}>
              <button onClick={toggleAiOpen}
                className="flex items-center gap-2 w-full text-left"
                style={{ color: ACCENT, fontSize: FS_MD, fontWeight: FW_SEMIBOLD, cursor: "pointer" }}
                aria-expanded={aiOpen}>
                <Sparkles size={15} /> Draft dengan AI
                <ChevronDown size={15} className="ml-auto"
                  style={{ transform: aiOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
              </button>
              {aiOpen && (
                <>
                  <p style={{ fontSize: FS_SM, color: MUTED, lineHeight: 1.5 }}>
                    Sudah isi identitas di atas? Jelaskan perubahan dalam satu kalimat, AI akan
                    menyusun deskripsi, tujuan, analisis risiko, tasklist, dan rollback di bawah —
                    meniru gaya RFC sebelumnya. Tinjau dan sesuaikan sebelum membuat dokumen.
                  </p>
                  <div className="flex gap-2">
                    <textarea
                      className={inputCls}
                      style={{ ...inputStyle, flex: 1, minHeight: 40, resize: "vertical", lineHeight: 1.5 }}
                      rows={1}
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                      placeholder="cth: perluas storage database dari 35TB ke 40TB karena utilisasi 88%"
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !drafting && canDraft) { e.preventDefault(); draftWithAI(); } }}
                    />
                    <button onClick={draftWithAI} disabled={drafting || !canDraft}
                      className="inline-flex items-center gap-2 rounded-md px-4 py-2 whitespace-nowrap"
                      style={{
                        background: drafting || !canDraft ? ACCENT_DISABLED : ACCENT,
                        color: drafting || !canDraft ? ON_ACCENT_DISABLED : ON_ACCENT,
                        fontSize: FS_MD, fontWeight: FW_MEDIUM,
                        cursor: drafting || !canDraft ? "not-allowed" : "pointer",
                      }}>
                      <Sparkles size={14} /> {drafting ? "Menyusun…" : "Buatkan draft"}
                    </button>
                  </div>
                  {!canDraft && (
                    <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: FS_XS, color: FAINT }}>
                      <AlertCircle size={12} style={{ flexShrink: 0 }} />
                      <span>Lengkapi dulu agar draft akurat:{" "}
                        {draftPrereqs.map((p, i) => (
                          <React.Fragment key={p.label}>
                            {i > 0 && ", "}
                            {p.id ? (
                              <button onClick={() => scrollToField(p.id)}
                                style={{ color: ACCENT, textDecoration: "underline", cursor: "pointer" }}>
                                {p.label}
                              </button>
                            ) : p.label}
                          </React.Fragment>
                        ))}.
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <FormEngine
              schema={RFC_FORM_SCHEMA.filter((s) => s.id === "info" || s.id === "urgensi")}
              f={f} setF={setF} touched={touched} errKeys={errKeys} tools={formTools}
            />
          </>
        ) : (
          <FormEngine
            schema={RFC_FORM_SCHEMA.filter((s) => STEPS[step].sections.includes(s.id))}
            f={f} setF={setF} touched={touched} errKeys={errKeys} tools={formTools}
          />
        )}
        </div>

        {/* RIGHT: sticky live preview + governance checklist */}
        <aside className="flex flex-col gap-4 min-w-0 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:overflow-y-auto">
          <div className="rounded-lg overflow-hidden" style={{ border: BORDER, background: CARD }}>
            <button onClick={() => setPreviewOpen((p) => !p)}
              className="w-full px-4 py-2.5 flex items-center gap-2 text-left"
              style={{ borderBottom: previewOpen ? BORDER : "none", background: SURFACE, cursor: "pointer" }}
              aria-expanded={previewOpen}>
              <FileText size={14} style={{ color: FAINT }} />
              <span style={{ fontSize: FS_SM, fontWeight: FW_MEDIUM, color: MUTED }}>Pratinjau langsung</span>
              <ChevronDown size={14} className="ml-auto" style={{
                color: FAINT, transform: previewOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s",
              }} />
            </button>
            {previewOpen && (
            <div className="p-5 flex flex-col gap-3">
              {/* No title line here — WizardHeader above already shows it at
                  2x the size; repeating it just pushed the sidebar's actual
                  content (chips, system, schedule) further down. */}
              <div className="flex flex-wrap gap-2 items-center">
                {f.urgensi && (
                  // Muted/outlined instead of the solid severity color while
                  // still at the untouched default — "Medium" here isn't a
                  // confirmed assessment yet, just what the field starts at,
                  // and a full-confidence pill would claim otherwise.
                  <span className="rounded-full px-2.5 py-0.5" style={{
                    ...(f.urgensi === BLANK.urgensi
                      ? { background: "transparent", border: BORDER, color: MUTED }
                      : URGENSI_STYLE[f.urgensi]),
                    fontSize: FS_SM, fontWeight: FW_MEDIUM,
                  }}>
                    {f.urgensi}
                  </span>
                )}
                {f.changeType && (
                  <span className="rounded-full px-2.5 py-0.5"
                    style={{ background: TAG_BG, color: TAG_FG, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
                    {f.changeType}
                  </span>
                )}
                {f.klasifikasi && (
                  <span className="rounded-full px-2.5 py-0.5" style={{
                    background: f.klasifikasi === "Major" ? DANGER_BG : NEUTRAL_BG,
                    color: f.klasifikasi === "Major" ? DANGER_FG : NEUTRAL_FG,
                    fontSize: FS_SM, fontWeight: FW_MEDIUM,
                  }}>
                    {f.klasifikasi}
                  </span>
                )}
              </div>
              <PreviewRow icon={Server} label="Sistem" value={f.system.join(", ")} monoStyle={mono} />
              {f.komponen?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {f.komponen.map((k, i) => (
                    <span key={i} className="rounded-full px-2 py-0.5"
                      style={{ background: SURFACE, border: BORDER, fontSize: FS_XS, color: MUTED }}>
                      {k}
                    </span>
                  ))}
                </div>
              )}
              {/* Clamped, not the full text — the description is already
                  right there in the editable field a few rows up; this is
                  just confirming "yes, it's filled in and reads like X",
                  not a second place to read the whole thing. */}
              <p style={{
                fontSize: FS_MD, color: f.description ? INK : FAINT, lineHeight: 1.65,
                display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {f.description || "Deskripsi perubahan formal muncul di sini saat Anda mengisi field."}
              </p>
              <div style={{ borderTop: BORDER }} className="pt-3 flex flex-col gap-2">
                <PreviewRow icon={User} label="Pelaksana" value={
                  f.executor ? (
                    <span>{f.executor}
                      {teamOf(f.executor) &&
                        <span style={{ color: TEAM_FG[teamOf(f.executor)], fontWeight: FW_SEMIBOLD }}> · {teamOf(f.executor)}</span>}
                    </span>
                  ) : ""} />
                <PreviewRow icon={Briefcase} label="Departemen" value={f.requester} />
                <PreviewRow icon={CalendarClock} label="Jadwal" value={scheduleLabel} monoStyle={mono} />
                {/* Separate from "Jadwal" on purpose — these two are the
                    Operational IT Policy's explicit-disclosure requirement
                    (VII.4.G.h), not just scheduling detail, so they get their
                    own visible row instead of being buried in a dot-joined
                    string where a reviewer could miss them. */}
                {(f.jadwal_downtime?.trim() || f.jadwal_pulih?.trim()) && (
                  <PreviewRow icon={AlertCircle} label="Downtime"
                    value={[f.jadwal_downtime, f.jadwal_pulih && `pulih ${f.jadwal_pulih}`].filter(Boolean).join(" · ")} />
                )}
                {f.risks?.length   > 0 && <PreviewRow icon={ShieldAlert} label="Risiko"   value={`${f.risks.length} item`} />}
                {f.tasks?.length   > 0 && <PreviewRow icon={ListChecks}  label="Tugas"    value={`${f.tasks.length} langkah`} />}
                {f.rollback?.length > 0 && <PreviewRow icon={RotateCcw}  label="Rollback" value={`${f.rollback.length} langkah`} />}
              </div>
            </div>
            )}
          </div>

          <GovernancePanel f={f} collapsed={!checklistOpen} onToggleCollapse={() => setChecklistOpen((p) => !p)} />

          {/* Governance & Security review findings — filtered to this step's
              own review sections, then per-finding to the step that owns its
              target field (findingVisibleOnStep) so a "security" finding
              about alasan_pengecualian shows on "Rencana Eksekusi" rather
              than only on "Risiko & Dampak". The readiness banner still
              reflects the full unfiltered review, so overall status is
              consistent across steps. Compact: collapsed issue text,
              fix/patch behind a click to expand — the 340px column has no
              room for the full cards. */}
          {review && (
            <ReviewPanel
              review={{ ...review, findings: review.findings.filter((x) => findingVisibleOnStep(x, step)) }}
              form={f} applied={applied}
              onApply={(i) => { applyPatch(i); }} onApplyAll={applyAll}
              sectionIds={STEPS[step].reviewSections} compact />
          )}
        </aside>
      </div>

      {/* Validation */}
      {touched && missing.length > 0 && (
        <div className="flex items-center gap-2 rounded-md px-3 py-2"
          style={{ background: DANGER_BG, color: DANGER_FG, fontSize: FS_MD }}>
          <AlertCircle size={15} /> Masih diperlukan: {missing.join(", ")}.
        </div>
      )}

      {/* Import real feedback received from IT Governance & Security after
          submission — an alternative source for the same review panel below
          (restore the submitted form from Riwayat first if it isn't already
          loaded). Lives on the "Tinjau & Pengesahan" step, where consolidated
          feedback conceptually belongs. */}
      {step === 3 && (
      <div className="flex flex-col gap-2">
        <button onClick={() => setFeedbackOpen((v) => !v)}
          title="Muat feedback dari IT Governance & Security untuk merevisi form ini"
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 self-start"
          style={{
            border: BORDER, fontSize: FS_BASE, background: CARD,
            color: MUTED, fontWeight: FW_MEDIUM, cursor: "pointer",
          }}>
          <Upload size={16} /> Impor Feedback
        </button>
        {feedbackOpen && (
          <div className="flex flex-col gap-2 rounded-lg p-4" style={{ background: HOVER, border: BORDER }}>
            <p style={{ fontSize: FS_SM, color: MUTED, lineHeight: 1.5 }}>
              Tempel teks feedback dari IT Governance & Security (mis. isi ekspor CSV dari Google Sheet),
              atau unggah filenya. Temuan yang masih relevan terhadap isi form saat ini akan muncul di
              panel Tinjau di bawah, lengkap dengan perbaikan satu klik bila memungkinkan — poin yang
              sudah direvisi atau sengaja ditolak tidak akan dimunculkan ulang.
            </p>
            <textarea
              className={inputCls}
              style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: mono, fontSize: FS_SM }}
              rows={6}
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="Tempel feedback di sini, atau unggah file .csv/.txt…"
            />
            <div className="flex items-center gap-2">
              <button onClick={() => feedbackFileRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2"
                style={{ border: BORDER, color: MUTED, fontSize: FS_MD, background: CARD }}>
                <Upload size={14} /> Unggah file (.csv/.txt)
              </button>
              <input ref={feedbackFileRef} type="file" accept=".csv,.txt,text/csv,text/plain"
                onChange={importFeedbackFile} style={{ display: "none" }} />
              <button onClick={importFeedback} disabled={importingFeedback || !feedbackText.trim()}
                className="inline-flex items-center gap-2 rounded-md px-4 py-2"
                style={{
                  background: importingFeedback || !feedbackText.trim() ? ACCENT_DISABLED : ACCENT,
                  color: importingFeedback || !feedbackText.trim() ? ON_ACCENT_DISABLED : ON_ACCENT,
                  fontSize: FS_MD, fontWeight: FW_MEDIUM,
                  cursor: importingFeedback || !feedbackText.trim() ? "not-allowed" : "pointer",
                }}>
                <ShieldAlert size={14} /> {importingFeedback ? "Memproses…" : "Proses Feedback"}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Actions — sticky so the buttons are always reachable on the long form */}
      <div className="sticky-bar bottom-0 flex flex-wrap items-center justify-between gap-2 py-3"
        style={{ borderTop: BORDER, marginTop: 4 }}>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={runReview}
            title="Tinjau Governance & Security"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2"
            style={{
              border: `1px solid ${ACCENT}`, fontSize: FS_BASE, background: CARD,
              color: ACCENT, fontWeight: FW_MEDIUM, cursor: "pointer",
            }}>
            <ShieldAlert size={16} /> {reviewing ? "Batalkan" : "Tinjau"}
          </button>
          <button onClick={generateDocx} disabled={generating}
            title="Unduh dokumen sebagai file .docx"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2"
            style={{
              background: generating ? ACCENT_DISABLED : ACCENT,
              color: generating ? ON_ACCENT_DISABLED : ON_ACCENT,
              fontSize: FS_BASE, fontWeight: FW_MEDIUM,
              cursor: generating ? "not-allowed" : "pointer",
            }}>
            <FileDown size={16} /> {generating ? "Membuat…" : "Unduh .docx"}
          </button>
          <button onClick={createGoogleDoc} disabled={gdocing}
            title="Buat dokumen baru di Google Docs"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2"
            style={{
              border: `1px solid ${GOOGLE}`, fontSize: FS_BASE, background: CARD,
              color: gdocing ? FAINT : GOOGLE, fontWeight: FW_MEDIUM,
              cursor: gdocing ? "not-allowed" : "pointer",
            }}>
            <FileText size={16} /> {gdocing ? "Membuat…" : "Google Doc"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => downloadFormJson(f)} title="Simpan isi form sebagai file JSON"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-2"
            style={{ border: BORDER, color: MUTED, fontSize: FS_MD, background: CARD }}>
            <Download size={14} /> JSON
          </button>
          <button onClick={() => importRef.current?.click()} title="Muat isi form dari file JSON"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-2"
            style={{ border: BORDER, color: MUTED, fontSize: FS_MD, background: CARD }}>
            <Upload size={14} /> Muat JSON
          </button>
          <input ref={importRef} type="file" accept="application/json,.json"
            onChange={importJson} style={{ display: "none" }} />
        </div>
      </div>

      {(gdocError || gdocs.length > 0) && (
        <div className="flex flex-col gap-2">
          {gdocError && (
            <div className="flex items-start gap-2 rounded-md px-3 py-2"
              style={{ background: DANGER_BG, color: DANGER_FG }}>
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: FS_MD, lineHeight: 1.5 }}>{gdocError}</span>
            </div>
          )}
          {gdocs.length > 0 && (
            <div className="rounded-md p-3 flex flex-col gap-2"
              style={{ background: SUCCESS_PANEL, border: BORDER }}>
              <div className="flex items-center gap-2"
                style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: SUCCESS_FG }}>
                <CheckCircle2 size={15} />
                Google Doc dibuat
              </div>
              <div className="flex flex-col gap-1.5">
                {gdocs.map((g) => (
                  <a key={g.id} href={g.link} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded px-2 py-1.5"
                    style={{ background: CARD, border: BORDER, fontSize: FS_SM, color: INK }}>
                    <ExternalLink size={14} style={{ color: GOOGLE, flexShrink: 0 }} />
                    <span className="flex-1 truncate">{g.name || "Google Doc"}</span>
                    <span style={{ color: FAINT, fontSize: FS_XS }}>
                      {g.createdAt ? new Date(g.createdAt).toLocaleString("id-ID", {
                        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                      }) : ""}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ChatPanel f={f} onApplyPatch={(field, value) => applyFieldPatch(setF, field, value)} />
    </div>
  );
}
