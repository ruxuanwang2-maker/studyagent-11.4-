const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const accounts = [
  { email: `regression-student-${suffix}@example.com`, username: 'Regression Student', password: 'StudyAgent-Regression-2026!' },
  { email: `regression-other-${suffix}@example.com`, username: 'Regression Other', password: 'StudyAgent-Other-2026!' }
];

async function request(path, options = {}, cookie = '') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const setCookie = response.headers.get('set-cookie') || '';
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${data?.error?.message || text}`);
  return { data, cookie: setCookie.split(';')[0] };
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function body(value) { return JSON.stringify(value); }

let cookieA = ''; let cookieB = ''; let userA; let userB;
try {
  const registeredA = await request('/api/auth/register', { method: 'POST', body: body(accounts[0]) }); cookieA = registeredA.cookie; userA = registeredA.data.user;
  assert(userA?.username === 'Regression Student' && cookieA, 'Regression Student registration failed');
  const workspaces = await request('/api/workspaces', {}, cookieA);
  const workspace = workspaces.data[0]; assert(workspace?.id, 'Regression workspace missing');
  const course = await request('/api/courses', { method: 'POST', body: body({ workspaceId: workspace.id, name: `Regression Numerical Methods ${suffix}`, description: 'Temporary end-to-end course' }) }, cookieA);
  assert(course.data?.id, 'Regression course creation failed');
  const lecture = await request('/api/documents/upload', { method: 'POST', body: body({
    name: `Regression Lecture ${suffix}.md`, courseId: course.data.id, workspaceId: workspace.id,
    content: '# Numerical Stability\n\n## Definition\nForward error measures the distance between the computed result and the exact result. Let $x$ be exact and $\\hat{x}$ be computed.\n\n## Theorem\nIf a computation is backward stable and the condition number is moderate, then the forward error is controlled.\n\n# Pivoting\n\n## Example\nGaussian elimination with partial pivoting chooses a large pivot and reduces round-off amplification. It is related to LU decomposition and numerical stability.\n\n## Review\nCompare forward error, backward error, condition number, Gaussian elimination, pivoting, and LU decomposition.'
  }) }, cookieA);
  const document = lecture.data; assert(document.id && document.courseId === course.data.id && document.content.length >= 2, 'Lecture import/structure failed');
  const page1 = await request(`/api/documents/${encodeURIComponent(document.id)}/pages/1`, {}, cookieA); assert(String(page1.data.text).includes('Forward error'), 'Page 1 not readable');
  const pivotPage = document.content.find(item => /pivoting/i.test(String(item.text || '')));
  assert(pivotPage && pivotPage.page !== page1.data.page, 'Structured lecture did not preserve a distinct pivoting page');
  const pageB = await request(`/api/documents/${encodeURIComponent(document.id)}/pages/${encodeURIComponent(pivotPage.page)}`, {}, cookieA); assert(/pivoting/i.test(String(pageB.data.text)), 'Pivoting page not readable');
  const secondPage = pivotPage.page;
  const started = await request('/api/learning/sessions', { method: 'POST', body: body({ workspaceId: workspace.id, courseId: course.data.id, documentId: document.id }) }, cookieA);
  const session = started.data; assert(session.id && session.pagesViewed.length === 0, 'Learning session did not start');

  const annotations = [];
  const annotationInputs = [
    { page: 1, type: 'highlight', color: 'yellow', text: 'Forward error measures the distance from the exact result.', note: '需要记住定义。' },
    { page: 1, type: 'highlight', color: 'purple', text: 'backward stable and the condition number is moderate', note: '这里和条件数有关。' },
    { page: secondPage, type: 'highlight', color: 'blue', text: 'partial pivoting chooses a large pivot', note: '算法步骤。' },
    { page: 1, type: 'knowledge', color: 'green', text: 'Forward error', note: '知识点：结果误差。' },
    { page: secondPage, type: 'knowledge', color: 'green', text: 'Pivoting and numerical stability', note: '知识点：选主元与稳定性。' },
    { page: 1, type: 'confusion', color: 'orange', text: 'Why does this condition control the forward error?', note: '这里没理解。' },
    { page: secondPage, type: 'exam-important', color: 'red', text: 'Compare forward error and backward error.', note: '考试重点。' }
  ];
  for (const input of annotationInputs) { const result = await request(`/api/documents/${encodeURIComponent(document.id)}/annotations`, { method: 'POST', body: body({ ...input, sessionId: session.id }) }, cookieA); annotations.push(result.data); }
  assert(annotations.length === 7, 'Annotation creation count failed');
  const listedAnnotations = await request(`/api/annotations?documentId=${encodeURIComponent(document.id)}`, {}, cookieA);
  assert(listedAnnotations.data.length === 7 && listedAnnotations.data.every(item => item.userId === userA.id && item.courseId === course.data.id), 'Annotation ownership/refresh failed');
  const edited = await request(`/api/annotations/${encodeURIComponent(annotations[0].id)}`, { method: 'PATCH', body: body({ note: '已编辑：定义需要和 backward error 对照。' }) }, cookieA);
  assert(edited.data.updatedAt && edited.data.note.includes('已编辑'), 'Annotation edit failed');
  const customNote = await request('/api/notes', { method: 'POST', body: body({ title: 'Regression custom note', content: '我需要把 forward error、backward error 和 condition number 分开理解。公式：\\(\\mathrm{fl}(x)=x(1+\\delta)\\)。', courseId: course.data.id, documentId: document.id, locator: { page: 1, selectedText: 'Forward error', formulaLatex: '\\mathrm{fl}(x)=x(1+\\delta)' } }) }, cookieA);
  assert(customNote.data.id, 'Custom note failed');

  const conversationId = `regression-closure-${suffix}`;
  const chained = [
    ['这个定理是什么意思？', 1], ['为什么需要这个条件？', 1], ['如果没有这个条件会怎么样？', 1], ['给我一个反例。', 1], ['它和前面那个定义有什么关系？', secondPage]
  ];
  const answers = [];
  for (const [message, page] of chained) {
    const answer = await request('/api/chat', { method: 'POST', body: body({ configId: 'local', conversationId, sessionId: session.id, documentId: document.id, courseId: course.data.id, page, selectedText: page === 1 ? 'backward stable and the condition number is moderate' : 'partial pivoting chooses a large pivot', message, language: 'zh' }) }, cookieA);
    answers.push(answer.data); assert(answer.data.answer && answer.data.context?.documentId === document.id && Array.isArray(answer.data.context?.annotations), `Chained question ${message} lost document context`);
  }
  const crossPage = await request('/api/chat', { method: 'POST', body: body({ configId: 'local', conversationId, sessionId: session.id, documentId: document.id, courseId: course.data.id, page: secondPage, selectedText: 'partial pivoting chooses a large pivot', message: '这个和刚才学的 forward error 有什么关系？', language: 'zh' }) }, cookieA);
  assert(crossPage.data.memory?.concepts?.length >= 1 && crossPage.data.context?.recentConversation?.length >= 1, 'Cross-page memory/conversation retrieval failed');
  const history = await request(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=30`, {}, cookieA); assert(history.data.messages.length >= 12, 'Conversation history persistence failed');
  const learningMemory = await request(`/api/memory?courseId=${encodeURIComponent(course.data.id)}&questionLimit=100`, {}, cookieA); assert(learningMemory.data.questions.length >= 6 && learningMemory.data.concepts.length >= 2, 'Long-term question/concept memory failed');
  const graph = await request(`/api/knowledge/graph?courseId=${encodeURIComponent(course.data.id)}`, {}, cookieA); assert(graph.data.nodes.length >= 2 && graph.data.edges.length >= 1, 'Knowledge graph update failed');
  await request('/api/prompt/settings', { method: 'POST', body: body({ developmentLogs: true }) }, cookieA);
  const debugAnswer = await request('/api/chat', { method: 'POST', body: body({ configId: 'local', conversationId, sessionId: session.id, documentId: document.id, courseId: course.data.id, page: 1, selectedText: 'Forward error', message: '请解释这个定义，并联系我的批注。', language: 'zh' }) }, cookieA);
  assert(debugAnswer.data.promptOptimization?.originalPrompt, 'Prompt trace missing');
  const inspector = await request('/api/agent/context/last', {}, cookieA);
  assert(inspector.data.enabled && inspector.data.context?.annotations?.length >= 7 && inspector.data.context?.optimizedPrompt, 'Development Agent Context Inspector did not expose actual context');
  const finished = await request(`/api/learning/sessions/${encodeURIComponent(session.id)}/finish`, { method: 'POST', body: '{}' }, cookieA);
  assert(finished.data.note?.rawEvidence?.counts?.annotations === 7 && finished.data.note.questions.length >= 7 && finished.data.experience?.concepts?.length >= 2, 'Learning note/experience generation failed');
  const notes = await request(`/api/learning/notes?sessionId=${encodeURIComponent(session.id)}`, {}, cookieA); assert(notes.data.notes.length === 1 && notes.data.notes[0].rawEvidence.annotations.length === 7, 'Learning note persistence failed');
  const experiences = await request(`/api/learning/experiences?courseId=${encodeURIComponent(course.data.id)}`, {}, cookieA); assert(experiences.data.experiences.length === 1, 'Learning experience persistence failed');
  const summary = await request(`/api/learning/summary?courseId=${encodeURIComponent(course.data.id)}`, {}, cookieA); assert(summary.data.questionsToday >= 7 && summary.data.learned.length >= 2, 'Learning summary did not use persisted evidence');
  const logout = await request('/api/auth/logout', { method: 'POST', body: '{}' }, cookieA); assert(logout.data.guest === true, 'Logout failed');
  const login = await request('/api/auth/login', { method: 'POST', body: body({ email: accounts[0].email, password: accounts[0].password }) }); cookieA = login.cookie; assert(login.data.user?.id === userA.id, 'Re-login failed');
  const remembered = await request('/api/chat', { method: 'POST', body: body({ configId: 'local', documentId: document.id, courseId: course.data.id, page: secondPage, message: '我之前学习这份讲义时主要哪里没理解？', language: 'zh' }) }, cookieA);
  assert(remembered.data.context?.memory?.relatedQuestions?.length >= 1 || remembered.data.memoryAssociations?.length >= 1, `Cross-session historical memory retrieval failed: ${JSON.stringify({ memory: remembered.data.context?.memory, associations: remembered.data.memoryAssociations })}`);

  const registeredB = await request('/api/auth/register', { method: 'POST', body: body(accounts[1]) }); cookieB = registeredB.cookie; userB = registeredB.data.user;
  const bMemory = await request(`/api/memory?courseId=${encodeURIComponent(course.data.id)}`, {}, cookieB);
  assert(bMemory.data.questions.length === 0 && bMemory.data.concepts.length === 0, 'Account isolation leaked A learning memory to B');
  const bDocs = await request('/api/documents', {}, cookieB); assert(!bDocs.data.some(item => item.id === document.id), 'Account isolation leaked A document to B');
  console.log(JSON.stringify({ ok: true, account: 'register/login/logout', document: 'upload/pages/course', annotations: '7 create + edit + reload', questions: answers.length + 2, crossPage: true, note: 'structured raw evidence', session: 'persist + finish', experience: 'persist', memory: 'cross-session', graph: `${graph.data.nodes.length} nodes/${graph.data.edges.length} edges`, inspector: 'actual prompt context', isolation: 'A not visible to B' }));
} finally {
  for (const [cookie, shouldDelete] of [[cookieA, Boolean(userA)], [cookieB, Boolean(userB)]]) {
    if (!cookie || !shouldDelete) continue;
    try { await request('/api/account', { method: 'DELETE', body: body({ confirmation: 'DELETE' }) }, cookie); } catch { /* preserve the original regression error */ }
  }
}
