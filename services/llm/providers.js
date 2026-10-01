const { getProvider, fallbackModels } = require('../../config/modelProviders');

function trimBaseUrl(value) { return String(value || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, ''); }
function safeMessage(error, fallback = '模型请求失败') { return error?.code ? `${error.code} ${error.message}` : (error?.message || fallback); }
function makeError(code, message, status = 502) { const error = new Error(message); error.code = code; error.status = status; return error; }
async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 45000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
    throw makeError('NETWORK_ERROR', error.message || '无法连接模型服务', 502);
  } finally { clearTimeout(timer); }
}
function headers(config, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...(config.headers || {}), ...extra };
  if (config.apiType === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (config.apiType !== 'gemini') headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}
function openAiMessages(messages) { return (messages || []).map(message => ({ role: message.role, content: message.content })); }
function parseOpenAi(data) { return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || ''; }
function parseAnthropic(data) { return (data?.content || []).filter(item => item.type === 'text').map(item => item.text).join(''); }

function createProvider(config) {
  const preset = getProvider(config.provider);
  const apiType = config.apiType || preset.apiType;
  const baseUrl = trimBaseUrl(config.baseUrl || preset.baseUrl);
  if (!baseUrl) throw makeError('INVALID_CONFIG', 'Base URL 不能为空', 400);
  async function chat(request) {
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
      const response = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify(body), signal: controller.signal });
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
    } catch (error) { if (error.name === 'AbortError') throw makeError('TIMEOUT', `请求超过 ${config.timeout || 45000} ms 未完成`, 504); if (error.code) throw error; throw makeError('NETWORK_ERROR', error.message, 502); }
    finally { clearTimeout(timer); }
  }
  async function listModels() {
    if (apiType === 'anthropic') return fallbackModels(config.provider);
    if (apiType === 'gemini') {
      const result = await requestJson(`${baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`, { headers: headers({ ...config, apiType }) }, config.timeout);
      return (result.data?.models || []).map(model => ({ id: String(model.name || '').replace(/^models\//, ''), label: model.displayName || model.name, supportsStreaming: true }));
    }
    const result = await requestJson(`${baseUrl}/models`, { headers: headers({ ...config, apiType }) }, config.timeout);
    return (result.data?.data || []).map(model => ({ id: model.id, label: model.id, supportsStreaming: true }));
  }
  async function embed(request = {}) { if (apiType !== 'openai-compatible') throw makeError('EMBEDDING_UNSUPPORTED', '当前服务商暂未提供统一 Embedding 适配器', 501); const input = Array.isArray(request.input) ? request.input : [String(request.input || '')]; const model = request.model || config.embeddingModel || config.model; const result = await requestJson(`${baseUrl}/embeddings`, { method: 'POST', headers: headers({ ...config, apiType }), body: JSON.stringify({ model, input }) }, config.timeout); return { model, provider: config.provider, embeddings: (result.data?.data || []).map(item => item.embedding || []) , raw: result.data }; }
  async function vision(request = {}) { if (apiType !== 'openai-compatible') throw makeError('VISION_UNSUPPORTED', '当前服务商暂未提供统一 Vision 适配器', 501); const image = request.imageData || request.imageUrl; if (!image) throw makeError('IMAGE_REQUIRED', 'Vision 请求需要 imageData 或 imageUrl', 400); const result = await chat({ model: request.model || config.model, temperature: request.temperature, maxTokens: request.maxTokens, messages: [{ role: 'user', content: [{ type: 'text', text: String(request.prompt || '请描述这张图片，并识别其中的文字、表格和数学公式。') }, { type: 'image_url', image_url: { url: image } }] }] }); return { ...result, vision: true }; }
  async function testConnection() { const started = Date.now(); const result = await chat({ model: config.model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], maxTokens: 8, temperature: 0 }); return { ok: Boolean(result.text), latencyMs: Date.now() - started, model: result.model, provider: result.provider, preview: String(result.text || '').slice(0, 80), streamingSupported: apiType === 'openai-compatible' || apiType === 'anthropic' }; }
  return { listModels, chat, streamChat, embed, vision, testConnection, provider: config.provider, baseUrl };
}

module.exports = { createProvider, safeMessage };
