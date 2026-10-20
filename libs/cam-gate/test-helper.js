import { join } from 'node:path';
import { GateKeyring } from './src/keyring.js';

// Test-only setup: emulate the administrator importing the peer identity bundle.
export async function trustTestPeer(keyring, dataDir, peerRole) {
  const peer = new GateKeyring({ filePath: join(dataDir, `.test-${peerRole}-keyring.json`), role: peerRole });
  await keyring.trustPeer(await peer.identity());
  await peer.trustPeer(await keyring.identity());
  await keyring.markPeerConfirmed();
  await peer.markPeerConfirmed();
  keyring.testPeerKeyring = peer;
  peer.testPeerKeyring = keyring;
  return peer;
}

export async function signedTestHeaders(keyring, method, path, payload = '', extra = {}) {
  const body = payload === '' || payload === undefined ? '' : typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  return keyring.testPeerKeyring.requestHeaders(method, path, body, extra, extra['x-cam-chunk-sha256'] ? { bodyDigest: extra['x-cam-chunk-sha256'] } : {});
}
