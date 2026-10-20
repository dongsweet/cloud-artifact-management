import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GateKeyring } from '../src/keyring.js';

async function pair(now = () => Date.now()) {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-identities-'));
  const core = new GateKeyring({ filePath: join(dir, 'core.json'), role: 'core', now });
  const edge = new GateKeyring({ filePath: join(dir, 'edge.json'), role: 'edge', now });
  await Promise.all([core.ready, edge.ready]);
  await core.trustPeer(await edge.identity());
  await edge.trustPeer(await core.identity());
  return { dir, core, edge };
}

test('business traffic remains disabled until a mutually trusted identity is confirmed', async () => {
  const { dir, core, edge } = await pair();
  try {
    assert.equal((await core.status()).businessReady, false);
    assert.equal((await edge.status()).businessReady, false);
    const path = '/api/v1/gate/approval-requests';
    const body = JSON.stringify({ requestId: 'R-1' });
    const headers = await edge.requestHeaders('POST', path, body);
    assert.equal(await core.verifyRequest({ method: 'POST', path, headers, body }), true);
    assert.equal((await core.status()).businessReady, false, 'business authentication alone does not mark the pairing test complete');
    await core.markPeerConfirmed();
    await edge.markPeerConfirmed();
    assert.equal((await core.status()).businessReady, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('signed requests bind method, path, content, key fingerprint, timestamp and a one-time nonce', async () => {
  const { dir, core, edge } = await pair();
  try {
    const path = '/api/v1/gate/approval-requests';
    const body = JSON.stringify({ requestId: 'R-2' });
    const headers = await edge.requestHeaders('POST', path, body);
    const request = { method: 'POST', path, headers, body };
    assert.equal(await core.verifyRequest(request), true);
    assert.equal(await core.verifyRequest(request), false, 'replayed nonces must be rejected');
    assert.equal(await core.verifyRequest({ ...request, path: `${path}/other`, headers: await edge.requestHeaders('POST', path, body) }), false);
    assert.equal(await core.verifyRequest({ ...request, body: JSON.stringify({ requestId: 'tampered' }), headers: await edge.requestHeaders('POST', path, body) }), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('identity rotation is signed by the old key, survives retries, and accepts old peer identity only through grace', async () => {
  let now = Date.now();
  const fixture = await pair(() => now);
  const { dir, core, edge } = fixture;
  try {
    await core.markPeerConfirmed(); await edge.markPeerConfirmed();
    const oldCoreIdentity = await core.identity();
    const oldCorePrivateKey = core.state.signing.privateKey;
    const proposal = await core.proposeIdentityRotation();
    const edgeReceipt = await edge.acceptIdentityRotation(proposal);
    const retryReceipt = await edge.acceptIdentityRotation(proposal);
    assert.deepEqual(retryReceipt, edgeReceipt, 'lost response can be recovered by retrying the same transition');
    await core.activateIdentityRotation(edgeReceipt);
    assert.notEqual((await core.identity()).signingFingerprint, oldCoreIdentity.signingFingerprint);
    assert.equal((await edge.status()).peerFingerprint, (await core.identity()).signingFingerprint);

    const body = '';
    const path = '/api/v1/gate/pairing-probe';
    const oldHeaders = {
      'x-cam-gate-key-id': oldCoreIdentity.signingFingerprint,
      ...((await import('../src/request-auth.js')).signGateRequest(oldCorePrivateKey, 'GET', path, body))
    };
    assert.equal(await edge.verifyRequest({ method: 'GET', path, headers: oldHeaders, body }), true);
    now += 24 * 3600_000 + 1;
    const expiredHeaders = {
      ...oldHeaders,
      ...((await import('../src/request-auth.js')).signGateRequest(oldCorePrivateKey, 'GET', path, body))
    };
    assert.equal(await edge.verifyRequest({ method: 'GET', path, headers: expiredHeaders, body }), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy negotiated shared secrets are removed when keyring state is loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-migration-'));
  try {
    const filePath = join(dir, 'keyring.json');
    const first = new GateKeyring({ filePath, role: 'core' });
    await first.ready;
    const state = JSON.parse(await readFile(filePath, 'utf8'));
    state.active = { id: 'legacy', secret: 'c2VjcmV0' };
    state.previous = { id: 'legacy-old', secret: 'b2xk' };
    await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, JSON.stringify(state)));
    const migrated = new GateKeyring({ filePath, role: 'core' });
    await migrated.ready;
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(saved.active, null);
    assert.equal(saved.previous, null);
    assert.ok(saved.events.some((event) => event.type === 'SHARED_SECRETS_RETIRED'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
