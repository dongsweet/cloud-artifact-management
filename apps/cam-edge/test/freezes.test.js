import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildEdgeApp } from '../src/app.js';
import { signedTestHeaders, trustTestPeer } from '../../../libs/cam-gate/test-helper.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

test('completed round report stays immutable while approval is pending and Edge rejects local decisions', async () => {
  let identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT'] };
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-freeze-'));
  const app = await buildEdgeApp({ principalProvider: () => identity, dataDir, defaultChunkSize: 8 });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Stack' } })).json();
  const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0.6.2' } })).json();
  const round = release.initialRound;
  const payload = Buffer.from('package');
  const candidate = (await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { sourceUrl: 'https://example.invalid/package.tar.gz', fileName: 'package.tar.gz', packageKey: 'core', size: payload.length, chunkSize: 8, targets: ['政务外网'] } })).json();
  const part = await app.inject({ method: 'PUT', url: `/api/v1/candidates/${candidate.candidateId}/parts/0`, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(payload) }, payload });
  assert.equal(part.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/candidates/${candidate.candidateId}/complete` })).statusCode, 200);

  const draftResponse = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/freezes`, payload: { reportTitle: 'Stack 8.0.6.2 验证报告', conclusion: 'PASS', environment: '验证环境 A' } });
  assert.equal(draftResponse.statusCode, 201, draftResponse.body);
  const draft = draftResponse.json();
  assert.equal(draft.manifest.items[0].actualSha256, sha256(payload));
  assert.equal(draft.manifestSha256.length, 64);
  const approvalEnvelope = app.freezeStore.approvalEnvelope(draft.freezeId);
  assert.deepEqual([approvalEnvelope.productName, approvalEnvelope.version, approvalEnvelope.roundNo, approvalEnvelope.reportTitle], ['Stack', '8.0.6.2', 1, 'Stack 8.0.6.2 验证报告']);
  const pdf = Buffer.from('%PDF-1.4\nreport');
  identity = { id: 'validator-2', type: 'TEST_IDP', roles: ['VALIDATOR'] };
  const otherValidatorUpload = await app.inject({ method: 'PUT', url: `/api/v1/freezes/${draft.freezeId}/report`, headers: { 'content-type': 'application/pdf', 'x-report-filename': 'verification.pdf' }, payload: pdf });
  assert.equal(otherValidatorUpload.statusCode, 403);
  identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['VALIDATOR', 'CANDIDATE_RECEIVER'] };
  for (const [fileName, contentType] of [['verification.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['verification.wps', 'application/vnd.ms-works'], ['verification.txt', 'text/plain'], ['verification.md', 'text/markdown']]) {
    const bytes = Buffer.from(`validation report ${fileName}`);
    const response = await app.inject({ method: 'PUT', url: `/api/v1/freezes/${draft.freezeId}/report`, headers: { 'content-type': contentType, 'x-report-filename': fileName }, payload: bytes });
    assert.equal(response.statusCode, 200, response.body);
    const downloaded = await app.inject({ url: `/api/v1/freezes/${draft.freezeId}/report-file` });
    assert.equal(downloaded.body, bytes.toString());
  }
  const upload = await app.inject({ method: 'PUT', url: `/api/v1/freezes/${draft.freezeId}/report`, headers: { 'content-type': 'application/pdf', 'x-report-filename': 'verification.pdf' }, payload: pdf });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().reportSha256, sha256(pdf));
  const submitted = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/submit`, payload: {} });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().status, 'PENDING_APPROVAL');
  const freezeDetail = (await app.inject({ method: 'GET', url: `/api/v1/rounds/${round.roundId}/freezes` })).json().item;
  assert.deepEqual([freezeDetail.reportTitle, freezeDetail.conclusion, freezeDetail.environment, freezeDetail.submittedBy], ['Stack 8.0.6.2 验证报告', 'PASS', '验证环境 A', 'validator-1']);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${round.roundId}/candidates/${candidate.candidateId}` })).statusCode, 409);

  const report = await app.inject({ method: 'GET', url: `/api/v1/freezes/${draft.freezeId}/report-file` });
  assert.equal(report.statusCode, 200);
  assert.equal(report.body, pdf.toString());
  identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['VALIDATOR'] };
  const unauthorizedApproval = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/decision`, payload: { decision: 'APPROVE' } });
  assert.equal(unauthorizedApproval.statusCode, 403);
  identity = { id: 'approver-2', type: 'TEST_IDP', roles: ['RELEASE_APPLICANT'] };
  const localApproval = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/decision`, payload: { decision: 'APPROVE' } });
  assert.equal(localApproval.statusCode, 409);
  assert.equal(localApproval.json().error.code, 'cloud_workflow_required');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { sourceUrl: 'https://example.invalid/next.tar.gz', fileName: 'next.tar.gz', packageKey: 'next', size: 0 } })).statusCode, 403);
  await app.close();
});

