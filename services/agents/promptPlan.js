const TASK_TYPES = ['explain', 'summarize', 'derive', 'prove', 'solve', 'compare', 'translate', 'review', 'quiz', 'flashcard', 'research', 'code'];
const CONTEXT_TYPES = ['selected_text', 'current_page', 'document', 'course', 'annotations', 'notes', 'conversation', 'learning_memory', 'knowledge_graph'];
const PromptOptimizationSchema = {
  type: 'object', additionalProperties: false,
  required: ['original_query','intent','task_type','difficulty','optimized_query','required_context','retrieval_query','answer_requirements','should_use_rag'],
  properties: {
    original_query: { type: 'string', maxLength: 4000 }, intent: { type: 'string', maxLength: 300 },
    task_type: { type: 'string', enum: TASK_TYPES }, difficulty: { type: 'string', enum: ['unknown','introductory','intermediate','advanced'] },
    optimized_query: { type: 'string', minLength: 1, maxLength: 6000 },
    required_context: { type: 'array', maxItems: 9, items: { type: 'string', enum: CONTEXT_TYPES } },
    retrieval_query: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 600 } },
    answer_requirements: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } },
    should_use_rag: { type: 'boolean' }
  }
};
function taskFor(question) {
  // User intent comes from the query, never from an instruction in a document.
  const text = String(question || '').toLowerCase();
  const rules = [['flashcard',/知识卡|闪卡|flashcard/],['quiz',/测验|出题|自测|quiz/],['translate',/翻译|translate/],['summarize',/总结|摘要|概括|summar/],['derive',/推导|derive|derivation/],['prove',/证明|prove|proof/],['solve',/计算|求解|solve|compute|calculate/],['compare',/区别|比较|对比|compare|difference/],['code',/代码|编程|debug|code/],['review',/复习|回顾|review/],['research',/研究|research/]];
  return rules.find(([,regex]) => regex.test(text))?.[0] || 'explain';
}
function localPromptPlan(input = {}) {
  const original = String(input.originalPrompt || '').trim().slice(0, 4000);
  const context = input.context || {}, task = input.kind === 'summary' ? 'summarize' : taskFor(original);
  const required = [];
  if (context.selectedText) required.push('selected_text');
  if (context.documentTitle || input.documentId) required.push('current_page','document');
  if (input.courseId) required.push('course');
  if (context.annotations?.length) required.push('annotations');
  if (context.notes?.length) required.push('notes');
  if (input.recentConversation?.length) required.push('conversation');
  if (input.memories?.selected?.length) required.push('learning_memory');
  if (input.memories?.graphRelations?.length) required.push('knowledge_graph');
  const location = [context.documentTitle && `《${context.documentTitle}》`, context.pageNumber && `第 ${context.pageNumber} 页`].filter(Boolean).join(' · ');
  const hints = task === 'prove' || task === 'derive' ? ['明确条件和符号','给出可核查的关键步骤','不足的证据明确说明'] : task === 'translate' ? ['保留原意与数学符号','不添加解释或无关知识'] : ['直接回应原问题','区分原文证据与推断','数学公式使用 LaTeX'];
  const reference = context.selectedText ? `当前选中：${String(context.selectedText).slice(0,700)}` : '';
  return { original_query: original, intent: task, task_type: task, difficulty: 'unknown', optimized_query: [original,location && `阅读位置：${location}`,reference].filter(Boolean).join('\n'), required_context: [...new Set(required)], retrieval_query: [original.slice(0,600), context.selectedText && String(context.selectedText).slice(0,600)].filter(Boolean), answer_requirements: hints, should_use_rag: Boolean(context.documentTitle || input.documentId || input.documentContext?.length || input.courseId) };
}
function validatePromptPlan(value, original, expectedTask) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('优化结果必须为 JSON 对象');
  for (const key of Object.keys(value)) if (!PromptOptimizationSchema.properties[key]) throw new Error(`未知优化字段: ${key}`);
  for (const key of PromptOptimizationSchema.required) {
    const schema = PromptOptimizationSchema.properties[key], item = value[key];
    if (schema.type === 'string') {
      if (typeof item !== 'string' || item.length > schema.maxLength || (schema.minLength && item.trim().length < schema.minLength) || (schema.enum && !schema.enum.includes(item))) throw new Error(`无效优化字段: ${key}`);
    } else if (schema.type === 'boolean') { if (typeof item !== 'boolean') throw new Error(`无效优化字段: ${key}`); }
    else if (!Array.isArray(item) || item.length > schema.maxItems || item.some(entry => typeof entry !== 'string' || !entry.trim() || (schema.items.maxLength && entry.length > schema.items.maxLength) || (schema.items.enum && !schema.items.enum.includes(entry)))) throw new Error(`无效优化字段: ${key}`);
  }
  if (value.original_query !== original) throw new Error('优化器不得改写 original_query');
  if (value.task_type !== expectedTask) throw new Error('优化器不得改变原始任务类型');
  return value;
}
function parsePromptPlan(text, original, expectedTask) {
  const value = String(text || '').trim();
  // Only an entire JSON object (optionally one fenced block), never brace slicing.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  return validatePromptPlan(JSON.parse(fenced ? fenced[1] : value), original, expectedTask);
}
module.exports = { TASK_TYPES, CONTEXT_TYPES, PromptOptimizationSchema, localPromptPlan, validatePromptPlan, parsePromptPlan };
