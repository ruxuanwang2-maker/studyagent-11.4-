const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { publicProviders, getProvider, fallbackModels } = require('./config/modelProviders');
const { createConfigStore } = require('./services/llm/store');
const { createProvider, safeMessage } = require('./services/llm/providers');
const { buildPrompt } = require('./prompts');
const { createLearningDb } = require('./services/db/sqlite');
const { parseStructuredDocument, extension: fileExtension } = require('./services/documents/pipeline');
const { createRagService } = require('./services/rag');
const { createMemoryService } = require('./services/memory');
const { createLearningOrchestrator } = require('./services/agents/orchestrator');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'studyagent.json');
const RUNTIME_TMP = path.join(ROOT, 'tmp', 'runtime');
const DOCUMENT_MIME_TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
let tesseract = null;
let chiSimData = null;
let pdfJsLoader = null;
try { tesseract = require('tesseract.js'); chiSimData = require('@tesseract.js-data/chi_sim'); } catch { /* OCR remains an explicit optional fallback. */ }
for (const dir of [DATA_DIR, UPLOAD_DIR, RUNTIME_TMP]) fs.mkdirSync(dir, { recursive: true });

const seed = {
  documents: [{
    id: 'doc-numerical-analysis', title: 'Numerical Analysis · Error & Stability', type: 'PDF', size: '1.8 MB', pages: 8,
    course: 'Numerical Analysis', progress: 0.62, annotations: 3, questions: 7, uploadedAt: '2026-09-26', lastRead: 'Today · 10:42',
    tags: ['重点', '期中复习'], content: [
      { page: 1, heading: '1. A language for numerical error', text: 'Numerical computation is the study of algorithms for solving mathematical problems with finite precision. A useful error analysis separates the error in a computed answer from the error in the problem that was actually solved.' },
      { page: 2, heading: '2. Forward error', text: 'Forward error measures the distance between the computed result and the exact result of the original problem. If x is exact and x-hat is computed, the forward error is |x-hat − x|. It answers: how far is my answer from the truth?' },
      { page: 3, heading: '3. Backward error', text: 'Backward error asks a different question: for which nearby input would the computed result be exact? A computation is backward stable when its answer is the exact answer to a nearby problem. Backward stability means the algorithm does not magnify the input perturbation beyond the scale expected from rounding.' },
      { page: 4, heading: '4. Condition number', text: 'The condition number measures how sensitive a problem is to small changes in input. An ill-conditioned problem may have a small backward error but a large forward error. This distinction separates an unstable algorithm from a sensitive problem.' },
      { page: 5, heading: '5. Floating-point arithmetic', text: 'Floating-point arithmetic represents real numbers with a finite significand and exponent. Rounding introduces a relative error bounded by the unit roundoff in standard models, but cancellation can still destroy significant digits.' },
      { page: 6, heading: '6. LU decomposition', text: 'LU decomposition factors a matrix A into a lower triangular matrix L and an upper triangular matrix U. With pivoting, PA = LU, the method is efficient for solving multiple systems with the same coefficient matrix.' },
      { page: 7, heading: '7. QR decomposition', text: 'QR decomposition writes A = QR, where Q has orthonormal columns and R is upper triangular. Householder reflections provide a stable way to construct Q without explicitly forming it.' },
      { page: 8, heading: '8. Checklist', text: 'When reading a numerical algorithm, ask three questions: What problem is being solved? Is the algorithm stable? Is the problem well-conditioned? A reliable conclusion connects forward error, backward error, and condition number.' }
    ]
  }, {
    id: 'doc-ai-foundations', title: 'AI Foundations · Retrieval and Memory', type: 'MD', size: '42 KB', pages: 4,
    course: 'Artificial Intelligence', progress: 0.28, annotations: 1, questions: 3, uploadedAt: '2026-09-24', lastRead: 'Yesterday · 16:20', tags: ['RAG'], content: [
      { page: 1, heading: 'Retrieval augmented generation', text: 'Retrieval augmented generation grounds model responses in an external collection of documents. The retriever finds relevant evidence and the generator composes an answer with that evidence.' },
      { page: 2, heading: 'Chunking and metadata', text: 'Good chunks preserve semantic boundaries and carry metadata such as document, page, section, and content type. Metadata enables precise filtering and citations.' },
      { page: 3, heading: 'Memory', text: 'Learning memory is a compact representation of durable user state: mastered concepts, recurring confusions, recent sessions, and review obligations.' },
      { page: 4, heading: 'Evaluation', text: 'A useful learning assistant evaluates both answer quality and learning impact: evidence coverage, citation accuracy, mastery updates, and whether the learner can retrieve the idea later.' }
    ]
  }],
  annotations: [
    { id: 'ann-1', documentId: 'doc-numerical-analysis', page: 3, type: 'highlight', color: 'yellow', text: 'Backward stability means its answer is the exact answer to a nearby problem.', note: '这里的“nearby problem”是输入有小扰动后的问题。', createdAt: 'Today · 10:42' },
    { id: 'ann-2', documentId: 'doc-numerical-analysis', page: 4, type: 'highlight', color: 'purple', text: 'An ill-conditioned problem may have a small backward error but a large forward error.', note: '', createdAt: 'Yesterday · 16:18' },
    { id: 'ann-3', documentId: 'doc-numerical-analysis', page: 8, type: 'note', color: 'blue', text: 'Forward / backward / condition number checklist', note: '复习时用三问法快速判断。', createdAt: 'Yesterday · 16:24' }
  ],
  knowledge: [
    { id: 'kp-forward', name: 'Forward Error', description: 'Computed result 与 exact result 的距离。', mastery: 0.72, difficulty: '中', importance: '高', source: 'Numerical Analysis · p.2', color: '#f2b36d' },
    { id: 'kp-backward', name: 'Backward Error', description: '使 computed result 精确成立所需的最小输入扰动。', mastery: 0.46, difficulty: '高', importance: '高', source: 'Numerical Analysis · p.3', color: '#d77f6a' },
    { id: 'kp-condition', name: 'Condition Number', description: '问题对输入扰动的敏感程度。', mastery: 0.38, difficulty: '高', importance: '高', source: 'Numerical Analysis · p.4', color: '#b57edc' },
    { id: 'kp-rag', name: 'RAG Pipeline', description: '先检索证据，再生成带引用的回答。', mastery: 0.67, difficulty: '中', importance: '中', source: 'AI Foundations · p.1', color: '#6da8d9' }
  ],
  cards: [
    { id: 'card-1', front: 'What is backward stability?', back: 'The algorithm returns the exact solution to a nearby problem. It controls backward error, not necessarily forward error.', source: 'Numerical Analysis · p.3', due: 'Today', mastery: 0.42 },
    { id: 'card-2', front: 'Forward error vs backward error?', back: 'Forward asks how far the answer is from truth; backward asks how much the input must change to make the answer exact.', source: 'Numerical Analysis · p.2–3', due: 'Tomorrow', mastery: 0.56 },
    { id: 'card-3', front: 'What does a condition number measure?', back: 'Sensitivity of a problem to small input changes. A large value signals an ill-conditioned problem.', source: 'Numerical Analysis · p.4', due: 'Today', mastery: 0.38 }
  ],
  messages: [{ id: 'msg-welcome', role: 'assistant', text: '你好，我是 StudyAgent。选择文档中的一段文字，或直接问我当前资料，我会给出带页码引用的解释。', citations: [], createdAt: 'Today' }],
  sessions: [{ id: 'session-1', documentId: 'doc-numerical-analysis', pagesRead: 4, questions: 7, highlights: 3, minutes: 42, date: 'Today' }],
  reviewTasks: [{ id: 'review-1', title: 'Review Backward Error', reason: 'You asked this concept three times yesterday.', source: 'Numerical Analysis · p.3', due: 'Today', status: 'due', knowledgeId: 'kp-backward' }, { id: 'review-2', title: 'Forward vs Backward Error', reason: 'Mastery is below 60%.', source: 'Numerical Analysis · p.2–3', due: 'Today', status: 'due', knowledgeId: 'kp-forward' }],
  settings: { provider: 'Local Study Agent', model: 'Evidence-first local mode', apiKey: '', language: '中文', privacy: 'retrieved-chunks', retrievalK: 8 }
};

