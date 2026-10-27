import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCoreLogCollection } from '../src/log-collection.js';
import { buildLogBundle, unpackTarGz } from '../../../libs/cam-server/src/log-bundle.js';

test('Core keeps Agent logs in separate name-based directories', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-log-collection-'));
  const jobId = 'LOG-TEST';
  const baseDir = join(dataDir, 'incoming');
  const makeAgentBundle = async (agentId, line) => {
    const path = join(baseDir, `${agentId}.tar.gz`);
    await (await import('node:fs/promises')).mkdir(baseDir, { recursive: true });
    await writeFile(path, buildLogBundle({ source: 'agent-aggregate', entries: [{ name: 'runtime.jsonl', data: Buffer.from(`${line}\n`) }] }));
    return path;
  };
  const files = [
    { agentId: 'AG-1', agentName: '测试中心1/ag1', centerId: '测试中心1', bundlePath: await makeAgentBundle('AG-1', '{"agent":"AG-1","msg":"one"}') },
    { agentId: 'AG-2', agentName: '测试中心2/ag2', centerId: '测试中心2', bundlePath: await makeAgentBundle('AG-2', '{"agent":"AG-2","msg":"two"}') }
  ];
  let result = { jobId, status: 'PACKAGING', fromAt: '2026-01-01T00:00:00.000Z', toAt: '2026-01-01T01:00:00.000Z', categories: ['runtime'] };
  const store = {
    dataDir,
    getLogCollection: () => result,
    listAgentLogCollectionFiles: () => files,
    setLogCollectionBundle: (_id, value) => { result = { ...result, status: value.status, bundlePath: value.path, bundleSha256: value.sha256, bundleSize: value.size }; return result; }
  };
  await buildCoreLogCollection(store, jobId);
  const entries = unpackTarGz(await readFile(result.bundlePath));
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('agents/测试中心1_ag1/runtime.jsonl'));
  assert.ok(names.includes('agents/测试中心2_ag2/runtime.jsonl'));
  assert.equal(names.includes('agents/runtime.jsonl'), false);
  assert.match(entries.find((entry) => entry.name === 'agents/测试中心1_ag1/runtime.jsonl').data.toString(), /AG-1/);
  assert.match(entries.find((entry) => entry.name === 'agents/测试中心2_ag2/runtime.jsonl').data.toString(), /AG-2/);
});

test('Core preserves the selected log categories for each Agent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-log-categories-'));
  const baseDir = join(dataDir, 'incoming');
  await (await import('node:fs/promises')).mkdir(baseDir, { recursive: true });
  const bundlePath = join(baseDir, 'agent.tar.gz');
  const source = [
    '{"level":30,"msg":"服务已启动"}',
    '{"level":30,"transferTaskId":"TR-1","msg":"传输分块"}',
    '{"level":50,"msg":"传输失败"}'
  ].join('\n');
  await writeFile(bundlePath, buildLogBundle({ source: 'agent-aggregate', entries: [{ name: 'runtime.jsonl', data: Buffer.from(`${source}\n`) }] }));
  let result = { jobId: 'LOG-CATEGORIES', status: 'PACKAGING', fromAt: '2026-01-01T00:00:00.000Z', toAt: '2026-01-01T01:00:00.000Z', categories: ['runtime', 'transfer', 'error'] };
  const store = {
    dataDir,
    getLogCollection: () => result,
    listAgentLogCollectionFiles: () => [{ agentId: 'AG-1', agentName: 'ag1', centerId: 'center', bundlePath }],
    setLogCollectionBundle: (_id, value) => { result = { ...result, status: value.status, bundlePath: value.path, bundleSha256: value.sha256, bundleSize: value.size }; return result; }
  };
  await buildCoreLogCollection(store, result.jobId);
  const entries = unpackTarGz(await readFile(result.bundlePath));
  assert.ok(entries.some((entry) => entry.name === 'agents/ag1/runtime.jsonl'));
  assert.match(entries.find((entry) => entry.name === 'agents/ag1/transfer.jsonl').data.toString(), /TR-1/);
  assert.match(entries.find((entry) => entry.name === 'agents/ag1/error.jsonl').data.toString(), /传输失败/);
});
