# CourseMind AI / StudyAgent 开发交接

> 更新于 2026-10-31。供新的 Codex 聊天和接手队友使用。作品对外名称为 **CourseMind AI**；当前代码仓库、npm 包、界面和大量文档仍使用开发名 **StudyAgent**。不要仅因命名不同重新创建项目。

2026-11-04 发布补充：用户指定将当前完整代码上传至 <https://github.com/ruxuanwang2-maker/studyagent-11.4->。该仓库在发布检查时为公开仓库。下文的 Git 状态与“未推送”表述是 2026-10-31 的交接快照，接手时必须重新检查实际状态；原仓库 `origin` 不因此次额外发布自动改址。

## 1. 新聊天先读这里

项目根目录：`C:\Users\王汝轩\Documents\Codex\2026-09-29\files-pasted-by-the-user-ai`

GitHub：<https://github.com/ruxuanwang2-maker/studyagent>

本地分支：`main`；远程名：`origin`；截至本交接的本地 HEAD：`00b2986`（2026-10-07）。
用户提供的云端体验地址：<http://47.103.63.67:4173/>。这是公开 **HTTP** 地址，不是 HTTPS；本次交接没有重新核验其可用性、部署版本或安全配置。不要把云端实例当成本地测试数据库，也不要直接对云端运行破坏性回归。

第一轮请按顺序执行：

1. 在上述目录查看 `git status --short`、`git log -1` 和本文件，保留已有未提交改动。
2. 读 `README.md`、`docs/USER_GUIDE.md`、`docs/ARCHITECTURE.md`、`docs/AI_PIPELINE.md`、`docs/RAG_ARCHITECTURE.md`、`docs/DATABASE_SCHEMA.md`、`docs/SECURITY_REVIEW.md`、`docs/TEST_PLAN.md`。
3. 先复现用户当前提出的问题，再做最小范围修改；不要按历史长需求一次性重构或补一批占位功能。
4. 每次修改后跑对应专项测试；完成一个模块后再跑全量回归。测试数据使用临时账号/副本，不覆盖用户资料。

## 2. 当前代码与运行方式

| 部分 | 现状 |
| --- | --- |
| 前端 | `public/` 中的原生 HTML、CSS、JavaScript；PDF.js 本地资源；无前端构建步骤 |
| 服务端 | Node.js 22.5+、原生 HTTP，入口 `server.js`；无 Express/ORM |
| 数据库 | 默认 Node 内置 SQLite，`data/studyagent.sqlite`；可选 MySQL 适配器在 `services/db/` |
| 原文件 | `uploads/`；临时任务在 `tmp/`；这些目录及 `data/` 均被 Git 忽略 |
| 文档处理 | `services/documents/`：多格式解析、OCR、导入工作线程和任务队列 |
| 检索/Agent | `services/rag/`、`services/agents/`、`services/memory/`、`prompts/` |
| 模型 | `services/llm/` 与 `config/modelProviders.js`；密钥应只在服务端保存 |
| 账号 | `services/auth/`；本地用户名、密码哈希、持久会话与按用户隔离 |

本地首次安装：`npm install`。启动：`npm start`，浏览器访问 <http://127.0.0.1:4173/>，健康检查为 `/api/health`。Windows 也有 `启动 StudyAgent.cmd`。默认 SQLite 无需 `.env`；团队 MySQL 需参考 `.env.example` 自行配置，**不得提交真实 `.env`**。本地 SQLite 与云端 MySQL 不自动同步；云端部署细节、SSH/运维权限和部署流水线不在仓库中，不能推断为已经具备。

## 3. 已有真实功能及调用链

- 课程、资料库及 PDF、DOCX/DOC、PPTX/PPT、MD、TXT、XLSX/XLS、CSV 和常见图片导入。新 Office 格式走结构化解析；旧二进制 Office 依赖本机转换工具。非 PDF 不保证 WPS 原版分页。
- PDF 原版连续阅读、解析视图、页码/续读、选择文本或公式、局部框选提问；扫描页可用本地 OCR，专用数学 OCR 需单独配置。任何识别结果仍需与原页核对。
- 高亮、批注、笔记、知识卡片、学习会话、学习经历、复习队列和来源跳转均有持久化链路。复习自测以证据与自评为主，**没有可靠的独立自动判题**，不应展示无依据的掌握百分比。
- 问答范围可选当前页、当前文件、课程、指定文件或工作区。服务端按账号和范围检索；结构化 Prompt 计划保留原问题；已配置模型经 Provider 适配器调用，返回引用。未配置远程模型时明确为本地证据模式；远程模型失败不得静默伪装成本地模型回答。
- 长期记忆与聊天记录分开；学习事件区分原始证据和推断。知识图谱及概念提取仍偏轻量、领域规则化，不能描述为通用自主多 Agent 或完整知识图谱系统。

核心链路：

