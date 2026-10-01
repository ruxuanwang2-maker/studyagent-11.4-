# StudyAgent

StudyAgent is a local-first AI learning workspace MVP for reading, asking, annotating, structuring knowledge, and reviewing. It is intentionally implemented without a build dependency so it can run on a machine that has Node.js but no Python runtime.

## What is working

- Home dashboard with real persisted demo metrics, focus tasks, weak knowledge, and recent cards.
- Library with seeded Numerical Analysis / AI Foundations materials and one upload path for PDF, Word, PowerPoint, Markdown, TXT, Excel, CSV, and image files. PDFs and other binary files are uploaded as original bytes; structured formats are parsed on the local server and the reader presents non-PDF files as page/slide/sheet/section content instead of routing them through a PDF viewer.
- Scanned PDFs now go through a local OCR path: Poppler `pdftoppm` renders pages, Tesseract.js recognizes Chinese simplified text with the bundled `@tesseract.js-data/chi_sim` model, and OCR output is stored with page citations. The status endpoint is `GET /api/ocr/status`.
- Formula-aware reading is included in the same local path: common PDF/OCR math patterns are separated into formula blocks, normalized to LaTeX, rendered with browser-native MathML, and shown with the original recognition text plus a confidence score. The reader also preserves the uploaded PDF bytes and exposes an `Original layout` toggle backed by `GET /api/documents/:id/page-image/:page`.
- Reading workspace with outline, page navigation, zoom, page summaries, local highlights, notes, selection actions, and an AI side panel.
- Evidence-first local retrieval: keyword/hybrid-shaped retrieval returns document/page citations for chat and explain requests.
- Knowledge points, flashcards, a lightweight knowledge graph, review queue, mastery updates, analytics, privacy settings, and command palette.
- Node API boundaries matching the requested product surface: documents, annotations, chat, streaming chat, explain, summarize, card creation, knowledge, graph, review, analytics, settings, learning summaries/quizzes, and an inspectable Learning Orchestrator plan.

## Start

```powershell
npm start
```

Open http://127.0.0.1:4173

Structured documents, sections, chunks, embeddings, notes, annotations, cards, concepts, relations, questions, memories, progress and review schedules are persisted in `data/studyagent.sqlite`; `data/studyagent.json` remains only as a compatibility and one-time bootstrap source for legacy seeded UI state. Uploaded local files are written to `uploads/`. No external provider is contacted in the default Local Study Agent mode. The OCR path is also local after the npm dependencies are installed.

Important PDF note: PDFs uploaded by builds before the binary upload fix may show replacement characters (`���`). Those imports are marked as needing re-import because the original PDF bytes were already lost during the old UTF-8 decode. Re-upload the original PDF once; the current upload path preserves the bytes, performs local page extraction, and runs OCR on pages without selectable text.

Formula note: the formula layer is a local heuristic OCR normalizer, not a full neural math-OCR model. It is designed to recover common relations, domains, Greek letters, roots, fractions, and matrix-style expressions from the current PDF text/OCR output. Low-confidence or heavily corrupted expressions keep their raw OCR text alongside the generated LaTeX so they can be corrected instead of being silently treated as exact.

## Demo path

1. Home → Continue reading.
2. On page 3, select the Backward stability sentence and click Highlight or Explain.
3. Create a card from the same selection.
4. Ask “What is the difference between forward error and backward error?” and inspect the page citations.
5. Click Summarize, then Knowledge and Review to see persisted downstream state.

## Verification

The server has no third-party runtime dependencies. Verify with:

```powershell
npm start
Invoke-RestMethod http://127.0.0.1:4173/api/documents
Invoke-RestMethod http://127.0.0.1:4173/api/knowledge/graph
```

## Architecture boundary

The current implementation keeps the local-first Node server and SQLite contract deliberately small. A future Python/FastAPI or neural retrieval adapter can be added behind the existing parser, embedding, and provider interfaces without changing the reader UI.

## Multi-model API and AI reading

