const fs = require('fs');

// Append migrations; never change the contents of a released migration.
const migrations = [{
  version: 1, name: 'learning-evidence-and-chapters',
  sql: `
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_id TEXT NOT NULL REFERENCES document_sections(id) ON DELETE CASCADE,
      title TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL,
      locator_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      UNIQUE(document_id, section_id)
    );
    CREATE INDEX chapters_scope ON chapters(user_id, course_id, document_id, position);
    CREATE TABLE learning_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, course_id TEXT,
      document_id TEXT, concept_id TEXT, session_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('reading','annotation','note','question','review','quiz','error','session_finished')),
      source_id TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
      interpretation_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX learning_event_source ON learning_events(user_id, event_type, source_id, COALESCE(concept_id,''));
    CREATE INDEX learning_event_scope ON learning_events(user_id, course_id, created_at);
    CREATE INDEX messages_recent ON messages(conversation_id, created_at);
    INSERT INTO chapters(id,user_id,course_id,document_id,section_id,title,level,position,locator_json,created_at)
      SELECT 'chapter-' || s.id,d.user_id,d.course_id,d.id,s.id,s.title,
        CASE WHEN json_valid(s.locator_json) THEN COALESCE(json_extract(s.locator_json,'$.headingLevel'),1) ELSE 1 END,
        s.position,s.locator_json,d.created_at
      FROM document_sections s JOIN documents d ON d.id=s.document_id WHERE s.kind='heading';
  `
}, {
  version: 2, name: 'reading-position-import-jobs-structured-prompts',
  sql: `
    CREATE TABLE reading_positions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      current_page INTEGER NOT NULL DEFAULT 1,
      pages_viewed_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,document_id)
    );
    CREATE TABLE document_import_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, status TEXT NOT NULL,
      progress_json TEXT NOT NULL DEFAULT '{}', document_id TEXT,
      error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX import_jobs_owner ON document_import_jobs(user_id,created_at);
    ALTER TABLE prompt_optimization_logs ADD COLUMN optimization_json TEXT NOT NULL DEFAULT '{}';
    INSERT INTO reading_positions(user_id,document_id,current_page,pages_viewed_json,updated_at)
      SELECT s.user_id,s.document_id,COALESCE((SELECT value FROM json_each(s.pages_viewed_json) ORDER BY key DESC LIMIT 1),1),s.pages_viewed_json,s.updated_at
      FROM learning_sessions s JOIN documents d ON d.id=s.document_id AND d.user_id=s.user_id
      WHERE json_valid(s.pages_viewed_json) AND json_array_length(s.pages_viewed_json)>0
      AND s.rowid=(SELECT s2.rowid FROM learning_sessions s2 WHERE s2.user_id=s.user_id AND s2.document_id=s.document_id ORDER BY s2.updated_at DESC,s2.rowid DESC LIMIT 1);
  `
}, {
  version: 3, name: 'structured-knowledge-cards',
  sql: `
    ALTER TABLE knowledge_cards ADD COLUMN category TEXT NOT NULL DEFAULT '未分类';
    ALTER TABLE knowledge_cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'concept';
    ALTER TABLE knowledge_cards ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}';
    CREATE INDEX knowledge_cards_category ON knowledge_cards(user_id,category,updated_at);
  `
}];

function applyMigrations(database, file) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  const completed = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const pending = migrations.filter(migration => !completed.has(migration.version));
  let backupPath = null;
  if (pending.length && fs.existsSync(file) && database.prepare('SELECT COUNT(*) count FROM documents').get().count > 0) {
    backupPath = `${file}.before-v${pending[0].version}-${Date.now()}.bak`;
    database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }
  for (const migration of pending) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  return { applied: pending.map(migration => migration.version), backupPath };
}
module.exports = { applyMigrations, migrations };

