# 数据库 Schema

默认主库为本地 `data/studyagent.sqlite`；设置 `STUDYAGENT_DB=mysql` 后使用 MySQL `studyagent`。MySQL 连接参数通过 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 配置。两个后端由同一数据库接口封装，完整定义以 `services/db/sqlite.js`、`services/db/mysql.js` 与对应 migrations 为准。

| 表组 | 表 | 职责/隔离 |
|---|---|---|
| 账号 | users、user_sessions | scrypt 密码/用户设置/Session；`users.is_guest` 标记隔离的访客账号 |
| 组织 | workspaces、courses | workspace 所属用户；课程通过工作区验归属 |
| 资料 | documents、document_sections、document_chunks、embeddings | 来源文件、块结构、定位、模型向量 |
| 会话 | conversations、messages、prompt_optimization_logs | 最近上下文、原始/优化问题与开发日志 |
| 记忆 | memories、questions、errors | 类型/作用域/重要性、历史问题、错误 |
| 知识 | concepts、concept_relations | KnowledgePoint、掌握分、关系/来源 |
| 复习 | learning_progress、quiz_attempts、review_schedule | 次数、自评、间隔复习 |
| 学习对象 | annotations、notes、knowledge_cards | 批注/普通笔记/front-back 卡 |
| 学习经历 | learning_sessions、learning_notes、learning_experiences | raw evidence 与 interpretation 独立 JSON |
| 本轮追加 | schema_migrations、chapters、learning_events | 版本、显式标题章节、可追溯行为 |

## v1 新字段与约束

chapters：id PK、user_id、course_id、document_id FK cascade、section_id FK cascade、title、level、position、locator_json、created_at；unique(document_id,section_id)。

learning_events：id PK、user/course/document/concept/session、event_type CHECK、source_id、evidence_json、interpretation_json、created_at；unique(user_id,event_type,source_id,coalesce(concept_id,''))。

schema_migrations：version PK、name、applied_at（DATETIME）。

## v2 阅读、导入与结构化优化

- reading_positions：联合主键 user_id/document_id；current_page 记录最后停留位置，pages_viewed_json 记录跨 Session 的去重页集合；updated_at。用户/文档删除级联清理。进度为访问页数/总页数，不代表理解或掌握。历史 Session 只能回填访问集合及近似位置，不具备精确停留时间证据。
- document_import_jobs：id、user_id FK cascade、filename、status、progress_json、document_id、error_json、created_at、updated_at。重启后未完成任务明确标失败，不能伪装已入库；用户需重新上传。历史任务不是上传文件的持久备份。
- prompt_optimization_logs.optimization_json：追加 plan 与 validation，不删除或替换 original_prompt/optimized_prompt。
- 文档更新改用 ON CONFLICT UPDATE 而非 REPLACE，避免重解析级联删除阅读位置。
- GET/PATCH /api/documents/:id/reading-position；GET /api/imports/:id、GET /api/imports；上传/重解析请求 async=true 返回 202 job IDs。原同步上传、批量统计和重解析响应保持兼容。

## 新 API

- GET /api/learning/chapters?documentId=&courseId=
- GET /api/learning/events?courseId=&documentId=&conceptId=&limit=
- GET /api/learning/mastery?courseId=

所有结果按当前用户过滤。sourceId 用于定位业务对象，不代表可任意访问其他用户记录。

## 写入与删除

SQLite 使用本地事务，MySQL 使用异步连接池与事务；需要原子性的文档修改和向量写入均通过适配器事务执行。MySQL DDL 会隐式提交，版本迁移不能依赖事务回滚；部署前应使用 MySQL 备份工具备份数据库。章节随对应文档/Section 删除。删除批注/普通笔记同步清理源事件；账号删除/课程记忆清空/文档删除覆盖新增事件。导出包含事件和章节。

大部分历史表仍无数据库 FK，某些旧清理流程还不是事务；应用层授权不能替代完整约束测试。数据库文件包含隐私，不可提交 GitHub。
