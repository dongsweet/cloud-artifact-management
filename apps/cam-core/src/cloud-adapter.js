import { ProxyAgent } from 'undici';

const EOMS_PATHS = Object.freeze({
  create: '/workflow-service/workOrderManagement/base',
  detail: '/workflow-service/workOrderManagement/workNumber',
  task: '/workflow-service/workOrderManagement/taskRecordDetail',
  confirm: '/workflow-service/workOrderManagement/base',
  priorities: '/system-service/sugon/system/multiLevelDictionary/noAuth/multiLevelDictionaryList',
  sources: '/system-service/sugon/system/multiLevelDictionary/noAuth/multiLevelDictionaryList',
  businessTypes: '/system-service/sugon/system/multiLevelDictionary/businessType',
  departments: '/system-service/sugon/systemDept/userDeptPermission',
  teams: '/system-service/sugon/teamRole/list',
  responsiblePersons: '/system-service/sugon/systemUser/responsiblePersons'
});

const text = (value) => value === undefined || value === null ? '' : String(value).trim();
const normalized = (value) => text(value).replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const normalizedPath = (value) => text(value).split('/').map(normalized).join('/');

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'cloud_mapping_not_configured' });
}

function cloudError(message, statusCode = undefined) {
  return Object.assign(new Error(message), { code: 'cloud_api_error', ...(statusCode ? { statusCode } : {}) });
}

function asId(value, field) {
  const id = text(value);
  if (!id) throw cloudError(`cloud response is missing ${field}`);
  return id;
}

function asNumericId(value, field) {
  const id = asId(value, field);
  if (!/^\d+$/u.test(id)) throw cloudError(`${field} must be numeric`);
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId)) throw cloudError(`${field} exceeds the JavaScript safe integer range`);
  return numericId;
}

function valueOf(node, keys) {
  for (const key of keys) {
    if (node?.[key] !== undefined && node?.[key] !== null && text(node[key])) return text(node[key]);
  }
  return '';
}

function childrenOf(node) {
  for (const key of ['childless', 'children', 'childList', 'items']) {
    if (Array.isArray(node?.[key])) return node[key];
  }
  return [];
}

function flattenDictionary(nodes, parents = []) {
  const result = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const label = valueOf(node, ['dictLabel', 'label', 'name', 'title']);
    const path = label ? [...parents, label] : parents;
    const children = childrenOf(node);
    if (!children.length && label) {
      result.push({ id: node.id ?? node.dictId, label, value: valueOf(node, ['dictValue', 'value', 'code']), path: path.join('/') });
    }
    result.push(...flattenDictionary(children, path));
  }
  return result;
}

function dictionaryItem(nodes, { label, value, path, field }) {
  const expectedLabel = normalized(label);
  const expectedValue = normalized(value);
  const expectedPath = normalizedPath(path);
  const leaves = flattenDictionary(nodes);
  const matches = leaves.filter((item) => {
    if (path && normalizedPath(item.path) !== expectedPath) return false;
    if (label && normalized(item.label) !== expectedLabel) return false;
    if (value && normalized(item.value) !== expectedValue) return false;
    return true;
  });
  if (matches.length !== 1) {
    const description = path || label || value || '(empty)';
    throw cloudError(`${field} mapping ${description} matched ${matches.length} leaf dictionary records`);
  }
  return matches[0];
}

function rowsFrom(data, keys) {
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return Array.isArray(data) ? data : [];
}

function namedRow(rows, expectedName, field, { nameKeys, idKeys }) {
  const expected = normalized(expectedName);
  const matches = rows.filter((row) => nameKeys.some((key) => normalized(valueOf(row, [key])) === expected));
  if (matches.length !== 1) throw cloudError(`${field} mapping ${expectedName} matched ${matches.length} records`);
  const id = valueOf(matches[0], idKeys);
  return { id: asId(id, `${field}.id`), label: expectedName };
}

function approvalStatus(detail) {
  const step = text(detail.currentStep);
  const confirm = text(detail.workOrderConfirm);
  if (step === '工单确认' && confirm === '1') return 'APPROVED';
  if (['流程提起', '处理工单'].includes(step) && confirm === '0') return 'PENDING';
  return 'UNKNOWN';
}

