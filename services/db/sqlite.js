const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { tokenize } = require('../rag/tokenize');
const { applyMigrations } = require('./migrations.sqlite');

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, password_hash TEXT, avatar_url TEXT, settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id, expires_at);
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
CREATE TABLE IF NOT EXISTS prompt_optimization_logs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT, course_id TEXT, document_id TEXT,
  original_prompt TEXT NOT NULL, optimized_prompt TEXT NOT NULL, query_type TEXT NOT NULL,
  optimization_level TEXT NOT NULL, mode TEXT NOT NULL, memory_ids_json TEXT NOT NULL DEFAULT '[]',
  document_ids_json TEXT NOT NULL DEFAULT '[]', knowledge_connections_json TEXT NOT NULL DEFAULT '[]',
  config_id TEXT, optimizer_config_id TEXT, created_at TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT, course_id TEXT, document_id TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, pages_viewed_json TEXT NOT NULL DEFAULT '[]', concepts_viewed_json TEXT NOT NULL DEFAULT '[]',
  annotations_created INTEGER NOT NULL DEFAULT 0, questions_asked INTEGER NOT NULL DEFAULT 0,
  generated_summary TEXT NOT NULL DEFAULT '', raw_evidence_json TEXT NOT NULL DEFAULT '{}', interpretation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_notes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, document_id TEXT, session_id TEXT,
  title TEXT NOT NULL DEFAULT '', concepts_json TEXT NOT NULL DEFAULT '[]', highlights_json TEXT NOT NULL DEFAULT '[]', annotations_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]', explanations_json TEXT NOT NULL DEFAULT '[]', difficult_points_json TEXT NOT NULL DEFAULT '[]',
  important_points_json TEXT NOT NULL DEFAULT '[]', misconceptions_json TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
  raw_evidence_json TEXT NOT NULL DEFAULT '{}', interpretation_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_experiences (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, document_id TEXT, session_id TEXT, experience_date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', concepts_json TEXT NOT NULL DEFAULT '[]', focus_json TEXT NOT NULL DEFAULT '[]',
  questions_count INTEGER NOT NULL DEFAULT 0, difficult_points_json TEXT NOT NULL DEFAULT '[]', mastery_changes_json TEXT NOT NULL DEFAULT '[]',
  related_concepts_json TEXT NOT NULL DEFAULT '[]', raw_evidence_json TEXT NOT NULL DEFAULT '{}', interpretation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT, document_id TEXT, front TEXT NOT NULL, back TEXT NOT NULL, source_label TEXT DEFAULT '', locator_json TEXT NOT NULL DEFAULT '{}', due_at TEXT, mastery_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(user_id, course_id, type, active);
CREATE INDEX IF NOT EXISTS questions_course ON questions(user_id, course_id, timestamp);
CREATE INDEX IF NOT EXISTS learning_sessions_user ON learning_sessions(user_id, course_id, started_at);
CREATE INDEX IF NOT EXISTS learning_notes_user ON learning_notes(user_id, course_id, updated_at);
CREATE INDEX IF NOT EXISTS learning_experiences_user ON learning_experiences(user_id, course_id, experience_date);
`;

function now() { return new Date().toISOString(); }
function json(value, fallback = {}) { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } }
function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function id(prefix) { return `${prefix}-${Math.random().toString(16).slice(2, 10)}`; }

function createLearningDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.execute = async (sql, values = []) => {
    const statement = database.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) return [statement.all(...values), []];
    const result = statement.run(...values);
    return [{ affectedRows: Number(result.changes || 0), insertId: Number(result.lastInsertRowid || 0) }, []];
  };
  database.query = database.execute;
  let transactionDepth = 0;
  database.transaction = async callback => {
    if (transactionDepth) return callback();
    database.exec('BEGIN IMMEDIATE');
    transactionDepth += 1;
    try {
      const result = await callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally { transactionDepth -= 1; }
  };
  let migrationResult;
  try {
  database.exec(schema);
  const userColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map(row => row.name));
  for (const [name, definition] of [['email', 'TEXT'], ['login_name', 'TEXT'], ['password_hash', 'TEXT'], ['avatar_url', 'TEXT'], ['settings_json', "TEXT NOT NULL DEFAULT '{}'"], ['updated_at', "TEXT NOT NULL DEFAULT ''"]]) if (!userColumns.has(name)) database.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL AND email <> ''");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_login_name_unique ON users(lower(login_name)) WHERE login_name IS NOT NULL AND login_name <> ''");
  const annotationColumns = new Set(database.prepare('PRAGMA table_info(annotations)').all().map(row => row.name));
  for (const [name, definition] of [['user_id', 'TEXT'], ['course_id', 'TEXT'], ['updated_at', "TEXT NOT NULL DEFAULT ''"]]) if (!annotationColumns.has(name)) database.exec(`ALTER TABLE annotations ADD COLUMN ${name} ${definition}`);
  database.exec("UPDATE annotations SET user_id=(SELECT user_id FROM documents WHERE documents.id=annotations.document_id) WHERE user_id IS NULL OR user_id=''");
  database.exec("UPDATE annotations SET course_id=(SELECT course_id FROM documents WHERE documents.id=annotations.document_id) WHERE course_id IS NULL");
  database.exec("UPDATE annotations SET updated_at=created_at WHERE updated_at='' OR updated_at IS NULL");
  migrationResult = applyMigrations(database, file);
  } catch (error) {
    database.close();
    throw error;
  }
  const userContext = new AsyncLocalStorage();
  let fallbackUserId = 'user-local';
  function currentUserId() { return userContext.getStore() || fallbackUserId; }
  function setUserId(userId) { fallbackUserId = String(userId || 'user-local'); return fallbackUserId; }
  function runAsUser(userId, callback) { return userContext.run(String(userId || 'user-local'), callback); }
  function defaultWorkspaceId(userId = currentUserId()) { return userId === 'user-local' ? 'workspace-personal' : `workspace-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
  const stmt = sql => database.prepare(sql);

  function userView(row) { return row ? { id: row.id, email: row.email || '', loginName: row.login_name || '', username: row.name || '', avatarUrl: row.avatar_url || '', createdAt: row.created_at, updatedAt: row.updated_at || row.created_at } : null; }
  function createUserAccount({ id: userId = id('user'), email, loginName, username, passwordHash, avatarUrl = '' } = {}) { const timestamp = now(); const accountId = userId; stmt('INSERT INTO users(id,name,email,login_name,password_hash,avatar_url,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(accountId, String(username || loginName || email || 'Learner').trim().slice(0, 120), email ? String(email).trim().toLowerCase() : null, loginName ? String(loginName).trim().toLowerCase() : null, passwordHash || null, String(avatarUrl || '').trim().slice(0, 1000), '{}', timestamp, timestamp); return userView(stmt('SELECT * FROM users WHERE id=?').get(accountId)); }
  function getUserByEmail(email) { return userView(stmt('SELECT * FROM users WHERE lower(email)=lower(?)').get(String(email || '').trim())); }
  function getUserByLoginName(loginName) { return userView(stmt('SELECT * FROM users WHERE lower(login_name)=lower(?)').get(String(loginName || '').trim())); }
  function getUserById(userId = currentUserId()) { return userView(stmt('SELECT * FROM users WHERE id=?').get(userId)); }
  function getUserAuthByEmail(email) { const row = stmt('SELECT * FROM users WHERE lower(email)=lower(?)').get(String(email || '').trim()); return row ? { ...userView(row), passwordHash: row.password_hash } : null; }
  function getUserAuthByLoginName(loginName) { const row = stmt('SELECT * FROM users WHERE lower(login_name)=lower(?)').get(String(loginName || '').trim()); return row ? { ...userView(row), passwordHash: row.password_hash } : null; }
  function getUserAuthById(userId) { const row = stmt('SELECT * FROM users WHERE id=?').get(userId); return row ? { ...userView(row), passwordHash: row.password_hash } : null; }
  function updateUserAccount(userId, updates = {}) { const existing = stmt('SELECT * FROM users WHERE id=?').get(userId); if (!existing) return null; const nextName = updates.username === undefined ? existing.name : String(updates.username || existing.name).trim().slice(0, 120); const nextEmail = updates.email === undefined ? existing.email : String(updates.email || existing.email).trim().toLowerCase(); const nextAvatar = updates.avatarUrl === undefined ? existing.avatar_url : String(updates.avatarUrl || '').trim().slice(0, 1000); stmt('UPDATE users SET name=?,email=?,avatar_url=?,updated_at=? WHERE id=?').run(nextName, nextEmail, nextAvatar, now(), userId); return userView(stmt('SELECT * FROM users WHERE id=?').get(userId)); }
  function updateUserPassword(userId, passwordHash) { return stmt('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, now(), userId).changes > 0; }
  function getUserSettings(userId = currentUserId()) { const row = stmt('SELECT settings_json FROM users WHERE id=?').get(userId); return row ? parse(row.settings_json, {}) : {}; }
  function saveUserSettings(settings = {}, userId = currentUserId()) { const next = { ...getUserSettings(userId), ...settings }; stmt('UPDATE users SET settings_json=?,updated_at=? WHERE id=?').run(json(next), now(), userId); return next; }
  function ensureUserSpace(userId = currentUserId()) {
    const workspaceId = defaultWorkspaceId(userId);
    stmt('INSERT OR IGNORE INTO workspaces(id,user_id,name,description,created_at) VALUES(?,?,?,?,?)').run(workspaceId, userId, 'Personal Learning Workspace', '本地优先的个人学习工作区', now());
    const courseId = userId === 'user-local' ? 'course-未分类' : `course-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '-')}-uncategorized`;
    stmt('INSERT OR IGNORE INTO courses(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)').run(courseId, workspaceId, '未分类', '', now());
    return { workspaceId, courseId };
  }
  function createSession(userId, ttlMs = 30 * 86400000) { const sessionId = crypto.randomBytes(32).toString('base64url'); const timestamp = now(); const expires = new Date(Date.now() + ttlMs).toISOString(); stmt('INSERT INTO user_sessions(id,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?)').run(sessionId, userId, expires, timestamp, timestamp); return { id: sessionId, userId, expiresAt: expires }; }
  function getSession(sessionId) { if (!sessionId) return null; const row = stmt('SELECT s.*,u.name,u.email,u.login_name,u.avatar_url,u.created_at user_created_at,u.updated_at user_updated_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?').get(sessionId, now()); if (!row) return null; stmt('UPDATE user_sessions SET last_seen_at=? WHERE id=?').run(now(), sessionId); return { id: row.id, userId: row.user_id, expiresAt: row.expires_at, user: { id: row.user_id, email: row.email || '', loginName: row.login_name || '', username: row.name || '', avatarUrl: row.avatar_url || '', createdAt: row.user_created_at, updatedAt: row.user_updated_at || row.user_created_at } }; }
  function deleteSession(sessionId) { return stmt('DELETE FROM user_sessions WHERE id=?').run(sessionId).changes > 0; }
  function deleteUserAccount(userId) {
    const documentIds = stmt('SELECT id FROM documents WHERE user_id=?').all(userId).map(row => row.id);
    const conceptIds = stmt('SELECT id FROM concepts WHERE user_id=?').all(userId).map(row => row.id);
    const workspaceIds = stmt('SELECT id FROM workspaces WHERE user_id=?').all(userId).map(row => row.id);
    const conversationIds = stmt('SELECT id FROM conversations WHERE user_id=?').all(userId).map(row => row.id);
    const sessionResult = stmt('DELETE FROM user_sessions WHERE user_id=?').run(userId).changes;
    for (const documentId of documentIds) {
      const chunkIds = stmt('SELECT id FROM document_chunks WHERE document_id=?').all(documentId).map(row => row.id);
      if (chunkIds.length) stmt(`DELETE FROM embeddings WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`).run(...chunkIds);
      stmt('DELETE FROM document_sections WHERE document_id=?').run(documentId);
      stmt('DELETE FROM document_chunks WHERE document_id=?').run(documentId);
      stmt('DELETE FROM annotations WHERE document_id=?').run(documentId);
    }
    if (conceptIds.length) {
      const placeholders = conceptIds.map(() => '?').join(',');
      stmt(`DELETE FROM concept_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...conceptIds, ...conceptIds);
    }
    if (conversationIds.length) stmt(`DELETE FROM messages WHERE conversation_id IN (${conversationIds.map(() => '?').join(',')})`).run(...conversationIds);
    for (const table of ['learning_events', 'chapters', 'memories', 'questions', 'errors', 'learning_progress', 'quiz_attempts', 'review_schedule', 'prompt_optimization_logs', 'notes', 'learning_sessions', 'learning_notes', 'learning_experiences', 'knowledge_cards', 'conversations']) stmt(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    if (documentIds.length) stmt(`DELETE FROM documents WHERE id IN (${documentIds.map(() => '?').join(',')})`).run(...documentIds);
    if (conceptIds.length) stmt(`DELETE FROM concepts WHERE id IN (${conceptIds.map(() => '?').join(',')})`).run(...conceptIds);
    if (workspaceIds.length) {
      const placeholders = workspaceIds.map(() => '?').join(',');
      stmt(`DELETE FROM courses WHERE workspace_id IN (${placeholders})`).run(...workspaceIds);
      stmt(`DELETE FROM workspaces WHERE id IN (${placeholders}) AND user_id=?`).run(...workspaceIds, userId);
    }
    const result = stmt('DELETE FROM users WHERE id=?').run(userId).changes;
    return { ok: result > 0, sessions: sessionResult, documents: documentIds.length, concepts: conceptIds.length, workspaces: workspaceIds.length, conversations: conversationIds.length };
  }

  function ensureBootstrap(legacy, targetUserId = 'user-local') {
    const userId = targetUserId;
    const seedPrefix = userId === 'user-local' ? '' : `${userId}-`;
    const workspaceId = defaultWorkspaceId(userId);
    const courseNames = new Map();
    stmt('INSERT OR IGNORE INTO users(id,name,created_at) VALUES(?,?,?)').run(userId, 'Local learner', now());
    stmt('INSERT OR IGNORE INTO workspaces(id,user_id,name,description,created_at) VALUES(?,?,?,?,?)').run(workspaceId, userId, 'Personal Learning Workspace', '本地优先的个人学习工作区', now());
    for (const legacyDoc of legacy?.documents || []) {
      const documentId = `${seedPrefix}${legacyDoc.id}`;
      const courseId = `${seedPrefix}course-${String(legacyDoc.course || '未分类').replace(/[^\w\u4e00-\u9fff]+/g, '-').slice(0, 40) || 'uncategorized'}`;
      if (!courseNames.has(courseId)) {
        stmt('INSERT OR IGNORE INTO courses(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)').run(courseId, workspaceId, legacyDoc.course || '未分类', '', now());
        courseNames.set(courseId, true);
      }
      stmt('INSERT OR IGNORE INTO documents(id,user_id,workspace_id,course_id,title,file_type,source_path,created_at,metadata_json,legacy_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        documentId, userId, workspaceId, courseId, legacyDoc.title || legacyDoc.id, legacyDoc.type || 'TXT', legacyDoc.sourceFile || '', legacyDoc.uploadedAt || now(), json({ pages: legacyDoc.pages, extraction: legacyDoc.extraction, tags: legacyDoc.tags }), json(legacyDoc)
      );
      for (const [index, page] of (legacyDoc.content || []).entries()) {
        const sectionId = `${documentId}-section-${page.page || index + 1}`;
        stmt('INSERT OR IGNORE INTO document_sections(id,document_id,title,content,locator_json,position,kind) VALUES(?,?,?,?,?,?,?)').run(sectionId, documentId, page.heading || `Page ${page.page || index + 1}`, page.text || '', json({ page: page.page || index + 1, source: page.source || 'legacy' }), index, page.type === 'formula' ? 'formula' : 'page');
        const chunkId = `${sectionId}-chunk-1`;
        stmt('INSERT OR IGNORE INTO document_chunks(id,document_id,section_id,content,chunk_index,metadata_json) VALUES(?,?,?,?,?,?)').run(chunkId, documentId, sectionId, page.text || '', 0, json({ page: page.page || index + 1, heading: page.heading || '' }));
      }
    }
    for (const legacyMemory of legacy?.knowledge || []) {
      const conceptId = `${seedPrefix}concept-${legacyMemory.id || id('legacy')}`;
      const metadata = { description: legacyMemory.description || '', source: legacyMemory.source || '', difficulty: legacyMemory.difficulty || '', importance: legacyMemory.importance || '', color: legacyMemory.color || '', migrated: true };
      stmt('INSERT OR IGNORE INTO concepts(id,user_id,course_id,name,mastery_score,status,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').run(conceptId, userId, null, legacyMemory.name, Number(legacyMemory.mastery || 0), Number(legacyMemory.mastery || 0) >= 0.8 ? 'mastered' : 'learning', now(), now(), json(metadata));
      const existing = stmt('SELECT metadata_json FROM concepts WHERE id=?').get(conceptId);
      if (existing) stmt('UPDATE concepts SET metadata_json=? WHERE id=?').run(json({ ...parse(existing.metadata_json, {}), ...metadata }), conceptId);
    }
    for (const legacyAnnotation of legacy?.annotations || []) {
      if (!legacyAnnotation.documentId) continue;
      stmt('INSERT OR IGNORE INTO annotations(id,document_id,page,type,color,text,note,created_at) VALUES(?,?,?,?,?,?,?,?)').run(`${seedPrefix}${legacyAnnotation.id || id('annotation')}`, `${seedPrefix}${legacyAnnotation.documentId}`, Number(legacyAnnotation.page || 0) || null, legacyAnnotation.type || 'highlight', legacyAnnotation.color || '', legacyAnnotation.text || '', legacyAnnotation.note || '', legacyAnnotation.createdAt || now());
    }
    for (const legacyCard of legacy?.cards || []) {
      stmt('INSERT OR IGNORE INTO knowledge_cards(id,user_id,course_id,document_id,front,back,source_label,locator_json,due_at,mastery_score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`${seedPrefix}${legacyCard.id || id('card')}`, userId, null, legacyCard.documentId ? `${seedPrefix}${legacyCard.documentId}` : null, legacyCard.front || '', legacyCard.back || '', legacyCard.source || '', json({ page: legacyCard.page || null }), legacyCard.due || null, Number(legacyCard.mastery || 0), now(), now());
    }
    for (const legacyTask of legacy?.reviewTasks || []) {
      const conceptId = legacyTask.knowledgeId ? `${seedPrefix}concept-${legacyTask.knowledgeId}` : null;
      const concept = conceptId ? stmt('SELECT id FROM concepts WHERE id=? AND user_id=?').get(conceptId, userId) : stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, legacyTask.title || '');
      if (!concept) continue;
      const scheduled = stmt('SELECT id FROM review_schedule WHERE user_id=? AND concept_id=?').get(userId, concept.id);
      if (!scheduled) {
        const nextReview = /today|今天/i.test(String(legacyTask.due || '')) ? now() : new Date(Date.now() + 86400000).toISOString();
        stmt('INSERT INTO review_schedule(id,user_id,concept_id,next_review_at,interval_days,ease,repetitions,last_result,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`${seedPrefix}review-${legacyTask.id || concept.id}`, userId, concept.id, nextReview, 0, 2.5, 0, null, now());
      }
    }
    const relationSeeds = [['Forward Error', 'Backward Error', 'contrasts_with'], ['Forward Error', 'Condition Number', 'related'], ['Backward Error', 'Condition Number', 'related']];
    for (const [sourceName, targetName, type] of relationSeeds) { const source = stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, sourceName); const target = stmt('SELECT id FROM concepts WHERE user_id=? AND name=?').get(userId, targetName); if (source && target) stmt('INSERT INTO concept_relations(id,source_id,target_id,type,weight,source,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,target_id,type) DO NOTHING').run(id('relation'), source.id, target.id, type, 0.75, 'bootstrap', '{}', now()); }
  }

  function upsertDocument({ document, sections = [], chunks = [], userId = currentUserId(), workspaceId = defaultWorkspaceId(userId), courseId = null }) {
    const existingOwner = stmt('SELECT user_id FROM documents WHERE id=?').get(document.id);
    if (existingOwner && existingOwner.user_id !== userId) throw new Error('资料不属于当前用户');
    database.exec('SAVEPOINT document_upsert');
    try {
    const tx = database.prepare('INSERT INTO documents(id,user_id,workspace_id,course_id,title,file_type,source_path,created_at,metadata_json,legacy_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,course_id=excluded.course_id,title=excluded.title,file_type=excluded.file_type,source_path=excluded.source_path,metadata_json=excluded.metadata_json,legacy_json=excluded.legacy_json');
    tx.run(document.id, userId, workspaceId, courseId, document.title, document.fileType || document.type || 'TXT', document.sourcePath || document.sourceFile || '', document.createdAt || now(), json(document.metadata || {}), json(document.legacy || {}));
    const previousChunkIds = stmt('SELECT id FROM document_chunks WHERE document_id=?').all(document.id).map(row => row.id);
    if (previousChunkIds.length) stmt(`DELETE FROM embeddings WHERE chunk_id IN (${previousChunkIds.map(() => '?').join(',')})`).run(...previousChunkIds);
    stmt('DELETE FROM document_sections WHERE document_id=?').run(document.id);
    stmt('DELETE FROM document_chunks WHERE document_id=?').run(document.id);
    const sectionInsert = stmt('INSERT INTO document_sections(id,document_id,title,content,locator_json,position,kind) VALUES(?,?,?,?,?,?,?)');
    const chunkInsert = stmt('INSERT INTO document_chunks(id,document_id,section_id,content,chunk_index,metadata_json) VALUES(?,?,?,?,?,?)');
    for (const [index, section] of sections.entries()) { const locator = { ...(section.locator || {}) }; if (Array.isArray(section.blocks) && section.blocks.length) locator.blocks = section.blocks; sectionInsert.run(section.id || `${document.id}-section-${index + 1}`, document.id, section.title || '', section.content || '', json(locator), Number(section.position ?? index), section.kind || 'paragraph'); }
    for (const [index, chunk] of chunks.entries()) chunkInsert.run(chunk.id || `${document.id}-chunk-${index + 1}`, document.id, chunk.sectionId || null, chunk.content || '', Number(chunk.chunkIndex ?? index), json(chunk.metadata || {}));
    for (const [index, section] of sections.entries()) {
      if (section.kind !== 'heading') continue;
      const sectionId = section.id || `${document.id}-section-${index + 1}`;
      const level = Number(section.locator?.headingLevel || String(section.locator?.style || '').match(/heading\s*(\d)/i)?.[1] || 1);
      stmt('INSERT INTO chapters(id,user_id,course_id,document_id,section_id,title,level,position,locator_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`chapter-${sectionId}`, userId, courseId, document.id, sectionId, section.title || '', Math.min(6, Math.max(1, level)), Number(section.position ?? index), json(section.locator || {}), now());
    }
    database.exec('RELEASE document_upsert');
    return document.id;
    } catch (error) { database.exec('ROLLBACK TO document_upsert; RELEASE document_upsert'); throw error; }
  }

  function listDocuments({ courseId, workspaceId } = {}) {
    const clauses = ['user_id=?']; const values = [currentUserId()];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (workspaceId) { clauses.push('workspace_id=?'); values.push(workspaceId); }
    const rows = stmt(`SELECT * FROM documents ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...values);
    return rows.map(row => ({ ...row, fileType: row.file_type, metadata: parse(row.metadata_json, {}), legacy: parse(row.legacy_json, {}) }));
  }
  function getDocument(idValue) { const row = stmt('SELECT * FROM documents WHERE id=? AND user_id=?').get(idValue, currentUserId()); return row ? { ...row, fileType: row.file_type, metadata: parse(row.metadata_json, {}), legacy: parse(row.legacy_json, {}) } : null; }
  function readingPageCount(document) {
    const sections = stmt('SELECT locator_json FROM document_sections WHERE document_id=?').all(document.id);
    return Math.max(1, Number(document.legacy?.pages) || sections.length, ...sections.map(row => { const locator = parse(row.locator_json, {}); return Number(locator.page || locator.slide) || 0; }));
  }
  function getReadingPosition(documentId) {
    const document = getDocument(documentId);
    if (!document) return null;
    const row = stmt('SELECT * FROM reading_positions WHERE user_id=? AND document_id=?').get(currentUserId(), documentId);
    const total = readingPageCount(document);
    const pagesViewed = parse(row?.pages_viewed_json, []).filter(page => Number.isInteger(page) && page > 0 && page <= total);
    return { documentId, currentPage: Math.min(total, Math.max(1, Number(row?.current_page) || 1)), pagesViewed, totalPages: total, progress: pagesViewed.length / total, updatedAt: row?.updated_at || null };
  }
  function saveReadingPosition(documentId, { currentPage, pagesViewed = [] } = {}) {
    const current = getReadingPosition(documentId);
    if (!current) throw new Error('资料不存在或不属于当前用户');
    const page = Number(currentPage ?? current.currentPage);
    if (!Number.isInteger(page) || page < 1 || page > current.totalPages) throw Object.assign(new Error('阅读页码超出文档范围'), { code: 'INVALID_READING_PAGE', status: 400 });
    const visited = [...new Set([...current.pagesViewed, ...pagesViewed, page].map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= current.totalPages))].sort((a, b) => a - b);
    stmt('INSERT INTO reading_positions(user_id,document_id,current_page,pages_viewed_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,document_id) DO UPDATE SET current_page=excluded.current_page,pages_viewed_json=excluded.pages_viewed_json,updated_at=excluded.updated_at')
      .run(currentUserId(), documentId, page, json(visited, []), now());
    return getReadingPosition(documentId);
  }
  function deleteDocument(idValue) {
    if (!getDocument(idValue)) return false;
    database.exec('SAVEPOINT document_delete');
    try {
      stmt('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_id=?)').run(idValue);
      // A concept can have evidence in multiple documents. Never delete it based
      // only on lastQuestionId; that destroyed unrelated learning history.
      for (const table of ['learning_events', 'learning_notes', 'learning_experiences', 'learning_sessions', 'notes', 'knowledge_cards', 'memories']) stmt(`DELETE FROM ${table} WHERE document_id=? AND user_id=?`).run(idValue, currentUserId());
      stmt('DELETE FROM annotations WHERE document_id=?').run(idValue);
      stmt('DELETE FROM questions WHERE source_document_id=? AND user_id=?').run(idValue, currentUserId());
      stmt('DELETE FROM document_chunks WHERE document_id=?').run(idValue);
      stmt('DELETE FROM document_sections WHERE document_id=?').run(idValue);
      const removed = stmt('DELETE FROM documents WHERE id=? AND user_id=?').run(idValue, currentUserId()).changes > 0;
      database.exec('RELEASE document_delete'); return removed;
    } catch (error) { database.exec('ROLLBACK TO document_delete; RELEASE document_delete'); throw error; }
  }
  function getDocumentContext(idValue) { return stmt('SELECT c.*, s.title section_title, s.locator_json FROM document_chunks c JOIN documents d ON d.id=c.document_id LEFT JOIN document_sections s ON s.id=c.section_id WHERE c.document_id=? AND d.user_id=? ORDER BY c.chunk_index').all(idValue, currentUserId()).map(row => ({ ...row, metadata: parse(row.metadata_json, {}), locator: parse(row.locator_json, {}) })); }
  function searchChunks(query, { documentIds = [], courseId, workspaceId, page, slide, sheet, limit = 8, candidateLimit = limit, includeZero = false } = {}) {
    const terms = tokenize(query);
    const clauses = ['d.user_id=?']; const values = [currentUserId()];
    if (courseId) { clauses.push('d.course_id=?'); values.push(courseId); }
    if (workspaceId) { clauses.push('d.workspace_id=?'); values.push(workspaceId); }
    if (documentIds.length) { clauses.push(`d.id IN (${documentIds.map(() => '?').join(',')})`); values.push(...documentIds); }
    const rows = stmt(`SELECT c.*,d.title document_title,d.course_id,d.workspace_id,s.title section_title,s.locator_json FROM document_chunks c JOIN documents d ON d.id=c.document_id LEFT JOIN document_sections s ON s.id=c.section_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`).all(...values);
    return rows.map(row => { const locator = parse(row.locator_json, {}); const haystack = `${row.content} ${row.section_title || ''}`.toLowerCase(); const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0); return { ...row, score, locator, metadata: parse(row.metadata_json, {}) }; }).filter(row => (page == null || Number(row.locator.page) === Number(page)) && (slide == null || Number(row.locator.slide) === Number(slide)) && (sheet == null || Number(row.locator.sheet) === Number(sheet))).filter(row => includeZero || row.score > 0 || !terms.length).sort((a, b) => b.score - a.score).slice(0, includeZero ? Math.max(Number(candidateLimit) || 0, Number(limit) || 1) : limit);
  }
  function listCourses(workspaceId = defaultWorkspaceId()) { return stmt('SELECT c.* FROM courses c JOIN workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=? AND w.user_id=? ORDER BY c.name').all(workspaceId, currentUserId()); }
  function listWorkspaces() { return stmt('SELECT * FROM workspaces WHERE user_id=? ORDER BY name').all(currentUserId()); }
  function getWorkspace(workspaceId) { return workspaceId ? stmt('SELECT * FROM workspaces WHERE id=? AND user_id=?').get(workspaceId, currentUserId()) : null; }
  function getCourse(courseId) { return courseId ? stmt('SELECT c.* FROM courses c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?').get(courseId, currentUserId()) : null; }
  function createWorkspace(name, description = '') { const workspaceId = id('workspace'); stmt('INSERT INTO workspaces(id,user_id,name,description,created_at) VALUES(?,?,?,?,?)').run(workspaceId, currentUserId(), name, description, now()); return stmt('SELECT * FROM workspaces WHERE id=? AND user_id=?').get(workspaceId, currentUserId()); }
  function createCourse(name, workspaceId = defaultWorkspaceId(), description = '') { const owner = stmt('SELECT id FROM workspaces WHERE id=? AND user_id=?').get(workspaceId, currentUserId()); if (!owner) throw new Error('工作区不存在或不属于当前用户'); const courseId = id('course'); stmt('INSERT INTO courses(id,workspace_id,name,description,created_at) VALUES(?,?,?,?,?)').run(courseId, workspaceId, name, description, now()); return stmt('SELECT * FROM courses WHERE id=?').get(courseId); }
  function assertOwnedWorkspace(workspaceId) { if (workspaceId && !stmt('SELECT id FROM workspaces WHERE id=? AND user_id=?').get(workspaceId, currentUserId())) throw new Error('工作区不存在或不属于当前用户'); }
  function assertOwnedCourse(courseId) { if (courseId && !stmt('SELECT c.id FROM courses c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?').get(courseId, currentUserId())) throw new Error('课程不存在或不属于当前用户'); }
  function assertOwnedDocument(documentId) { if (documentId && !stmt('SELECT id FROM documents WHERE id=? AND user_id=?').get(documentId, currentUserId())) throw new Error('资料不存在或不属于当前用户'); }
  function updateDocumentOrganization(documentId, { workspaceId, courseId } = {}) {
    const row = stmt('SELECT * FROM documents WHERE id=? AND user_id=?').get(documentId, currentUserId());
    if (!row) throw new Error('资料不存在或不属于当前用户');
    const targetWorkspaceId = workspaceId === undefined ? row.workspace_id : (workspaceId || 'workspace-personal');
    const workspace = getWorkspace(targetWorkspaceId);
    if (!workspace) throw new Error('工作区不存在或不属于当前用户');
    const targetCourseId = courseId === undefined ? row.course_id : (courseId || null);
    const course = targetCourseId ? getCourse(targetCourseId) : null;
    if (targetCourseId && !course) throw new Error('课程不存在或不属于当前用户');
    if (course && course.workspace_id !== workspace.id) throw new Error('课程不属于目标工作区');
    const legacy = parse(row.legacy_json, {});
    legacy.workspaceId = workspace.id;
    legacy.courseId = course?.id || null;
    legacy.course = course?.name || '未分类';
    const metadata = parse(row.metadata_json, {});
    metadata.workspaceId = workspace.id;
    metadata.courseId = course?.id || null;
    stmt('UPDATE documents SET workspace_id=?,course_id=?,metadata_json=?,legacy_json=? WHERE id=? AND user_id=?').run(workspace.id, course?.id || null, json(metadata), json(legacy), documentId, currentUserId());
    stmt('UPDATE chapters SET course_id=? WHERE document_id=? AND user_id=?').run(course?.id || null, documentId, currentUserId());
    return getDocument(documentId);
  }
  function assertOwnedConcept(conceptId) { if (conceptId && !stmt('SELECT id FROM concepts WHERE id=? AND user_id=?').get(conceptId, currentUserId())) throw new Error('概念不存在或不属于当前用户'); }
  function upsertConversation({ id: conversationId, title = '学习对话', workspaceId = defaultWorkspaceId(), courseId = null } = {}) { assertOwnedWorkspace(workspaceId); assertOwnedCourse(courseId); const conversationKey = conversationId || id('conversation'); const timestamp = now(); stmt('INSERT INTO conversations(id,user_id,workspace_id,course_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,workspace_id=excluded.workspace_id,course_id=excluded.course_id,updated_at=excluded.updated_at WHERE conversations.user_id=excluded.user_id').run(conversationKey, currentUserId(), workspaceId, courseId, String(title || '学习对话').slice(0, 200), timestamp, timestamp); return stmt('SELECT * FROM conversations WHERE id=? AND user_id=?').get(conversationKey, currentUserId()); }
  function saveConversationMessage({ id: messageId, conversationId = null, role, content, metadata = {} } = {}) { const messageKey = messageId || id('message'); const timestamp = now(); if (conversationId && !stmt('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, currentUserId())) throw new Error('对话不存在或不属于当前用户'); stmt('INSERT INTO messages(id,conversation_id,role,content,metadata_json,created_at) VALUES(?,?,?,?,?,?)').run(messageKey, conversationId, String(role || 'assistant'), String(content || ''), json(metadata), timestamp); if (conversationId) stmt('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?').run(timestamp, conversationId, currentUserId()); return messageKey; }
  function listConversations({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT * FROM conversations WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows; }
  function listConversationMessages(conversationId, limit = 200) {
    const count = Math.min(10000, Math.max(1, Math.floor(Number(limit) || 200)));
    // rowid breaks ties when successive messages share the same millisecond.
    return stmt('SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND c.user_id=? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?')
      .all(conversationId, currentUserId(), count).reverse().map(row => ({ ...row, metadata: parse(row.metadata_json, {}) }));
  }
  function saveMemory(memory) { assertOwnedWorkspace(memory.workspaceId || null); assertOwnedCourse(memory.courseId || null); assertOwnedDocument(memory.documentId || null); assertOwnedConcept(memory.conceptId || null); const timestamp = now(); const memoryId = memory.id || id('memory'); const existing = stmt('SELECT user_id FROM memories WHERE id=?').get(memoryId); if (existing && existing.user_id !== currentUserId()) throw new Error('记忆记录不属于当前用户'); stmt('INSERT OR REPLACE INTO memories(id,type,scope,user_id,workspace_id,course_id,document_id,concept_id,content,metadata_json,importance,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(memoryId, memory.type || 'conversation', memory.scope || 'user', currentUserId(), memory.workspaceId || null, memory.courseId || null, memory.documentId || null, memory.conceptId || null, memory.content, json(memory.metadata || {}), Number(memory.importance ?? 0.5), memory.active === false ? 0 : 1, memory.createdAt || timestamp, timestamp); return memoryId; }
  function listMemories({ type, courseId, includeGlobal = false, limit = 50, active = true } = {}) { const clauses = ['user_id=?']; const values = [currentUserId()]; if (type) { clauses.push('type=?'); values.push(type); } if (courseId) { clauses.push(includeGlobal ? '(course_id=? OR course_id IS NULL)' : 'course_id=?'); values.push(courseId); } if (active) clauses.push('active=1'); const rows = stmt(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...values); return rows.map(row => ({ ...row, metadata: parse(row.metadata_json, {}) })); }
  function upsertConcept({ name, courseId = null, scoreDelta = 0, status, metadata = {} }) { assertOwnedCourse(courseId); const existing = stmt('SELECT * FROM concepts WHERE user_id=? AND course_id IS ? AND name=?').get(currentUserId(), courseId, name); const timestamp = now(); if (!existing) { const conceptId = id('concept'); const score = Math.max(0, Math.min(1, scoreDelta)); stmt('INSERT INTO concepts(id,user_id,course_id,name,mastery_score,status,first_seen,last_seen,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').run(conceptId, currentUserId(), courseId, name, score, status || (score > 0.8 ? 'mastered' : score > 0 ? 'learning' : 'unseen'), timestamp, timestamp, json(metadata)); return { id: conceptId, name, courseId, masteryScore: score }; } const score = Math.max(0, Math.min(1, Number(existing.mastery_score) + scoreDelta)); const nextStatus = status || (score >= 0.8 ? 'mastered' : score >= 0.45 ? 'familiar' : score > 0 ? 'learning' : 'unseen'); stmt('UPDATE concepts SET mastery_score=?,status=?,last_seen=?,metadata_json=? WHERE id=? AND user_id=?').run(score, nextStatus, timestamp, json({ ...parse(existing.metadata_json, {}), ...metadata }), existing.id, currentUserId()); return { id: existing.id, name, courseId, masteryScore: score }; }
  function listConcepts(courseId) { const rows = stmt(`SELECT * FROM concepts WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY mastery_score ASC, name`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(row => ({ ...row, masteryScore: row.mastery_score, metadata: parse(row.metadata_json, {}) })); }
  function listKnowledgePoints(courseId) { return listConcepts(courseId).map(item => ({ ...item, mastery: item.masteryScore, learningEvidence: getMasteryEvidence(item.id), description: item.metadata?.description || 'Recorded learning concept; mastery not assessed', difficulty: item.metadata?.difficulty || '', importance: item.metadata?.importance || '', source: item.metadata?.source || 'SQLite learning memory', color: item.metadata?.color || '#635bff' })); }
  function saveQuestion(question) { const questionId = question.id || id('question'); const existing = stmt('SELECT user_id FROM questions WHERE id=?').get(questionId); if (existing && existing.user_id !== currentUserId()) throw new Error('问题记录不属于当前用户'); assertOwnedCourse(question.courseId || null); assertOwnedDocument(question.sourceDocumentId || null); stmt('INSERT OR REPLACE INTO questions(id,user_id,question,timestamp,course_id,source_document_id,concepts_json,answer_summary,difficulty,resolved,conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(questionId, currentUserId(), question.question, question.timestamp || now(), question.courseId || null, question.sourceDocumentId || null, json(question.concepts || []), question.answerSummary || '', question.difficulty || 'unknown', question.resolved ? 1 : 0, question.conversationId || null); return questionId; }
  function listQuestions({ courseId, limit = 20 } = {}) { const rows = stmt(`SELECT * FROM questions WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY timestamp DESC LIMIT ${Math.max(1, Number(limit) || 20)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(row => ({ ...row, concepts: parse(row.concepts_json, []) })); }
  function listErrors({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT e.*,c.name concept_name,q.question FROM errors e LEFT JOIN concepts c ON c.id=e.concept_id LEFT JOIN questions q ON q.id=e.question_id WHERE e.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ORDER BY e.created_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows; }
  function recordProgress({ conceptId, event = 'question', correct = false }) { if (!conceptId) return null; assertOwnedConcept(conceptId); const timestamp = now(); const existing = stmt('SELECT * FROM learning_progress WHERE user_id=? AND concept_id=?').get(currentUserId(), conceptId); const isQuestion = event === 'question' || event === 'error'; const isReview = event === 'review'; if (!existing) { const progressId = id('progress'); stmt('INSERT INTO learning_progress(id,user_id,concept_id,attempts,correct_count,question_count,review_count,last_event,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(progressId, currentUserId(), conceptId, isQuestion ? 1 : 0, correct ? 1 : 0, isQuestion ? 1 : 0, isReview ? 1 : 0, event, timestamp); return progressId; } stmt('UPDATE learning_progress SET attempts=attempts+?,correct_count=correct_count+?,question_count=question_count+?,review_count=review_count+?,last_event=?,updated_at=? WHERE user_id=? AND concept_id=?').run(isQuestion ? 1 : 0, correct ? 1 : 0, isQuestion ? 1 : 0, isReview ? 1 : 0, event, timestamp, currentUserId(), conceptId); return existing.id; }
  function listProgress({ courseId, limit = 100 } = {}) { const rows = stmt(`SELECT lp.*,c.name concept_name,c.course_id FROM learning_progress lp JOIN concepts c ON c.id=lp.concept_id WHERE lp.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ORDER BY lp.updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows; }
  function saveQuizAttempt({ courseId = null, concept, score = 0, total = 0, answers = [] }) { assertOwnedCourse(courseId); const attemptId = id('quiz-attempt'); stmt('INSERT INTO quiz_attempts(id,user_id,course_id,concept,score,total,answers_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(attemptId, currentUserId(), courseId, String(concept || '当前资料'), Number(score) || 0, Number(total) || 0, json(answers, []), now()); return attemptId; }
  function listQuizAttempts({ courseId, limit = 50 } = {}) { const rows = stmt(`SELECT * FROM quiz_attempts WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(row => ({ ...row, answers: parse(row.answers_json, []) })); }
  function updateReviewSchedule({ conceptId, correct = true }) { if (!conceptId) return null; assertOwnedConcept(conceptId); const timestamp = now(); const existing = stmt('SELECT * FROM review_schedule WHERE user_id=? AND concept_id=?').get(currentUserId(), conceptId); const wasCorrect = Boolean(correct); const repetitions = wasCorrect ? (existing?.repetitions || 0) + 1 : 0; const ease = Math.max(1.3, Number(existing?.ease || 2.5) + (wasCorrect ? 0.05 : -0.2)); const previousInterval = Number(existing?.interval_days || 0); const intervalDays = wasCorrect ? (repetitions <= 1 ? 1 : repetitions === 2 ? 3 : Math.min(60, Math.max(1, Math.round(previousInterval * ease)))) : 0.25; const nextReview = new Date(Date.now() + intervalDays * 86400000).toISOString(); if (!existing) { const scheduleId = id('review'); stmt('INSERT INTO review_schedule(id,user_id,concept_id,next_review_at,interval_days,ease,repetitions,last_result,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(scheduleId, currentUserId(), conceptId, nextReview, intervalDays, ease, repetitions, wasCorrect ? 1 : 0, timestamp); return scheduleId; } stmt('UPDATE review_schedule SET next_review_at=?,interval_days=?,ease=?,repetitions=?,last_result=?,updated_at=? WHERE user_id=? AND concept_id=?').run(nextReview, intervalDays, ease, repetitions, wasCorrect ? 1 : 0, timestamp, currentUserId(), conceptId); return existing.id; }
  function listReviewSchedule({ courseId, dueOnly = false, limit = 100 } = {}) { const rows = stmt(`SELECT rs.*,c.name concept_name,c.course_id,c.mastery_score,c.status FROM review_schedule rs JOIN concepts c ON c.id=rs.concept_id WHERE rs.user_id=? ${courseId ? 'AND c.course_id=?' : ''} ${dueOnly ? 'AND rs.next_review_at<=?' : ''} ORDER BY rs.next_review_at ASC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? (dueOnly ? [currentUserId(), courseId, now()] : [currentUserId(), courseId]) : (dueOnly ? [currentUserId(), now()] : [currentUserId()]))); return rows; }
  function clearCourseMemory(courseId) {
    if (!courseId) return { ok: false, removed: 0 };
    const conceptIds = stmt('SELECT id FROM concepts WHERE user_id=? AND course_id=?').all(currentUserId(), courseId).map(row => row.id);
    let removed = 0;
    const run = (sql, values) => { removed += Number(stmt(sql).run(...values).changes || 0); };
    for (const table of ['learning_events', 'memories', 'questions', 'quiz_attempts', 'learning_sessions', 'learning_notes', 'learning_experiences']) run(`DELETE FROM ${table} WHERE user_id=? AND course_id=?`, [currentUserId(), courseId]);
    if (conceptIds.length) {
      const placeholders = conceptIds.map(() => '?').join(',');
      run(`DELETE FROM concept_relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`, [...conceptIds, ...conceptIds]);
      for (const table of ['errors', 'learning_progress', 'review_schedule']) run(`DELETE FROM ${table} WHERE user_id=? AND concept_id IN (${placeholders})`, [currentUserId(), ...conceptIds]);
      run(`DELETE FROM concepts WHERE user_id=? AND id IN (${placeholders})`, [currentUserId(), ...conceptIds]);
    }
    return { ok: true, courseId, removed, concepts: conceptIds.length };
  }
  function saveRelation({ sourceId, targetId, type, weight = 0.5, source = 'memory' }) { const allowed = new Set(['RELATED_TO', 'PREREQUISITE_OF', 'DERIVED_FROM', 'ASKED_ABOUT', 'MENTIONED_IN', 'CONFUSED_WITH', 'SOLVED_BY', 'BELONGS_TO']); const normalizedType = String(type || 'RELATED_TO').trim().toUpperCase(); if (!sourceId || !targetId || sourceId === targetId || !allowed.has(normalizedType)) throw new Error('概念关系必须连接两个不同概念，且使用受支持的关系类型'); const sourceNode = stmt('SELECT id FROM concepts WHERE id=? AND user_id=?').get(sourceId, currentUserId()); const targetNode = stmt('SELECT id FROM concepts WHERE id=? AND user_id=?').get(targetId, currentUserId()); if (!sourceNode || !targetNode) throw new Error('概念关系的节点不存在或不属于当前用户'); const relationId = id('relation'); stmt('INSERT INTO concept_relations(id,source_id,target_id,type,weight,source,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,target_id,type) DO UPDATE SET weight=excluded.weight,source=excluded.source').run(relationId, sourceId, targetId, normalizedType, Math.max(0, Math.min(1, Number(weight) || 0.5)), source, '{}', now()); return stmt('SELECT * FROM concept_relations WHERE source_id=? AND target_id=? AND type=?').get(sourceId, targetId, normalizedType); }
  function deleteRelation(relationId) { const row = stmt('SELECT r.id FROM concept_relations r JOIN concepts s ON s.id=r.source_id JOIN concepts t ON t.id=r.target_id WHERE r.id=? AND s.user_id=? AND t.user_id=?').get(relationId, currentUserId(), currentUserId()); return row ? stmt('DELETE FROM concept_relations WHERE id=?').run(relationId).changes > 0 : false; }
  function getConceptDetails(conceptId) { const conceptRow = stmt('SELECT * FROM concepts WHERE id=? AND user_id=?').get(conceptId, currentUserId()); if (!conceptRow) return null; const concept = { ...conceptRow, masteryScore: conceptRow.mastery_score, metadata: parse(conceptRow.metadata_json, {}) }; const relations = stmt('SELECT r.*,s.name source_name,t.name target_name FROM concept_relations r JOIN concepts s ON s.id=r.source_id JOIN concepts t ON t.id=r.target_id WHERE (r.source_id=? OR r.target_id=?) AND s.user_id=? AND t.user_id=?').all(conceptId, conceptId, currentUserId(), currentUserId()); const courseId = conceptRow.course_id || undefined; const conceptName = String(conceptRow.name || '').toLowerCase(); const matchesConcept = item => `${item.title || ''} ${item.content || ''} ${item.front || ''} ${item.back || ''} ${item.source || ''}`.toLowerCase().includes(conceptName); const questions = listQuestions({ courseId, limit: 200 }).filter(item => item.concepts.includes(conceptRow.name)).slice(0, 20); const documents = questions.map(item => item.source_document_id ? getDocument(item.source_document_id) : null).filter(Boolean).map(item => ({ id: item.id, title: item.title, fileType: item.fileType })); const memories = listMemories({ courseId, includeGlobal: true, limit: 200 }).filter(item => item.concept_id === conceptId || item.content.toLowerCase().includes(conceptName)).slice(0, 20); const notes = listNotes({ courseId, limit: 200 }).filter(matchesConcept).slice(0, 20); const cards = listCards({ courseId, limit: 200 }).filter(matchesConcept).slice(0, 20); const errors = listErrors({ courseId, limit: 200 }).filter(item => item.concept_id === conceptId).slice(0, 20); const progress = listProgress({ courseId, limit: 200 }).find(item => item.concept_id === conceptId) || null; const quizAttempts = listQuizAttempts({ courseId, limit: 200 }).filter(item => item.concept === conceptRow.name).slice(0, 20); return { learningEvents: listLearningEvents({ conceptId, limit: 20 }), learningEvidence: getMasteryEvidence(conceptId), concept, relations, questions, documents, memories, notes, cards, errors, progress, quizAttempts }; }
  function listGraph(courseId) { const concepts = listConcepts(courseId); const ids = new Set(concepts.map(c => c.id)); const labels = new Map(concepts.map(c => [c.id, c.name])); const relations = stmt('SELECT * FROM concept_relations').all().filter(row => ids.has(row.source_id) && ids.has(row.target_id)); return { nodes: concepts.map(c => ({ id: c.id, label: c.name, type: 'concept', mastery: c.masteryScore, status: c.status, learningEvidence: getMasteryEvidence(c.id) })), edges: relations.map(r => ({ id: r.id, source: r.source_id, target: r.target_id, sourceLabel: labels.get(r.source_id), targetLabel: labels.get(r.target_id), type: r.type, weight: r.weight, sourceOrigin: r.source })) }; }
  function listCards({ courseId, documentId, category, limit = 200 } = {}) {
    const clauses = ['user_id=?']; const values = [currentUserId()];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (documentId) { clauses.push('document_id=?'); values.push(documentId); }
    if (category) { clauses.push('category=?'); values.push(String(category)); }
    const rows = stmt(`SELECT * FROM knowledge_cards WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 200)}`).all(...values);
    return rows.map(row => ({ ...row, source: row.source_label, due: row.due_at, mastery: row.mastery_score, cardType: row.card_type || 'concept', structure: parse(row.content_json, {}), locator: parse(row.locator_json, {}) }));
  }
  function listCardCategories() { return stmt('SELECT category,COUNT(*) count FROM knowledge_cards WHERE user_id=? GROUP BY category ORDER BY category COLLATE NOCASE').all(currentUserId()).map(row => ({ name: row.category || '未分类', count: Number(row.count || 0) })); }
  function saveCard({ cardId, front, back, courseId = null, documentId = null, source = '', due = 'Tomorrow', mastery = 0.2, category = '未分类', cardType = 'concept', structure = {}, locator = {} } = {}) {
    if (!String(front || '').trim() || !String(back || '').trim()) throw new Error('知识卡正面和背面不能为空');
    assertOwnedCourse(courseId); assertOwnedDocument(documentId); const cardKey = cardId || id('card'); const existing = stmt('SELECT user_id FROM knowledge_cards WHERE id=?').get(cardKey); if (existing && existing.user_id !== currentUserId()) throw new Error('知识卡片不属于当前用户'); const timestamp = now();
    stmt(`INSERT INTO knowledge_cards(id,user_id,course_id,document_id,front,back,source_label,locator_json,due_at,mastery_score,category,card_type,content_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,document_id=excluded.document_id,front=excluded.front,back=excluded.back,source_label=excluded.source_label,locator_json=excluded.locator_json,due_at=excluded.due_at,mastery_score=excluded.mastery_score,category=excluded.category,card_type=excluded.card_type,content_json=excluded.content_json,updated_at=excluded.updated_at`)
      .run(cardKey, currentUserId(), courseId, documentId, String(front).trim().slice(0, 2000), String(back).trim().slice(0, 20000), String(source || '').slice(0, 500), json(locator), String(due || 'Tomorrow').slice(0, 80), Math.max(0, Math.min(1, Number(mastery) || 0)), String(category || '未分类').trim().slice(0, 80) || '未分类', String(cardType || 'concept').trim().slice(0, 40), json(structure), timestamp, timestamp);
    return listCards({ documentId }).find(card => card.id === cardKey) || null;
  }
  function renameCardCategory(from, to) { const source = String(from || '').trim(); const target = String(to || '').trim().slice(0, 80); if (!source || !target) throw new Error('分类名称不能为空'); return stmt('UPDATE knowledge_cards SET category=?,updated_at=? WHERE user_id=? AND category=?').run(target, now(), currentUserId(), source).changes; }
  function removeCardCategory(category) { const source = String(category || '').trim(); if (!source || source === '未分类') throw new Error('不能删除默认分类'); return stmt("UPDATE knowledge_cards SET category='未分类',updated_at=? WHERE user_id=? AND category=?").run(now(), currentUserId(), source).changes; }
  function deleteCard(cardId) { return stmt('DELETE FROM knowledge_cards WHERE id=? AND user_id=?').run(cardId, currentUserId()).changes > 0; }
  function listAnnotations({ documentId, page, limit = 500 } = {}) {
    const pageClause = page !== undefined && page !== null ? ' AND a.page=?' : '';
    const pageValue = page !== undefined && page !== null ? [Number(page) || 0] : [];
    const rows = documentId
      ? stmt(`SELECT a.* FROM annotations a JOIN documents d ON d.id=a.document_id WHERE a.document_id=? AND d.user_id=?${pageClause} ORDER BY a.created_at DESC LIMIT ?`).all(documentId, currentUserId(), ...pageValue, Math.max(1, Number(limit) || 500))
      : stmt(`SELECT a.* FROM annotations a JOIN documents d ON d.id=a.document_id WHERE d.user_id=?${pageClause} ORDER BY a.created_at DESC LIMIT ?`).all(currentUserId(), ...pageValue, Math.max(1, Number(limit) || 500));
    return rows.map(row => ({ ...row, documentId: row.document_id, userId: row.user_id, courseId: row.course_id, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at }));
  }
  function saveAnnotation({ id: annotationId, documentId, page, type = 'highlight', color = '', text = '', note = '' } = {}) {
    if (!documentId) throw new Error('批注必须关联文档');
    if (!stmt('SELECT id FROM documents WHERE id=? AND user_id=?').get(documentId, currentUserId())) throw new Error('批注关联的文档不存在或不属于当前用户');
    const documentRow = stmt('SELECT id,user_id,course_id FROM documents WHERE id=? AND user_id=?').get(documentId, currentUserId());
    if (!documentRow) throw new Error('批注关联的文档不存在或不属于当前用户');
    const annotationKey = annotationId || id('annotation'); const existing = stmt('SELECT a.id FROM annotations a JOIN documents d ON d.id=a.document_id WHERE a.id=? AND d.user_id=?').get(annotationKey, currentUserId()); const foreign = stmt('SELECT a.id FROM annotations a WHERE a.id=?').get(annotationKey); if (foreign && !existing) throw new Error('批注记录不属于当前用户'); const createdAt = existing ? (stmt('SELECT created_at FROM annotations WHERE id=?').get(annotationKey)?.created_at || now()) : now();
    stmt(`INSERT INTO annotations(id,user_id,course_id,document_id,page,type,color,text,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,course_id=excluded.course_id,document_id=excluded.document_id,page=excluded.page,type=excluded.type,color=excluded.color,text=excluded.text,note=excluded.note,updated_at=excluded.updated_at`).run(annotationKey, currentUserId(), documentRow.course_id || null, documentId, Number(page || 0) || null, String(type).slice(0, 40), String(color).slice(0, 40), String(text).slice(0, 20000), String(note).slice(0, 20000), createdAt, now());
    recordLearningEvent({ type: 'annotation', sourceId: annotationKey, documentId, evidence: { page: Number(page || 0), annotationType: type, text: String(text).slice(0, 20000), note: String(note).slice(0, 20000) } });
    return listAnnotations({ documentId }).find(item => item.id === annotationKey) || null;
  }
  function updateAnnotation(annotationId, updates = {}) {
    const existing = stmt('SELECT * FROM annotations WHERE id=? AND user_id=?').get(annotationId, currentUserId());
    if (!existing) return null;
    return saveAnnotation({ id: annotationId, documentId: existing.document_id, page: updates.page ?? existing.page, type: updates.type ?? existing.type, color: updates.color ?? existing.color, text: updates.text ?? existing.text, note: updates.note ?? existing.note });
  }
  function deleteAnnotation(annotationId) { const removed = stmt('DELETE FROM annotations WHERE id=? AND document_id IN (SELECT id FROM documents WHERE user_id=?)').run(annotationId, currentUserId()).changes > 0; if (removed) stmt("DELETE FROM learning_events WHERE user_id=? AND event_type='annotation' AND source_id=?").run(currentUserId(), annotationId); return removed; }
  function listNotes({ courseId, documentId, limit = 100 } = {}) {
    const clauses = ['user_id=?']; const values = [currentUserId()];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (documentId) { clauses.push('document_id=?'); values.push(documentId); }
    const rows = stmt(`SELECT * FROM notes WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...values);
    return rows.map(row => ({ ...row, locator: parse(row.locator_json, {}) }));
  }
  function saveNote({ noteId, title = '', content, courseId = null, documentId = null, locator = {} } = {}) {
    const noteKey = noteId || id('note'); const timestamp = now();
    if (!String(content || '').trim()) throw new Error('笔记内容不能为空');
    assertOwnedCourse(courseId); assertOwnedDocument(documentId); const existing = stmt('SELECT user_id FROM notes WHERE id=?').get(noteKey); if (existing && existing.user_id !== currentUserId()) throw new Error('笔记不属于当前用户');
    stmt(`INSERT INTO notes(id,user_id,course_id,document_id,title,content,locator_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,document_id=excluded.document_id,title=excluded.title,content=excluded.content,locator_json=excluded.locator_json,updated_at=excluded.updated_at`)
      .run(noteKey, currentUserId(), courseId, documentId, String(title || '').trim().slice(0, 200), String(content).trim().slice(0, 20000), json(locator), timestamp, timestamp);
    recordLearningEvent({ type: 'note', sourceId: noteKey, courseId, documentId, evidence: { title: String(title || '').slice(0, 200), locator } });
    return listNotes({ documentId }).find(note => note.id === noteKey) || null;
  }
  function deleteNote(noteId) { const removed = stmt('DELETE FROM notes WHERE id=? AND user_id=?').run(noteId, currentUserId()).changes > 0; if (removed) stmt("DELETE FROM learning_events WHERE user_id=? AND event_type='note' AND source_id=?").run(currentUserId(), noteId); return removed; }
  function mapLearningSession(row) {
    if (!row) return null;
    return { ...row, userId: row.user_id, workspaceId: row.workspace_id, courseId: row.course_id, documentId: row.document_id, startedAt: row.started_at, endedAt: row.ended_at, pagesViewed: parse(row.pages_viewed_json, []), conceptsViewed: parse(row.concepts_viewed_json, []), annotationsCreated: row.annotations_created, questionsAsked: row.questions_asked, generatedSummary: row.generated_summary, rawEvidence: parse(row.raw_evidence_json, {}), interpretation: parse(row.interpretation_json, {}) };
  }
  function startLearningSession({ sessionId, workspaceId = null, courseId = null, documentId = null } = {}) {
    assertOwnedCourse(courseId); assertOwnedDocument(documentId);
    const sessionKey = sessionId || id('session'); const timestamp = now();
    stmt(`INSERT INTO learning_sessions(id,user_id,workspace_id,course_id,document_id,started_at,ended_at,pages_viewed_json,concepts_viewed_json,annotations_created,questions_asked,generated_summary,raw_evidence_json,interpretation_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionKey, currentUserId(), workspaceId, courseId, documentId, timestamp, null, '[]', '[]', 0, 0, '', '{}', '{}', timestamp, timestamp);
    return mapLearningSession(stmt('SELECT * FROM learning_sessions WHERE id=? AND user_id=?').get(sessionKey, currentUserId()));
  }
  function getLearningSession(sessionId) { return mapLearningSession(stmt('SELECT * FROM learning_sessions WHERE id=? AND user_id=?').get(sessionId, currentUserId())); }
  function listLearningSessions({ courseId, limit = 100 } = {}) { const rows = stmt(`SELECT * FROM learning_sessions WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY started_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(mapLearningSession); }
  function updateLearningSession(sessionId, updates = {}) {
    const current = getLearningSession(sessionId); if (!current) return null;
    if (current.endedAt && (updates.currentPage !== undefined || updates.pagesViewed?.length)) throw Object.assign(new Error('学习会话已结束，请开始新的会话。'), { code: 'SESSION_ENDED', status: 409 });
    const totalPages = current.documentId ? getReadingPosition(current.documentId)?.totalPages : Infinity;
    const incomingPages = (Array.isArray(updates.pagesViewed) ? updates.pagesViewed : []).map(Number).filter(page => Number.isInteger(page) && page > 0 && page <= totalPages);
    if (current.documentId && (updates.currentPage !== undefined || incomingPages.length)) saveReadingPosition(current.documentId, { currentPage: updates.currentPage ?? incomingPages.at(-1), pagesViewed: incomingPages });
    const pages = [...new Set([...(current.pagesViewed || []), ...incomingPages].map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= totalPages))].sort((a, b) => a - b);
    const concepts = [...new Set([...(current.conceptsViewed || []), ...(Array.isArray(updates.conceptsViewed) ? updates.conceptsViewed : [])].map(value => String(value).trim()).filter(Boolean))];
    const timestamp = now();
    stmt(`UPDATE learning_sessions SET pages_viewed_json=?,concepts_viewed_json=?,annotations_created=?,questions_asked=?,ended_at=?,generated_summary=?,raw_evidence_json=?,interpretation_json=?,updated_at=? WHERE id=? AND user_id=?`).run(json(pages, []), json(concepts, []), Math.max(0, Number(updates.annotationsCreated ?? current.annotationsCreated) || 0), Math.max(0, Number(updates.questionsAsked ?? current.questionsAsked) || 0), updates.endedAt === undefined ? current.endedAt : updates.endedAt, String((updates.generatedSummary ?? current.generatedSummary) || '').slice(0, 20000), json(updates.rawEvidence ?? current.rawEvidence, {}), json(updates.interpretation ?? current.interpretation, {}), timestamp, sessionId, currentUserId());
    for (const page of pages.filter(value => !(current.pagesViewed || []).includes(value))) recordLearningEvent({ type: 'reading', sourceId: `${sessionId}:page:${page}`, sessionId, documentId: current.documentId, courseId: current.courseId, evidence: { page } });
    if (updates.endedAt && !current.endedAt) recordLearningEvent({ type: 'session_finished', sourceId: sessionId, sessionId, documentId: current.documentId, courseId: current.courseId, evidence: updates.rawEvidence || current.rawEvidence, interpretation: updates.interpretation || current.interpretation });
    return getLearningSession(sessionId);
  }
  function saveLearningNote(note = {}) {
    assertOwnedCourse(note.courseId || null); assertOwnedDocument(note.documentId || null);
    const noteId = note.id || id('learning-note'); const timestamp = now(); const existing = stmt('SELECT user_id FROM learning_notes WHERE id=?').get(noteId); if (existing && existing.user_id !== currentUserId()) throw new Error('学习笔记不属于当前用户');
    stmt(`INSERT INTO learning_notes(id,user_id,course_id,document_id,session_id,title,concepts_json,highlights_json,annotations_json,questions_json,explanations_json,difficult_points_json,important_points_json,misconceptions_json,summary,raw_evidence_json,interpretation_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,concepts_json=excluded.concepts_json,highlights_json=excluded.highlights_json,annotations_json=excluded.annotations_json,questions_json=excluded.questions_json,explanations_json=excluded.explanations_json,difficult_points_json=excluded.difficult_points_json,important_points_json=excluded.important_points_json,misconceptions_json=excluded.misconceptions_json,summary=excluded.summary,raw_evidence_json=excluded.raw_evidence_json,interpretation_json=excluded.interpretation_json,updated_at=excluded.updated_at`).run(noteId, currentUserId(), note.courseId || null, note.documentId || null, note.sessionId || null, String(note.title || '').slice(0, 300), json(note.concepts || [], []), json(note.highlights || [], []), json(note.annotations || [], []), json(note.questions || [], []), json(note.explanations || [], []), json(note.difficultPoints || [], []), json(note.importantPoints || [], []), json(note.misconceptions || [], []), String(note.summary || '').slice(0, 20000), json(note.rawEvidence || {}, {}), json(note.interpretation || {}, {}), note.createdAt || timestamp, timestamp);
    return getLearningNote(noteId);
  }
  function getLearningNote(noteId) { const row = stmt('SELECT * FROM learning_notes WHERE id=? AND user_id=?').get(noteId, currentUserId()); return row ? { ...row, userId: row.user_id, courseId: row.course_id, documentId: row.document_id, sessionId: row.session_id, concepts: parse(row.concepts_json, []), highlights: parse(row.highlights_json, []), annotations: parse(row.annotations_json, []), questions: parse(row.questions_json, []), explanations: parse(row.explanations_json, []), difficultPoints: parse(row.difficult_points_json, []), importantPoints: parse(row.important_points_json, []), misconceptions: parse(row.misconceptions_json, []), rawEvidence: parse(row.raw_evidence_json, {}), interpretation: parse(row.interpretation_json, {}) } : null; }
  function listLearningNotes({ courseId, documentId, sessionId, limit = 100 } = {}) { const clauses = ['user_id=?']; const values = [currentUserId()]; if (courseId) { clauses.push('course_id=?'); values.push(courseId); } if (documentId) { clauses.push('document_id=?'); values.push(documentId); } if (sessionId) { clauses.push('session_id=?'); values.push(sessionId); } return stmt(`SELECT id FROM learning_notes WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...values).map(row => getLearningNote(row.id)); }
  function saveLearningExperience(experience = {}) { assertOwnedCourse(experience.courseId || null); assertOwnedDocument(experience.documentId || null); const experienceId = experience.id || id('experience'); const timestamp = now(); const existing = stmt('SELECT user_id FROM learning_experiences WHERE id=?').get(experienceId); if (existing && existing.user_id !== currentUserId()) throw new Error('学习经历不属于当前用户'); stmt(`INSERT INTO learning_experiences(id,user_id,course_id,document_id,session_id,experience_date,title,content,concepts_json,focus_json,questions_count,difficult_points_json,mastery_changes_json,related_concepts_json,raw_evidence_json,interpretation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,concepts_json=excluded.concepts_json,focus_json=excluded.focus_json,questions_count=excluded.questions_count,difficult_points_json=excluded.difficult_points_json,mastery_changes_json=excluded.mastery_changes_json,related_concepts_json=excluded.related_concepts_json,raw_evidence_json=excluded.raw_evidence_json,interpretation_json=excluded.interpretation_json,updated_at=excluded.updated_at`).run(experienceId, currentUserId(), experience.courseId || null, experience.documentId || null, experience.sessionId || null, experience.date || timestamp.slice(0, 10), String(experience.title || '').slice(0, 300), String(experience.content || '').slice(0, 30000), json(experience.concepts || [], []), json(experience.focus || [], []), Number(experience.questionsCount) || 0, json(experience.difficultPoints || [], []), json(experience.masteryChanges || [], []), json(experience.relatedConcepts || [], []), json(experience.rawEvidence || {}, {}), json(experience.interpretation || {}, {}), experience.createdAt || timestamp, timestamp); return getLearningExperience(experienceId); }
  function getLearningExperience(experienceId) { const row = stmt('SELECT * FROM learning_experiences WHERE id=? AND user_id=?').get(experienceId, currentUserId()); return row ? { ...row, userId: row.user_id, courseId: row.course_id, documentId: row.document_id, sessionId: row.session_id, date: row.experience_date, concepts: parse(row.concepts_json, []), focus: parse(row.focus_json, []), questionsCount: row.questions_count, difficultPoints: parse(row.difficult_points_json, []), masteryChanges: parse(row.mastery_changes_json, []), relatedConcepts: parse(row.related_concepts_json, []), rawEvidence: parse(row.raw_evidence_json, {}), interpretation: parse(row.interpretation_json, {}) } : null; }
  function listLearningExperiences({ courseId, limit = 100 } = {}) { const rows = stmt(`SELECT * FROM learning_experiences WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY experience_date DESC,updated_at DESC LIMIT ${Math.max(1, Number(limit) || 100)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(row => getLearningExperience(row.id)); }
  function listChapters({ courseId, documentId } = {}) {
    const clauses = ['user_id=?']; const values = [currentUserId()];
    if (courseId) { clauses.push('course_id=?'); values.push(courseId); }
    if (documentId) { clauses.push('document_id=?'); values.push(documentId); }
    return stmt(`SELECT * FROM chapters WHERE ${clauses.join(' AND ')} ORDER BY document_id,position`).all(...values).map(row => ({ ...row, locator: parse(row.locator_json, {}) }));
  }
  function recordLearningEvent({ type, sourceId, courseId = null, documentId = null, conceptId = null, sessionId = null, evidence = {}, interpretation = {} } = {}) {
    assertOwnedCourse(courseId); assertOwnedDocument(documentId); assertOwnedConcept(conceptId);
    if (!sourceId || !['reading','annotation','note','question','review','quiz','error','session_finished'].includes(type)) throw new Error('学习事件类型或来源无效');
    if (sessionId && !getLearningSession(sessionId)) throw new Error('学习会话不存在或不属于当前用户');
    const document = documentId ? getDocument(documentId) : null;
    const concept = conceptId ? stmt('SELECT course_id FROM concepts WHERE id=? AND user_id=?').get(conceptId, currentUserId()) : null;
    const resolvedCourse = courseId || document?.course_id || concept?.course_id || null;
    if (resolvedCourse && [document?.course_id, concept?.course_id].some(value => value && value !== resolvedCourse)) throw new Error('学习事件的课程与来源不一致');
    stmt('INSERT INTO learning_events(id,user_id,course_id,document_id,concept_id,session_id,event_type,source_id,evidence_json,interpretation_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id('event'), currentUserId(), resolvedCourse, documentId, conceptId, sessionId, type, String(sourceId), json(evidence), json(interpretation), now());
    const row = stmt("SELECT * FROM learning_events WHERE user_id=? AND event_type=? AND source_id=? AND COALESCE(concept_id,'')=?").get(currentUserId(), type, String(sourceId), conceptId || '');
    if (row && ['annotation', 'note'].includes(type)) { stmt('UPDATE learning_events SET evidence_json=? WHERE id=? AND user_id=?').run(json(evidence), row.id, currentUserId()); row.evidence_json = json(evidence); }
    return row ? { ...row, evidence: parse(row.evidence_json, {}), interpretation: parse(row.interpretation_json, {}) } : null;
  }
  function listLearningEvents({ courseId, documentId, conceptId, limit = 100 } = {}) {
    const clauses = ['user_id=?']; const values = [currentUserId()];
    for (const [column, value] of [['course_id', courseId], ['document_id', documentId], ['concept_id', conceptId]]) if (value) { clauses.push(`${column}=?`); values.push(value); }
    return stmt(`SELECT * FROM learning_events WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(...values, Math.min(10000, Math.max(1, Math.floor(Number(limit) || 100)))).map(row => ({ ...row, evidence: parse(row.evidence_json, {}), interpretation: parse(row.interpretation_json, {}) }));
  }
  function getMasteryEvidence(conceptId) {
    assertOwnedConcept(conceptId);
    const errors = stmt('SELECT COUNT(*) count FROM errors WHERE user_id=? AND concept_id=? AND resolved=0').get(currentUserId(), conceptId).count;
    const events = stmt("SELECT event_type,source_id,evidence_json,created_at FROM learning_events WHERE user_id=? AND concept_id=? AND event_type IN ('question','review','quiz') ORDER BY created_at DESC,rowid DESC").all(currentUserId(), conceptId);
    const questionEvents = new Set(events.filter(event => event.event_type === 'question').map(event => event.source_id));
    const historicalQuestions = stmt('SELECT q.id FROM questions q JOIN concepts c ON c.id=? AND c.user_id=q.user_id WHERE q.user_id=? AND q.course_id IS c.course_id AND EXISTS (SELECT 1 FROM json_each(q.concepts_json) names WHERE names.value=c.name)').all(conceptId, currentUserId());
    const questionIds = new Set([...questionEvents, ...historicalQuestions.map(question => question.id)]);
    const historicalQuestionCount = historicalQuestions.filter(question => !questionEvents.has(question.id)).length;
    const legacyProgress = stmt('SELECT review_count FROM learning_progress WHERE user_id=? AND concept_id=?').get(currentUserId(), conceptId);
    const assessed = events.filter(event => ['review', 'quiz'].includes(event.event_type)).map(event => ({ ...event, evidence: parse(event.evidence_json, {}) })).filter(event => event.evidence.selfReported === true && typeof event.evidence.correct === 'boolean');
    const reviews = assessed.length, correct = assessed.filter(event => event.evidence.correct).length;
    const score = reviews ? (Math.min(correct, reviews) + 1) / (reviews + 2) : null;
    // Retained only for compatibility/scheduling. Neither the UI nor the tutor should
    // present this internal estimate as a measured percentage of knowledge mastered.
    const confidence = Math.min(0.6, reviews / (reviews + 8));
    const needsAttention = Boolean(errors) || assessed[0]?.evidence.correct === false;
    const label = needsAttention ? 'Weak' : !reviews ? 'Low Evidence' : 'Developing';
    return { score, confidence, label, learningStatus: needsAttention ? 'needs_attention' : reviews ? 'self_reported' : 'unassessed', questionCount: questionIds.size, historicalQuestionCount, unverifiedLegacyReviewCount: Math.max(0, Number(legacyProgress?.review_count || 0) - reviews), reviewCount: reviews, selfReviewCount: assessed.filter(event => event.event_type === 'review').length, quizItemCount: assessed.filter(event => event.event_type === 'quiz').length, correctCount: correct, selfReportedPositiveCount: correct, selfReportedNegativeCount: reviews - correct, unresolvedErrors: Number(errors), lastEvidenceAt: events[0]?.created_at || null, lastAssessmentAt: assessed[0]?.created_at || null, basis: 'self-reported-review', masteryAssessed: false, caveat: '仅展示可追溯学习记录；答对/记住由用户自评，未独立判题。旧提问按已保存原文核对，缺少逐条来源的历史复习汇总不用于评估。阅读、批注、提问及自评次数均不等于掌握程度。' };
  }
  function saveEmbedding(chunkId, vector, model = 'local-hash-v1') { stmt('INSERT OR REPLACE INTO embeddings(chunk_id,vector_json,model,created_at) VALUES(?,?,?,?)').run(chunkId, json(vector, []), model, now()); }
  function getEmbeddings(chunkIds = []) { if (!chunkIds.length) return []; return stmt(`SELECT * FROM embeddings WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`).all(...chunkIds).map(row => ({ chunkId: row.chunk_id, vector: parse(row.vector_json, []), model: row.model })); }
  function deleteMemory(memoryId) { return stmt('UPDATE memories SET active=0,updated_at=? WHERE id=? AND user_id=?').run(now(), memoryId, currentUserId()).changes > 0; }
  function updateMemory(memoryId, content, importance) { const result = stmt('UPDATE memories SET content=?,importance=?,updated_at=? WHERE id=? AND user_id=? AND active=1').run(String(content || ''), Number(importance ?? 0.5), now(), memoryId, currentUserId()); return result.changes > 0; }
  function touchMemories(memoryIds = []) { const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : [memoryIds]).filter(Boolean))]; if (!ids.length) return 0; let touched = 0; for (const memoryId of ids) { const row = stmt('SELECT metadata_json FROM memories WHERE id=? AND user_id=? AND active=1').get(memoryId, currentUserId()); if (!row) continue; const metadata = parse(row.metadata_json, {}); metadata.accessCount = Number(metadata.accessCount || 0) + 1; metadata.lastAccessedAt = now(); touched += stmt('UPDATE memories SET metadata_json=?,updated_at=? WHERE id=? AND user_id=? AND active=1').run(json(metadata), now(), memoryId, currentUserId()).changes; } return touched; }
  function savePromptOptimizationLog(log = {}) { const logId = log.id || id('prompt-log'); stmt(`INSERT INTO prompt_optimization_logs(id,user_id,conversation_id,course_id,document_id,original_prompt,optimized_prompt,query_type,optimization_level,mode,memory_ids_json,document_ids_json,knowledge_connections_json,config_id,optimizer_config_id,created_at,optimization_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(logId, currentUserId(), log.conversationId || null, log.courseId || null, log.documentId || null, String(log.originalPrompt || ''), String(log.optimizedPrompt || ''), log.queryType || 'other', log.optimizationLevel || 'automatic', log.mode || 'local-fallback', json(log.memoryIds || [], []), json(log.documentIds || [], []), json(log.knowledgeConnections || [], []), log.configId || null, log.optimizerConfigId || null, log.createdAt || now(), json({ plan: log.structured || {}, validation: log.validation || {} })); return getPromptOptimizationLog(logId); }
  function getPromptOptimizationLog(logId) { const row = stmt('SELECT * FROM prompt_optimization_logs WHERE id=? AND user_id=?').get(logId, currentUserId()); return row ? { ...row, optimization: parse(row.optimization_json, {}), memoryIds: parse(row.memory_ids_json, []), documentIds: parse(row.document_ids_json, []), knowledgeConnections: parse(row.knowledge_connections_json, []) } : null; }
  function listPromptOptimizationLogs({ limit = 50, courseId } = {}) { const rows = stmt(`SELECT * FROM prompt_optimization_logs WHERE user_id=? ${courseId ? 'AND course_id=?' : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Number(limit) || 50)}`).all(...(courseId ? [currentUserId(), courseId] : [currentUserId()])); return rows.map(row => ({ ...row, optimization: parse(row.optimization_json, {}), memoryIds: parse(row.memory_ids_json, []), documentIds: parse(row.document_ids_json, []), knowledgeConnections: parse(row.knowledge_connections_json, []) })); }
  function getUserProfile() { const memory = listMemories({ type: 'user-profile', limit: 1 })[0]; if (!memory) return null; const profile = parse(memory.content, memory.metadata?.profile || {}); return { ...profile, memoryId: memory.id, updatedAt: memory.updated_at || memory.updatedAt }; }
  function saveUserProfile(profile = {}) { const normalized = { answerStyle: profile.answerStyle === 'concise' ? 'concise' : 'detailed', formulaStyle: profile.formulaStyle === 'plain' ? 'plain' : 'latex', learningGoals: String(profile.learningGoals || '').trim().slice(0, 2000), programmingLanguage: String(profile.programmingLanguage || '').trim().slice(0, 120), preferredLanguage: profile.preferredLanguage === 'en' ? 'en' : 'zh' }; const memoryId = `memory-profile-${currentUserId()}`; saveMemory({ id: memoryId, type: 'user-profile', scope: 'user', content: JSON.stringify(normalized), importance: 1, metadata: { profile: normalized } }); return getUserProfile(); }
  function deleteUserProfile() { const profile = getUserProfile(); return profile ? deleteMemory(profile.memoryId) : false; }
  function exportMemory() { return { learningEvents: listLearningEvents({ limit: 10000 }), profile: getUserProfile(), memories: listMemories({ active: false, limit: 10000 }), concepts: listConcepts(), questions: listQuestions({ limit: 10000 }), errors: listErrors({ limit: 10000 }), learningSessions: listLearningSessions({ limit: 10000 }), learningNotes: listLearningNotes({ limit: 10000 }), learningExperiences: listLearningExperiences({ limit: 10000 }) }; }
  function exportUserData() {
    const documents = listDocuments().map(item => ({ ...item, readingPosition: getReadingPosition(item.id), sections: getDocumentContext(item.id), chapters: listChapters({ documentId: item.id }) }));
    const user = getUserById();
    const learningEvents = listLearningEvents({ limit: 10000 });
    const conversations = listConversations({ limit: 10000 }).map(item => ({ ...item, messages: listConversationMessages(item.id, 10000) }));
    return { exportedAt: now(), user, learningEvents, promptOptimizations: listPromptOptimizationLogs({ limit: 10000 }), settings: getUserSettings(), workspaces: listWorkspaces(), courses: listCourses(), documents, conversations, memories: listMemories({ active: false, limit: 10000 }), concepts: listConcepts(), relations: listGraph().edges, questions: listQuestions({ limit: 10000 }), errors: listErrors({ limit: 10000 }), progress: listProgress({ limit: 10000 }), notes: listNotes({ limit: 10000 }), cards: listCards({ limit: 10000 }), learningSessions: listLearningSessions({ limit: 10000 }), learningNotes: listLearningNotes({ limit: 10000 }), learningExperiences: listLearningExperiences({ limit: 10000 }) };
  }

  return { database, migrationResult, getReadingPosition, saveReadingPosition, listChapters, recordLearningEvent, listLearningEvents, getMasteryEvidence, ensureBootstrap, currentUserId, setUserId, runAsUser, defaultWorkspaceId, ensureUserSpace, createUserAccount, getUserByEmail, getUserByLoginName, getUserById, getUserAuthByEmail, getUserAuthByLoginName, getUserAuthById, updateUserAccount, updateUserPassword, getUserSettings, saveUserSettings, createSession, getSession, deleteSession, deleteUserAccount, upsertDocument, listDocuments, getDocument, deleteDocument, getDocumentContext, searchChunks, listCourses, listWorkspaces, getWorkspace, getCourse, createWorkspace, createCourse, updateDocumentOrganization, upsertConversation, saveConversationMessage, listConversations, listConversationMessages, saveMemory, listMemories, updateMemory, touchMemories, savePromptOptimizationLog, getPromptOptimizationLog, listPromptOptimizationLogs, getUserProfile, saveUserProfile, deleteUserProfile, upsertConcept, listConcepts, listKnowledgePoints, saveQuestion, listQuestions, listErrors, recordProgress, listProgress, saveQuizAttempt, listQuizAttempts, updateReviewSchedule, listReviewSchedule, clearCourseMemory, saveRelation, deleteRelation, getConceptDetails, listGraph, listCards, listCardCategories, saveCard, renameCardCategory, removeCardCategory, deleteCard, listAnnotations, saveAnnotation, updateAnnotation, deleteAnnotation, listNotes, saveNote, deleteNote, startLearningSession, getLearningSession, listLearningSessions, updateLearningSession, saveLearningNote, getLearningNote, listLearningNotes, saveLearningExperience, getLearningExperience, listLearningExperiences, saveEmbedding, getEmbeddings, deleteMemory, exportMemory, exportUserData, close: () => database.close() };
}

module.exports = { createLearningDb };
