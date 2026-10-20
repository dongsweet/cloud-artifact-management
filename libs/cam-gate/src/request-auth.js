import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value ?? '').digest('hex');
const canonical = (method, path, timestamp, nonce, bodyDigest) => [method.toUpperCase(), path, timestamp, nonce, bodyDigest].join('\n');

export function gateBodyDigest(body = '') { return hash(body); }

export function signGateRequest(privateKey, method, path, body = '', { timestamp = new Date().toISOString(), nonce = randomBytes(18).toString('base64url'), bodyDigest = gateBodyDigest(body) } = {}) {
  const signature = sign(null, Buffer.from(canonical(method, path, timestamp, nonce, bodyDigest)), createPrivateKey(privateKey)).toString('base64url');
  return {
    'x-cam-gate-timestamp': timestamp,
    'x-cam-gate-nonce': nonce,
    'x-cam-gate-content-sha256': bodyDigest,
    'x-cam-gate-signature': signature
  };
}

export function verifyGateRequest(publicKey, headers, method, path, body = '', { now = Date.now(), toleranceMs = 5 * 60_000, bodyDigest } = {}) {
  try {
    const timestamp = headers['x-cam-gate-timestamp'];
    const nonce = headers['x-cam-gate-nonce'];
    const digest = headers['x-cam-gate-content-sha256'];
    const signature = headers['x-cam-gate-signature'];
    const at = Date.parse(timestamp);
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !Number.isFinite(at) || Math.abs(now - at) > toleranceMs || !/^[a-f0-9]{64}$/.test(digest ?? '') || typeof signature !== 'string') return false;
    if (bodyDigest ? bodyDigest !== digest : hash(body) !== digest) return false;
    return verify(null, Buffer.from(canonical(method, path, timestamp, nonce, digest)), createPublicKey(publicKey), Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
