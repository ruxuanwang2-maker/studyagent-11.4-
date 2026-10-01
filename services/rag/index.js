const crypto = require('crypto');

const DIMENSIONS = 96;
function tokenize(value) { return String(value || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(token => token.length > 1); }
function localEmbedding(value) {
  const vector = Array(DIMENSIONS).fill(0); for (const token of tokenize(value)) { const hash = crypto.createHash('sha256').update(token).digest(); const index = hash.readUInt32LE(0) % DIMENSIONS; vector[index] += (hash[4] % 2 ? 1 : -1) * (1 + hash[5] / 255); }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1; return vector.map(value => Number((value / norm).toFixed(6)));
}
function cosine(a, b) { let dot = 0; let aa = 0; let bb = 0; for (let i = 0; i < Math.max(a.length, b.length); i += 1) { dot += (a[i] || 0) * (b[i] || 0); aa += (a[i] || 0) ** 2; bb += (b[i] || 0) ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }

function createRagService(learningDb) {
  function indexChunks(chunks) { for (const chunk of chunks || []) learningDb.saveEmbedding(chunk.id, localEmbedding(chunk.content), 'local-hash-v1'); return { indexed: (chunks || []).length, model: 'local-hash-v1' }; }
  async function indexChunksWithProvider(chunks, embedder, model) { const source = chunks || []; if (!source.length) return { indexed: 0, model: model || 'remote', dimensions: 0 }; if (typeof embedder !== 'function') throw new Error('A provider embedder is required'); const result = await embedder({ input: source.map(chunk => chunk.content), model }); const vectors = result?.embeddings || []; if (vectors.length !== source.length || !vectors.every(vector => Array.isArray(vector) && vector.length > 0)) throw new Error('Embedding provider returned an invalid vector count or dimension'); for (const [index, chunk] of source.entries()) learningDb.saveEmbedding(chunk.id, vectors[index], result.model || model || 'remote-embedding'); return { indexed: source.length, model: result.model || model || 'remote-embedding', dimensions: vectors[0].length }; }
  function search(query, options = {}) {
    const limit = Math.max(1, Number(options.limit) || 8); const candidateLimit = Math.max(limit * 8, Number(options.candidateLimit) || 50); const lexical = learningDb.searchChunks(query, { ...options, includeZero: true, candidateLimit }); const terms = tokenize(query); const embedding = localEmbedding(query); const stored = learningDb.getEmbeddings(lexical.map(row => row.id)); const vectors = new Map(stored.map(row => [row.chunkId, row.vector]));
    return lexical.map(row => { const lexicalScore = terms.length ? row.score / terms.length : 0; const semanticScore = Math.max(0, cosine(embedding, vectors.get(row.id) || [])); return { ...row, lexicalScore, semanticScore, score: lexicalScore * 0.65 + semanticScore * 0.35 }; }).filter(row => row.lexicalScore > 0 || row.semanticScore >= 0.55).filter(row => row.score >= (Number(options.minScore) || 0.18)).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function context(query, options = {}) { return search(query, options).map((row, index) => { const locator = row.locator || {}; return { rank: index + 1, text: row.content, documentId: row.document_id, documentTitle: row.document_title, section: row.section_title, locator, score: Number(row.score.toFixed(4)), citation: `${row.document_title} · ${locator.slide ? `第 ${locator.slide} 张幻灯片` : locator.sheet ? `Sheet ${locator.sheet}` : locator.page ? `第 ${locator.page} 页` : row.section_title || '正文'}` }; }); }
  return { indexChunks, indexChunksWithProvider, search, context, embed: localEmbedding, model: 'local-hash-v1' };
}

module.exports = { createRagService, localEmbedding };