```text
资料上传 → 原文件保存 → 文档解析/OCR → 结构化章节与内容块 → 分块与索引
阅读位置/选段/公式/批注 → /api/chat 或 /api/chat/stream
→ 用户与资料范围校验 → RAG/笔记/近期消息/允许使用的记忆
→ Prompt 计划 → 所选 Provider 或明确标注的本地证据模式
→ 回答与来源引用 → 对话/问题/学习事件持久化
→ 学习会话结束 → 笔记/经历/知识卡片/复习入口
```

检索目前是关键词与 96 维本地特征哈希向量的加权排序，不是已训练的语义向量、BM25、ANN 或神经重排。外部 Embedding 可建索引，但查询仍存在明确的本地回退路径；详见 `docs/RAG_ARCHITECTURE.md`。

## 4. 本次交接时的工作区状态

2026-10-31 检查到：`README.md` 已修改；`docs/USER_GUIDE.md` 与 `docs/contest/` 未跟踪。参赛材料的三份 DOCX 及其旧版备份位于 `docs/contest/`；桌面另有“云端修订版”。这些内容不是本次交接生成的，**不要重置、清理或擅自提交**。开始工作先重查状态，因为用户/其他聊天可能已经改动。

本次仅新建本交接文件并计划在 README 中加入入口；未修改服务端、前端、数据库，也未推送 GitHub 或部署云端。源码对外作品名 `CourseMind AI` 与内部 `StudyAgent` 尚未统一；若要统一，先列出用户可见文案、持久化键、包名和部署脚本，避免简单全局替换破坏兼容。

## 5. 验证状态与命令

本次（2026-10-31）实际运行：

- `npm run check:syntax`：PASS，34 个第一方 JS 文件。
- `npm test`：PASS，结构化解析、RAG 索引/检索、持久记忆核心检查。
- **未在本次运行** `npm run verify`、真实远程 Provider、云端 E2E 或桌面讲义全量导入。

历史基线见 `docs/TEST_PLAN.md`：2026-10-07 的 20 组全量检查曾通过；按用户要求桌面“讲义”目录中**体积最大的文件默认不参与回归**。历史结果不能代替当前版本重新测试。`npm run verify` 会做真实 HTTP/导入/临时账号回归，耗时可能较长；先确认测试目录和数据库范围。可用 `STUDYAGENT_LECTURE_DIR` 指定测试资料目录；只有明确进行压力测试时才设置 `STUDYAGENT_INCLUDE_LARGEST_LECTURE=1`。

常用专项：`npm run check:auth`、`npm run check:multiformat:http`、`npm run check:pdf`、`npm run check:prompt-plan`、`npm run check:closure`。项目尚无独立 TypeScript 类型检查或完整 lint 流水线，不能将语法检查称作二者通过。真实模型效果需凭真实账号/密钥和外网单独验证；不要把合约夹具当作实网验证。

## 6. 优先风险与安全纪律

1. 云端是公网 HTTP。**在 HTTPS、认证/授权和公开部署安全复核完成前，不要让用户在该地址输入真实 API Key、复用密码或上传敏感资料。**之前聊天中出现过模型密钥，应视为已暴露并在服务商处轮换；不要在交接文档、日志或代码中复写该值。
2. `docs/SECURITY_REVIEW.md` 记录 Office ZIP 展开边界、敏感 Header 脱敏、限流/CSRF/Host 校验、JSON/base64 大文件内存占用等尚待处理。云端可访问不等于通过这些检查。
3. `server.js` 与 `public/app.js` 体积较大，部分前端函数存在覆盖式演进；改动前追踪实际调用链。服务端有全局串行队列和可变账号上下文，不能未经改造就把普通 API 请求直接并发化。
4. 默认本地运行数据 `data/`、`uploads/`、`.env`、模型配置、个人讲义不可提交或随意删除。数据库变更用迁移，不删库重建；测试先用副本。
5. OCR、数学公式、来源引用和 AI 回答均需人工核验。阅读过、问过、做过自评不等于掌握知识。

## 7. 建议下一轮顺序

先确认用户当前要求及是否仅针对本地、云端或文档。若继续开发，建议优先处理公网 HTTPS/会话与密钥安全，再针对实际可复现的阅读、导入、问答问题做局部修复；之后补真实模型与多账号端到端回归。每项采用“复现 → 定位 → 最小修复 → 专项测试 → 回归”的循环。不要把参赛文案、历史需求清单或本文件当作比当前代码更高优先级的事实来源。

## 8. 给新 Codex 聊天的开场指令

> 请在 `C:\Users\王汝轩\Documents\Codex\2026-09-29\files-pasted-by-the-user-ai` 继续维护 CourseMind AI（代码名 StudyAgent）。先阅读 `docs/HANDOFF.md`、README 和相关架构/测试文档，检查当前 Git 未提交改动及实际代码调用链。不要初始化新项目，不要清空本地数据，不要自动推送 GitHub 或部署云端。按我随后提出的具体问题复现、局部修复并做对应回归；清楚区分已实测、历史结果和待验证项目。
