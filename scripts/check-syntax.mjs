import { spawnSync } from 'node:child_process';

const files = [
  'server.js',
  'services/http/requestQueue.js',
  'services/documents/parser.js',
  'services/documents/importWorker.js',
  'services/documents/importJobs.js',
  'services/agents/promptPlan.js',
  'scripts/check-prompt-plan.mjs',
  'scripts/check-learning-evidence.mjs',
  'scripts/check-reading-import-http.mjs',
  'scripts/check-request-queue.mjs',
  'public/app.js',
  'public/learning-history.js',
  'public/import-status.js',
  'services/db/sqlite.js',
  'services/db/migrations.js',
  'scripts/check-pdf-regression.mjs',
  'services/documents/pipeline.js',
  'services/rag/index.js',
  'services/rag/tokenize.js',
  'services/agents/promptOptimizer.js',
  'scripts/check-upgrade.mjs',
  'scripts/check-upgrade-http.mjs',
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
