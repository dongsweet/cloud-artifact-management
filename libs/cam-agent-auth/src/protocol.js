import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, fingerprint: fingerprint(publicKeyPem) };
}
export function fingerprint(publicKeyPem) { const key = createPublicKey(publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Agent identity must use Ed25519'); return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'); }
export function bodyHash(body = '') { return createHash('sha256').update(body).digest('hex'); }
export function canonical(method, path, timestamp, nonce, body = '') { return [method.toUpperCase(), path, timestamp, nonce, bodyHash(body)].join('\n'); }
export function signRequest(privateKeyPem, method, path, timestamp, nonce, body = '') { return sign(null, Buffer.from(canonical(method, path, timestamp, nonce, body)), createPrivateKey(privateKeyPem)).toString('base64url'); }
export function verifyRequest(publicKeyPem, signature, method, path, timestamp, nonce, body = '') { try { return verify(null, Buffer.from(canonical(method, path, timestamp, nonce, body)), createPublicKey(publicKeyPem), Buffer.from(signature ?? '', 'base64url')); } catch { return false; } }
export function canonicalResponse(status, method, path, requestNonce, timestamp, body = '') { return [String(status), method.toUpperCase(), path, requestNonce, timestamp, bodyHash(body)].join('\n'); }
export function signResponse(privateKeyPem, status, method, path, requestNonce, timestamp, body = '') { return sign(null, Buffer.from(canonicalResponse(status, method, path, requestNonce, timestamp, body)), createPrivateKey(privateKeyPem)).toString('base64url'); }
export function verifyResponse(publicKeyPem, signature, status, method, path, requestNonce, timestamp, body = '') { try { return verify(null, Buffer.from(canonicalResponse(status, method, path, requestNonce, timestamp, body)), createPublicKey(publicKeyPem), Buffer.from(signature ?? '', 'base64url')); } catch { return false; } }
export function randomNonce() { return randomBytes(16).toString('base64url'); }
