const crypto = require('crypto');

const CONCEPT_ALIASES = [
  ['LU Decomposition', ['lu decomposition', 'lu 分解', 'lu']],
  ['Gaussian Elimination', ['gaussian elimination', '高斯消元', '消元']],
  ['Pivoting', ['pivoting', 'partial pivoting', '选主元', '主元']],
  ['Condition Number', ['condition number', '条件数']],
  ['Numerical Stability', ['numerical stability', '数值稳定性', '稳定性']],
  ['Forward Error', ['forward error', '前向误差']],
  ['Backward Error', ['backward error', '后向误差']],
  ['QR Decomposition', ['qr decomposition', 'qr 分解']],
  ['RAG', ['rag', 'retrieval augmented generation', '检索增强生成']]
];
const CONCEPT_RELATIONS = [
  ['Matrix Operations', 'Gaussian Elimination', 'PREREQUISITE_OF'],
  ['Gaussian Elimination', 'LU Decomposition', 'RELATED_TO'],
  ['Gaussian Elimination', 'Pivoting', 'RELATED_TO'],
  ['Pivoting', 'Numerical Stability', 'RELATED_TO'],
  ['Numerical Stability', 'Forward Error', 'RELATED_TO'],
  ['Numerical Stability', 'Backward Error', 'RELATED_TO'],
  ['Condition Number', 'Forward Error', 'RELATED_TO'],
  ['Condition Number', 'Backward Error', 'RELATED_TO'],
  ['LU Decomposition', 'QR Decomposition', 'RELATED_TO']
];
function id(prefix) { return `${prefix}-${crypto.randomBytes(4).toString('hex')}`; }
function conceptsIn(text) { const lower = String(text || '').toLowerCase(); return CONCEPT_ALIASES.filter(([, aliases]) => aliases.some(alias => lower.includes(alias))).map(([name]) => name); }
function overlap(a, b) { const left = new Set(a); const right = new Set(b); const intersection = [...left].filter(value => right.has(value)).length; const union = new Set([...left, ...right]).size; return union ? intersection / union : 0; }
function relationBetween(left, right) { return CONCEPT_RELATIONS.find(([source, target]) => (source === left && target === right) || (source === right && target === left)) || null; }
function relatedNames(concepts, maxDepth = 3) { const seen = new Set(concepts); let frontier = [...concepts]; for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) { const next = []; for (const current of frontier) for (const [source, target] of CONCEPT_RELATIONS) { const neighbor = source === current ? target : target === current ? source : null; if (neighbor && !seen.has(neighbor)) { seen.add(neighbor); next.push(neighbor); } } frontier = next; } return [...seen].filter(name => !concepts.includes(name)); }
function statusFor(score) { return score >= 0.8 ? 'mastered' : score >= 0.55 ? 'familiar' : score > 0 ? 'learning' : 'unseen'; }

