const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function createConfigStore(filePath) {
  const key = crypto.scryptSync(`${os.userInfo().username}:${os.hostname()}:studyagent-model-config`, 'studyagent-local-salt', 32);
  function read() {
    if (!fs.existsSync(filePath)) return [];
    try {
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { return []; }
  }
  function write(configs) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(configs), 'utf8'), cipher.final()]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2));
  }
  return { read, write };
}

module.exports = { createConfigStore };
