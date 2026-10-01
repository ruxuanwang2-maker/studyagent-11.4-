const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, course_id TEXT,
  title TEXT NOT NULL, file_type TEXT NOT NULL, source_path TEXT, created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', legacy_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS document_sections (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, title TEXT DEFAULT '', content TEXT NOT NULL,
  locator_json TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'paragraph'
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, section_id TEXT, content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT PRIMARY KEY, vector_json TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, course_id TEXT, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'user', user_id TEXT NOT NULL,
  workspace_id TEXT, course_id TEXT, document_id TEXT, concept_id TEXT, content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', importance REAL NOT NULL DEFAULT 0.5, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, name TEXT NOT NULL,
  mastery_score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unseen',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS concepts_user_course_name ON concepts(user_id, course_id, name);
CREATE TABLE IF NOT EXISTS concept_relations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5, source TEXT NOT NULL DEFAULT 'memory', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS concept_relation_unique ON concept_relations(source_id, target_id, type);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, question TEXT NOT NULL, timestamp TEXT NOT NULL,
  course_id TEXT, source_document_id TEXT, concepts_json TEXT NOT NULL DEFAULT '[]', answer_summary TEXT DEFAULT '',
  difficulty TEXT DEFAULT 'unknown', resolved INTEGER NOT NULL DEFAULT 0, conversation_id TEXT
);
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, concept_id TEXT, question_id TEXT, description TEXT NOT NULL,
  correction TEXT DEFAULT '', severity REAL NOT NULL DEFAULT 0.5, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_progress (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, concept_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0, question_count INTEGER NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
  last_event TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, concept TEXT NOT NULL,
  score INTEGER NOT NULL, total INTEGER NOT NULL, answers_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_schedule (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, concept_id TEXT NOT NULL, next_review_at TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, repetitions INTEGER NOT NULL DEFAULT 0,
  last_result INTEGER, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_schedule_user_concept ON review_schedule(user_id, concept_id);
CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page INTEGER, type TEXT NOT NULL, color TEXT, text TEXT, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, document_id TEXT, title TEXT, content TEXT NOT NULL, locator_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, document_id TEXT, front TEXT NOT NULL, back TEXT NOT NULL, source_label TEXT DEFAULT '', locator_json TEXT NOT NULL DEFAULT '{}', due_at TEXT, mastery_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(user_id, course_id, type, active);
CREATE INDEX IF NOT EXISTS questions_course ON questions(user_id, course_id, timestamp);
`;

function now() { return new Date().toISOString(); }
function json(value, fallback = {}) { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } }
function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function id(prefix) { return `${prefix}-${Math.random().toString(16).slice(2, 10)}`; }

function createLearningDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(schema);
  const stmt = sql => database.prepare(sql);

  function ensureBootstrap(legacy) {
    const userId = 'user-local';
    const workspaceId = 'workspace-personal';
    const courseNames = new Map();
    stmt('INSERT OR IGNORE INTO users(id,name,created_at) VALUES(?,?,?)').run(userId, 'Local learner', now());
    stmt('INSERT OR IGNORE INTO workspaces(id,user_id,name,description,created_at) VALUES(?,?,?,?,?)').run(workspaceId, userId, 'Personal Learning Workspace', '本地优先的个人学习工作区', now());
    for (const legacyDoc of legacy?.documents || []) {
      const courseId = `course-${String(legacyDoc.course || '未分类').replace(/[^\w\u4e00-\u9fff]+/g, '-').slice(0, 40) || 'uncategorized'}`;
      if (!courseNames.has(courseId)) {
        stmt('INSERT OR IGNORE INTO courses(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)').run(courseId, workspaceId, legacyDoc.course || '未分类', '', now());
        courseNames.set(courseId, true);
      }
      stmt('INSERT OR IGNORE INTO documents(id,user_id,workspace_id,course_id,title,file_type,source_path,created_at,metadata_json,legacy_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        legacyDoc.id, userId, workspaceId, courseId, legacyDoc.title || legacyDoc.id, legacyDoc.type || 'TXT', legacyDoc.sourceFile || '', legacyDoc.uploadedAt || now(), json({ pages: legacyDoc.pages, extraction: legacyDoc.extraction, tags: legacyDoc.tags }), json(legacyDoc)
      );
      for (const [index, page] of (legacyDoc.content || []).entries()) {
        const sectionId = `${legacyDoc.id}-section-${page.page || index + 1}`;
        stmt('INSERT OR IGNORE INTO document_sections(id,document_id,title,content,locator_json,position,kind) VALUES(?,?,?,?,?,?,?)').run(sectionId, legacyDoc.id, page.heading || `Page ${page.page || index + 1}`, page.text || '', json({ page: page.page || index + 1, source: page.source || 'legacy' }), index, page.type === 'formula' ? 'formula' : 'page');
        const chunkId = `${sectionId}-chunk-1`;
        stmt('INSERT OR IGNORE INTO document_chunks(id,document_id,section_id,content,chunk_index,metadata_json) VALUES(?,?,?,?,?,?)').run(chunkId, legacyDoc.id, sectionId, page.text || '', 0, json({ page: page.page || index + 1, heading: page.heading || '' }));
      }
    }
    for (const legacyMemory of legacy?.knowledge || []) {
      const conceptId = `concept-${legacyMemory.id || id('legacy')}`;
      const metadata = { description: legacyMemory.description || '', source: legacyMemory.source || '', difficulty: legacyMemory.difficulty || '', importance: legacyMemory.importance || '', color: legacyMemory.color || '', migrated: true };
      stmt('INSERT OR IGNORE INTO concepts(id,user_id,course_id,name,mastery_score,status,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').run(conceptId, userId, null, legacyMemory.name, Number(legacyMemory.mastery || 0), Number(legacyMemory.mastery || 0) >= 0.8 ? 'mastered' : 'learning', now(), now(), json(metadata));
      const existing = stmt('SELECT metadata_json FROM concepts WHERE id=?').get(conceptId);
      if (existing) stmt('UPDATE concepts SET metadata_json=? WHERE id=?').run(json({ ...parse(existing.metadata_json, {}), ...metadata }), conceptId);
    }
    for (const legacyAnnotation of legacy?.annotations || []) {
      if (!legacyAnnotation.documentId) continue;
      stmt('INSERT OR IGNORE INTO annotations(id,document_id,page,type,color,text,note,created_at) VALUES(?,?,?,?,?,?,?,?)').run(legacyAnnotation.id || id('annotation'), legacyAnnotation.documentId, Number(legacyAnnotation.page || 0) || null, legacyAnnotation.type || 'highlight', legacyAnnotation.color || '', legacyAnnotation.text || '', legacyAnnotation.note || '', legacyAnnotation.createdAt || now());
    }
    for (const legacyCard of legacy?.cards || []) {
      stmt('INSERT OR IGNORE INTO knowledge_cards(id,user_id,course_id,document_id,front,back,source_label,locator_json,due_at,mastery_score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(legacyCard.id || id('card'), userId, null, legacyCard.documentId || null, legacyCard.front || '', legacyCard.back || '', legacyCard.source || '', json({ page: legacyCard.page || null }), legacyCard.due || null, Number(legacyCard.mastery || 0), now(), now());
    }
    for (const legacyTask of legacy?.reviewTasks || []) {
      const conceptId = legacyTask.knowledgeId ? `concept-${legacyTask.knowledgeId}` : null;
      const concept = conceptId ? stmt('SELECT id FROM concepts WHERE id=? AND user_id=?').get(conceptId, userId) : stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, legacyTask.title || '');
      if (!concept) continue;
      const scheduled = stmt('SELECT id FROM review_schedule WHERE user_id=? AND concept_id=?').get(userId, concept.id);
      if (!scheduled) {
        const nextReview = /today|今天/i.test(String(legacyTask.due || '')) ? now() : new Date(Date.now() + 86400000).toISOString();
        stmt('INSERT INTO review_schedule(id,user_id,concept_id,next_review_at,interval_days,ease,repetitions,last_result,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`review-${legacyTask.id || concept.id}`, userId, concept.id, nextReview, 0, 2.5, 0, null, now());
      }
    }
    const relationSeeds = [['Forward Error', 'Backward Error', 'contrasts_with'], ['Forward Error', 'Condition Number', 'related'], ['Backward Error', 'Condition Number', 'related']];
    for (const [sourceName, targetName, type] of relationSeeds) { const source = stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, sourceName); const target = stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, targetName); if (source && target) stmt('INSERT INTO concept_relations(id,source_id,target_id,type,weight,source,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,target_id,type) DO NOTHING').run(id('relation'), source.id, target.id, type, 0.75, 'bootstrap', '{}', now()); }
  }

  function upsertDocument({ document, sections = [], chunks = [], userId = 'user-local', workspaceId = 'workspace-personal', courseId = null }) {
    const tx = database.prepare('INSERT OR REPLACE INTO documents(id,user_id,workspace_id,course_id,title,file_type,source_path,created_at,metadata_json,legacy_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
    tx.run(document.id, userId, workspaceId, courseId, document.title, document.fileType || document.type || 'TXT', document.sourcePath || document.sourceFile || '', document.createdAt || now(), json(document.metadata || {}), json(document.legacy || {}));
    stmt('DELETE FROM document_sections WHERE document_id=?').run(document.id);
    stmt('DELETE FROM document_chunks WHERE document_id=?').run(document.id);
    const sectionInsert = stmt('INSERT INTO document_sections(id,document_id,title,content,locator_json,position,kind) VALUES(?,?,?,?,?,?,?)');
    const chunkInsert = stmt('INSERT INTO document_chunks(id,document_id,section_id,content,chunk_index,metadata_json) VALUES(?,?,?,?,?,?)');
    for (const [index, section] of sections.entries()) { const locator = { ...(section.locator || {}) }; if (Array.isArray(section.blocks) && section.blocks.length) locator.blocks = section.blocks; sectionInsert.run(section.id || `${document.id}-section-${index + 1}`, document.id, section.title || '', section.content || '', json(locator), Number(section.position ?? index), section.kind || 'paragraph'); }
    for (const [index, chunk] of chunks.entries()) chunkInsert.run(chunk.id || `${document.id}-chunk-${index + 1}`, document.id, chunk.sectionId || null, chunk.content || '', Number(chunk.chunkIndex ?? index), json(chunk.metadata || {}));
    return document.id;
  }

  function listDocuments({ courseId, workspaceId } = {}) {
    const clauses = []; const values = [];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (workspaceId) { clauses.push('workspace_id=?'); values.push(workspaceId); }
    const rows = stmt(`SELECT * FROM documents ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...values);
    return rows.map(row => ({ ...row, fileType: row.file_type, metadata: parse(row.metadata_json, {}), legacy: parse(row.legacy_json, {}) }));
  }
  function getDocument(idValue) { const row = stmt('SELECT * FROM documents WHERE id=?').get(idValue); return row ? { ...row, fileType: row.file_type, metadata: parse(row.metadata_json, {}), legacy: parse(row.legacy_json, {}) } : null; }
  function deleteDocument(idValue) { const related = stmt('SELECT id FROM document_chunks WHERE document_id=?').all(idValue).map(row => row.id); if (related.length) stmt(`DELETE FROM embeddings WHERE chunk_id IN (${related.map(() => '?').join(',')})`).run(...related); const questionIds = stmt('SELECT id FROM questions WHERE source_document_id=?').all(idValue).map(row => row.id); if (questionIds.length) { const conceptRows = stmt(`SELECT id FROM concepts WHERE ${questionIds.map(() => 'metadata_json LIKE ?').join(' OR ')}`).all(...questionIds.map(questionId => `%${questionId}%`)); const conceptIds = conceptRows.map(row => row.id); if (conceptIds.length) stmt(`DELETE FROM concept_relations WHERE source_id IN (${conceptIds.map(() => '?').join(',')}) OR target_id IN (${conceptIds.map(() => '?').join(',')})`).run(...conceptIds, ...conceptIds); if (conceptIds.length) stmt(`DELETE FROM concepts WHERE id IN (${conceptIds.map(() => '?').join(',')})`).run(...conceptIds); } stmt('DELETE FROM annotations WHERE document_id=?').run(idValue); stmt('DELETE FROM notes WHERE document_id=?').run(idValue); stmt('DELETE FROM knowledge_cards WHERE document_id=?').run(idValue); stmt('DELETE FROM document_chunks WHERE document_id=?').run(idValue); stmt('DELETE FROM document_sections WHERE document_id=?').run(idValue); stmt('DELETE FROM memories WHERE document_id=?').run(idValue); stmt('DELETE FROM questions WHERE source_document_id=?').run(idValue); return stmt('DELETE FROM documents WHERE id=?').run(idValue).changes > 0; }
  function getDocumentContext(idValue) { return stmt('SELECT c.*, s.title section_title, s.locator_json FROM document_chunks c LEFT JOIN document_sections s ON s.id=c.section_id WHERE c.document_id=? ORDER BY c.chunk_index').all(idValue).map(row => ({ ...row, metadata: parse(row.metadata_json, {}), locator: parse(row.locator_json, {}) })); }
  function searchChunks(query, { documentIds = [], courseId, workspaceId, page, slide, sheet, limit = 8, candidateLimit = limit, includeZero = false } = {}) {
    const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1);
    const clauses = []; const values = [];
    if (courseId) { clauses.push('d.course_id=?'); values.push(courseId); }
    if (workspaceId) { clauses.push('d.workspace_id=?'); values.push(workspaceId); }
    if (documentIds.length) { clauses.push(`d.id IN (${documentIds.map(() => '?').join(',')})`); values.push(...documentIds); }
    const rows = stmt(`SELECT c.*,d.title document_title,d.course_id,s.title section_title,s.locator_json FROM document_chunks c JOIN documents d ON d.id=c.document_id LEFT JOIN document_sections s ON s.id=c.section_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`).all(...values);
    return rows.map(row => { const locator = parse(row.locator_json, {}); const haystack = `${row.content} ${row.section_title || ''}`.toLowerCase(); const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0); return { ...row, score, locator, metadata: parse(row.metadata_json, {}) }; }).filter(row => (page == null || Number(row.locator.page) === Number(page)) && (slide == null || Number(row.locator.slide) === Number(slide)) && (sheet == null || Number(row.locator.sheet) === Number(sheet))).filter(row => includeZero || row.score > 0 || !terms.length).sort((a, b) => b.score - a.score).slice(0, includeZero ? Math.max(Number(candidateLimit) || 0, Number(limit) || 1) : limit);
  }
  function listCourses(workspaceId = 'workspace-personal') { return stmt('SELECT * FROM courses WHERE workspace_id=? ORDER BY name').all(workspaceId); }
  function listWorkspaces(userId = 'user-local') { return stmt('SELECT * FROM workspaces WHERE user_id=? ORDER BY name').all(userId); }
  function createWorkspace(name, description = '') { const workspaceId = id('workspace'); stmt('INSERT INTO workspaces(id,user_id,name,description,created_at) VALUES(?,?,?,?,?)').run(workspaceId, 'user-local', name, description, now()); return stmt('SELECT * FROM workspaces WHERE id=?').get(workspaceId); }
  function createCourse(name, workspaceId = 'workspace-personal', description = '') { const courseId = id('course'); stmt('INSERT INTO courses(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)').run(courseId, workspaceId, name, description, now()); return stmt('SELECT * FROM courses WHERE id=?').get(courseId); }
  function upsertConversation({ id: conversationId, title = '学习对话', workspaceId = 'workspace-personal', courseId = null } = {}) { const conversationKey = conversationId || id('conversation'); const timestamp = now(); stmt('INSERT INTO conversations(id,user_id,workspace_id,course_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,workspace_id=excluded.workspace_id,course_id=excluded.course_id,updated_at=excluded.updated_at').run(conversationKey, 'user-local', workspaceId, courseId, String(title || '学习对话').slice(0, 200), timestamp, timestamp); return stmt('SELECT * FROM conversations WHERE id=?').get(conversationKey); }
  function saveConversationMessage({ id: messageId, conversationId = null, role, content, metadata = {} } = {}) { const messageKey = messageId || id('message'); const timestamp = now(); stmt('INSERT INTO messages(id,conversation_id,role,content,metadata_json,created_at) VALUES(?,?,?,?,?,?)').run(messageKey, conversationId, String(role || 'assistant'), String(content || ''), json(metadata), timestamp); if (conversationId) stmt('UPDATE conversations SET updated_at=? WHERE id=?').run(timestamp, conversationId); return messageKey; }
  function listConversations({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT * FROM conversations WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows; }
  function listConversationMessages(conversationId, limit = 200) { return stmt('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT ?').all(conversationId, Math.max(1, Number(limit) || 200)).map(row => ({ ...row, metadata: parse(row.metadata_json, {}) })); }
  function saveMemory(memory) { const timestamp = now(); const memoryId = memory.id || id('memory'); stmt('INSERT OR REPLACE INTO memories(id,type,scope,user_id,workspace_id,course_id,document_id,concept_id,content,metadata_json,importance,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(memoryId, memory.type || 'conversation', memory.scope || 'user', memory.userId || 'user-local', memory.workspaceId || null, memory.courseId || null, memory.documentId || null, memory.conceptId || null, memory.content, json(memory.metadata || {}), Number(memory.importance ?? 0.5), memory.active === false ? 0 : 1, memory.createdAt || timestamp, timestamp); return memoryId; }
  function listMemories({ type, courseId, limit = 50, active = true } = {}) { const clauses = ['user_id=?']; const values = ['user-local']; if (type) { clauses.push('type=?'); values.push(type); } if (courseId) { clauses.push('course_id=?'); values.push(courseId); } if (active) clauses.push('active=1'); const rows = stmt(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...values); return rows.map(row => ({ ...row, metadata: parse(row.metadata_json, {}) })); }
  function upsertConcept({ name, courseId = null, scoreDelta = 0, status, metadata = {} }) { const existing = stmt('SELECT * FROM concepts WHERE user_id=? AND course_id IS ? AND name=?').get('user-local', courseId, name); const timestamp = now(); if (!existing) { const conceptId = id('concept'); const score = Math.max(0, Math.min(1, scoreDelta)); stmt('INSERT INTO concepts(id,user_id,course_id,name,mastery_score,status,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').run(conceptId, 'user-local', courseId, name, score, status || (score > 0.8 ? 'mastered' : score > 0 ? 'learning' : 'unseen'), timestamp, timestamp, json(metadata)); return { id: conceptId, name, courseId, masteryScore: score }; } const score = Math.max(0, Math.min(1, Number(existing.mastery_score) + scoreDelta)); const nextStatus = status || (score >= 0.8 ? 'mastered' : score >= 0.45 ? 'familiar' : score > 0 ? 'learning' : 'unseen'); stmt('UPDATE concepts SET mastery_score=?,status=?,last_seen=?,metadata_json=? WHERE id=?').run(score, nextStatus, timestamp, json({ ...parse(existing.metadata_json, {}), ...metadata }), existing.id); return { id: existing.id, name, courseId, masteryScore: score }; }
  function listConcepts(courseId) { const rows = stmt(`SELECT * FROM concepts WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY mastery_score ASC, name`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows.map(row => ({ ...row, masteryScore: row.mastery_score, metadata: parse(row.metadata_json, {}) })); }
  function listKnowledgePoints(courseId) { return listConcepts(courseId).map(item => ({ ...item, mastery: item.masteryScore, description: item.metadata?.description || `${item.status || 'learning'} · SQLite learning concept`, difficulty: item.metadata?.difficulty || '', importance: item.metadata?.importance || '', source: item.metadata?.source || 'SQLite learning memory', color: item.metadata?.color || '#635bff' })); }
  function saveQuestion(question) { const questionId = question.id || id('question'); stmt('INSERT OR REPLACE INTO questions(id,user_id,question,timestamp,course_id,source_document_id,concepts_json,answer_summary,difficulty,resolved,conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(questionId, 'user-local', question.question, question.timestamp || now(), question.courseId || null, question.sourceDocumentId || null, json(question.concepts || []), question.answerSummary || '', question.difficulty || 'unknown', question.resolved ? 1 : 0, question.conversationId || null); return questionId; }
  function listQuestions({ courseId, limit = 20 } = {}) { const rows = stmt(`SELECT * FROM questions WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY timestamp DESC LIMIT ${Math.max(1, Number(limit) || 20)}`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows.map(row => ({ ...row, concepts: parse(row.concepts_json, []) })); }
  function listErrors({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT e.*,c.name concept_name,q.question FROM errors e LEFT JOIN concepts c ON c.id=e.concept_id LEFT JOIN questions q ON q.id=e.question_id WHERE e.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ORDER BY e.created_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows; }
  function recordProgress({ conceptId, event = 'question', correct = false }) { if (!conceptId) return null; const timestamp = now(); const existing = stmt('SELECT * FROM learning_progress WHERE user_id=? AND concept_id=?').get('user-local', conceptId); const isQuestion = event === 'question' || event === 'error'; const isReview = event === 'review'; if (!existing) { const progressId = id('progress'); stmt('INSERT INTO learning_progress(id,user_id,concept_id,attempts,correct_count,question_count,review_count,last_event,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(progressId, 'user-local', conceptId, isQuestion ? 1 : 0, correct ? 1 : 0, isQuestion ? 1 : 0, isReview ? 1 : 0, event, timestamp); return progressId; } stmt('UPDATE learning_progress SET attempts=attempts+?,correct_count=correct_count+?,question_count=question_count+?,review_count=review_count+?,last_event=?,updated_at=? WHERE user_id=? AND concept_id=?').run(isQuestion ? 1 : 0, correct ? 1 : 0, isQuestion ? 1 : 0, isReview ? 1 : 0, event, timestamp, 'user-local', conceptId); return existing.id; }
  function listProgress({ courseId, limit = 100 } = {}) { const rows = stmt(`SELECT lp.*,c.name concept_name,c.course_id FROM learning_progress lp JOIN concepts c ON c.id=lp.concept_id WHERE lp.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ORDER BY lp.updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows; }
  function saveQuizAttempt({ courseId = null, concept, score = 0, total = 0, answers = [] }) { const attemptId = id('quiz-attempt'); stmt('INSERT INTO quiz_attempts(id,user_id,course_id,concept,score,total,answers_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(attemptId, 'user-local', courseId, String(concept || '当前资料'), Number(score) || 0, Number(total) || 0, json(answers, []), now()); return attemptId; }
  function listQuizAttempts({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT * FROM quiz_attempts WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? ['user-local', courseId] : ['user-local'])); return rows.map(row => ({ ...row, answers: parse(row.answers_json, []) })); }
  function updateReviewSchedule({ conceptId, correct = true }) { if (!conceptId) return null; const timestamp = now(); const existing = stmt('SELECT * FROM review_schedule WHERE user_id=? AND concept_id=?').get('user-local', conceptId); const wasCorrect = Boolean(correct); const repetitions = wasCorrect ? (existing?.repetitions || 0) + 1 : 0; const ease = Math.max(1.3, Number(existing?.ease || 2.5) + (wasCorrect ? 0.05 : -0.2)); const previousInterval = Number(existing?.interval_days || 0); const intervalDays = wasCorrect ? (repetitions <= 1 ? 1 : repetitions === 2 ? 3 : Math.min(60, Math.max(1, Math.round(previousInterval * ease)))) : 0.25; const nextReview = new Date(Date.now() + intervalDays * 86400000).toISOString(); if (!existing) { const scheduleId = id('review'); stmt('INSERT INTO review_schedule(id,user_id,concept_id,next_review_at,interval_days,ease,repetitions,last_result,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(scheduleId, 'user-local', conceptId, nextReview, intervalDays, ease, repetitions, wasCorrect ? 1 : 0, timestamp); return scheduleId; } stmt('UPDATE review_schedule SET next_review_at=?,interval_days=?,ease=?,repetitions=?,last_result=?,updated_at=? WHERE user_id=? AND concept_id=?').run(nextReview, intervalDays, ease, repetitions, wasCorrect ? 1 : 0, timestamp, 'user-local', conceptId); return existing.id; }
  function listReviewSchedule({ courseId, dueOnly = false, limit = 100 } = {}) { const rows = stmt(`SELECT rs.*,c.name concept_name,c.course_id,c.mastery_score,c.status FROM review_schedule rs JOIN concepts c ON c.id=rs.concept_id WHERE rs.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ${dueOnly ? 'AND rs.next_review_at<=?' : ''} ORDER BY rs.next_review_at ASC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? (dueOnly ? ['user-local', courseId, now()] : ['user-local', courseId]) : (dueOnly ? ['user-local', now()] : ['user-local']))); return rows; }
  function clearCourseMemory(courseId) { if (!courseId) return { ok: false, removed: 0 }; const conceptRows = stmt('SELECT id FROM concepts WHERE user_id=? AND course_id=?').all('user-local', courseId); const conceptIds = conceptRows.map(row => row.id); let removed = 0; const run = (sql, values) => { const result = stmt(sql).run(...values); removed += Number(result.changes || 0); }; run('DELETE FROM memories WHERE user_id=? AND course_id=?', ['user-local', courseId]); run('DELETE FROM questions WHERE user_id=? AND course_id=?', ['user-local', courseId]); run('DELETE FROM quiz_attempts WHERE user_id=? AND course_id=?', ['user-local', courseId]); if (conceptIds.length) { const placeholders = conceptIds.map(() => '?').join(','); run(`DELETE FROM concept_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`, [...conceptIds, ...conceptIds]); run(`DELETE FROM errors WHERE user_id=? AND concept_id IN (${placeholders})`, ['user-local', ...conceptIds]); run(`DELETE FROM learning_progress WHERE user_id=? AND concept_id IN (${placeholders})`, ['user-local', ...conceptIds]); run(`DELETE FROM review_schedule WHERE user_id=? AND concept_id IN (${placeholders})`, ['user-local', ...conceptIds]); run(`DELETE FROM concepts WHERE user_id=? AND id IN (${placeholders})`, ['user-local', ...conceptIds]); } return { ok: true, courseId, removed, concepts: conceptIds.length }; }
  function saveRelation({ sourceId, targetId, type, weight = 0.5, source = 'memory' }) { const relationId = id('relation'); stmt('INSERT INTO concept_relations(id,source_id,target_id,type,weight,source,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,target_id,type) DO UPDATE SET weight=excluded.weight,source=excluded.source').run(relationId, sourceId, targetId, type, weight, source, '{}', now()); return relationId; }
  function getConceptDetails(conceptId) { const conceptRow = stmt('SELECT * FROM concepts WHERE id=? AND user_id=?').get(conceptId, 'user-local'); if (!conceptRow) return null; const concept = { ...conceptRow, masteryScore: conceptRow.mastery_score, metadata: parse(conceptRow.metadata_json, {}) }; const relations = stmt('SELECT * FROM concept_relations WHERE source_id=? OR target_id=?').all(conceptId, conceptId); const questions = listQuestions({ courseId: conceptRow.course_id || undefined, limit: 200 }).filter(item => item.concepts.includes(conceptRow.name)).slice(0, 20); const documents = questions.map(item => item.source_document_id ? getDocument(item.source_document_id) : null).filter(Boolean).map(item => ({ id: item.id, title: item.title, fileType: item.fileType })); const memories = listMemories({ courseId: conceptRow.course_id || undefined, limit: 200 }).filter(item => item.concept_id === conceptId || item.content.toLowerCase().includes(String(conceptRow.name).toLowerCase())).slice(0, 20); return { concept, relations, questions, documents, memories }; }
  function listGraph(courseId) { const concepts = listConcepts(courseId); const ids = new Set(concepts.map(c => c.id)); const relations = stmt('SELECT * FROM concept_relations').all().filter(row => ids.has(row.source_id) && ids.has(row.target_id)); return { nodes: concepts.map(c => ({ id: c.id, label: c.name, type: 'concept', mastery: c.masteryScore, status: c.status })), edges: relations.map(r => ({ source: r.source_id, target: r.target_id, type: r.type, weight: r.weight })) }; }
  function listCards({ courseId, documentId, limit = 200 } = {}) {
    const clauses = ['user_id=?']; const values = ['user-local'];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (documentId) { clauses.push('document_id=?'); values.push(documentId); }
    const rows = stmt(`SELECT * FROM knowledge_cards WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 200)}`).all(...values);
    return rows.map(row => ({ ...row, source: row.source_label, due: row.due_at, mastery: row.mastery_score, locator: parse(row.locator_json, {}) }));
  }
  function saveCard({ cardId, front, back, courseId = null, documentId = null, source = '', due = 'Tomorrow', mastery = 0.2, locator = {} } = {}) {
    if (!String(front || '').trim() || !String(back || '').trim()) throw new Error('知识卡正面和背面不能为空');
    const cardKey = cardId || id('card'); const timestamp = now();
    stmt(`INSERT INTO knowledge_cards(id,user_id,course_id,document_id,front,back,source_label,locator_json,due_at,mastery_score,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,document_id=excluded.document_id,front=excluded.front,back=excluded.back,source_label=excluded.source_label,locator_json=excluded.locator_json,due_at=excluded.due_at,mastery_score=excluded.mastery_score,updated_at=excluded.updated_at`)
      .run(cardKey, 'user-local', courseId, documentId, String(front).trim().slice(0, 2000), String(back).trim().slice(0, 20000), String(source || '').slice(0, 500), json(locator), String(due || 'Tomorrow').slice(0, 80), Math.max(0, Math.min(1, Number(mastery) || 0)), timestamp, timestamp);
    return listCards({ documentId }).find(card => card.id === cardKey) || null;
  }
  function deleteCard(cardId) { return stmt('DELETE FROM knowledge_cards WHERE id=? AND user_id=?').run(cardId, 'user-local').changes > 0; }
  function listAnnotations({ documentId, limit = 500 } = {}) {
    const rows = documentId
      ? stmt('SELECT * FROM annotations WHERE document_id=? ORDER BY created_at DESC LIMIT ?').all(documentId, Math.max(1, Number(limit) || 500))
      : stmt('SELECT * FROM annotations ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Number(limit) || 500));
    return rows.map(row => ({ ...row, documentId: row.document_id, createdAt: row.created_at }));
  }
  function saveAnnotation({ id: annotationId, documentId, page, type = 'highlight', color = '', text = '', note = '' } = {}) {
    if (!documentId) throw new Error('批注必须关联文档');
    const annotationKey = annotationId || id('annotation'); const createdAt = now();
    stmt(`INSERT INTO annotations(id,document_id,page,type,color,text,note,created_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET page=excluded.page,type=excluded.type,color=excluded.color,text=excluded.text,note=excluded.note`).run(annotationKey, documentId, Number(page || 0) || null, String(type).slice(0, 40), String(color).slice(0, 40), String(text).slice(0, 20000), String(note).slice(0, 20000), createdAt);
    return listAnnotations({ documentId }).find(item => item.id === annotationKey) || null;
  }
  function deleteAnnotation(annotationId) { return stmt('DELETE FROM annotations WHERE id=?').run(annotationId).changes > 0; }
  function listNotes({ courseId, documentId, limit = 100 } = {}) {
    const clauses = ['user_id=?']; const values = ['user-local'];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (documentId) { clauses.push('document_id=?'); values.push(documentId); }
    const rows = stmt(`SELECT * FROM notes WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...values);
    return rows.map(row => ({ ...row, locator: parse(row.locator_json, {}) }));
  }
  function saveNote({ noteId, title = '', content, courseId = null, documentId = null, locator = {} } = {}) {
    const noteKey = noteId || id('note'); const timestamp = now();
    if (!String(content || '').trim()) throw new Error('笔记内容不能为空');
    stmt(`INSERT INTO notes(id,user_id,course_id,document_id,title,content,locator_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,document_id=excluded.document_id,title=excluded.title,content=excluded.content,locator_json=excluded.locator_json,updated_at=excluded.updated_at`)
      .run(noteKey, 'user-local', courseId, documentId, String(title || '').trim().slice(0, 200), String(content).trim().slice(0, 20000), json(locator), timestamp, timestamp);
    return listNotes({ documentId }).find(note => note.id === noteKey) || null;
  }
  function deleteNote(noteId) { return stmt('DELETE FROM notes WHERE id=? AND user_id=?').run(noteId, 'user-local').changes > 0; }
  function saveEmbedding(chunkId, vector, model = 'local-hash-v1') { stmt('INSERT OR REPLACE INTO embeddings(chunk_id,vector_json,model,created_at) VALUES(?,?,?,?)').run(chunkId, json(vector, []), model, now()); }
  function getEmbeddings(chunkIds = []) { if (!chunkIds.length) return []; return stmt(`SELECT * FROM embeddings WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`).all(...chunkIds).map(row => ({ chunkId: row.chunk_id, vector: parse(row.vector_json, []), model: row.model })); }
  function deleteMemory(memoryId) { return stmt('UPDATE memories SET active=0,updated_at=? WHERE id=?').run(now(), memoryId).changes > 0; }
  function updateMemory(memoryId, content, importance) { const result = stmt('UPDATE memories SET content=?,importance=?,updated_at=? WHERE id=? AND active=1').run(String(content || ''), Number(importance ?? 0.5), now(), memoryId); return result.changes > 0; }
  function getUserProfile() { const memory = listMemories({ type: 'user-profile', limit: 1 })[0]; if (!memory) return null; const profile = parse(memory.content, memory.metadata?.profile || {}); return { ...profile, memoryId: memory.id, updatedAt: memory.updated_at || memory.updatedAt }; }
  function saveUserProfile(profile = {}) { const normalized = { answerStyle: profile.answerStyle === 'concise' ? 'concise' : 'detailed', formulaStyle: profile.formulaStyle === 'plain' ? 'plain' : 'latex', learningGoals: String(profile.learningGoals || '').trim().slice(0, 2000), programmingLanguage: String(profile.programmingLanguage || '').trim().slice(0, 120), preferredLanguage: profile.preferredLanguage === 'en' ? 'en' : 'zh' }; const memoryId = 'memory-profile-user-local'; saveMemory({ id: memoryId, type: 'user-profile', scope: 'user', content: JSON.stringify(normalized), importance: 1, metadata: { profile: normalized } }); return getUserProfile(); }
  function deleteUserProfile() { const profile = getUserProfile(); return profile ? deleteMemory(profile.memoryId) : false; }
  function exportMemory() { return { profile: getUserProfile(), memories: listMemories({ active: false, limit: 10000 }), concepts: listConcepts(), questions: listQuestions({ limit: 10000 }), errors: listErrors({ limit: 10000 }) }; }

  return { database, ensureBootstrap, upsertDocument, listDocuments, getDocument, deleteDocument, getDocumentContext, searchChunks, listCourses, listWorkspaces, createWorkspace, createCourse, upsertConversation, saveConversationMessage, listConversations, listConversationMessages, saveMemory, listMemories, updateMemory, getUserProfile, saveUserProfile, deleteUserProfile, upsertConcept, listConcepts, listKnowledgePoints, saveQuestion, listQuestions, listErrors, recordProgress, listProgress, saveQuizAttempt, listQuizAttempts, updateReviewSchedule, listReviewSchedule, clearCourseMemory, saveRelation, getConceptDetails, listGraph, listCards, saveCard, deleteCard, listAnnotations, saveAnnotation, deleteAnnotation, listNotes, saveNote, deleteNote, saveEmbedding, getEmbeddings, deleteMemory, exportMemory, close: () => database.close() };
}

module.exports = { createLearningDb };
