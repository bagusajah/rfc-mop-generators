// Shared form UI: primitives (Field, RowTable, TagInput, …), the governance
// checklist, section nav, and the review-findings panel with one-click fixes.
// Domain hooks (REVIEW_SECTIONS, govCheck, scopeWarnings) are injected via
// <AppProvider> so this module stays app-neutral — see app-context.js.
import React, { useId, useState, useRef, useEffect } from "react";
import {
  Plus, X, ListChecks, CheckCircle2, Circle, ShieldAlert, Wand2, Check, RefreshCw,
  MessageCircle, Send, ChevronDown,
} from "lucide-react";
import { useApp } from "./app-context.js";
import { apiUrl } from "./api.js";
import {
  INK, MUTED, FAINT, ACCENT, SURFACE, CARD, DANGER,
  WARN_BG, WARN_FG, WARN_BORDER, WARN_PANEL,
  SUCCESS_FG, SUCCESS_INK, SUCCESS_ICON, SUCCESS_BORDER, SUCCESS_PANEL,
  TAG_BG, TAG_FG, R_MD, R_PILL,
  FS_XS, FS_SM, FS_MD, FS_BASE, FW_NORMAL, FW_MEDIUM, FW_SEMIBOLD,
  CELL_PAD_SM, BORDER, RISK_LEVEL_STYLE, SEVERITY_STYLE,
  ACCENT_DISABLED, ON_ACCENT, ON_ACCENT_DISABLED,
  inputCls, inputStyle,
} from "./tokens.js";

export function Field({ label, children, hint, required, ...rest }) {
  return (
    <label className="flex flex-col gap-1.5" {...rest}>
      <span style={{
        fontSize: FS_XS, fontWeight: FW_SEMIBOLD, color: FAINT,
        textTransform: "uppercase", letterSpacing: "0.05em",
      }}>
        {label}{required && <span style={{ color: DANGER }}> *</span>}
      </span>
      {children}
      {hint && <span style={{ fontSize: FS_SM, color: FAINT }}>{hint}</span>}
    </label>
  );
}

// `badge`, when given, is a resolved `{ label, style: {background, color} }`
// (e.g. from URGENSI_STYLE[f.urgensi]) rendered as a pill in the top-right —
// the section's current value at a glance without opening it. Caller resolves
// the style (this stays app-neutral, no schema/token-map import here).
export function SectionHead({ icon: Icon, label, badge }) {
  return (
    <div className="flex items-center gap-2 pb-2" style={{ borderBottom: BORDER }}>
      {Icon && <Icon size={15} style={{ color: ACCENT }} />}
      <span style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>{label}</span>
      {badge && (
        <span className="ml-auto rounded-full px-2 py-0.5"
          style={{ fontSize: FS_XS, fontWeight: FW_SEMIBOLD, ...badge.style }}>
          {badge.label}
        </span>
      )}
    </div>
  );
}

/* ── Dynamic row table ── */

