const migrations = [{
  version: 1,
  name: 'learning-evidence-and-chapters',
  sql: `
    CREATE TABLE IF NOT EXISTS chapters (
      id VARCHAR(255) PRIMARY KEY, user_id VARCHAR(255) NOT NULL, course_id VARCHAR(255),
      document_id VARCHAR(255) NOT NULL, section_id VARCHAR(255) NOT NULL,
      title TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL,
      locator_json TEXT NOT NULL, created_at DATETIME NOT NULL,
      UNIQUE KEY chapters_document_section (document_id, section_id),
      CONSTRAINT chapters_document_fk FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      CONSTRAINT chapters_section_fk FOREIGN KEY (section_id) REFERENCES document_sections(id) ON DELETE CASCADE
    );
    CREATE INDEX chapters_scope ON chapters(user_id, course_id, document_id, position);
    CREATE TABLE IF NOT EXISTS learning_events (
      id VARCHAR(255) PRIMARY KEY, user_id VARCHAR(255) NOT NULL, course_id VARCHAR(255),
      document_id VARCHAR(255), concept_id VARCHAR(255), session_id VARCHAR(255),
      event_type VARCHAR(40) NOT NULL,
      source_id VARCHAR(255) NOT NULL, evidence_json TEXT NOT NULL,
      interpretation_json TEXT NOT NULL, created_at DATETIME NOT NULL,
      source_key BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONCAT(user_id,CHAR(0),event_type,CHAR(0),source_id,CHAR(0),COALESCE(concept_id,'')),256))) STORED,
      CONSTRAINT learning_event_type_check CHECK(event_type IN ('reading','annotation','note','question','review','quiz','error','session_finished')),
      UNIQUE KEY learning_event_source (user_id, source_key)
    );
    CREATE INDEX learning_event_scope ON learning_events(user_id, course_id, created_at);
    CREATE INDEX messages_recent ON messages(conversation_id, created_at);
    INSERT IGNORE INTO chapters(id,user_id,course_id,document_id,section_id,title,level,position,locator_json,created_at)
      SELECT CONCAT('chapter-', s.id),d.user_id,d.course_id,d.id,s.id,s.title,
        CASE WHEN JSON_VALID(s.locator_json) THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(s.locator_json,'$.headingLevel')) AS UNSIGNED),1) ELSE 1 END,
        s.position,s.locator_json,d.created_at
      FROM document_sections s JOIN documents d ON d.id=s.document_id WHERE s.kind='heading';
  `
}, {
  version: 2,
  name: 'reading-position-import-jobs-structured-prompts',
  sql: `
    CREATE TABLE IF NOT EXISTS reading_positions (
      user_id VARCHAR(255) NOT NULL,
      document_id VARCHAR(255) NOT NULL,
      current_page INTEGER NOT NULL DEFAULT 1,
      pages_viewed_json TEXT NOT NULL, updated_at DATETIME NOT NULL,
      PRIMARY KEY(user_id,document_id),
      CONSTRAINT reading_positions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT reading_positions_document_fk FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS document_import_jobs (
      id VARCHAR(255) PRIMARY KEY, user_id VARCHAR(255) NOT NULL,
      filename TEXT NOT NULL, status VARCHAR(64) NOT NULL,
      progress_json TEXT NOT NULL DEFAULT ('{}'), document_id VARCHAR(255),
      error_json TEXT, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
      CONSTRAINT import_jobs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX import_jobs_owner ON document_import_jobs(user_id,created_at);
    INSERT IGNORE INTO reading_positions(user_id,document_id,current_page,pages_viewed_json,updated_at)
      SELECT s.user_id,s.document_id,
        COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(s.pages_viewed_json, CONCAT('$[', JSON_LENGTH(s.pages_viewed_json)-1, ']'))) AS UNSIGNED),1),
        s.pages_viewed_json,s.updated_at
      FROM learning_sessions s JOIN documents d ON d.id=s.document_id AND d.user_id=s.user_id
      WHERE JSON_VALID(s.pages_viewed_json) AND JSON_TYPE(s.pages_viewed_json)='ARRAY' AND JSON_LENGTH(s.pages_viewed_json)>0
      AND s.id=(SELECT s2.id FROM learning_sessions s2 WHERE s2.user_id=s.user_id AND s2.document_id=s.document_id ORDER BY s2.updated_at DESC,s2.id DESC LIMIT 1);
  `
}, {
  version: 3,
  name: 'structured-knowledge-cards',
  sql: `
    CREATE INDEX knowledge_cards_category ON knowledge_cards(user_id,category,updated_at);
  `
}, {
  version: 4,
  name: 'repair-invalid-annotation-timestamps',
  sql: `
    UPDATE annotations
    SET created_at=UTC_TIMESTAMP()
    WHERE CAST(created_at AS CHAR) LIKE '0000-%';
  `
}];

async function hasColumn(database, table, column) {
  const [rows] = await database.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=? LIMIT 1',
    [table, column]
  );
  return rows.length > 0;
}

async function applyMigrations(database, file) {
  await database.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name VARCHAR(255) NOT NULL,applied_at DATETIME NOT NULL)');
  const completed = new Set((await database.prepare('SELECT version FROM schema_migrations').all()).map(row => Number(row.version)));
  const pending = migrations.filter(migration => !completed.has(migration.version));
  for (const migration of pending) {
    if (migration.version === 2) {
      if (!(await hasColumn(database, 'prompt_optimization_logs', 'optimization_json'))) {
        await database.exec("ALTER TABLE prompt_optimization_logs ADD COLUMN optimization_json TEXT NOT NULL DEFAULT ('{}')");
      }
    } else if (migration.version === 3) {
      for (const [column, definition] of [
        ['category', "VARCHAR(255) NOT NULL DEFAULT '未分类'"],
        ['card_type', "VARCHAR(64) NOT NULL DEFAULT 'concept'"],
        ['content_json', "TEXT NOT NULL DEFAULT ('{}')"]
      ]) {
        if (!(await hasColumn(database, 'knowledge_cards', column))) {
          await database.exec(`ALTER TABLE knowledge_cards ADD COLUMN ${column} ${definition}`);
        }
      }
    }
    await database.exec(migration.sql);
    await database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  return { applied: pending.map(migration => migration.version), backupPath: null };
}

module.exports = { applyMigrations, migrations };
