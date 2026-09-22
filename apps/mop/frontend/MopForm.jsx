// The MOP form: fill (or AI-draft) a Method of Procedure, pre-review it against
// the Governance & Security rubric, then generate the document (.docx download
// / Google Doc). The form body is rendered declaratively from MOP_FORM_SCHEMA
// by the shared FormEngine; this component owns the controller logic (AI draft
// bar, review pipeline, generation, preview aside, action bar). No server-side
// record is kept — form state lives in App and autosaves to localStorage.
import React, { useRef, useState, useEffect } from "react";
import {
  FileText, Server, CalendarClock, User, AlertCircle,
  ShieldAlert, ListChecks, FileDown, CheckCircle2, Sparkles,
  ExternalLink, Upload, Download, ChevronDown,
} from "lucide-react";
import { apiUrl, useToast } from "./core.js";
import { REVIEW_SECTIONS, summarizeReview, dedupeCrossSectionPatches } from "../mop-schema.js";
import {
  INK, MUTED, FAINT, ACCENT, SURFACE, CARD, HOVER, GOOGLE,
  ACCENT_DISABLED, ON_ACCENT, ON_ACCENT_DISABLED,
  DANGER, DANGER_BG, DANGER_FG,
  SUCCESS_FG, SUCCESS_PANEL, TAG_BG, TAG_FG,
  FS_XS, FS_SM, FS_MD, FS_BASE, FS_XL, FW_MEDIUM, FW_SEMIBOLD,
  BORDER, TEAM_FG,
  mono, inputCls, inputStyle,
} from "./core.js";
import {
  SYSTEMS, EXECUTORS, teamOf, BLANK,
} from "./form-data.js";
import {
  RowTable, TagInput, GovernancePanel, PreviewRow,
  FormNav, ReviewPanel, ChatPanel, withFindingIds,
} from "./core.js";
import { FormEngine, errKeysFrom } from "../../../packages/core/frontend/FormEngine.jsx";
import { MOP_FORM_SCHEMA, MOP_DATALISTS } from "./mop-form-schema.js";
import { downloadFormJson, readFormJson } from "./core.js";

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

