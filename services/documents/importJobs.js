const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');

// Parsing never touches the database or the HTTP server's mutable user context.
// Only short commits/progress writes enter the existing serial API queue.
function createImportJobs({ learningDb, queueTask, commit, maxPending = 4, timeoutMs = 45 * 60000 }) {
  const pending = [];
  const active = new Map();
  learningDb.database.prepare(`UPDATE document_import_jobs SET status='failed',error_json=?,updated_at=? WHERE status IN ('queued','running')`)
    .run(JSON.stringify({ code: 'IMPORT_INTERRUPTED', message: '服务重启中断了导入，请重新上传原文件。' }), new Date().toISOString());
  function ownedTask(userId, operation) {
    return queueTask(() => {
      if (!learningDb.getUserById(userId)) throw Object.assign(new Error('账号已删除，导入已停止。'), { code: 'ACCOUNT_DELETED' });
      learningDb.setUserId(userId);
      return operation();
    });
  }
  function update(id, status, { progress, documentId, error } = {}) {
    learningDb.database.prepare(`UPDATE document_import_jobs SET status=?,progress_json=COALESCE(?,progress_json),document_id=COALESCE(?,document_id),error_json=?,updated_at=? WHERE id=?`)
      .run(status, progress ? JSON.stringify(progress) : null, documentId || null, error ? JSON.stringify(error) : null, new Date().toISOString(), id);
  }
  function pump() {
    if (active.size || !pending.length) return;
    const job = pending.shift();
    active.set(job.id, job);
    const worker = new Worker(path.join(__dirname, 'importWorker.js'), { workerData: job.payload, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
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
            update(job.id, 'completed', { documentId: result.id, progress: { stage: 'completed', page: result.pages, total: result.pages } });
            return result;
          });
          job.resolve(document);
        } catch (failure) {
          await queueTask(() => update(job.id, 'failed', { error: { code: failure.code || 'DOCUMENT_IMPORT_FAILED', message: failure.message } }));
          job.reject(failure);
        } finally {
          await worker.terminate();
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
  }
  function create(payload, userId) {
    if (pending.length + active.size >= maxPending) throw Object.assign(new Error('导入队列已满，请等待当前文件完成。'), { code: 'IMPORT_QUEUE_FULL', status: 429 });
    const id = `import-${randomUUID()}`, timestamp = new Date().toISOString();
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    done.catch(() => {});
    learningDb.database.prepare('INSERT INTO document_import_jobs(id,user_id,filename,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, userId, payload.name, 'queued', timestamp, timestamp);
    pending.push({ id, payload, userId, resolve, reject });
    // Never re-enter the queue from inside its current task.
    setImmediate(pump);
    return { id, done };
  }
  function get(id, userId) {
    const row = learningDb.database.prepare('SELECT * FROM document_import_jobs WHERE id=? AND user_id=?').get(id, userId);
    return row ? { id: row.id, filename: row.filename, status: row.status, progress: JSON.parse(row.progress_json), documentId: row.document_id, error: row.error_json ? JSON.parse(row.error_json) : null, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  function list(userId) {
    return learningDb.database.prepare("SELECT id FROM document_import_jobs WHERE user_id=? AND (status!='completed' OR document_id IN (SELECT id FROM documents WHERE user_id=?)) ORDER BY created_at DESC LIMIT 20").all(userId,userId).map(row => get(row.id, userId));
  }
  return { create, get, list };
}
module.exports = { createImportJobs };
