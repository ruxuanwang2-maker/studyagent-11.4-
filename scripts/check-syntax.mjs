import { spawnSync } from 'node:child_process';

const files = [
  'server.js',
  'public/app.js',
  'services/db/sqlite.js',
  'services/documents/pipeline.js',
  'services/rag/index.js',
  'services/memory/index.js',
  'services/agents/orchestrator.js',
  'services/llm/providers.js',
  'services/llm/store.js'
  , 'services/auth/index.js',
  'scripts/check-auth.mjs',
  'scripts/check-learning-closure.mjs',
  'scripts/check-math-ocr.mjs',
  'scripts/check-math-ocr-http.mjs',
  'scripts/check-multiformat-http.mjs',
  'scripts/check-lecture-folder.mjs',
  'scripts/check-all.mjs'
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`syntax ok: ${files.length} files`);
