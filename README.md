# RFC & MOP Generators

Two SRE tools in one repo, sharing a domain-neutral **core**:

- **RFC** — fill the official **Form Permintaan Perubahan** (Request for Change)
  once, in a web form — no more copying the Word template by hand — then generate
  the deliverable as a **.docx download** or a **Google Doc**.
- **MOP** — write a **Method of Procedure** (an execution runbook an engineer
  follows step-by-step during a maintenance window), with the same AI-assist +
  pre-review + doc generation. MOP steps carry the exact command, expected
  output, and evidence capture so the runbook is executable verbatim.

Both are **stateless** (no database, no record tracking) and share the same
infrastructure: a multi-provider LLM dashboard, Google Docs export, optional
Qdrant-backed semantic grounding, and a schema-driven form engine. Each app is a
thin layer over the core supplying its own schema, prompts, and Word template.

| App | What it produces | Port (compose) |
|---|---|---|
| RFC | Form Permintaan Perubahan (.docx / Google Doc) | `:8080` |
| MOP | Method of Procedure (.docx / Google Doc) | `:8081` |

The point of both tools is passing IT Governance & Security review **on the
first submit**. That team reviews submissions with an LLM and returns forms for
missing information or typos, so each app puts the same kind of reviewer in the
loop *before* submission:

