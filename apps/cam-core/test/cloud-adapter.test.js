import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalStatus, CloudAdapter, EOMS_PATHS, readConfig } from '../src/cloud-adapter.js';

const env = {
  CAM_CLOUD_WORK_ORDER_PRIORITY_LABEL: '常规变更',
  CAM_CLOUD_WORK_ORDER_PRIORITY_VALUE: '',
  CAM_CLOUD_WORK_ORDER_SOURCE_LABEL: '内部需求',
  CAM_CLOUD_WORK_ORDER_SOURCE_VALUE: '',
  CAM_CLOUD_WORK_ORDER_BUSINESS_TYPE_PATH: '平台类/其他',
  CAM_CLOUD_WORK_ORDER_DEPT_NAME: '成都',
  CAM_CLOUD_WORK_ORDER_TEAM_NAME: 'OpenStack平台运维',
  CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS: '',
  CAM_CLOUD_WORK_ORDER_TITLE_PREFIX: '云平台制品验证报告审批'
};

function response(data, code = 0, status = 200) {
  return new Response(JSON.stringify({ code, msg: code === 0 ? '操作成功' : '失败', data }), { status, headers: { 'content-type': 'application/json' } });
}

test('Core business configuration accepts usernames instead of numeric IDs', () => {
  const config = readConfig(env, { ...env, processUserNames: 'zhuren_luan' });
  assert.deepEqual(config.processUserNames, ['zhuren_luan']);
  assert.deepEqual(config.legacyProcessUserIds, []);
});

test('CloudAdapter resolves environment-specific IDs and creates an EOMS work order', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === EOMS_PATHS.priorities && parsed.searchParams.get('dictType') === 'demand_ticket') return response([{ id: 394, dictLabel: '常规变更', dictValue: 'normal', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.sources && parsed.searchParams.get('dictType') === 'work_order_source') return response([{ id: 402, dictLabel: '内部需求', dictValue: 'internal', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.businessTypes) return response([{ id: 230, dictLabel: '平台类', childless: [{ id: 231, dictLabel: '其他', dictValue: 'other', childless: [] }] }]);
    if (parsed.pathname === EOMS_PATHS.departments) return response({ defaultCenterDept: 215, centerList: [{ deptId: 215, deptName: '成都' }] });
    if (parsed.pathname === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    if (parsed.pathname === EOMS_PATHS.responsiblePersons) {
      assert.equal(parsed.searchParams.get('deptId'), '215');
      assert.equal(parsed.searchParams.get('isAll'), 'true');
      assert.equal(parsed.searchParams.get('userType'), 'true');
      // The API includes multi-department processors for the requested dept,
      // even when their primary department differs.
      return response([{ userId: 2308, userName: 'zhuren_luan', deptId: 221 }]);
    }
    if (parsed.pathname === EOMS_PATHS.create) return response('20261012D1234');
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env: { ...env, CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS: '2308' }, fetchImpl });
  const result = await adapter.createApproval({ requestId: 'FREEZE-1', releaseId: 'REL-1', roundId: 'ROUND-1', conclusion: 'PASS', manifestSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), reportFileName: 'report.pdf' }, { ...env, processUserNames: 'zhuren_luan' });
  assert.equal(result.approvalId, '20261012D1234');
  assert.equal(result.mappingSnapshot.priority.id, '394');
  assert.equal(result.mappingSnapshot.businessType.id, '231');
  assert.deepEqual(result.mappingSnapshot.processUserIds, ['2308']);
  assert.equal(result.requestBody.deptId, 215);
  assert.equal(result.requestBody.teamId, 3);
  assert.equal(result.requestBody.processWorkOrder, '2308');
  assert.equal(result.requestBody.priority, '394');
  assert.equal(result.requestBody.businessType, '231');
  assert.equal(result.requestBody.workOrderSource, '402');
  assert.deepEqual(result.mappingSnapshot.processUsers, [{ userId: '2308', username: 'zhuren_luan' }]);
  assert.ok(calls.some(({ url }) => new URL(url).pathname === EOMS_PATHS.responsiblePersons));
  assert.ok(calls.every(({ options }) => options.headers['x-auth-secret'] === 'secret' && options.headers['x-auth-userid'] === '2308'));
});

