import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateKeyring } from '../src/keyring.js';

async function pairedScenario(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-recovery-'));
  let time = Date.now();
  const now = () => time;
  const core = new GateKeyring({ filePath: join(dir, 'core.json'), role: 'core', now });
  const edge = new GateKeyring({ filePath: join(dir, 'edge.json'), role: 'edge', now });
  const rotate = async () => {
    const pending = await core.prepareProposal();
    await core.verifyProof(await edge.acceptProposal(pending.proposal));
    await edge.confirmAtEdge(pending.id);
    await core.markEdgeConfirmed(pending.id);
    return pending;
  };
  try {
    await core.trustPeer(await edge.identity());
    await edge.trustPeer(await core.identity());
    await run({ core, edge, dir, now, advance: (ms) => { time += ms; }, rotate });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('First-key confirmation must finish before Core enables business traffic', async () => {
  await pairedScenario(async ({ core, edge }) => {
    assert.equal((await core.status()).pairingState, 'KEY_PENDING');
    const pending = await core.prepareProposal();
    await core.verifyProof(await edge.acceptProposal(pending.proposal));
    assert.equal((await core.status()).keyConfigured, true);
    assert.equal((await core.status()).businessReady, false);
    assert.equal((await core.status()).pairingState, 'CONFIRMING');
    await edge.confirmAtEdge(pending.id);
    await core.markEdgeConfirmed(pending.id);
    assert.equal((await core.status()).businessReady, true);
  });
});

test('Changing the rotation schedule keeps its due date anchored to the last successful rotation', async () => {
  await pairedScenario(async ({ core, advance, rotate, now }) => {
    await rotate();
    const lastRotationAt = (await core.status()).lastRotationAt;
    advance(10 * 86400000);
    await core.configure({ rotationIntervalDays: 90, gracePeriodHours: 24 });
    assert.equal((await core.status()).nextRotationAt, new Date(Date.parse(lastRotationAt) + 90 * 86400000).toISOString());
    await core.configure({ rotationIntervalDays: 5, gracePeriodHours: 24 });
    assert.equal((await core.status()).nextRotationAt, new Date(Date.parse(lastRotationAt) + 5 * 86400000).toISOString());
    assert.ok(Date.parse((await core.status()).nextRotationAt) < now(), 'shortened schedule may already be due');
  });
});

test('Rotation resumes after proposal expiry and restart, and retires old keys on schedule', async () => {
  await pairedScenario(async ({ core, edge, advance, rotate, dir, now }) => {
    const first = await rotate();
    const old = await core.currentSecret();
    await core.configure({ rotationIntervalDays: 1, gracePeriodHours: 1 });
    const pending = await core.prepareProposal();
    await edge.acceptProposal(pending.proposal);
    advance(16 * 60_000);
    const renewed = await core.prepareProposal();
    assert.equal(renewed.id, pending.id);
    await core.verifyProof(await edge.acceptProposal(renewed.proposal));
    assert.equal((await core.status()).businessReady, true, 'existing business key keeps the channel usable');
    await edge.confirmAtEdge(renewed.id);
    // Simulate a lost confirmation response and process restart.
    const restarted = new GateKeyring({ filePath: join(dir, 'core.json'), role: 'core', now });
    assert.equal((await restarted.prepareProposal()).status, 'CONFIRM_PENDING');
    await edge.confirmAtEdge(renewed.id);
    await restarted.markEdgeConfirmed(renewed.id);
    assert.equal(await edge.verifySecret(old), first.id);
    assert.equal(await restarted.verifySecret(old), first.id);
    advance(3600001);
    assert.equal((await edge.status()).previousKeyExpiresAt, null);
    assert.equal(await edge.verifySecret(old), false);
    assert.equal(await restarted.verifySecret(old), false);
    assert.equal(await edge.verifySecret(await restarted.currentSecret()), renewed.id);
    await assert.rejects(() => edge.acceptProposal(renewed.proposal), { code: 'gate_rotation_expired' });
  });
});

test('Reimporting a peer is idempotent; changing its identity revokes existing keys', async () => {
  await pairedScenario(async ({ core, edge, rotate, dir }) => {
    await rotate();
    const old = await core.currentSecret();
    const id = (await core.status()).activeKeyId;
    await core.trustPeer(await edge.identity());
    assert.equal((await core.status()).activeKeyId, id);
    const replacement = new GateKeyring({ filePath: join(dir, 'replacement.json'), role: 'edge' });
    await core.trustPeer(await replacement.identity());
    assert.equal((await core.status()).businessReady, false);
    assert.equal((await core.status()).keyConfigured, false);
    assert.equal(await core.verifySecret(old), false);
    const invalid = { ...(await edge.identity()), exchangePublicKey: (await edge.identity()).signingPublicKey };
    await assert.rejects(() => core.trustPeer(invalid), { code: 'gate_peer_invalid' });
  });
});

test('Retired signed proposals cannot roll the Edge back to an earlier key', async () => {
  await pairedScenario(async ({ core, edge, rotate }) => {
    const first = await rotate();
    const second = await rotate();
    await assert.rejects(() => edge.acceptProposal(first.proposal), { code: 'gate_rotation_replayed' });
    assert.equal((await edge.status()).activeKeyId, second.id);
    assert.equal(await edge.verifySecret(await core.currentSecret()), second.id);
  });
});

test('Legacy interrupted rotations retire old keys using the original activation time', async () => {
  await pairedScenario(async ({ core, edge, rotate, dir, now, advance }) => {
    await rotate();
    const old = await core.currentSecret();
    await rotate();
    const filePath = join(dir, 'core.json');
    const state = JSON.parse(await readFile(filePath, 'utf8'));
    delete state.previous.expiresAt;
    await writeFile(filePath, JSON.stringify(state));
    advance(25 * 3600000);
    const restarted = new GateKeyring({ filePath, role: 'core', now });
    assert.equal(await restarted.verifySecret(old), false);
    assert.equal((await restarted.status()).previousKeyExpiresAt, null);
    assert.equal(await edge.verifySecret(await restarted.currentSecret()), (await restarted.status()).activeKeyId);
  });
});

test('Core establishes the first shared key only after mutual identity trust, then rotates with bounded overlap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-keyring-'));
  try {
    let now = Date.now();
    const core = new GateKeyring({ filePath: join(dir, 'core', 'keyring.json'), role: 'core', now: () => now });
    const edge = new GateKeyring({ filePath: join(dir, 'edge', 'keyring.json'), role: 'edge', now: () => now });
    const coreIdentity = await core.identity();
    const edgeIdentity = await edge.identity();
    await core.trustPeer(edgeIdentity);
    await edge.trustPeer(coreIdentity);

    const proposal = await core.prepareProposal();
    const proof = await edge.acceptProposal(proposal.proposal);
    await core.verifyProof(proof);
    const newKey = (await core.acceptedSecrets())[0];
    assert.ok(newKey);
    assert.equal(await edge.verifySecret(newKey.secret.toString('base64url')), false, 'Edge must not activate the proposal before Core confirms it');
    await edge.confirmAtEdge(proposal.id);
    await core.markEdgeConfirmed(proposal.id);
    assert.equal(await edge.verifySecret(newKey.secret.toString('base64url')), proposal.id);
    assert.equal(await core.verifySecret(newKey.secret.toString('base64url')), proposal.id);
    assert.equal((await core.status()).rotationState, 'IDLE');

    const saved = JSON.parse(await readFile(join(dir, 'core', 'keyring.json'), 'utf8'));
    assert.equal(saved.pending, null);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'core', 'keyring.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Edge rejects unauthenticated and tampered rotation proposals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-keyring-'));
  try {
    const core = new GateKeyring({ filePath: join(dir, 'core.json'), role: 'core' });
    const edge = new GateKeyring({ filePath: join(dir, 'edge.json'), role: 'edge' });
    await assert.rejects(() => edge.acceptProposal({}), { code: 'gate_peer_not_trusted' });
    await edge.trustPeer(await core.identity());
    await core.trustPeer(await edge.identity());
    const proposal = await core.prepareProposal();
    await assert.rejects(() => edge.acceptProposal({ ...proposal.proposal, ciphertext: 'tampered' }), { code: 'gate_rotation_signature_invalid' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy bootstrap secrets are retired on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-gate-bootstrap-'));
  const filePath = join(dir, 'core.json');
  try {
    const empty = new GateKeyring({ filePath, role: 'core' });
    assert.equal((await empty.status()).keyConfigured, false);
    const legacy = JSON.parse(await readFile(filePath, 'utf8'));
    legacy.active = { id: 'BOOTSTRAP', secret: Buffer.from('old-secret').toString('base64url'), activatedAt: new Date().toISOString() };
    await (await import('node:fs/promises')).writeFile(filePath, JSON.stringify(legacy));
    const restarted = new GateKeyring({ filePath, role: 'core' });
    assert.equal((await restarted.status()).keyConfigured, false);
    assert.equal(await restarted.verifySecret('old-secret'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
