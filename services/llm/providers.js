const { getProvider, fallbackModels } = require('../../config/modelProviders');
const https = require('node:https');
const net = require('node:net');
const { Readable } = require('node:stream');
const { assertPublicHttpsEndpoint } = require('./publicEndpoint');

function trimBaseUrl(value) { return String(value || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, ''); }
function safeMessage(error, fallback = '模型请求失败') { return error?.code ? `${error.code} ${error.message}` : (error?.message || fallback); }
function makeError(code, message, status = 502) { const error = new Error(message); error.code = code; error.status = status; return error; }
function requestHeaders(options = {}) {
  const result = { Accept: 'application/json', 'User-Agent': 'StudyAgent/0.1', ...(options.headers || {}) };
  if (typeof options.body === 'string' && !result['Content-Length']) result['Content-Length'] = String(Buffer.byteLength(options.body));
  return result;
}
async function requestJson(url, options, timeoutMs) {
  let pinnedAddresses = options.pinnedAddresses;
  if (!pinnedAddresses && process.env.NODE_ENV === 'production') {
    ({ addresses: pinnedAddresses } = await assertPublicHttpsEndpoint(url));
  }
  if (pinnedAddresses?.length) return requestPinnedJson(url, options, timeoutMs, pinnedAddresses);
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 45000));
    try {
      const response = await fetch(url, { ...options, headers: requestHeaders(options), signal: controller.signal });
      const raw = await response.text(); let data = null;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
      if (!response.ok) {
        const code = response.status === 401 ? '401' : response.status === 404 ? '404' : response.status === 429 ? '429' : `HTTP_${response.status}`;
        throw makeError(code, data?.error?.message || data?.message || raw.slice(0, 240) || response.statusText, response.status);
      }
      return { response, data };
    } catch (error) {
      if (error.name === 'AbortError') throw makeError('TIMEOUT', `请求超过 ${timeoutMs || 45000} ms 未完成`, 504);
      if (error.code) throw error;
      if (attempt < attempts - 1) { await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1))); continue; }
      const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
      throw makeError('NETWORK_ERROR', `${error.message || '无法连接模型服务'}${cause}`, 502);
    } finally { clearTimeout(timer); }
  }
}
function requestPinnedJson(value, options, timeoutMs, addresses) {
  const url = new URL(value);
  const requestOptions = { method: options.method || 'GET', headers: requestHeaders(options), lookup: (_hostname, lookupOptions, callback) => {
    if (lookupOptions?.all) callback(null, addresses.map(address => ({ address, family: net.isIP(address) })));
    else callback(null, addresses[0], net.isIP(addresses[0]));
  } };
  const body = options.body;
  const timeout = Math.max(1000, Number(timeoutMs) || 45000);
  return new Promise((resolve, reject) => {
    const request = https.request(url, requestOptions, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const status = response.statusCode || 502;
          const code = status === 401 ? '401' : status === 404 ? '404' : status === 429 ? '429' : `HTTP_${status}`;
          return reject(makeError(code, data?.error?.message || data?.message || raw.slice(0, 240) || response.statusMessage, status));
        }
        resolve({ response, data });
      });
    });
    request.setTimeout(timeout, () => request.destroy(makeError('TIMEOUT', `请求超过 ${timeoutMs || 45000} ms 未完成`, 504)));
    request.on('error', error => reject(error.code ? error : makeError('NETWORK_ERROR', error.message, 502)));
    if (body) request.write(body);
    request.end();
  });
}
async function requestPinnedStream(value, options, timeoutMs) {
  const { addresses } = await assertPublicHttpsEndpoint(value);
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(value), {
      method: options.method || 'GET',
      headers: requestHeaders(options),
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, addresses.map(address => ({ address, family: net.isIP(address) })));
        else callback(null, addresses[0], net.isIP(addresses[0]));
      }
    }, response => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve({ ok: true, status: response.statusCode, statusText: response.statusMessage, body: Readable.toWeb(response) });
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        const status = response.statusCode || 502;
        const code = status === 401 ? '401' : status === 429 ? '429' : `HTTP_${status}`;
        reject(makeError(code, data?.error?.message || data?.message || raw.slice(0, 240) || response.statusMessage, status));
      });
    });
    const timeout = Math.max(1000, Number(timeoutMs) || 45000);
    request.setTimeout(timeout, () => request.destroy(makeError('TIMEOUT', `请求超过 ${timeoutMs || 45000} ms 未完成`, 504)));
    const abort = () => request.destroy(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => options.signal?.removeEventListener('abort', abort));
    request.on('error', error => reject(error.code ? error : makeError('NETWORK_ERROR', error.message, 502)));
    if (options.body) request.write(options.body);
    request.end();
  });
}
function headers(config, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...(config.headers || {}), ...extra };
  if (config.apiType === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (config.apiType !== 'gemini' && config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}
function openAiMessages(messages) { return (messages || []).map(message => ({ role: message.role, content: message.content })); }
function parseOpenAi(data) { return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || ''; }
function parseAnthropic(data) { return (data?.content || []).filter(item => item.type === 'text').map(item => item.text).join(''); }
function mathpixSource(imageData, imageUrl) {
  const source = String(imageData || imageUrl || '').trim();
  if (!source) throw makeError('IMAGE_REQUIRED', '数学 OCR 需要 imageData 或 imageUrl', 400);
  return source.startsWith('data:') || /^https?:\/\//i.test(source) ? source : `data:image/png;base64,${source}`;
}
function normalizeMathpixLatex(value) {
  let result = String(value || '').trim();
  if (result.startsWith('$$') && result.endsWith('$$')) result = result.slice(2, -2).trim();
  else if (result.startsWith('\\[') && result.endsWith('\\]')) result = result.slice(2, -2).trim();
  else if (result.startsWith('\\(') && result.endsWith('\\)')) result = result.slice(2, -2).trim();
  else if (result.startsWith('$') && result.endsWith('$') && !result.startsWith('$$')) result = result.slice(1, -1).trim();
  return result;
}
function mathpixLatexCandidates(data = {}) {
  const candidates = [];
  for (const key of ['latex_styled', 'latex_simplified']) {
    const value = normalizeMathpixLatex(data[key]);
    if (value) candidates.push(value);
  }
  for (const line of Array.isArray(data.line_data) ? data.line_data : []) {
    const value = normalizeMathpixLatex(line.latex_styled || line.latex_simplified);
    if (value) candidates.push(value);
  }
  return [...new Set(candidates)].slice(0, 32);
}

function createProvider(config) {
  const preset = getProvider(config.provider);
  const apiType = config.apiType || preset.apiType;
  const baseUrl = trimBaseUrl(config.baseUrl || preset.baseUrl);
  if (!baseUrl) throw makeError('INVALID_CONFIG', 'Base URL 不能为空', 400);
  async function chat(request) {
    if (apiType === 'mathpix') throw makeError('MATH_OCR_CHAT_UNSUPPORTED', 'Mathpix 配置只用于数学 OCR，不能用于对话回答', 400);
    const model = request.model || config.model;
    const messages = request.messages || [];
    const temperature = Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : Number(config.temperature ?? 0.2);
    const maxTokens = Number(request.maxTokens || config.maxTokens || 1200);
    if (apiType === 'anthropic') {
      const system = messages.find(message => message.role === 'system')?.content;
      const body = { model, max_tokens: maxTokens, temperature, messages: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, content: message.content })) };
      if (system) body.system = system;
      const result = await requestJson(`${baseUrl}/messages`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify(body) }, config.timeout);
      return { text: parseAnthropic(result.data), raw: result.data, model, provider: config.provider };
    }
    if (apiType === 'gemini') {
      const contents = messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
      const system = messages.find(message => message.role === 'system')?.content;
      const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const result = await requestJson(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify(body) }, config.timeout);
      return { text: result.data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '', raw: result.data, model, provider: config.provider };
    }
    const body = { model, messages: openAiMessages(messages), temperature, max_tokens: maxTokens, stream: false };
    if (config.organizationId) body.organization = config.organizationId;
    const result = await requestJson(`${baseUrl}/chat/completions`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify(body) }, config.timeout);
    return { text: parseOpenAi(result.data), raw: result.data, model, provider: config.provider };
  }
  async function streamChat(request, onToken) {
    if (apiType !== 'openai-compatible') { const result = await chat(request); onToken(result.text); return result; }
    const body = { model: request.model || config.model, messages: openAiMessages(request.messages), temperature: Number(request.temperature ?? config.temperature ?? 0.2), max_tokens: Number(request.maxTokens || config.maxTokens || 1200), stream: true };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(config.timeout) || 45000));
    try {
      const requestBody = JSON.stringify(body);
      const streamUrl = `${baseUrl}/chat/completions`;
      const streamOptions = { method: 'POST', headers: headers({ ...config, apiType }), body: requestBody, signal: controller.signal };
      const response = process.env.NODE_ENV === 'production'
        ? await requestPinnedStream(streamUrl, streamOptions, config.timeout)
        : await fetch(streamUrl, { ...streamOptions, headers: requestHeaders(streamOptions) });
      if (!response.ok) { const raw = await response.text(); throw makeError(response.status === 401 ? '401' : response.status === 429 ? '429' : `HTTP_${response.status}`, raw.slice(0, 240) || response.statusText, response.status); }
      let full = ''; const reader = response.body?.getReader();
      if (!reader) { const result = await response.json(); full = parseOpenAi(result); onToken(full); return { text: full, model: body.model, provider: config.provider }; }
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split(/\r?\n/).slice(0, -1)) {
          if (!line.startsWith('data:')) continue; const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
          try { const token = JSON.parse(payload)?.choices?.[0]?.delta?.content || ''; if (token) { full += token; onToken(token); } } catch { /* wait for provider's next complete SSE line */ }
        }
        buffer = buffer.split(/\r?\n/).slice(-1)[0] || '';
      }
      return { text: full, model: body.model, provider: config.provider };
    } catch (error) { if (error.name === 'AbortError') throw makeError('TIMEOUT', `请求超过 ${config.timeout || 45000} ms 未完成`, 504); if (error.code) throw error; const cause = error?.cause?.code ? ` (${error.cause.code})` : ''; throw makeError('NETWORK_ERROR', `${error.message || '无法连接模型服务'}${cause}`, 502); }
    finally { clearTimeout(timer); }
  }
  async function listModels(endpoint = {}) {
    if (apiType === 'anthropic') return fallbackModels(config.provider);
    if (apiType === 'gemini') {
      const result = await requestJson(`${baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`, { headers: headers({ ...config, apiType }), redirect: 'error', pinnedAddresses: endpoint.addresses }, config.timeout);
      return (result.data?.models || []).map(model => ({ id: String(model.name || '').replace(/^models\//, ''), label: model.displayName || model.name, supportsStreaming: true }));
    }
    const result = await requestJson(`${baseUrl}/models`, { headers: headers({ ...config, apiType }), redirect: 'error', pinnedAddresses: endpoint.addresses }, config.timeout);
    return (result.data?.data || []).map(model => ({ id: model.id, label: model.id, supportsStreaming: true }));
  }
  async function embed(request = {}) { if (apiType !== 'openai-compatible') throw makeError('EMBEDDING_UNSUPPORTED', '当前服务商暂未提供统一 Embedding 适配器', 501); const input = Array.isArray(request.input) ? request.input : [String(request.input || '')]; const model = request.model || config.embeddingModel || config.model; const result = await requestJson(`${baseUrl}/embeddings`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify({ model, input }) }, config.timeout); return { model, provider: config.provider, embeddings: (result.data?.data || []).map(item => item.embedding || []) , raw: result.data }; }
  async function vision(request = {}) { if (apiType !== 'openai-compatible') throw makeError('VISION_UNSUPPORTED', '当前服务商暂未提供统一 Vision 适配器', 501); const image = request.imageData || request.imageUrl; if (!image) throw makeError('IMAGE_REQUIRED', 'Vision 请求需要 imageData 或 imageUrl', 400); const result = await chat({ model: request.model || config.model, temperature: request.temperature, maxTokens: request.maxTokens, messages: [{ role: 'user', content: [{ type: 'text', text: String(request.prompt || '请描述这张图片，并识别其中的文字、表格和数学公式。') }, { type: 'image_url', image_url: { url: image } }] }] }); return { ...result, vision: true }; }
  async function mathOcr(request = {}) {
    if (apiType !== 'mathpix') throw makeError('MATH_OCR_UNSUPPORTED', '当前配置不是 Mathpix 数学 OCR 配置', 501);
    if (!config.apiKey) throw makeError('API_KEY_REQUIRED', 'Mathpix App Key 未配置', 400);
    const appId = config.appId || config.organizationId;
    if (!appId) throw makeError('APP_ID_REQUIRED', 'Mathpix App ID 未配置', 400);
    const payload = { src: mathpixSource(request.imageData, request.imageUrl), formats: ['text', 'latex_styled', 'latex_simplified', 'mathml'], include_diagram_text: true };
    if (request.includeLineData !== false) payload.include_line_data = true;
    const result = await requestJson(`${baseUrl}/text`, { method: 'POST', headers: { 'Content-Type': 'application/json', app_id: appId, app_key: config.apiKey, ...(config.headers || {}) }, body: JSON.stringify(payload) }, config.timeout);
    return { provider: config.provider, model: config.model || 'mathpix-text', text: result.data?.text || '', latex: normalizeMathpixLatex(result.data?.latex_styled || result.data?.latex_simplified), latexCandidates: mathpixLatexCandidates(result.data), mathml: result.data?.mathml || '', raw: result.data };
  }
  async function testConnection() { const started = Date.now(); const result = await chat({ model: config.model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], maxTokens: 8, temperature: 0 }); return { ok: Boolean(result.text), latencyMs: Date.now() - started, model: result.model, provider: result.provider, preview: String(result.text || '').slice(0, 80), streamingSupported: apiType === 'openai-compatible' || apiType === 'anthropic' }; }
  return { listModels, chat, streamChat, embed, vision, mathOcr, testConnection, provider: config.provider, baseUrl };
}

module.exports = { createProvider, safeMessage };
