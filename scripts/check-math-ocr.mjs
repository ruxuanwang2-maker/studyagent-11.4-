import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const providersResponse = await fetch(`${base}/api/models/providers`);
assert.equal(providersResponse.ok, true, 'model provider registry is unavailable');
const providers = await providersResponse.json();
assert.ok((providers.providers || []).some(item => item.id === 'mathpix'), 'Mathpix provider is missing from the registry');

const require = createRequire(import.meta.url);
const { createProvider } = require('../services/llm/providers.js');
const originalFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, options = {}) => {
  captured = { url: String(url), options };
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({
      text: 'x squared plus y squared',
      latex_styled: '\\(x^2 + y^2\\)',
      latex_simplified: 'x^2+y^2',
      mathml: '<math><msup><mi>x</mi><mn>2</mn></msup></math>',
      line_data: [{ latex_styled: '\\(x^2 + y^2\\)' }]
    })
  };
};

try {
  const result = await createProvider({
    provider: 'mathpix',
    apiType: 'mathpix',
    baseUrl: 'https://mathpix.test/v3',
    appId: 'test-app-id',
    apiKey: 'test-app-key',
    model: 'mathpix-text'
  }).mathOcr({ imageData: 'data:image/png;base64,AAAA' });
  assert.equal(captured.url, 'https://mathpix.test/v3/text');
  const headers = captured.options.headers || {};
  assert.equal(headers.app_id, 'test-app-id');
  assert.equal(headers.app_key, 'test-app-key');
  const payload = JSON.parse(captured.options.body);
  assert.equal(payload.src, 'data:image/png;base64,AAAA');
  assert.ok(payload.formats.includes('latex_styled'));
  assert.ok(payload.include_line_data);
  assert.deepEqual(result.latexCandidates, ['x^2 + y^2', 'x^2+y^2']);
  assert.equal(result.mathml.includes('<math>'), true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('math OCR adapter ok: registry, Mathpix request contract, LaTeX candidates and MathML');

let ollamaRequest = null;
globalThis.fetch = async (url, options = {}) => {
  ollamaRequest = { url: String(url), options };
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ choices: [{ message: { content: '本地模型响应' } }] }) };
};
try {
  const result = await createProvider({ provider: 'ollama', apiType: 'openai-compatible', baseUrl: 'http://ollama.test/v1', model: 'llama3.2' }).chat({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.text, '本地模型响应');
  assert.equal(ollamaRequest.url, 'http://ollama.test/v1/chat/completions');
  assert.equal(Object.hasOwn(ollamaRequest.options.headers, 'Authorization'), false, 'Ollama should not require an API key');
  assert.equal(ollamaRequest.options.headers['User-Agent'], 'StudyAgent/0.1');
  assert.equal(ollamaRequest.options.headers['Content-Length'], String(Buffer.byteLength(ollamaRequest.options.body)));
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Ollama adapter ok: local OpenAI-compatible calls work without an API key');