Open `Settings → AI Model Settings` to add a provider. The page supports OpenAI, DeepSeek, Anthropic Claude, Google Gemini, OpenRouter, SiliconFlow, Moonshot/Kimi, Zhipu/GLM, Qwen/DashScope, and custom OpenAI-compatible endpoints. Selecting a provider fills its Base URL and fallback models; `刷新模型列表` tries the provider's Models API and falls back to the local registry when the remote endpoint is unavailable.

The server exposes these model endpoints:

```text
GET    /api/models/providers
GET    /api/models/configs
POST   /api/models/configs
DELETE /api/models/configs/:id
POST   /api/models/configs/:id/test
POST   /api/models/discover
POST   /api/chat
POST   /api/chat/stream
```

API keys are never returned in full and are not written to `data/studyagent.json`. Configurations are stored in the local encrypted file `data/model-config.enc`; the encryption key is derived from the current Windows user and machine, so this is local-at-rest protection rather than a cloud secret manager or a replacement for Windows Credential Manager. Do not copy that file to another machine and do not commit it. The default Local Study Agent mode makes no outbound model request; responses include `mode: "local"` so the UI does not present local retrieval as a remote model answer.

To add or update a model, edit `config/modelProviders.js` and add its provider/model capability metadata. Implement protocol-specific request parsing in `services/llm/providers.js` only when the service is not OpenAI-compatible. The reader sends document title, page number, selected text, nearby text, formula LaTeX, and the user's question through the shared Prompt/Context Builder in `prompts/index.js`; it does not send the whole PDF by default.

After changing PDF/OCR/parser code, run the fixed real-sample regression first:

```powershell
npm run check:pdf
```

The HTTP integration check (`npm run check:http`) exercises the live local service for the SQLite document catalog, knowledge points/graph, review queue, note/annotation/card CRUD, SQLite analytics, and workspace retrieval; it cleans up the records it creates.

The same check also confirms the local PDF.js assets, original PDF stream, page AST, formula blocks, and original page image. A remote provider test requires a real API key and outbound network access; builds and local-mode tests do not prove upstream provider availability.

Interface and AI language is configurable in Settings as `中文` or `English`. The selected `zh`/`en` value is persisted locally: the interface localizes the workspace navigation and primary learning surfaces, while the same value is passed through the shared context builder to both Local Study Agent responses and configured remote providers.

## Structured learning workspace

The current implementation adds a real local-first learning data path on top of the existing reader:

