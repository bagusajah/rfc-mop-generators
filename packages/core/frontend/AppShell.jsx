// Generic app shell: one form, no tracking. The in-progress form autosaves to
// localStorage; each generated document is kept in a small local "riwayat"
// so a rejection can be revised without retyping. Everything app-specific
// (the form itself, AI panels, doc generation) is supplied by the caller via
// props so this shell serves RFC, MOP, and any future sibling app unchanged.
import React, { useEffect, useRef, useState } from "react";
import {
  FileText, Plus, Server, Sun, Moon, History, X, Trash2, ExternalLink, FileDown, Cpu,
} from "lucide-react";
import { useTheme } from "./use-theme.js";
import { useToast } from "./toast.jsx";
import { useConfirm } from "./confirm.jsx";
import {
  INK, MUTED, FAINT, ACCENT, SURFACE, CARD, GOOGLE, ON_ACCENT, LINE,
  FS_XS, FS_SM, FS_MD, FS_BASE, FS_2XL, FW_MEDIUM, FW_SEMIBOLD,
  BORDER, FONT_SANS, FONT_DISPLAY,
} from "./tokens.js";
import {
  loadDraft, saveDraft, loadHistory, pushHistory, removeHistory,
} from "./localStore.js";
import LlmSettings from "./LlmSettings.jsx";

