import { spawnSync } from 'node:child_process';

const files = [
  'server.js',
  'public/app.js',
  'services/db/sqlite.js',
  'services/documents/pipeline.js',
  'services/rag/index.js',
  'services/memory/index.js',
  'services/agents/orchestrator.js',
  'services/llm/providers.js'
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`syntax ok: ${files.length} files`);
