# 增量迁移设计

## 已执行的机制

先建立历史兼容 Schema/补列，再运行 append-only migrations。schema_migrations 记录已完成版本；每个待迁移版本 BEGIN IMMEDIATE → SQL → 写版本 → COMMIT，错误 ROLLBACK。

已有 documents 时先 VACUUM INTO：`data/studyagent.sqlite.before-v1-<timestamp>.bak`。备份失败会阻止版本迁移，不继续无保护改库。首次空库无需备份。迁移前旧兼容补列仍是历史逻辑，不宣称已全部迁入新 runner。

v1 新建 chapters/learning_events，并从明确 heading 结构回填章节。历史事件不会凭空回填成“用户学习过”；旧概念/笔记/问答保留。

重启不会重复执行版本迁移；不能通过删库获得测试通过。回滚需先停止已确认的 StudyAgent，再备份当前库，人工恢复迁移前副本；不要在程序运行中复制覆盖 WAL 数据库。

## 后续迁移（设计，不是已创建）

v2 已实施：reading_positions、document_import_jobs、prompt_optimization_logs.optimization_json；复用原资料/账号/会话表。已发行的 v1 SQL 不修改。迁移前仍采用 SQLite VACUUM INTO 备份；已有库不重建。历史 visited pages 可回填，但旧 Session 排序页集合不能推断精确的最后停留页，精确续读从新版本记录开始。

| 阶段 | 迁移目标 | 向后兼容方式 |
|---|---|---|
| 2 后续 | Prompt token/latency/usage 指标 | 结构化 JSON 已加入；仍保留原始/优化字符串字段 |
| 3 | cards structured_json、concept/chapter/source、关联 | front/back 仍支持旧复习；不可丢弃原卡 |
| 4 | embedding namespace/dim/text hash、多空间索引 | 旧无 namespace 远程向量不当作可比较空间 |
| 5 | exercises、exercise_attempts、mistakes | 区分历史自评与新判题；source 必填 |
| 6 | mastery evidence basis/衰减/复习任务 | 已有 score 标为 legacy，保留原始次数 |
| 7 | model_preferences、comparison_runs | 用户/任务类型隔离；不存明文密钥 |
| 8 | sidebar_preferences | 账号设置增量合并；可恢复默认 |
| 9 | card/exercise/material 图节点、全文索引 | 复用 concept IDs；新边携带来源 |

## 迁移验收

旧资料、批注、笔记/卡片数量和 ID 保留；重启幂等；失败回滚；A/B 用户隔离；跨课程来源拒绝；删除/导出覆盖新表；备份存在且能独立打开。单元测试使用独立临时库，不能以真实用户库做破坏测试。