function html(value) {
  return text(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function parseProcessorNames(value) {
  const names = text(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (names.some((name) => /\s/u.test(name) || /^\d+$/u.test(name))) throw configurationError('请填写有效的云管审批处理人用户名');
  return [...new Set(names)];
}

function parseLegacyProcessorIds(value) {
  const ids = text(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/u.test(id))) throw configurationError('CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS must contain numeric user IDs');
  return [...new Set(ids)];
}

function readConfig(env = process.env, overrides = undefined) {
  const config = {
    priorityLabel: text(env.CAM_CLOUD_WORK_ORDER_PRIORITY_LABEL),
    priorityValue: text(env.CAM_CLOUD_WORK_ORDER_PRIORITY_VALUE),
    sourceLabel: text(env.CAM_CLOUD_WORK_ORDER_SOURCE_LABEL),
    sourceValue: text(env.CAM_CLOUD_WORK_ORDER_SOURCE_VALUE),
    businessTypePath: text(env.CAM_CLOUD_WORK_ORDER_BUSINESS_TYPE_PATH),
    deptName: text(env.CAM_CLOUD_WORK_ORDER_DEPT_NAME),
    teamName: text(env.CAM_CLOUD_WORK_ORDER_TEAM_NAME),
    processUserNames: text(env.CAM_CLOUD_WORK_ORDER_PROCESS_USER_NAMES),
    legacyProcessUserIds: text(env.CAM_CLOUD_WORK_ORDER_PROCESS_USER_IDS),
    titlePrefix: text(env.CAM_CLOUD_WORK_ORDER_TITLE_PREFIX) || '云平台制品验证报告审批'
  };
  if (overrides) for (const key of ['priorityLabel', 'priorityValue', 'sourceLabel', 'sourceValue', 'businessTypePath', 'deptName', 'teamName', 'titlePrefix']) {
    if (overrides[key] !== undefined && overrides[key] !== '') config[key] = text(overrides[key]);
  }
  if (overrides?.processUserNames !== undefined) {
    config.processUserNames = text(overrides.processUserNames);
    config.legacyProcessUserIds = '';
  } else if (overrides?.processUserIds !== undefined) {
    // Read older database records during rollout; new UI and saves only use usernames.
    config.legacyProcessUserIds = text(overrides.processUserIds);
  }
  config.processUserNames = parseProcessorNames(config.processUserNames);
  config.legacyProcessUserIds = parseLegacyProcessorIds(config.legacyProcessUserIds);
  if (!config.processUserNames.length && !config.legacyProcessUserIds.length) throw configurationError('请填写云管审批处理人用户名');
  if (!config.priorityLabel && !config.priorityValue) throw configurationError('CAM_CLOUD_WORK_ORDER_PRIORITY_LABEL or _VALUE is required');
  if (!config.sourceLabel && !config.sourceValue) throw configurationError('CAM_CLOUD_WORK_ORDER_SOURCE_LABEL or _VALUE is required');
  if (!config.businessTypePath) throw configurationError('CAM_CLOUD_WORK_ORDER_BUSINESS_TYPE_PATH is required');
  if (!config.deptName) throw configurationError('CAM_CLOUD_WORK_ORDER_DEPT_NAME is required');
  if (!config.teamName) throw configurationError('CAM_CLOUD_WORK_ORDER_TEAM_NAME is required');
  return config;
}

function dataOf(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'data')) return value.data;
  return value;
}

