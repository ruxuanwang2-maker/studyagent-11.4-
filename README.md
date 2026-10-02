# StudyAgent

StudyAgent 是一个本地优先的 AI 学习工作台 MVP，用于阅读资料、提问、批注、整理知识和复习。项目刻意不依赖构建工具，因此只要安装 Node.js、无需 Python 运行时即可运行。

## 当前已实现

- 首页仪表盘：展示持久化的学习指标、重点任务、薄弱知识和最近生成的知识卡片。
- 资料库：内置数值分析和 AI 基础资料，并提供统一导入入口，支持 PDF、Word、PowerPoint、Markdown、TXT、Excel、CSV 和图片。PDF 及其他二进制文件会以原始字节保存；结构化格式在本地服务器解析，阅读器会将非 PDF 文件以页面、幻灯片、工作表或章节形式呈现，而不是强制转换为 PDF。
- 扫描 PDF 的本地 OCR：使用 Poppler 的 `pdftoppm` 渲染页面，使用随包提供的 `@tesseract.js-data/chi_sim` 模型识别简体中文，并保存带页码引用的 OCR 结果。状态接口为 `GET /api/ocr/status`。
- 公式识别阅读：同一条本地处理链会将常见 PDF/OCR 数学模式拆分为公式块、规范化为 LaTeX，并使用浏览器原生 MathML 渲染；界面同时展示原始识别文本和置信度。阅读器会保留上传的 PDF 字节，并通过 `GET /api/documents/:id/page-image/:page` 提供“原始排版”切换。
- 阅读工作台：提供大纲、页码导航、缩放、页面摘要、本地高亮、笔记、文本选择操作和 AI 侧边栏。
- 证据优先的本地检索：基于关键词和混合检索形态返回文档/页面引用，供聊天和解释功能使用。
- 知识点、知识卡片、轻量知识图谱、复习队列、掌握度更新、学习分析、隐私设置和命令面板。
- 与产品功能对应的 Node API 边界：文档、批注、聊天、流式聊天、解释、摘要、知识卡片、知识库、图谱、复习、分析、设置、学习总结、测验以及可检查的学习编排器计划。
- 个人账号系统：支持游客模式、注册、登录、退出、持久会话、个人资料、修改密码、账号导出和账号删除；Account 页面提供可操作的账号管理入口。

## 启动

```powershell
npm start
```

打开 http://127.0.0.1:4173

结构化文档、章节、分块、向量、笔记、批注、知识卡片、概念、关系、问题、记忆、学习进度、复习计划、账号和会话都会持久化到 `data/studyagent.sqlite`。`data/studyagent.json` 仅作为旧版种子界面的兼容和一次性初始化来源保留。用户上传的本地文件写入 `uploads/`。默认的本地学习助手模式不会请求外部服务；安装 npm 依赖后，OCR 处理也完全在本地执行。

未登录时使用游客模式，游客不会写入长期学习记忆；登录个人账号后，文档、课程、对话、RAG 检索、知识图谱、学习进度、Prompt 设置和模型配置都按 `user_id` 隔离。密码使用本地服务端 scrypt 哈希保存，会话使用 HttpOnly、SameSite Cookie；模型配置按用户写入本地加密文件 `data/model-configs/`。账号导出接口为 `GET /api/account/export`，删除账号要求提交 `DELETE` 确认。

PDF 重要说明：在二进制上传修复之前构建的版本可能会显示替换字符（`���`）。这是因为旧版 UTF-8 解码已经丢失了原始 PDF 字节，这些导入记录会被标记为需要重新导入。请重新上传一次原始 PDF；当前上传流程会保留原始字节、执行本地页面提取，并对没有可选文本的页面运行 OCR。

