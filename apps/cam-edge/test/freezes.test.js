import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildEdgeApp } from '../src/app.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

test('completed round can be submitted with a PDF report, approved by another user, and stays immutable', async () => {
  let identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT'] };
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-freeze-'));
  const app = await buildEdgeApp({ principalProvider: () => identity, dataDir, defaultChunkSize: 8 });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Stack' } })).json();
  const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0.6.2' } })).json();
  const round = (await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: {} })).json();
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
  const pdf = Buffer.from('%PDF-1.4\nreport');
  identity = { id: 'validator-2', type: 'TEST_IDP', roles: ['VALIDATOR'] };
  const otherValidatorUpload = await app.inject({ method: 'PUT', url: `/api/v1/freezes/${draft.freezeId}/report`, headers: { 'content-type': 'application/octet-stream', 'x-report-filename': 'verification.pdf' }, payload: pdf });
  assert.equal(otherValidatorUpload.statusCode, 403);
  identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['VALIDATOR', 'CANDIDATE_RECEIVER'] };
  const upload = await app.inject({ method: 'PUT', url: `/api/v1/freezes/${draft.freezeId}/report`, headers: { 'content-type': 'application/octet-stream', 'x-report-filename': 'verification.pdf' }, payload: pdf });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().reportSha256, sha256(pdf));
  const submitted = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/submit`, payload: {} });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().status, 'PENDING_APPROVAL');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${round.roundId}/candidates/${candidate.candidateId}` })).statusCode, 409);

  const report = await app.inject({ method: 'GET', url: `/api/v1/freezes/${draft.freezeId}/report-file` });
  assert.equal(report.statusCode, 200);
  assert.equal(report.body, pdf.toString());
  identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['VALIDATOR'] };
  const unauthorizedApproval = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/decision`, payload: { decision: 'APPROVE' } });
  assert.equal(unauthorizedApproval.statusCode, 403);
  identity = { id: 'validator-1', type: 'TEST_IDP', roles: ['RELEASE_APPLICANT'] };
  const selfApproval = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/decision`, payload: { decision: 'APPROVE' } });
  assert.equal(selfApproval.statusCode, 409);

  identity = { id: 'approver-2', type: 'TEST_IDP', roles: ['RELEASE_APPLICANT'] };
  const approved = await app.inject({ method: 'POST', url: `/api/v1/freezes/${draft.freezeId}/decision`, payload: { decision: 'APPROVE', reference: 'UC-1234', comment: '审批通过' } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().status, 'APPROVED');
  assert.equal(approved.json().decisionReference, 'UC-1234');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { sourceUrl: 'https://example.invalid/next.tar.gz', fileName: 'next.tar.gz', packageKey: 'next', size: 0 } })).statusCode, 403);
  await app.close();
});

test('freeze requires every candidate to have completed integrity verification', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-freeze-guards-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'validator', type: 'TEST_IDP', roles: ['CANDIDATE_RECEIVER', 'VALIDATOR'] }), dataDir });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Cloud' } })).json();
  const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
  const round = (await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: {} })).json();
  const incomplete = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { sourceUrl: 'https://example.invalid/a.bin', fileName: 'a.bin', size: 2 } });
  assert.equal(incomplete.statusCode, 201);
  const blocked = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/freezes`, payload: { reportTitle: 'Report', conclusion: 'PASS', environment: 'Test' } });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error.code, 'round_incomplete');
  await app.close();
});
