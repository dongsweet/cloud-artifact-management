import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GateKeyring } from '../../../libs/cam-gate/src/keyring.js';
import { buildEdgeApp } from '../src/app.js';

test('Edge accepts the first key confirmation after mutual identity pairing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-pairing-'));
  const app = await buildEdgeApp({ dataDir });
  const core = new GateKeyring({ filePath: join(dataDir, 'test-core', 'gate-keyring.json'), role: 'core' });
  try {
    await core.trustPeer(await app.gateKeyring.identity());
    await app.gateKeyring.trustPeer(await core.identity());
    assert.equal((await core.status()).keyConfigured, false);
    assert.equal((await app.gateKeyring.status()).keyConfigured, false);

    const pending = await core.prepareProposal();
    const proposal = await app.inject({ method: 'POST', url: '/api/v1/gate/key-rotation/proposals', payload: pending.proposal });
    assert.equal(proposal.statusCode, 200, proposal.body);
    await core.verifyProof(proposal.json());

    const secret = await core.currentSecret();
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/gate/key-rotation/proposals/${encodeURIComponent(pending.id)}/confirm`,
      headers: { 'x-cam-gate-secret': secret.toString('base64url') },
      payload: { keyId: pending.id }
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    await core.markEdgeConfirmed(pending.id);

    assert.equal((await app.gateKeyring.status()).keyConfigured, true);
    assert.equal((await core.status()).keyConfigured, true);
    assert.equal(await app.gateKeyring.verifySecret(secret.toString('base64url')), pending.id);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
