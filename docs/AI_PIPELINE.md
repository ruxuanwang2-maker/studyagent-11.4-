# AI 请求与学习数据链

## 已接通

Reader 选择文本/LaTeX → API 请求包含 documentId/page/course/scope/selectedText/formula/conversationId/remember → 账号验证 → readerContext → Orchestrator.prepare → RAG、批注、笔记、最近消息、Memory、学习事件 → PromptOptimizer → Provider.chat/streamChat → 回答与引用 → conversations/messages + questions/memories/concepts/progress/events → Session 完成时生成 learning_notes/learning_experiences。

普通笔记、批注和页访问亦直接形成对应事件，下一次问题可获得当前资料最近的学习事件。历史泛问只检索真实持久对象，不从提示词生成假历史。

## Agent 角色的真实含义

DocumentAgent、RetrievalAgent、MemoryAgent、KnowledgeGraphAgent、TutorAgent 等是 Orchestrator 的工作流标签。当前不是每个标签都有独立 LLM、自主循环和工具调用。避免把 plan 中的名称数量当成多 Agent 完成度。

## Prompt 优化的当前边界

- 原始 message 持久化到用户消息；优化结果用于内部上下文；支持预览并选择原始/优化版本。
- `promptPlan.js` 输出结构化计划，包含 original_query、intent、task_type、difficulty、optimized_query、required_context、retrieval_query、answer_requirements、should_use_rag。保留旧 originalPrompt/optimizedPrompt 字段兼容 UI。
- includeDocument/includeMemory/includeConversation/includeKnowledge 控制来源；开发日志可显示实际最终 Prompt。
- 公式通过 formula 字段和源片段中的 LaTeX 进入上下文，不只传屏幕上的视觉文本。
- 远程结果整段 JSON 解析并校验类型、长度、枚举、原问题与任务类型；只允许一次输出修复，网络失败不重复套娃重试；失败明确返回 validation.fallbackReason 并使用确定性计划。支持无 Key 的 Ollama 优化器。
- 优化器只能生成计划，不得替换证据。最终 Prompt 始终重新组装原问题、当前页、选段、LaTeX、资料、批注、笔记、对话与真实记忆。模型系统消息明确拒绝执行参考区块里的指令；参考值 JSON 编码，预算裁剪保留完整边界。这降低注入风险，但不保证模型永不误判。
- 本地计划在首次 RAG 前增强检索词；有效远程计划可按相同用户/课程/页面作用域二次检索。没有新接通远程 Embedding 或神经重排器。
- 预览可展开结构化计划及校验状态。记忆启用且本次允许记忆时，原始/优化问题与计划同时入日志；本次禁止记忆不会默认新增优化日志，开发显式日志设置仍单独控制。

## 持久化与事实界限

learning_events.evidence_json 是观察到的页访问、标注、提问、自评等；interpretation_json 是启发式/模型解释。二者不得混同。问题只说明参与学习，不能证明正确理解。

复习目前基于用户 selfReported=true 的反馈，没有独立判题。学习证据返回 learningStatus、来源去重提问次数、逐条自评复习/自测结果、未解决错误及 caveat。score/confidence 仅为旧兼容内部字段，不用于页面显示或 Tutor 掌握断言。记忆检索不再把旧低分或没有测验记录称为薄弱；只把实际错误或最近自评未记住作为需要关注的记录，并明确不代表已测得掌握程度。

## 调试

`/api/agent/context/last` 仅在 developmentLogs 或 STUDYAGENT_DEV_CONTEXT=1 可见，本轮按用户存储；生产默认关闭。仍需增加 token/latency/精确预算。不可输出 API Key。

## 错误

主模型调用失败应返回明确错误，不静默换成本地模板。未配置主模型时返回 mode=local；对于任意选中文本，只展示证据并明确无法可靠解释任意定理。Provider 的空答案和异常结构还需要补充严格验证。
