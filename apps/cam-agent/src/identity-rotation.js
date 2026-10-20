import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fingerprint, generateIdentity, signRequest, verifyRequest } from '../../../libs/cam-agent-auth/src/protocol.js';

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
}
function validateIdentity(identity) {
  const signature = signRequest(identity.privateKeyPem, 'GET', '/identity', '', '');
  if (!verifyRequest(identity.publicKeyPem, signature, 'GET', '/identity', '', '')) throw new Error('Agent 身份文件中的公私钥不匹配');
  return { ...identity, fingerprint: fingerprint(identity.publicKeyPem) };
}
export async function loadAgentIdentity(path) {
  const saved = await readJson(path);
  if (saved !== undefined) return validateIdentity(saved);
  const identity = generateIdentity();
  await saveJson(path, identity);
  return identity;
}

// Core supplies policy; Agent keeps private keys locally and makes all outbound
// requests. A pending key survives retries, lost responses and process restarts.
export async function createIdentityRotation({ identityPath, identity: initial, request, onIdentity, onAgentId, now = Date.now }) {
  let identity = initial;
  const pendingPath = `${identityPath}.pending`;
  const statePath = `${identityPath}.rotation`;
  let pending = await readJson(pendingPath);
  if (pending !== undefined) pending = validateIdentity(pending);
  let state = await readJson(statePath) ?? { attempts: 0, retryAt: null, lastError: null, policy: null };
  state.agentId ??= state.policy?.agentId;
  if (state.agentId) onAgentId?.(state.agentId);
  let inFlight;
  const call = async (path, options, signer) => (await (await request(path, options, signer)).json()).item;
  const rememberAgentId = async (id) => {
    if (typeof id !== 'string' || !id || state.agentId === id) return;
    state = { ...state, agentId: id };
    await saveJson(statePath, state);
    onAgentId?.(id);
  };
  const confirm = async () => {
    const policy = await call('/api/v1/agent/identity/confirm', { method: 'POST' });
    state = { ...state, requested: false, attempts: 0, retryAt: null, lastError: null, policy, checkedAt: new Date(now()).toISOString() };
    await saveJson(statePath, state);
  };
  async function run(force) {
      const requested = force || state.requested;
      if (pending) {
        // Probe with the durable new key first. This also recovers after the
        // old key's grace period has elapsed, without needing the lost reply.
        let accepted = false;
        try {
          const policy = await call('/api/v1/agent/identity', {}, pending);
          accepted = policy.keyId === pending.fingerprint;
          if (accepted) await rememberAgentId(policy.agentId);
        }
        catch (error) { if (error.status !== 401) throw error; }
        if (!accepted) {
          await call('/api/v1/agent/key-rotation', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ publicKey: pending.publicKeyPem, expectedKeyId: identity.fingerprint }), proofKey: pending
          });
        }
        await rename(pendingPath, identityPath);
        identity = pending; pending = null; onIdentity(identity);
        await confirm();
        return;
      }
      const policy = await call('/api/v1/agent/identity', {});
      await rememberAgentId(policy.agentId);
      if (policy.keyId !== identity.fingerprint) throw Object.assign(new Error('Core 当前公钥与本机身份不一致，请检查配对'), { code: 'agent_identity_mismatch' });
      state.policy = policy;
      if (!policy.confirmedAt || state.lastError) await confirm();
      if (requested || policy.rotationDue) {
        const next = generateIdentity();
        await saveJson(pendingPath, next);
        pending = next;
        await run(false);
      } else {
        state = { ...state, attempts: 0, retryAt: null, lastError: null, checkedAt: new Date(now()).toISOString() };
        await saveJson(statePath, state);
      }
  }
  async function sync({ force = false, ignoreBackoff = false } = {}) {
    if (inFlight) {
      if (force) throw Object.assign(new Error('身份正在同步，请稍后重试'), { status: 409, code: 'agent_rotation_busy' });
      return inFlight;
    }
    if (!force && !ignoreBackoff && !pending && state.retryAt && Date.parse(state.retryAt) > now()) return;
    inFlight = (async () => {
      try { if (force) { state.requested = true; await saveJson(statePath, state); } await run(force); }
      catch (error) {
        const attempts = state.attempts + 1;
        state = { ...state, attempts, retryAt: new Date(now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6))).toISOString(), lastError: String(error.message).slice(0, 1000) };
        await saveJson(statePath, state);
        await call('/api/v1/agent/identity/failure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: state.lastError, attempts, retryAt: state.retryAt }) }).catch(() => {});
        throw error;
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  const resetConnection = async () => {
    if (inFlight) throw Object.assign(new Error('身份正在同步，请稍后重试'), { status: 409, code: 'agent_rotation_busy' });
    state = { ...state, attempts: 0, retryAt: null, lastError: null, policy: null, checkedAt: null };
    await saveJson(statePath, state);
  };
  return { sync, resetConnection, status: () => ({ ...state, agentId: state.agentId ?? null, pending: Boolean(pending), rotating: Boolean(inFlight), paired: Boolean(state.policy?.confirmedAt) && !state.lastError }) };
}
