const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
let sessionCookie = '';

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...(options.headers || {}) };
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';')[0];
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${data?.error?.message || text}`);
  return data;
}

const documents = await request('/api/documents');
const document = documents.find(item => item.id === 'doc-e06b943c') || documents.find(item => item.type === 'PDF');
if (!document) throw new Error('No PDF regression document available for HTTP learning checks');
if (!document.courseId || !document.structure?.chunks || !Array.isArray(document.content)) throw new Error('HTTP MySQL document catalog regression');
const knowledge = await request('/api/knowledge');
if (!Array.isArray(knowledge.points) || !knowledge.points.length || !Array.isArray(knowledge.cards)) throw new Error('HTTP MySQL knowledge points regression');
const graph = await request('/api/knowledge/graph');
if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('HTTP MySQL knowledge graph regression');
if (graph.nodes.length < 2) throw new Error('HTTP knowledge graph needs at least two concepts for relation management regression');
const detailNode = graph.nodes[0];
const existingPairs = new Set(graph.edges.map(edge => `${edge.source}:${edge.target}:${edge.type}`));
const relationPair = graph.nodes.flatMap(source => graph.nodes.map(target => ({ source, target }))).find(pair => pair.source.id !== pair.target.id && !existingPairs.has(`${pair.source.id}:${pair.target.id}:RELATED_TO`));
if (!relationPair) throw new Error('HTTP knowledge graph has no available relation pair for management regression');
const createdRelation = await request('/api/graph/relations', { method: 'POST', body: JSON.stringify({ sourceId: relationPair.source.id, targetId: relationPair.target.id, type: 'RELATED_TO', weight: 0.61 }) });
if (!createdRelation.id) throw new Error('HTTP graph relation create regression');
const graphAfterRelation = await request('/api/knowledge/graph');
if (!graphAfterRelation.edges.some(edge => edge.id === createdRelation.id || (edge.source === relationPair.source.id && edge.target === relationPair.target.id && edge.type === 'RELATED_TO'))) throw new Error('HTTP graph relation list regression');
if (!(await request(`/api/graph/relations/${encodeURIComponent(createdRelation.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP graph relation delete regression');
const reviewQueue = await request('/api/review/today');
if (!Array.isArray(reviewQueue) || reviewQueue.some(item => !String(item.id).startsWith('learning-review-'))) throw new Error('HTTP MySQL review queue regression');

const suffix = Date.now().toString(36);
const createdNote = await request('/api/notes', { method: 'POST', body: JSON.stringify({ title: `HTTP note ${suffix}`, content: `HTTP persistence check for ${detailNode.label}`, documentId: document.id, locator: { page: 1, section: 'Regression', formulaLatex: 'A \\in \\mathbb{C}^{n}' } }) });
if (!createdNote.id) throw new Error('HTTP note create regression');
if (createdNote.locator?.formulaLatex !== 'A \\in \\mathbb{C}^{n}') throw new Error('HTTP formula note persistence regression');
const updatedNote = await request(`/api/notes/${encodeURIComponent(createdNote.id)}`, { method: 'PATCH', body: JSON.stringify({ title: `HTTP note ${suffix} updated`, content: `HTTP update check for ${detailNode.label}`, locator: { page: 2 } }) });
if (updatedNote.title !== `HTTP note ${suffix} updated` || updatedNote.locator?.page !== 2) throw new Error('HTTP note update regression');
const listedNotes = await request(`/api/notes?documentId=${encodeURIComponent(document.id)}&limit=200`);
if (!listedNotes.notes.some(item => item.id === createdNote.id)) throw new Error('HTTP note list regression');

const annotation = await request(`/api/documents/${encodeURIComponent(document.id)}/annotations`, { method: 'POST', body: JSON.stringify({ page: 1, type: 'highlight', color: 'yellow', text: `HTTP annotation ${suffix}`, note: 'LaTeX: A \\in \\mathbb{C}^{n}' }) });
if (!annotation.id) throw new Error('HTTP annotation create regression');
const annotations = await request(`/api/annotations?documentId=${encodeURIComponent(document.id)}`);
if (!annotations.some(item => item.id === annotation.id)) throw new Error('HTTP annotation list regression');
if (!String(annotations.find(item => item.id === annotation.id)?.note || '').includes('LaTeX:')) throw new Error('HTTP formula annotation persistence regression');
if (!(await request(`/api/annotations/${encodeURIComponent(annotation.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP annotation delete regression');

const createdCard = await request('/api/ai/create-card', { method: 'POST', body: JSON.stringify({ documentId: document.id, page: 1, selectedText: `HTTP card ${suffix} about ${detailNode.label}：给定矩阵 4 E C“““ 和向量 5 E C+`, formula: 'A \\in \\mathbb{C}^{n}', category: '矩阵例题', cardType: 'worked-example', language: 'zh' }) });
if (!createdCard.id) throw new Error('HTTP card create regression');
if (createdCard.locator?.formulaLatex !== 'A \\in \\mathbb{C}^{n}') throw new Error('HTTP formula card persistence regression');
if (createdCard.category !== '矩阵例题' || createdCard.cardType !== 'worked-example' || createdCard.structure?.layout !== 'worked-example' || !createdCard.structure?.steps?.length) throw new Error('HTTP structured card persistence regression');
const categories = await request('/api/cards/categories');
if (!categories.categories.some(item => item.name === '矩阵例题')) throw new Error('HTTP card category list regression');
const movedCard = await request(`/api/cards/${encodeURIComponent(createdCard.id)}`, { method: 'PATCH', body: JSON.stringify({ category: '线性代数例题' }) });
if (movedCard.category !== '线性代数例题') throw new Error('HTTP card category update regression');
const renamedCategory = await request('/api/cards/categories', { method: 'PATCH', body: JSON.stringify({ from: '线性代数例题', to: '数值算法例题' }) });
if (!renamedCategory.categories.some(item => item.name === '数值算法例题')) throw new Error('HTTP card category rename regression');
const removedCategory = await request('/api/cards/categories?name=%E6%95%B0%E5%80%BC%E7%AE%97%E6%B3%95%E4%BE%8B%E9%A2%98', { method: 'DELETE' });
if (!removedCategory.categories.some(item => item.name === '未分类')) throw new Error('HTTP card category removal regression');
const cards = await request(`/api/knowledge?documentId=${encodeURIComponent(document.id)}&limit=200`);
if (!cards.cards.some(item => item.id === createdCard.id)) throw new Error('HTTP card list regression');
const formulaCard = await request('/api/ai/create-card', { method: 'POST', body: JSON.stringify({ documentId: document.id, page: 1, selectedText: `OCR formula regression ${suffix}：给定矩阵 4 E C“““ 和向量 5 E C+`, formula: 'A \\in \\mathbb{C}^{n}', language: 'zh' }) });
if (!String(formulaCard.back || '').includes(String.fromCharCode(92) + '(')) throw new Error('HTTP review formula rendering source regression');
if (!(await request(`/api/cards/${encodeURIComponent(formulaCard.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP formula card cleanup regression');
const conceptDetails = await request(`/api/graph/${encodeURIComponent(detailNode.id)}`);
if (!Array.isArray(conceptDetails.notes) || !Array.isArray(conceptDetails.cards) || !Array.isArray(conceptDetails.errors) || !Array.isArray(conceptDetails.quizAttempts) || !('progress' in conceptDetails)) throw new Error('HTTP concept detail learning artifacts regression');
if (!conceptDetails.notes.some(item => String(item.content).includes(detailNode.label)) || !conceptDetails.cards.some(item => String(item.front).includes(detailNode.label))) throw new Error('HTTP concept detail did not connect notes and cards');
if (!(await request(`/api/notes/${encodeURIComponent(createdNote.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP note delete regression');
if (!(await request(`/api/cards/${encodeURIComponent(createdCard.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP card delete regression');

const analytics = await request('/api/analytics');
if (analytics.source !== 'mysql-learning-events' || !Array.isArray(analytics.dailyActivity) || typeof analytics.documents !== 'number') throw new Error('HTTP analytics regression');
const search = await request('/api/learning/search?q=backward%20error&scope=workspace&limit=3');
if (search.scope !== 'workspace' || !Array.isArray(search.results)) throw new Error('HTTP workspace retrieval regression');
const encodedDocumentId = encodeURIComponent(document.id);
const currentPageSearch = await request(`/api/learning/search?q=FDU&scope=current-page&documentIds=${encodedDocumentId}&page=1&limit=10`);
if (currentPageSearch.scope !== 'current-page' || currentPageSearch.results.some(item => item.documentId !== document.id || Number(item.locator?.page) !== 1)) throw new Error('HTTP current-page retrieval regression');
const currentDocumentSearch = await request(`/api/learning/search?q=FDU&scope=current-document&documentIds=${encodedDocumentId}&limit=10`);
if (currentDocumentSearch.scope !== 'current-document' || currentDocumentSearch.results.some(item => item.documentId !== document.id)) throw new Error('HTTP current-document retrieval regression');
const selectedDocumentsSearch = await request(`/api/learning/search?q=FDU&scope=documents&documentIds=${encodedDocumentId}&limit=10`);
if (selectedDocumentsSearch.scope !== 'documents' || selectedDocumentsSearch.results.some(item => item.documentId !== document.id)) throw new Error('HTTP selected-documents retrieval regression');
const courseSearch = await request(`/api/learning/search?q=FDU&scope=course&courseId=${encodeURIComponent(document.courseId)}&limit=10`);
if (courseSearch.scope !== 'course' || courseSearch.results.some(item => item.courseId && item.courseId !== document.courseId)) throw new Error('HTTP course retrieval regression');
const formulaLatex = 'A \\in \\mathbb{C}^{n}';
  const formulaExplanation = await request('/api/ai/explain', { method: 'POST', body: JSON.stringify({ documentId: document.id, page: 1, selectedText: `\\(${formulaLatex}\\)`, formula: formulaLatex, language: 'zh', configId: 'local' }) });
  if (formulaExplanation.context?.formula !== formulaLatex) throw new Error('HTTP formula context regression');
  const formulaConversation = await request('/api/chat', { method: 'POST', body: JSON.stringify({ conversationId: `formula-regression-${suffix}`, documentId: document.id, page: 1, message: '请解释这个公式。', selectedText: `\\(${formulaLatex}\\)`, formula: formulaLatex, language: 'zh', remember: false, configId: 'local' }) });
  const formulaHistory = await request(`/api/conversations/${encodeURIComponent(formulaConversation.conversationId)}/messages?limit=10`);
  if (!formulaHistory.messages?.some(item => item.role === 'user' && item.metadata?.formula === formulaLatex)) throw new Error('HTTP formula conversation persistence regression');
const quiz = await request('/api/learning/quiz', { method: 'POST', body: JSON.stringify({ courseId: document.courseId, count: 6, language: 'zh' }) });
const quizTypes = [...new Set((quiz.items || []).map(item => item.type).filter(Boolean))];
if (!Array.isArray(quiz.items) || quiz.items.length < 4 || quizTypes.length < 3) throw new Error(`HTTP varied quiz regression: ${quizTypes.join(',')}`);

const courses = await request('/api/courses');
const targetCourse = courses.find(item => item.name !== '未分类');
if (!targetCourse) throw new Error('HTTP document organization regression needs a non-default course');
let organizationDocumentId = null;
try {
  const organizationDocument = await request('/api/documents/upload', { method: 'POST', body: JSON.stringify({ name: `http-organization-${suffix}.md`, content: '# Organization regression\n\nThis document is moved between persisted course scopes.' }) });
  organizationDocumentId = organizationDocument.id;
  if (organizationDocument.courseId === targetCourse.id) throw new Error('HTTP organization fixture unexpectedly started in target course');
  const movedDocument = await request(`/api/learning/documents/${encodeURIComponent(organizationDocumentId)}`, { method: 'PATCH', body: JSON.stringify({ workspaceId: targetCourse.workspace_id, courseId: targetCourse.id }) });
  if (movedDocument.courseId !== targetCourse.id || movedDocument.workspaceId !== targetCourse.workspace_id) throw new Error('HTTP document organization update regression');
  const targetCourseDocuments = await request(`/api/learning/documents?courseId=${encodeURIComponent(targetCourse.id)}`);
  if (!targetCourseDocuments.some(item => item.id === organizationDocumentId)) throw new Error('HTTP document organization catalog regression');
  const unassignedDocument = await request(`/api/learning/documents/${encodeURIComponent(organizationDocumentId)}`, { method: 'PATCH', body: JSON.stringify({ courseId: null }) });
  if (unassignedDocument.courseId !== null) throw new Error('HTTP document unassign regression');
} finally {
  if (organizationDocumentId) await request(`/api/learning/documents/${encodeURIComponent(organizationDocumentId)}`, { method: 'DELETE' });
}

const planCases = [
  { scope: 'current-page', documentIds: [document.id], page: 1 },
  { scope: 'current-document', documentIds: [document.id] },
  { scope: 'course', courseId: document.courseId },
  { scope: 'documents', documentIds: [document.id] },
  { scope: 'workspace' }
];
const agentPlans = {};
for (const input of planCases) {
  const plan = await request('/api/agent/plan', { method: 'POST', body: JSON.stringify({ message: '解释 FDU 数值算法中的 backward error', documentId: document.id, page: input.page || 1, ...input }) });
  if (plan.scope !== input.scope || !Array.isArray(plan.agents) || !plan.agents.includes('RetrievalAgent') || !plan.memory || !Array.isArray(plan.retrieved)) throw new Error(`HTTP agent plan ${input.scope} regression`);
  if (input.scope === 'current-page' && plan.retrieved.some(item => item.documentId !== document.id || Number(item.locator?.page) !== 1)) throw new Error('HTTP agent current-page scope leaked outside the page');
  if ((input.scope === 'current-document' || input.scope === 'documents') && plan.retrieved.some(item => item.documentId !== document.id)) throw new Error(`HTTP agent ${input.scope} scope leaked outside the document`);
  if (input.scope === 'course' && plan.retrieved.some(item => item.courseId !== document.courseId)) throw new Error('HTTP agent course scope leaked outside the course');
  agentPlans[input.scope] = plan.retrieved.length;
}
console.log(JSON.stringify({ ok: true, documentId: document.id, note: 'create/update/list/delete', annotation: 'create/list/delete', card: 'create/list/delete', graphRelation: 'create/list/delete', documentOrganization: 'import/move/unassign/delete', formulaContext: 'latex', quizTypes, catalog: 'mysql', knowledge: 'points/graph', review: 'mysql', analyticsSource: analytics.source, retrievalScopes: { workspace: search.results.length, currentPage: currentPageSearch.results.length, currentDocument: currentDocumentSearch.results.length, documents: selectedDocumentsSearch.results.length, course: courseSearch.results.length }, agentPlans }));
