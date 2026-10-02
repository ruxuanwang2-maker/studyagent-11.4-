import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let seenRequest = null;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    seenRequest = { url: req.url, appId: req.headers.app_id, appKey: req.headers.app_key, body: raw ? JSON.parse(raw) : {} };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: 'a over b',
      latex_styled: '\\(\\frac{a}{b}\\)',
      latex_simplified: 'a/b',
      mathml: '<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>',
      line_data: [{ latex_styled: '\\(\\frac{a}{b}\\)' }]
    }));
  });
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const port = mock.address().port;
let configId = null;
let documentId = null;
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json();
  assert.equal(response.ok, true, `${options.method || 'GET'} ${path} failed: ${JSON.stringify(data)}`);
  return data;
}

try {
  const config = await request('/api/models/configs', { method: 'POST', body: JSON.stringify({ provider: 'mathpix', providerName: 'Mathpix test', apiType: 'mathpix', purpose: 'math-ocr', model: 'mathpix-text', appId: 'http-test-app', apiKey: 'http-test-key', baseUrl: `http://127.0.0.1:${port}/v3`, isDefault: false }) });
  configId = config.id;
  const document = await request('/api/documents/upload', { method: 'POST', body: JSON.stringify({ name: 'math-ocr-http-test.png', base64: onePixelPng }) });
  documentId = document.id;
  const result = await request(`/api/documents/${encodeURIComponent(documentId)}/math-ocr`, { method: 'POST', body: JSON.stringify({ page: 1, persist: true }) });
  assert.equal(result.provider, 'mathpix');
  assert.deepEqual(result.latexCandidates, ['\\frac{a}{b}', 'a/b']);
  assert.equal(result.persisted, true);
  const pages = await request(`/api/documents/${encodeURIComponent(documentId)}/pages`);
  const formulas = (pages[0]?.blocks || []).filter(block => block.type === 'formula');
  assert.ok(formulas.some(block => block.latex === '\\frac{a}{b}'), 'persisted formula is missing from the document page');
  assert.equal(seenRequest?.url, '/v3/text');
  assert.equal(seenRequest?.appId, 'http-test-app');
  assert.equal(seenRequest?.appKey, 'http-test-key');
  assert.ok(seenRequest?.body?.formats?.includes('latex_styled'));
  console.log('math OCR HTTP flow ok: upload -> Mathpix adapter -> persisted LaTeX/MathML page block');
} finally {
  if (documentId) await request(`/api/learning/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' }).catch(() => {});
  if (configId) await request(`/api/models/configs/${encodeURIComponent(configId)}`, { method: 'DELETE' }).catch(() => {});
  await new Promise(resolve => mock.close(resolve));
}
