import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';
import { activateStagedAgentServiceIdentity, loadAgentServiceIdentity, scheduleAgentServiceIdentityActivation, stageAgentServiceIdentityRotation } from '../src/agent-service-identity.js';

test('staged Core identity activates at the configured grace deadline and records skipped Agents', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-identity-deadline-'));
  const identityPath = join(dataDir, 'core-agent-identity.json');
  try {
    await writeFile(identityPath, JSON.stringify(generateIdentity()), { mode: 0o600 });
    const current = await loadAgentServiceIdentity(identityPath);
    const pending = await stageAgentServiceIdentityRotation(identityPath, current, 3);
    assert.equal(Date.parse(pending.activationDeadlineAt) - Date.parse(pending.createdAt), 3 * 3600_000);

    let fireDeadline;
    let scheduledDelay;
    const activated = new Promise((resolve, reject) => {
      scheduleAgentServiceIdentityActivation(pending, () => activateStagedAgentServiceIdentity(identityPath, current, pending.graceHours, { skippedAgentCount: 2 }).then(resolve, reject), {
        now: () => Date.parse(pending.createdAt),
        setTimer: (callback, delay) => { fireDeadline = callback; scheduledDelay = delay; return { unref() {} }; },
        clearTimer: () => {}
      });
    });
    assert.equal(scheduledDelay, 3 * 3600_000);
    fireDeadline();

    const result = await activated;
    assert.notEqual(result.fingerprint, pending.previousFingerprint);
    assert.equal(result.pendingIdentity, null);
    const persisted = JSON.parse(await readFile(identityPath, 'utf8'));
    assert.equal(persisted.lastRotationSkippedAgentCount, 2);
    assert.equal((await loadAgentServiceIdentity(identityPath)).fingerprint, result.fingerprint);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