// `rows` should always be an array, but a draft saved under an older schema
// (localStorage / imported JSON) can carry a stale non-array value for this
// field — guard here, once, rather than trusting every caller's data.
export function RowTable({ rows: rowsProp, onChange, columns, addLabel, transform, minWidth = 460 }) {
  const rows = Array.isArray(rowsProp) ? rowsProp : [];
  const add = () => {
    const row = Object.fromEntries(columns.map((c) => [c.key, ""]));
    onChange([...rows, transform ? transform(row) : row]);
  };
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const update = (i, key, val) => {
    const next = { ...rows[i], [key]: val };
    onChange(rows.map((r, j) => (j === i ? (transform ? transform(next) : next) : r)));
  };

  const tpl = columns.map((c) => c.flex || "1fr").join(" ") + " 28px";

  return (
    <div className="flex flex-col gap-2">
      <div className="scroll-x">
        <div className="flex flex-col gap-2" style={{ minWidth }}>
          {rows.length > 0 && (
            <div className="grid gap-2 items-end rounded"
              style={{ gridTemplateColumns: tpl, background: SURFACE, padding: "6px 6px" }}>
              {columns.map((c) => (
                <span key={c.key}
                  style={{ fontSize: FS_XS, fontWeight: FW_SEMIBOLD, color: FAINT, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {c.label}
                </span>
              ))}
              <span />
            </div>
          )}
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 items-start rounded"
          style={{ gridTemplateColumns: tpl, background: i % 2 === 1 ? SURFACE : "transparent", padding: "4px 6px" }}>
          {columns.map((col) =>
            col.readOnly ? (
              <span key={col.key}
                className="rounded-full px-2 py-1 self-center text-center block"
                style={{ fontSize: FS_XS, fontWeight: FW_SEMIBOLD, ...(RISK_LEVEL_STYLE[row[col.key]] || { background: SURFACE, color: MUTED }) }}>
                {row[col.key] || "—"}
              </span>
            ) : col.options ? (
              <select key={col.key} className={inputCls}
                style={{ ...inputStyle, fontSize: FS_MD, padding: CELL_PAD_SM }}
                value={row[col.key]}
                onChange={(e) => update(i, col.key, e.target.value)}>
                <option value="">{col.label}</option>
                {col.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input key={col.key} className={inputCls}
                style={{ ...inputStyle, fontSize: FS_MD, padding: CELL_PAD_SM, ...(col.cellStyle || {}) }}
                placeholder={col.label} value={row[col.key]}
                onChange={(e) => update(i, col.key, e.target.value)} />
            )
          )}
          <button onClick={() => remove(i)} title="Hapus baris" aria-label="Hapus baris"
            className="icon-btn-sm self-start mt-1" style={{ color: DANGER }}>
            <X size={13} />
          </button>
        </div>
      ))}
        </div>
      </div>
      <button onClick={add}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 self-start"
        style={{ border: BORDER, color: MUTED, fontSize: FS_SM, background: CARD }}>
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}

/* ── Component tag input ── */

// `value` should always be an array — same stale-draft guard as RowTable.
export function TagInput({ value: valueProp, onChange, options, placeholder = "Ketik nama komponen, tekan Enter untuk menambah", error }) {
  const value = Array.isArray(valueProp) ? valueProp : [];
  const [input, setInput] = useState("");
  const listId = useId();

  const add = () => {
    const v = input.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setInput("");
  };
  const remove = (i) => onChange(value.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5"
              style={{ background: TAG_BG, color: TAG_FG, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
              {v}
              <button onClick={() => remove(i)} title="Hapus" aria-label="Hapus komponen"
                className="icon-btn-sm" style={{ color: TAG_FG }}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD, ...(error ? { borderColor: DANGER } : {}) }}
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          list={options ? listId : undefined}
          placeholder={placeholder} />
        <button onClick={add} className="rounded-md px-3 py-2 flex-shrink-0"
          style={{ border: BORDER, color: MUTED, fontSize: FS_MD, background: CARD }}>
          Tambah
        </button>
      </div>
      {options && (
        <datalist id={listId}>
          {options.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

/* ── Governance checklist panel ── */

// `collapsed`/`onToggleCollapse` are optional — omit both for the original
// always-expanded, non-interactive header (e.g. MOP, which doesn't have a
// sidebar review panel competing for room yet).
export function GovernancePanel({ f, collapsed, onToggleCollapse }) {
  const { govCheck, scopeWarnings } = useApp();
  const checks  = govCheck(f);
  const warnings = scopeWarnings(f);
  const passed  = checks.filter((c) => c.ok).length;
  const allOk   = passed === checks.length;
  const Header = onToggleCollapse ? "button" : "div";

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: BORDER }}>
      <Header {...(onToggleCollapse ? { onClick: onToggleCollapse, "aria-expanded": !collapsed } : {})}
        className={`w-full px-4 py-2.5 flex items-center justify-between ${onToggleCollapse ? "text-left" : ""}`}
        style={{ borderBottom: collapsed ? "none" : BORDER, background: SURFACE, cursor: onToggleCollapse ? "pointer" : "default" }}>
        <div className="flex items-center gap-2">
          <ListChecks size={14} style={{ color: FAINT }} />
          <span style={{ fontSize: FS_SM, fontWeight: FW_MEDIUM, color: MUTED }}>Checklist tinjauan</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: FS_SM, fontWeight: FW_SEMIBOLD, color: allOk ? SUCCESS_FG : WARN_FG }}>
            {passed}/{checks.length}
          </span>
          {onToggleCollapse && (
            <ChevronDown size={14} style={{
              color: FAINT, transform: collapsed ? "none" : "rotate(180deg)", transition: "transform 0.15s",
            }} />
          )}
        </div>
      </Header>
      {!collapsed && (
      <div className="px-4 py-3 flex flex-col gap-2">
        {checks.map((c) => (
          <div key={c.id} className="flex items-center gap-2" style={{ fontSize: FS_SM }}>
            {c.ok
              ? <CheckCircle2 size={14} style={{ color: SUCCESS_ICON, flexShrink: 0 }} />
              : <Circle      size={14} style={{ color: FAINT,    flexShrink: 0 }} />}
            <span style={{ color: c.ok ? INK : MUTED }}>{c.label}</span>
          </div>
        ))}
        {warnings.length > 0 && (
          <div className="mt-1 rounded-md px-3 py-2"
            style={{ background: WARN_BG, color: WARN_FG, fontSize: FS_XS }}>
            <div style={{ fontWeight: FW_SEMIBOLD, marginBottom: 3 }}>Scope tidak sesuai</div>
            {warnings.map((w, i) => <div key={i}>"{w}" belum disebut di deskripsi</div>)}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/* ── Preview row helper ── */

export function PreviewRow({ icon: Icon, label, value, monoStyle }) {
  if (!value) return null;
  return (
    // items-start (not items-center): a long value (e.g. several tagged
    // systems, comma-joined with no truncation) can wrap to multiple lines —
    // centering would float the icon/label against the whole wrapped block
    // instead of aligning them to its first line.
    <div className="flex items-start gap-2" style={{ fontSize: FS_MD }}>
      <Icon size={14} style={{ color: FAINT, flexShrink: 0, marginTop: 2 }} />
      <span style={{ color: MUTED, minWidth: 64, flexShrink: 0 }}>{label}</span>
      <span style={{ color: INK, ...(monoStyle || {}) }}>{value}</span>
    </div>
  );
}

/* ── Section navigation ── */

// Default nav layout = the RFC form's sections. An app whose sections differ
// (MOP) supplies its own via <AppProvider value={{ navItems: (checks) => [...] }}>.
const DEFAULT_NAV_ITEMS = (checks) => [
  { id: "sec-info",        label: "Informasi",  ok: checks[0].ok },
  { id: "sec-urgensi",     label: "Jadwal",     ok: checks[2].ok },
  { id: "sec-sistem",      label: "Sistem",     ok: checks[1].ok },
  { id: "sec-risiko",      label: "Risiko",     ok: checks[3].ok },
  { id: "sec-security",    label: "Security",   ok: checks[7].ok },
  { id: "sec-pengerjaan",  label: "Pengerjaan", ok: checks[5].ok },
  { id: "sec-rollback",    label: "Rollback",   ok: checks[6].ok },
  { id: "sec-pengecualian", label: "Pengecualian", ok: null },
  { id: "sec-pengesahan",  label: "Pengesahan", ok: null },
];

export function FormNav({ f }) {
  // Map each section to a governance-check item for a completion dot.
  const { govCheck, navItems = DEFAULT_NAV_ITEMS } = useApp();
  const items = navItems(govCheck(f));
  return (
    <nav aria-label="Form sections"
      className="sticky-bar top-0 flex items-center gap-1.5 overflow-x-auto py-2">
      {items.map((it) => (
        <a key={it.id} href={`#${it.id}`}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 whitespace-nowrap"
          style={{ border: BORDER, background: CARD, fontSize: FS_SM, color: it.ok === false ? MUTED : INK }}>
          <span style={{
            width: 7, height: 7, borderRadius: R_PILL, flexShrink: 0,
            background: it.ok === true ? SUCCESS_ICON : it.ok === false ? FAINT : "transparent",
            border: it.ok === null ? BORDER : "none",
          }} />
          {it.label}
        </a>
      ))}
    </nav>
  );
}

/* ── Review findings panel (with one-click fixes) ── */

// Human preview of what a patch will change: truncated before → after for
// prose, item counts for arrays.
function patchPreview(form, patch) {
  const trunc = (s) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > 90 ? t.slice(0, 90) + "…" : t || "(kosong)";
  };
  const oldVal = form?.[patch.field];
  if (Array.isArray(patch.value) || Array.isArray(oldVal)) {
    const a = Array.isArray(oldVal) ? oldVal.length : 0;
    const b = Array.isArray(patch.value) ? patch.value.length : 0;
    return `${a} item → ${b} item (${patch.field})`;
  }
  return `"${trunc(oldVal)}" → "${trunc(patch.value)}"`;
}

// Stable per-finding id ("<section>#<nth within that section>") so "applied"
// tracking and React keys survive findings being re-merged in a different
// order as review sections resolve out of order. Safe to recompute on every
// snapshot: a section's own findings never reorder once resolved, so the same
// finding always gets the same nth-within-its-section count regardless of
// which other sections are present around it in that particular pass.
export function withFindingIds(findings) {
  const seen = {};
  return findings.map((x) => {
    const n = seen[x.section] = (seen[x.section] || 0) + 1;
    return { ...x, id: `${x.section}#${n - 1}` };
  });
}

// Anchors FormNav already defines (components.jsx below) — clicking a section
// header jumps straight to that part of the form. "bahasa" has no single
// anchor (it sweeps every text field), so it's plain (non-clickable) text.
// App-supplied via <AppProvider value={{ sectionAnchor }}> when the app's
// section ids differ; defaults to the RFC layout.
const DEFAULT_SECTION_ANCHOR = {
  deskripsi: "sec-info", dampak: "sec-sistem", jadwal: "sec-urgensi",
  risiko: "sec-risiko", pengerjaan: "sec-pengerjaan", security: "sec-security",
};

// One finding's card — issue, one-click fix advice, patch preview/apply.
// `compact` (sidebar mode) clamps the issue to 2 lines and hides fix/patch
// behind a click-to-expand — the apply button still always shows so a patch
// can be applied without expanding. Non-compact behavior is unchanged.
function FindingCard({ x, form, applied, onApply, compact }) {
  const st = SEVERITY_STYLE[x.severity] || SEVERITY_STYLE.warn;
  const done = applied.has(x.id);
  const [expanded, setExpanded] = useState(!compact);
  const showBody = !compact || expanded;
  return (
    <div className="rounded-md p-3"
      style={{ background: st.panel, border: BORDER, borderLeft: `3px solid ${st.border}`, opacity: done ? 0.75 : 1 }}>
      <div className="flex items-center gap-2 mb-1 flex-wrap" style={{ fontSize: FS_SM }}>
        <span className="rounded-full px-2 py-0.5" style={{ background: st.bg, color: st.fg, fontWeight: FW_SEMIBOLD }}>
          {st.label}
        </span>
        {!compact && <span style={{ color: FAINT }}>{x.area}</span>}
        {x.patch && (
          done ? (
            <span className="inline-flex items-center gap-1 ml-auto" style={{ color: SUCCESS_INK, fontWeight: FW_MEDIUM }}>
              <Check size={13} /> Diterapkan
            </span>
          ) : (
            <button onClick={() => onApply(x.id)}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ml-auto"
              style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: CARD, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
              <Wand2 size={13} /> Terapkan
            </button>
          )
        )}
      </div>
      <div
        className="flex items-start gap-1.5"
        onClick={compact ? () => setExpanded((e) => !e) : undefined}
        style={{ cursor: compact ? "pointer" : "default" }}>
        {compact && (
          <ChevronDown size={13} style={{
            color: FAINT, flexShrink: 0, marginTop: 3,
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform var(--transition-fast)",
          }} />
        )}
        <span style={{
          fontSize: FS_MD, color: INK, lineHeight: 1.5,
          display: compact && !expanded ? "-webkit-box" : "block",
          WebkitLineClamp: compact && !expanded ? 2 : undefined,
          WebkitBoxOrient: compact && !expanded ? "vertical" : undefined,
          overflow: compact && !expanded ? "hidden" : "visible",
        }}>{x.issue}</span>
      </div>
      {showBody && x.fix && (
        <div style={{ fontSize: FS_MD, color: SUCCESS_INK, lineHeight: 1.5, marginTop: 2 }}>
          → {x.fix}
        </div>
      )}
      {showBody && x.patch && !done && (
        <div style={{ fontSize: FS_XS, color: FAINT, marginTop: 4, fontStyle: "italic" }}>
          {patchPreview(form, x.patch)}
        </div>
      )}
    </div>
  );
}

// One section's row in the panel: a status icon (pending/active/clean/has-
// findings/not-reached) + label, doubling as the review's progress display
// (there's no separate spinner line — a still-pending row IS the "not done
// yet" signal). Findings render nested underneath, only when there are any.
function SectionGroup({ section, items, status, form, applied, onApply, compact }) {
  const { sectionAnchor = DEFAULT_SECTION_ANCHOR } = useApp();
  const anchor = sectionAnchor[section.id];
  const Header = anchor ? "a" : "div";
  const icon =
    status === "pending" || status === "notReached"
      ? <Circle size={14} style={{ color: FAINT, flexShrink: 0 }} />
    : status === "active"
      ? <RefreshCw size={14} className="animate-spin" style={{ color: MUTED, flexShrink: 0 }} />
    : items.length === 0
      ? <CheckCircle2 size={14} style={{ color: SUCCESS_ICON, flexShrink: 0 }} />
      : <span style={{
          width: 9, height: 9, borderRadius: R_PILL, flexShrink: 0,
          background: SEVERITY_STYLE[["block", "warn", "info"].find((s) => items.some((x) => x.severity === s))].fg,
        }} />;
  const trailing =
    status === "pending" ? null
    : status === "active" ? null
    : status === "notReached" ? "— belum ditinjau"
    : items.length === 0 ? "— tidak ada temuan"
    : `— ${items.length} temuan`;
  return (
    <div className="flex flex-col gap-2">
      <Header {...(anchor ? { href: `#${anchor}` } : {})}
        className="flex items-center gap-2"
        style={{
          fontSize: FS_SM, fontWeight: FW_MEDIUM, textDecoration: "none",
          color: status === "pending" || status === "notReached" ? FAINT : INK,
          cursor: anchor ? "pointer" : "default",
        }}>
        {icon}
        {section.label}
        {trailing && <span style={{ color: FAINT, fontWeight: FW_NORMAL }}>{trailing}</span>}
      </Header>
      {items.length > 0 && (
        <div className="flex flex-col gap-2 pl-1">
          {items.map((x) => <FindingCard key={x.id} x={x} form={form} applied={applied} onApply={onApply} compact={compact} />)}
        </div>
      )}
    </div>
  );
}

// `sectionIds`, when given, limits which REVIEW_SECTIONS groups render below
// (e.g. a wizard step showing only its own findings) — the summary banner
// above still reflects the full unfiltered `findings`, so overall readiness
// stays a single source of truth regardless of which subset is visible.
// Omitted = every section renders, unchanged from prior behavior.
// `compact` (sidebar mode) tightens padding, drops the redundant summary
// line (the header banner already says it), and renders each finding
// collapsed via FindingCard's own compact mode — for a full-width usage
// (e.g. below the form), omit it and nothing changes from before.
export function ReviewPanel({ review, form, applied, onApply, onApplyAll, sectionIds, compact }) {
  const { REVIEW_SECTIONS } = useApp();
  const visibleSections = sectionIds ? REVIEW_SECTIONS.filter((s) => sectionIds.includes(s.id)) : REVIEW_SECTIONS;
  const { ready, summary, findings = [], inProgress, sections = [], running = [], done = 0, total = 0 } = review;
  const counts = findings.reduce((m, x) => ({ ...m, [x.severity]: (m[x.severity] || 0) + 1 }), {});
  const applicable = findings.filter((x) => x.patch && !applied.has(x.id)).map((x) => x.id);
  const runningSet = new Set(running);

  return (
    <div className={`flex flex-col gap-3 rounded-lg ${compact ? "p-3" : "p-4"}`}
      style={{
        border: `1px solid ${ready ? SUCCESS_BORDER : WARN_BORDER}`, background: ready ? SUCCESS_PANEL : WARN_PANEL,
        transition: "background var(--transition-fast), border-color var(--transition-fast)",
      }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2" style={{ fontSize: compact ? FS_SM : FS_BASE, fontWeight: FW_SEMIBOLD, color: ready ? SUCCESS_FG : WARN_FG }}>
          {ready ? <CheckCircle2 size={compact ? 14 : 16} /> : <ShieldAlert size={compact ? 14 : 16} />}
          {inProgress
            ? `Meninjau… ${done}/${total}${ready ? " — belum ada blocker" : ""}`
            : (ready ? "Siap diajukan" : "Perlu diperbaiki")}
        </div>
        {!inProgress && applicable.length > 1 && (
          <button onClick={() => onApplyAll(applicable)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5"
            style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: CARD, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
            <Wand2 size={13} /> Terapkan semua ({applicable.length})
          </button>
        )}
      </div>
      {!compact && summary && <p style={{ fontSize: FS_MD, color: MUTED, lineHeight: 1.5 }}>{summary}</p>}
      {findings.length > 0 && (
        <div className="flex gap-2 flex-wrap" style={{ fontSize: FS_SM }}>
          {["block", "warn", "info"].filter((s) => counts[s]).map((s) => (
            <span key={s} className="rounded-full px-2 py-0.5"
              style={{ background: SEVERITY_STYLE[s].bg, color: SEVERITY_STYLE[s].fg }}>
              {counts[s]} {SEVERITY_STYLE[s].label}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {visibleSections.map((section) => {
          const items = findings.filter((x) => x.section === section.id);
          const resolved = sections.some((s) => s.id === section.id);
          const status = resolved ? "done"
            : inProgress ? (runningSet.has(section.id) ? "active" : "pending")
            : "notReached";
          return (
            <SectionGroup key={section.id} section={section} items={items} status={status}
              form={form} applied={applied} onApply={onApply} compact={compact} />
          );
        })}
      </div>
    </div>
  );
}

/* ── Chat panel: Q&A grounded in the corpus + current draft (/api/chat) ── */

// Cap how much prior conversation gets sent as context — the record JSON,
// examples, and policy excerpts are already re-sent every turn, so unbounded
// history growth risks blowing past the local model's context window (and
// gets slower/costlier turn by turn). Older turns just drop off; the UI still
// shows the full transcript, only the backend payload is capped.
const HISTORY_LIMIT = 8;

// `onApplyPatch(field, value)` is optional — when a backend answer carries a
// `patch` (a direct "fill this field" request it could confidently resolve,
// same contract as a Tinjau finding's patch), the message renders a
// "Terapkan" button next to it. Omit the prop to disable this (chat still
// works as plain Q&A) — used by apps that don't wire up an apply path.
export function ChatPanel({ f, onApplyPatch }) {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([]); // { role, content, patch?, applied? }
  const [input, setInput]       = useState("");
  const [sending, setSending]   = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  const send = async () => {
    const question = input.trim();
    if (!question || sending) return;
    const history = messages.slice(-HISTORY_LIMIT);
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, record: f, history }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const { answer, patch } = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: answer, patch: patch || null, applied: false }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", content: `Gagal menjawab: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  };

  const applyMessagePatch = (i) => {
    const m = messages[i];
    if (!m?.patch || !onApplyPatch) return;
    onApplyPatch(m.patch.field, m.patch.value);
    setMessages((ms) => ms.map((x, j) => (j === i ? { ...x, applied: true } : x)));
  };

  return (
    <>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center rounded-full"
        style={{
          position: "fixed", right: 20, bottom: 20, width: 48, height: 48,
          background: ACCENT, color: ON_ACCENT, boxShadow: "0 4px 14px rgba(0,0,0,.22)", zIndex: 900,
        }}
        aria-label={open ? "Tutup chat" : "Tanya AI seputar RFC ini"}>
        {open ? <X size={20} /> : <MessageCircle size={20} />}
      </button>
      {open && (
        <div className="flex flex-col" style={{
          position: "fixed", right: 20, bottom: 80, width: 340, maxHeight: 460,
          background: CARD, border: BORDER, borderRadius: R_MD,
          boxShadow: "0 8px 24px rgba(0,0,0,.18)", zIndex: 900,
        }}>
          <div className="flex items-center gap-2 px-3 py-2.5"
            style={{ borderBottom: BORDER, fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>
            <MessageCircle size={14} style={{ color: ACCENT }} /> Tanya seputar RFC ini
          </div>
          <div ref={listRef} className="flex flex-col gap-2 px-3 py-3" style={{ overflowY: "auto", flex: 1 }}>
            {messages.length === 0 && (
              <p style={{ fontSize: FS_SM, color: FAINT, lineHeight: 1.5 }}>
                Tanyakan apa saja tentang draft ini — contoh RFC serupa, kelengkapan security requirement,
                atau cara mengisi suatu bagian.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className="flex flex-col gap-1" style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%",
              }}>
                <div className="rounded-md px-2.5 py-1.5" style={{
                  background: m.role === "user" ? ACCENT : SURFACE,
                  color: m.role === "user" ? ON_ACCENT : INK,
                  fontSize: FS_SM, lineHeight: 1.5, whiteSpace: "pre-wrap",
                }}>
                  {m.content}
                </div>
                {m.patch && onApplyPatch && (
                  m.applied ? (
                    <span className="inline-flex items-center gap-1 self-start"
                      style={{ fontSize: FS_XS, color: SUCCESS_INK, fontWeight: FW_MEDIUM }}>
                      <Check size={12} /> Diterapkan ke {m.patch.field}
                    </span>
                  ) : (
                    <button onClick={() => applyMessagePatch(i)}
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 self-start"
                      style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: CARD, fontSize: FS_XS, fontWeight: FW_MEDIUM }}>
                      <Wand2 size={12} /> Terapkan ke {m.patch.field}
                    </button>
                  )
                )}
              </div>
            ))}
            {sending && <div style={{ fontSize: FS_SM, color: FAINT }}>Menjawab…</div>}
          </div>
          <div className="flex gap-2 px-3 py-2.5" style={{ borderTop: BORDER }}>
            <input className={inputCls} style={inputStyle} value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !sending) { e.preventDefault(); send(); } }}
              placeholder="Ketik pertanyaan…" aria-label="Pertanyaan untuk AI" />
            <button onClick={send} disabled={sending || !input.trim()}
              className="inline-flex items-center justify-center rounded-md px-3"
              style={{
                background: sending || !input.trim() ? ACCENT_DISABLED : ACCENT,
                color: sending || !input.trim() ? ON_ACCENT_DISABLED : ON_ACCENT,
                cursor: sending || !input.trim() ? "not-allowed" : "pointer",
              }}>
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