公式说明：默认公式处理仍是基于 OCR 证据的本地启发式规范化层，用于从当前 PDF 文本或 OCR 结果中恢复常见关系、定义域、希腊字母、根号、分式和矩阵表达式。对于扫描讲义、复杂排版或本地 OCR 置信度不足的页面，可以在“设置 → 专用数学 OCR”中配置 Mathpix App ID 和 App Key。阅读器解析视图会提供“使用专用数学 OCR 重识本页”入口；服务端把页面图像提交到 Mathpix `/v3/text`，接收文本、LaTeX、MathML 和逐行结果，并将去重后的 LaTeX 公式块写回文档页、分块和检索索引。密钥只保存在本地服务端加密配置中，不会下发到前端。没有配置 Mathpix 时不会伪造远端结果，系统继续使用本地回退识别，并保留原始识别文本和可人工修正的 LaTeX。

## 演示流程

1. 进入“首页”→“继续阅读”。
2. 在第 3 页选择 Backward stability 相关句子，点击“高亮”或“解释”。
3. 使用同一段选中文本创建知识卡片。
4. 提问“前向误差和后向误差有什么区别？”，检查回答中的页面引用。
5. 点击“总结”，再进入“知识库”和“复习”，查看持久化后的下游状态。

## 验证

服务器没有第三方运行时依赖。可以使用以下命令验证：

```powershell
npm start
Invoke-RestMethod http://127.0.0.1:4173/api/documents
Invoke-RestMethod http://127.0.0.1:4173/api/knowledge/graph
```

## 架构边界

当前实现刻意保持本地优先 Node 服务器和 SQLite 契约的简洁性。未来可以在现有解析器、向量和模型服务接口之后增加 Python/FastAPI 服务或神经检索适配器，而无需修改阅读器界面。

## 多模型 API 与 AI 阅读

进入“设置”→“AI 模型设置”即可添加模型服务。页面支持 OpenAI、DeepSeek、Anthropic Claude、Google Gemini、OpenRouter、SiliconFlow、Moonshot/Kimi、智谱/GLM、通义千问/DashScope、Ollama 本地模型以及自定义 OpenAI 兼容接口。选择服务商后会自动填充 Base URL 和备用模型；“刷新模型列表”会尝试请求服务商的 Models API，远程接口不可用时则回退到本地模型注册表。Ollama 默认使用 `http://127.0.0.1:11434/v1`，不要求 API Key，但需要本机 Ollama 服务和对应模型已启动。

服务器提供以下模型接口：

```text
GET    /api/models/providers
GET    /api/models/configs
POST   /api/models/configs
DELETE /api/models/configs/:id
POST   /api/models/configs/:id/test
POST   /api/models/discover
POST   /api/chat
POST   /api/chat/stream
```

API Key 不会完整返回，也不会写入 `data/studyagent.json`。游客兼容配置保存在 `data/model-config.enc`，登录账号的模型配置保存在按账号分隔的 `data/model-configs/` 加密文件中；加密密钥由本机项目数据目录中的随机本地密钥派生，因此在同一项目目录下重启服务、切换正常/提权启动方式时仍能读取配置。这属于本地静态保护，不是云端密钥管理器，也不能替代 Windows Credential Manager。不要将这些文件复制到其他机器，也不要提交到 Git。默认的本地学习助手模式不会发出外部模型请求；响应中会包含 `mode: "local"`，以避免界面将本地检索回答误显示为远程模型回答。

如需添加或更新模型，请编辑 `config/modelProviders.js`，补充对应的服务商/模型能力元数据。OpenAI、DeepSeek、OpenRouter、SiliconFlow、Moonshot/Kimi、智谱/GLM、通义千问、Ollama 和自定义兼容服务统一走 OpenAI-compatible 适配器；请求会自动补齐标准 `Accept`、`User-Agent` 和 `Content-Length`，兼容需要明确请求长度的网关。只有当服务不是 OpenAI 兼容协议时，才需要在 `services/llm/providers.js` 中实现专用请求解析。阅读器通过 `prompts/index.js` 中共享的 Prompt/Context Builder 发送文档标题、页码、选中文本、附近文本、公式 LaTeX 和用户问题，默认不会发送整个 PDF。

