// Provider-agnostic LLM client.
// Speaks the OpenAI-compatible Chat Completions shape (POST /chat/completions),
// so it works with DeepSeek, Qwen, GLM/Zhipu, Ollama, OpenAI, and Anthropic's
// OpenAI-compatible endpoint.
//
// Which provider serves a call is resolved per request (llm-config.js): the
// dashboard assigns a stored provider per task ("draft" | "review" | "chat"), and the
// LLM_BASE_URL / LLM_API_KEY / LLM_MODEL env vars remain the fallback — so
// dashboard changes apply immediately, no restart, and env-only setups keep
// working unchanged. See .env.example for per-provider settings.

import { resolveProvider } from "./llm-config.js";

export const llmConfigured = (task = "draft") => Boolean(resolveProvider(task));

/**
 * Call the chat-completions endpoint and return the assistant message text.
 * `task` picks the provider assigned in the dashboard ("draft" | "review" | "chat").
 * `json: true` asks the provider for a JSON object response where supported;
 * callers must still parse defensively (not every provider honours it).
 */
export async function chat({ system, user, temperature = 0.4, json = true, signal, maxTokens, meta, task = "draft" }) {
  const provider = resolveProvider(task);
  if (!provider) {
    throw new Error("LLM not configured — add a provider in the dashboard (Pengaturan LLM) or set LLM_BASE_URL and LLM_MODEL (see .env.example)");
  }
  return chatWith(provider, { system, user, temperature, json, signal, maxTokens, meta });
}

/**
 * Same as chat() but against an explicit provider {baseUrl, apiKey, model,
 * concurrency} — used by the dashboard's connection test (and internally by
 * chat()).
 *
 * Concurrency is bounded PER PROVIDER by a counting semaphore: each provider
 * id gets its own pool of `limit` slots, so a slow local model (LM Studio,
 * single slot) never blocks calls to a fast hosted one, and a hosted provider
 * can serve several review sections at once without overwhelming a local
 * fallback. `concurrency` comes from the provider object (llm-config.js,
 * default 1 — reproduces the old single-slot behaviour). A failed call's
 * finally block always releases its slot, so an error can never wedge a pool.
 */

// Classic counting semaphore: at most `limit` holders at once; further
// acquire()s queue FIFO and resume in arrival order as slots release.
function makeSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < limit) { active++; return Promise.resolve(); }
      return new Promise((resolve) => waiters.push(() => { active++; resolve(); }));
    },
    release() {
      active--;
      const next = waiters.shift();
      if (next) next();   // hand the slot straight to the next waiter (active++
                          // already counted for it, so the pool stays bounded).
    },
  };
}

// One semaphore per provider id. Memoized on first sight; the limit is
// captured then, so a dashboard edit to `concurrency` calls dropSemaphore(id)
// (see llm-admin.js) to let the next call recreate it with the new limit.
const semaphores = new Map();
function semaphoreFor(provider) {
  const key = provider?.id;
  let sem = key && semaphores.get(key);
  if (!sem) {
    const limit = Math.max(1, Number(provider?.concurrency) || 1);
    sem = makeSemaphore(limit);
    if (key) semaphores.set(key, sem);
  }
  return sem;
}

// Drop a provider's cached semaphore so the next chatWith() recreates it with
// the current stored limit. Called after a dashboard edit to concurrency.
// In-flight calls keep their own release() closure, so they finish cleanly.
export function dropSemaphore(providerId) {
  if (providerId) semaphores.delete(providerId);
}

export async function chatWith(provider, opts) {
  const sem = semaphoreFor(provider);
  await sem.acquire();
  try {
    return await chatWithNow(provider, opts);
  } finally {
    sem.release();
  }
}

