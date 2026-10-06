const { parentPort, workerData } = require('node:worker_threads');
const { parseImportPayload } = require('./parser');

function send(message) {
  if (parentPort) return parentPort.postMessage(message);
  if (!process.send) return;
  // The parent owns the IPC lifetime. Disconnecting here can make the parent
  // observe exit(0) before it receives the final result on Windows.
  process.send(message);
}

function run(payload) {
  parseImportPayload(payload, progress => send({ progress }))
    .then(result => send({ result }))
    .catch(error => send({ error: { code: error.code || 'DOCUMENT_PARSE_FAILED', message: error.message } }));
}

if (parentPort) run(workerData);
else {
  let started = false;
  // Keep a message listener attached while the asynchronous parser runs: a
  // one-shot listener can unref the IPC channel and exit before it resolves.
  process.on('message', payload => { if (!started) { started = true; run(payload); } });
}
