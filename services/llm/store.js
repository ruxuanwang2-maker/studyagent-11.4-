const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function createConfigStore(filePath) {
  const stableKeyPath = path.join(path.dirname(filePath), '.model-config-key');
  function deriveKey(secret) { return crypto.scryptSync(secret, 'studyagent-local-salt', 32); }
  function stableKey() {
    let secret = '';
    try { secret = fs.readFileSync(stableKeyPath, 'utf8').trim(); } catch { /* Create the local secret below. */ }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(path.dirname(stableKeyPath), { recursive: true });
      fs.writeFileSync(stableKeyPath, secret, { encoding: 'utf8', flag: 'wx' });
    }
    return deriveKey(`stable:${secret}`);
  }
  function legacyKeys() {
    const identities = new Set([os.userInfo().username, 'CodexSandboxOffline', '王汝轩']);
    return [...identities].map(identity => deriveKey(`${identity}:${os.hostname()}:studyagent-model-config`));
  }
  function decrypt(envelope, key) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  function read() {
    if (!fs.existsSync(filePath)) return [];
    try {
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      try { return decrypt(envelope, stableKey()); } catch { /* Read legacy identity-bound files during migration. */ }
      for (const key of legacyKeys()) {
        try {
          const configs = decrypt(envelope, key);
          write(configs);
          return configs;
        } catch { /* Try the next legacy identity. */ }
      }
      return [];
    } catch { return []; }
  }
  function write(configs) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', stableKey(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(configs), 'utf8'), cipher.final()]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2));
  }
  return { read, write };
}

module.exports = { createConfigStore };