export default function MopForm({ f, setF, onGenerated }) {
  const toast = useToast();
  const [touched, setTouched]       = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drafting, setDrafting]     = useState(false);
  const [intent, setIntent]         = useState("");
  const [aiOpen, setAiOpen] = useState(() => localStorage.getItem("mop.aiOpen") !== "0");
  const toggleAiOpen = () => setAiOpen((p) => {
    try { localStorage.setItem("mop.aiOpen", p ? "0" : "1"); } catch { /* private mode */ }
    return !p;
  });
  const [reviewing, setReviewing]   = useState(false);
  const [review, setReview]         = useState(null);
  const [applied, setApplied]       = useState(new Set());
  // Sidebar preview/checklist auto-minimize once Tinjau findings show up —
  // three full panels stacked in a 340px column is too much at once, and the
  // findings are what matters most right after a review runs. Still user-
  // toggleable afterward (e.g. to peek the live preview again mid-review).
  const [previewOpen, setPreviewOpen] = useState(true);
  const [checklistOpen, setChecklistOpen] = useState(true);
  useEffect(() => {
    if (review) { setPreviewOpen(false); setChecklistOpen(false); }
  }, [Boolean(review)]);
  const [feedbackOpen, setFeedbackOpen]           = useState(false);
  const [feedbackText, setFeedbackText]           = useState("");
  const [importingFeedback, setImportingFeedback] = useState(false);
  const feedbackFileRef = useRef(null);
  const [gdocing, setGdocing]       = useState(false);
  const [gdocError, setGdocError]   = useState(null);
  const [gdocs, setGdocs]           = useState([]);
  const importRef = useRef(null);

  const set    = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setArr = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  // Draft prerequisites — affected systems + window end + author + intent.
  // /api/draft needs something to anchor on; window_end + author ground the
  // procedure concretely (a MOP is instance-specific: one window, one executor).
  const draftPrereqs = [
    !f.affected_systems?.length && "sistem terpengaruh",
    !f.window_end   && "akhir maintenance window",
    !f.author       && "penyusun",
    !intent.trim()  && "kalimat prosedur",
  ].filter(Boolean);
  const canDraft = draftPrereqs.length === 0;

  const draftWithAI = async () => {
    setDrafting(true);
    try {
      const res = await fetch(apiUrl("/api/draft"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, affected_systems: f.affected_systems, author: f.author }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const { draft, examplesUsed = 0 } = await res.json();
      // Fill-empty-only: never overwrite fields the user already entered.
      const fillArr = (cur, next) => (Array.isArray(cur) && cur.length ? cur : (next || []));
      const fillStr = (cur, next) => (cur?.trim() ? cur : (next || ""));
      setF((p) => ({
        ...p,
        title:             fillStr(p.title, draft.title),
        purpose:           fillStr(p.purpose, draft.purpose),
        in_scope:          fillArr(p.in_scope, draft.in_scope),
        out_of_scope:      fillArr(p.out_of_scope, draft.out_of_scope),
        impact_summary:    fillStr(p.impact_summary, draft.impact_summary),
        dependencies:      fillArr(p.dependencies, draft.dependencies),
        rollback_deadline: fillStr(p.rollback_deadline, draft.rollback_deadline),
        rollback_triggers: fillStr(p.rollback_triggers, draft.rollback_triggers),
        prerequisites:     fillArr(p.prerequisites, draft.prerequisites),
        steps:             p.steps.length ? p.steps : (draft.steps?.length ? draft.steps : []),
        verification:      fillArr(p.verification, draft.verification),
      }));
      toast.success(
        examplesUsed > 0
          ? `Draf AI diterapkan — berdasarkan ${examplesUsed} MOP serupa. Tinjau sebelum membuat dokumen.`
          : "Draf AI diterapkan (tidak ada MOP serupa — draf generik). Tinjau sebelum membuat dokumen.",
      );
    } catch (err) {
      toast.error(
        "Gagal membuat draft AI. Pastikan backend berjalan dan LLM dikonfigurasi " +
          "(apps/mop/backend/.env). Error: " + err.message,
      );
    } finally {
      setDrafting(false);
    }
  };

  // Client-side required fields — a small subset (title + author + system) the
  // form flags before POSTing. The server's documentBlockers enforces the full
  // 8-point govCheck and surfaces any remaining blockers via the 400 body.
  const missingFields = [
    !f.title  && { id: "field-title",  field: "title",  label: "judul" },
    !f.author && { id: "field-author", field: "author", label: "penyusun" },
    !f.affected_systems?.length && { id: "field-system", field: "affected_systems", label: "sistem terpengaruh" },
  ].filter(Boolean);
  const missing = missingFields.map((m) => m.label);
  const errKeys = errKeysFrom(missingFields);

  const requireComplete = () => {
    setTouched(true);
    if (missingFields.length) {
      toast.error("Lengkapi dulu: " + missing.join(", ") + ".");
      document.getElementById(missingFields[0].id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    try { localStorage.setItem("mop.lastAuthor", f.author); } catch { /* private mode */ }
    return true;
  };

  // One focused LLM review per section, concurrent up to the provider limit.
  const reviewAbort = useRef(null);
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
    const results = new Array(total);
    let done = 0, degraded = 0, reused = 0, aborted = false, fatal = null;
    const running = new Set();

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
    refresh();
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

  // Keyed by the finding's stable id, not its position in review.findings —
  // that array is rebuilt in section order every time another section
  // resolves, so a raw array index would drift to a different finding
  // mid-review.
  const applyPatch = (id) => {
    const x = review?.findings?.find((f) => f.id === id);
    if (!x?.patch) return;
    const { field, value } = x.patch;
    setF((p) => ({ ...p, [field]: value }));
    setApplied((s) => new Set([...s, id]));
  };
  const applyAll = (ids) => {
    ids.forEach(applyPatch);
    toast.success(`${ids.length} perbaikan diterapkan`);
  };

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
  // gated. Not part of the MOP record; stripped by exampleOf before storage.
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
          toast.error(`${e.error || "Dokumen belum lengkap."} Lengkapi: ${e.blockers.join(", ")}.`);
          return;
        }
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${(f.title || "mop").replace(/[\/\\:*?"<>|]+/g, " ").trim().slice(0, 120)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
      onGenerated({ form: f, kind: "docx" });
      toast.success("Dokumen Word diunduh — tersimpan di Riwayat");
    } catch (err) {
      toast.error("Gagal mengunduh .docx. Pastikan backend berjalan. Error: " + err.message);
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
          setGdocError(`${e.error || "Dokumen belum lengkap."} Lengkapi: ${e.blockers.join(", ")}.`);
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
      setGdocError("Gagal membuat Google Doc. Pastikan backend berjalan dan Google OAuth dikonfigurasi. Error: " + err.message);
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

  const importFeedbackFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { setFeedbackText(await file.text()); } catch { toast.error("Gagal membaca file."); }
  };

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

  // Window label for the preview: "02:00 – 04:00 · WIB" from window_start/end.
  const windowLabel = [f.window_start, f.window_end].filter(Boolean).join(" – ") + (f.timezone ? ` · ${f.timezone}` : "");

  return (
    <div className="flex flex-col gap-6">

      <FormNav f={f} />

      {/* ─── AI draft bar ─── */}
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
              Pilih sistem terpengaruh, isi akhir window &amp; penyusun, lalu jelaskan prosedur dalam satu kalimat.
              AI akan menyusun tujuan, ruang lingkup, prasyarat, langkah eksekusi (dengan perintah, hasil harapan,
              dan aksi rollback per langkah), verifikasi, serta rencana rollback — meniru gaya MOP sebelumnya.
              Tinjau dan sesuaikan sebelum membuat dokumen.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 items-start">
              <div className="col-span-2">
                <TagInput value={f.affected_systems} onChange={setArr("affected_systems")} options={SYSTEMS}
                  placeholder="Pilih atau ketik sistem…" />
              </div>
              <input type="datetime-local" className={inputCls} style={inputStyle} value={f.window_start}
                onChange={set("window_start")} aria-label="Window mulai (draft AI)" />
              <input type="datetime-local" className={inputCls} style={inputStyle} value={f.window_end}
                onChange={set("window_end")} aria-label="Window selesai (draft AI)" />
              <input className={inputCls} style={inputStyle} list="executor-list"
                value={f.author} onChange={set("author")}
                placeholder="Nama penyusun…" aria-label="Penyusun (draft AI)" />
            </div>
            <div className="flex gap-2">
              <textarea
                className={inputCls}
                style={{ ...inputStyle, flex: 1, minHeight: 40, resize: "vertical", lineHeight: 1.5 }}
                rows={1}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="cth: perluasan storage database 35TB → 40TB"
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
              <div className="flex items-center gap-1.5" style={{ fontSize: FS_XS, color: FAINT }}>
                <AlertCircle size={12} style={{ flexShrink: 0 }} />
                Lengkapi dulu agar draft akurat: {draftPrereqs.join(", ")}.
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Two-column body ─── */}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="flex flex-col gap-6 min-w-0">

        <FormEngine
          schema={MOP_FORM_SCHEMA}
          f={f} setF={setF}
          touched={touched}
          errKeys={errKeys}
          tools={{
            TagInput, RowTable,
            datalists: MOP_DATALISTS,
          }}
        />
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
              <div style={{ fontSize: FS_XL, fontWeight: FW_SEMIBOLD, color: INK, lineHeight: 1.35 }}>
                {f.title || "Method of Procedure…"}
              </div>
              {f.affected_systems?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {f.affected_systems.map((s, i) => (
                    <span key={i} className="rounded-full px-2 py-0.5"
                      style={{ background: TAG_BG, color: TAG_FG, fontSize: FS_XS, fontWeight: FW_MEDIUM }}>
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <p style={{ fontSize: FS_MD, color: f.purpose ? INK : FAINT, lineHeight: 1.65 }}>
                {f.purpose || "Tujuan prosedur muncul di sini saat Anda mengisi field."}
              </p>
              <div style={{ borderTop: BORDER }} className="pt-3 flex flex-col gap-2">
                <PreviewRow icon={User} label="Penyusun" value={
                  f.author ? (
                    <span>{f.author}
                      {teamOf(f.author) &&
                        <span style={{ color: TEAM_FG[teamOf(f.author)], fontWeight: FW_SEMIBOLD }}> · {teamOf(f.author)}</span>}
                    </span>
                  ) : ""} />
                <PreviewRow icon={CalendarClock} label="Window" value={windowLabel} monoStyle={mono} />
                {f.prerequisites?.length > 0 && <PreviewRow icon={CheckCircle2} label="Prasyarat" value={`${f.prerequisites.length} item`} />}
                {f.steps?.length > 0 && <PreviewRow icon={ListChecks}  label="Langkah" value={`${f.steps.length} langkah`} />}
                {f.verification?.length > 0 && <PreviewRow icon={ShieldAlert} label="Verifikasi" value={`${f.verification.length} kriteria`} />}
              </div>
            </div>
            )}
          </div>

          <GovernancePanel f={f} collapsed={!checklistOpen} onToggleCollapse={() => setChecklistOpen((p) => !p)} />

          {/* Governance & Security review findings, moved into the sidebar
              (compact: collapsed issue text, fix/patch behind a click to
              expand) so they stay visible while editing the form instead of
              requiring a scroll down. */}
          {review && (
            <ReviewPanel review={review} form={f} applied={applied}
              onApply={(i) => { applyPatch(i); }} onApplyAll={applyAll} compact />
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

      {/* Import real feedback */}
      <div className="flex flex-col gap-2">
        <button onClick={() => setFeedbackOpen((v) => !v)}
          title="Muat feedback dari reviewer untuk merevisi MOP ini"
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 self-start"
          style={{ border: BORDER, fontSize: FS_BASE, background: CARD, color: MUTED, fontWeight: FW_MEDIUM, cursor: "pointer" }}>
          <Upload size={16} /> Impor Feedback
        </button>
        {feedbackOpen && (
          <div className="flex flex-col gap-2 rounded-lg p-4" style={{ background: HOVER, border: BORDER }}>
            <p style={{ fontSize: FS_SM, color: MUTED, lineHeight: 1.5 }}>
              Tempel teks feedback dari reviewer, atau unggah filenya. Temuan yang masih relevan terhadap
              isi MOP saat ini akan muncul di panel Tinjau di bawah.
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

      {/* Actions */}
      <div className="sticky-bar bottom-0 flex flex-wrap items-center justify-between gap-2 py-3"
        style={{ borderTop: BORDER, marginTop: 4 }}>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={runReview}
            title="Tinjau Governance & Security"
            className="inline-flex items-center gap-2 rounded-md px-4 py-2"
            style={{ border: `1px solid ${ACCENT}`, fontSize: FS_BASE, background: CARD, color: ACCENT, fontWeight: FW_MEDIUM, cursor: "pointer" }}>
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
          <button onClick={() => downloadFormJson(f, { fallbackName: "mop-form" })} title="Simpan isi form sebagai file JSON"
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

      <ChatPanel f={f} />
    </div>
  );
}
