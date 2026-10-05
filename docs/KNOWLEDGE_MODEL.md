# 统一学习模型

## 当前实体映射

User → Workspace → Course → Document → Chapter（显式标题）/Section/Chunk → Concept（现有知识点） → Annotation/Question/Note → LearningEvent → Session/Experience → Memory/Graph/Review。

Concept 继续复用 concepts；没有另建相同含义的 knowledge_points。固定领域别名由 services/memory 管理；通用语义规范化待实现。

## LearningEvent

字段：id、user_id、course_id、document_id、concept_id、session_id、event_type、source_id、evidence_json、interpretation_json、created_at。

来源可以是：页阅读、批注、笔记、提问、复习、自测、错误或结束学习。源 ID 与概念共同决定幂等键；同 Session 同页不会重复计数，多概念问题可以有多个 concept 关联，前端按源问题去重展示。

`course_id` 从实际文档/概念推导，不接受外部用户的课程。原始学习事件反映当时课程；资料后来调课不重写原始历史。Annotation/Note 事件的 evidence 更新为该源最新状态，不新增假的学习次数。

## Chapter

chapter 与 document_sections 的明确标题一一关联；保留标题级别、position、locator。没有标题证据时不凭空创建章节。Markdown headingLevel 与 Word Heading 样式可以作为级别证据；PDF 复杂标题识别待加强。

## Mastery

本产品当前不展示掌握百分比或掌握进度条，也不使用自评次数生成“熟悉/精通”等能力结论。已有旧掌握分不删除，内部兼容估计 `(correct + 1) / (reviews + 2)` 及 confidence 只保留兼容字段，不作为页面或 Tutor 的掌握断言。

展示 `learningStatus`：`unassessed` 尚未评估、`self_reported` 已有自评记录、`needs_attention` 有待关注记录。后一状态仅表示存在未解决错误或最近明确自评答错/未记住，不表示测得了能力薄弱；无自测不等于薄弱。

逐概念、当前用户及课程核对 questions 原文与 question 事件并按源 ID 去重。自评复习/自测仅接受 `selfReported=true` 且 `correct` 为布尔值的逐条事件，分别显示次数/题数与答对或记住 X/Y；不将缺失答案判为错误。错误记录不计入提问次数。缺少逐条来源的历史复习汇总单独展示 `unverifiedLegacyReviewCount`，不参与判断。

知识点、图谱节点/详情、学习分析和学习记录使用相同 `learningEvidence`；详情包含最多 20 条近期事件、历史提问与原资料导航。兼容 `label` 仅返回 Low Evidence/Developing/Weak，不再从自评推出 Familiar。未来独立判题也必须区分某次练习表现与跨题型、跨时间的掌握评估，不能把正确率直接重命名为掌握度。

## 知识卡与习题尚待扩展

现有 knowledge_cards front/back 将追加 structured_json 与 concept/chapter/source 关联，保留旧复习功能。Exercise、Attempt、Mistake 未来独立建表，引用已验证来源；不要把 errors 记忆当作完整错题库。

## 事实和推断

- Fact：读过页、保存批注、问题原文、自评结果。
- Interpretation：可能困惑、需要复习、模型解释。
- Mastery：基于证据的保守指标，不是心理状态真值。

图谱关系记录 sourceOrigin；固定 ontology 候选关系不等于用户掌握相关节点。

## 阅读进度与掌握度

reading_positions.current_page 是最后阅读位置；pages_viewed_json 是实际打开过的页面集合，去重后计算访问进度。跳到最后一页不等于读完整份资料；访问进度 100% 也不等于掌握度 100%。阅读位置跨 Session 保存，阅读事件仍绑定具体 LearningSession，并可进入学习经历。