test('CloudAdapter requires the complete business type path returned by EOMS', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === EOMS_PATHS.priorities && parsed.searchParams.get('dictType') === 'demand_ticket') return response([{ id: 394, dictLabel: '常规变更', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.sources && parsed.searchParams.get('dictType') === 'work_order_source') return response([{ id: 402, dictLabel: '内部需求', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.businessTypes) return response([{ id: 47, dictLabel: 'OpenStack平台系统类', childless: [{ id: 230, dictLabel: '平台类-其他', childless: [] }] }]);
    if (parsed.pathname === EOMS_PATHS.departments) return response({ centerList: [{ deptId: 215, deptName: '成都' }] });
    if (parsed.pathname === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    if (parsed.pathname === EOMS_PATHS.responsiblePersons) return response([{ userId: 2308, userName: 'zhuren_luan', deptId: 215 }]);
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env, fetchImpl });
  const mappings = await adapter.resolveMappings({ ...env, processUserNames: 'zhuren_luan', businessTypePath: 'OpenStack平台系统类/平台类-其他' });
  assert.equal(mappings.businessType.id, '230');
  assert.equal(mappings.businessType.path, 'OpenStack平台系统类/平台类-其他');
  await assert.rejects(adapter.resolveMappings({ ...env, processUserNames: 'zhuren_luan', businessTypePath: '平台类/其他' }), /matched 0 leaf dictionary records/);
});

test('CloudAdapter permits a multi-department processor returned for the work-order department', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === EOMS_PATHS.priorities && parsed.searchParams.get('dictType') === 'demand_ticket') return response([{ id: 394, dictLabel: '常规变更', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.sources && parsed.searchParams.get('dictType') === 'work_order_source') return response([{ id: 402, dictLabel: '内部需求', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.businessTypes) return response([{ id: 47, dictLabel: 'OpenStack平台系统类', childless: [{ id: 230, dictLabel: '平台类-其他', childless: [] }] }]);
    if (parsed.pathname === EOMS_PATHS.departments) return response({ centerList: [{ deptId: 215, deptName: '成都' }] });
    if (parsed.pathname === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    if (parsed.pathname === EOMS_PATHS.responsiblePersons) {
      assert.equal(parsed.searchParams.get('deptId'), '215');
      return response([{ userId: 2249, userName: 'zhuren_luan', deptId: 230 }]);
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env, fetchImpl });
  const mappings = await adapter.resolveMappings({ ...env, processUserNames: 'zhuren_luan', businessTypePath: 'OpenStack平台系统类/平台类-其他' });
  assert.deepEqual(mappings.processUsers, [{ userId: '2249', username: 'zhuren_luan' }]);
});

test('CloudAdapter rejects ambiguous or non-leaf mappings before creating a work order', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === EOMS_PATHS.priorities) return response([{ id: 1, dictLabel: '常规变更', childless: [] }, { id: 2, dictLabel: '常规变更', childless: [] }]);
    if (path === EOMS_PATHS.sources) return response([{ id: 402, dictLabel: '内部需求', childless: [] }]);
    if (path === EOMS_PATHS.businessTypes) return response([{ id: 230, dictLabel: '平台类', childless: [{ id: 231, dictLabel: '其他', childless: [] }] }]);
    if (path === EOMS_PATHS.departments) return response({ centerList: [{ deptId: 215, deptName: '成都' }] });
    if (path === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    throw new Error('create must not be called when mapping is ambiguous');
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env: { ...env, CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS: '2308' }, fetchImpl });
  await assert.rejects(adapter.createApproval({ requestId: 'FREEZE-1' }), /priority mapping/);
});

test('CloudAdapter fails closed when a processor username is missing or ambiguous', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === EOMS_PATHS.priorities && parsed.searchParams.get('dictType') === 'demand_ticket') return response([{ id: 394, dictLabel: '常规变更', childless: [] }]);
    if (path === EOMS_PATHS.sources && parsed.searchParams.get('dictType') === 'work_order_source') return response([{ id: 402, dictLabel: '内部需求', childless: [] }]);
    if (path === EOMS_PATHS.businessTypes) return response([{ id: 230, dictLabel: '平台类', childless: [{ id: 231, dictLabel: '其他', childless: [] }] }]);
    if (path === EOMS_PATHS.departments) return response({ centerList: [{ deptId: 215, deptName: '成都' }] });
    if (path === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    if (path === EOMS_PATHS.responsiblePersons) return response([{ userId: 1, userName: 'zhuren_luan' }, { userId: 2, userName: 'zhuren_luan' }]);
    throw new Error('unexpected request');
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env, fetchImpl });
  const mappingConfig = { priorityLabel: '常规变更', sourceLabel: '内部需求', businessTypePath: '平台类/其他', deptName: '成都', teamName: 'OpenStack平台运维' };
  await assert.rejects(adapter.resolveMappings({ ...mappingConfig, processUserNames: 'unknown_user' }), /匹配到 0 个用户/);
  await assert.rejects(adapter.resolveMappings({ ...mappingConfig, processUserNames: 'zhuren_luan' }), /匹配到 2 个用户/);
});

