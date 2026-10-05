function createLearningOrchestrator({ ragService, memoryService, learningDb }) {
  function emptyMemory() { return { concepts: [], relatedConcepts: [], graphRelations: [], relatedQuestions: [], relatedMemories: [], profile: null, weakConcepts: [] }; }
  function detectIntent(question = '', kind = 'text') {
    const value = String(question).toLowerCase();
    if (kind === 'summary' || /总结|摘要|summar/.test(value)) return 'summary';
    if (kind === 'formula' || /公式|推导|latex|formula|derive/.test(value)) return 'formula-tutor';
    if (/复习|测验|quiz|review|练习/.test(value)) return 'quiz';
    if (/关联|之前|历史|related|previous/.test(value)) return 'historical-association';
    return 'tutor';
  }
  async function prepare({ question = '', body = {}, document = null, kind = 'text', scope = {} }) {
    const [memory, retrieved, annotations, notes, learningEvents, recentConversation, graph] = await Promise.all([
      body.memoryEnabled === false
        ? Promise.resolve(emptyMemory())
        : memoryService.retrieve(question, { courseId: body.courseId || document?.courseId || null, limit: 6 }),
      ragService.context(body.retrievalQuery || question, scope),
      document?.id ? learningDb.listAnnotations({ documentId: document.id, page: scope.page }) : Promise.resolve([]),
      document?.id ? learningDb.listNotes({ documentId: document.id, limit: 40 }) : Promise.resolve([]),
      body.memoryEnabled === false ? Promise.resolve([]) : learningDb.listLearningEvents({ courseId: body.courseId || document?.courseId || document?.course_id || undefined, limit: 40 }),
      body.conversationId ? learningDb.listConversationMessages(body.conversationId, 8) : Promise.resolve([]),
      learningDb.listGraph(body.courseId || document?.courseId || document?.course_id || undefined)
    ]);
    const recentLearningEvents = learningEvents.filter(event => (document?.id && event.document_id === document.id) || /之前|以前|最近|历史|previous|history/i.test(question)).slice(0, 10);
    const relatedConceptNames = new Set(memory.concepts || []);
    const relatedIds = new Set(graph.nodes.filter(node => relatedConceptNames.has(node.label)).map(node => node.id));
    const persistedRelations = graph.edges.filter(edge => relatedIds.has(edge.source) || relatedIds.has(edge.target)).slice(0, 12);
    const relations = [...(memory.graphRelations || []), ...persistedRelations].slice(0, 12);
    const agents = ['DocumentAgent', 'RetrievalAgent', 'MemoryAgent'];
    if (relations.length) agents.push('KnowledgeGraphAgent');
    agents.push(kind === 'summary' ? 'SummaryAgent' : kind === 'quiz' ? 'QuizAgent' : 'TutorAgent');
    return { intent: detectIntent(question, kind), agents, scope: body.scope || 'current-document', retrieved, memory, graph: { relations }, annotations, notes, recentConversation, recentLearningEvents, memoryText: memoryService.contextText(memory) };
  }
  return { detectIntent, prepare };
}

module.exports = { createLearningOrchestrator };
