// LLM provider configuration store — file-backed, like tokens.js.
//
// The dashboard (/api/llm/*) manages a small set of named providers and which
// one serves each task ("draft" | "review" | "chat") — review/chat can run on
// a faster model than draft without touching .env. Everything lives in one
// JSON file written atomically (tmp + rename); LLM_CONFIG_PATH points it at
// the Docker volume in compose, the dev fallback is ./llm-config.json next to
// server.js.
//
//   {
//     "providers": [ { id, name, baseUrl, apiKey, model, lastTest? } ],
//     "active":    { "draft": "<id>|env", "review": "<id>|env", "chat": "<id>|env" }
//   }
//
// The LLM_BASE_URL/LLM_API_KEY/LLM_MODEL env vars remain as a virtual,
// read-only provider (id "env") and the fallback when nothing is assigned —
// existing deployments keep working with zero migration.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CONFIG_PATH = process.env.LLM_CONFIG_PATH
  || (fs.existsSync("/data") ? "/data/llm-config.json" : "llm-config.json");

export const TASKS = ["draft", "review", "chat"];
export const ENV_ID = "env";

// Env-var provider (may be unconfigured — baseUrl/model empty).
export function envProvider() {
  return {
    id: ENV_ID,
    name: "Konfigurasi .env (server)",
    baseUrl: (process.env.LLM_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
    // Max in-flight LLM calls to this provider. 1 reproduces the old
    // single-slot behaviour (safe for local models that serve one request);
    // raise it for hosted providers that accept parallel requests.
    concurrency: Math.min(16, Math.max(1, Number(process.env.LLM_CONCURRENCY) || 1)),
  };
}

const envConfigured = () => Boolean(envProvider().baseUrl && envProvider().model);

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      active: raw.active && typeof raw.active === "object" ? raw.active : {},
    };
  } catch {
    return { providers: [], active: {} }; // missing/corrupt → env-only behavior
  }
}

function writeConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.mkdirSync(path.dirname(path.resolve(CONFIG_PATH)), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

export const listProviders = () => readConfig().providers;
export const getProvider = (id) =>
  id === ENV_ID ? envProvider() : readConfig().providers.find((p) => p.id === id) || null;

// Create or update. On update an empty apiKey keeps the stored key (the
// browser never sees keys, so edits legitimately arrive without one).
// `concurrency` (1–16) bounds how many LLM calls run in parallel against this
// provider; default 1 reproduces the old single-slot behaviour.
export function saveProvider({ id, name, baseUrl, apiKey, model, concurrency }) {
  const cfg = readConfig();
  const clean = {
    name: String(name || "").trim(),
    baseUrl: String(baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(model || "").trim(),
    concurrency: Math.min(16, Math.max(1, Number(concurrency) || 1)),
  };
  const existing = id ? cfg.providers.find((p) => p.id === id) : null;
  if (id && !existing) return null;
  if (existing) {
    Object.assign(existing, clean, { apiKey: apiKey ? String(apiKey) : existing.apiKey });
  } else {
    cfg.providers.push({ id: `p-${crypto.randomUUID().slice(0, 8)}`, ...clean, apiKey: String(apiKey || "") });
  }
  writeConfig(cfg);
  return existing || cfg.providers[cfg.providers.length - 1];
}

export function deleteProvider(id) {
  const cfg = readConfig();
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.providers.length === before) return false;
  for (const task of TASKS) if (cfg.active[task] === id) delete cfg.active[task];
  writeConfig(cfg);
  return true;
}

// active[task] = provider id, "env", or "" (= automatic fallback).
export function setActive(patch) {
  const cfg = readConfig();
  for (const task of TASKS) {
    if (!(task in patch)) continue;
    const v = patch[task];
    if (v) cfg.active[task] = v;
    else delete cfg.active[task];
  }
  writeConfig(cfg);
  return cfg.active;
}

export const getActive = () => readConfig().active;

// Record the latest connection-test result on a stored provider (dashboard
// shows it as a freshness chip). Env provider results are not persisted.
export function recordTest(id, result) {
  const cfg = readConfig();
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) return;
  p.lastTest = { ok: Boolean(result.ok), latencyMs: result.latencyMs ?? null, at: Date.now() };
  writeConfig(cfg);
}

// The provider that should serve `task` right now:
//   explicit assignment → that provider (deleted id falls through)
//   otherwise           → env vars when configured, else the first stored provider.
export function resolveProvider(task) {
  const { providers, active } = readConfig();
  const id = active[task];
  if (id === ENV_ID && envConfigured()) return envProvider();
  const assigned = providers.find((p) => p.id === id);
  if (assigned) return assigned;
  if (envConfigured()) return envProvider();
  return providers.find((p) => p.baseUrl && p.model) || null;
}
