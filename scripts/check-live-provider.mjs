import { createRequire } from 'node:module';

const port = Number(process.env.STUDYAGENT_LIVE_PROVIDER_PORT || 4281);
const base = `http://127.0.0.1:${port}`;
process.env.STUDYAGENT_PORT = String(port);
const require = createRequire(import.meta.url);
const { startup } = require('../server.js');
const server = await startup;

function assert(value, message) { if (!value) throw new Error(message); }
async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(90000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${data?.error?.code || ''} ${data?.error?.message || text}`.trim());
  return data;
}
async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await request('/api/auth/session'); return; } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  throw new Error('StudyAgent did not start for live provider verification');
}

try {
  await ready();
  const modelData = await request('/api/models/configs');
  const config = (modelData.configs || []).find(item => item.hasApiKey && item.purpose !== 'math-ocr');
  if (!config) throw new Error('No configured remote answer model is available for live verification');
  const connection = await request(`/api/models/configs/${encodeURIComponent(config.id)}/test`, { method: 'POST', body: '{}' });
  assert(connection.ok, 'provider connection test did not succeed');
  const documents = await request('/api/documents');
  const document = documents.find(item => Number(item.pages) > 0) || documents[0];
  assert(document?.id, 'no document is available for grounded provider verification');
  const result = await request('/api/chat', { method: 'POST', body: JSON.stringify({ message: '请用两句话概括当前资料的核心主题，并保留必要的数学符号。', documentId: document.id, page: 1, scope: 'current-page', configId: config.id, language: 'zh', remember: false, skipOptimization: true }) });
  assert(result.mode === 'remote', `document answer unexpectedly used ${result.mode || 'unknown'} mode`);
  assert(result.provider === config.provider, `document answer provider mismatch: ${result.provider || 'unknown'}`);
  assert(String(result.answer || '').trim().length > 0, 'remote document answer was empty');
  console.log(JSON.stringify({ ok: true, provider: result.provider, model: result.model, mode: result.mode, answerLength: result.answer.length, citations: (result.citations || []).length, connectionLatencyMs: connection.latencyMs }));
} finally {
  await new Promise(resolve => server.close(resolve));
}
