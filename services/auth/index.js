const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 8;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateCredentials({ email, password, username } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw Object.assign(new Error('请输入有效的 Email 地址。'), { code: 'INVALID_EMAIL', status: 400 });
  if (String(password || '').length < PASSWORD_MIN_LENGTH) throw Object.assign(new Error(`密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符。`), { code: 'WEAK_PASSWORD', status: 400 });
  if (username !== undefined && !String(username || '').trim()) throw Object.assign(new Error('用户名不能为空。'), { code: 'INVALID_USERNAME', status: 400 });
  return { email: normalizedEmail, username: String(username || normalizedEmail.split('@')[0]).trim().slice(0, 120), password: String(password) };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const derived = crypto.scryptSync(String(password), Buffer.from(parts[4], 'base64url'), 64, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
    return crypto.timingSafeEqual(derived, Buffer.from(parts[5], 'base64url'));
  } catch { return false; }
}

function createAuthService(learningDb) {
  function register(input = {}) {
    const credentials = validateCredentials(input);
    if (learningDb.getUserByEmail(credentials.email)) throw Object.assign(new Error('该 Email 已注册，请直接登录。'), { code: 'EMAIL_EXISTS', status: 409 });
    const user = learningDb.createUserAccount({ email: credentials.email, username: credentials.username, passwordHash: hashPassword(credentials.password) });
    return { user, session: learningDb.createSession(user.id) };
  }
  function login(input = {}) {
    const email = normalizeEmail(input.email); const account = learningDb.getUserAuthByEmail(email);
    if (!account || !verifyPassword(String(input.password || ''), account.passwordHash)) throw Object.assign(new Error('Email 或密码不正确。'), { code: 'INVALID_CREDENTIALS', status: 401 });
    delete account.passwordHash;
    return { user: account, session: learningDb.createSession(account.id) };
  }
  return { normalizeEmail, validateCredentials, hashPassword, verifyPassword, register, login };
}

module.exports = { PASSWORD_MIN_LENGTH, normalizeEmail, validateCredentials, hashPassword, verifyPassword, createAuthService };
