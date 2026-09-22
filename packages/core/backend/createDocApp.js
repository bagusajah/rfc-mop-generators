// Generic Fastify server factory for a stateless doc-generator app (RFC, MOP, …).
//
// Each app supplies its domain bits and gets back a booted Fastify instance
// with the shared wiring already done: CORS, the LLM dashboard routes, the
// .docx render + download route, the Google OAuth + Drive export routes.
// App-specific AI routes (draft/review/chat) are registered by the caller.
//
// This keeps server.js per-app to ~20 lines: import createDocApp, pass the
// app's bits, listen. No Fastify/docxtemplater/OAuth plumbing duplicated.
import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs";
import crypto from "node:crypto";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { applyItalicMarkers } from "./italic-terms.js";
import { googleConfigured, authUrl, exchangeCode, uploadAsGoogleDoc } from "./google.js";
import { configureSession, sessionId, saveTok, loadTok, googleAccessToken } from "./tokens.js";
import llmAdminRoutes from "./llm-admin.js";

const GOOGLE_POST_AUTH = process.env.GOOGLE_POST_AUTH || "";

// Build the .docx render closure bound to a template path + a record→data
// projection. Reading the template lazily (first request) keeps startup fast
// and lets the file be hot-swapped without a restart.
function makeRenderer(templatePath, recordToTemplateData) {
  let cached = null;
  const load = () => {
    if (!cached) cached = fs.readFileSync(templatePath, "binary");
    return cached;
  };
  return (record) => {
    const zip = new PizZip(load());
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(recordToTemplateData(record));
    const outZip = doc.getZip();
    applyItalicMarkers(outZip);
    return outZip.generate({ type: "nodebuffer" });
  };
}

// Strip (a) filesystem-forbidden chars and (b) non-ASCII — Node rejects
// non-ASCII bytes in HTTP header values (ERR_INVALID_CHAR → 500), so titles
// like "...300GB → 500GB" must be reduced to printable ASCII for the
// Content-Disposition filename.
const docName = (r, fallback) => (r.title || fallback)
  .replace(/[\/\\:*?"<>|]+/g, " ")
  .replace(/[^\x20-\x7E]+/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, 120) || fallback;

// The frontend attaches this meta field to the generate request when it has
// an unresolved-block-finding count from the last Tinjau run (see
// summarizeReview in rfc-schema.js / mop-schema.js). It's request metadata,
// not a record field — doesn't reach recordToTemplateData or get stored.
const hasUnresolvedReviewBlockers = (body) => Number(body?.__reviewBlockCount) > 0;

/**
 * Build a stateless doc-generator Fastify app.
 *
 * @param {object} opts
 * @param {string} opts.templatePath     Absolute path to the .docx template.
 * @param {(r) => object} opts.recordToTemplateData  Map a record → docx placeholders.
 * @param {string} opts.cookieName       Session cookie name (per-app isolation).
 * @param {string} opts.docFallback      Filename fallback when record has no title.
 * @param {(record) => void} [opts.onGenerated] Best-effort hook (e.g. feed the
 *        record back into the vector corpus) called after a successful render —
 *        but SKIPPED when the record carries unresolved review blockers (see
 *        hasUnresolvedReviewBlockers below), so a flawed draft never teaches
 *        future drafts to repeat the same mistake via few-shot grounding.
 * @param {(record) => string[]} opts.documentBlockers  Completeness gate; returns
 *        blocker strings (empty = ready to render).
 * @param {import("fastify").FastifyPluginAsync} [opts.aiRoutes]  App AI routes
 *        (draft/review/chat). Registered before the doc/dashboard routes.
 */
export async function createDocApp({
  templatePath, recordToTemplateData, cookieName, docFallback = "document",
  onGenerated, documentBlockers, aiRoutes,
}) {
  configureSession({ cookieName });
  const renderDocx = makeRenderer(templatePath, recordToTemplateData);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  if (aiRoutes) await app.register(aiRoutes);
  await app.register(llmAdminRoutes);

  app.post("/api/document", (req, reply) => {
    const blockers = documentBlockers(req.body);
    if (blockers.length) {
      return reply.code(400).send({ error: "Dokumen belum lengkap untuk digenerate.", blockers });
    }
    const buf = renderDocx(req.body);
    if (onGenerated && !hasUnresolvedReviewBlockers(req.body)) onGenerated(req.body);
    reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("Content-Disposition", `attachment; filename="${docName(req.body, docFallback)}.docx"`)
      .send(buf);
  });

  app.get("/api/google/status", (req, reply) => {
    const sid = sessionId(req, reply);
    const tok = loadTok(sid);
    return { configured: googleConfigured(), connected: Boolean(tok && tok.refresh_token) };
  });

  app.get("/api/google/auth", (req, reply) => {
    if (!googleConfigured()) return reply.code(503).send({ error: "Google not configured." });
    const sid = sessionId(req, reply);
    return reply.redirect(authUrl(sid));
  });

  // Popup lands here; we store tokens then close the popup (opener polls /status).
  app.get("/api/google/callback", async (req, reply) => {
    const { code, state, error } = req.query;
    const sid = state || sessionId(req, reply);
    const close = (msg) => reply.type("text/html").send(
      `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px">${msg}` +
      `<script>setTimeout(()=>window.close(),800)</script></body>`);
    if (error || !code) return close("Login Google dibatalkan. Anda bisa menutup jendela ini.");
    try {
      const tok = await exchangeCode(code);
      const prev = loadTok(sid) || {};
      saveTok(sid, {
        refresh_token: tok.refresh_token || prev.refresh_token,
        access_token: tok.access_token,
        expiry: Date.now() + (tok.expires_in || 3600) * 1000,
      });
      if (GOOGLE_POST_AUTH) return reply.redirect(`${GOOGLE_POST_AUTH}?gdoc=connected`);
      return close("Terhubung ke Google. Jendela ini akan tertutup otomatis.");
    } catch (err) {
      app.log.error(err);
      return close("Gagal terhubung ke Google. Tutup jendela ini dan coba lagi.");
    }
  });

  app.post("/api/document/gdoc", async (req, reply) => {
    if (!googleConfigured()) {
      return reply.code(503).send({
        error: "Google not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (see .env.example).",
      });
    }
    const sid = sessionId(req, reply);
    let token;
    try { token = await googleAccessToken(sid); }
    catch (err) { app.log.error(err); token = null; }
    if (!token) return reply.code(401).send({ needAuth: true, authUrl: "/api/google/auth" });

    const blockers = documentBlockers(req.body);
    if (blockers.length) {
      return reply.code(400).send({ error: "Dokumen belum lengkap untuk digenerate.", blockers });
    }

    try {
      const buf = renderDocx(req.body);
      const file = await uploadAsGoogleDoc(token, docName(req.body, docFallback), buf);
      if (onGenerated && !hasUnresolvedReviewBlockers(req.body)) onGenerated(req.body);
      return { id: file.id, link: file.webViewLink, name: file.name };
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: `Google Doc creation failed: ${err.message}` });
    }
  });

  return app;
}

// Bind 0.0.0.0 by default so the server is reachable from other containers
// (e.g. nginx in docker compose). Override with HOST env for other setups.
export function listen(app) {
  const PORT = Number(process.env.PORT) || 3001;
  const HOST = process.env.HOST || "0.0.0.0";
  return app.listen({ port: PORT, host: HOST })
    .then(() => console.log(`backend on http://${HOST}:${PORT}`));
}

// Re-export the crypto hash helper apps use for corpus point ids (kept here so
// apps don't each re-import node:crypto for one call).
export const sha1hex = (s, len = 12) =>
  crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, len);
