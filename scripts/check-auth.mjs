const base = process.env.STUDYAGENT_URL || 'http://127.0.0.1:4173';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const accounts = [
  { email: `studyagent-a-${suffix}@example.com`, username: 'Isolation A', password: 'StudyAgent-A-2026!' },
  { email: `studyagent-b-${suffix}@example.com`, username: 'Isolation B', password: 'StudyAgent-B-2026!' }
];

async function request(path, options = {}, cookie = '') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const setCookie = response.headers.get('set-cookie') || '';
  return { response, data, cookie: setCookie.split(';')[0] };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function jsonBody(value) { return JSON.stringify(value); }

const guest = await request('/api/auth/session');
assert(guest.response.ok && guest.data.guest === true, 'fresh session should be guest');
const guestCookie = guest.cookie;
assert(guestCookie && guest.data.user?.id !== 'user-local', 'guest should receive an isolated session identity');
const guestWorkspace = await request('/api/workspaces', { method: 'POST', body: jsonBody({ name: `Guest private workspace ${suffix}` }) }, guestCookie);
assert(guestWorkspace.response.ok, 'guest workspace creation failed');
const otherGuest = await request('/api/auth/session');
assert(otherGuest.response.ok && otherGuest.data.guest && otherGuest.data.user.id !== guest.data.user.id, 'separate visitors should receive separate guest identities');
const otherGuestWorkspaces = await request('/api/workspaces', {}, otherGuest.cookie);
assert(otherGuestWorkspaces.response.ok && !otherGuestWorkspaces.data.some(item => item.id === guestWorkspace.data.id), 'guest workspaces leaked to another visitor');
const blockedDiscovery = await request('/api/models/discover', { method: 'POST', body: jsonBody({ provider: 'custom', model: 'ssrf-test', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3306' }) }, guestCookie);
assert(blockedDiscovery.response.status === 400 && blockedDiscovery.data.error?.code === 'INVALID_MODEL_ENDPOINT', 'model discovery allowed a private endpoint');
await request('/api/guest/cleanup', { method: 'POST', body: '{}' }, guestCookie);
await request('/api/guest/cleanup', { method: 'POST', body: '{}' }, otherGuest.cookie);

const localLoginName = `regression_${suffix.replace(/[^a-z0-9]/gi, '').slice(-18)}`;
const localPassword = 'Local-study-2026!';
const localRegistration = await request('/api/auth/register', { method: 'POST', body: jsonBody({ loginName: localLoginName, password: localPassword }) });
assert(localRegistration.response.status === 201 && localRegistration.data.user?.loginName === localLoginName && !localRegistration.data.user?.email, 'local username registration failed');
const localCookie = localRegistration.cookie;
const duplicateLocal = await request('/api/auth/register', { method: 'POST', body: jsonBody({ loginName: localLoginName.toUpperCase(), password: localPassword }) });
assert(duplicateLocal.response.status === 409, 'duplicate local username was accepted');
const badLocalPassword = await request('/api/account/password', { method: 'POST', body: jsonBody({ currentPassword: 'wrong-password', newPassword: 'Changed-local-2026!' }) }, localCookie);
assert(badLocalPassword.response.status === 401, 'local account accepted wrong current password');
const changedLocalPassword = await request('/api/account/password', { method: 'POST', body: jsonBody({ currentPassword: localPassword, newPassword: 'Changed-local-2026!' }) }, localCookie);
assert(changedLocalPassword.response.ok, 'local account password change failed');
await request('/api/auth/logout', { method: 'POST' }, localCookie);
const localLogin = await request('/api/auth/login', { method: 'POST', body: jsonBody({ loginId: localLoginName, password: 'Changed-local-2026!' }) });
assert(localLogin.response.ok && localLogin.data.user?.loginName === localLoginName, 'local username login failed');
const localDelete = await request('/api/account', { method: 'DELETE', body: jsonBody({ confirmation: 'DELETE' }) }, localLogin.cookie);
assert(localDelete.response.ok, 'local account cleanup failed');

const registeredA = await request('/api/auth/register', { method: 'POST', body: jsonBody(accounts[0]) });
assert(registeredA.response.status === 201 && registeredA.data.user?.email === accounts[0].email, 'A registration failed');
const cookieA = registeredA.cookie;
assert(cookieA, 'A session cookie missing');

const profileA = await request('/api/memory/profile', { method: 'POST', body: jsonBody({ profile: { learningGoals: 'isolation-regression-A', answerStyle: 'detailed', formulaStyle: 'latex' } }) }, cookieA);
assert(profileA.response.ok && profileA.data.profile?.learningGoals === 'isolation-regression-A', 'A profile was not saved');
const documentA = await request('/api/documents/upload', { method: 'POST', body: jsonBody({ name: 'A private document.txt', content: 'Only account A should retrieve this document.' }) }, cookieA);
assert(documentA.response.status === 201 && documentA.data.title === 'A private document', 'A document was not imported');
const workspacesA = await request('/api/workspaces', {}, cookieA);
assert(workspacesA.response.ok && workspacesA.data.some(item => item.id === documentA.data.workspaceId), 'A document was not assigned to A workspace');
const noteA = await request('/api/notes', { method: 'POST', body: jsonBody({ id: `note-a-${suffix}`, title: 'A note', content: 'Only account A should edit this note.', documentId: documentA.data.id }) }, cookieA);
assert(noteA.response.status === 200 && noteA.data.id === `note-a-${suffix}`, 'A note was not saved');
const annotationA = await request(`/api/documents/${encodeURIComponent(documentA.data.id)}/annotations`, { method: 'POST', body: jsonBody({ id: `annotation-a-${suffix}`, page: 1, type: 'highlight', text: 'A only' }) }, cookieA);
assert(annotationA.response.status === 200 && annotationA.data.id === `annotation-a-${suffix}`, 'A annotation was not saved');
const configA = await request('/api/models/configs', { method: 'POST', body: jsonBody({ provider: 'custom', model: `account-a-${suffix}`, baseUrl: 'http://127.0.0.1:9/v1', isDefault: true }) }, cookieA);
assert(configA.response.ok && configA.data.model === `account-a-${suffix}`, 'A model config was not saved');
const exportA = await request('/api/account/export', {}, cookieA);
assert(exportA.response.ok && exportA.data.user?.email === accounts[0].email, 'A export is not scoped to A');

const logoutA = await request('/api/auth/logout', { method: 'POST' }, cookieA);
assert(logoutA.response.ok && logoutA.data.guest === true, 'A logout failed');

const registeredB = await request('/api/auth/register', { method: 'POST', body: jsonBody(accounts[1]) });
assert(registeredB.response.status === 201 && registeredB.data.user?.email === accounts[1].email, 'B registration failed');
const cookieB = registeredB.cookie;
const documentB = await request('/api/documents/upload', { method: 'POST', body: jsonBody({ name: 'B private document.txt', content: 'Only account B should retrieve this document.' }) }, cookieB);
assert(documentB.response.status === 201, 'B document was not imported');
const noteCollision = await request('/api/notes', { method: 'POST', body: jsonBody({ id: `note-a-${suffix}`, title: 'Tampered note', content: 'B must not overwrite A', documentId: documentB.data.id }) }, cookieB);
assert(noteCollision.response.status === 400, 'B could overwrite A note by reusing its id');
const annotationCollision = await request(`/api/documents/${encodeURIComponent(documentB.data.id)}/annotations`, { method: 'POST', body: jsonBody({ id: `annotation-a-${suffix}`, page: 1, type: 'highlight', text: 'B must not overwrite A' }) }, cookieB);
assert(annotationCollision.response.status === 400, 'B could overwrite A annotation by reusing its id');
const memoryB = await request('/api/memory', {}, cookieB);
assert(memoryB.response.ok && !memoryB.data.profile && !(memoryB.data.memories || []).some(item => String(item.content).includes('isolation-regression-A')), 'B can see A memory');
const docsB = await request('/api/documents', {}, cookieB);
assert(docsB.response.ok && !(docsB.data || []).some(item => item.title === 'A private document'), 'B can see A document');
const configsB = await request('/api/models/configs', {}, cookieB);
assert(configsB.response.ok && !(configsB.data.configs || []).some(item => item.model === `account-a-${suffix}`), 'B can see A model config');

const logoutB = await request('/api/auth/logout', { method: 'POST' }, cookieB);
assert(logoutB.response.ok, 'B logout failed');
const loginA = await request('/api/auth/login', { method: 'POST', body: jsonBody({ email: accounts[0].email, password: accounts[0].password }) });
assert(loginA.response.ok && loginA.data.user?.email === accounts[0].email, 'A login failed');
const restoredA = await request('/api/memory/profile', {}, loginA.cookie);
assert(restoredA.response.ok && restoredA.data.profile?.learningGoals === 'isolation-regression-A', 'A session did not restore A memory');
const restoredConfigsA = await request('/api/models/configs', {}, loginA.cookie);
assert(restoredConfigsA.response.ok && restoredConfigsA.data.configs.some(item => item.model === `account-a-${suffix}`), 'A model config did not persist across sessions');

const deletedA = await request('/api/account', { method: 'DELETE', body: jsonBody({ confirmation: 'DELETE' }) }, loginA.cookie);
assert(deletedA.response.ok && deletedA.data.ok === true, 'A deletion failed');
const loginDeletedA = await request('/api/auth/login', { method: 'POST', body: jsonBody({ email: accounts[0].email, password: accounts[0].password }) });
assert(loginDeletedA.response.status === 401, 'deleted A account can still log in');

const deletedB = await request('/api/account', { method: 'DELETE', body: jsonBody({ confirmation: 'DELETE' }) }, cookieB);
assert(deletedB.response.ok && deletedB.data.ok === true, 'B deletion failed');
console.log('auth isolation ok: local usernames, legacy email login, password change, guest, session restore, user-scoped memory, note/annotation ownership, export and account deletion');
