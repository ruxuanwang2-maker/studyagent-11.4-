# Existing Capability Map

状态：Implemented / Partially Implemented / Missing / Broken / Needs Verification。日期 2026-10-04。本表基于真实调用链；Implemented 仅指所述范围。

| 能力 | 状态 | 证据 / 边界 |
|---|---|---|
| 原生前端 + Node HTTP + SQLite | Implemented | 启动、HTTP、核心测试 |
| 注册、登录、Session 恢复 | Implemented | services/auth → user_sessions；多账号测试 |
| 用户数据隔离 | Implemented | DB 归属校验、auth/closure；新增 events/chapters 另测 |
| 课程创建、资料归属 | Implemented | courses / updateDocumentOrganization |
| PDF 原始阅读/页码/文件下载 | Implemented | 本地 PDF.js、page-image、file |
| 阅读位置/进度与新事件统一 | Implemented | reading_positions 保存最后页和去重访问页，刷新/登录/重解析恢复；不等同于掌握度 |
| PDF 文本、OCR、数学识别 | Partially Implemented | 字体映射 + OCR + Mathpix；不能保证扫描公式正确 |
| Word/PPTX/Excel 结构导入 | Partially Implemented | XML 段落、表格、标题、Notes；图像资源/复杂公式有限 |
| DOC/PPT/XLS | Partially Implemented | 可选 LibreOffice，否则有限字符串提取 |
| Markdown/TXT/CSV/图片 | Implemented | 解析和 HTTP 测试；Vision 依赖配置 |
| EPUB | Missing | 未注册解析器 |
| 原始排版全格式 WPS 级保真 | Missing | PDF 原版可显示；Office 不是原生编辑器 |
| 文本/公式选择提问 | Partially Implemented | selectedText/formula 传递与保存；需更多真实扫描样本 |
| 高亮、批注 CRUD | Implemented | annotations API；准确区域坐标持久化仍不足 |
| AI Chat/多 Provider | Implemented | 服务端适配器、加密配置、错误回传 |
| 各第三方 Provider 实网兼容 | Needs Verification | 协议测试不等于所有真实服务可用 |
| 连续对话 | Implemented | 本轮修复最近消息截断问题 |
| RAG 范围隔离/引用 | Implemented | user/course/doc/page，保留 chunkId |
| 神经语义检索/BM25/reranker | Partially Implemented | 本地哈希+关键词；远程索引存在，同模型查询待接通 |
| Prompt 优化/预览/Off/Smart/Always | Implemented | 结构化计划、Schema 类型/字段校验、一次输出修复、确定性回退、原意与证据保留；实网质量待验证 |
| Prompt 日志 | Implemented | 允许记忆或开发显式启用时保存原问题/优化问题/计划/校验；用户导出和隔离，opt-out 不默认保存 |
| 后台导入/重解析 | Implemented | 解析/OCR/本地向量计算在工作线程，短事务入库与原队列兼容；持久任务状态与中断失败 |
| 普通笔记 | Implemented | SQLite CRUD、来源跳转 |
| 学习 Session、学习经历 | Implemented | Session finish → note/experience |
| 学习总结语义分析 | Partially Implemented | 启发式与 evidence/interpretation 分离；非完整 LLM 总结 |
| 长期记忆控制 | Implemented | 查看、修改、删除、关闭、课程清空、导出 |
| 任意课程概念抽取/别名规范化 | Partially Implemented | 主要固定数值算法别名；任意领域未验证 |
| 知识图谱存储/关系管理 | Implemented | concepts/concept_relations、节点详情 |
| 图谱 zoom/pan/drag/完整多类型节点 | Missing | 当前概念按钮视图，不是完整可交互图网络 |
| 知识卡片 | Partially Implemented | 现有 front/back 卡；结构化理解卡待 Phase 3 |
| 自测/间隔复习 | Partially Implemented | 多题型模板、SM2 类调度、自评；没有完整判题 |
| Exercise Mode + Mistake Book | Missing | errors 记忆不等于持久化习题/尝试/错题系统 |
| 学习事件 + 显式章节 | Implemented | 本轮迁移追加，与已有源对象相连 |
| 学习证据展示 | Implemented | 无掌握百分比；知识库/图谱/分析统一核对来源事件、自评与错误，旧无来源汇总单列 |
| 独立掌握评估 | Missing | 未独立判题或校准；不从自评/阅读/旧分数宣称掌握或薄弱 |
| Multi-model Playground/任务偏好 | Missing | 不把模型下拉框算作比较中心 |
| Sidebar 自定义 | Missing | 固定 NAV |
| 统一全局搜索 | Missing | 文档检索已有，不涵盖全部对象 |
| 自动回归 | Implemented | 核心/HTTP/账号/讲义；不是全部浏览器 E2E |
| 生产部署/桌面打包/完整安全审计 | Needs Verification | 本地启动可用不代表可公开部署 |

## 开源设计借鉴（不复制代码）

- [Open WebUI 多模型聊天](https://docs.openwebui.com/features/chat-conversations/chat-features/multi-model-chats/)：同问题并排比较；StudyAgent 应再按学习任务保存偏好，不设置虚构全局最佳模型。
- [Open WebUI RAG](https://docs.openwebui.com/features/chat-conversations/rag/)：索引和查询模型必须一致；本轮先避免混算，远程查询另行接通。
- [Khoj Search](https://docs.khoj.dev/features/search/)：自然语言检索加范围过滤、阈值；本项目保留本地优先与可解释匹配。
- [AnythingLLM 文档范围](https://docs.anythingllm.com/chatting-with-documents/introduction)：持久工作区知识与一次性附件区别；适配为课程范围与当前阅读上下文。
- [LobeHub 官方使用文档](https://github.com/lobehub/lobehub/blob/canary/docs/usage/start.mdx)：角色、模型与资料绑定分离；复用现有 Provider/Orchestrator，不移植其完整运行框架。
- [Artha Study](https://github.com/arthalabs-in/study)：资料关联进度、错答形成复习卡；适配为证据事件到卡片/复习闭环。
- [Memori / AI Study Flashcards](https://github.com/DoradoDevs/ai-study-flashcards-app)：主动回忆、多种学习方式、间隔复习；不是同名 MemoriLabs 记忆基础设施项目。
- [Study Assistant 候选](https://github.com/neuronection/study-assistant)：提示梯度和结构化课程对象值得参考；用户没有指定仓库，此处明确是同名候选，不宣称唯一对应。
- RecallAI：未确认用户指的是哪个学习类开源仓库；不拿会议录制服务 Recall.ai 当作学习产品，也不虚构研究结论。

## 本轮复用与新增原则

复用已有账号、课程、文档、概念、卡片、记忆；新迁移仅追加确实需要的对象。任何待实现能力保持 Missing/Partial，不能用按钮或示例数据提升状态。
