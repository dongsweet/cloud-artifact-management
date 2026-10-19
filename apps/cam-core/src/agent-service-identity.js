import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fingerprint, generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

export async function loadAgentServiceIdentity(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const identity = JSON.parse(await readFile(filePath, 'utf8'));
    if (!identity.privateKeyPem || !identity.publicKeyPem || !identity.fingerprint || fingerprint(identity.publicKeyPem) !== identity.fingerprint) throw new Error('invalid Core Agent service identity');
    if (identity.previousPublicKeyPem && identity.previousFingerprint !== fingerprint(identity.previousPublicKeyPem)) throw new Error('invalid previous Core Agent service identity');
    await chmod(filePath, 0o600);
    return identity;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const identity = generateIdentity();
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  return identity;
}

export async function rotateAgentServiceIdentity(filePath, current, graceHours = 24) {
  const next = generateIdentity();
  const rotated = { ...next, previousPublicKeyPem: current.publicKeyPem, previousFingerprint: current.fingerprint, previousKeyExpiresAt: new Date(Date.now() + graceHours * 3600_000).toISOString() };
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(rotated), { mode: 0o600, flag: 'wx' });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  return rotated;
}
