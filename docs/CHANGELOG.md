# 阶段交付与回归记录

## 2026-10-07 本地优先数据库与完整回归修复

- 恢复 SQLite 零配置默认启动，同时保留 `STUDYAGENT_DB=mysql` 可选团队后端；健康检查与全部业务服务使用统一适配器。
- 修复游客/测试账号导入种子讲义时 chunk 错绑原始文档 ID 的问题；课程内自测现在可从本课程真实分块生成多类型题目，不跨课程、不填充虚构答案。
- `npm run check:all` 完整 20 组检查通过：学习闭环、账号隔离、多格式、Office 结构、OCR/数学公式、连续阅读、PDF 和桌面讲义回归均为 PASS。
- 桌面讲义按约定排除最大 13 MB 文件，其余 8 份、212 页均完成真实解析与检索；导入期间阅读保存探针零错误，单次最慢 166 ms（仅本机本轮实测）。

## 2026-10-04 — 移除伪精确掌握百分比，展示可核对学习证据

- 删除知识库列表、图谱节点/详情、学习进度与学习分析中的掌握百分比及条形图；保留知识点、复习、来源导航和学习历史，不删除用户资料。
- `services/db/sqlite.js` 按来源事件/已保存问题核对次数，错误不再混入提问次数；分开自评复习与自测题，只统计明确布尔自评，旧复习汇总缺少逐条结果时单独标注。旧问题按用户/课程/概念匹配且与事件去重。
- `public/app.js`、`learning-history.js`、`styles.css`：统一“尚未评估 / 已有自评记录 / 有待关注记录”，结果显示为自评答对或记住 X/Y 次而非掌握率，详情可查看时间、原问题及来源。中英展示均说明未经独立判题。
- `services/memory/index.js`、`promptOptimizer.js`、`server.js`：低旧分/未自测不再成为薄弱判据；Agent 只引用实际错误或最近自评未记住的记录，并明确不是掌握评估。分析接口移除数值 value，追加 learningEvidence；概念详情追加近期 learningEvents，非法自评返回 400 且不写库，未拥有概念返回 404。
- 无数据库迁移，无删库；旧分数保留作为兼容内部字段，不用于展示或能力判断。缓存版本 v29。
- 新增 `check:evidence`：临时库 + 中英渲染单元 + 真实 HTTP，覆盖旧高分、20/多次提问不证明掌握、错误不计提问、反复自评不标熟悉、历史来源/汇总、非法自评、图谱/分析/详情及 A/B 隔离。纳入完整回归。
- 完整回归 `ALL CHECKS PASSED (16)`，退出 0；34 份第一方 JS 语法检查通过。桌面全部 9 份讲义、473 页、4289 分块完成真实导入/API/检索及原字节检查；导入期间 585 次阅读保存、0 错误、最大 513ms（仅本次环境实测）。历史来源核对的小补充完成后，再运行 evidence、upgrade HTTP、原有 learning HTTP、prompt-plan 全部通过。
- 浏览器实测：知识库列表/图谱节点/概念详情无数字百分比，历史提问仍显示；旧复习汇总单列、未纳入评估，点击概念显示真实历史关联问题和来源。截图 `outputs/learning-evidence-regression.jpg`。概念关联来自既有规则提取，不等于已独立确认掌握或题目只涉及该概念，因此标为“关联提问”。原 6 份资料保留，数据库完整性 ok；新专项只操作临时账号/库，验证后清理。

## 2026-10-04 — 导入卡顿与阅读进度修复 / Phase 2 结构化 Prompt 增量

### Files Changed / Features Added

- `services/documents/parser.js`：从现有服务抽取并复用 PDF/OCR/公式/多格式解析；`importWorker.js`、`importJobs.js`：后台解析和本地向量计算、单 worker/最多 4 个任务、45 分钟上限、持久化状态、按账号获取。原始资料保持原字节，读取原 PDF 的展示路径不变。
- `services/http/requestQueue.js`、`server.js`：上传/重解析不在全局 API 队列内长时间等待，短事务入库仍串行；兼容既有同步上传及批量返回，前端采用异步任务轮询。列表不再携带全部文档正文。
- `services/rag/index.js`：接收经过校验的 worker 本地向量，批量索引事务，保留外部向量空间。
- `services/db/migrations.js`、`sqlite.js`：v2 增量迁移、阅读位置/累计已访问页、重解析保留位置、Prompt 结构计划持久化与导出。
- `services/agents/promptPlan.js`、`promptOptimizer.js`、`orchestrator.js`、`server.js`：12 种任务的结构化计划、Schema 校验、最多两次修复、明确失败回退、原问题保留、计划作为不可信建议、按原范围执行检索再构造最终上下文。不是用模型生成的一段字符串覆盖所有来源证据。
- `public/app.js`、`import-status.js`、`styles.css`、`index.html`：跨页面导入状态、刷新后查询任务、恢复最后阅读位置、按唯一已访问页显示进度、优化计划预览与窄侧栏换行。缓存版本 v28。
- `scripts/check-prompt-plan.mjs`、`check-reading-import-http.mjs` 新增专项；升级/语法/全量/全部讲义脚本扩展；文档同步真实能力边界。