function HistoryDrawer({ open, onClose, entries, onRestore, onRemove }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Riwayat dokumen">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 flex flex-col"
        style={{ width: "min(420px, 92vw)", background: SURFACE, borderLeft: BORDER, boxShadow: "-8px 0 24px rgba(0,0,0,0.12)" }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: BORDER }}>
          <div className="flex items-center gap-2" style={{ fontSize: FS_BASE, fontWeight: FW_SEMIBOLD, color: INK }}>
            <History size={16} style={{ color: ACCENT }} /> Riwayat dokumen
          </div>
          <button onClick={onClose} className="icon-btn" title="Tutup" aria-label="Tutup riwayat">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {entries.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12" style={{ color: FAINT, fontSize: FS_MD }}>
              <FileText size={20} />
              Belum ada dokumen yang dibuat.
              <span style={{ fontSize: FS_SM, textAlign: "center" }}>
                Setiap kali Anda mengunduh .docx atau membuat Google Doc,
                isian formnya tersimpan di sini.
              </span>
            </div>
          )}
          {entries.map((e) => (
            <div key={e.id} className="rounded-lg p-3 flex flex-col gap-1.5" style={{ border: BORDER, background: CARD }}>
              <button onClick={() => onRestore(e)} className="text-left"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                         fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK, lineHeight: 1.4 }}>
                {e.title}
              </button>
              <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: FS_XS, color: FAINT }}>
                <span>
                  {new Date(e.savedAt).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                {(e.kinds || []).includes("docx") && (
                  <span className="inline-flex items-center gap-1" style={{ color: MUTED }}>
                    <FileDown size={11} /> .docx
                  </span>
                )}
                {e.link && (
                  <a href={e.link} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1" style={{ color: GOOGLE }}>
                    <ExternalLink size={11} /> Google Doc
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => onRestore(e)}
                  className="rounded-md px-2.5 py-1"
                  style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: CARD, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
                  Buka di form
                </button>
                <button onClick={() => onRemove(e.id)} title="Hapus dari riwayat" aria-label="Hapus dari riwayat"
                  className="icon-btn-sm ml-auto" style={{ color: FAINT }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2.5" style={{ borderTop: BORDER, fontSize: FS_XS, color: FAINT }}>
          Tersimpan lokal di browser ini (maks. 20 terakhir) — bukan di server.
        </div>
      </aside>
    </div>
  );
}

// `config` shape:
//   { title, subtitle, HeaderIcon, blank: <seed form>,
//     newBlank: () => <form>, normalize: (loaded) => <form>,
//     isStarted: (f) => boolean }
// `renderForm` is called with { form, setForm, onGenerated } and must return
// the form element (the app-specific RfcForm / MopForm).
export default function AppShell({ config, renderForm }) {
  const { theme, toggle: toggleTheme } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState(() => config.normalize(loadDraft() || config.newBlank()));
  const [history, setHistory] = useState(() => loadHistory());
  const [drawer, setDrawer] = useState(false);
  const [llmOpen, setLlmOpen] = useState(false);

  // Autosave the in-progress form (debounced) — a refresh never loses work.
  const saveTimer = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveDraft(form), 400);
    return () => clearTimeout(saveTimer.current);
  }, [form]);

  const newForm = async () => {
    if (config.isStarted(form)) {
      const ok = await confirm({
        title: "Mulai form baru?",
        message: "Isian form saat ini akan diganti dengan form kosong. (Form yang sudah dibuat dokumennya tetap ada di Riwayat.)",
        confirmLabel: "Form baru",
        danger: true,
      });
      if (!ok) return;
    }
    setForm(config.newBlank());
    toast.info("Form baru siap diisi");
  };

  const restore = async (entry) => {
    if (config.isStarted(form) && JSON.stringify(form) !== JSON.stringify(entry.form)) {
      const ok = await confirm({
        title: "Buka form dari riwayat?",
        message: "Isian form saat ini akan diganti dengan isi dari riwayat.",
        confirmLabel: "Buka",
        danger: true,
      });
      if (!ok) return;
    }
    setForm(config.normalize({ ...config.blank, ...entry.form }));
    setDrawer(false);
    toast.success("Form dimuat dari riwayat — perbarui jadwal sebelum membuat dokumen baru.");
  };

  const onGenerated = ({ form: generated, kind, link, title }) => {
    setHistory(pushHistory({ form: generated, kind, link, title }));
  };

  const HeaderIcon = config.HeaderIcon || Server;

  return (
    <div style={{ background: SURFACE, color: INK, minHeight: 480, fontFamily: FONT_SANS }}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-1 pb-4 mb-3"
        style={{ borderBottom: BORDER }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="rounded-md flex items-center justify-center flex-shrink-0"
            style={{ width: 32, height: 32, background: ACCENT }}>
            <HeaderIcon size={17} color={ON_ACCENT} />
          </div>
          <div>
            <div style={{ fontSize: FS_2XL, fontWeight: FW_SEMIBOLD, lineHeight: 1.1, fontFamily: FONT_DISPLAY }}>{config.title}</div>
            <div style={{ fontSize: FS_SM, color: FAINT }}>{config.subtitle}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setDrawer(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-2"
            style={{ border: BORDER, color: MUTED, fontSize: FS_BASE, background: CARD }}>
            <History size={15} /> Riwayat
            {history.length > 0 && (
              <span className="rounded-full px-1.5"
                style={{ background: ACCENT, color: ON_ACCENT, fontSize: FS_XS, fontWeight: FW_SEMIBOLD }}>
                {history.length}
              </span>
            )}
          </button>
          <button onClick={newForm}
            className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2"
            style={{ background: ACCENT, color: ON_ACCENT, fontSize: FS_BASE, fontWeight: FW_MEDIUM }}>
            <Plus size={16} /> Form baru
          </button>
          <button onClick={() => setLlmOpen(true)} title="Pengaturan LLM"
            aria-label="Pengaturan LLM provider"
            className="inline-flex items-center justify-center rounded-md"
            style={{ width: 34, height: 34, border: BORDER, color: MUTED }}>
            <Cpu size={16} />
          </button>
          <button onClick={toggleTheme} title={theme === "dark" ? "Ganti ke terang" : "Ganti ke gelap"}
            aria-label="Ganti tema warna"
            className="inline-flex items-center justify-center rounded-md"
            style={{ width: 34, height: 34, border: BORDER, color: MUTED }}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      <main>
        {renderForm({ form, setForm, onGenerated })}
      </main>

      <HistoryDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        entries={history}
        onRestore={restore}
        onRemove={(id) => setHistory(removeHistory(id))}
      />

      <LlmSettings open={llmOpen} onClose={() => setLlmOpen(false)} />
    </div>
  );
}