修改 PDF/OCR/解析器代码后，请先运行固定的真实样例回归：

```powershell
npm run check:pdf
```

HTTP 集成检查（`npm run check:http`）会调用真实的本地服务，验证 SQLite 文档目录、知识点/知识图谱、概念关系、复习队列、笔记/批注/知识卡片的增删改查、SQLite 学习分析以及 workspace/当前页/当前文件/指定文件/课程检索范围；检查结束后会清理自己创建的记录。

多格式 HTTP 检查（`npm run check:multiformat:http`）会真实上传 Markdown、TXT、CSV、DOCX、PPTX、XLSX 和 PNG，验证结构化 sections/chunks 返回、SQLite 目录持久化和删除闭环；DOCX/PPTX/XLSX 的页面、表格、备注和工作表结构，以及 PNG 的本地 OCR 元数据和原始图片接口也会在同一条服务级链路中校验。检查还会用 Markdown 与 DOCX 走 `POST /api/documents/upload-batch`，验证批量导入、部分失败结果结构和清理闭环。浏览器上传对文本格式使用 UTF-8，对 PDF、Office 和图片使用 Base64，避免二进制文件被文本解码损坏。

完整回归入口为 `npm run verify`（等同于 `npm run check:all`）。它会按顺序执行语法、数学 OCR、核心数据层、账号隔离、多格式 HTTP、原有学习 HTTP、新增真实学习闭环、PDF 高代讲义和桌面讲义文件夹回归；桌面回归默认扫描 `C:\Users\<当前用户>\Desktop\讲义` 下全部支持格式，逐份验证上传、结构化页面/区段、SQLite 目录、当前文件检索、原始字节和删除清理。也可以通过 `STUDYAGENT_LECTURE_DIR` 指定其他讲义目录。大文件导入的 JSON 请求上限为 64 MiB，长时间 OCR 回归的单次请求等待上限为 30 分钟。

账号隔离检查（`npm run check:auth`）会真实注册两个临时账号，验证会话恢复、长期画像、资料、模型配置、导出和账号删除，并确认 B 账号不能读取 A 账号的数据；检查结束后会清理临时账号。

同一检查还会确认本地 PDF.js 资源、原始 PDF 流、页面 AST、公式块和原始页面图片。远程模型服务测试需要真实 API Key 和外网访问；构建检查及本地模式测试不能证明上游模型服务当前可用。

界面和 AI 输出语言可以在设置中选择 `中文` 或 `English`。选中的 `zh`/`en` 值会持久化在本地：界面会翻译工作区导航和主要学习页面，同时该值也会通过共享上下文构建器传递给本地学习助手和已配置的远程模型服务。

## 结构化学习工作区

当前实现已在原有阅读器之上增加一条真实的本地优先学习数据链路：

