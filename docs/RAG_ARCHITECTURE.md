# RAG 当前实现与演进边界

## 当前索引

Document → Sections/Blocks → Chunks。公式和表格优先成为独立块；普通段落按语义边界合并。不能称所有巨型单段落均已合理切分。

SQLite document_chunks 存储 text + document/section/locator；embeddings 每片段一条 vector_json/model。结构化章节由显式标题产生，不把 PDF 每页强行当章节。

## 当前查询

范围过滤 user_id → 可选 course/workspace/document/page/slide/sheet → 词法候选 → 同空间本地哈希向量 → 加权排序 → 阈值 → 上下文与引用。

本地向量 local-hash-v2 是 96 维确定性特征哈希，不是训练出的语言语义模型。中文使用连续双字分词，以便“请解释条件数的作用”匹配“矩阵条件数”。有跨领域同义词局限。

远程 Embedding 索引接口可存向量。启动不覆盖远程向量；同步本地查询不与其做余弦，而从原片段生成 local-hash-v2 并返回 retrievalMode=local-hash-fallback。这是显式降级，不是远程神经语义检索已完成。

向量保存前验证数量、统一维度、有限数值；整批保存以事务完成。不能因为维度相同就推断不同模型是同一向量空间。

## 引用

返回 documentId、chunkId、sectionId、locator、documentTitle、score、citation；页面按 documentId + page/slide/sheet 回到原文。主模型回答只应使用实际提供的来源；返回候选来源不等同于验证每条答案都受支持。

## 性能与 Phase 4 目标

1. 给 Embedding 新增 namespace：Provider + endpoint fingerprint + model + dimensions + text hash。
2. 索引和查询明确选择同一 embedding adapter；远程失败保留关键词结果并显示降级，不污染索引。
3. SQLite FTS/BM25 与向量融合；对片段候选分页/索引，避免将整库同步扫描。
4. 章节/知识点 Metadata Filter 与中文查询改写；训练式 reranker 作为可选接口。
5. Source text range、可观测分数、预算控制、真实 Provider 集成测试。

这些目标尚未实现；不借 BM25/reranking 的名称描述当前简单加权排序。

## Prompt 计划检索联动

已加入：原问题与选中片段形成确定性 retrieval_query；远程优化若返回有效计划，可追加受限检索词，在原 user/course/document/page 范围重新检索，再构建回答证据。Prompt 计划不能扩大租户或课程范围。Remote Embedding query、BM25 与训练式重排器仍未接通。
