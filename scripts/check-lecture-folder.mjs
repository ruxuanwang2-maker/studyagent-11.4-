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
    const req = http.request({ hostname: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`, method: options.method || 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? {Cookie:cookie}:{}), ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
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

async function waitForImport(jobId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await request(`/api/imports/${encodeURIComponent(jobId)}`);
    if (job.status === 'completed') {
      if (!job.documentId) fail(`completed import ${jobId} has no document id`);
      return request(`/api/documents/${encodeURIComponent(job.documentId)}`);
    }
    if (job.status === 'failed') fail(`${job.filename || jobId} import failed: ${job.error?.message || job.error?.code || 'unknown error'}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`import ${jobId} did not complete within 30 minutes`);
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
// The largest lecture is intentionally excluded from routine regression. It
// remains a valid user document, but repeatedly OCR-processing it makes the
// fast regression disproportionately slow and was explicitly excluded by the
// project owner. Set STUDYAGENT_INCLUDE_LARGEST_LECTURE=1 for a stress run.
if (files.length > 1 && process.env.STUDYAGENT_INCLUDE_LARGEST_LECTURE !== '1') {
  const largest = files.reduce((current, file) => fs.statSync(file).size > fs.statSync(current).size ? file : current, files[0]);
  files.splice(files.indexOf(largest), 1);
  console.log(`lecture regression: excluded largest file ${displayName(largest)} (${Math.ceil(fs.statSync(largest).size / 1024 / 1024)} MB)`);
}

const created = [];
const results = [];
let cookie = '';
let probeDocumentId = '';
const responsiveness = [];
async function probe() {
  const start = performance.now();
  const response = await fetch(`${base}/api/documents/${probeDocumentId}/reading-position`, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type':'application/json' }, body: JSON.stringify({ currentPage: 2 }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Reading progress probe HTTP ${response.status}`);
  await response.json();
  return Math.round(performance.now() - start);
}
try {
  const registered = await fetch(`${base}/api/auth/register`, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`lectures-${runId}@example.com`,username:'Regression Student Lectures',password:'Lecture-Regression-2026!'}) });
  if (!registered.ok) fail('could not register lecture regression account');
  cookie = registered.headers.get('set-cookie')?.split(';')[0] || '';
  if (!cookie) fail('missing lecture regression session');
  const probeUpload = await fetch(`${base}/api/documents/upload`, { method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({name:`${runId}-reader.md`,content:'# Page 1\n\nReading.\n\n# Page 2\n\nPersist progress.'}) });
  probeDocumentId = (await probeUpload.json()).id;
  if (!probeDocumentId) fail('could not import reading progress probe');
  for (const file of files) {
    const name = path.basename(file);
    const testName = `${runId}-${name}`;
    console.log(`lecture regression: importing ${displayName(file)} (${Math.ceil(fs.statSync(file).size / 1024 / 1024)} MB)`);
    const raw = fs.readFileSync(file);
    const measurements = [], errors = [];
    let runningProbe = null;
    const timer = setInterval(() => { if (!runningProbe) runningProbe = probe().then(ms=>measurements.push(ms)).catch(error=>errors.push(error.message)).finally(()=>{runningProbe=null}); },700);
    let imported;
    try {
      // Exercise the same isolated background-import path used by the UI. A
      // synchronous response serializes the whole parsed lecture and can make
      // a rapid all-files regression consume far more memory than real usage.
      const accepted = await request('/api/documents/upload', { method: 'POST', body: JSON.stringify({ name: testName, base64: raw.toString('base64'), async: true }) });
      const jobId = accepted.jobs?.[0]?.id;
      if (!jobId) fail(`${displayName(file)} did not create a background import job`);
      imported = await waitForImport(jobId);
    }
    finally { clearInterval(timer); if(runningProbe)await runningProbe; }
    const metrics={file:displayName(file),samples:measurements.length,maxMs:Math.max(0,...measurements),errors};
    responsiveness.push(metrics);
    console.log('reading-during-import:',JSON.stringify(metrics));
    if(errors.length)fail(`${displayName(file)} blocked reading progress while importing: ${errors.join('; ')}`);
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
    const original = await fetch(`${base}/api/documents/${encodeURIComponent(imported.id)}/file`,{headers:{Cookie:cookie}});
    if (!original.ok || !Buffer.from(await original.arrayBuffer()).equals(raw)) fail(`${displayName(file)} original file bytes were not preserved`);

    const blockTypes = [...new Set(pages.flatMap(page => (page.blocks || []).map(block => block.type)).filter(Boolean))];
    results.push({ file: displayName(file), fileType: imported.fileType || imported.type, pages: pages.length, chunks: imported.structure.chunks, formulas: pages.reduce((count, page) => count + (page.formulas || []).length, 0), blockTypes, searchResults: search.results.length });
    // Each test copy is disposable. Removing it immediately prevents a
    // nine-file regression from accumulating duplicate parsed textbooks while
    // retaining the compact result summary above.
    await request(`/api/learning/documents/${encodeURIComponent(imported.id)}`, { method: 'DELETE' });
    const createdIndex = created.indexOf(imported.id);
    if (createdIndex >= 0) created.splice(createdIndex, 1);
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
  if(probeDocumentId)await fetch(`${base}/api/learning/documents/${probeDocumentId}`,{method:'DELETE',headers:{Cookie:cookie}});
  if(cookie)await fetch(`${base}/api/account`,{method:'DELETE',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({confirmation:'DELETE'})});
}

console.log(JSON.stringify({ ok: true, lectureRoot, files: results.length, results, responsiveness }, null, 2));