- 支持的导入类型：PDF、DOCX、DOC、PPTX、PPT、Markdown、TXT、XLSX、XLS、CSV、PNG、JPG/JPEG 和 WEBP。
- 在源格式能够提供相应信息时，结构化解析器会保留页面、标题、段落、列表、公式、幻灯片文本框、备注、工作表/单元格地址、表格以及图片/OCR 位置。阅读器页面携带带类型的内容块，因此表格、列表、备注、基于 OMML 的公式候选结果和主动调用的 Vision 描述不会被压扁为一整段文本。图片资料先经过本地 OCR；阅读器中的“使用 Vision 分析图表/公式”功能只有在配置视觉模型且用户主动调用时才会运行，并将描述结果持久化后加入检索索引。旧版二进制 DOC/PPT/XLS 会使用可读的打印文本回退路径，按旧版段落拆分并明确标记解析能力受限；OOXML 格式的 DOCX/PPTX/XLSX 使用更丰富的结构化解析路径。
- SQLite 保存在 `data/studyagent.sqlite`，其中包含 Workspace/Course/Document 记录、章节、分块、向量、问题、记忆、概念、关系和学习进度。
- RAG 服务使用结构感知分块：标题、段落、公式、表格、备注和图片等带类型内容块会成为可单独追踪的分块，并写入 `blockType`/`blockIndex` 元数据；非结构化文本则按段落边界和长度上限处理。系统会保存本地哈希向量回退实现（`local-hash-v1`），执行候选池检索、归一化词法加余弦重排，并使用明确的相关性阈值；低相关性分块会在构建上下文之前被排除。模型服务抽象还提供服务器端 `embed()` 和 `vision()` 适配器，对应 `/api/ai/embed` 和 `/api/ai/vision`；`/api/learning/reindex` 可以使用已配置的模型向量服务重建指定文档或课程，而 RAG 默认仍使用离线本地回退实现。
- 聊天和 `/api/learning/search` 支持 `current-page`、`current-document`、`course`、`documents` 和 `workspace` 上下文范围，并返回检索分块对应的页码/幻灯片/工作表/章节引用。空的课程或文件选择会保持为空，不会静默扩大为整个知识库。
- 长期记忆与聊天记录分开持久化。“知识库”页面提供可编辑的用户画像记忆（回答风格、公式风格、学习目标和编程语言）、记忆数量、编辑/删除/导出控制、学习进度、总结和测验记录；“设置”可以关闭记忆捕获。每次聊天或阅读提问都提供“保存到长期记忆”的开关，API 也接受 `remember: false`；启用记忆后，已保存的用户画像会加入 Agent 上下文。
- 历史关联使用相关性阈值和小型概念本体（例如 Gaussian Elimination → Pivoting → Numerical Stability → Backward Error）。当历史问题是通过知识图谱关系检索到时，回答会将其标记为知识图谱关联，而不会假装它是直接的词面匹配；新的概念关系会持久化到 `concept_relations`。
- 聊天轮次也会保存到 SQLite 的 `conversations` 和 `messages` 表，包括上下文范围、选中文本、引用、服务商和模型元数据。当前会话可以通过 `GET /api/conversations` 和 `GET /api/conversations/:id/messages` 查询；旧版 JSON 消息列表仅为兼容现有界面状态而保留。阅读器进入文档时会创建 `learning_sessions`，聊天和批注会关联当前会话；结束会话后会将可观测原始证据分别整理到 `learning_notes` 和 `learning_experiences`，并把 `rawEvidence` 与 `interpretation` 分开保存。
- 笔记现在使用 SQLite 的 `notes` 表，而不是原先静态的笔记页面。笔记可以从阅读器选中文本创建，也可以独立创建；每条笔记保留文档/课程/页码/章节元数据，支持编辑和删除，并可跳转回来源页面。
- 阅读器高亮和批注也已迁移到 SQLite 的 `annotations` 表；`/api/annotations` 以及阅读器高亮操作都使用持久化存储，批注支持 PATCH 编辑并保留 `user_id/course_id/updated_at`。学习分析使用真实的 SQLite 问题、笔记和批注事件，而不是固定的仪表盘数字。
- 知识卡片持久化在 SQLite 的 `knowledge_cards` 表中；启动时会迁移旧版卡片，创建卡片使用同一存储，删除来源文档时会同时删除关联卡片。
- 首页和资料库的统计卡片现在读取 `/api/analytics`；它们展示可核验的文档、问题、概念和笔记数量，不再把不受真实活动支撑的固定“学习时长”当作用户数据。

常用本地接口包括 `/api/learning/documents`、`/api/learning/search`、`/api/learning/reindex`、`/api/learning/sessions`、`/api/learning/notes`、`/api/learning/experiences`、`/api/learning/progress`、`/api/learning/summary`、`/api/learning/quiz`、`/api/memory`、`/api/memory/export`、`/api/graph`、`/api/agent/plan`、`/api/agent/context/last`、`/api/ai/embed`、`/api/ai/vision` 和 `/api/questions`。`/api/agent/context/last` 只在开发日志开关或 `STUDYAGENT_DEV_CONTEXT=1` 时返回最近一次真实 Agent 上下文；生产默认关闭。PDF 回归命令会验证上传的高代讲义样例，包括页面渲染、OCR 和公式提取。