function load() { if (!fs.existsSync(DATA_FILE)) { fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2)); return structuredClone(seed); } try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return structuredClone(seed); } }
let db = load();
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
if (db.settings?.apiKey) { delete db.settings.apiKey; save(); }
if (db.settings?.language === '中文' || db.settings?.language === 'English') { db.settings.language = db.settings.language === 'English' ? 'en' : 'zh'; save(); }
const learningDb = createLearningDb(path.join(DATA_DIR, 'studyagent.sqlite'));
learningDb.ensureBootstrap(db);
const ragService = createRagService(learningDb);
const memoryService = createMemoryService(learningDb);
const learningOrchestrator = createLearningOrchestrator({ ragService, memoryService, learningDb });
for (const indexedDocument of learningDb.listDocuments()) ragService.indexChunks(learningDb.getDocumentContext(indexedDocument.id));
const modelConfigStore = createConfigStore(path.join(DATA_DIR, 'model-config.enc'));
let modelConfigs = modelConfigStore.read();
const modelListCache = new Map();
function maskKey(value) { const key = String(value || ''); return key ? `${key.slice(0, 3)}${'•'.repeat(Math.max(4, Math.min(12, key.length - 3)))}${key.slice(-3)}` : ''; }
function publicModelConfig(config) {
  const preset = getProvider(config.provider);
  return { ...config, apiType: config.apiType || preset.apiType, baseUrl: config.baseUrl || preset.baseUrl, apiKey: maskKey(config.apiKey), hasApiKey: Boolean(config.apiKey), headers: config.headers || {}, models: modelListCache.get(config.provider) || fallbackModels(config.provider) };
}
function normalizeModelConfig(input, previous = {}) {
  const provider = String(input.provider || previous.provider || 'custom');
  const preset = getProvider(provider);
  const apiKey = input.apiKey && !String(input.apiKey).includes('•') ? String(input.apiKey) : String(previous.apiKey || '');
  return { id: previous.id || input.id || uid('model'), provider, providerName: input.providerName || previous.providerName || preset.name, apiType: input.apiType || previous.apiType || preset.apiType, model: input.model || previous.model || preset.models?.[0]?.id || '', apiKey, baseUrl: input.baseUrl ?? previous.baseUrl ?? preset.baseUrl, organizationId: input.organizationId || previous.organizationId || '', headers: input.headers || previous.headers || {}, temperature: Number(input.temperature ?? previous.temperature ?? 0.2), maxTokens: Number(input.maxTokens ?? previous.maxTokens ?? 1200), timeout: Number(input.timeout ?? previous.timeout ?? 45000), streaming: input.streaming !== undefined ? Boolean(input.streaming) : previous.streaming !== false, isDefault: Boolean(input.isDefault ?? previous.isDefault), createdAt: previous.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function persistModelConfigs() { modelConfigStore.write(modelConfigs); }
function defaultModelConfig() { return modelConfigs.find(config => config.isDefault && config.apiKey) || modelConfigs.find(config => config.apiKey); }
function selectModelConfig(input = {}) { return (input.configId && modelConfigs.find(config => config.id === input.configId)) || (input.provider && modelConfigs.find(config => config.provider === input.provider && (!input.model || config.model === input.model))) || defaultModelConfig(); }
function readerContext(body, document) {
  const page = document?.content?.find(item => item.page === Number(body.page || 0));
  const text = page?.text || '';
  const selected = String(body.selectedText || '').trim();
  const position = selected ? text.indexOf(selected) : -1;
  return { documentId: document?.id, documentTitle: document?.title, pageNumber: page?.page, selectedText: selected, formula: body.formula || '', surroundingText: position >= 0 ? text.slice(Math.max(0, position - 360), Math.min(text.length, position + selected.length + 360)) : text.slice(0, 900), userQuestion: body.message || '', language: body.language === 'en' ? 'en' : (db.settings?.language === 'en' ? 'en' : 'zh') };
}
function learningScope(body, document) {
  const scope = body.scope || 'current-document';
  const documentIds = Array.isArray(body.documentIds) ? body.documentIds : [];
  if (scope === 'current-page') return { documentIds: document?.id ? [document.id] : (documentIds.length ? documentIds : ['__empty-current-page__']), page: Number(body.page || 0) || undefined, limit: 6 };
  if (scope === 'current-document') return { documentIds: document?.id ? [document.id] : (documentIds.length ? documentIds : ['__empty-current-document__']), limit: 8 };
  if (scope === 'course') return { courseId: body.courseId || document?.courseId || '__empty-course__', limit: 10 };
  if (scope === 'documents') return { documentIds: documentIds.length ? documentIds : ['__empty-document-selection__'], limit: 10 };
  return { workspaceId: body.workspaceId || 'workspace-personal', limit: 10 };
}
function buildLearningContext(body, document, kind = body.formula ? 'formula' : 'text') {
  const options = learningScope(body, document);
  return learningOrchestrator.prepare({ question: body.message || '', body, document, kind, scope: options });
}
function memoryAssociationNote(memory, language) {
  const related = memory?.relatedQuestions || [];
  if (!related.length) return '';
  const english = language === 'en';
  const lines = related.slice(0, 2).map(item => item.association === 'concept-graph'
    ? (english ? `- This connects to your earlier question “${item.question}” through ${item.matchedConcepts?.join(', ') || 'a related concept'}.` : `- 这与您之前的问题“${item.question}”通过${item.matchedConcepts?.join('、') || '相关概念'}形成知识关联。`)
    : (english ? `- You previously asked: “${item.question}”` : `- 你之前问过：“${item.question}”`));
  return english ? `\n\nConnection to your previous learning:\n${lines.join('\n')}` : `\n\n与你之前学习内容的关联：\n${lines.join('\n')}`;
}
async function runAiRequest(body, kind = 'text') {
  const document = findDoc(body.documentId);
  const context = readerContext(body, document);
  const learning = buildLearningContext(body, document, kind);
  const config = selectModelConfig(body);
  if (!config || !config.apiKey) {
    const local = localAnswer(body.message || '', body.documentId, body.selectedText || '', context.language, learning.retrieved);
    const memoryNote = memoryAssociationNote(learning.memory, context.language);
    return { ...local, answer: `${local.answer}${memoryNote}`, mode: 'local', provider: 'local', model: 'Evidence-first local mode', language: context.language, context: { ...context, ...learning }, memoryAssociations: learning.memory.relatedQuestions };
  }
  const retrievedText = learning.retrieved.map(item => `[${item.citation}]\n${item.text}`).join('\n\n');
  const prompt = `${buildPrompt(kind, context, body.message || '请解释当前内容。')}\n\n资料库检索上下文（只使用相关内容）：\n${retrievedText || '当前范围没有命中文本。'}\n\n真实长期学习记忆：\n${learning.memoryText || '没有明显相关的历史记忆。'}`;
  const provider = createProvider(config);
  const response = await provider.chat({ model: config.model, messages: [{ role: 'system', content: `You are StudyAgent's literature reading assistant. Answer in ${context.language === 'en' ? 'English' : 'Chinese'}. Ground the answer in the supplied context and use LaTeX for mathematics.` }, { role: 'user', content: prompt }], temperature: config.temperature, maxTokens: config.maxTokens });
  const citations = learning.retrieved.map((item, index) => ({ id: index + 1, documentId: item.documentId, document: item.documentTitle, page: item.locator.page, slide: item.locator.slide, sheet: item.locator.sheet, section: item.section, label: item.citation, quote: item.text.slice(0, 130) }));
  return { answer: response.text, citations, confidence: 0.9, mode: 'remote', provider: config.provider, model: response.model, configId: config.id, language: context.language, context: { ...context, ...learning }, memoryAssociations: learning.memory.relatedQuestions };
}
function migrateLegacyPdfImports() {
  let changed = false;
  for (const doc of db.documents || []) {
    if (doc.type !== 'PDF' || !Array.isArray(doc.content)) continue;
    const broken = doc.content.some(page => /�|%PDF-|obj\s|endstream/.test(page.text || ''));
    if (!broken || doc.legacyExtractError) continue;
    doc.legacyExtractError = true;
    doc.content = [{ page: 1, heading: 'PDF needs to be re-imported', text: 'This PDF was imported by an older build that decoded the binary file as UTF-8. The original bytes cannot be recovered from that import. Upload the original PDF again; the current build preserves PDF bytes and extracts page text with font mappings.' }];
    doc.pages = 1;
    doc.progress = 0;
    changed = true;
  }
  if (changed) save();
}
migrateLegacyPdfImports();
function uid(prefix) { return prefix + '-' + crypto.randomBytes(4).toString('hex'); }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function error(res, code, message, details = {}) { const status = Number(details?.status) || 400; const safeDetails = { ...details }; delete safeDetails.status; json(res, status, { error: { code, message, details: safeDetails } }); }
function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', c => { data += c; if (data.length > 15e6) reject(new Error('payload too large')); }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); } }); }); }
function clientDocumentView(row) {
  const legacy = row?.legacy && typeof row.legacy === 'object' ? row.legacy : {};
  const course = learningDb.listCourses().find(item => item.id === row.course_id);
  const context = Array.isArray(legacy.content) && legacy.content.length ? legacy.content : learningDb.getDocumentContext(row.id).map((item, index) => ({
    page: Number(item.locator?.page || item.locator?.slide || item.locator?.sheet || index + 1),
    heading: item.section_title || item.metadata?.title || `Section ${index + 1}`,
    text: item.content,
    locator: item.locator,
    blocks: item.locator?.blocks || []
  }));
  return { ...legacy, id: row.id, title: row.title, type: row.file_type, fileType: row.file_type, sourceFile: row.source_path || legacy.sourceFile || '', courseId: row.course_id, workspaceId: row.workspace_id, course: course?.name || legacy.course || '未分类', pages: Number(legacy.pages || context.length || 0), content: context, metadata: { ...(legacy.metadata || {}), ...row.metadata }, structure: legacy.structure || { sections: context.length, chunks: learningDb.getDocumentContext(row.id).length, parser: 'sqlite-document-catalog' } };
}
function findDoc(id) {
  const legacy = db.documents.find(d => d.id === id);
  if (legacy) return legacy;
  const row = learningDb.getDocument(id);
  return row ? clientDocumentView(row) : null;
}
function conversationIdFor(input = {}) { return input.conversationId || (input.documentId ? `conversation-document-${input.documentId}` : 'conversation-workspace'); }
function persistConversationTurn(input, result = {}, answer = '') {
  const document = findDoc(input.documentId);
  const conversationId = conversationIdFor(input);
  learningDb.upsertConversation({
    id: conversationId,
    title: document?.title ? `阅读：${document.title}` : '工作区学习对话',
    workspaceId: input.workspaceId || 'workspace-personal',
    courseId: input.courseId || document?.courseId || document?.course_id || null
  });
  learningDb.saveConversationMessage({
    conversationId,
    role: 'user',
    content: input.message || '',
    metadata: { selectedText: input.selectedText || '', page: input.page, scope: input.scope || 'current-document', language: input.language || null }
  });
  learningDb.saveConversationMessage({
    conversationId,
    role: 'assistant',
    content: answer || '',
    metadata: { citations: result.citations || [], provider: result.provider || 'local', model: result.model || '', mode: result.mode || 'local' }
  });
  return conversationId;
}
function tokenize(s) { return (s || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(x => x.length > 2); }
function streamFromPdfObject(body) {
  const marker = body.indexOf('stream');
  if (marker < 0) return '';
  let start = marker + 6;
  if (body[start] === '\r') start += 1;
  if (body[start] === '\n') start += 1;
  const end = body.lastIndexOf('endstream');
  if (end < start) return '';
  let raw = Buffer.from(body.slice(start, end), 'latin1');
  if (/\/FlateDecode/.test(body)) {
    try { raw = zlib.inflateSync(raw); } catch { return ''; }
  }
  return raw.toString('latin1');
}
function parsePdfCMap(cmap) {
  const map = new Map();
  const hexToCode = hex => parseInt(hex, 16);
  const hexToUnicode = hex => {
    const units = [];
    for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  for (const section of cmap.split('endbfchar')) {
    for (const m of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) map.set(hexToCode(m[1]), hexToUnicode(m[2]));
  }
  for (const section of cmap.split('endbfrange')) {
    for (const m of section.matchAll(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g)) {
      const from = hexToCode(m[1]); const to = hexToCode(m[2]); const start = hexToCode(m[3]);
      for (let code = from; code <= to; code += 1) map.set(code, String.fromCharCode(start + code - from));
    }
  }
  return map;
}
function decodePdfHex(hex, cmap) {
  const candidates = [];
  for (let width = 4; width >= 2; width -= 2) {
    if (hex.length % width !== 0) continue;
    const values = [];
    for (let i = 0; i < hex.length; i += width) values.push(parseInt(hex.slice(i, i + width), 16));
    const mapped = values.map(v => cmap.get(v));
    if (mapped.every(Boolean)) return mapped.join('');
    candidates.push(values.map(v => v >= 32 && v <= 126 ? String.fromCharCode(v) : '').join(''));
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}
function decodePdfLiteral(value) {
  return value.replace(/\\([\\()nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
}
function assessNativeTextQuality(value) {
  const text = String(value || '').trim();
  const chars = text.length;
  if (!chars) return { chars: 0, printableRatio: 0, replacementRatio: 0, garbageRatio: 1, alphabetRatio: 0, chineseRatio: 0, coverage: 0, score: 0 };
  const printable = [...text].filter(char => /[\p{L}\p{N}\p{P}\p{Z}\p{S}]/u.test(char)).length;
  const replacements = [...text].filter(char => char === '�' || char === '□').length;
  const garbage = [...text].filter(char => /[�□]|(?:[A-Za-z])\1{3,}|[�□]{2,}/.test(char)).length + (text.match(/[�□]/g) || []).length;
  const alphabet = [...text].filter(char => /[A-Za-z]/.test(char)).length;
  const chinese = [...text].filter(char => /[\u4e00-\u9fff]/.test(char)).length;
  const coverage = Math.min(1, chars / 180);
  const printableRatio = printable / chars;
  const replacementRatio = replacements / chars;
  const garbageRatio = Math.min(1, garbage / chars);
  const alphabetRatio = alphabet / chars;
  const chineseRatio = chinese / chars;
  const score = Math.max(0, Math.min(1, printableRatio * 0.35 + (1 - replacementRatio) * 0.3 + (1 - garbageRatio) * 0.2 + coverage * 0.15));
  return { chars, printableRatio, replacementRatio, garbageRatio, alphabetRatio, chineseRatio, coverage, score };
}
function parsePdfMediaBox(body) {
  const match = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(body || '');
  if (!match) return { width: null, height: null };
  return { width: Math.abs(Number(match[3]) - Number(match[1])), height: Math.abs(Number(match[4]) - Number(match[2])) };
}
function extractPdfText(stream, cmap) {
  const out = [];
  const pushToken = token => {
    if (token.startsWith('<') && token.endsWith('>')) out.push(decodePdfHex(token.slice(1, -1), cmap));
    else if (token.startsWith('(') && token.endsWith(')')) out.push(decodePdfLiteral(token.slice(1, -1)));
  };
  for (const match of stream.matchAll(/\[(.*?)\]\s*TJ|(<[0-9A-Fa-f]+>|\((?:\\.|[^)])*\))\s*Tj/gms)) {
    if (match[1] !== undefined) for (const token of match[1].match(/<[0-9A-Fa-f]+>|\((?:\\.|[^)])*\)/g) || []) pushToken(token);
    else pushToken(match[2]);
    out.push(' ');
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
function extractPdfPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  const source = buffer.toString('latin1'); const objects = new Map();
  for (const match of source.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) objects.set(Number(match[1]), match[3]);
  const cmap = new Map();
  for (const body of objects.values()) if (/\/ToUnicode/.test(body)) for (const [code, value] of parsePdfCMap(streamFromPdfObject(body))) cmap.set(code, value);
  const pages = [...objects.entries()].filter(([, body]) => /\/Type\s*\/Page\b/.test(body));
  const result = pages.map(([id, body], index) => {
    const refs = []; const refPattern = /\/Contents\s+(?:\[\s*)?((?:\d+\s+\d+\s+R\s*)+)/.exec(body);
    if (refPattern) for (const ref of refPattern[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(ref[1]));
    const text = refs.map(ref => extractPdfText(streamFromPdfObject(objects.get(ref) || ''), cmap)).filter(Boolean).join(' ').trim();
    const quality = assessNativeTextQuality(text);
    const mediaBox = parsePdfMediaBox(body);
    const usable = Boolean(text) && quality.score >= 0.7;
    return {
      page: index + 1,
      heading: `Page ${index + 1}`,
      width: mediaBox.width,
      height: mediaBox.height,
      text: usable ? text : 'No selectable text was found on this page. You can still annotate it locally.',
      extraction: usable ? 'native' : 'ocr-pending',
      source: usable ? 'native-pdf' : 'ocr',
      nativeQuality: quality
    };
  });
  return result.length ? result : null;
}
function normalizePdfJsLine(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) text = text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
  return text.replace(/\s+([，。；：！？、）》」』,.!?])/g, '$1').replace(/([（《「『])\s+/g, '$1');
}
async function extractPdfJsPages(buffer) {
  try {
    pdfJsLoader ||= import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjs = await pdfJsLoader;
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = new Map();
      for (const item of content.items || []) {
        const text = String(item.str || '').trim();
        if (!text) continue;
        const x = Number(item.transform?.[4] || 0);
        const y = Math.round(Number(item.transform?.[5] || 0) / 2) * 2;
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x, text });
      }
      const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => normalizePdfJsLine(items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))).filter(Boolean).join('\n');
      const viewport = page.getViewport({ scale: 1 });
      pages.push({ page: pageNumber, heading: text.split(/[\n.!?。！？]/)[0]?.slice(0, 70) || `Page ${pageNumber}`, width: viewport.width, height: viewport.height, text, extraction: text ? 'native-pdfjs' : 'ocr-pending', source: text ? 'native-pdfjs' : 'ocr', nativeQuality: { score: text ? 0.94 : 0, engine: 'pdfjs' } });
    }
    return pages.length ? pages : null;
  } catch (error) {
    return null;
  }
}
function normalizeFormula(raw) {
  let latex = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fff]{2,}/.test(latex)) latex = latex.replace(/[二五]/g, ' = ');
  latex = latex.replace(/−/g, '-').replace(/×/g, '\\times ').replace(/÷/g, '\\div ').replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/∞/g, '\\infty ');
  latex = latex.replace(/\b4z\b/g, 'Az').replace(/\b5\s+E\b/g, 'b \\in').replace(/\b4\s+E\b/g, 'A \\in').replace(/\b4w\b/g, 'Aw');
  latex = latex.replace(/\bE\s+C\b/g, '\\in \\mathbb{C}').replace(/\bE\s+R\b/g, '\\in \\mathbb{R}');
  latex = latex.replace(/\\in\s+C[“"^*×xmn+]{0,10}/g, '\\in \\mathbb{C}^{n}').replace(/Az\s*=\s*5/g, 'Az = b').replace(/Az\s*=\s*z/g, 'Az = ' + String.fromCharCode(92) + 'lambda z').replace(/\b4Hw\b/g, 'A^H w');
  latex = latex.replace(/∑/g, '\\sum ').replace(/Σ/g, '\\sum ').replace(/√/g, '\\sqrt ').replace(/∈/g, '\\in ');
  latex = latex.replace(/(?<!\\)\b(alpha|beta|gamma|lambda|mu|omega)\b/gi, m => `\\${m.toLowerCase()}`);
  latex = latex.replace(/\s+=\s+/g, ' = ');
  return latex;
}
function isFormulaLike(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 120) return false;
  if (/%|\b(?:for|while|function|fprintf|import|print|single|struct|pack|unpack|logspace|rel_err|f[12]|x_vals)\b/i.test(value)) return false;
  const hasRelation = /[=∈≤≥≠≈]|\bE\s+C\b/.test(value);
  const hasMathToken = /[A-Za-z0-9][\s]*[A-Za-z0-9]|[+\-*/^_]|\\(frac|sqrt|sum|in|mathbb)|\b(?:4z|4w|minz)\b/.test(value);
  const hasMathOperator = /[=∈≤≥≠≈+\-*/^_]|\\(frac|sqrt|sum|in|mathbb)/.test(value);
  const chineseCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const chineseRatio = chineseCount / Math.max(1, value.length);
  return hasRelation && hasMathToken && hasMathOperator && chineseCount <= 1 && chineseRatio < 0.2;
}
function formulaFragments(chunk) {
  const patterns = [
    /\b4\s+E\s+C[“"^*×xmn+]{0,10}/g,
    /\b5\s+E\s+C[“"^*×xmn+]{0,10}/g,
    /\b4z\s*[二五=]\s*5\b/g,
    /\b4z\s*五\s*z\b/g,
    /\b4H?\s*w\s*[一-]\s*u\b/g,
    /\bminzecn[^,。]{0,70}/g,
    /\b(?:Babs|Brel|Era)\s*\([^)]*\)\s*[:：]\s*[二=][^,。]{0,45}/g
  ];
  const matches = [];
  for (const pattern of patterns) for (const match of chunk.matchAll(pattern)) matches.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
  return matches.sort((a, b) => a.start - b.start).filter((match, index, all) => index === 0 || match.start >= all[index - 1].end);
}
function splitPageBlocks(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [{ type: 'paragraph', text: '' }];
  const chunks = source.split(/(?<=[。！？.!?；;])\s+/).filter(Boolean); const blocks = [];
  for (const chunk of chunks) {
    const fragments = formulaFragments(chunk);
    if (fragments.length) {
      let cursor = 0;
      for (const fragment of fragments) {
        const before = chunk.slice(cursor, fragment.start).trim(); if (before) blocks.push({ type: 'paragraph', text: before });
        blocks.push({ type: 'formula', source: fragment.raw.trim(), latex: normalizeFormula(fragment.raw), confidence: /�|[4O0]{2,}/.test(fragment.raw) ? 0.52 : 0.78 });
        cursor = fragment.end;
      }
      const after = chunk.slice(cursor).trim(); if (after) blocks.push({ type: 'paragraph', text: after });
    } else if (isFormulaLike(chunk)) {
      blocks.push({ type: 'formula', source: chunk.trim(), latex: normalizeFormula(chunk), confidence: /�|[4O0]{2,}/.test(chunk) ? 0.52 : 0.7 });
    }
    else blocks.push({ type: 'paragraph', text: chunk.trim() });
  }
  return blocks.length ? blocks : [{ type: 'paragraph', text: source }];
}
function pageSource(page) {
  if (page?.source === 'native-pdf' || page?.extraction === 'native') return 'native-pdf';
  if (page?.source === 'ocr' || page?.extraction === 'ocr') return 'ocr';
  return 'text';
}
function decoratePage(page) {
  const source = pageSource(page);
  const rawBlocks = splitPageBlocks(page.text);
  const blocks = rawBlocks.map((block, index) => ({
    ...block,
    id: `p${page.page}-b${index + 1}`,
    bbox: block.bbox || null,
    provenance: {
      source,
      parser: block.type === 'formula' ? 'heuristic-formula' : source === 'native-pdf' ? 'pdf-text' : source === 'ocr' ? 'tesseract' : 'text'
    }
  }));
  return {
    ...page,
    source,
    extraction: page.extraction || source,
    bbox: page.bbox || null,
    blocks,
    formulas: blocks.filter(block => block.type === 'formula')
  };
}
function decoratePages(pages) {
  return (pages || []).map(decoratePage);
}
function decorateExistingPages() {
  let changed = false;
  for (const doc of db.documents || []) {
    if (!Array.isArray(doc.content)) continue;
    doc.content = doc.content.map(page => {
      const next = decoratePage(page);
      if (JSON.stringify(next) !== JSON.stringify(page)) changed = true;
      return next;
    });
  }
  if (changed) save();
}
decorateExistingPages();
function attachExistingSources() {
  let changed = false;
  for (const doc of db.documents || []) {
    if (doc.sourceFile) continue;
    const match = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).find(entry => entry.isFile() && entry.name.startsWith(`${doc.id}-`));
    if (match) { doc.sourceFile = match.name; changed = true; }
  }
  if (changed) save();
}
attachExistingSources();
function findPdftoppm() {
  const candidates = [
    process.env.PDFTOPPM_PATH,
    process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe') : null,
    'pdftoppm'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (candidate === 'pdftoppm' || fs.existsSync(candidate)) { if (candidate === 'pdftoppm') execFileSync(candidate, ['-h'], { stdio: 'ignore' }); return candidate; } } catch { /* try next candidate */ }
  }
  return null;
}
function ocrAvailable() { return Boolean(tesseract && chiSimData && findPdftoppm()); }
function parserStatus() {
  return {
    pdfjs: fs.existsSync(path.join(PUBLIC, 'vendor', 'pdfjs', 'pdf.min.mjs')) && fs.existsSync(path.join(PUBLIC, 'vendor', 'pdfjs', 'pdf.worker.min.mjs')),
    nativeText: true,
    pageImage: Boolean(findPdftoppm()),
    ocr: ocrAvailable(),
    layoutParser: false,
    formulaRecognizer: 'heuristic'
  };
}
function normalizeOcrText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\s+([，。！？：；、,.!?;:])/g, '$1')
    .replace(/([（(])\s+/g, '$1').replace(/\s+([）)])/g, '$1');
}
function formulaOcrEligible(page) {
  const text = String(page?.text || '');
  return /矩阵|方程|误差|条件数|稳定|浮点|舍入|截断|分解|奇异|线性|公式|内积|Taylor|Heron|Sterbenz|rounding|error|condition|stability|matrix|algorithm|equation|factor/i.test(text);
}
function prepareFormulaOcrPages(pages) {
  const source = Array.isArray(pages) ? pages : [];
  const eligible = source.filter(formulaOcrEligible);
  const selected = new Set((eligible.length ? eligible : source).slice(0, 8).map(page => page.page));
  return source.map(page => ({ ...page, formulaOcrSkip: !selected.has(page.page) }));
}
async function renderPdfPageImage(doc, pageNumber) {
  if (!doc?.sourceFile || !findPdftoppm()) return null;
  const source = path.join(UPLOAD_DIR, doc.sourceFile);
  const page = Math.max(1, Number(pageNumber) || 1);
  if (!fs.existsSync(source) || page > Number(doc.pages || 1)) return null;
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-page-'));
  const outputBase = path.join(tempDir, 'page');
  try {
    await execFileAsync(findPdftoppm(), ['-f', String(page), '-l', String(page), '-png', '-r', '150', '-singlefile', source, outputBase], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const imagePath = `${outputBase}.png`;
    return fs.existsSync(imagePath) ? fs.readFileSync(imagePath) : null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
async function ocrPdfPages(buffer, pages, options = {}) {
  const force = Boolean(options.force);
  if (!ocrAvailable()) return { pages, extraction: 'pdf-ocr-unavailable', ocr: { available: false, message: 'Installable OCR dependencies or pdftoppm were not available.' } };
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-ocr-'));
  const pdfPath = path.join(tempDir, 'source.pdf'); fs.writeFileSync(pdfPath, buffer);
  let worker = null;
  let recognized = 0;
  try {
    worker = await tesseract.createWorker('chi_sim', 1, { langPath: chiSimData.langPath });
    for (const page of pages) {
      if (force && page.formulaOcrSkip) continue;
      // The normal text pass must preserve selectable PDF text. The formula
      // pass deliberately sets force=true so that math glyphs missing from a
      // PDF text layer can still be recovered from the rendered page image.
      if (!force && page.text && !page.text.startsWith('No selectable text')) continue;
      const outputBase = path.join(tempDir, `page-${page.page}`);
      await execFileAsync(findPdftoppm(), ['-f', String(page.page), '-l', String(page.page), '-png', '-r', String(force ? 220 : 300), '-singlefile', pdfPath, outputBase], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const imagePath = `${outputBase}.png`;
      if (!fs.existsSync(imagePath)) continue;
      const result = await worker.recognize(imagePath);
      const text = normalizeOcrText(result.data?.text || '');
      if (text) {
        page.text = text;
        page.heading = text.split(/[.!?。！？\n]/)[0].slice(0, 70) || page.heading;
        page.extraction = 'ocr';
        page.source = 'ocr';
        page.ocrQuality = { confidence: Number(result.data?.confidence || 0) / 100, dpi: 300, engine: 'tesseract.js' };
        recognized += 1;
      }
    }
  } catch (error) {
    return { pages, extraction: 'pdf-ocr-error', ocr: { available: true, engine: 'tesseract.js', language: 'chi_sim', pagesRecognized: recognized, error: error.message } };
  } finally {
    if (worker) await worker.terminate();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const nativePages = pages.filter(page => page.text && !page.text.startsWith('No selectable text')).length;
  return { pages, extraction: recognized ? 'pdf-ocr' : nativePages ? 'pdf-native' : 'pdf-no-text', ocr: { available: true, engine: 'tesseract.js', language: 'chi_sim', pagesRecognized: recognized } };
}
async function ocrImageBuffer(buffer, name = 'image') {
  if (!tesseract || !chiSimData) return { text: '', available: false, reason: 'tesseract-unavailable' };
  const tempDir = fs.mkdtempSync(path.join(RUNTIME_TMP, 'studyagent-image-')); const imagePath = path.join(tempDir, `source-${fileExtension(name) || 'img'}`); fs.writeFileSync(imagePath, buffer); let worker = null;
  try { worker = await tesseract.createWorker('chi_sim', 1, { langPath: chiSimData.langPath }); const result = await worker.recognize(imagePath); return { text: normalizeOcrText(result.data?.text || ''), available: true, confidence: Number(result.data?.confidence || 0) / 100 }; }
  catch (error) { return { text: '', available: true, reason: error.message }; }
  finally { if (worker) await worker.terminate(); fs.rmSync(tempDir, { recursive: true, force: true }); }
}
async function reprocessDocument(doc) {
  if (!doc?.sourceFile) throw new Error('Original PDF file is unavailable for this document.');
  const source = path.join(UPLOAD_DIR, doc.sourceFile);
  if (!fs.existsSync(source)) throw new Error('Original PDF file is unavailable for this document.');
  const raw = fs.readFileSync(source);
  const legacyNative = extractPdfPages(raw); const pdfJsNative = await extractPdfJsPages(raw); const native = pdfJsNative || legacyNative || [{ page: 1, heading: 'Page 1', text: 'No selectable text was found on this page.' }];
  const extracted = await ocrPdfPages(raw, native); const formulaSourcePages = legacyNative || pdfJsNative || native; const legacyFormulaPages = legacyNative ? decoratePages(legacyNative.map(page => ({ ...page }))) : []; const formulaExtracted = await ocrPdfPages(raw, prepareFormulaOcrPages(formulaSourcePages), { force: true });
  const pages = decoratePages(extracted.pages);
  const formulaPages = decoratePages(formulaExtracted.pages);
  for (const [index, page] of pages.entries()) { const candidates = [...(formulaPages[index]?.formulas || []), ...(legacyFormulaPages[index]?.formulas || [])].filter((formula, formulaIndex, all) => all.findIndex(item => item.latex === formula.latex && item.source === formula.source) === formulaIndex); if (candidates.length && !(page.formulas || []).length) { const appended = candidates.map((formula, formulaIndex) => ({ ...formula, id: `${page.page}-formula-${formulaIndex + 1}`, provenance: { source: 'native-pdfjs+heuristic-formula', parser: 'heuristic-formula' } })); page.blocks = [...(page.blocks || []), ...appended]; page.formulas = appended; } }
  if (extracted.extraction === 'pdf-ocr' && pages[0] && doc.title) pages[0].heading = doc.title;
  doc.content = pages; doc.pages = pages.length; doc.extraction = extracted.extraction; doc.ocr = extracted.ocr;
  doc.tags = ['新上传', ...(extracted.extraction === 'pdf-ocr' ? ['OCR'] : [])];
  const structured = await parseStructuredDocument({ name: doc.sourceFile, buffer: raw, parsePdf: () => pages, ocrImage: (buffer, imageName) => ocrImageBuffer(buffer, imageName) });
  const reprocessCourseId = doc.courseId || learningDb.listCourses().find(course => course.name === '未分类')?.id || null; doc.courseId = reprocessCourseId; doc.course = learningDb.listCourses().find(course => course.id === reprocessCourseId)?.name || doc.course || '未分类';
  learningDb.upsertDocument({ document: { id: doc.id, title: doc.title, fileType: 'PDF', sourcePath: doc.sourceFile, createdAt: new Date().toISOString(), metadata: { ...(doc.metadata || {}), reprocessedWith: pdfJsNative ? 'pdfjs-text-layer' : 'legacy-pdf-parser' }, legacy: doc }, sections: structured.sections, chunks: structured.chunks, courseId: reprocessCourseId });
  ragService.indexChunks(structured.chunks); save();
  return doc;
}
async function correctDocumentFormula(doc, input = {}) {
  const pageNumber = Number(input.page || 0); const formulaId = String(input.formulaId || '').trim(); const latex = String(input.latex || '').trim();
  if (!pageNumber || !formulaId || !latex || latex.length > 4000) throw Object.assign(new Error('公式页码、公式 ID 和 LaTeX 内容不能为空，且 LaTeX 长度不能超过 4000。'), { code: 'INVALID_FORMULA_CORRECTION' });
  const page = doc?.content?.find(item => Number(item.page) === pageNumber); const formula = page?.blocks?.find(block => block.id === formulaId && block.type === 'formula') || page?.formulas?.find(block => block.id === formulaId);
  if (!page || !formula) throw Object.assign(new Error('找不到需要修正的公式。'), { code: 'FORMULA_NOT_FOUND' });
  formula.latex = latex; formula.confidence = 1; formula.provenance = { ...(formula.provenance || {}), corrected: true, parser: 'user-correction' };
  page.formulas = page.blocks?.length ? page.blocks.filter(block => block.type === 'formula') : (page.formulas || [formula]);
  const source = doc.sourceFile ? path.join(UPLOAD_DIR, doc.sourceFile) : null;
  if (source && fs.existsSync(source)) {
    const raw = fs.readFileSync(source); const structured = await parseStructuredDocument({ name: doc.sourceFile, buffer: raw, parsePdf: () => doc.content, ocrImage: (buffer, imageName) => ocrImageBuffer(buffer, imageName) });
    const courseId = doc.courseId || learningDb.listCourses().find(course => course.name === '未分类')?.id || null;
    learningDb.upsertDocument({ document: { id: doc.id, title: doc.title, fileType: 'PDF', sourcePath: doc.sourceFile, createdAt: new Date().toISOString(), metadata: { ...(doc.metadata || {}), formulaCorrections: Number(doc.metadata?.formulaCorrections || 0) + 1 }, legacy: doc }, sections: structured.sections, chunks: structured.chunks, courseId });
    ragService.indexChunks(structured.chunks); doc.metadata = { ...(doc.metadata || {}), formulaCorrections: Number(doc.metadata?.formulaCorrections || 0) + 1 }; doc.structure = { sections: structured.sections.length, chunks: structured.chunks.length, parser: 'structured-document-pipeline' };
  }
  save(); return { documentId: doc.id, page: pageNumber, formulaId, formula };
}
async function analyzeDocumentVision(doc, input = {}) {
  const ext = fileExtension(doc?.sourceFile || doc?.title || '');
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw Object.assign(new Error('Vision 文档分析目前只适用于图片资料。'), { code: 'VISION_IMAGE_REQUIRED' });
  const source = doc?.sourceFile ? path.join(UPLOAD_DIR, doc.sourceFile) : null;
  if (!source || !fs.existsSync(source)) throw Object.assign(new Error('原始图片文件不可用，请重新上传。'), { code: 'DOCUMENT_FILE_UNAVAILABLE' });
  const config = selectModelConfig(input); if (!config || !config.apiKey) throw Object.assign(new Error('Vision 需要先在设置中配置支持视觉的远程模型。'), { code: 'REMOTE_MODEL_REQUIRED', status: 503 });
  const raw = fs.readFileSync(source); const imageData = `data:${DOCUMENT_MIME_TYPES[ext] || 'image/png'};base64,${raw.toString('base64')}`; const result = await createProvider(config).vision({ imageData, prompt: input.prompt || '请识别这张学习资料图片中的文字、表格、图表和数学公式；使用结构清晰的中文回答，公式尽量使用 LaTeX。', model: input.model });
  const structured = await parseStructuredDocument({ name: doc.sourceFile, buffer: raw, ocrImage: (buffer, imageName) => ocrImageBuffer(buffer, imageName), visionImage: async () => ({ text: result.text || '', provider: result.provider, model: result.model }) });
  const courseId = doc.courseId || learningDb.listCourses().find(course => course.name === '未分类')?.id || null; const sections = structured.sections; doc.content = sections.map((item, index) => ({ page: item.locator.page || index + 1, heading: item.title || 'Image OCR', text: item.content, source: 'structured-pipeline', extraction: 'vision', locator: item.locator, blocks: item.blocks || [] })); doc.pages = doc.content.length; doc.metadata = { ...(doc.metadata || {}), vision: true, visionProvider: result.provider, visionModel: result.model, visionAnalyzedAt: new Date().toISOString() }; doc.structure = { sections: structured.sections.length, chunks: structured.chunks.length, parser: 'structured-document-pipeline' };
  learningDb.upsertDocument({ document: { id: doc.id, title: doc.title, fileType: doc.fileType || doc.type || ext.toUpperCase(), sourcePath: doc.sourceFile, createdAt: new Date().toISOString(), metadata: { ...(doc.metadata || {}), courseId, workspaceId: doc.workspaceId || 'workspace-personal' }, legacy: doc }, sections: structured.sections, chunks: structured.chunks, courseId }); ragService.indexChunks(structured.chunks); save(); return { documentId: doc.id, provider: result.provider, model: result.model, text: result.text || '', pages: doc.pages, metadata: doc.metadata };
}
function retrieve(query, docId) {
  const terms = new Set(tokenize(query)); const docs = docId ? db.documents.filter(d => d.id === docId) : db.documents;
  return docs.flatMap(d => d.content.map(p => ({ doc: d, page: p.page, heading: p.heading, text: p.text, score: [...terms].filter(t => tokenize(p.text).includes(t)).length }))).sort((a, b) => b.score - a.score).slice(0, 5);
}
function citations(items) { return items.filter(x => x.score > 0 || items.length === 1).slice(0, 3).map((x, i) => ({ id: i + 1, documentId: x.doc.id, document: x.doc.title, page: x.page, label: `${x.doc.title} · Page ${x.page}`, quote: x.text.slice(0, 130) + (x.text.length > 130 ? '…' : '') })); }
async function importStructuredDocument(payload) {
  const name = String(payload.name || '').trim(); if (!name) throw Object.assign(new Error('A file name is required'), { code: 'INVALID_DOCUMENT' });
  const ext = fileExtension(name); const raw = payload.base64 ? Buffer.from(payload.base64, 'base64') : Buffer.from(payload.content || '', 'utf8');
  let extracted = null; let sourcePages = null; let formulaPages = null;
  if (ext === 'pdf') { const legacyNative = extractPdfPages(raw); const pdfJsNative = await extractPdfJsPages(raw); const native = pdfJsNative || legacyNative || [{ page: 1, heading: 'Page 1', text: 'No selectable text was found on this page.' }]; extracted = await ocrPdfPages(raw, native); sourcePages = decoratePages(extracted.pages); const formulaSourcePages = legacyNative || pdfJsNative || native; const legacyFormulaPages = legacyNative ? decoratePages(legacyNative.map(page => ({ ...page }))) : []; const formulaExtracted = await ocrPdfPages(raw, prepareFormulaOcrPages(formulaSourcePages), { force: true }); formulaPages = decoratePages(formulaExtracted.pages); formulaPages = formulaPages.map((page, index) => ({ ...page, formulas: [...(page.formulas || []), ...(legacyFormulaPages[index]?.formulas || [])].filter((formula, formulaIndex, all) => all.findIndex(item => item.latex === formula.latex && item.source === formula.source) === formulaIndex) })); }
  const parsed = await parseStructuredDocument({ name, buffer: raw, parsePdf: () => sourcePages || [], ocrImage: (buffer, imageName) => ocrImageBuffer(buffer, imageName) });
  const documentId = uid('doc'); const sourceFile = `${documentId}-${name.replace(/[^\w.-]+/g, '_')}`; fs.writeFileSync(path.join(UPLOAD_DIR, sourceFile), raw);
  const courseId = payload.courseId || learningDb.listCourses().find(course => course.name === payload.course)?.id || learningDb.listCourses().find(course => course.name === '未分类')?.id || null; const course = learningDb.listCourses().find(item => item.id === courseId);
  const pages = ext === 'pdf' ? sourcePages : parsed.sections.map((item, index) => ({ page: item.locator.page || item.locator.slide || item.locator.sheet || index + 1, heading: item.title || `Section ${index + 1}`, text: item.content, source: 'structured-pipeline', type: item.kind, locator: item.locator, blocks: item.blocks || [] }));
  if (ext === 'pdf') for (const [index, page] of pages.entries()) { const candidates = formulaPages[index]?.formulas || []; if (candidates.length && !(page.formulas || []).length) { const appended = candidates.map((formula, formulaIndex) => ({ ...formula, id: `${page.page}-formula-${formulaIndex + 1}`, provenance: { source: 'native-pdfjs+heuristic-formula', parser: 'heuristic-formula' } })); page.blocks = [...(page.blocks || []), ...appended]; page.formulas = appended; } }
  const doc = { id: documentId, title: name.replace(/\.[^.]+$/, ''), type: parsed.fileType, fileType: parsed.fileType, size: `${Math.max(1, Math.round(raw.length / 1024))} KB`, pages: pages.length, course: course?.name || payload.course || '未分类', courseId, workspaceId: 'workspace-personal', progress: 0, annotations: 0, questions: 0, uploadedAt: 'Just now', lastRead: 'Not started', tags: ['新上传', ...(parsed.metadata.ocr ? ['OCR'] : [])], content: pages, extraction: extracted?.extraction || 'structured', ocr: extracted?.ocr || parsed.metadata.ocr ? { available: true } : null, sourceFile, metadata: parsed.metadata, structure: { sections: parsed.sections.length, chunks: parsed.chunks.length, parser: 'structured-document-pipeline' } };
  learningDb.upsertDocument({ document: { id: documentId, title: doc.title, fileType: parsed.fileType, sourcePath: sourceFile, createdAt: new Date().toISOString(), metadata: { ...parsed.metadata, courseId, workspaceId: 'workspace-personal' }, legacy: doc }, sections: parsed.sections, chunks: parsed.chunks, courseId }); ragService.indexChunks(parsed.chunks); db.documents.unshift(doc); save(); return doc;
}
function localAnswer(query, docId, selection = '', language = db.settings?.language === 'en' ? 'en' : 'zh', retrieved = []) {
  const hits = retrieved.length ? retrieved.map(item => ({ doc: { id: item.documentId, title: item.documentTitle }, page: item.locator?.page || item.locator?.slide || item.locator?.sheet, heading: item.section || item.citation, text: item.text, score: item.score })) : retrieve(query + ' ' + selection, docId); const refs = citations(hits.length ? hits : retrieve('', docId).slice(0, 2));
  const q = (query + ' ' + selection).toLowerCase(); const english = language === 'en'; let answer = english ? 'Here is the relevant evidence from the current material:' : '我在当前资料中找到的相关证据如下：';
  if ((q.includes('gaussian') || q.includes('高斯') || q.includes('消元')) && (q.includes('unstable') || q.includes('stability') || q.includes('不稳定') || q.includes('稳定'))) answer = english ? 'Gaussian elimination can become numerically unstable when it uses a very small pivot: division by that pivot amplifies round-off error, and subsequent elimination steps can magnify the error further. Partial pivoting swaps in a larger available pivot, reducing this amplification. Keep the concepts separate: the condition number describes sensitivity of the problem itself, while pivoting improves the stability of the algorithm.' : '高斯消元可能出现数值不稳定，常见原因是选到了绝对值很小的主元：除以小主元会放大舍入误差，后续消元还可能继续放大这种误差。部分选主元通过交换行选择更大的可用主元，从而减小误差放大。要区分两件事：条件数描述问题本身对扰动的敏感性，而选主元主要改善算法执行过程的稳定性。';
  else if (q.includes('pivot') || q.includes('主元')) answer = english ? 'Pivoting chooses a safer pivot before each elimination step. Partial pivoting usually selects the largest-magnitude entry in the current column and swaps its row into place, avoiding division by a tiny number. It controls algorithmic error growth; it does not make an inherently ill-conditioned problem well-conditioned.' : '选主元是在每一步消元前选择更安全的主元。部分选主元通常在当前列中选择绝对值最大的元素并交换行，避免除以很小的数。它控制的是算法误差增长，并不会把一个本身病态的问题变成良态问题。';
  else if (q.includes('difference') || q.includes('区别') || q.includes('backward error') || q.includes('forward error') || q.includes('forward') && q.includes('backward')) answer = english ? 'Forward error asks how far the computed answer is from the exact answer. Backward error asks how much the input must change to make the computed answer exact. An algorithm can be backward stable while forward error remains large when the original problem has a large condition number. Memory aid: Forward looks at the answer; backward looks at the problem.' : 'Forward error 关注“算出来的结果离真值有多远”；Backward error 关注“要把这个结果解释成精确解，输入需要改动多少”。一个算法可以 backward stable，但如果原问题 condition number 很大，forward error 仍可能很大。记忆方法：Forward 看答案，Backward 看问题。';
  else if (q.includes('condition') || q.includes('条件数')) answer = english ? 'The condition number measures how sensitive a problem is to small input perturbations. A large value means the problem is ill-conditioned; this is different from an unstable algorithm. Separate the algorithm\'s backward error from the problem\'s condition number.' : 'Condition number 描述问题本身对输入扰动的敏感程度。它大，说明问题 ill-conditioned；这不等同于算法不稳定。判断时把算法的 backward error 与问题的 condition number 分开看。';
  else if (q.includes('summar') || q.includes('总结')) answer = hits.slice(0, 3).map(h => english ? `${h.heading}: ${h.text}` : `${h.heading}：${h.text}`).join('\n\n') || (english ? 'There is no extractable text in the current scope.' : '当前范围暂无可总结的文本。');
  else if (selection) answer = english ? `The core idea of this passage is: ${selection.slice(0, 260)}. In other words, first identify whether it describes answer error, input perturbation, or problem sensitivity, then separate the responsibilities of the algorithm and the problem.` : `这段话的核心是：${selection.slice(0, 260)}。换句话说，先识别它描述的是“答案误差”“输入扰动”还是“问题敏感度”，再判断算法与问题各自的责任。`;
  else if (hits[0]) answer = english ? `${hits[0].heading}: ${hits[0].text}` : `${hits[0].heading}：${hits[0].text}`;
  return { answer, citations: refs, language, knowledge_points: ['Forward Error', 'Backward Error', 'Condition Number'].filter(x => q.includes(x.toLowerCase()) || hits.some(h => h.text.toLowerCase().includes(x.toLowerCase()))).slice(0, 3), confidence: hits[0]?.score ? 0.92 : 0.68, suggested_actions: english ? ['Create a knowledge card', 'Review this concept tomorrow'] : ['Create a knowledge card', 'Review this concept tomorrow'] };
}
function learningSummary(courseId = null) { const today = new Date().toISOString().slice(0, 10); const questions = learningDb.listQuestions({ courseId, limit: 200 }).filter(item => String(item.timestamp || '').slice(0, 10) === today); const concepts = learningDb.listConcepts(courseId); const progress = learningDb.listProgress({ courseId, limit: 200 }); const errors = learningDb.listErrors({ courseId, limit: 100 }).filter(item => String(item.created_at || '').slice(0, 10) === today); const graph = learningDb.listGraph(courseId); const labels = new Map(graph.nodes.map(node => [node.id, node.label])); const associations = graph.edges.map(edge => ({ source: labels.get(edge.source) || edge.source, target: labels.get(edge.target) || edge.target, type: edge.type })); return { date: today, source: 'sqlite-learning-memory', questionsToday: questions.length, learned: concepts.filter(item => String(item.last_seen || '').slice(0, 10) === today).slice(0, 12).map(item => ({ name: item.name, mastery: item.masteryScore, status: item.status })), associations: associations.slice(0, 20), weakConcepts: concepts.filter(item => item.masteryScore < 0.55).slice(0, 8).map(item => ({ name: item.name, mastery: item.masteryScore, status: item.status })), errorsToday: errors.length, progress, recentQuestions: questions.slice(0, 8).map(item => ({ question: item.question, concepts: item.concepts, timestamp: item.timestamp })) }; }
function learningQuiz({ courseId = null, concept = '', count = 3 } = {}) { const requested = String(concept || '').trim(); const fallback = learningDb.listConcepts(courseId).find(item => item.masteryScore < 0.55)?.name || learningDb.listConcepts(courseId)[0]?.name || '当前资料'; const topic = requested || fallback; const retrieved = ragService.context(topic, { courseId, limit: Math.max(4, Number(count) * 2) }); const unique = []; const seen = new Set(); for (const item of retrieved) { const key = `${item.documentId}:${item.locator?.page || item.locator?.slide || item.locator?.sheet || item.section}`; if (!seen.has(key)) { seen.add(key); unique.push(item); } if (unique.length >= Math.max(1, Math.min(8, Number(count) || 3))) break; } return { topic, mode: 'retrieval-grounded-local', items: unique.map((item, index) => ({ id: `quiz-${Date.now()}-${index}`, question: `根据${item.citation}，请解释“${topic}”的核心含义，并说明它与这段资料的关系。`, answer: item.text, citation: item.citation, documentId: item.documentId, locator: item.locator })) }; }

function parsePath(reqUrl) { return new URL(reqUrl, 'http://localhost'); }
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); const method = req.method;
  if (method === 'GET' && url.pathname === '/api/ocr/status') return json(res, 200, { available: ocrAvailable(), engine: ocrAvailable() ? 'tesseract.js' : null, language: ocrAvailable() ? 'chi_sim' : null, renderer: findPdftoppm() ? 'pdftoppm' : null });
  if (method === 'GET' && url.pathname === '/api/parser/status') return json(res, 200, parserStatus());
  if (method === 'POST' && url.pathname === '/api/agent/plan') { const b = await body(req); const document = findDoc(b.documentId); return json(res, 200, learningOrchestrator.prepare({ question: b.message || '', body: b, document, kind: b.kind || 'text', scope: learningScope(b, document) })); }
  if (method === 'GET' && url.pathname === '/api/models/providers') return json(res, 200, { providers: publicProviders() });
  if (method === 'GET' && url.pathname === '/api/models/configs') return json(res, 200, { configs: modelConfigs.map(publicModelConfig), defaultId: defaultModelConfig()?.id || null });
  if (method === 'POST' && url.pathname === '/api/models/configs') {
    const input = await body(req); const previous = input.id ? modelConfigs.find(config => config.id === input.id) : null;
    const config = normalizeModelConfig(input, previous || {});
    if (!config.provider || !config.model) return error(res, 'INVALID_MODEL_CONFIG', 'Provider 和 Model 不能为空');
    if (config.isDefault) modelConfigs = modelConfigs.map(item => ({ ...item, isDefault: false }));
    const index = modelConfigs.findIndex(item => item.id === config.id); if (index >= 0) modelConfigs[index] = config; else modelConfigs.push(config);
    persistModelConfigs(); return json(res, 200, publicModelConfig(config));
  }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'models' && parts[2] === 'configs' && parts[3]) {
    modelConfigs = modelConfigs.filter(config => config.id !== parts[3]); persistModelConfigs(); return json(res, 200, { ok: true });
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'models' && parts[2] === 'configs' && parts[4] === 'test') {
    const config = modelConfigs.find(item => item.id === parts[3]); if (!config) return error(res, 'MODEL_CONFIG_NOT_FOUND', '模型配置不存在');
    if (!config.apiKey) return json(res, 200, { ok: false, error: { code: 'API_KEY_REQUIRED', message: '当前模型配置没有 API Key' } });
    try { return json(res, 200, { ...(await createProvider(config).testConnection()), ok: true }); } catch (e) { return json(res, e.status || 200, { ok: false, error: { code: e.code || 'CONNECTION_FAILED', message: safeMessage(e, '连接模型服务失败') } }); }
  }
  if (method === 'POST' && url.pathname === '/api/models/discover') {
    const input = await body(req); const previous = input.id ? modelConfigs.find(item => item.id === input.id) : null; const config = normalizeModelConfig(input, previous || {});
    if (!config.apiKey) return error(res, 'API_KEY_REQUIRED', '刷新模型列表前请先填写 API Key');
    try { const models = await createProvider(config).listModels(); modelListCache.set(config.provider, models); return json(res, 200, { models, source: 'remote' }); } catch (e) { return json(res, 200, { models: fallbackModels(config.provider), source: 'fallback', error: { code: e.code || 'MODEL_LIST_FAILED', message: safeMessage(e, '动态模型列表获取失败，已使用本地列表') } }); }
  }
  if (method === 'GET' && url.pathname === '/api/documents') return json(res, 200, learningDb.listDocuments().map(clientDocumentView));
  if (method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, learningDb.listWorkspaces());
  if (method === 'POST' && url.pathname === '/api/workspaces') { const b = await body(req); if (!b.name) return error(res, 'INVALID_WORKSPACE', '工作区名称不能为空'); return json(res, 201, learningDb.createWorkspace(b.name, b.description || '')); }
  if (method === 'GET' && url.pathname === '/api/courses') return json(res, 200, learningDb.listCourses(url.searchParams.get('workspaceId') || 'workspace-personal'));
  if (method === 'POST' && url.pathname === '/api/courses') { const b = await body(req); if (!b.name) return error(res, 'INVALID_COURSE', '课程名称不能为空'); return json(res, 201, learningDb.createCourse(b.name, b.workspaceId || 'workspace-personal', b.description || '')); }
  if (method === 'GET' && url.pathname === '/api/conversations') return json(res, 200, { conversations: learningDb.listConversations({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 50) }) });
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'conversations' && parts[2] && parts[3] === 'messages') return json(res, 200, { conversationId: parts[2], messages: learningDb.listConversationMessages(parts[2], Number(url.searchParams.get('limit') || 200)) });
  if (method === 'GET' && url.pathname === '/api/learning/documents') return json(res, 200, learningDb.listDocuments({ courseId: url.searchParams.get('courseId') || undefined, workspaceId: url.searchParams.get('workspaceId') || undefined }));
  if (method === 'POST' && url.pathname === '/api/learning/reindex') { const b = await body(req); const config = selectModelConfig(b); if (!config || !config.apiKey) return error(res, 'REMOTE_MODEL_REQUIRED', '远程 Embedding 重建索引需要先配置模型服务', { status: 503 }); const requestedIds = Array.isArray(b.documentIds) ? b.documentIds.filter(Boolean) : []; const documents = requestedIds.length ? requestedIds.map(id => learningDb.getDocument(id)).filter(Boolean) : learningDb.listDocuments({ courseId: b.courseId || undefined, workspaceId: b.workspaceId || undefined }); const chunks = documents.flatMap(document => learningDb.getDocumentContext(document.id)); if (!chunks.length) return error(res, 'NO_CHUNKS', '指定范围没有可建立索引的内容'); try { const result = await ragService.indexChunksWithProvider(chunks, input => createProvider(config).embed(input), b.embeddingModel || config.embeddingModel || config.model); return json(res, 200, { ...result, scope: requestedIds.length ? 'documents' : b.courseId ? 'course' : 'workspace', documentIds: documents.map(document => document.id) }); } catch (e) { return error(res, e.code || 'REINDEX_FAILED', safeMessage(e, '远程 Embedding 重建失败'), { status: e.status || 502 }); } }
  if (method === 'GET' && url.pathname === '/api/learning/progress') return json(res, 200, { progress: learningDb.listProgress({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 100) }) });
  if (method === 'GET' && url.pathname === '/api/learning/summary') return json(res, 200, learningSummary(url.searchParams.get('courseId') || null));
  if (method === 'POST' && url.pathname === '/api/learning/quiz') { const b = await body(req); return json(res, 200, learningQuiz({ courseId: b.courseId || null, concept: b.concept || '', count: b.count || 3 })); }
  if (method === 'GET' && url.pathname === '/api/learning/quiz/attempts') return json(res, 200, { attempts: learningDb.listQuizAttempts({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 50) }) });
  if (method === 'POST' && url.pathname === '/api/learning/quiz/attempt') { const b = await body(req); if (!Array.isArray(b.answers) || !b.answers.length) return error(res, 'INVALID_QUIZ_ATTEMPT', '至少需要提交一道复习题的作答结果'); return json(res, 201, memoryService.recordQuizAttempt({ courseId: b.courseId || null, concept: b.concept || '当前资料', answers: b.answers })); }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'learning' && parts[2] === 'documents' && parts[3]) { const target = findDoc(parts[3]); const removed = learningDb.deleteDocument(parts[3]); if (target?.sourceFile) { const targetPath = path.join(UPLOAD_DIR, target.sourceFile); if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true }); } if (removed) { db.documents = db.documents.filter(document => document.id !== parts[3]); save(); } return json(res, 200, { ok: removed, id: parts[3] }); }
  if (method === 'GET' && url.pathname === '/api/learning/search') { const query = url.searchParams.get('q') || ''; const scope = url.searchParams.get('scope') || 'workspace'; const documentIds = (url.searchParams.get('documentIds') || '').split(',').map(value => value.trim()).filter(Boolean); const page = Number(url.searchParams.get('page') || 0) || undefined; const slide = Number(url.searchParams.get('slide') || 0) || undefined; const sheet = url.searchParams.get('sheet') || undefined; const options = { page, slide, sheet, limit: Number(url.searchParams.get('limit') || 10) }; if (scope === 'course') options.courseId = url.searchParams.get('courseId') || '__empty-course__'; else if (scope === 'documents' || scope === 'current-document' || scope === 'current-page') options.documentIds = documentIds.length ? documentIds : ['__empty-document-selection__']; else options.workspaceId = url.searchParams.get('workspaceId') || 'workspace-personal'; return json(res, 200, { query, scope, results: ragService.context(query, options) }); }
  if (method === 'GET' && url.pathname === '/api/memory') return json(res, 200, { profile: learningDb.getUserProfile(), memories: learningDb.listMemories({ type: url.searchParams.get('type') || undefined, courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 100) }), concepts: learningDb.listConcepts(url.searchParams.get('courseId') || undefined), questions: learningDb.listQuestions({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('questionLimit') || 50) }), errors: learningDb.listErrors({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('errorLimit') || 50) }) });
  if (method === 'GET' && url.pathname === '/api/memory/profile') return json(res, 200, { profile: learningDb.getUserProfile() });
  if (method === 'GET' && url.pathname === '/api/errors') return json(res, 200, { errors: learningDb.listErrors({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 100) }) });
  if (method === 'GET' && url.pathname === '/api/memory/export') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="studyagent-memory.json"' }); return res.end(JSON.stringify(learningDb.exportMemory(), null, 2)); }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'memory' && parts[2] === 'course') { const courseId = url.searchParams.get('courseId'); if (!courseId) return error(res, 'COURSE_REQUIRED', '清空课程记忆需要 courseId'); return json(res, 200, learningDb.clearCourseMemory(courseId)); }
  if (method === 'POST' && url.pathname === '/api/memory/profile') { const b = await body(req); return json(res, 200, { profile: learningDb.saveUserProfile(b.profile || b) }); }
  if (method === 'DELETE' && url.pathname === '/api/memory/profile') return json(res, 200, { ok: learningDb.deleteUserProfile() });
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'memory' && parts[2] && parts[2] !== 'errors') { const b = await body(req); return json(res, 200, { ok: learningDb.updateMemory(parts[2], b.content, b.importance), id: parts[2] }); }
  if (method === 'POST' && url.pathname === '/api/memory/errors') { const b = await body(req); if (!b.description || !b.concept) return error(res, 'INVALID_ERROR_MEMORY', '概念和错误描述不能为空'); return json(res, 201, { id: memoryService.updateError({ description: b.description, correction: b.correction || '', courseId: b.courseId || null, concept: b.concept, questionId: b.questionId || null }) }); }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'memory' && parts[2]) return json(res, 200, { ok: learningDb.deleteMemory(parts[2]), id: parts[2] });
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'graph' && parts[2]) { const details = learningDb.getConceptDetails(parts[2]); return details ? json(res, 200, details) : error(res, 'CONCEPT_NOT_FOUND', '概念不存在'); }
  if (method === 'GET' && url.pathname === '/api/graph') return json(res, 200, learningDb.listGraph(url.searchParams.get('courseId') || undefined));
  if (method === 'GET' && url.pathname === '/api/questions') return json(res, 200, learningDb.listQuestions({ courseId: url.searchParams.get('courseId') || undefined, limit: Number(url.searchParams.get('limit') || 50) }));
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'page-image' && parts[4]) {
    const d = findDoc(parts[2]); const image = d ? await renderPdfPageImage(d, parts[4]) : null;
    if (!image) return error(res, 'PAGE_IMAGE_UNAVAILABLE', 'Original PDF page image is unavailable for this document.');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }); return res.end(image);
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'file') {
    const d = findDoc(parts[2]); const source = d?.sourceFile ? path.join(UPLOAD_DIR, d.sourceFile) : null;
    if (!source || !fs.existsSync(source)) return error(res, 'DOCUMENT_FILE_UNAVAILABLE', 'Original document file is unavailable for this document.');
    const stat = fs.statSync(source);
    const ext = fileExtension(d.sourceFile || d.title || '') || String(d.fileType || d.type || 'bin').toLowerCase();
    const mime = DOCUMENT_MIME_TYPES[ext] || 'application/octet-stream';
    const safeTitle = String(d.title || 'document').replace(/["\\\r\n]/g, '_');
    const filename = encodeURIComponent(`${safeTitle}.${ext}`);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Content-Disposition': `inline; filename="document.${ext}"; filename*=UTF-8''${filename}`, 'Cache-Control': 'private, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(source).pipe(res);
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'pages' && parts[4]) {
    const d = findDoc(parts[2]);
    const pageNumber = Number(parts[4]);
    const page = d?.content?.find(item => item.page === pageNumber);
    return page ? json(res, 200, page) : error(res, 'PAGE_NOT_FOUND', 'Document page not found');
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'pages') { const d = findDoc(parts[2]); return d ? json(res, 200, d.content) : error(res, 'NOT_FOUND', 'Document not found'); }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'formula') { const d = findDoc(parts[2]); if (!d) return error(res, 'NOT_FOUND', 'Document not found'); try { return json(res, 200, await correctDocumentFormula(d, await body(req))); } catch (e) { return error(res, e.code || 'FORMULA_CORRECTION_FAILED', e.message); } }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'vision') { const d = findDoc(parts[2]); if (!d) return error(res, 'NOT_FOUND', 'Document not found'); try { return json(res, 200, await analyzeDocumentVision(d, await body(req))); } catch (e) { return error(res, e.code || 'VISION_FAILED', safeMessage(e, 'Vision 分析失败'), { status: e.status || 502 }); } }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'documents' && parts[2]) { const d = findDoc(parts[2]); return d ? json(res, 200, d) : error(res, 'NOT_FOUND', 'Document not found'); }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'reprocess') { const d = findDoc(parts[2]); if (!d) return error(res, 'NOT_FOUND', 'Document not found'); try { return json(res, 200, await reprocessDocument(d)); } catch (e) { return error(res, 'REPROCESS_FAILED', e.message); } }
  if (method === 'GET' && url.pathname === '/api/notes') return json(res, 200, { notes: learningDb.listNotes({ courseId: url.searchParams.get('courseId') || undefined, documentId: url.searchParams.get('documentId') || undefined, limit: Number(url.searchParams.get('limit') || 100) }) });
  if (method === 'POST' && url.pathname === '/api/notes') {
    const b = await body(req); const document = b.documentId ? findDoc(b.documentId) : null;
    if (b.documentId && !document) return error(res, 'DOCUMENT_NOT_FOUND', '笔记关联的文档不存在');
    if (!String(b.content || '').trim()) return error(res, 'INVALID_NOTE', '笔记内容不能为空');
    try {
      const note = learningDb.saveNote({ noteId: b.id, title: b.title || (document ? `${document.title} · 第${Number(b.locator?.page || b.page || 1)}页` : '学习笔记'), content: b.content, courseId: b.courseId || document?.courseId || document?.course_id || null, documentId: b.documentId || null, locator: { ...(b.locator || {}), page: Number(b.locator?.page || b.page || 0) || undefined, selectedText: String(b.locator?.selectedText || b.selectedText || '').slice(0, 500), section: String(b.locator?.section || '').slice(0, 200) }
      });
      return json(res, b.id ? 200 : 201, note);
    } catch (e) { return error(res, 'NOTE_SAVE_FAILED', e.message); }
  }
  if ((method === 'POST' || method === 'PATCH') && parts[0] === 'api' && parts[1] === 'notes' && parts[2]) {
    const b = await body(req); const existing = learningDb.listNotes({ limit: 10000 }).find(note => note.id === parts[2]);
    if (!existing) return error(res, 'NOTE_NOT_FOUND', '笔记不存在');
    try { return json(res, 200, learningDb.saveNote({ noteId: parts[2], title: b.title ?? existing.title, content: b.content ?? existing.content, courseId: b.courseId ?? existing.course_id, documentId: b.documentId ?? existing.document_id, locator: b.locator || existing.locator })); } catch (e) { return error(res, 'NOTE_SAVE_FAILED', e.message); }
  }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'notes' && parts[2]) return json(res, 200, { ok: learningDb.deleteNote(parts[2]), id: parts[2] });
  if (method === 'GET' && url.pathname === '/api/annotations') return json(res, 200, learningDb.listAnnotations({ documentId: url.searchParams.get('documentId') || undefined, limit: Number(url.searchParams.get('limit') || 500) }));
  if (method === 'POST' && url.pathname === '/api/documents/upload') {
    const b = await body(req); try { return json(res, 201, await importStructuredDocument(b)); } catch (e) { return error(res, e.code || 'DOCUMENT_IMPORT_FAILED', e.message || '文档导入失败'); }
  }
  if (method === 'POST' && url.pathname === '/api/documents/upload-legacy') {
    const b = await body(req); if (!b.name) return error(res, 'INVALID_DOCUMENT', 'A file name is required');
    const type = (b.name.split('.').pop() || 'TXT').toUpperCase(); const binary = type === 'PDF' && b.base64;
    const raw = binary ? Buffer.from(b.base64, 'base64') : Buffer.from(b.content || '', 'utf8');
    const fallback = b.content || 'Uploaded document is ready for annotation. Add a provider in Settings for model-backed extraction.';
    const parsed = binary ? extractPdfPages(raw) : null;
    const fallbackPages = fallback.split(/\f|\n\n\n/).slice(0, 30).map((text, i) => ({ page: i + 1, heading: `Page ${i + 1}`, text: text.trim() || 'No extractable text. This file can still be annotated locally.' }));
    const extracted = binary ? await ocrPdfPages(raw, parsed || [{ page: 1, heading: 'Page 1', text: 'No selectable text was found on this page.' }]) : { pages: fallbackPages, extraction: 'text', ocr: null };
    const pages = decoratePages(extracted.pages);
    const doc = { id: uid('doc'), title: b.name.replace(/\.[^.]+$/, ''), type, size: `${Math.max(1, Math.round(raw.length / 1024))} KB`, pages: pages.length, course: '未分类', progress: 0, annotations: 0, questions: 0, uploadedAt: 'Just now', lastRead: 'Not started', tags: ['新上传', ...(extracted.extraction === 'pdf-ocr' ? ['OCR'] : [])], content: pages, extraction: extracted.extraction, ocr: extracted.ocr };
    if (extracted.extraction === 'pdf-ocr' && doc.content[0]) doc.content[0].heading = doc.title;
    doc.sourceFile = `${doc.id}-${b.name.replace(/[^\w.-]+/g, '_')}`;
    db.documents.unshift(doc); fs.writeFileSync(path.join(UPLOAD_DIR, doc.sourceFile), raw); save(); return json(res, 201, doc);
  }
  if (method === 'POST' && parts[0] === 'api' && parts[1] === 'documents' && parts[2] && parts[3] === 'annotations') { const b = await body(req); try { const ann = learningDb.saveAnnotation({ id: b.id, documentId: parts[2], page: b.page, type: b.type, color: b.color, text: b.text, note: b.note }); const d = findDoc(parts[2]); if (d) d.annotations = learningDb.listAnnotations({ documentId: parts[2] }).length; save(); return json(res, b.id ? 200 : 201, ann); } catch (e) { return error(res, 'ANNOTATION_SAVE_FAILED', e.message); } }
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'annotations' && parts[2]) return json(res, 200, { ok: learningDb.deleteAnnotation(parts[2]), id: parts[2] });
  if (method === 'GET' && url.pathname === '/api/knowledge') return json(res, 200, { points: learningDb.listKnowledgePoints(url.searchParams.get('courseId') || undefined), cards: learningDb.listCards({ courseId: url.searchParams.get('courseId') || undefined, documentId: url.searchParams.get('documentId') || undefined, limit: Number(url.searchParams.get('limit') || 200) }) });
  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'cards' && parts[2]) return json(res, 200, { ok: learningDb.deleteCard(parts[2]), id: parts[2] });
  if (method === 'GET' && url.pathname === '/api/knowledge/graph') return json(res, 200, learningDb.listGraph(url.searchParams.get('courseId') || undefined));
  if (method === 'GET' && url.pathname === '/api/review/today') { const scheduled = learningDb.listReviewSchedule({ dueOnly: true }); const points = learningDb.listKnowledgePoints(); return json(res, 200, scheduled.map(item => { const point = points.find(candidate => candidate.id === item.concept_id); return { id: `learning-review-${item.concept_id}`, title: `Review ${item.concept_name}`, reason: `${item.repetitions} repetitions · mastery ${Math.round(item.mastery_score * 100)}%`, source: point?.source || item.concept_name, due: 'Today', status: 'due', knowledgeId: item.concept_id, conceptId: item.concept_id }; })); }
  if (method === 'GET' && url.pathname === '/api/analytics') { const questions = learningDb.listQuestions({ limit: 10000 }); const concepts = learningDb.listConcepts(); const annotations = learningDb.listAnnotations({ limit: 10000 }); const notes = learningDb.listNotes({ limit: 10000 }); const progress = learningDb.listProgress({ limit: 10000 }); const today = new Date(); const dates = Array.from({ length: 7 }, (_, index) => { const d = new Date(today); d.setDate(today.getDate() - (6 - index)); return d.toISOString().slice(0, 10); }); const countByDate = values => dates.map(date => values.filter(item => String(item.timestamp || item.created_at || item.createdAt || item.updated_at || item.updatedAt || '').slice(0, 10) === date).length); const weeklyQuestions = questions.filter(item => dates.includes(String(item.timestamp || '').slice(0, 10))).length; return json(res, 200, { source: 'sqlite-learning-events', labels: dates.map(date => date.slice(5)), dailyActivity: dates.map((date, index) => ({ date, questions: countByDate(questions)[index], annotations: countByDate(annotations)[index], notes: countByDate(notes)[index] })), weeklyQuestions, documents: learningDb.listDocuments().length, pages: new Set(questions.map(item => item.source_document_id).filter(Boolean)).size, questions: questions.length, annotations: annotations.length, notes: notes.length, concepts: concepts.length, progress, mastery: concepts.map(k => ({ name: k.name, value: Math.round(k.masteryScore * 100) })) }); }
  if (method === 'POST' && url.pathname === '/api/chat') {
    const b = await body(req); b.message = b.message || '请解释当前内容。';
    try {
      const result = await runAiRequest(b, b.formula ? 'formula' : 'text');
      const conversationId = conversationIdFor(b);
      result.memory = memoryService.recordInteraction({ question: b.message, answer: result.answer, courseId: b.courseId || findDoc(b.documentId)?.courseId || null, documentId: b.documentId, conversationId, optedOut: b.remember === false || db.settings?.memoryEnabled === false });
      result.conversationId = persistConversationTurn(b, result, result.answer);
      db.messages.push({ id: uid('msg'), role: 'user', text: b.message, selectedText: b.selectedText || '', formula: b.formula || '', pageNumber: b.page, provider: result.provider, model: result.model, createdAt: new Date().toISOString() }, { id: uid('msg'), role: 'assistant', text: result.answer, citations: result.citations, provider: result.provider, model: result.model, mode: result.mode, createdAt: new Date().toISOString() }); save(); return json(res, 200, result);
    } catch (e) { return error(res, e.code || 'AI_REQUEST_FAILED', safeMessage(e, 'AI 请求失败'), { provider: b.provider || null, status: e.status || 502 }); }
  }
  if (method === 'POST' && url.pathname === '/api/chat/stream') {
    const b = await body(req); b.message = b.message || '请解释当前内容。'; const config = selectModelConfig(b);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      if (!config || !config.apiKey) {
        const document = findDoc(b.documentId); const learning = buildLearningContext(b, document); const language = b.language === 'en' ? 'en' : (db.settings?.language === 'en' ? 'en' : 'zh'); const result = localAnswer(b.message, b.documentId, b.selectedText || '', language, learning.retrieved);
        const memoryNote = memoryAssociationNote(learning.memory, language);
        result.answer += memoryNote;
        const conversationId = conversationIdFor(b);
        const memory = memoryService.recordInteraction({ question: b.message, answer: result.answer, courseId: b.courseId || findDoc(b.documentId)?.courseId || null, documentId: b.documentId, conversationId, optedOut: b.remember === false || db.settings?.memoryEnabled === false });
        persistConversationTurn(b, result, result.answer);
        for (const chunk of result.answer.split(/(?<=[。！？.!?])|\n/).filter(Boolean)) { res.write(`data: ${JSON.stringify({ delta: chunk, mode: 'local', provider: 'local', model: 'Evidence-first local mode', language: result.language })}\n\n`); await new Promise(resolve => setTimeout(resolve, 35)); }
        res.write(`data: ${JSON.stringify({ done: true, conversationId, citations: result.citations, memory, memoryAssociations: learning.memory.relatedQuestions, mode: 'local', provider: 'local', model: 'Evidence-first local mode', language: result.language })}\n\n`); return res.end();
      }
      const document = findDoc(b.documentId); const context = readerContext(b, document); const learning = buildLearningContext(b, document); const prompt = `${buildPrompt(b.formula ? 'formula' : 'text', context, b.message)}\n\n资料库检索上下文：\n${learning.retrieved.map(item => `[${item.citation}]\n${item.text}`).join('\n\n') || '当前范围没有命中文本。'}\n\n真实长期学习记忆：\n${learning.memoryText || '没有明显相关的历史记忆。'}`; let answer = '';
      await createProvider(config).streamChat({ model: config.model, messages: [{ role: 'system', content: `You are StudyAgent's literature reading assistant. Answer in ${context.language === 'en' ? 'English' : 'Chinese'}. Ground the answer in the supplied context and use LaTeX for mathematics.` }, { role: 'user', content: prompt }], temperature: config.temperature, maxTokens: config.maxTokens }, token => { answer += token; res.write(`data: ${JSON.stringify({ delta: token, mode: 'remote', provider: config.provider, model: config.model, language: context.language })}\n\n`); });
      const citations = learning.retrieved.map((item, index) => ({ id: index + 1, documentId: item.documentId, document: item.documentTitle, page: item.locator.page, slide: item.locator.slide, sheet: item.locator.sheet, section: item.section, label: item.citation, quote: item.text.slice(0, 130) }));
      const conversationId = conversationIdFor(b);
      const memory = memoryService.recordInteraction({ question: b.message, answer, courseId: b.courseId || document?.courseId || document?.course_id || null, documentId: b.documentId, conversationId, optedOut: b.remember === false || db.settings?.memoryEnabled === false });
      persistConversationTurn(b, { citations, provider: config.provider, model: config.model, mode: 'remote' }, answer);
      db.messages.push({ id: uid('msg'), role: 'user', text: b.message, selectedText: b.selectedText || '', pageNumber: b.page, provider: config.provider, model: config.model, createdAt: new Date().toISOString() }, { id: uid('msg'), role: 'assistant', text: answer, citations, provider: config.provider, model: config.model, mode: 'remote', createdAt: new Date().toISOString() }); save(); res.write(`data: ${JSON.stringify({ done: true, conversationId, citations, memory, mode: 'remote', provider: config.provider, model: config.model, language: context.language })}\n\n`); return res.end();
    } catch (e) { res.write(`data: ${JSON.stringify({ error: { code: e.code || 'AI_REQUEST_FAILED', message: safeMessage(e, 'AI 请求失败') } })}\n\n`); return res.end(); }
  }
  if (method === 'POST' && url.pathname === '/api/ai/embed') { const b = await body(req); const config = selectModelConfig(b); if (!config || !config.apiKey) return error(res, 'REMOTE_MODEL_REQUIRED', 'Embedding 需要先在设置中配置远程模型', { status: 503 }); try { return json(res, 200, await createProvider(config).embed({ input: b.input, model: b.model })); } catch (e) { return error(res, e.code || 'EMBEDDING_FAILED', safeMessage(e, 'Embedding 请求失败'), { status: e.status || 502 }); } }
  if (method === 'POST' && url.pathname === '/api/ai/vision') { const b = await body(req); const config = selectModelConfig(b); if (!config || !config.apiKey) return error(res, 'REMOTE_MODEL_REQUIRED', 'Vision 需要先在设置中配置支持视觉的远程模型', { status: 503 }); try { return json(res, 200, await createProvider(config).vision({ imageData: b.imageData, imageUrl: b.imageUrl, prompt: b.prompt, model: b.model })); } catch (e) { return error(res, e.code || 'VISION_FAILED', safeMessage(e, 'Vision 请求失败'), { status: e.status || 502 }); } }
  if (method === 'POST' && url.pathname === '/api/ai/explain') { const b = await body(req); b.message = b.message || `请解释这段内容：${b.selectedText || ''}`; try { return json(res, 200, await runAiRequest(b, b.formula ? 'formula' : 'text')); } catch (e) { return error(res, e.code || 'AI_REQUEST_FAILED', safeMessage(e, 'AI 解释失败'), { status: e.status || 502 }); } }
  if (method === 'POST' && url.pathname === '/api/ai/summarize') { const b = await body(req); const d = findDoc(b.documentId) || db.documents[0]; const pages = b.page ? d.content.filter(p => p.page === Number(b.page)) : d.content; const context = pages.map(page => page.text).join('\n\n').slice(0, 5000); try { return json(res, 200, await runAiRequest({ ...b, documentId: d.id, selectedText: context, message: b.message || '请总结当前页面的核心内容、关键概念、公式和复习重点。' }, 'summary')); } catch (e) { return error(res, e.code || 'AI_REQUEST_FAILED', safeMessage(e, 'AI 总结失败'), { status: e.status || 502 }); } }
  if (method === 'POST' && url.pathname === '/api/ai/create-card') { const b = await body(req); const d = findDoc(b.documentId) || db.documents[0]; if (!d) return error(res, 'DOCUMENT_REQUIRED', '创建知识卡需要至少一份资料'); const language = b.language === 'en' ? 'en' : (db.settings?.language === 'en' ? 'en' : 'zh'); const card = learningDb.saveCard({ front: b.selectedText ? `Explain: ${b.selectedText.slice(0, 90)}` : 'What is the key idea of this section?', back: localAnswer('Explain ' + (b.selectedText || 'the main idea'), d.id, b.selectedText || '', language).answer, source: `${d.title} · p.${b.page || 1}`, due: 'Tomorrow', mastery: 0.2, documentId: d.id, courseId: d.courseId || d.course_id || null, locator: { page: Number(b.page || 1) || 1, selectedText: String(b.selectedText || '').slice(0, 500) } }); return json(res, 201, card); }
  if (method === 'POST' && url.pathname === '/api/review/complete') { const b = await body(req); const scheduled = learningDb.listReviewSchedule({ limit: 200 }).find(item => `learning-review-${item.concept_id}` === b.id); if (!scheduled) return json(res, 200, { ok: false, task: null, knowledge: null, review: null }); const review = memoryService.recordReview({ concept: scheduled.concept_name, courseId: scheduled.course_id || null, correct: b.correct !== false }); const knowledge = learningDb.listKnowledgePoints(scheduled.course_id || undefined).find(item => item.name === scheduled.concept_name) || null; return json(res, 200, { ok: true, task: { id: b.id, title: `Review ${scheduled.concept_name}`, status: 'completed', conceptId: scheduled.concept_id }, knowledge, review }); }
  if (method === 'GET' && url.pathname === '/api/state') return json(res, 200, db);
  if (method === 'POST' && url.pathname === '/api/settings') { const b = await body(req); delete b.apiKey; if (b.language) b.language = b.language === 'en' || b.language === 'English' ? 'en' : 'zh'; if (b.memoryEnabled !== undefined) b.memoryEnabled = Boolean(b.memoryEnabled); db.settings = { ...db.settings, ...b }; save(); return json(res, 200, db.settings); }
  return error(res, 'NOT_FOUND', 'API route not found');
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = http.createServer(async (req, res) => { try { const url = parsePath(req.url); if (url.pathname.startsWith('/api/')) return await api(req, res, url); let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname); if (!file.startsWith(PUBLIC)) return error(res, 'FORBIDDEN', 'Invalid path'); if (!fs.existsSync(file)) file = path.join(PUBLIC, 'index.html'); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); } catch (e) { json(res, 500, { error: { code: 'SERVER_ERROR', message: e.message, details: {} } }); } });
server.listen(4173, '127.0.0.1', () => console.log('StudyAgent running at http://127.0.0.1:4173'));