- **AI draft** — describe the change/procedure in one sentence; the LLM fills
  the prose, risk register, mitigation, security requirements, tasklist/steps,
  and rollback/verification in formal Bahasa Indonesia, imitating real approved
  documents (semantic search over the historical corpus). Every LLM-facing
  prompt (draft, review, chat, feedback import) shares one language rule
  (`LANG_RULE` in each app's `review-sections.js`): respond in Bahasa Indonesia,
  but keep standard technical/governance/security jargon (rollback, downtime,
  security group, etc.) in English rather than forcing an awkward translation.
- **AI pre-review** — simulates the Governance & Security gate **per form
  section** (deskripsi, dampak, jadwal, risiko, tasklist & rollback, security
  requirement, bahasa/typo): one focused LLM call per section, fired
  concurrently and bounded by the assigned provider's **Konkurensi** setting
  (see the LLM provider dashboard below; defaults to 1, which serialises
  section calls the same way a single-slot local model needs), so findings
  stream into the panel section by section and can be applied while later
  sections are still running. Deterministic rule checks (the 8-point
  governance checklist, single-sourced in `apps/rfc/rfc-schema.js`) back every
  section — guaranteed findings when the model misses, and the whole result
  when the LLM is unreachable. Findings are advisory (never block generation)
  and, where possible, carry a **one-click fix** ("Terapkan") that patches the
  form field directly.
- **No tracking** — the app is stateless by design. No database, no record
  list, no statuses. The in-progress form autosaves in the browser
  (localStorage); every generated document is kept in a local **Riwayat**
  (last 20) so a returned form can be revised without retyping; form JSON can
  be exported/imported as files.
- **LLM provider dashboard** — ⚙ *Pengaturan LLM* in the header manages any
  number of OpenAI-compatible providers (DeepSeek, Qwen, GLM, Anthropic,
  OpenAI, local Ollama) with connection tests, and assigns a provider **per
  task**: draft and review can run on different models (e.g. a fast model for
  review, a strong one for drafting). Each provider also has a **Konkurensi**
  setting (1–16): how many LLM calls may run against it at once. The default
  of 1 keeps local single-slot models (LM Studio) safe; raising it lets the
  per-section review fan out several sections in parallel on a capable hosted
  provider. Providers are isolated, so a slow local model never queues behind
  a fast hosted one. Changes apply immediately, no restart; the `LLM_*` env
  vars remain as a fallback provider.
- **Chat Q&A** — a floating chat panel lets the user ask questions while
  filling the form (e.g. "is security requirement mandatory?", "what counts
  as a Major change?"). Grounded in the same historical-RFC corpus as
  draft/review, plus the Company IT Policy corpus below, plus the live
  in-progress draft.
- **Company IT Policy grounding** — draft, review, and chat all retrieve
  relevant excerpts from the Company IT Policy PDF (semantic search, its own
  Qdrant collection) so answers/rubrics cite the actual policy text instead
  of a hardcoded/transcribed clause.

## Architecture

```
apps/rfc/                  The RFC app — schema, prompts, form, Word template
  frontend/                Vite + React SPA (Bahasa Indonesia UI): RfcForm, form-data, schema
  backend/                 Fastify — LLM draft/review, docx render, Google Docs
  rfc-schema.js            Single source of truth for the RFC form model
apps/mop/                  The MOP app (mirrors rfc/'s layout)
  frontend/                MopForm, form-data, mop-form-schema, mop-widgets
  backend/                 MOP AI routes + template-data + examples + vector-mop
  mop-schema.js            Single source of truth for the MOP form model
packages/core/             Domain-neutral core shared across apps
  backend/                 createDocApp factory, LLM client, vector store, OAuth, docx render
  frontend/                AppShell, FormEngine + FieldRenderer, UI primitives, LlmSettings, theming
tools/                     Python: template tagging (RFC) + PDF/tracker import pipeline (RFC)
RFC/                       local-only (git-ignored), currently empty: drop RFC source PDFs,
                            tracker, corpus JSONs here to (re-)populate grounding
policy/                    local-only (git-ignored): Company IT Policy source PDFs + parsed text
```

**Shared vs. per-app.** The core (LLM client, vector store, OAuth+Drive, docx
render, Fastify factory, UI shell, schema-driven form engine) lives in
`packages/core/` and is consumed unchanged by both apps. Each app supplies:
its **schema** (`*-schema.js`: enums, ajv record schema, govCheck, review
sections), **prompts** (backend `review-sections.js` rubrics + `ai.js`
DRAFT/CHAT/IMPORT system prompts), **form-data** (reference lists, BLANK
shape, column defs), the declarative **form schema** for the engine, custom
**widgets** (the security grid, sign-off pair), and a **Word template**. Adding
a third doc-generator app is mostly a new `apps/<name>/` directory + schema.

- **The backend is stateless**: the only persisted state is two small JSON
  files on the `rfc-data` / `mop-data` volumes — per-browser Google OAuth
  tokens (`TOKENS_PATH`) and the LLM provider config incl. API keys
  (`LLM_CONFIG_PATH`). Everything else is computed per request.
- **Documents** are rendered by docxtemplater from each app's
  `<app>_template.docx` (the official template with placeholder tags injected
  by `tools/apply_template.py`); `<app>/backend/template-data.js` maps form
  fields to template tags. **MOP's template is a placeholder copy of RFC's
  for now** — see "MOP specifics" below.
- **Form UI is schema-driven**: each app declares its sections+fields in a
  `*-form-schema.js`; the shared `FormEngine` (`packages/core/frontend`)
  renders them via `FieldRenderer` (text/textarea/date/time/select/radio/
  taginput/rowtable/group/custom). App-specific bespoke widgets (RFC's security
  grid, MOP's step table columns) register as `custom` widgets.
- **Grounding corpus**: `apps/<app>/backend/fixtures/*.json` (committed) plus
  a local-only corpus dir. With Qdrant + Ollama running, examples are picked by
  semantic similarity; without them the file corpus is re-ranked by
  change-type/system (RFC) or system (MOP) match. Generated documents are
  embedded back into Qdrant (best-effort) so future drafts learn from them.
  Both are currently **empty** in this repo (the real historical RFCs and
  Qdrant collections were cleared) — draft/review run fine without them, just
  without similar-example grounding, until re-populated via the import
  pipeline below.
- **Company IT Policy corpus**: `policy/pdfs/*.pdf` (local-only) chunked +
  embedded into a separate Qdrant collection (`it_policy`, see
  `packages/core/backend/policy.js`) — shared by both apps.
  `searchPolicy()` feeds relevant excerpts into each app's `/api/draft`,
  `/api/review/section`, and `/api/chat`. Optional: all three endpoints work
  fine (just without policy grounding) when this collection is empty.

## Run (docker compose)

Both apps come up together; qdrant + ollama are shared.

```bash
cp apps/rfc/backend/.env.example apps/rfc/backend/.env   # set LLM_*, GOOGLE_*
cp apps/mop/backend/.env.example apps/mop/backend/.env   # (optional) same for MOP
docker compose build
docker compose up -d
open http://localhost:8080   # RFC
open http://localhost:8081   # MOP
```

One-time vector-store setup (optional but recommended):

```bash
docker compose exec ollama ollama pull bge-m3
cd apps/rfc/backend && QDRANT_URL=http://localhost:6333 EMBED_BASE_URL=http://localhost:11434/v1 \
  EMBED_API_KEY=ollama EMBED_MODEL=bge-m3 npm run seed
```

The old `rfc-data` volume from the tracker era may still contain `rfc.db`;
it is unused now and the volume can be pruned if you want (Google tokens and
the LLM provider config are the only things on it).

## Run (dev)

```bash
npm install                          # at repo root — installs all workspaces
cd apps/rfc/backend && npm run dev   # RFC Fastify on :3001
cd apps/rfc/frontend && npm run dev  # RFC Vite on :5173
cd apps/mop/backend && PORT=3002 npm run dev   # MOP Fastify on :3002
cd apps/mop/frontend && npm run dev            # MOP Vite on :5173 (proxy → :3001; set VITE_DEV_PROXY_TARGET=http://localhost:3002 for MOP's backend)
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/draft` | One-line intent → full draft (JSON), grounded in similar RFCs + IT policy excerpts |
| POST | `/api/review/section?section=<id>` | Form JSON → one section's `{section, llm, findings[], examplesUsed, policyUsed}` (ids in `apps/rfc/rfc-schema.js` `REVIEW_SECTIONS`) |
| POST | `/api/review/import` | Form JSON + pasted/uploaded Governance feedback → findings against the current record (same contract as `/api/review/section`) |
| POST | `/api/chat` | `{question, record, history}` → `{answer, examplesUsed, policyUsed}` — free-form Q&A grounded in the corpus, the live draft, and IT policy excerpts |
| POST | `/api/document` | Form JSON → .docx (attachment) |
| POST | `/api/document/gdoc` | Form JSON → native Google Doc (per-user OAuth, scope `drive.file`) |
| GET | `/api/google/status\|auth\|callback` | OAuth flow (per-browser `rfc_sid` cookie) |
| GET | `/api/llm/config` | List providers (masked keys), env fallback, active provider per task, effective provider per task |
| POST | `/api/llm/providers` | Add an LLM provider |
| PUT | `/api/llm/providers/:id` | Update a provider |
| DELETE | `/api/llm/providers/:id` | Remove a provider |
| PUT | `/api/llm/active` | Assign the active provider per task (draft/review) |
| POST | `/api/llm/test` | Test a provider connection (stored or unsaved values) |

A review finding's `patch` is a whole-field replacement
(`{field, value}`), validated server-side against the field's schema in
`apps/rfc/rfc-schema.js` before it reaches the browser.

## Historical corpus (import pipeline)

Drop signed PDFs + `RFC Tracker.xlsx` into `RFC/`, then:

```bash
pip install -r tools/requirements.txt
cd apps/rfc/backend && npm run import:all
# = read_tracker.py → parse_pdf.py → import-rfcs.js
```

`import-rfcs.js` joins tracker metadata with PDF prose, classifies the change
type with one cheap LLM call per record (re-runs keep existing
classifications), writes one JSON per record to `RFC/corpus/`, and embeds it
into Qdrant. Everything under `RFC/` stays out of git (real names).

## Company IT Policy corpus (optional)

Grounds draft/review/chat in the actual Company IT Policy text instead of a
hardcoded/transcribed clause. Drop one or more policy PDFs into `policy/pdfs/`,
then:

```bash
cd apps/rfc/backend && npm run policy:all
# = parse_policy_pdf.py (extract text) → ingest-policy.js (chunk + embed)
```

Safe to re-run — chunk ids are deterministic per source file + chunk index,
so adding another PDF later and re-running only embeds the new one; existing
docs just overwrite in place. Requires Qdrant + the embedding model (same
setup as the vector-store step above). Everything under `policy/` stays out
of git (internal policy content).

## Template maintenance

When Governance updates the official template:

```bash
cd apps/rfc/backend
npm run template          # re-inject placeholder tags (tools/apply_template.py)
npm run template:check    # verify template ↔ code placeholder parity
npm run fixture:check     # render the committed fixture through the template
```

## MOP specifics

MOP shares RFC's shape (priority/klasifikasi, risk register, security
requirement matrix, sign-off, schedule) but diverges where a MOP is an
**execution document**, not a change classification:

- **Steps instead of tasks** — each step carries `{phase, step_no, waktu,
  action, command, expected_output, evidence, pic}`. The `command` is the
  exact paste-ready command; `expected_output` is the success indicator;
  `evidence` is the capture (screenshot/log). A step without a command or
  expected output is flagged as not executable.
- **Objective + scope + prerequisites + verification** replace RFC's
  description/tujuan/rollback-as-separate-table. Prerequisites is the pre-check
  gate (backup, capacity, access); verification is the post-execution
  acceptance criteria.
- **No changeType taxonomy** — a MOP executes an already-classified change, so
  it doesn't carry RFC's 16 change types / 9 categories. Few-shot matching is
  system-only.
- **7 review sections**: tujuan, prasyarat, langkah, verifikasi, risiko,
  security, bahasa (vs RFC's deskripsi, dampak, jadwal, risiko, pengerjaan,
  security, bahasa).

**MOP `.docx` is a placeholder.** `apps/mop/backend/mop_template.docx` is a copy
of RFC's template so `/api/document` produces a valid `.docx` end-to-end, but
the MOP-native placeholder keys (`{objective}`, `{scope}`, `{#step_groups}`, …)
don't match the RFC template's slots, so the output renders with blanks.
Production-correct MOP `.docx` output needs either an official MOP Word
template (drop in, then extend `tools/apply_template.py` with a `--app mop`
ruleset) or a hand-authored one. The retooling script injects placeholders into
a doc whose structure already matches — it can't restructure (rename headings,
widen the task table to 8 columns) — so it needs a MOP-structured source doc.