- Supported import types: PDF, DOCX, DOC, PPTX, PPT, Markdown, TXT, XLSX, XLS, CSV, PNG, JPG/JPEG and WEBP.
- Structured parsers preserve page, heading, paragraph, list, formula, slide text box, notes, sheet/cell address, table and image/OCR locations where the source format exposes them. Reader pages carry typed blocks so tables, lists, notes, OMML-derived formula candidates and opt-in Vision descriptions are not flattened into one string. Image资料先走本地 OCR；阅读器中的“使用 Vision 分析图表/公式”会在已配置视觉模型且用户主动调用后，把描述结果持久化并加入检索索引。DOC/PPT/XLS legacy binary files now receive a readable printable-run fallback split into legacy paragraphs, with an explicit limited-parser warning; OOXML DOCX/PPTX/XLSX has the richer structured path.
- SQLite is stored at `data/studyagent.sqlite`, with Workspace/Course/Document records, sections, chunks, embeddings, questions, memories, concepts, relations and learning progress.
- The RAG service uses structure-aware chunking: typed heading, paragraph, formula, table, note and image blocks become individually traceable chunks with `blockType`/`blockIndex` metadata, while unstructured text uses paragraph boundaries and a size ceiling. It persists a local hash embedding fallback (`local-hash-v1`) with candidate-pool retrieval, normalized lexical-plus-cosine reranking, and an explicit relevance threshold; low-relevance chunks are excluded before context construction. The provider abstraction now also exposes server-side `embed()` and `vision()` adapters through `/api/ai/embed` and `/api/ai/vision`; `/api/learning/reindex` can rebuild selected documents or a course with a configured provider embedding model, while RAG still defaults to the local fallback offline.
- Chat and `/api/learning/search` support `current-page`, `current-document`, `course`, `documents` and `workspace` scopes and return page/slide/sheet/section citations from retrieved chunks. Empty course/file selections remain empty instead of silently widening to the whole knowledge base.
- Long-term memory is persisted separately from chat history. The Knowledge page exposes an editable user-profile memory (answer style, formula style, learning goals, and programming language), memory counts, edit/delete/export controls, learning progress, summaries and quiz attempts, and Settings can disable memory capture. Each Chat/Reading question also has a per-turn “save to long-term memory” switch, and the API accepts `remember: false`; the saved profile is included in the Agent context when it is enabled.
- Historical association uses a relevance threshold plus a small concept ontology (for example Gaussian Elimination → Pivoting → Numerical Stability → Backward Error). When a previous question is reached through that graph, the response labels it as a knowledge-graph connection instead of pretending it was a direct lexical match; new concept relations are persisted in `concept_relations`.
- Chat turns are also persisted in SQLite `conversations` and `messages` rows, including scope, selected text, citations, provider and model metadata. The current conversation can be queried with `GET /api/conversations` and `GET /api/conversations/:id/messages`; the legacy JSON message list remains only for compatibility with the existing UI state.
- Notes now use the SQLite `notes` table rather than the former static Notes screen: a note can be created from selected reader text or independently, keeps document/course/page/section metadata, can be edited or deleted, and can jump back to its source page.
- Reader highlights and annotations are also migrated into SQLite `annotations`; `/api/annotations` and the reader highlight action now use the persistent store. Learning Analytics reports actual SQLite question, note and annotation events instead of fixed dashboard counters.
- Knowledge cards are persisted in SQLite `knowledge_cards`; legacy cards are migrated at bootstrap, card creation uses the same store, and deleting a source document removes its linked cards.
- Home and Library summary cards now consume `/api/analytics`; they show verifiable document, question, concept and note counts, while unsupported fixed “study time” numbers are no longer presented as user activity.

Useful local endpoints include `/api/learning/documents`, `/api/learning/search`, `/api/learning/reindex`, `/api/learning/progress`, `/api/learning/summary`, `/api/learning/quiz`, `/api/memory`, `/api/memory/export`, `/api/graph`, `/api/agent/plan`, `/api/ai/embed`, `/api/ai/vision`, and `/api/questions`. The PDF regression command below validates the uploaded high-algebra lecture sample, including page rendering, OCR and formula extraction.

## Explicit boundaries / TODO

- Legacy binary DOC/PPT/XLS files still do not have full layout, table, slide or formula reconstruction. They use a readable printable-run fallback and retain a limited-parser warning; full structure preservation requires a dedicated legacy Office parser or a locally installed conversion runtime.
- The default embedding implementation is a deterministic local hash vector (`local-hash-v1`) so the app works offline. It is not equivalent to a neural embedding model; the provider-backed `embed()` adapter exists, but remote embedding-based indexing is not enabled by default.
- Formula recovery is currently a heuristic layer over the PDF text/OCR evidence. The original PDF view remains the layout authority, while the parsed view exposes LaTeX candidates and raw recognition text for correction. A dedicated neural math-OCR model is still TODO.
- The persistent data, page-aware retrieval, editable node-detail graph view, dynamic Workspace/Course/Document screens, SQLite-backed daily summary, retrieval-grounded quiz generation, quiz-attempt persistence, adaptive review intervals, and Learning Orchestrator plan are implemented. The quiz endpoint is intentionally transparent about its `retrieval-grounded-local` mode; it does not pretend to be a remote LLM when no provider is configured. A full adaptive review-agent experience with richer scheduling analytics remains explicitly out of scope for this iteration rather than hidden mock functionality.
