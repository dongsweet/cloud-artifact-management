import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';
import { CloudAdapter, EOMS_PATHS } from '../src/cloud-adapter.js';

function cloudResponse(data, code = 0, msg = '操作成功') {
  return new Response(JSON.stringify({ code, msg, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('cloud config test reports the failed field and writes credential-free Core diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-cloud-diagnostics-'));
  const logDir = join(root, 'logs');
  const previousLogDir = process.env.CAM_LOG_DIR;
  process.env.CAM_LOG_DIR = logDir;
  const secret = 'do-not-write-this-secret';
  const cloudEnv = {
    CAM_CLOUD_WORK_ORDER_PRIORITY_LABEL: '常规变更',
    CAM_CLOUD_WORK_ORDER_SOURCE_LABEL: '内部需求',
    CAM_CLOUD_WORK_ORDER_BUSINESS_TYPE_PATH: '平台类/其他',
    CAM_CLOUD_WORK_ORDER_DEPT_NAME: '统一运维中心',
    CAM_CLOUD_WORK_ORDER_TEAM_NAME: '平台运维',
    CAM_CLOUD_WORK_ORDER_PROCESS_USER_NAMES: 'sheshx'
  };
  const cloud = new CloudAdapter({
    baseUrl: 'https://cloud.test/eoms',
    authUserId: '2308',
    authSecret: secret,
    tlsInsecure: true,
    env: cloudEnv,
    fetchImpl: async (input) => {
      const path = new URL(input).pathname;
      if (path === `/eoms${EOMS_PATHS.priorities}`) return cloudResponse([{ id: 394, dictLabel: '常规变更', childless: [] }]);
      if (path === `/eoms${EOMS_PATHS.sources}`) return cloudResponse([{ id: 402, dictLabel: '内部需求', childless: [] }]);
      if (path === `/eoms${EOMS_PATHS.businessTypes}`) return cloudResponse([{ id: 230, dictLabel: '平台类', childless: [{ id: 231, dictLabel: '其他', childless: [] }] }]);
      if (path === `/eoms${EOMS_PATHS.departments}`) return cloudResponse(null, 500, '服务异常');
      if (path === `/eoms${EOMS_PATHS.teams}`) return cloudResponse({ rows: [{ id: 3, teamName: '平台运维' }] });
      throw new Error(`Unexpected cloud path: ${path}`);
    }
  });
  let app;
  try {
    app = await buildCoreApp({ dataDir: join(root, 'data'), cloudAdapter: cloud, enableAuth: false });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/test',
      payload: {
        priorityLabel: '常规变更',
        sourceLabel: '内部需求',
        businessTypePath: '平台类/其他',
        deptName: '统一运维中心',
        teamName: '平台运维',
        processUserNames: 'sheshx'
      }
    });

    assert.equal(response.statusCode, 502, response.body);
    assert.match(response.json().error.message, /部门\/中心列表查询失败/u);
    assert.match(response.json().error.message, /code 500/u);
    assert.match(response.json().error.message, /服务异常/u);
  } finally {
    await app?.close();
    await cloud.dispatcher?.close();
    if (previousLogDir === undefined) delete process.env.CAM_LOG_DIR;
    else process.env.CAM_LOG_DIR = previousLogDir;
  }

  try {
    const logs = await readFile(join(logDir, 'cam-core.jsonl'), 'utf8');
    const diagnostic = logs.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      .find((entry) => entry.msg === '云管连接或字典校验失败');
    assert.ok(diagnostic, 'failure diagnostic should be written to Core application logs');
    assert.equal(diagnostic.operation, '部门/中心列表');
    assert.equal(diagnostic.path, `/eoms${EOMS_PATHS.departments}`);
    assert.equal(diagnostic.httpStatus, 200);
    assert.equal(diagnostic.contentType, 'application/json');
    assert.equal(diagnostic.failureType, 'business_error');
    assert.equal(diagnostic.upstreamCode, '500');
    assert.match(diagnostic.message, /服务异常/u);
    assert.doesNotMatch(logs, /do-not-write-this-secret/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