export class CloudAdapter {
  constructor({
    baseUrl = process.env.CAM_CLOUD_API_BASE_URL,
    authUserId = process.env.CAM_CLOUD_AUTH_USER_ID,
    authUsername = process.env.CAM_CLOUD_AUTH_USERNAME,
    authSecret = process.env.CAM_CLOUD_AUTH_SECRET,
    proxyUrl = process.env.CAM_CLOUD_HTTP_PROXY,
    timeoutMs = Number(process.env.CAM_CLOUD_TIMEOUT_MS ?? 10000),
    fetchImpl = globalThis.fetch,
    env = process.env
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') || null;
    this.authUserId = text(authUserId);
    this.authUsername = text(authUsername);
    this.authSecret = text(authSecret);
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.env = env;
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  }

  enabled() { return Boolean(this.baseUrl && this.authUserId && this.authSecret && this.fetch); }

  businessConfig() {
    return {
      priorityLabel: text(this.env.CAM_CLOUD_WORK_ORDER_PRIORITY_LABEL),
      priorityValue: text(this.env.CAM_CLOUD_WORK_ORDER_PRIORITY_VALUE),
      sourceLabel: text(this.env.CAM_CLOUD_WORK_ORDER_SOURCE_LABEL),
      sourceValue: text(this.env.CAM_CLOUD_WORK_ORDER_SOURCE_VALUE),
      businessTypePath: text(this.env.CAM_CLOUD_WORK_ORDER_BUSINESS_TYPE_PATH),
      deptName: text(this.env.CAM_CLOUD_WORK_ORDER_DEPT_NAME),
      teamName: text(this.env.CAM_CLOUD_WORK_ORDER_TEAM_NAME),
      processUserNames: text(this.env.CAM_CLOUD_WORK_ORDER_PROCESS_USER_NAMES),
      titlePrefix: text(this.env.CAM_CLOUD_WORK_ORDER_TITLE_PREFIX) || '云平台制品验证报告审批'
    };
  }

  async request(path, { method = 'GET', query = undefined, body = undefined } = {}) {
    if (!this.enabled()) throw Object.assign(new Error('cloud adapter is not configured'), { code: 'cloud_not_configured' });
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && text(value)) url.searchParams.set(key, text(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        accept: 'application/json',
        'x-auth-secret': this.authSecret,
        'x-auth-userid': this.authUserId
      };
      if (this.authUsername) headers['x-auth-username'] = this.authUsername;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) });
      const rawText = await response.text();
      let value;
      try { value = rawText ? JSON.parse(rawText) : {}; } catch { throw cloudError(`cloud API returned non-JSON response (${response.status})`, response.status); }
      if (!response.ok) throw cloudError(value?.msg ?? value?.message ?? value?.error ?? `cloud API returned ${response.status}`, response.status);
      if (value && value.code !== undefined && String(value.code) !== '0') throw cloudError(value.msg ?? value.message ?? `cloud API returned business code ${value.code}`, response.status);
      return dataOf(value);
    } finally { clearTimeout(timer); }
  }

  async resolveMappings(overrides = undefined) {
    const config = readConfig(this.env, overrides);
    const [priorityData, sourceData, businessData, deptData, teamData] = await Promise.all([
      this.request(EOMS_PATHS.priorities, { query: { dictType: 'demand_ticket' } }),
      this.request(EOMS_PATHS.sources, { query: { dictType: 'work_order_source' } }),
      this.request(EOMS_PATHS.businessTypes, { query: { orderType: 'demand_ticket' } }),
      this.request(EOMS_PATHS.departments),
      this.request(EOMS_PATHS.teams)
    ]);
    const priority = dictionaryItem(priorityData, { label: config.priorityLabel, value: config.priorityValue, field: 'priority' });
    const source = dictionaryItem(sourceData, { label: config.sourceLabel, value: config.sourceValue, field: 'workOrderSource' });
    const businessType = dictionaryItem(businessData, { path: config.businessTypePath, field: 'businessType' });
    const departments = rowsFrom(deptData, ['centerList', 'rows', 'list']);
    const teams = rowsFrom(teamData, ['rows', 'list']);
    const dept = namedRow(departments, config.deptName, 'dept', {
      nameKeys: ['deptName', 'departmentName', 'centerName', 'deptLabel', 'name', 'label'],
      idKeys: ['deptId', 'departmentId', 'id']
    });
    const team = namedRow(teams, config.teamName, 'team', {
      nameKeys: ['teamName', 'teamRoleName', 'name', 'label', 'roleName'],
      idKeys: ['teamId', 'id']
    });
    const processorIds = [...config.legacyProcessUserIds];
    const resolvedProcessors = config.legacyProcessUserIds.map((userId) => ({ userId, username: null }));
    let persons = [];
    if (config.processUserNames.length) {
      // The approval department and the processor's home department can differ.
      // Query the authorized processor set without restricting it to dept.id;
      // the cloud API still scopes the result by the authenticated account.
      const personsData = await this.request(EOMS_PATHS.responsiblePersons, { query: { isAll: true, userType: true } });
      persons = rowsFrom(personsData, ['rows', 'list', 'users', 'records', 'data']);
    }
    for (const value of config.processUserNames) {
      const usernameKeys = ['username', 'userName', 'user_name', 'loginName', 'loginname', 'login_name', 'userLoginName', 'userAccount', 'account', 'userCode'];
      const matches = persons.filter((person) => usernameKeys.some((key) => normalized(valueOf(person, [key])) === normalized(value)));
      if (matches.length !== 1) throw cloudError(`云管处理人用户名 ${value} 匹配到 ${matches.length} 个用户`);
      const userId = asId(valueOf(matches[0], ['userId', 'id']), `processUser ${value}.userId`);
      if (!/^\d+$/u.test(userId)) throw cloudError(`云管处理人 ${value} 的 userId 不是数字`);
      processorIds.push(userId);
      resolvedProcessors.push({ userId, username: value });
    }
    return {
      priority: { id: asId(priority.id, 'priority.id'), label: priority.label, value: priority.value, path: priority.path },
      source: { id: asId(source.id, 'workOrderSource.id'), label: source.label, value: source.value, path: source.path },
      businessType: { id: asId(businessType.id, 'businessType.id'), label: businessType.label, value: businessType.value, path: businessType.path },
      dept,
      team,
      processUserIds: [...new Set(processorIds)],
      processUsers: resolvedProcessors,
      resolvedAt: new Date().toISOString()
    };
  }

  buildWorkOrder(envelope, mappings, overrides = undefined) {
    const config = readConfig(this.env, overrides);
    if (!mappings.processUserIds.length) throw configurationError('请配置云管审批处理人用户名');
    const title = `${config.titlePrefix} ${envelope.releaseId ?? ''}/${envelope.roundId ?? ''}`.trim().slice(0, 64);
    const detail = [
      `<p>${html(config.titlePrefix)}</p>`,
      `<p>产品发布：${html(envelope.releaseId)}</p>`,
      `<p>候选轮次：${html(envelope.roundId)}</p>`,
      `<p>请求编号：${html(envelope.requestId)}</p>`,
      `<p>验证结论：${html(envelope.conclusion)}</p>`,
      `<p>清单 SHA-256：${html(envelope.manifestSha256)}</p>`,
      `<p>报告 SHA-256：${html(envelope.reportSha256)}</p>`,
      `<p>报告文件：${html(envelope.reportFileName)}</p>`
    ].join('');
    return {
      workOrderType: 'demand_ticket',
      title,
      priority: mappings.priority.id,
      businessType: mappings.businessType.id,
      workOrderDetail: detail.slice(0, 2000),
      processWorkOrder: mappings.processUserIds.join(','),
      deptId: asNumericId(mappings.dept.id, 'dept.id'),
      teamId: asNumericId(mappings.team.id, 'team.id'),
      workOrderSource: mappings.source.id,
      equipmentType: [],
      cloudPlate: [],
      relevancyEquip: []
    };
  }

  async createApproval(envelope, overrides = undefined) {
    const mappings = await this.resolveMappings(overrides);
    const requestBody = this.buildWorkOrder(envelope, mappings, overrides);
    const result = await this.request(EOMS_PATHS.create, { method: 'POST', body: requestBody });
    const workNumber = typeof result === 'string' ? result : valueOf(result, ['workOrderNumber', 'workNumber', 'number']);
    if (!workNumber) throw cloudError('cloud create response does not contain a work order number');
    return {
      approvalId: workNumber,
      status: 'PENDING',
      requestBody,
      mappingSnapshot: mappings,
      workOrderNumber: workNumber
    };
  }

  async getApproval(approvalId, expectedRequest = undefined) {
    const detail = await this.request(EOMS_PATHS.detail, { query: { workNumber: approvalId } });
    if (!detail) throw cloudError(`cloud work order ${approvalId} was not found`);
    const actualWorkNumber = valueOf(detail, ['workOrderNumber', 'workNumber']);
    if (actualWorkNumber && actualWorkNumber !== approvalId) throw cloudError(`cloud work order identity does not match ${approvalId}`);
    const status = approvalStatus(detail);
    const description = text(detail.workOrderDetail);
    const manifestSha256 = description.match(/清单\s*SHA-256：?\s*([a-f0-9]{64})/iu)?.[1]?.toLowerCase();
    if (status === 'APPROVED') {
      if (!manifestSha256) throw cloudError('approved cloud work order does not contain a manifest SHA-256');
      if (expectedRequest?.manifestSha256 && manifestSha256 !== text(expectedRequest.manifestSha256).toLowerCase()) {
        throw Object.assign(new Error('cloud approved manifest does not match the local approval request'), { code: 'cloud_manifest_mismatch' });
      }
    }
    return {
      approvalId,
      status,
      workflowStep: text(detail.currentStep),
      transferTaskId: status === 'APPROVED' ? `EOMS-${approvalId}` : undefined,
      manifestSha256,
      cloudDetail: detail
    };
  }

  async closeApproval(approvalId, body = {}) {
    const detail = await this.request(EOMS_PATHS.detail, { query: { workNumber: approvalId } });
    const workorderId = detail?.id;
    if (!workorderId) throw cloudError(`cloud work order ${approvalId} has no numeric ID`);
    if (text(detail.currentStep) !== '工单确认' || text(detail.workOrderConfirm) !== '1') {
      throw cloudError(`cloud work order ${approvalId} is not waiting for submitter confirmation`);
    }
    const tasks = await this.request(EOMS_PATHS.task, { query: { id: workorderId } });
    const task = Array.isArray(tasks) ? tasks[0] : tasks?.[0] ?? tasks;
    if (!task) throw cloudError(`cloud work order ${approvalId} has no pending task record`);
    if (text(task.taskName) !== '工单确认') throw cloudError(`cloud work order ${approvalId} task is not the confirmation step`);
    return this.request(EOMS_PATHS.confirm, {
      method: 'PUT',
      body: {
        id: asNumericId(task.id, 'task.id'),
        taskId: task.taskId,
        taskName: task.taskName,
        taskRecordId: asNumericId(task.taskRecordId, 'task.taskRecordId'),
        workorderId: asNumericId(task.workorderId ?? workorderId, 'task.workorderId'),
        approve: true,
        editorContent: body.reason ? `<p>${html(body.reason)}</p>` : '<p>云平台软件制品已完成内网接收。</p>',
        assignmentList: []
      }
    });
  }
}

export { EOMS_PATHS, approvalStatus, flattenDictionary, readConfig };
