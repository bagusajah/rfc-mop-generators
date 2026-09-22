// RFC form-generator backend — stateless by design.
//
// The app helps fill the official "Form Permintaan Perubahan" and generate it
// as .docx / Google Doc; it does NOT track created forms. In-progress form
// state lives in the browser (localStorage); the only server-side state is the
// per-browser Google OAuth token file (packages/core/backend/tokens.js).
//
// Routes (registered by createDocApp + aiRoutes):
//   POST /api/draft, /api/review, /api/chat — LLM assistance (ai.js)
//   /api/llm/*                             — LLM provider dashboard
//   POST /api/document                     — render the .docx for download
//   POST /api/document/gdoc                — render + upload as a Google Doc
//   GET  /api/google/status|auth|callback  — per-user OAuth (scope drive.file)
// dotenv, not the node --env-file-if-exists flag (needs Node >= 20.12/21.7 —
// too new to assume on every host this runs on outside Docker).
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocApp, listen, sha1hex } from "../../../packages/core/backend/createDocApp.js";
import { upsertRfc } from "./vector-rfc.js";
import { exampleOf } from "./examples.js";
import { recordToTemplateData } from "./template-data.js";
import aiRoutes, { documentBlockers } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generating a document means the form is finished enough to submit — so feed
// it back into the vector corpus (best-effort, only when Qdrant is configured)
// and future drafts/reviews learn from it. The id is derived from the title so
// re-generating a revision overwrites its previous point instead of piling up.
function enrichCorpus(record) {
  const id = "gen-" + sha1hex(record.title || "untitled");
  upsertRfc({ ...record, id }, exampleOf(record));
}

const app = await createDocApp({
  templatePath: path.join(__dirname, "rfc_template.docx"),
  recordToTemplateData,
  cookieName: "rfc_sid",
  docFallback: "rfc",
  onGenerated: enrichCorpus,
  documentBlockers,
  aiRoutes,
});

await listen(app);