test('CloudAdapter refuses to create a work order without a configured processor', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === EOMS_PATHS.priorities && parsed.searchParams.get('dictType') === 'demand_ticket') return response([{ id: 394, dictLabel: '常规变更', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.sources && parsed.searchParams.get('dictType') === 'work_order_source') return response([{ id: 402, dictLabel: '内部需求', childless: [] }]);
    if (parsed.pathname === EOMS_PATHS.businessTypes) return response([{ id: 230, dictLabel: '平台类', childless: [{ id: 231, dictLabel: '其他', childless: [] }] }]);
    if (parsed.pathname === EOMS_PATHS.departments) return response({ centerList: [{ deptId: 215, deptName: '成都' }] });
    if (parsed.pathname === EOMS_PATHS.teams) return response({ rows: [{ id: 3, teamName: 'OpenStack平台运维' }] });
    throw new Error('work-order creation must not be attempted without processors');
  };
  const adapter = new CloudAdapter({
    baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret',
    env: { ...env, CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS: '', CAM_CLOUD_WORK_ORDER_PROCESS_USER_NAMES: '' }, fetchImpl
  });
  await assert.rejects(adapter.createApproval({ requestId: 'FREEZE-1' }), { code: 'cloud_mapping_not_configured' });
  assert.equal(calls.filter((path) => path === EOMS_PATHS.create).length, 0);
});

test('CloudAdapter rejects department and team IDs that JavaScript cannot represent exactly', () => {
  const adapter = new CloudAdapter({ env: { ...env, CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS: '2308' } });
  assert.throws(() => adapter.buildWorkOrder({ requestId: 'FREEZE-1' }, {
    priority: { id: '394' },
    businessType: { id: '231' },
    source: { id: '402' },
    dept: { id: '9007199254740993' },
    team: { id: '3' },
    processUserIds: ['2308']
  }), /safe integer range/);
});

test('CloudAdapter maps EOMS confirmation step to approval and confirms a work order on close', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    const path = new URL(url).pathname;
    if (path === EOMS_PATHS.detail) return response({ id: 123, workOrderNumber: '20261012D1234', currentStep: '工单确认', workOrderConfirm: '1', workOrderDetail: `<p>清单 SHA-256：${'a'.repeat(64)}</p>` });
    if (path === EOMS_PATHS.task) return response([{ id: 990, taskId: 'task-1', taskName: '工单确认', taskRecordId: 880, workorderId: 123 }]);
    if (path === EOMS_PATHS.confirm) return response(null);
    throw new Error(`unexpected request ${path}`);
  };
  const adapter = new CloudAdapter({ baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env, fetchImpl });
  const approval = await adapter.getApproval('20261012D1234');
  assert.equal(approval.status, 'APPROVED');
  assert.equal(approval.manifestSha256, 'a'.repeat(64));
  assert.equal(approval.transferTaskId, 'EOMS-20261012D1234');
  await adapter.closeApproval('20261012D1234', { reason: '已完成 <内网> 接收' });
  assert.deepEqual(calls.map((call) => [call.path, call.method]), [[EOMS_PATHS.detail, 'GET'], [EOMS_PATHS.detail, 'GET'], [EOMS_PATHS.task, 'GET'], [EOMS_PATHS.confirm, 'PUT']]);
  assert.equal(calls.at(-1).body.approve, true);
  assert.equal(calls.at(-1).body.editorContent, '<p>已完成 &lt;内网&gt; 接收</p>');
});

test('CloudAdapter fails closed for ended or undocumented EOMS workflow states', () => {
  assert.equal(approvalStatus({ currentStep: '流程提起', workOrderConfirm: '0' }), 'PENDING');
  assert.equal(approvalStatus({ currentStep: '处理工单', workOrderConfirm: '0' }), 'PENDING');
  assert.equal(approvalStatus({ currentStep: '工单确认', workOrderConfirm: '1' }), 'APPROVED');
  assert.equal(approvalStatus({ currentStep: '已结束', workOrderConfirm: '0' }), 'UNKNOWN');
  assert.equal(approvalStatus({ currentStep: '未知节点', workOrderConfirm: '1' }), 'UNKNOWN');
});

test('CloudAdapter requires the EOMS work order manifest to match the local request', async () => {
  const detail = { workOrderNumber: '20261012D1234', currentStep: '工单确认', workOrderConfirm: '1', workOrderDetail: `<p>清单 SHA-256：${'a'.repeat(64)}</p>` };
  const adapter = new CloudAdapter({
    baseUrl: 'http://cloud.test:9006', authUserId: '2308', authSecret: 'secret', env,
    fetchImpl: async () => response(detail)
  });
  const result = await adapter.getApproval('20261012D1234', { manifestSha256: 'a'.repeat(64) });
  assert.equal(result.status, 'APPROVED');
  await assert.rejects(
    adapter.getApproval('20261012D1234', { manifestSha256: 'b'.repeat(64) }),
    { code: 'cloud_manifest_mismatch' }
  );
  detail.workOrderNumber = '20261012D9999';
  await assert.rejects(
    adapter.getApproval('20261012D1234', { manifestSha256: 'a'.repeat(64) }),
    { code: 'cloud_api_error' }
  );
});