## 明确边界 / TODO

- 旧版二进制 DOC/PPT/XLS 会优先检测本机的 `soffice`/LibreOffice 转换器；检测到时先转换为 DOCX/PPTX/XLSX，再复用结构化解析器，尽量保留标题、表格、幻灯片和公式。没有转换器或转换失败时会使用可读的打印文本回退路径，并在文档 metadata 与 `/api/parser/status` 中明确标记受限能力；旧版二进制的完整布局恢复仍取决于本地转换器。
- 默认向量实现是确定性的本地哈希向量（`local-hash-v1`），目的是保证离线可用。它不等同于神经网络向量模型；虽然已经存在模型服务提供的 `embed()` 适配器，但默认不会启用基于远程向量模型的索引。
- 公式恢复默认使用 PDF 文本/OCR 证据上的本地启发式层；设置 Mathpix App ID 和 App Key 后，解析视图可以调用专用数学 OCR，并将 LaTeX、MathML 和逐行公式结果写回页面、分块与检索索引。原始 PDF 视图仍是排版权威，解析视图会同时暴露 LaTeX 候选结果和原始识别文本，便于人工修正。未配置 Mathpix 时保留本地回退，不伪造远程识别结果。
- 持久化数据、按页面检索、可编辑的知识图谱节点详情与概念关系、动态 Workspace/Course/Document 页面、基于 SQLite 的每日总结、基于检索内容的测验生成、测验结果持久化、自适应复习间隔以及学习编排器计划均已实现。测验接口会明确使用 `retrieval-grounded-local` 模式；未配置远程模型时不会假装自己是远程 LLM。更丰富的自适应复习 Agent 体验和调度分析仍明确不属于本次迭代范围，而不是用隐藏的模拟功能冒充已经完成。

## 功能详解：从资料到长期学习记忆

StudyAgent 的核心不是某个单独页面，而是下面这条可追踪的数据链：

```text
选择课程/资料
    ↓
阅读页面、幻灯片或工作表
    ↓
文本/公式选择与批注
    ↓
基于选中文本提问
    ↓
文档 + RAG + 批注 + 历史问题 + 学习记忆
    ↓
带来源的 AI 回答
    ↓
学习笔记与 Learning Experience
    ↓
概念抽取与归一化
    ↓
个人知识图谱
    ↓
掌握度、错误记忆和复习队列
    ↓
下一次提问获得个性化上下文
```

### 资料导入与结构化解析

资料导入不会只生成一个纯文本文件，而是统一转成带来源位置的 Document Model：

```text
Document
├── id / user_id / course_id
├── title / file_type / source_path
├── metadata
├── sections
│   ├── page / slide / sheet / chapter
│   ├── title / position
│   └── structured content blocks
├── chunks
└── embeddings
```

不同格式会尽量保留各自结构：

- PDF 保存页码、标题、段落、表格、图片、文本层和 OCR 结果；
- DOCX 保存 Heading、段落、列表、表格、图片和公式候选；
- PPTX 保存 Slide 编号、标题、文本框、备注、表格和图片；
- XLSX 保存 Sheet、单元格地址、表头、数据类型和表格区域；
- Markdown 保存标题层级、段落、列表、表格和代码块；
- 图片资料保存 OCR 文本、图片元数据，并提供图表/公式 Vision 分析入口。

解析后的页面或区段会进入 SQLite、Chunk 索引和阅读器。阅读器展示的文件名直接来自上传文件名；引用则携带文档 ID、页码/幻灯片/工作表和区段位置，便于从 AI 回答回到原始资料。

### OCR、公式和原始排版

