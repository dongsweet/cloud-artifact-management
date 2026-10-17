import { join } from 'node:path';
import { GateKeyring } from './src/keyring.js';

// Test-only setup: emulate the administrator importing the peer identity bundle.
export async function trustTestPeer(keyring, dataDir, peerRole) {
  const peer = new GateKeyring({ filePath: join(dataDir, `.test-${peerRole}-keyring.json`), role: peerRole });
  await keyring.trustPeer(await peer.identity());
  await peer.trustPeer(await keyring.identity());
  const core = keyring.role === 'core' ? keyring : peer;
  const edge = keyring.role === 'edge' ? keyring : peer;
  const proposal = await core.prepareProposal();
  const proof = await edge.acceptProposal(proposal.proposal);
  await core.verifyProof(proof);
  await edge.confirmAtEdge(proposal.id);
  await core.markEdgeConfirmed(proposal.id);
  const now = new Date().toISOString();
  for (const local of [keyring, peer]) {
    local.state.active = { id: 'TEST', secret: Buffer.from('gate-test').toString('base64url'), activatedAt: now };
  }
  return peer;
}
