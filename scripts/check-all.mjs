import { spawn } from 'node:child_process';

const root = process.cwd();
const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const checks = [
  ['syntax', 'scripts/check-syntax.mjs'],
  ['math-ocr', 'scripts/check-math-ocr.mjs'],
  ['math-ocr-http', 'scripts/check-math-ocr-http.mjs'],
  ['core', 'scripts/check-learning-core.mjs'],
  ['auth', 'scripts/check-auth.mjs'],
  ['multiformat-http', 'scripts/check-multiformat-http.mjs'],
  ['learning-http', 'scripts/check-learning-http.mjs'],
  ['learning-closure', 'scripts/check-learning-closure.mjs'],
  ['pdf-regression', 'scripts/check-pdf-regression.mjs'],
  ['lecture-folder', 'scripts/check-lecture-folder.mjs']
];

async function isReady() {
  try { return (await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

function run(label, script) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, [script], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`)));
  });
}

let server = null;
async function waitForServer() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isReady()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`StudyAgent server did not become ready at ${base}`);
}

try {
  if (!(await isReady())) {
    const port = new URL(base).port || '4173';
    server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, STUDYAGENT_PORT: port }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    await waitForServer();
  }
  for (const [label, script] of checks) await run(label, script);
  console.log(`\nALL CHECKS PASSED (${checks.length})`);
} catch (error) {
  console.error(`\nREGRESSION FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) server.kill();
}
