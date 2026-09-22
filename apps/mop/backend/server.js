// MOP backend — stateless by design.
//
// The app helps write a "Method of Procedure" and generate it as .docx /
// Google Doc. Routes (registered by createDocApp + aiRoutes):
//   POST /api/draft, /api/review/section, /api/chat, /api/review/import — LLM
//   /api/llm/*                        — LLM provider dashboard
//   POST /api/document                — render the .docx for download
//   POST /api/document/gdoc           — render + upload as a Google Doc
//   GET  /api/google/status|auth|callback — per-user OAuth (scope drive.file)
// dotenv, not the node --env-file-if-exists flag (needs Node >= 20.12/21.7 —
// too new to assume on every host this runs on outside Docker).
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocApp, listen, sha1hex } from "../../../packages/core/backend/createDocApp.js";
import { upsertMop } from "./vector-mop.js";
import { exampleOf } from "./examples.js";
import { recordToTemplateData } from "./template-data.js";
import aiRoutes, { documentBlockers } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generating a document means the MOP is finished enough to submit — feed it
// back into the vector corpus (best-effort) so future drafts learn from it.
function enrichCorpus(record) {
  const id = "gen-" + sha1hex(record.title || "untitled");
  upsertMop({ ...record, id }, exampleOf(record));
}

const app = await createDocApp({
  templatePath: path.join(__dirname, "mop_template.docx"),
  recordToTemplateData,
  cookieName: "mop_sid",
  docFallback: "mop",
  onGenerated: enrichCorpus,
  documentBlockers,
  aiRoutes,
});

await listen(app);
