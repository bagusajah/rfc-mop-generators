// LLM provider dashboard (drawer) — manage the providers behind the AI
// features and which one serves each task. Draf, Tinjauan, and Tanya AI can
// use different providers (e.g. a cheaper/faster model for review/chat). Keys
// are write-only: the server returns only a 4-char hint, never the key itself.
import React, { useEffect, useState } from "react";
import {
  Cpu, X, Plus, Pencil, Trash2, Zap, CheckCircle2, XCircle, Loader2,
} from "lucide-react";
import { apiUrl } from "./api.js";
import { useToast } from "./toast.jsx";
import { useConfirm } from "./confirm.jsx";
import { Field } from "./components.jsx";
import {
  INK, MUTED, FAINT, ACCENT, SURFACE, CARD, DANGER, BORDER, FONT_MONO,
  SUCCESS_BG, SUCCESS_FG, DANGER_BG, DANGER_FG, TAG_BG, TAG_FG,
  FS_XS, FS_SM, FS_MD, FS_BASE, FW_MEDIUM, FW_SEMIBOLD,
  inputCls, inputStyle,
} from "./tokens.js";

const TASKS = ["draft", "review", "chat"];
const TASK_LABEL = { draft: "Draf AI", review: "Tinjauan AI", chat: "Tanya AI" };

