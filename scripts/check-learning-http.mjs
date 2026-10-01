const base = 'http://127.0.0.1:4173';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${data?.error?.message || text}`);
  return data;
}

const documents = await request('/api/documents');
const document = documents.find(item => item.id === 'doc-e06b943c') || documents.find(item => item.type === 'PDF');
if (!document) throw new Error('No PDF regression document available for HTTP learning checks');
if (!document.courseId || !document.structure?.chunks || !Array.isArray(document.content)) throw new Error('HTTP SQLite document catalog regression');
const knowledge = await request('/api/knowledge');
if (!Array.isArray(knowledge.points) || !knowledge.points.length || !Array.isArray(knowledge.cards)) throw new Error('HTTP SQLite knowledge points regression');
const graph = await request('/api/knowledge/graph');
if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('HTTP SQLite knowledge graph regression');
const reviewQueue = await request('/api/review/today');
if (!Array.isArray(reviewQueue) || reviewQueue.some(item => !String(item.id).startsWith('learning-review-'))) throw new Error('HTTP SQLite review queue regression');

const suffix = Date.now().toString(36);
const createdNote = await request('/api/notes', { method: 'POST', body: JSON.stringify({ title: `HTTP note ${suffix}`, content: 'HTTP persistence check', documentId: document.id, locator: { page: 1, section: 'Regression' } }) });
if (!createdNote.id) throw new Error('HTTP note create regression');
const updatedNote = await request(`/api/notes/${encodeURIComponent(createdNote.id)}`, { method: 'PATCH', body: JSON.stringify({ title: `HTTP note ${suffix} updated`, content: 'HTTP update check', locator: { page: 2 } }) });
if (updatedNote.title !== `HTTP note ${suffix} updated` || updatedNote.locator?.page !== 2) throw new Error('HTTP note update regression');
const listedNotes = await request(`/api/notes?documentId=${encodeURIComponent(document.id)}&limit=200`);
if (!listedNotes.notes.some(item => item.id === createdNote.id)) throw new Error('HTTP note list regression');
if (!(await request(`/api/notes/${encodeURIComponent(createdNote.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP note delete regression');

const annotation = await request(`/api/documents/${encodeURIComponent(document.id)}/annotations`, { method: 'POST', body: JSON.stringify({ page: 1, type: 'highlight', color: 'yellow', text: `HTTP annotation ${suffix}`, note: '' }) });
if (!annotation.id) throw new Error('HTTP annotation create regression');
const annotations = await request(`/api/annotations?documentId=${encodeURIComponent(document.id)}`);
if (!annotations.some(item => item.id === annotation.id)) throw new Error('HTTP annotation list regression');
if (!(await request(`/api/annotations/${encodeURIComponent(annotation.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP annotation delete regression');

const createdCard = await request('/api/ai/create-card', { method: 'POST', body: JSON.stringify({ documentId: document.id, page: 1, selectedText: `HTTP card ${suffix}`, language: 'zh' }) });
if (!createdCard.id) throw new Error('HTTP card create regression');
const cards = await request(`/api/knowledge?documentId=${encodeURIComponent(document.id)}&limit=200`);
if (!cards.cards.some(item => item.id === createdCard.id)) throw new Error('HTTP card list regression');
if (!(await request(`/api/cards/${encodeURIComponent(createdCard.id)}`, { method: 'DELETE' })).ok) throw new Error('HTTP card delete regression');

const analytics = await request('/api/analytics');
if (analytics.source !== 'sqlite-learning-events' || !Array.isArray(analytics.dailyActivity) || typeof analytics.documents !== 'number') throw new Error('HTTP analytics regression');
const search = await request('/api/learning/search?q=backward%20error&scope=workspace&limit=3');
if (search.scope !== 'workspace' || !Array.isArray(search.results)) throw new Error('HTTP workspace retrieval regression');
console.log(JSON.stringify({ ok: true, documentId: document.id, note: 'create/update/list/delete', annotation: 'create/list/delete', card: 'create/list/delete', catalog: 'sqlite', knowledge: 'points/graph', review: 'sqlite', analyticsSource: analytics.source, retrievalHits: search.results.length }));
