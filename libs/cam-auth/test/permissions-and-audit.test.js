import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { queryAuthEvents } from '../src/audit-events.js';
import { hasCorePermission, hasEdgePermission } from '../src/roles.js';

test('Core and Edge roles follow the agreed module separation', () => {
  assert.equal(hasCorePermission(['CORE_SYSTEM_ADMIN'], 'aaaWrite'), true);
  assert.equal(hasCorePermission(['CORE_SECURITY_ADMIN'], 'aaaRead'), false);
  assert.equal(hasCorePermission(['CORE_SYSTEM_ADMIN'], 'userAdmin'), false);
  assert.equal(hasCorePermission(['CORE_SECURITY_ADMIN'], 'userAdmin'), true);
  assert.equal(hasCorePermission(['CORE_SYSTEM_ADMIN'], 'businessWrite'), false);
  assert.equal(hasCorePermission(['CORE_OPERATOR'], 'businessWrite'), true);
  assert.equal(hasCorePermission(['CORE_AUDITOR'], 'businessRead'), false);
  assert.equal(hasCorePermission(['CORE_AUDITOR'], 'businessWrite'), false);
  assert.equal(hasCorePermission(['CORE_AUDITOR'], 'auditRead'), true);

  assert.equal(hasEdgePermission(['EDGE_SYSTEM_ADMIN'], 'configWrite'), true);
  assert.equal(hasEdgePermission(['EDGE_SECURITY_ADMIN'], 'configWrite'), false);
  assert.equal(hasEdgePermission(['EDGE_SECURITY_ADMIN'], 'userAdminRead'), true);
  assert.equal(hasEdgePermission(['EDGE_AUDITOR'], 'auditRead'), true);
  assert.equal(hasEdgePermission(['EDGE_AUDITOR'], 'candidateRead'), false);
  assert.equal(hasEdgePermission(['EDGE_AUDITOR'], 'validatorRead'), false);
  assert.equal(hasEdgePermission(['EDGE_AUDITOR'], 'candidateWrite'), false);
});

test('shared audit query supports filters and bounded pagination for both modules', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE core_auth_events (event_id TEXT PRIMARY KEY, principal_id TEXT, event_type TEXT NOT NULL, source_address TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO core_auth_events VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('1', 'alice', 'LOGIN_SUCCEEDED', '10.0.0.1', '{"sessionId":"one"}', '2026-10-20T09:00:00.000Z');
    insert.run('2', 'bob', 'USER_CREATED', '10.0.0.2', '{"username":"bob"}', '2026-10-21T09:00:00.000Z');
    insert.run('3', 'alice', 'LOGOUT', '10.0.0.1', '{}', '2026-10-22T09:00:00.000Z');

    const firstPage = queryAuthEvents(db, 'core_auth_events', { limit: '1', offset: '0' });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.items[0].event_id, '3');
    assert.equal(firstPage.limit, 1);
    const filtered = queryAuthEvents(db, 'core_auth_events', { search: 'alice', from: '2026-10-20', to: '2026-10-21' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].event_type, 'LOGIN_SUCCEEDED');
    assert.throws(() => queryAuthEvents(db, 'core_auth_events', { from: 'invalid' }), (error) => error.code === 'audit_filter_invalid');
    assert.throws(() => queryAuthEvents(db, 'unexpected_table'), TypeError);
  } finally { db.close(); }
});
