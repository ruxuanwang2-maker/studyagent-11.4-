import assert from 'node:assert/strict';
const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const suffix = Date.now().toString(36);
const cookies = [];
async function request(route, { cookie = '', method = 'GET', body } = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
async function wait(jobId, cookie) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const job = (await request('/api/imports/' + jobId, { cookie })).data;
    if (job.status === 'completed' || job.status === 'failed') return job;
    assert.ok(Date.now() < deadline, 'fixture import did not complete');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
try {
  for (const label of ['A','B']) {
    const registered = await request('/api/auth/register', { method: 'POST', body: { email: `reading-${label}-${suffix}@example.com`, username: `Reading ${label}`, password: 'Regression-Read-2026!' } });
    assert.equal(registered.status, 201); cookies.push(registered.cookie);
  }
  const [a,b] = cookies;
  const course = await request('/api/courses', { cookie: a, method: 'POST', body: { name: 'Reading regression' } });
  assert.equal(course.status, 201);
  const courseId = course.data.id || course.data.course?.id;
  const uploaded = await request('/api/documents/upload', { cookie: a, method: 'POST', body: { name: `reading-${suffix}.md`, courseId, async: true, content: '# 第一节\n\n非零主元。\n\n# 第二节\n\n高斯消元。\n\n# 第三节\n\n条件数与稳定性。' } });
  assert.equal(uploaded.status, 202);
  const id = uploaded.data.jobs[0].id;
  assert.equal((await request('/api/imports/' + id, { cookie: b })).status, 404);
  const job = await wait(id, a); assert.equal(job.status, 'completed');
  const documentId = job.documentId;
  const session = await request('/api/learning/sessions', { cookie: a, method: 'POST', body: { documentId, courseId } });
  const sessionId = session.data.session?.id || session.data.id;
  assert.ok(sessionId);
  for (const page of [1,3,1]) assert.equal((await request(`/api/learning/sessions/${sessionId}`, { cookie: a, method: 'PATCH', body: { pagesViewed: [page], currentPage: page } })).status, 200);
  const position = (await request(`/api/documents/${documentId}/reading-position`, { cookie: a })).data;
  assert.equal(position.currentPage, 1);
  assert.deepEqual(position.pagesViewed, [1,3]);
  assert.equal(position.progress, 2/3, 'jumping to the last page must not report completion');
  assert.equal((await request(`/api/documents/${documentId}/reading-position`, { cookie: b })).status, 404);
  assert.equal((await request(`/api/documents/${documentId}/reading-position`, { cookie: a, method: 'PATCH', body: { currentPage: 999 } })).status, 400);
  const catalog = (await request(`/api/documents/${documentId}`, { cookie: a })).data;
  assert.equal(catalog.readingPosition.currentPage, 1); assert.equal(catalog.progress, 2/3);
  const planned = await request('/api/prompt/optimize', { cookie: a, method: 'POST', body: { message: '解释这个条件', documentId, page: 1, selectedText: '非零主元。', courseId } });
  assert.equal(planned.status, 200); assert.equal(planned.data.structured.original_query, '解释这个条件');
  assert.ok(planned.data.answerPrompt.includes('非零主元'));
  const bad = await request('/api/documents/upload', { cookie: a, method: 'POST', body: { name: 'empty.txt', content: '', async: true } });
  assert.equal((await wait(bad.data.jobs[0].id, a)).status, 'failed');
  assert.equal((await request(`/api/documents/${documentId}/reading-position`, { cookie: a })).data.progress, 2/3);
  await request('/api/auth/logout', { cookie: a, method: 'POST', body: {} });
  const login = await request('/api/auth/login', { method: 'POST', body: { email: `reading-A-${suffix}@example.com`, password: 'Regression-Read-2026!' } });
  cookies[0] = login.cookie;
  assert.equal((await request(`/api/documents/${documentId}/reading-position`, { cookie: login.cookie })).data.currentPage, 1);
  assert.equal((await request(`/api/documents/${documentId}/reading-position`, { cookie: login.cookie })).data.progress, 2/3);
  console.log('PASS: isolated background imports, failed empty import recovery, last position vs unique pages, revisit, invalid page, source catalog, structured prompt HTTP, logout/login restoration and account isolation');
} finally {
  for (const cookie of cookies) await request('/api/account', { cookie, method: 'DELETE', body: { confirmation: 'DELETE' } });
}
