const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Parsing never touches the database or the HTTP server's mutable user context.
// Only short commits/progress writes enter the existing serial API queue.
async function createImportJobs({ learningDb, queueTask, commit, maxPending = 4, timeoutMs = 45 * 60000 }) {
  const pending = [];
  const active = new Map();
  await learningDb.database.execute(`UPDATE document_import_jobs SET status='failed',error_json=?,updated_at=? WHERE status IN ('queued','running')`, [
    JSON.stringify({ code: 'IMPORT_INTERRUPTED', message: '服务重启中断了导入，请重新上传原文件。' }),
    new Date().toISOString()
  ]);
  async function ownedTask(userId, operation) {
    return queueTask(async () => {
      if (!await learningDb.getUserById(userId)) throw Object.assign(new Error('账号已删除，导入已停止。'), { code: 'ACCOUNT_DELETED' });
      await learningDb.setUserId(userId);
      return operation();
    });
  }
  async function update(id, status, { progress, documentId, error } = {}) {
    await learningDb.database.execute(`UPDATE document_import_jobs SET status=?,progress_json=COALESCE(?,progress_json),document_id=COALESCE(?,document_id),error_json=?,updated_at=? WHERE id=?`, [
      status,
      progress ? JSON.stringify(progress) : null,
      documentId || null,
      error ? JSON.stringify(error) : null,
      new Date().toISOString(),
      id
    ]);
  }
  function pump() {
    if (active.size || !pending.length) return;
    const job = pending.shift();
    active.set(job.id, job);
    // OCR engines allocate sizeable WASM/native buffers that are not always
    // returned to the OS when only a worker thread ends. A dedicated process
    // gives every import a hard memory boundary and keeps the reader/API alive
    // during consecutive large-PDF imports.
    const worker = fork(path.join(__dirname, 'importWorker.js'), [], {
      execArgv: ['--max-old-space-size=1024'],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    job.worker = worker;
    let settled = false, lastProgressAt = 0;
    const timer = setTimeout(() => finish(Object.assign(new Error('导入处理超时，请检查文件后重试。'), { code: 'IMPORT_TIMEOUT' })), timeoutMs);
    function finish(error, parsed) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resource cleanup completes before another OCR worker can start.
      (async () => {
        try {
          if (error) throw error;
          const document = await ownedTask(job.userId, async () => {
            const result = await commit(job.payload, parsed);
            await update(job.id, 'completed', { documentId: result.id, progress: { stage: 'completed', page: result.pages, total: result.pages } });
            return result;
          });
          job.resolve(document);
        } catch (failure) {
          await queueTask(() => update(job.id, 'failed', { error: { code: failure.code || 'DOCUMENT_IMPORT_FAILED', message: failure.message } }));
          job.reject(failure);
        } finally {
          if (worker.connected) worker.disconnect();
          if (!worker.killed) worker.kill();
          active.delete(job.id);
          job.payload = null;
          pump();
        }
      })().catch(job.reject);
    }
    ownedTask(job.userId, () => update(job.id, 'running', { progress: { stage: 'parsing', page: 0, total: 0 } })).catch(finish);
    worker.on('message', message => {
      if (settled) return;
      if (message.result) return finish(null, message.result);
      if (message.error) return finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      if (message.progress && Date.now() - lastProgressAt > 500) {
        lastProgressAt = Date.now();
        ownedTask(job.userId, () => update(job.id, 'running', { progress: message.progress })).catch(finish);
      }
    });
    worker.once('error', finish);
    worker.once('exit', code => { if (!settled) finish(Object.assign(new Error(`解析进程异常退出 (${code})`), { code: 'IMPORT_WORKER_EXIT' })); });
    worker.send(job.payload);
  }
  async function create(payload, userId) {
    if (pending.length + active.size >= maxPending) throw Object.assign(new Error('导入队列已满，请等待当前文件完成。'), { code: 'IMPORT_QUEUE_FULL', status: 429 });
    const id = `import-${randomUUID()}`, timestamp = new Date().toISOString();
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    done.catch(() => {});
    await learningDb.database.execute('INSERT INTO document_import_jobs(id,user_id,filename,status,progress_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [id, userId, payload.name, 'queued', '{}', timestamp, timestamp]);
    pending.push({ id, payload, userId, resolve, reject });
    // Never re-enter the queue from inside its current task.
    setImmediate(pump);
    return { id, done };
  }
  async function get(id, userId) {
    const [rows] = await learningDb.database.execute('SELECT * FROM document_import_jobs WHERE id=? AND user_id=?', [id, userId]);
    const row = rows[0];
    return row ? { id: row.id, filename: row.filename, status: row.status, progress: JSON.parse(row.progress_json), documentId: row.document_id, error: row.error_json ? JSON.parse(row.error_json) : null, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  async function list(userId) {
    const [rows] = await learningDb.database.execute("SELECT id FROM document_import_jobs WHERE user_id=? AND (status!='completed' OR document_id IN (SELECT id FROM documents WHERE user_id=?)) ORDER BY created_at DESC LIMIT 20", [userId, userId]);
    return Promise.all(rows.map(row => get(row.id, userId)));
  }
  return { create, get, list };
}
module.exports = { createImportJobs };
