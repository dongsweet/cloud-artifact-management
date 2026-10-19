import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, fingerprint: fingerprint(publicKeyPem) };
}
export function fingerprint(publicKeyPem) { return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex'); }
export function bodyHash(body = '') { return createHash('sha256').update(body).digest('hex'); }
export function canonical(method, path, timestamp, nonce, body = '') { return [method.toUpperCase(), path, timestamp, nonce, bodyHash(body)].join('\n'); }
export function signRequest(privateKeyPem, method, path, timestamp, nonce, body = '') { return sign(null, Buffer.from(canonical(method, path, timestamp, nonce, body)), createPrivateKey(privateKeyPem)).toString('base64url'); }
export function verifyRequest(publicKeyPem, signature, method, path, timestamp, nonce, body = '') { try { return verify(null, Buffer.from(canonical(method, path, timestamp, nonce, body)), createPublicKey(publicKeyPem), Buffer.from(signature ?? '', 'base64url')); } catch { return false; } }
export function randomNonce() { return randomBytes(16).toString('base64url'); }
