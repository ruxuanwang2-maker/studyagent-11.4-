const crypto = require('crypto');
const { tokenize } = require('./tokenize');

const DIMENSIONS = 96;
const LOCAL_MODEL = 'local-hash-v2';
function localEmbedding(value) {
  const vector = Array(DIMENSIONS).fill(0); for (const token of tokenize(value)) { const hash = crypto.createHash('sha256').update(token).digest(); const index = hash.readUInt32LE(0) % DIMENSIONS; vector[index] += (hash[4] % 2 ? 1 : -1) * (1 + hash[5] / 255); }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1; return vector.map(value => Number((value / norm).toFixed(6)));
}
function cosine(a, b) { if (a.length !== b.length) return 0; let dot = 0; let aa = 0; let bb = 0; for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }

function createRagService(learningDb) {
  async function indexChunks(chunks, prepared = {}) {
    const source = chunks || [];
    const vectors = prepared.vectors;
    if (vectors && (prepared.model !== LOCAL_MODEL || vectors.length !== source.length || !vectors.every(vector => Array.isArray(vector) && vector.length === DIMENSIONS && vector.every(value => typeof value === 'number' && Number.isFinite(value))))) throw new Error('Prepared local embeddings have an invalid model, count or dimension');
    const stored = new Map((await learningDb.getEmbeddings(source.map(chunk => chunk.id))).map(row => [row.chunkId, row]));
    let indexed = 0;
    await learningDb.database.transaction(async () => {
      for (const [index, chunk] of source.entries()) {
        const previous = stored.get(chunk.id);
        // Never replace externally generated embeddings merely because the app starts.
        if (previous && !previous.model.startsWith('local-hash-')) continue;
        if (previous?.model === LOCAL_MODEL && previous.vector.length === DIMENSIONS) continue;
        await learningDb.saveEmbedding(chunk.id, vectors ? vectors[index] : localEmbedding(chunk.content), LOCAL_MODEL); indexed++;
      }
    });
    return { indexed, preserved: source.length - indexed, model: LOCAL_MODEL };
  }
  async function indexChunksWithProvider(chunks, embedder, model) {
    const source = chunks || [];
    if (!source.length) return { indexed: 0, model: model || 'remote', dimensions: 0 };
    if (typeof embedder !== 'function') throw new Error('A provider embedder is required');
    const result = await embedder({ input: source.map(chunk => chunk.content), model });
    const vectors = result?.embeddings || []; const dimensions = vectors[0]?.length;
    if (vectors.length !== source.length || !dimensions || !vectors.every(vector => Array.isArray(vector) && vector.length === dimensions && vector.every(value => typeof value === 'number' && Number.isFinite(value)))) throw new Error('Embedding provider returned an invalid vector count or dimension');
    await learningDb.database.transaction(async () => {
      for (const [index, chunk] of source.entries()) await learningDb.saveEmbedding(chunk.id, vectors[index], result.model || model || 'remote-embedding');
    });
    return { indexed: source.length, model: result.model || model || 'remote-embedding', dimensions };
  }
  async function search(query, options = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 8))); const candidateLimit = Math.max(limit * 8, Number(options.candidateLimit) || 50); const lexical = await learningDb.searchChunks(query, { ...options, includeZero: true, candidateLimit }); const terms = tokenize(query); const embedding = localEmbedding(query); const stored = await learningDb.getEmbeddings(lexical.map(row => row.id)); const vectors = new Map(stored.map(row => [row.chunkId, row]));
    return lexical.map(row => {
      const previous = vectors.get(row.id);
      const compatible = previous?.model === LOCAL_MODEL && previous.vector.length === DIMENSIONS && previous.vector.every(Number.isFinite);
      // Synchronous retrieval is explicitly local; use a same-space local fallback,
      // not a numerically plausible cosine between unrelated embedding models.
      const vector = compatible ? previous.vector : localEmbedding(row.content);
      const lexicalScore = terms.length ? row.score / terms.length : 0;
      const semanticScore = Math.max(0, cosine(embedding, vector));
      return { ...row, lexicalScore, semanticScore, retrievalMode: compatible ? 'local-hash' : 'local-hash-fallback', embeddingModel: LOCAL_MODEL, score: lexicalScore * 0.65 + semanticScore * 0.35 };
    }).filter(row => row.lexicalScore > 0 || row.semanticScore >= 0.55).filter(row => row.score >= (Number(options.minScore) || 0.18)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async function context(query, options = {}) { return (await search(query, options)).map((row, index) => { const locator = row.locator || {}; return { rank: index + 1, chunkId: row.id, sectionId: row.section_id, text: row.content, documentId: row.document_id, documentTitle: row.document_title, courseId: row.course_id, workspaceId: row.workspace_id, section: row.section_title, locator, retrievalMode: row.retrievalMode, embeddingModel: row.embeddingModel, score: Number(row.score.toFixed(4)), citation: `${row.document_title} · ${locator.slide ? `第 ${locator.slide} 张幻灯片` : locator.sheet ? `Sheet ${locator.sheet}` : locator.page ? `第 ${locator.page} 页` : row.section_title || '正文'}` }; }); }
  return { indexChunks, indexChunksWithProvider, search, context, embed: localEmbedding, model: LOCAL_MODEL };
}

module.exports = { createRagService, localEmbedding, LOCAL_MODEL, DIMENSIONS };
