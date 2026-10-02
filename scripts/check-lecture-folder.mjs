import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const lectureRoot = path.resolve(process.env.STUDYAGENT_LECTURE_DIR || path.join(os.homedir(), 'Desktop', '讲义'));
const supported = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'md', 'markdown', 'txt', 'xlsx', 'xls', 'csv', 'png', 'jpg', 'jpeg', 'webp']);
const runId = `studyagent-regression-${Date.now().toString(36)}`;

function extension(file) { return path.extname(file).slice(1).toLowerCase(); }
function displayName(file) { return path.relative(lectureRoot, file) || path.basename(file); }
function fail(message) { throw new Error(`lecture-folder regression failed: ${message}`); }

async function request(route, options = {}) {
  const target = new URL(route, base);
  const payload = options.body || '';
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: options.method || 'GET', headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('lecture regression request timed out after 30 minutes')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  let data = {};
  try { data = response.body ? JSON.parse(response.body) : {}; } catch { data = { raw: response.body }; }
  if (response.status < 200 || response.status >= 300) fail(`${options.method || 'GET'} ${route} -> ${response.status}: ${data?.error?.message || response.body}`);
  return data;
}

if (!fs.existsSync(lectureRoot) || !fs.statSync(lectureRoot).isDirectory()) fail(`lecture directory not found: ${lectureRoot}`);
const files = [];
for (const entry of fs.readdirSync(lectureRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const fullPath = path.join(entry.parentPath || entry.path || lectureRoot, entry.name);
  if (supported.has(extension(fullPath))) files.push(fullPath);
}
files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
if (!files.length) fail(`no supported learning files found under ${lectureRoot}`);

const created = [];
const results = [];
try {
  for (const file of files) {
    const name = path.basename(file);
    const testName = `${runId}-${name}`;
    console.log(`lecture regression: importing ${displayName(file)} (${Math.ceil(fs.statSync(file).size / 1024 / 1024)} MB)`);
    const raw = fs.readFileSync(file);
    const imported = await request('/api/documents/upload', { method: 'POST', body: JSON.stringify({ name: testName, base64: raw.toString('base64') }) });
    if (!imported.id || !Array.isArray(imported.content) || !imported.content.length || !imported.structure?.chunks) fail(`${displayName(file)} returned no structured document`);
    created.push(imported.id);

    const catalogued = await request(`/api/documents/${encodeURIComponent(imported.id)}`);
    if (catalogued.id !== imported.id || catalogued.structure?.parser !== 'structured-document-pipeline') fail(`${displayName(file)} was not persisted in the SQLite catalog`);
    const pages = await request(`/api/documents/${encodeURIComponent(imported.id)}/pages`);
    if (!Array.isArray(pages) || pages.length !== imported.content.length) fail(`${displayName(file)} page/section API is inconsistent`);
    const firstPage = await request(`/api/documents/${encodeURIComponent(imported.id)}/pages/1`);
    if (firstPage.page !== 1 || !Array.isArray(firstPage.blocks)) fail(`${displayName(file)} single-page structured API is unavailable`);

    const search = await request(`/api/learning/search?q=${encodeURIComponent(path.basename(name, path.extname(name)).split(/[\s,，._-]+/).filter(Boolean).slice(0, 2).join(' '))}&scope=current-document&documentIds=${encodeURIComponent(imported.id)}&limit=5`);
    if (search.scope !== 'current-document' || search.results.some(item => item.documentId !== imported.id)) fail(`${displayName(file)} retrieval escaped the current document`);
    const original = await fetch(`${base}/api/documents/${encodeURIComponent(imported.id)}/file`);
    if (!original.ok || (await original.arrayBuffer()).byteLength !== raw.byteLength) fail(`${displayName(file)} original file bytes were not preserved`);

    const blockTypes = [...new Set(pages.flatMap(page => (page.blocks || []).map(block => block.type)).filter(Boolean))];
    results.push({ file: displayName(file), fileType: imported.fileType || imported.type, pages: pages.length, chunks: imported.structure.chunks, formulas: pages.reduce((count, page) => count + (page.formulas || []).length, 0), blockTypes, searchResults: search.results.length });
  }
} finally {
  const cleanupIds = new Set(created);
  try {
    const current = await request('/api/documents');
    for (const document of current) if (String(document.title || '').startsWith(runId)) cleanupIds.add(document.id);
  } catch (error) { console.error(`lecture regression cleanup discovery failed: ${error.message}`); }
  for (const id of cleanupIds) {
    try { await request(`/api/learning/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (error) { console.error(error.message); }
  }
}

console.log(JSON.stringify({ ok: true, lectureRoot, files: results.length, results }, null, 2));