// Mirrors backend/.env.example — picking one fills the form, nothing more.
const PRESETS = [
  { name: "DeepSeek",         baseUrl: "https://api.deepseek.com/v1",                           model: "deepseek-chat" },
  { name: "Qwen (DashScope)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "GLM / Zhipu",      baseUrl: "https://open.bigmodel.cn/api/paas/v4",                  model: "glm-4-plus" },
  { name: "Anthropic",        baseUrl: "https://api.anthropic.com/v1",                          model: "claude-opus-4-8" },
  { name: "OpenAI",           baseUrl: "https://api.openai.com/v1",                             model: "gpt-4o" },
  { name: "Ollama (lokal)",   baseUrl: "http://localhost:11434/v1",                             model: "qwen2.5:14b" },
  { name: "LM Studio (lokal)", baseUrl: "http://localhost:1234/v1",                             model: "" },
];

async function call(path, { method = "GET", body } = {}) {
  // Content-Type only when there is a body — Fastify 400s an empty JSON body.
  const res = await fetch(apiUrl(path), {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtLatency = (ms) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function TestChip({ t }) {
  if (!t) return null;
  const ok = t.ok;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
      style={{ background: ok ? SUCCESS_BG : DANGER_BG, color: ok ? SUCCESS_FG : DANGER_FG, fontSize: FS_XS, fontWeight: FW_MEDIUM }}>
      {ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
      {ok ? `Terhubung · ${fmtLatency(t.latencyMs)}` : "Gagal terhubung"}
    </span>
  );
}

function TaskBadges({ tasks }) {
  return tasks.map((t) => (
    <span key={t} className="rounded-full px-2 py-0.5"
      style={{ background: TAG_BG, color: TAG_FG, fontSize: FS_XS, fontWeight: FW_SEMIBOLD }}>
      {TASK_LABEL[t]}
    </span>
  ));
}

/* ── Add / edit form ── */

function ProviderForm({ initial, onDone, onCancel }) {
  const toast = useToast();
  const editing = Boolean(initial?.id);
  const [f, setF] = useState({
    name: initial?.name || "", baseUrl: initial?.baseUrl || "",
    model: initial?.model || "", apiKey: "",
    concurrency: String(initial?.concurrency ?? 1),
  });
  const [busy, setBusy] = useState("");      // "" | "test" | "save"
  const [testResult, setTestResult] = useState(null);

  const set = (k) => (e) => { setF((p) => ({ ...p, [k]: e.target.value })); setTestResult(null); };
  const applyPreset = (i) => {
    if (i === "") return;
    const p = PRESETS[Number(i)];
    setF((prev) => ({ ...prev, name: prev.name || p.name, baseUrl: p.baseUrl, model: p.model }));
    setTestResult(null);
  };
  const canSave = f.name.trim() && /^https?:\/\//.test(f.baseUrl.trim()) && f.model.trim();

  // Test the form's values as-is; when editing with a blank key the server
  // falls back to the stored key (keys are never echoed into this form).
  const test = async () => {
    setBusy("test"); setTestResult(null);
    try {
      const body = { baseUrl: f.baseUrl.trim(), model: f.model.trim() };
      if (f.apiKey) body.apiKey = f.apiKey;
      if (editing) body.id = initial.id;
      setTestResult(await call("/api/llm/test", { method: "POST", body }));
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally { setBusy(""); }
  };

  const save = async () => {
    setBusy("save");
    try {
      const body = {
        name: f.name.trim(), baseUrl: f.baseUrl.trim(), model: f.model.trim(),
        concurrency: Math.min(16, Math.max(1, Number(f.concurrency) || 1)),
      };
      if (f.apiKey) body.apiKey = f.apiKey;
      if (editing) await call(`/api/llm/providers/${initial.id}`, { method: "PUT", body });
      else await call("/api/llm/providers", { method: "POST", body });
      toast.success(editing ? "Provider diperbarui." : "Provider ditambahkan.");
      onDone();
    } catch (err) {
      toast.error(`Gagal menyimpan provider: ${err.message}`);
    } finally { setBusy(""); }
  };

  return (
    <div className="rounded-lg p-3 flex flex-col gap-3" style={{ border: `1px solid ${ACCENT}`, background: CARD }}>
      <div style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>
        {editing ? `Ubah provider — ${initial.name}` : "Tambah provider"}
      </div>
      {!editing && (
        <Field label="Preset" hint="Mengisi Base URL & model sesuai penyedia — API key tetap diisi sendiri.">
          <select className={inputCls} style={{ ...inputStyle, fontSize: FS_MD }} defaultValue=""
            onChange={(e) => applyPreset(e.target.value)}>
            <option value="">Pilih penyedia…</option>
            {PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Nama" required>
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD }}
          value={f.name} onChange={set("name")} placeholder='mis. "DeepSeek produksi"' />
      </Field>
      <Field label="Base URL" required
        hint="Endpoint OpenAI-compatible, tanpa /chat/completions. Backend di Docker mengakses host lokal (Ollama/LM Studio) lewat http://host.docker.internal:<port>/v1.">
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD, fontFamily: FONT_MONO }}
          value={f.baseUrl} onChange={set("baseUrl")} placeholder="https://api.deepseek.com/v1" />
      </Field>
      <Field label="Model" required>
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD, fontFamily: FONT_MONO }}
          value={f.model} onChange={set("model")} placeholder="deepseek-chat" />
      </Field>
      <Field label="Konkurensi"
        hint="Berapa permintaan LLM boleh berjalan bersamaan ke provider ini. 1 = satu per satu (default; aman untuk model lokal). Tingkatkan bila provider mendukung banyak permintaan paralel — review per-bagian jadi lebih cepat.">
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD }}
          type="number" min={1} max={16} step={1}
          value={f.concurrency} onChange={set("concurrency")} />
      </Field>
      <Field label="API Key" hint={editing
        ? "Kosongkan untuk tetap memakai key tersimpan."
        : "Disimpan di server; tidak pernah dikirim balik ke browser."}>
        <input className={inputCls} style={{ ...inputStyle, fontSize: FS_MD, fontFamily: FONT_MONO }}
          type="password" autoComplete="off"
          value={f.apiKey} onChange={set("apiKey")}
          placeholder={editing && initial.hasKey ? `(tidak diubah — ${initial.keyHint})` : "sk-…"} />
      </Field>
      {testResult && (
        <div className="rounded-md px-3 py-2" style={{
          background: testResult.ok ? SUCCESS_BG : DANGER_BG,
          color: testResult.ok ? SUCCESS_FG : DANGER_FG, fontSize: FS_SM,
        }}>
          {testResult.ok
            ? `Terhubung (${fmtLatency(testResult.latencyMs)}) — balasan: "${testResult.reply}"`
            : `Gagal: ${testResult.error}`}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={test} disabled={!canSave || busy}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5"
          style={{ border: BORDER, color: MUTED, background: CARD, fontSize: FS_SM, fontWeight: FW_MEDIUM, opacity: !canSave || busy ? 0.6 : 1 }}>
          {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Tes koneksi
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} disabled={busy === "save"}
            className="rounded-md px-3 py-1.5"
            style={{ border: BORDER, color: MUTED, background: CARD, fontSize: FS_SM }}>
            Batal
          </button>
          <button onClick={save} disabled={!canSave || busy}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5"
            style={{ background: ACCENT, color: "var(--on-accent)", fontSize: FS_SM, fontWeight: FW_MEDIUM, opacity: !canSave || busy ? 0.6 : 1 }}>
            {busy === "save" && <Loader2 size={13} className="animate-spin" />} Simpan
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Provider card ── */

function ProviderCard({ p, tasks, readonly, note, onTest, testing, onEdit, onDelete }) {
  return (
    <div className="rounded-lg p-3 flex flex-col gap-1.5" style={{ border: BORDER, background: CARD }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>{p.name}</span>
        <TaskBadges tasks={tasks} />
        <TestChip t={p.lastTest} />
        {!readonly && (
          <div className="ml-auto flex items-center gap-1">
            <button onClick={onTest} title="Tes koneksi" aria-label={`Tes koneksi ${p.name}`} className="icon-btn-sm" disabled={testing}>
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            </button>
            <button onClick={onEdit} title="Ubah" aria-label={`Ubah ${p.name}`} className="icon-btn-sm">
              <Pencil size={14} />
            </button>
            <button onClick={onDelete} title="Hapus" aria-label={`Hapus ${p.name}`} className="icon-btn-sm" style={{ color: DANGER }}>
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: FS_SM, color: MUTED }}>
        <span style={{ fontFamily: FONT_MONO }}>{p.model}</span>
        {Number(p.concurrency) > 1 && (
          <span className="rounded-full px-1.5 py-0.5"
            style={{ background: TAG_BG, color: TAG_FG, fontSize: FS_XS, fontWeight: FW_SEMIBOLD }}
            title={`Hingga ${p.concurrency} permintaan paralel ke provider ini`}>
            ×{p.concurrency}
          </span>
        )}
      </div>
      <div style={{ fontSize: FS_XS, color: FAINT, fontFamily: FONT_MONO, wordBreak: "break-all" }}>
        {p.baseUrl}{p.hasKey ? `  ·  key ${p.keyHint}` : "  ·  tanpa key"}
      </div>
      {note && <div style={{ fontSize: FS_XS, color: FAINT }}>{note}</div>}
    </div>
  );
}

/* ── Drawer ── */

export default function LlmSettings({ open, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [cfg, setCfg] = useState(null);        // GET /api/llm/config payload
  const [form, setForm] = useState(null);      // null | {} (add) | provider (edit)
  const [testingId, setTestingId] = useState("");

  const refresh = async () => {
    try { setCfg(await call("/api/llm/config")); }
    catch (err) { toast.error(`Gagal memuat konfigurasi LLM: ${err.message}`); }
  };
  useEffect(() => { if (open) { setForm(null); refresh(); } }, [open]);

  if (!open) return null;

  const providers = cfg?.providers || [];
  const env = cfg?.env || { configured: false };
  // Badge = the provider that actually serves the task (after fallback).
  const tasksOf = (id) => TASKS.filter((t) => cfg?.effective?.[t]?.id === id);

  const setTask = async (task, id) => {
    try {
      await call("/api/llm/active", { method: "PUT", body: { [task]: id } });
      await refresh();
      toast.success(`${TASK_LABEL[task]} diperbarui.`);
    } catch (err) { toast.error(`Gagal mengatur model aktif: ${err.message}`); }
  };

  const testProvider = async (p) => {
    setTestingId(p.id);
    try {
      const r = await call("/api/llm/test", { method: "POST", body: { id: p.id } });
      if (r.ok) toast.success(`${p.name} terhubung (${fmtLatency(r.latencyMs)}).`);
      else toast.error(`${p.name} gagal: ${r.error}`);
    } catch (err) { toast.error(`Tes gagal: ${err.message}`); }
    finally { setTestingId(""); await refresh(); }
  };

  const removeProvider = async (p) => {
    const ok = await confirm({
      title: `Hapus provider "${p.name}"?`,
      message: "API key yang tersimpan ikut terhapus. Tugas yang memakai provider ini kembali ke fallback.",
      confirmLabel: "Hapus", danger: true,
    });
    if (!ok) return;
    try { await call(`/api/llm/providers/${p.id}`, { method: "DELETE" }); await refresh(); toast.info("Provider dihapus."); }
    catch (err) { toast.error(`Gagal menghapus: ${err.message}`); }
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Pengaturan LLM">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 flex flex-col"
        style={{ width: "min(540px, 94vw)", background: SURFACE, borderLeft: BORDER, boxShadow: "-8px 0 24px rgba(0,0,0,0.12)" }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: BORDER }}>
          <div className="flex items-center gap-2" style={{ fontSize: FS_BASE, fontWeight: FW_SEMIBOLD, color: INK }}>
            <Cpu size={16} style={{ color: ACCENT }} /> Pengaturan LLM
          </div>
          <button onClick={onClose} className="icon-btn" title="Tutup" aria-label="Tutup pengaturan LLM">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {!cfg && <div style={{ color: FAINT, fontSize: FS_MD }}>Memuat…</div>}

          {cfg && (
            <>
              {/* Task → provider assignment */}
              <section className="flex flex-col gap-3">
                <div style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>Model aktif per tugas</div>
                {TASKS.map((t) => {
                  const eff = cfg.effective?.[t];
                  return (
                    <Field key={t} label={TASK_LABEL[t]}
                      hint={eff ? `Aktif: ${eff.name} · ${eff.model}` : "Belum ada provider yang bisa dipakai."}>
                      <select className={inputCls} style={{ ...inputStyle, fontSize: FS_MD }}
                        value={cfg.active?.[t] || ""} onChange={(e) => setTask(t, e.target.value)}>
                        <option value="">Otomatis (fallback)</option>
                        {env.configured && <option value="env">Konfigurasi .env (server)</option>}
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} — {p.model}</option>
                        ))}
                      </select>
                    </Field>
                  );
                })}
                <div style={{ fontSize: FS_XS, color: FAINT }}>
                  Draf, Tinjauan, dan Tanya AI boleh memakai provider berbeda — mis. model cepat untuk
                  tinjauan/tanya agar tidak menunggu lama, model kuat untuk draf.
                </div>
              </section>

              {/* Provider list */}
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div style={{ fontSize: FS_MD, fontWeight: FW_SEMIBOLD, color: INK }}>Provider</div>
                  {!form && (
                    <button onClick={() => setForm({})}
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5"
                      style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: CARD, fontSize: FS_SM, fontWeight: FW_MEDIUM }}>
                      <Plus size={13} /> Tambah provider
                    </button>
                  )}
                </div>

                {form && (
                  <ProviderForm initial={form.id ? form : null}
                    onDone={async () => { setForm(null); await refresh(); }}
                    onCancel={() => setForm(null)} />
                )}

                {providers.length === 0 && !env.configured && !form && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center" style={{ color: FAINT, fontSize: FS_MD }}>
                    <Cpu size={20} />
                    Belum ada provider LLM.
                    <span style={{ fontSize: FS_SM }}>
                      Tambahkan provider untuk mengaktifkan Draf AI, Tinjauan AI, dan Tanya AI.
                    </span>
                  </div>
                )}

                {providers.map((p) => (
                  <ProviderCard key={p.id} p={p} tasks={tasksOf(p.id)}
                    testing={testingId === p.id}
                    onTest={() => testProvider(p)}
                    onEdit={() => setForm(p)}
                    onDelete={() => removeProvider(p)} />
                ))}

                {env.configured && (
                  <ProviderCard readonly tasks={tasksOf("env")}
                    p={{ name: "Konfigurasi .env (server)", model: env.model, baseUrl: env.baseUrl, hasKey: env.hasKey, keyHint: "" }}
                    note="Dikelola lewat backend/.env — hanya-baca di sini; dipakai sebagai fallback." />
                )}
              </section>
            </>
          )}
        </div>

        <div className="px-4 py-2.5" style={{ borderTop: BORDER, fontSize: FS_XS, color: FAINT }}>
          API key tersimpan di server (volume <span style={{ fontFamily: FONT_MONO }}>rfc-data</span>) dan
          tidak pernah dikirim kembali ke browser. Perubahan langsung berlaku tanpa restart.
        </div>
      </aside>
    </div>
  );
}
