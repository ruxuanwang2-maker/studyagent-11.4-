import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const account = {
  email: `vision-region-${suffix}@example.com`,
  username: 'Vision Region Regression',
  password: 'StudyAgent-Vision-2026!',
};
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4V5sAAAAASUVORK5CYII=';

async function request(path, options = {}, cookie = '') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
}

const requests = [];
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, payload });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: `mock-${suffix}`,
    model: 'mock-vision',
    choices: [{ message: { role: 'assistant', content: '识别公式：\\(x^2+y^2=z^2\\)。这是勾股定理。' } }],
    usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
  }));
});

await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', resolve);
});
const mockPort = mock.address().port;
let cookie = '';

try {
  const registered = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(account) });
  assert.equal(registered.response.status, 201, `registration failed: ${JSON.stringify(registered.data)}`);
  cookie = registered.cookie;
  assert.ok(cookie, 'session cookie missing');

  const invalid = await request('/api/chat/vision', { method: 'POST', body: JSON.stringify({ imageData: 'not-an-image' }) }, cookie);
  assert.equal(invalid.response.status, 400, 'invalid image should be rejected');
  assert.equal(invalid.data.error?.code, 'IMAGE_REQUIRED');

  const documentResponse = await request('/api/documents/upload', {
    method: 'POST',
    body: JSON.stringify({ name: `Vision formula ${suffix}.md`, content: '# Pythagorean theorem\n\nFor a right triangle, $x^2+y^2=z^2$.' }),
  }, cookie);
  assert.equal(documentResponse.response.status, 201, `document import failed: ${JSON.stringify(documentResponse.data)}`);
  const document = documentResponse.data;

  const configResponse = await request('/api/models/configs', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      apiType: 'openai-compatible',
      model: 'mock-vision',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'test-key',
      isDefault: true,
      purpose: 'answer',
    }),
  }, cookie);
  assert.equal(configResponse.response.status, 200, `model config failed: ${JSON.stringify(configResponse.data)}`);

  const vision = await request('/api/chat/vision', {
    method: 'POST',
    body: JSON.stringify({
      imageData,
      message: '请识别区域中的公式并解释。',
      documentId: document.id,
      page: 1,
      scope: 'current-page',
      configId: configResponse.data.id,
      remember: true,
      language: 'zh',
    }),
  }, cookie);
  assert.equal(vision.response.status, 200, `vision request failed: ${JSON.stringify(vision.data)}`);
  assert.equal(vision.data.mode, 'remote-vision');
  assert.equal(vision.data.provider, 'custom');
  assert.equal(vision.data.model, 'mock-vision');
  assert.match(vision.data.answer, /x\^2\+y\^2=z\^2/);
  assert.ok(vision.data.conversationId, 'conversation was not persisted');

  assert.equal(requests.length, 1, 'vision provider should be called exactly once');
  assert.equal(requests[0].url, '/v1/chat/completions');
  const content = requests[0].payload.messages?.[0]?.content;
  assert.ok(Array.isArray(content), 'vision message should use multimodal content');
  assert.equal(content.find(item => item.type === 'image_url')?.image_url?.url, imageData, 'captured image was not sent to the provider');
  assert.match(content.find(item => item.type === 'text')?.text || '', /准确识别图片中的文字、数学公式/);

  const history = await request(`/api/conversations/${encodeURIComponent(vision.data.conversationId)}/messages`, {}, cookie);
  assert.equal(history.response.status, 200);
  assert.ok(history.data.messages.some(item => item.role === 'user' && /框选区域截图/.test(String(item.metadata?.selectedText || ''))), 'region evidence missing from saved user turn');
  assert.ok(history.data.messages.some(item => item.role === 'assistant' && /勾股定理/.test(String(item.content || item.text || ''))), 'vision answer missing from saved conversation');

  console.log('vision region ok: image payload, remote provider, document context and persisted conversation');
} finally {
  if (cookie) await request('/api/account', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE' }) }, cookie).catch(() => {});
  await new Promise(resolve => mock.close(resolve));
}