扫描 PDF 和图片会经过本地 OCR。PDF 没有文本层时，系统先将页面渲染为图片，再进行中文识别；解析结果会保留原始文本和置信度。常见数学表达式会被识别为公式块并规范化为 LaTeX，前端使用 MathML/可视公式展示，避免用户直接看到 `\\frac`、转义符或 OCR 乱码。

阅读器同时保留两种视图：

1. 解析视图：适合选择、搜索、批注、RAG 和 AI 提问；
2. 原始排版视图：直接展示上传的 PDF 页面图片，作为版式权威来源。

对于复杂公式、低清扫描或本地 OCR 置信度不足的页面，可以在设置中配置 Mathpix App ID 和 App Key，主动执行“专用数学 OCR 重识本页”。密钥只保存于本地服务端加密配置，不会发送到前端或提交 Git。

### 阅读、选择、批注与学习笔记

用户可以在当前页面选择普通文本、公式或混合内容，然后执行：

- 解释、总结、详细推导、举例和“为什么”；
- 高亮、创建笔记、创建知识卡片和生成复习题；
- 标记“这里没理解”“考试重点”或自定义问题；
- 使用“与之前知识关联”查看历史学习内容。

每条批注都带有 `user_id`、`course_id`、`document_id`、页面/区段、选中文本、公式 LaTeX、类型和时间戳。批注可以编辑、删除、搜索和按课程/概念聚合。学习 Session 结束后，系统不会简单拼接聊天记录，而是把高亮、批注、问题、回答、困难点和重点整理为 Learning Note 与 Learning Experience。

### AI 阅读上下文与 RAG

用户问“这里为什么需要这个条件？”时，Agent 会保留当前页面和选中文本，不要求用户重新复制上下文。上下文可能包括：

- 当前文档、课程和页面内容；
- 当前选中文本和公式 LaTeX；
- 页面附近段落、表格或备注；
- 当前课程或指定文件的检索结果；
- 当前会话中的连续追问；
- 相关批注、笔记和知识卡片；
- 历史问题、概念图谱和薄弱知识；
- 用户设置的回答语言、公式表达偏好和详细程度。

检索采用结构感知分块、关键词候选、向量相似度和相关性阈值过滤。每个 Chunk 保留 `blockType`、`blockIndex`、页码/幻灯片/工作表/章节等元数据，回答可以生成“《某讲义》第 12 页”的来源引用。

### 多模型 API 与本地模式

设置页支持 OpenAI、DeepSeek、Claude、Gemini、OpenRouter、SiliconFlow、Moonshot/Kimi、智谱、通义千问、Ollama 和自定义 OpenAI-compatible 服务。统一 Provider 接口包括：

```text
chat()    普通对话
stream()  流式回答
embed()   生成向量
vision()  分析图片、图表和公式
```

默认本地模式不调用外部服务，使用本地检索和结构化资料回答，并显式返回 `mode: "local"`。配置远程服务后，服务端会根据用户选择调用对应模型；不同 Provider 的请求格式、Base URL、模型列表发现和错误信息由服务端适配器处理。前端永远不会获得完整 API Key。

### 长期记忆、学习经历与知识图谱

长期记忆与聊天记录分开保存，主要包括：

- User Profile Memory：学习目标、回答风格、公式风格和常用语言；
- Concept Memory：概念别名、来源、掌握状态和相关概念；
- Question Memory：历史问题、答案摘要、难度和解决状态；
- Error Memory：错题、误解、容易混淆的概念；
- Learning Progress：阅读、批注、提问、复习和测验证据；
- Conversation Memory：当前会话的连续指代和追问。

概念会进行归一化，避免同一个知识点因为中英文名称不同而重复建节点。知识图谱关系包括 `RELATED_TO`、`PREREQUISITE_OF`、`DERIVED_FROM`、`CONFUSED_WITH`、`SOLVED_BY`、`MENTIONED_IN` 和 `LEARNED_WITH`。再次学习同一概念时更新掌握度、置信度、提问次数、批注次数和最近复习时间，而不是创建重复概念。

