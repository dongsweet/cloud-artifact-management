import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateKeyring } from '../src/keyring.js';

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
