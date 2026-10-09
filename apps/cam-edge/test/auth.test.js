import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../src/auth-store.js';
import { buildEdgeApp } from '../src/app.js';

const password = 'Temporary-password-123';
async function account(store, username, roles) {
  const u = await store.createUser({ username, displayName: username, password, roles });
  await store.changePassword(u.id, 'Permanent-password-456', u.id, password);
  return store.getUser(u.id);
}
async function login(app, username, value = 'Permanent-password-456') {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: value } });
  assert.equal(r.statusCode, 200, r.body);
  return { cookie: r.headers['set-cookie'].map((v) => v.split(';')[0]).join('; '), 'x-cam-csrf': r.json().csrfToken };
}
test('password hashing, login lockout and idle/absolute expiry', async () => {
  const db = new DatabaseSync(':memory:'); let clock = Date.now();
  const s = new AuthStore(db, { clock: () => clock, idleMs: 1000, absoluteMs: 2000 });
  try {
    const u = await account(s, 'validator', ['VALIDATOR']);
    const row = db.prepare('SELECT * FROM edge_users').get();
    assert.notEqual(row.password_hash, password); assert.equal(row.password_hash.length, 128);
    for (let i = 0; i < 5; i++) await assert.rejects(s.login('validator', 'bad'), /用户名或密码错误/);
    await assert.rejects(s.login('validator', 'Permanent-password-456'), /用户名或密码错误/);
    clock += 60001;
    const logged = await s.login('validator', 'Permanent-password-456');
    assert.equal(s.resolve(logged.token).id, u.id);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM edge_sessions').get()).includes(logged.token));
    clock += 900; assert.ok(s.resolve(logged.token));
    clock += 900; assert.ok(s.resolve(logged.token));
    clock += 201; assert.equal(s.resolve(logged.token), null);
    const another = await s.login('validator', 'Permanent-password-456');
    clock += 1001; assert.equal(s.resolve(another.token), null);
  } finally { db.close(); }
});
test('bootstrap is once-only and the last admin cannot be removed', async () => {
  const db = new DatabaseSync(':memory:'); const s = new AuthStore(db);
  try {
    const admin = await s.createUser({ username: 'admin', displayName: '管理员', password, roles: ['EDGE_ADMIN'] }, null, { bootstrap: true });
    await assert.rejects(s.createUser({ username: 'admin2', displayName: '管理员', password, roles: ['EDGE_ADMIN'] }, null, { bootstrap: true }), /已经初始化/);
    assert.throws(() => s.updateUser(admin.id, { status: 'DISABLED' }, 'other'), /至少保留/);
    assert.throws(() => s.updateUser(admin.id, { roles: ['VALIDATOR'] }, admin.id), /不能禁用自己/);
    const other = await account(s, 'other', ['VALIDATOR']);
    const session = await s.login('other', 'Permanent-password-456');
    s.updateUser(other.id, { status: 'DISABLED' }, admin.id);
    assert.equal(s.resolve(session.token), null);
    await s.changePassword(other.id, password, admin.id);
    assert.equal(s.getUser(other.id).mustChangePassword, true);
  } finally { db.close(); }
});
test('business APIs enforce login, CSRF, forced password change and independent roles', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-auth-'));
  const app = await buildEdgeApp({ dataDir, secureCookies: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/products', headers: { 'x-cam-principal-id': 'forged' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://evil.invalid' }, payload: {} })).statusCode, 403);
    await app.authStore.createUser({ username: 'admin', displayName: '管理员', password, roles: ['EDGE_ADMIN'] });
    let headers = await login(app, 'admin', password);
    assert.equal((await app.inject({ url: '/api/v1/users', headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: { cookie: headers.cookie }, payload: { oldPassword: password, password: 'Permanent-password-456' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers, payload: { oldPassword: password, password: 'Permanent-password-456' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers })).statusCode, 401);
    headers = await login(app, 'admin');
    assert.equal((await app.inject({ url: '/api/v1/users', headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: { name: 'forbidden' } })).statusCode, 403);
    await account(app.authStore, 'receiver', ['CANDIDATE_RECEIVER']);
    const receiver = await login(app, 'receiver');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/products', headers: receiver, payload: { name: 'allowed' } })).statusCode, 201);
    assert.equal((await app.inject({ url: '/api/v1/users', headers: receiver })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: receiver })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/products', headers: receiver })).statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('accounts and session survive reopening the persisted SQLite database', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-auth-persist-'));
  let app = await buildEdgeApp({ dataDir, secureCookies: false });
  try {
    const u = await account(app.authStore, 'validator', ['VALIDATOR']);
    const headers = await login(app, 'validator'); await app.close();
    app = await buildEdgeApp({ dataDir, secureCookies: false });
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers })).json().user.id, u.id);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('download ownership, token-only calls, revoked recipient and invalid Range limits', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-auth-download-'));
  const app = await buildEdgeApp({ dataDir, secureCookies: false });
  try {
    const creator = await account(app.authStore, 'creator', ['VALIDATOR']);
    const recipient = await account(app.authStore, 'recipient', ['VALIDATOR']);
    const admin = await account(app.authStore, 'admin', ['EDGE_ADMIN']);
    const headers = await login(app, 'creator');
    const bytes = Buffer.from('test-verified-content');
    const c = await app.candidateStore.create({ sourceUrl: 'https://dev.invalid/pkg.bin', fileName: 'pkg.bin', size: bytes.length });
    await writeFile(c.source_path, bytes);
    app.candidateStore.db.prepare("UPDATE candidates SET status = 'COMPLETED', final_sha256 = ? WHERE candidate_id = ?").run(createHash('sha256').update(bytes).digest('hex'), c.candidate_id);
    const response = await app.inject({ method: 'POST', url: '/api/v1/download-grants', headers, payload: { candidateIds: [c.candidate_id], recipientId: recipient.id, expiresAt: new Date(Date.now() + 60000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 } });
    assert.equal(response.statusCode, 201, response.body);
    const grant = response.json();
    assert.equal(app.downloadGrantStore.getGrant(grant.grantId).principalId, recipient.id);
    assert.equal(app.downloadGrantStore.getGrant(grant.grantId).createdBy, creator.id);
    assert.equal((await app.inject({ url: grant.items[0].downloadUrl, headers: { range: 'bytes=999-1000' } })).statusCode, 416);
    assert.equal(app.downloadGrantStore.getGrant(grant.grantId).usedTotalSessions, 0);
    const suffix = await app.inject({ url: grant.items[0].downloadUrl, headers: { range: 'bytes=-4' } });
    assert.equal(suffix.statusCode, 409);
    assert.equal(app.downloadGrantStore.getGrant(grant.grantId).usedTotalSessions, 0);
    const firstPart = await app.inject({ url: grant.items[0].downloadUrl, headers: { range: 'bytes=0-3' } });
    assert.equal(firstPart.statusCode, 206); assert.deepEqual(firstPart.rawPayload, bytes.subarray(0, 4));
    const event = app.downloadGrantStore.db.prepare("SELECT principal_id FROM download_events WHERE event_type = 'DOWNLOAD_STARTED'").get();
    assert.equal(event.principal_id, `TOKEN:${grant.grantId}`);
    app.authStore.updateUser(recipient.id, { status: 'DISABLED' }, admin.id);
    assert.equal((await app.inject({ url: grant.items[0].downloadUrl })).statusCode, 403);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('secure session cookies are the default and rapid login attempts are throttled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-auth-secure-'));
  const app = await buildEdgeApp({ dataDir });
  try {
    await account(app.authStore, 'validator', ['VALIDATOR']);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'validator', password: 'Permanent-password-456' } });
    assert.match(r.headers['set-cookie'][0], /HttpOnly; Secure/);
    assert.match(r.headers['set-cookie'][0], /SameSite=Strict/);
    for (let i = 1; i < 20; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode, 429);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
