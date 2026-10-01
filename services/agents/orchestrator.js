function createLearningOrchestrator({ ragService, memoryService, learningDb }) {
  function detectIntent(question = '', kind = 'text') {
    const value = String(question).toLowerCase();
    if (kind === 'summary' || /总结|摘要|summar/.test(value)) return 'summary';
    if (kind === 'formula' || /公式|推导|latex|formula|derive/.test(value)) return 'formula-tutor';
    if (/复习|测验|quiz|review|练习/.test(value)) return 'quiz';
    if (/关联|之前|历史|related|previous/.test(value)) return 'historical-association';
    return 'tutor';
  }
  function prepare({ question = '', body = {}, document = null, kind = 'text', scope = {} }) {
    const memory = memoryService.retrieve(question, { courseId: body.courseId || document?.courseId || null, limit: 6 });
    const retrieved = ragService.context(question, scope);
    const graph = learningDb.listGraph(body.courseId || undefined);
    const relatedConceptNames = new Set(memory.concepts || []);
    const relatedIds = new Set(graph.nodes.filter(node => relatedConceptNames.has(node.label)).map(node => node.id));
    const persistedRelations = graph.edges.filter(edge => relatedIds.has(edge.source) || relatedIds.has(edge.target)).slice(0, 12);
    const relations = [...(memory.graphRelations || []), ...persistedRelations].slice(0, 12);
    const agents = ['DocumentAgent', 'RetrievalAgent', 'MemoryAgent'];
    if (relations.length) agents.push('KnowledgeGraphAgent');
    agents.push(kind === 'summary' ? 'SummaryAgent' : kind === 'quiz' ? 'QuizAgent' : 'TutorAgent');
    return { intent: detectIntent(question, kind), agents, scope: body.scope || 'current-document', retrieved, memory, graph: { relations }, memoryText: memoryService.contextText(memory) };
  }
  return { detectIntent, prepare };
}

module.exports = { createLearningOrchestrator };
