# Existing Architecture Report / 当前架构与增量升级

审计日期：2026-10-04。证据来自源码调用链和本地测试，不依据文件名推定功能完成。项目保留原架构，不重新初始化。

## 1. 技术栈

- 前端：原生 HTML / CSS / JavaScript，静态资源由同一 Node 服务提供；PDF.js 4.10 本地资源；公式主要通过自实现 LaTeX → MathML 渲染。
- 后端：Node.js 22.5+，CommonJS，原生 HTTP 路由，无 Express、TypeScript、ORM、前端构建步骤。
- 数据库：内置 `node:sqlite` 的同步 SQLite，WAL；原始文件在 `uploads/`，解析资料、学习对象主要在 SQLite。
- 历史兼容层：`data/studyagent.json` 仍保存部分资料视图、访客设置和历史状态。双存储不是新设计目标，暂不直接删除。
- AI：服务端 Provider 工厂适配 OpenAI-compatible、Anthropic、Gemini、Mathpix；Ollama 使用兼容接口。
- OCR：Tesseract.js 中文/英文、Poppler 页面图片、可配置 Mathpix。数学规则校正不是通用数学 OCR 模型。
- 启动：`npm start`；默认 `http://127.0.0.1:4173`，支持 `STUDYAGENT_PORT`。
- 没有现成 Docker、桌面安装包、TypeScript 类型检查或完整 ESLint 配置。语法检查不能代替这些能力。

## 2. 目录与职责

```text
public/                    页面、交互、PDF 阅读、样式
server.js                  HTTP API、导入协调、学习业务、服务启动
config/modelProviders.js   Provider 预设及模型列表
services/db/               SQLite、兼容迁移、版本化迁移
services/documents/        多格式结构解析
services/rag/              词法 + 本地哈希向量检索、Embedding 索引
services/memory/           概念规则、历史问题关联、复习记录
services/agents/           工作流协调、Prompt 优化
services/llm/              Provider 请求、加密配置
services/auth/             账号、密码、Session
services/http/             请求体读取与串行队列
scripts/                   单元、协议、HTTP、讲义回归
docs/                      本轮审计、设计、验收记录
data/ uploads/ tmp/        运行数据；不要上传 GitHub
```

## 3. 已有功能与真实边界

账号注册/登录/恢复、账号数据隔离、课程创建/资料归属、导入、原 PDF 查看、批注 CRUD、普通笔记 CRUD、问答及引用、Provider 配置、Prompt 预览、可管理长期记忆、Session、学习笔记/经历、概念关系、复习调度已有实际 API 和存储。

知识抽取主要使用数值算法领域固定别名表；总结主要是启发式整理；图谱页面只展示少量概念按钮；卡片是 front/back 复习卡；复习题是检索证据驱动的题型模板。以上不等于通用概念抽取、完整结构化知识卡、AI 判题或可缩放图谱。

## 4. 数据模型

已有 User → Workspace → Course → Document → Section/Chunk → Annotation/Conversation/Question → Memory/Concept/Relation/Progress。另有 Notes、KnowledgeCards、QuizAttempts、ReviewSchedule、LearningSessions、LearningNotes、LearningExperiences。

本轮追加 `schema_migrations`、`chapters`、`learning_events`；继续使用 `concepts` 作为 KnowledgePoint，不再另建同义知识点表。详细字段见 DATABASE_SCHEMA.md。

## 5. AI 完整调用链

```text
选择文字/公式 → 阅读器请求体
→ /api/chat 或 /api/chat/stream
→ 当前账号/课程/文件范围
→ readerContext + Orchestrator
→ RAG + 批注/笔记 + 最近消息 + Memory + 学习事件
→ PromptOptimizer → 服务端 Provider
→ 回答/引用 → Conversation + Question + Memory + LearningEvent
→ 前端渲染与来源导航
```

主模型失败返回错误；本地证据模式会明确返回 mode=local。串行接口队列是当前全局账号上下文的保护机制，不能未经改造直接并发执行 API。

## 6. 文档完整调用链

上传 JSON（含 base64）→ 扩展名/大小检查 → 保存原始文件 → PDF 原生文本/OCR 或 Office/文本/表格解析 → Sections/Blocks/Locator → Chunks → SQLite → 本地索引 → 列表/阅读/检索。

PDF 由后端协调 PDF.js、Poppler、OCR；Word/PPT 的原生排版并没有完整重建，解析层主要保留语义结构。旧 DOC/PPT/XLS 在没有 LibreOffice 时仅有限可读字符串提取。图片描述必须配置支持 Vision 的 Provider。

## 7. RAG

SQLite 存片段和向量；检索先限定当前用户与文档/课程，再按关键词和 96 维本地哈希向量加权排序。没有 BM25、训练式 reranker 或 ANN 索引。远程 Embedding 可建索引，但同步回答检索仍走明确标记的本地检索，不声称已经支持远程查询向量。见 RAG_ARCHITECTURE.md。

## 8. 用户数据存储

核心对象按 user_id 过滤；文档/课程归属在数据库查询边界校验。密码 scrypt；Session 随机 token、HttpOnly Cookie；模型配置服务端 AES-GCM 加密文件。密钥与解密秘密文件均属运行数据，不进入版本控制。

## 9. Memory

