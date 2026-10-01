function contextText(context = {}) {
  return [`Document: ${context.documentTitle || 'Untitled'}`, context.pageNumber ? `Page: ${context.pageNumber}` : '', context.selectedText ? `Selected text:\n${context.selectedText}` : '', context.formula ? `Formula (LaTeX):\n${context.formula}` : '', context.surroundingText ? `Surrounding context:\n${context.surroundingText}` : '', context.previousParagraph ? `Previous paragraph:\n${context.previousParagraph}` : '', context.nextParagraph ? `Next paragraph:\n${context.nextParagraph}` : ''].filter(Boolean).join('\n\n');
}
function buildPrompt(kind, context, question) {
  const languageInstruction = context.language === 'en' ? 'Answer in English. Keep technical terms precise and use Markdown with LaTeX for mathematics.' : '请使用中文回答。请基于给定文献上下文回答，不要编造不存在的内容；使用 Markdown，数学表达式使用 LaTeX。';
  const base = `你是一名严谨的大学课程助教。${languageInstruction}\n\n上下文：\n${contextText(context)}\n\n用户问题：\n${question || (context.language === 'en' ? 'Please explain this content.' : '请解释这段内容。')}`;
  if (kind === 'formula') return `${base}\n\n请重点解释公式整体含义、每个符号、成立条件、推导思路、直观意义，并给出一个具体例子。`;
  if (kind === 'summary') return `${base}\n\n请总结核心观点、关键概念、论证关系和需要复习的内容。`;
  if (kind === 'translate') return `${base}\n\n请准确翻译选中文本，并保留公式、术语和引用结构。`;
  return `${base}\n\n请先给出结论，再分点解释证据和推理。`;
}

module.exports = { contextText, buildPrompt };