### Database / API Changes

v1 保持不变，v2 新增 `reading_positions`、`document_import_jobs` 与 `prompt_optimization_logs.optimization_json`，迁移前备份，不删库。历史最后位置只能从旧记录近似回填；今后保存确切当前页。文档更新用 UPSERT 避免阅读位置被级联删除。

新增 GET `/api/imports`、GET `/api/imports/:id`、GET/PATCH `/api/documents/:id/reading-position`、DELETE `/api/prompt/logs/:id`。既有上传/批量/重解析支持 `async:true` 返回 202，原同步调用仍兼容；Prompt 预览追加 `structured` 与 `validation`，保留原有字段。

### Tests Added / Regression Result

最终全量 15 组 PASS（退出 0），33 份第一方 JS 语法 PASS；类型检查/lint 未配置，不冒称通过。涵盖既有账号、多格式、批注、聊天/记忆/学习闭环、PDF、OCR 合约，加上结构计划、阅读位置/后台任务/归属/失败恢复。

真实桌面 9 份讲义：473 页、4289 分块、75 公式候选；每份导入期间保存阅读进度，合计 648 次、0 错误，最大 366ms。首轮遗漏文件下载 Cookie 导致断言失败，补 Cookie 后全部重新运行。首轮教材请求曾达 4772ms，移出向量计算并批量写入后复测最大 366ms；不是删断言换取通过。

浏览器实测 PASS：跳至第 3 页不误报全部读完、返回第 1 页刷新续读正确；第 2 页提问、结束学习后刷新恢复第 2 页及问答；结构计划显示真实选段、文档与保存的历史问题。截图 `outputs/structured-prompt-regression.jpg`。临时测试账号和副本已清理，原 6 份用户资料保留；v2 备份 integrity_check 为 ok。

### Known Issues / Next Step

- PDF/OCR 总耗时仍取决于页数及模型；后台处理解决主线程阻塞，不等于更高识别精度。第 6 讲仍 0 个公式候选，75 是候选数，不是准确公式数。
- 普通远程 AI/视觉调用仍在全局队列内等待；请求级上下文隔离及安全并发仍是下一步，不直接移除队列破坏用户隔离。
- 导入中断后状态可见但需要重新上传，不支持任务自动续传。
- 结构化输出当前为 JSON 指令 + 本地 Schema 校验/修复；尚未逐 Provider 验证原生 JSON Schema 能力。本轮未用真实 API 凭据评估远程优化效果。上下文预算仍按字符近似，不是精确 Token 数。
- 本地证据模式的讲解模板仍有适用范围限制；以上浏览器问答验证数据链，不作为远程数学教学质量证明。完整浏览器自动 E2E、移动端与安全负载测试继续保留为待办。

下一步：独立请求上下文以进一步缩短远程 AI 排队，并完善 Provider 原生结构化输出/精确 Token 预算，然后进入结构化知识卡片。

## 2026-10-04 — Phase 0 / Phase 1 基础增量

### Files Changed

- services/db/sqlite.js、migrations.js：最近消息、原子文档更新/删除、章节/事件、保守证据指标、归属、清理/导出。
- services/rag/index.js、tokenize.js：中文双字词、同空间本地匹配、远程索引保留、向量验证、来源 ID。
- services/memory/index.js：问题不再增加掌握分，问题/错误/复习/自测事件，自评标识。
- services/agents/orchestrator.js、promptOptimizer.js：课程图谱范围、当前学习事件进入上下文。
- server.js：正确 HTTP 错误、可配置端口、用户级工作区会话/调试上下文、新查询接口。
- public/learning-history.js、app.js、styles.css、index.html：独立学习记录视图、课程/日期筛选、证据标签、来源导航；首页移除固定日期/完成数等演示内容。
- scripts/check-upgrade.mjs、check-upgrade-http.mjs、check-pdf-regression.mjs、check-syntax.mjs、check-all.mjs、package.json：专项回归、升级备份完整性和安全测试副本。
- README.md：新增能力边界、文档导航、真实验证命令。
- docs/：架构/能力/链路/模型/迁移/回归/安全。