function createMemoryService(learningDb) {
  function updateReviewMastery(conceptRow) {
    const evidence = learningDb.getMasteryEvidence(conceptRow.id);
    if (evidence.score === null) return conceptRow;
    return learningDb.upsertConcept({ name: conceptRow.name, courseId: conceptRow.courseId, scoreDelta: evidence.score - conceptRow.masteryScore, status: evidence.label === 'Weak' ? 'weak' : evidence.label === 'Familiar' ? 'familiar' : 'learning', metadata: { masteryEvidence: evidence } });
  }
  function retrieve(question, { courseId, limit = 8, enabled = true } = {}) {
    if (enabled === false) return { concepts: [], relatedConcepts: [], graphRelations: [], relatedQuestions: [], relatedMemories: [], profile: null, weakConcepts: [] };
    const concepts = conceptsIn(question); const directRelated = relatedNames(concepts); const graph = learningDb.listGraph(courseId); const graphLabels = new Map(graph.nodes.map(node => [node.id, node.label])); const graphRelated = graph.edges.flatMap(edge => { const source = graphLabels.get(edge.source); const target = graphLabels.get(edge.target); if (concepts.includes(source)) return [target]; if (concepts.includes(target)) return [source]; return []; }); const relatedConcepts = [...new Set([...directRelated, ...graphRelated])].filter(name => !concepts.includes(name));
    const memories = learningDb.listMemories({ courseId, includeGlobal: true, limit: 30 }); const questions = learningDb.listQuestions({ courseId, limit: 60 }); const historicalQuery = /之前|以前|历史|最近学|主要哪里|薄弱|不理解|学习经历|what did i|previous|history|struggled/i.test(String(question)); const relatedQuestions = questions.map(item => { const itemConcepts = item.concepts || []; const direct = overlap(concepts, itemConcepts); const matchedConcepts = itemConcepts.filter(name => concepts.includes(name)); const graphMatches = itemConcepts.filter(name => relatedConcepts.includes(name)); const association = direct >= 0.3 ? 'direct-concept' : graphMatches.length ? 'concept-graph' : historicalQuery ? 'historical-recall' : ''; const relevance = direct >= 0.3 ? Math.min(1, 0.65 + direct * 0.35) : graphMatches.length ? Math.min(1, 0.48 + (graphMatches.length / Math.max(1, itemConcepts.length)) * 0.2) : historicalQuery ? 0.56 : 0; return { ...item, concepts: itemConcepts, relevance, association, matchedConcepts: [...new Set([...matchedConcepts, ...graphMatches])] }; }).filter(item => item.relevance >= 0.5).sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    const relatedMemories = memories.filter(item => item.type !== 'user-profile' && ([...concepts, ...relatedConcepts].some(concept => String(item.content || '').toLowerCase().includes(concept.toLowerCase())) || (historicalQuery && ['question', 'error', 'learning-progress'].includes(item.type)))).slice(0, limit);
    const graphRelations = CONCEPT_RELATIONS.filter(([source, target]) => concepts.includes(source) || concepts.includes(target)).map(([source, target, type]) => ({ source, target, type }));
    return { concepts, relatedConcepts, graphRelations, relatedQuestions, relatedMemories, profile: learningDb.getUserProfile(), weakConcepts: learningDb.listConcepts(courseId).map(item => ({ ...item, learningEvidence: learningDb.getMasteryEvidence(item.id) })).filter(item => item.learningEvidence.learningStatus === 'needs_attention').slice(0, 8) };
  }
  function recordInteraction({ question, answer, courseId = null, documentId = null, conversationId = null, page = null, selectedText = '', formula = '', optedOut = false }) {
    if (optedOut || !question) return { stored: false, reason: 'memory-opted-out', concepts: [] };
    const concepts = conceptsIn(`${question}\n${answer}`); const questionId = learningDb.saveQuestion({ question, courseId, sourceDocumentId: documentId, concepts, answerSummary: String(answer || '').slice(0, 500), conversationId });
    const conceptRows = concepts.map(name => learningDb.upsertConcept({ name, courseId, scoreDelta: 0, metadata: { lastQuestionId: questionId } }));
    const eventConcepts = conceptRows.length ? conceptRows : [{ id: null }];
    eventConcepts.forEach(conceptRow => learningDb.recordLearningEvent({ type: 'question', sourceId: questionId, courseId, documentId, conceptId: conceptRow.id, evidence: { question, answerSummary: String(answer || '').slice(0, 500), conversationId, ...(Number.isInteger(Number(page)) && Number(page) > 0 ? { page: Number(page) } : {}), selectedText: String(selectedText || '').slice(0, 5000), formula: String(formula || '').slice(0, 5000) } }));
    conceptRows.forEach(conceptRow => learningDb.recordProgress({ conceptId: conceptRow.id, event: 'question' }));
    for (let i = 0; i < conceptRows.length; i += 1) for (let j = i + 1; j < conceptRows.length; j += 1) learningDb.saveRelation({ sourceId: conceptRows[i].id, targetId: conceptRows[j].id, type: 'RELATED_TO', weight: 0.55, source: 'question-memory' });
    const allConceptRows = learningDb.listConcepts(courseId); for (const current of conceptRows) for (const existing of allConceptRows) { const relation = relationBetween(current.name, existing.name); if (relation && current.id !== existing.id) learningDb.saveRelation({ sourceId: current.id, targetId: existing.id, type: relation[2], weight: 0.72, source: 'concept-ontology' }); }
    learningDb.saveMemory({ id: id('memory'), type: 'question', scope: courseId ? 'course' : 'user', courseId, documentId, content: question, importance: concepts.length ? 0.75 : 0.45, metadata: { questionId, concepts, answerSummary: String(answer || '').slice(0, 500) } });
    return { stored: true, questionId, concepts, conceptRows };
  }
  function updateError({ description, correction, courseId = null, concept = null, questionId = null }) {
    if (questionId && !learningDb.listQuestions({ limit: 10000 }).some(item => item.id === questionId)) throw new Error('问题不存在或不属于当前用户');
    const conceptRow = concept ? learningDb.upsertConcept({ name: concept, courseId, scoreDelta: -0.08, status: 'weak' }) : null;
    const errorId = id('error');
    learningDb.database.prepare('INSERT INTO errors(id,user_id,concept_id,question_id,description,correction,severity,resolved,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(errorId, learningDb.currentUserId(), conceptRow?.id || null, questionId, description, correction || '', 0.7, 0, new Date().toISOString());
    learningDb.recordLearningEvent({ type: 'error', sourceId: errorId, courseId, conceptId: conceptRow?.id || null, evidence: { description, correction: correction || '', questionId } });
    if (conceptRow) { learningDb.recordProgress({ conceptId: conceptRow.id, event: 'error' }); learningDb.updateReviewSchedule({ conceptId: conceptRow.id, correct: false }); }
    learningDb.saveMemory({ type: 'error', scope: courseId ? 'course' : 'user', courseId, conceptId: conceptRow?.id, content: `${description}${correction ? `；纠正：${correction}` : ''}`, importance: 0.9, metadata: { errorId } });
    return errorId;
  }
  function recordQuizAttempt({ courseId = null, concept, answers = [] }) {
    if (!Array.isArray(answers) || answers.some(item => !item || typeof item.correct !== 'boolean')) throw new Error('Quiz self-assessment requires a boolean correct result for every item');
    const normalized = Array.isArray(answers) ? answers.map(item => ({ correct: item.correct === true, question: String(item.question || ''), citation: String(item.citation || '') })) : [];
    const score = normalized.filter(item => item.correct).length, total = normalized.length;
    const conceptRow = concept ? learningDb.upsertConcept({ name: concept, courseId, scoreDelta: 0, metadata: { lastQuizScore: score, lastQuizTotal: total } }) : null;
    const attemptId = learningDb.saveQuizAttempt({ courseId, concept, score, total, answers: normalized });
    normalized.forEach((item, index) => {
      learningDb.recordLearningEvent({ type: 'quiz', sourceId: `${attemptId}:${index}`, courseId, conceptId: conceptRow?.id || null, evidence: { ...item, selfReported: true, attemptId } });
      if (conceptRow) { learningDb.recordProgress({ conceptId: conceptRow.id, event: 'review', correct: item.correct }); learningDb.updateReviewSchedule({ conceptId: conceptRow.id, correct: item.correct }); }
    });
    learningDb.saveMemory({ type: 'learning-progress', scope: courseId ? 'course' : 'user', courseId, conceptId: conceptRow?.id, content: `${concept || '当前资料'} 复习题得分 ${score}/${total}`, importance: 0.65, metadata: { attemptId, score, total, selfReported: true } });
    return { attemptId, score, total, concept: conceptRow ? updateReviewMastery(conceptRow) : null, selfReported: true };
  }
  function recordReview({ courseId = null, concept, correct = true }) {
    if (!concept) return { stored: false, reason: 'concept-required' };
    const conceptRow = learningDb.upsertConcept({ name: concept, courseId, scoreDelta: 0, metadata: { lastReviewCorrect: correct === true } });
    learningDb.recordProgress({ conceptId: conceptRow.id, event: 'review', correct: correct === true });
    const scheduleId = learningDb.updateReviewSchedule({ conceptId: conceptRow.id, correct: correct === true });
    learningDb.recordLearningEvent({ type: 'review', sourceId: id('review-result'), courseId, conceptId: conceptRow.id, evidence: { correct: correct === true, selfReported: true, scheduleId } });
    learningDb.saveMemory({ type: 'learning-progress', scope: courseId ? 'course' : 'user', courseId, conceptId: conceptRow.id, content: `${concept} 复习${correct ? '完成' : '需要再次复习'}`, importance: 0.55, metadata: { correct: correct === true, scheduleId, selfReported: true } });
    return { stored: true, concept: updateReviewMastery(conceptRow), correct: correct === true, scheduleId, selfReported: true };
  }
  function contextText(context) { const lines = []; if (context.profile) lines.push(`用户学习偏好：回答${context.profile.answerStyle === 'concise' ? '简洁' : '详细'}；公式${context.profile.formulaStyle === 'plain' ? '使用线性文本' : '优先使用 LaTeX'}${context.profile.learningGoals ? `；学习目标：${context.profile.learningGoals}` : ''}${context.profile.programmingLanguage ? `；常用编程语言：${context.profile.programmingLanguage}` : ''}`); if (context.concepts.length) lines.push(`相关概念：${context.concepts.join('、')}`); if (context.relatedConcepts?.length) lines.push(`知识关联候选：${context.relatedConcepts.join(' → ')}`); if (context.graphRelations?.length) lines.push(`概念关系：${context.graphRelations.map(item => `${item.source} ${item.type} ${item.target}`).join('；')}`); if (context.relatedQuestions.length) lines.push(`历史问题：${context.relatedQuestions.map(item => `${item.association === 'concept-graph' ? '（知识图谱关联）' : ''}「${item.question}」`).join('；')}`); if (context.weakConcepts.length) lines.push(`需要关注的学习记录（不是掌握度结论）：${context.weakConcepts.map(item => `${item.name}（未解决错误 ${item.learningEvidence?.unresolvedErrors || 0} 条；存在错误或最近自评未记住）`).join('、')}`); if (context.relatedMemories.length) lines.push(`长期记忆：${context.relatedMemories.map(item => item.content).join('；')}`); return lines.join('\n'); }
  return { conceptsIn, retrieve, recordInteraction, updateError, recordQuizAttempt, recordReview, contextText, statusFor };
}

module.exports = { createMemoryService, conceptsIn };
