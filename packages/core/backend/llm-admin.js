// LLM provider dashboard endpoints (/api/llm/*).
//
// Manages the provider list in llm-config.js and which provider serves each
// task (draft/review). API keys are write-only: the browser sends them on
// create/update and gets back only `hasKey` + a 4-char hint — a stored key
// never leaves the server.
//
//   GET    /api/llm/config           — providers (masked) + active + effective
//   POST   /api/llm/providers        — add provider
//   PUT    /api/llm/providers/:id    — update (empty apiKey = keep stored)
//   DELETE /api/llm/providers/:id    — remove (clears its task assignments)
//   PUT    /api/llm/active           — assign task → provider id | "env" | ""
//   POST   /api/llm/test             — connection test (stored id and/or form values)

import Ajv from "ajv";
import { chatWith, dropSemaphore } from "./llm.js";
import {
  TASKS, ENV_ID, envProvider, listProviders, getProvider,
  saveProvider, deleteProvider, setActive, getActive, recordTest, resolveProvider,
} from "./llm-config.js";

const ajv = new Ajv({ coerceTypes: true, allErrors: true });

const PROVIDER_BODY = {
  type: "object",
  required: ["name", "baseUrl", "model"],
  properties: {
    name:        { type: "string", minLength: 1, maxLength: 80 },
    baseUrl:     { type: "string", minLength: 1, maxLength: 300, pattern: "^https?://" },
    model:       { type: "string", minLength: 1, maxLength: 120 },
    apiKey:      { type: "string", maxLength: 500 },
    concurrency: { type: "integer", minimum: 1, maximum: 16 },
  },
};
const ACTIVE_BODY = {
  type: "object",
  properties: Object.fromEntries(TASKS.map((t) => [t, { type: "string", maxLength: 60 }])),
};
const TEST_BODY = {
  type: "object",
  properties: {
    id:      { type: "string", maxLength: 60 },
    baseUrl: { type: "string", maxLength: 300 },
    model:   { type: "string", maxLength: 120 },
    apiKey:  { type: "string", maxLength: 500 },
  },
};
const validateProvider = ajv.compile(PROVIDER_BODY);
const validateActive   = ajv.compile(ACTIVE_BODY);
const validateTest     = ajv.compile(TEST_BODY);

function invalid(reply, validator, body) {
  if (validator(body)) return false;
  reply.code(400).send({ error: "Invalid request body", details: validator.errors });
  return true;
}

// What the browser is allowed to see of a provider — everything but the key.
const masked = (p) => ({
  id: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  model: p.model,
  hasKey: Boolean(p.apiKey),
  keyHint: p.apiKey ? `…${String(p.apiKey).slice(-4)}` : "",
  concurrency: p.concurrency || 1,
  lastTest: p.lastTest || null,
});

export default async function llmAdminRoutes(app) {
  app.get("/api/llm/config", () => {
    const env = envProvider();
    return {
      providers: listProviders().map(masked),
      env: { configured: Boolean(env.baseUrl && env.model), baseUrl: env.baseUrl, model: env.model, hasKey: Boolean(env.apiKey) },
      active: Object.fromEntries(TASKS.map((t) => [t, getActive()[t] || ""])),
      // What actually serves each task right now, after fallbacks.
      effective: Object.fromEntries(TASKS.map((t) => {
        const p = resolveProvider(t);
        return [t, p ? { id: p.id, name: p.name, model: p.model } : null];
      })),
    };
  });

  app.post("/api/llm/providers", (req, reply) => {
    if (invalid(reply, validateProvider, req.body || {})) return;
    return { provider: masked(saveProvider(req.body)) };
  });

  app.put("/api/llm/providers/:id", (req, reply) => {
    if (invalid(reply, validateProvider, req.body || {})) return;
    const p = saveProvider({ ...req.body, id: req.params.id });
    if (!p) return reply.code(404).send({ error: "Provider not found" });
    // Drop the cached semaphore so the next call picks up the (possibly new)
    // concurrency limit immediately — no backend restart needed. In-flight
    // calls keep their own release() closure and finish cleanly.
    dropSemaphore(req.params.id);
    return { provider: masked(p) };
  });

  app.delete("/api/llm/providers/:id", (req, reply) => {
    if (!deleteProvider(req.params.id)) return reply.code(404).send({ error: "Provider not found" });
    dropSemaphore(req.params.id);
    return { ok: true };
  });

  app.put("/api/llm/active", (req, reply) => {
    if (invalid(reply, validateActive, req.body || {})) return;
    for (const t of TASKS) {
      const id = req.body[t];
      if (id && !getProvider(id)) return reply.code(400).send({ error: `Unknown provider for ${t}: ${id}` });
    }
    return { active: setActive(req.body) };
  });

  // Connection test. {id} tests a stored provider with its stored key;
  // baseUrl/model/apiKey in the body override (so the edit form can test
  // unsaved values — a blank key while editing still uses the stored one).
  app.post("/api/llm/test", async (req, reply) => {
    if (invalid(reply, validateTest, req.body || {})) return;
    const { id, baseUrl, model, apiKey } = req.body || {};
    const stored = id ? getProvider(id) : null;
    if (id && !stored) return reply.code(404).send({ error: "Provider not found" });
    const target = {
      baseUrl: (baseUrl || stored?.baseUrl || "").trim(),
      model:   (model   || stored?.model   || "").trim(),
      apiKey:  apiKey || stored?.apiKey || "",
    };
    if (!target.baseUrl || !target.model) {
      return reply.code(400).send({ error: "baseUrl and model are required (directly or via id)" });
    }

    const t0 = Date.now();
    let result;
    try {
      const text = await chatWith(target, {
        system: "You are a connectivity check.",
        user: 'Balas hanya dengan kata: OK',
        temperature: 0,
        json: false,
        maxTokens: 20,
        signal: AbortSignal.timeout(60000),
      });
      result = { ok: true, latencyMs: Date.now() - t0, reply: text.slice(0, 80) };
    } catch (err) {
      result = { ok: false, latencyMs: Date.now() - t0, error: String(err.message || err).slice(0, 300) };
    }
    // Persist the outcome only for a pure stored-provider test — form values
    // may differ from what's saved, so their result would mislabel the card.
    if (stored && stored.id !== ENV_ID && !baseUrl && !model && !apiKey) recordTest(stored.id, result);
    return result;
  });
}