test('freeze requires every candidate to have completed integrity verification', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-freeze-guards-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'validator', type: 'TEST_IDP', roles: ['CANDIDATE_RECEIVER', 'VALIDATOR'] }), dataDir });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Cloud' } })).json();
  const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
  const round = release.initialRound;
  const incomplete = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { sourceUrl: 'https://example.invalid/a.bin', fileName: 'a.bin', size: 2 } });
  assert.equal(incomplete.statusCode, 201);
  const blocked = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/freezes`, payload: { reportTitle: 'Report', conclusion: 'PASS', environment: 'Test' } });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error.code, 'round_incomplete');
  await app.close();
});

test('Edge accepts only authenticated, idempotent Core approval-result callbacks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-core-result-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'test-admin', type: 'TEST_IDP', roles: ['EDGE_ADMIN', 'CANDIDATE_RECEIVER', 'VALIDATOR'] }) });
  await trustTestPeer(app.gateKeyring, dataDir, 'core');
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Callback product' } })).json();
  const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
  const candidate = (await app.inject({ method: 'POST', url: `/api/v1/rounds/${release.initialRound.roundId}/candidates`, payload: { packageKey: 'base', sourceUrl: 'https://example.invalid/base.tar', fileName: 'base.tar', size: 0 } })).json();
  app.candidateStore.db.prepare("UPDATE candidates SET status = 'COMPLETED', final_sha256 = ?, completed_at = ? WHERE candidate_id = ?").run('b'.repeat(64), new Date().toISOString(), candidate.candidateId);
  const freezeId = 'FREEZE-CALLBACK';
  const now = new Date().toISOString();
  app.candidateStore.db.prepare(`INSERT INTO round_freezes
    (freeze_id, round_id, status, report_title, conclusion, environment, manifest_json, manifest_sha256, submitted_by, submitted_at, created_at, updated_at)
    VALUES (?, ?, 'PENDING_APPROVAL', 'Test report', 'PASS', 'test', '{}', ?, 'validator', ?, ?, ?)`)
    .run(freezeId, release.initialRound.roundId, 'a'.repeat(64), now, now, now);
  const payload = { schemaVersion: 1, type: 'APPROVAL_RESULT', eventId: 'DECISION-1', requestId: freezeId, freezeId, status: 'APPROVED', decidedAt: now };
  try {
    const unpairedDir = `${dataDir}-unpaired`;
    const unpaired = await buildEdgeApp({ dataDir: unpairedDir });
    try {
      const blocked = await unpaired.inject({ method: 'POST', url: '/api/v1/gate/approval-results', payload: {} });
      assert.equal(blocked.statusCode, 503, blocked.body);
      assert.equal(blocked.json().error.code, 'gate_pairing_required');
    } finally { await unpaired.close(); await rm(unpairedDir, { recursive: true, force: true }); }
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-results', payload });
    assert.equal(unauthorized.statusCode, 401);
    const headers = await signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-results', payload);
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-results', headers, payload });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json(), { accepted: true, requestId: freezeId, eventId: payload.eventId, idempotent: false });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-results', headers: await signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-results', payload), payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().idempotent, true);
    const status = await app.inject({ method: 'GET', url: `/api/v1/rounds/${release.initialRound.roundId}/freezes` });
    assert.equal(status.json().item.status, 'APPROVED');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/releases/${release.releaseId}` })).json().status, 'SEALED');
    const nextRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '封存后不允许继续开轮次' } });
    assert.equal(nextRound.statusCode, 409);
    assert.equal(nextRound.json().error.message.includes('已封存'), true);
    const newPackage = await app.inject({ method: 'POST', url: `/api/v1/rounds/${release.initialRound.roundId}/candidates`, payload: { packageKey: 'other', sourceUrl: 'https://example.invalid/other.tar', size: 0 } });
    assert.equal(newPackage.statusCode, 409);
    const alteredRevision = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/revisions`, payload: { version: '1.0.999' } });
    assert.equal(alteredRevision.statusCode, 400);
    assert.equal(alteredRevision.json().error.code, 'revision_version_forbidden');
    const revision = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/revisions`, payload: {} });
    assert.equal(revision.statusCode, 201, revision.body);
    assert.equal(revision.json().revision, 1);
    assert.equal(revision.json().displayVersion, '1.0-r1');
    assert.equal(revision.json().baseReleaseId, release.releaseId);
    assert.equal(revision.json().initialRound.baseRoundId, release.initialRound.roundId);
    assert.equal(revision.json().inheritedPackageCount, 1);
    const inherited = await app.inject({ method: 'GET', url: `/api/v1/rounds/${revision.json().initialRound.roundId}/candidates` });
    assert.equal(inherited.json().items[0].candidateId, candidate.candidateId);
    assert.equal(inherited.json().items[0].mappingSource, 'INHERITED');
    assert.equal('coreApprovalId' in status.json().item, false);
    assert.equal('coreStatus' in status.json().item, false);
    assert.equal('dispatchAttempts' in status.json().item, false);
    assert.equal('dispatchLastError' in status.json().item, false);
  } finally { await app.close(); }
});
