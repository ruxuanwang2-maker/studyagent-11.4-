// Read incoming bodies immediately, even while an earlier API request is busy.
// A disconnected or incomplete upload must never hold the serial API queue.
const bodies = new WeakMap();

function readJsonBody(req, { maxBytes, timeoutMs = 30000 } = {}) {
  if (bodies.has(req)) return bodies.get(req);
  const result = new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (code, message, status = 400) => finish(Object.assign(new Error(message), { code, status }));
    const timer = setTimeout(() => fail('REQUEST_BODY_TIMEOUT', '请求内容接收超时，请重试。', 408), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onError);
      req.off('close', onClose);
      if (error) { reject(error); req.resume(); } else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) return fail('PAYLOAD_TOO_LARGE', `payload too large; maximum JSON body is ${maxBytes} bytes`, 413);
      chunks.push(Buffer.from(chunk));
    }
    function onEnd() {
      try { const text = Buffer.concat(chunks).toString('utf8'); finish(null, text ? JSON.parse(text) : {}); }
      catch { fail('INVALID_JSON', 'invalid json'); }
    }
    function onAbort() { fail('REQUEST_ABORTED', '客户端已取消请求。', 499); }
    function onError(error) { finish(error); }
    function onClose() { if (!req.complete) onAbort(); }
    if (req.aborted || req.destroyed) return onAbort();
    if (req.readableEnded) return fail('REQUEST_BODY_UNAVAILABLE', '请求内容已读取，请重试。');
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onError);
    req.once('close', onClose);
  });
  // Queued requests may fail before their handler reaches await body(req).
  result.catch(() => {});
  bodies.set(req, result);
  return result;
}

function createRequestQueue(handler, { maxBytes, bodyTimeoutMs = 30000 } = {}) {
  let tail = Promise.resolve();
  async function task(operation) {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  async function run(req, res, url) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      readJsonBody(req, { maxBytes, timeoutMs: bodyTimeoutMs });
    }
    return task(async () => {
      if (req.aborted || res.destroyed) return;
      return await handler(req, res, url);
    });
  }
  run.task = task;
  return run;
}

module.exports = { readJsonBody, createRequestQueue };
