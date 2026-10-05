import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import dbModule from '../services/db/sqlite.js';
import memoryModule from '../services/memory/index.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'studyagent-evidence-'));
const db = dbModule.createLearningDb(path.join(fixture, 'evidence.sqlite'));
db.ensureBootstrap({ documents: [] });
try {
  const memory = memoryModule.createMemoryService(db);
  const legacy = db.upsertConcept({ name: 'Condition Number', scoreDelta: 0.96 });
  assert.equal(db.getMasteryEvidence(legacy.id).learningStatus, 'unassessed');
  assert.equal(db.getMasteryEvidence(legacy.id).score, null, 'old numeric scores are not learning evidence');
  assert.equal(memory.retrieve('条件数').weakConcepts.length, 0, 'unassessed is not weak');
  for (let i = 0; i < 4; i++) memory.recordInteraction({ question: '条件数是什么意思？', answer: 'Condition Number describes sensitivity.' });
  let evidence = db.getMasteryEvidence(legacy.id);
  assert.equal(evidence.questionCount, 4);
  const oldQuestionId = db.saveQuestion({ question: '旧历史里的条件数问题', concepts: ['Condition Number'] });
  db.recordProgress({ conceptId: legacy.id, event: 'review', correct: true });
  const historicalEvidence = db.getMasteryEvidence(legacy.id);
  assert.equal(historicalEvidence.questionCount, 5, 'old saved question text remains visible as evidence');
  assert.equal(historicalEvidence.historicalQuestionCount, 1);
  assert.equal(historicalEvidence.unverifiedLegacyReviewCount, 1);
  assert.equal(historicalEvidence.reviewCount, 0, 'a legacy counter is not a graded result');
  db.database.prepare('DELETE FROM questions WHERE id=?').run(oldQuestionId);
  db.database.prepare('UPDATE learning_progress SET review_count=0,correct_count=0 WHERE concept_id=?').run(legacy.id);
  assert.equal(evidence.learningStatus, 'unassessed');
  const errorId = memory.updateError({ concept: 'Condition Number', description: '没有分清敏感性与算法误差' });
  evidence = db.getMasteryEvidence(legacy.id);
  assert.equal(evidence.questionCount, 4, 'recording an error is not asking another question');
  assert.equal(evidence.unresolvedErrors, 1);
  assert.equal(evidence.learningStatus, 'needs_attention');
  const context = memory.contextText(memory.retrieve('条件数'));
  assert.ok(context.includes('未解决错误 1 条'));
  assert.ok(!/\d+(?:\.\d+)?%/.test(context), 'tutor context cannot turn an estimate into a percentage');
  db.database.prepare('UPDATE errors SET resolved=1 WHERE id=?').run(errorId);
  assert.equal(db.getMasteryEvidence(legacy.id).learningStatus, 'unassessed');
  for (let i = 0; i < 5; i++) memory.recordReview({ concept: 'Condition Number', correct: true });
  evidence = db.getMasteryEvidence(legacy.id);
  assert.equal(evidence.learningStatus, 'self_reported');
  assert.equal(evidence.masteryAssessed, false);
  assert.equal(evidence.label, 'Developing', 'even repeated self-reviews cannot establish mastery');
  assert.equal(evidence.selfReviewCount, 5);
  assert.equal(memory.retrieve('条件数').weakConcepts.length, 0);
  memory.recordQuizAttempt({ concept: 'Condition Number', answers: [{ correct: true, question: 'Q1' }, { correct: false, question: 'Q2' }] });
  evidence = db.getMasteryEvidence(legacy.id);
  assert.equal(evidence.quizItemCount, 2);
  assert.equal(evidence.reviewCount, 7);
  assert.equal(evidence.correctCount, 6);
  assert.equal(evidence.learningStatus, 'needs_attention');
  assert.throws(() => memory.recordQuizAttempt({ concept: 'Condition Number', answers: [{}] }), /boolean/);
  db.recordLearningEvent({ type: 'quiz', conceptId: legacy.id, sourceId: 'ungraded-fixture', evidence: { correct: true } });
  assert.equal(db.getMasteryEvidence(legacy.id).reviewCount, 7, 'unidentified grading source cannot masquerade as a self-assessment');
  assert.equal(db.listKnowledgePoints()[0].learningEvidence.questionCount, 4);
  assert.equal(db.listGraph().nodes[0].learningEvidence.quizItemCount, 2);
  assert.ok(db.getConceptDetails(legacy.id).learningEvents.length);

  const app = fs.readFileSync('public/app.js', 'utf8');
  const helper = app.slice(app.indexOf('function learningStatusLabel('), app.indexOf('function knowledge(){'));
  const runtime = { language: 'zh', uiLanguage() { return this.language; }, esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.createContext(runtime);
  // uiLanguage closes over the sandbox variable, rather than depending on call receiver.
  vm.runInContext('uiLanguage = () => language;', runtime);
  vm.runInContext(helper, runtime);
  for (const state of ['unassessed', 'self_reported', 'needs_attention']) {
    const markup = runtime.learningEvidenceMarkup({ ...evidence, learningStatus: state });
    assert.ok(!markup.includes('%'));
    assert.ok(markup.includes('不等于掌握程度'));
    assert.ok(!markup.includes('width:'));
  }
  runtime.language = 'en';
  assert.ok(runtime.learningEvidenceMarkup(evidence).includes('not independently graded'));
  assert.ok(runtime.knowledgePointMarkup({ id: legacy.id, name: '<script>', learningEvidence: evidence }).includes('&lt;script>'));
  const b = db.createUserAccount({ email: 'evidence-b@regression.local', username: 'B' });
  db.setUserId(b.id);
  assert.equal(db.listGraph().nodes.length, 0);
  assert.throws(() => db.getMasteryEvidence(legacy.id), /不属于/);
  console.log('PASS: traceable event counts, legacy scores ignored, unassessed != weak, self-report != mastery, error/question separation, explicit results, graph/detail evidence, bilingual percentage-free rendering, tenant isolation');
} finally {
  db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const cookies = [];
async function request(route, { cookie = '', method = 'GET', body } = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
try {
  for (const label of ['A', 'B']) {
    const registered = await request('/api/auth/register', { method: 'POST', body: { email: `evidence-${label}-${Date.now()}@example.com`, username: `Evidence ${label}`, password: 'Regression-Evidence-2026!' } });
    assert.equal(registered.status, 201); cookies.push(registered.cookie);
  }
  const [a, b] = cookies;
  const result = await request('/api/learning/quiz/attempt', { cookie: a, method: 'POST', body: { concept: 'Evidence Concept', answers: [{ correct: true }, { correct: false }] } });
  assert.equal(result.status, 201);
  const evidence = (await request('/api/learning/mastery', { cookie: a })).data.concepts[0];
  assert.equal(evidence.quizItemCount, 2); assert.equal(evidence.correctCount, 1); assert.equal(evidence.masteryAssessed, false);
  const points = (await request('/api/knowledge', { cookie: a })).data.points;
  assert.equal(points[0].learningEvidence.learningStatus, 'needs_attention');
  const graph = (await request('/api/graph', { cookie: a })).data;
  assert.equal(graph.nodes[0].learningEvidence.quizItemCount, 2);
  const details = (await request(`/api/graph/${evidence.id}`, { cookie: a })).data;
  assert.equal(details.learningEvents.length, 2);
  const analytics = (await request('/api/analytics', { cookie: a })).data;
  assert.equal(analytics.mastery[0].value, undefined, 'analytics cannot publish a mastery percentage');
  assert.equal(analytics.mastery[0].learningEvidence.correctCount, 1);
  assert.equal((await request('/api/learning/mastery', { cookie: b })).data.concepts.length, 0);
  assert.equal((await request(`/api/graph/${evidence.id}`, { cookie: b })).status, 404);
  assert.equal((await request('/api/learning/quiz/attempt', { cookie: a, method: 'POST', body: { concept: 'Evidence Concept', answers: [{}] } })).status, 400);
  assert.equal((await request('/api/learning/mastery', { cookie: a })).data.concepts[0].quizItemCount, 2);
  console.log('PASS: real HTTP evidence propagation to knowledge/graph/details/analytics, invalid results rejected without writes, A/B isolation');
} finally {
  for (const cookie of cookies) {
    assert.equal((await request('/api/account', { cookie, method: 'DELETE', body: { confirmation: 'DELETE' } })).status, 200);
  }
}