记忆包含用户偏好、重要问题、错误、学习进度；历史问题关联使用规则概念、已有图边及相关度阈值，不伪造“以前问过”。可关闭、编辑、删除、导出和清空课程记忆。本轮学习事件同时保留原始行为 evidence 与 interpretation；提问不再增加掌握分。

## 10. 页面

首页、资料库、课程、阅读、AI 问答、知识、笔记、复习、统计、账号、设置。笔记页本轮补充学习记录视图。前端仍单文件为主，多处函数被再次赋值覆盖，是后续逐步拆分的主要技术债。

## 11–14. 可复用资产

- 组件：PDF.js 阅读器、来源跳转、公式渲染、批注菜单、Prompt 预览、账号页面、笔记编辑器、课程资料选择器。
- Service：parseStructuredDocument、createProvider、createMemoryService、createLearningOrchestrator、createPromptOptimizer、createRagService、createLearningDb。
- API：documents/pages/file、annotations、notes、chat、models/configs、prompt、memory、graph、learning/sessions、learning/experiences、review。
- 表：courses、document_sections、concepts、questions、knowledge_cards、learning_progress、learning_sessions 等；优先追加字段/关联，不建立重复实体。

## 15–19. 技术债、Bug、性能、安全、UX

- 已修复：最近消息查询错误、启动覆盖远程向量、不同模型向量混算、中文词法匹配过弱、文档更新不原子、删除资料误删共享概念、跨用户工作区聊天 ID 冲突、调试上下文跨用户共享。
- 仍需处理：巨型 server/app 文件、重复函数覆盖、JSON/SQLite 双存储、启动重复导入兼容片段、部分清理操作缺乏事务；阅读页面事件已保存，但旧 progress/lastRead 显示与自动续读位置尚未统一。
- 性能：同步 SQLite/文件读写、接口全局串行、大文档一次性返回、词法候选先截断、课程多个统计请求，没有分页/后台任务/全量向量搜索。
- 安全：ZIP 解压缺少独立条目验证和展开大小限制；Provider 可配置 URL 是本地管理信任面；自定义 Header 的敏感值仍需服务端脱敏；CSRF/Host 检查及限流需进一步强化。
- UX：首页固定日期/待办已改为当前日期、账号、真实复习队列；图谱缺 zoom/pan/drag；部分页面中英文不完整；公式渲染不是完整 KaTeX；选中文字的高亮定位尚非精确矩形持久化。

## 20. 本轮及后续路线

| Phase | 增量工作 | 验收重点 |
|---|---|---|
| 0 | 审计、确定性 Bug 修复、安全测试副本、文档 | 原功能回归，不抹除个人学习记录 |
| 1 | 复用 Course/Concept，章节、学习事件、证据掌握度、迁移 | 重启/隔离/幂等/来源/清空/导出 |
| 2 | 结构化 PromptOptimizationService、验证、上下文预算 | 原始意图不变，优化失败仍保留原始证据 |
| 3 | 扩展现有 cards 为结构化知识卡 | 真正 AI 生成、Schema、编辑/检索/去重/来源 |
| 4 | 课程知识库、同模型远程检索、混合融合/来源 | tenant + course 隔离、Embedding 故障降级 |
| 5 | 习题、提示梯度、步骤解答、尝试、错题 | 答案按用户动作显示，正确性与来源可追溯 |
| 6 | Memory、弱项、确定性 Mastery、个性化复习 | 自评与实际判题区分、不制造精确掌握度 |
| 7 | 已配置模型并行 Playground、任务偏好 | 同上下文、耗时/usage、失败隔离、真实模型调用 |
| 8 | Sidebar 配置、真实 Dashboard、响应式 | 配置持久化、键盘与移动操作 |
| 9 | 交互图谱 + 全局搜索 | 节点去重、来源反向导航、跨对象检索 |
| 10 | 全量回归、负载/安全、部署 | 桌面讲义、多账号、真实 Provider、异常路径 |

以上是路线，不表示所有阶段已经交付。阶段记录及实际验证以 CHANGELOG.md、TEST_PLAN.md 为准。

## 2026-10-04 后续增量：导入、续读与结构化 Prompt

长 PDF/图片/Office 导入与 PDF 重解析由 importWorker.js 调用共享 parser.js，隔离 CPU/OCR 和本地哈希向量计算，不在主 API 锁内等待。importJobs.js 维护最多 4 个等待/活动任务、单个解析工作线程、45 分钟失败上限；仅短暂进度写入与最终用户级批量事务入库使用原队列。工作线程不启动 HTTP、不读取模型密钥、不连接用户数据库。目录/首页响应省略页面全文，阅读时再取 pages，避免每次打开页面传整库全文。

reading_positions 与 LearningSession 配合，保存最后位置和跨会话去重访问页。前端再次进入同一页也会更新位置，重复渲染不重复发记录请求；来源引用指定页优先于续读页。实际访问与掌握程度严格分开。

PromptOptimizer 现有服务增量扩展：先确定性检测任务/上下文、增强检索，再可选请求优化模型并验证结构化计划，最后始终重新组装原问题与证据。远程优化不能替换整份提示词；界面支持查看结构化结果和失败回退状态。

剩余性能限制：普通 AI/数学 OCR 服务调用仍受原全局串行队列保护，慢远程请求仍可能拖延其他接口；上传仍为 JSON/base64；同步入库/索引、PDF 全页内容 API 仍需进一步分页/流式化。本轮不声称消灭所有卡顿。
