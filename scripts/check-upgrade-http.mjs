import assert from 'node:assert/strict';
const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const accounts = [];
async function request(route, input, cookie = '') {
  const response = await fetch(`${base}${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${data.error?.message || ''}`);
  return { data, response };
}
async function register(label) {
  const result = await request('/api/auth/register', { email: `${label.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, username: label, password: 'Upgrade-Regression-2026!' });
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie); accounts.push(cookie); return cookie;
}
try {
  const malformed = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad', signal: AbortSignal.timeout(10000) });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  const a = await register('Upgrade Student A'), b = await register('Upgrade Student B');
  for (const cookie of [a, b]) await request('/api/prompt/settings', { level: 'off', developmentLogs: true }, cookie);
  const course = (await request('/api/courses', { name: '数值算法回归' }, a)).data;
  const doc = (await request('/api/documents/upload', { name: '结构化讲义.md', courseId: course.id, content: '# 线性方程\nLU Decomposition connects Gaussian Elimination and Pivoting.\n\n## 条件数\nCondition Number measures sensitivity. $\\kappa(A)=\\|A\\|\\|A^{-1}\\|$' }, a)).data;
  const chapters = (await request(`/api/learning/chapters?documentId=${doc.id}`, undefined, a)).data.chapters;
  assert.equal(chapters.length, 2); assert.equal(chapters[1].level, 2);
  assert.equal((await request(`/api/learning/chapters?documentId=${doc.id}`, undefined, b)).data.chapters.length, 0);
  const session = (await request('/api/learning/sessions', { documentId: doc.id, courseId: course.id }, a)).data;
  const ann = (await request(`/api/documents/${doc.id}/annotations`, { page: 2, text: 'Condition Number', note: '没有理解敏感性', sessionId: session.id }, a)).data;
  const answer = (await request('/api/chat', { message: '请解释条件数与主元的区别', selectedText: 'Condition Number measures sensitivity.', documentId: doc.id, courseId: course.id, page: 2, scope: 'course', configId: 'local', sessionId: session.id }, a)).data;
  assert.ok(answer.promptOptimization.answerPrompt.includes('OBSERVED LEARNING EVENTS'));
  assert.ok(answer.promptOptimization.answerPrompt.includes('没有理解敏感性'));
  const prior = (await request('/api/agent/context/last', undefined, b)).data;
  assert.equal(prior.context, null, 'another account cannot inspect A question context');
  const aWorkspace = (await request('/api/chat', { message: '我的工作区问题 A', scope: 'workspace', configId: 'local' }, a)).data;
  const bWorkspace = (await request('/api/chat', { message: '我的工作区问题 B', scope: 'workspace', configId: 'local' }, b)).data;
  assert.notEqual(aWorkspace.conversationId, bWorkspace.conversationId, 'each account must have an independent default conversation');
  const events = (await request(`/api/learning/events?documentId=${doc.id}`, undefined, a)).data.events;
  assert.ok(events.some(e => e.source_id === ann.id && e.event_type === 'annotation'));
  assert.ok(events.some(e => e.event_type === 'question'));
  assert.ok(events.filter(e => e.event_type === 'question').every(e => e.evidence.page === 2 && e.evidence.selectedText === 'Condition Number measures sensitivity.'), 'question events must retain the selected passage and exact source page');
  assert.equal((await request(`/api/learning/events?documentId=${doc.id}`, undefined, b)).data.events.length, 0);
  const scores = (await request(`/api/learning/mastery?courseId=${course.id}`, undefined, a)).data.concepts;
  assert.ok(scores.length); assert.ok(scores.every(item => item.score === null && item.label === 'Low Evidence'));
  const exportData = (await request('/api/account/export', undefined, a)).data;
  assert.ok(exportData.learningEvents.length);
  console.log('PASS: actual APIs for migration/chapters/events/mastery/context, private default conversations, inspector isolation, JSON status and export');
} finally {
  for (const cookie of accounts) {
    const response = await fetch(`${base}/api/account`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ confirmation: 'DELETE' }), signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, 'test account cleanup failed');
  }
}
