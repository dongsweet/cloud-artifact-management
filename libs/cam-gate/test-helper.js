import { join } from 'node:path';
import { GateKeyring } from './src/keyring.js';

// Test-only setup: emulate the administrator importing the peer identity bundle.
export async function trustTestPeer(keyring, dataDir, peerRole) {
  const peer = new GateKeyring({ filePath: join(dataDir, `.test-${peerRole}-keyring.json`), role: peerRole });
  await keyring.trustPeer(await peer.identity());
  return peer;
}