async function chatWithNow(provider, { system, user, temperature = 0.4, json = true, signal, maxTokens, meta = false }) {
  const base = {
    model: provider.model,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
  };

  // First attempt honours json (response_format). Providers that don't
  // support response_format:json_object fail in two ways: return 200 + empty
  // content (some cloud providers), or reject the request outright (LM
  // Studio: 400 "'response_format.type' must be 'json_schema' or 'text'").
  // Either way, retry once without it — extractJson tolerates fences/prose.
  let out;
  if (!json) {
    out = await callOnce(provider, base, signal);
  } else {
    try {
      out = await callOnce(provider, { ...base, response_format: { type: "json_object" } }, signal);
    } catch (err) {
      if (!/response_format|json_object|json_schema/i.test(String(err.message))) throw err;
      out = { content: "" };
    }
    if (!out.content) out = await callOnce(provider, base, signal);
  }

  if (!out.content) {
    const msg = out.raw?.choices?.[0]?.message || {};
    throw new Error(
      `LLM returned empty content (finish_reason=${out.finish ?? "?"}, ` +
      `message keys=[${Object.keys(msg).join(",") || "none"}]). ` +
      `Raw: ${JSON.stringify(out.raw).slice(0, 400)}`,
    );
  }
  // meta callers also get finish_reason — reasoning models that exhaust the
  // token budget mid-answer ("length") need to be told apart from a clean stop.
  return meta ? { content: out.content, finish: out.finish } : out.content;
}

// One request to /chat/completions. Returns { content, finish, raw }. Surfaces
// 200-with-error bodies and falls back to reasoning_content (reasoning models).
async function callOnce(provider, body, signal) {
  const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // Some providers report failures in a 200 body instead of an HTTP error.
  if (data.error) {
    throw new Error(`LLM error: ${JSON.stringify(data.error).slice(0, 400)}`);
  }
  const choice = data.choices?.[0];
  const m = choice?.message || {};
  const content = String(m.content || m.reasoning_content || "").trim();
  return { content, finish: choice?.finish_reason, raw: data };
}

// Walk a JSON fragment tracking string/escape state and the open {[ scopes.
// Returns where the top-level object closes (-1 when the text is truncated)
// plus the state needed to synthesize the missing closers.
function scanJson(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (!stack.length) return { end: i, stack, inStr };
    }
  }
  return { end: -1, stack, inStr };
}

const closersFor = ({ stack, inStr }) =>
  (inStr ? '"' : "") + [...stack].reverse().map((c) => (c === "{" ? "}" : "]")).join("");

// Repair-only transforms — never applied before a straight parse has failed,
// since they could in principle touch content inside string values.
const stripTrailingCommas = (s) => s.replace(/,\s*([}\]])/g, "$1");
const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

/** Extract a JSON object from a model response. Tolerates ```json fences,
 * surrounding prose (string-aware — a `}` inside prose or a value can't end
 * the object early), trailing commas, and truncated output (finish_reason=
 * length): open scopes are closed and, failing that, the dangling fragment is
 * dropped so the complete findings still parse. */
export function extractJson(text) {
  if (!text) throw new Error("empty LLM response");
  // Strip code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("no JSON object in LLM response");

  const scan = scanJson(candidate.slice(start));
  if (scan.end !== -1) {
    const body = candidate.slice(start, start + scan.end + 1);
    const parsed = tryParse(body) ?? tryParse(stripTrailingCommas(body));
    if (parsed !== undefined) return parsed;
    throw new Error("malformed JSON in LLM response");
  }

  // Truncated output. Attempts, cheapest first:
  //  1. close the open string/scopes as-is (mid-string cuts);
  //  2. also drop a dangling `,`/`:`/partial token first (mid-token cuts);
  //  3. cut back to the last complete nested value and close from there.
  const base = candidate.slice(start).trimEnd();
  const cut = Math.max(base.lastIndexOf("}"), base.lastIndexOf("]"));
  for (const b of [
    base,
    base.replace(/[,:]\s*("(?:[^"\\]|\\.)*)?$/, ""),
    cut > 0 ? base.slice(0, cut + 1) : "",
  ]) {
    if (!b || b[0] !== "{") continue;
    const parsed = tryParse(stripTrailingCommas(b + closersFor(scanJson(b))));
    if (parsed !== undefined) return parsed;
  }
  throw new Error("truncated JSON in LLM response could not be repaired");
}
