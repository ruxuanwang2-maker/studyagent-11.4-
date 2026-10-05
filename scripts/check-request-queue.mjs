import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRequestQueue, readJsonBody } = require('../services/http/requestQueue');

let releaseHold;
let enterHold;
let enterBody;
const holdEntered = new Promise(resolve => { enterHold = resolve; });
const bodyEntered = new Promise(resolve => { enterBody = resolve; });
const hold = new Promise(resolve => { releaseHold = resolve; });
const processed = [];
const run = createRequestQueue(async (req, res, url) => {
  if (url === '/hold') { enterHold(); await hold; }
  let payload = {};
  if (req.method === 'POST') { enterBody(); payload = await readJsonBody(req, { maxBytes: 1024 }); }
  processed.push(url);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}, { maxBytes: 1024, bodyTimeoutMs: 150 });
const server = http.createServer((req, res) => {
  run(req, res, req.url).catch(error => {
    if (res.destroyed) return;
    res.statusCode = error.status || 400;
    res.end(JSON.stringify({ code: error.code }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (url, options = {}) => fetch(`${base}${url}`, { ...options, signal: AbortSignal.timeout(2500) });
function incomplete(url) {
  const req = http.request(`${base}${url}`, { method: 'POST', headers: { 'Content-Length': '100', 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.flushHeaders();
  req.write('{');
  return req;
}
try {
  const active = incomplete('/aborted-active');
  await bodyEntered;
  active.destroy();
  assert.equal((await request('/after-active-abort')).status, 200);

  const held = request('/hold');
  await holdEntered;
  const abandoned = incomplete('/aborted-queued');
  await once(abandoned, 'socket');
  abandoned.destroy();
  const valid = request('/queued-valid', { method: 'POST', body: JSON.stringify({ text: '中文公式 Ax=b' }) });
  releaseHold();
  await held;
  assert.deepEqual(await (await valid).json(), { text: '中文公式 Ax=b' });
  assert.ok(!processed.includes('/aborted-queued'), 'abandoned request must not run');

  const stalled = incomplete('/stalled-upload');
  const stallResult = await once(stalled, 'response');
  assert.equal(stallResult[0].statusCode, 408);
  stalled.destroy();
  assert.equal((await request('/after-body-timeout')).status, 200);

  const invalid = await request('/invalid-json', { method: 'POST', body: '{broken' });
  assert.equal((await invalid.json()).code, 'INVALID_JSON');
  const oversized = await request('/oversized', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(1500) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await request('/after-errors')).status, 200);
  console.log('PASS: active abort, queued abort, queued JSON integrity, upload timeout, invalid JSON, body limit, queue recovery');
} finally {
  releaseHold();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
