import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint, generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

export async function loadAgentServiceIdentity(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const identity = JSON.parse(await readFile(filePath, 'utf8'));
    if (!identity.privateKeyPem || !identity.publicKeyPem || !identity.fingerprint || fingerprint(identity.publicKeyPem) !== identity.fingerprint) throw new Error('invalid Core Agent service identity');
    if (identity.previousPublicKeyPem && identity.previousFingerprint !== fingerprint(identity.previousPublicKeyPem)) throw new Error('invalid previous Core Agent service identity');
    if (identity.pendingIdentity && (!identity.pendingIdentity.privateKeyPem || !identity.pendingIdentity.publicKeyPem || fingerprint(identity.pendingIdentity.publicKeyPem) !== identity.pendingIdentity.fingerprint || identity.pendingIdentity.previousFingerprint !== identity.fingerprint || (identity.pendingIdentity.graceHours !== undefined && (!Number.isInteger(identity.pendingIdentity.graceHours) || identity.pendingIdentity.graceHours < 1 || identity.pendingIdentity.graceHours > 168)) || (identity.pendingIdentity.activationDeadlineAt !== undefined && !Number.isFinite(Date.parse(identity.pendingIdentity.activationDeadlineAt))))) throw new Error('invalid pending Core Agent service identity');
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

export async function stageAgentServiceIdentityRotation(filePath, current, graceHours = 24) {
  if (current.pendingIdentity) return current.pendingIdentity;
  const next = generateIdentity();
  if (!Number.isInteger(graceHours) || graceHours < 1 || graceHours > 168) throw new Error('Core 身份过渡期必须为 1–168 小时');
  const createdAt = new Date().toISOString();
  const pendingIdentity = { ...next, rotationId: randomUUID(), previousFingerprint: current.fingerprint, createdAt, graceHours, activationDeadlineAt: new Date(Date.parse(createdAt) + graceHours * 3600_000).toISOString() };
  const updated = { ...current, pendingIdentity };
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  Object.assign(current, updated);
  return pendingIdentity;
}

export function scheduleAgentServiceIdentityActivation(pendingIdentity, onDeadline, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const graceHours = pendingIdentity.graceHours ?? 24;
  const deadline = pendingIdentity.activationDeadlineAt
    ? Date.parse(pendingIdentity.activationDeadlineAt)
    : Date.parse(pendingIdentity.createdAt) + graceHours * 3600_000;
  const timer = setTimer(() => { void onDeadline(); }, Math.max(0, deadline - now()));
  timer?.unref?.();
  return () => clearTimer(timer);
}

export async function activateStagedAgentServiceIdentity(filePath, current, graceHours = 24, { skippedAgentCount = 0 } = {}) {
  const pending = current.pendingIdentity;
  if (!pending) return current;
  const updated = {
    ...pending,
    previousPublicKeyPem: current.publicKeyPem,
    previousFingerprint: current.fingerprint,
    previousKeyExpiresAt: new Date(Date.now() + graceHours * 3600_000).toISOString(),
    pendingIdentity: null,
    lastRotationAt: new Date().toISOString(),
    lastRotationSkippedAgentCount: skippedAgentCount
  };
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  Object.assign(current, updated);
  return current;
}
