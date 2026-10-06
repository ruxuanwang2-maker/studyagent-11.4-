const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 8;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLoginName(value) { return String(value || '').trim().toLowerCase(); }

function validateCredentials({ email, loginName, password, username } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedLoginName = normalizeLoginName(loginName);
  if (normalizedLoginName) {
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(normalizedLoginName)) throw Object.assign(new Error('本地用户名须为 3–32 位文字、数字、下划线、点或短横线。'), { code: 'INVALID_LOGIN_NAME', status: 400 });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw Object.assign(new Error('请输入本地用户名。'), { code: 'INVALID_LOGIN_NAME', status: 400 });
  if (String(password || '').length < PASSWORD_MIN_LENGTH) throw Object.assign(new Error(`密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符。`), { code: 'WEAK_PASSWORD', status: 400 });
  if (username !== undefined && !String(username || '').trim()) throw Object.assign(new Error('用户名不能为空。'), { code: 'INVALID_USERNAME', status: 400 });
  return { email: normalizedLoginName ? null : normalizedEmail, loginName: normalizedLoginName || null, username: String(username || normalizedLoginName || normalizedEmail.split('@')[0]).trim().slice(0, 120), password: String(password) };
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
  async function register(input = {}) {
    const credentials = validateCredentials(input);
    if (credentials.loginName && await learningDb.getUserByLoginName(credentials.loginName)) throw Object.assign(new Error('该本地用户名已被使用。'), { code: 'LOGIN_NAME_EXISTS', status: 409 });
    if (credentials.email && await learningDb.getUserByEmail(credentials.email)) throw Object.assign(new Error('该 Email 已注册，请直接登录。'), { code: 'EMAIL_EXISTS', status: 409 });
    const user = await learningDb.createUserAccount({ email: credentials.email, loginName: credentials.loginName, username: credentials.username, passwordHash: hashPassword(credentials.password) });
    return { user, session: await learningDb.createSession(user.id) };
  }
  async function login(input = {}) {
    const identity = String(input.loginId || input.loginName || input.email || '').trim();
    const account = identity.includes('@') ? await learningDb.getUserAuthByEmail(normalizeEmail(identity)) : await learningDb.getUserAuthByLoginName(normalizeLoginName(identity));
    if (!account || !verifyPassword(String(input.password || ''), account.passwordHash)) throw Object.assign(new Error('用户名或密码不正确。'), { code: 'INVALID_CREDENTIALS', status: 401 });
    delete account.passwordHash;
    return { user: account, session: await learningDb.createSession(account.id) };
  }
  return { normalizeEmail, validateCredentials, hashPassword, verifyPassword, register, login };
}

module.exports = { PASSWORD_MIN_LENGTH, normalizeEmail, validateCredentials, hashPassword, verifyPassword, createAuthService };