### Database Changes

v1 schema_migrations + chapters + learning_events + 索引。已有数据自动备份后增量迁移，不删库。concepts 与 front/back cards 继续复用。

### API Changes

GET learning/chapters、learning/events、learning/mastery；现有聊天/引用对象保留兼容字段并追加来源 ID。默认端口不变。

### Tests Added

最近消息、中文查询、远程向量不覆盖/不混算、非法向量、事件幂等、标题章节、文档事务回滚、提问不制造掌握度、用户隔离、opt-out、备份完整性、重开幂等、问题页码/选段、无效页面过滤。

### Regression Result

基线：语法、核心、队列、HTTP、账号、闭环 PASS。首次完整 check:all 12 项 PASS；加入真实 HTTP 专项后 13 项 PASS。浏览器发现补充的阅读/页码问题已修复，相关专项再次 PASS；最终版本 `npm run check:all` 返回 `ALL CHECKS PASSED (13)`，退出码 0。

| 验证 | 结果 | 实测边界 |
|---|---|---|
| 第一方 JS 语法 | PASS | 26 文件；项目暂无独立 TypeScript/lint 流水线 |
| 请求队列/SQLite/升级/RAG/记忆 | PASS | 最新消息、中文匹配、向量空间、事务、备份、幂等 |
| 账号与真实 HTTP/学习闭环 | PASS | 7 批注/7 问题、跨页/跨 Session、经历/图谱/A-B 隔离 |
| MD/TXT/CSV/DOCX/PPTX/XLSX/PNG | PASS | 简单真实导入夹具、原字节、结构/存储/清理 |
| Mathpix/Ollama 接口合约 | PASS | 本地协议夹具；不代表第三方实网识别/生成质量 |
| 高代 PDF 副本 | PASS | 16 页、216 块、7 公式候选、原页/原文件、校正持久化 |
| 桌面全部 9 份讲义 | PASS | 473 页、4289 分块、75 公式候选；导入/结构/API/范围检索 |
| 浏览器新增学习记录 | PASS | 两页实际记录、精确来源跳转、筛选、经历、刷新恢复 |
| 大文件导入期间交互 | PARTIAL | 已复现排队超时，未实现后台任务 |
| 数学 OCR 准确性 | PARTIAL | 第 6 讲仍 0 个公式候选；没有逐公式人工精度评测 |
| 真实第三方模型调用 | Needs Verification | 本轮没有重新进行带真实凭据的服务商实网调用 |

桌面逐文件结果：教材 261 页/36 公式；第 0–7 讲分别 16/7、25/9、27/8、32/2、38/4、24/2、34/0、16/7（页/候选数）。PASS 不表示复杂排版、公式或答案全部正确。

真实用户库迁移前备份另经只读 `PRAGMA integrity_check` 验证为 ok，备份包含 6 份已有资料。仅清理本轮临时测试账号、测试导入副本及失败测试的临时目录；原资料和有效历史未删除。

浏览器实测 PASS：登录、真实首页、课程/日期过滤、未分类空结果、记录来源跳转、两页阅读、第二页提问、历史关联、结束学习、刷新恢复、退出；导出断言页面 `[1,2]` 与问题页码 `2`。保存验证截图，不把测试账号数据写进真实用户的学习记录。

### Known Issues / Next Step

Phase 1 已交付基础对象；PDF 章节识别/任意课程概念规范化仍 PARTIAL。大 PDF 解析/OCR 期间全局串行导致前端请求超时，已经实测复现，后台任务隔离尚未交付。旧阅读进度百分比/lastRead 与新事件、自动续读还没有统一，不能将事件准确计数等同于旧进度显示已经修复。Phase 2–10 尚未宣称完成，下一步优先请求级上下文/后台解析、阅读进度统一与严格结构化 Prompt 优化，再进入 KnowledgeCard Schema、课程 RAG 与习题闭环。详细路线见 ARCHITECTURE.md。
