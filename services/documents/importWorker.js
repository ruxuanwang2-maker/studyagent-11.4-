const { parentPort, workerData } = require('node:worker_threads');
const { parseImportPayload } = require('./parser');

parseImportPayload(workerData, progress => parentPort.postMessage({ progress }))
  .then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: { code: error.code || 'DOCUMENT_PARSE_FAILED', message: error.message } }));