掌握度不会仅根据“看过一次”计算。系统综合阅读、批注、连续提问、反例请求、错误理解、测验结果和复习记录；证据不足时使用 `Unknown`、`Low Evidence`、`Developing`、`Familiar` 等状态，避免输出没有依据的伪精确百分比。

知识图谱节点可以反向打开来源资料、历史问题、相关批注、学习经历和复习建议。学习总结会区分 `rawEvidence` 与 `interpretation`：前者是可核验事件，后者是 Agent 基于证据得出的推断。

## 页面与模块导航

| 页面/模块 | 作用 |
| --- | --- |
| 首页 Home | 查看学习统计、继续阅读、今日重点和最近学习活动 |
| 资料库 Library | 管理 Workspace、Course 和 Document，导入多格式资料 |
| 课程 Courses | 创建课程、组织讲义、查看课程进度 |
| 阅读 Reading | 阅读原始排版或解析内容，选择文本/公式，创建批注并提问 |
| AI Chat | 在工作区、课程、当前文件或当前页面范围内进行对话 |
| 知识库 Knowledge | 查看记忆、概念、知识卡片、学习经历和可导出的个人学习数据 |
| 笔记 Notes | 管理带来源位置的学习笔记并回到原文 |
| 复习 Review | 查看复习队列、生成多类型自测题并更新学习状态 |
| 学习分析 Learning Analytics | 查看阅读、提问、批注、概念和复习等可核验统计 |
| 设置 Settings | 选择语言、配置模型、管理长期记忆和专用数学 OCR |

## 数据持久化与安全边界

主要本地数据位置：

```text
data/studyagent.sqlite       # 文档、区段、分块、对话、笔记、记忆、图谱和进度
data/studyagent.json         # 旧版种子数据兼容文件
data/model-config.enc        # 游客模型配置的本地加密文件
data/model-configs/           # 登录用户模型配置
uploads/                      # 用户上传的原始资料
```

这些路径已被 `.gitignore` 排除。账号密码使用服务端 scrypt 哈希保存，会话使用 HttpOnly、SameSite Cookie。登录后文档、课程、对话、批注、笔记、RAG、知识图谱、模型配置和长期记忆都按 `user_id` 隔离；游客不会写入长期学习记忆。

本地加密用于降低配置文件被直接读取的风险，不等同于云端 Secret Manager，也不能替代 Windows Credential Manager。API Key 不应出现在 README、前端代码、提交记录、截图或测试日志中。

## 开发者快速开始

```powershell
npm install
npm start
```

打开 <http://127.0.0.1:4173>。如需开发 Agent Context Inspector：

```powershell
$env:STUDYAGENT_DEV_CONTEXT = '1'
npm start
```

常用验证：

```powershell
npm run check:syntax
npm test
npm run check:pdf
npm run check:http
npm run check:multiformat:http
npm run check:auth
npm run check:learning:closure
npm run verify
```

`npm run verify` 等同于完整回归入口，会覆盖语法、数学 OCR、核心数据层、账号隔离、多格式导入、真实学习闭环、PDF 高代讲义和桌面讲义目录。桌面讲义回归默认扫描 `C:\Users\<当前用户>\Desktop\讲义`，也可以通过 `STUDYAGENT_LECTURE_DIR` 指定其他目录。

## 团队协作建议

1. 从 `main` 创建功能分支；
2. 修改解析器、OCR 或公式显示后运行 `npm run check:pdf`；
3. 修改 API、SQLite、记忆或 RAG 后运行 `npm run check:http` 和对应学习闭环检查；
4. 修改账号或权限后运行 `npm run check:auth`；
5. 提交前运行 `npm run verify`；
6. 使用 Pull Request 合并，并在描述中记录测试命令和已知限制。

推荐提交信息：

```text
feat: add ...
fix: correct ...
docs: update ...
test: cover ...
refactor: improve ...
```
