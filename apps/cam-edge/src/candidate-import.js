import readExcelFile from 'read-excel-file/node';

const MAX_WORKBOOK_BYTES = 12 * 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;
const HEADER_SCAN_ROWS = 15;

const FIELD_ALIASES = {
  type: ['类型', '分类', '软件类型'],
  deploymentPackage: ['部署包', '包名称', '部署包名称', '软件包'],
  purpose: ['用途', '说明', '功能说明'],
  fileName: ['包名/版本', '包名／版本', '包名', '文件名', '文件名/版本', '原始文件名', '文件名称', '制品名称'],
  applicableProducts: ['所属产品', '适用产品', '产品范围'],
  displaySize: ['大小', '文件大小', '制品大小'],
  architecture: ['cpu架构', '架构', '处理器架构'],
  sourceUrl: ['完整包内网下载', '内网下载地址', '内网下载链接', '内网地址', '研发内网地址', '研发内网文件地址', '文件下载地址', '下载地址', '下载链接', '文件地址', '来源地址', 'url', '研发文件地址'],
  digest: ['完整包md5/sha256值', '完整包md5/sha-256值', '完整包摘要', '完整包校验值', 'md5/sha256值', 'md5/sha256', 'md5/sha-256', 'md5', 'sha256', 'sha-256', '摘要', '校验值'],
  documentationUrl: ['部署文档地址', '文档地址', '部署文档', '文档链接'],
  notes: ['备注', '说明备注'],
  targets: ['目标范围', '目标环境', '部署范围'],
  packageKey: ['包标识', '包键']
};

const HEADER_ALIASES = new Map(Object.entries(FIELD_ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [normalizeHeader(alias), field])));
const INHERIT_FIELDS = ['type', 'deploymentPackage', 'purpose', 'applicableProducts'];

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s\u00a0_\-—–:：/\\()[\]【】]/g, '');
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('').trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return cellText(value.result);
  }
  return String(value).trim();
}

function detectHeaders(rows) {
  let best = null;
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index += 1) {
    const headers = (rows[index] ?? []).map(cellText);
    const mapping = {};
    headers.forEach((header, columnIndex) => {
      const field = HEADER_ALIASES.get(normalizeHeader(header));
      if (field && mapping[field] === undefined) mapping[field] = columnIndex;
    });
    const score = Object.keys(mapping).length + (mapping.sourceUrl === undefined ? 0 : 4) + (mapping.fileName === undefined ? 0 : 2);
    if (!best || score > best.score) best = { headerRow: index, headers, mapping, score };
  }
  return best;
}

function normalizeArchitecture(value) {
  const raw = cellText(value);
  if (!raw) return '';
  const parts = raw.split(/[|,，;；、\s]+/).filter(Boolean).map((part) => {
    const token = part.toLowerCase();
    if (['x86', 'x86_64', 'x64', 'amd64', 'amd-64'].includes(token)) return 'x86_64';
    if (['arm', 'arm64', 'aarch64', 'armv8', 'armv8-a'].includes(token)) return 'arm64';
    return part.trim();
  });
  return [...new Set(parts)].join(' | ');
}

function parseFileName(value, sourceUrl) {
  const explicit = cellText(value);
  if (explicit) return explicit.split(/[\\/]/).pop().trim();
  try {
    const lastPart = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(lastPart).trim();
  } catch {
    return '';
  }
}

function parseDigest(value, fileName) {
  const text = cellText(value);
  if (!text) return { md5: null, sha256: null, warning: null };
  const entries = [];
  const pattern = /(?<![a-f\d])([a-f\d]{64}|[a-f\d]{32})(?![a-f\d])/ig;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 100), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 255);
    entries.push({ value: match[1].toLowerCase(), context: `${before} ${after}` });
  }
  if (entries.length === 0) return { md5: null, sha256: null, warning: '摘要列中未识别到有效 MD5 或 SHA-256' };
  const matching = entries.filter((entry) => fileName && entry.context.includes(fileName));
  const candidates = matching.length ? matching : entries;
  const uniqueByLength = (length) => [...new Set(candidates.map((entry) => entry.value).filter((digest) => digest.length === length))];
  const md5Values = uniqueByLength(32);
  const sha256Values = uniqueByLength(64);
  if (md5Values.length > 1 || sha256Values.length > 1) return { md5: null, sha256: null, warning: '摘要列包含多个同类型摘要，无法确定完整包对应值' };
  if (md5Values.length === 0 && sha256Values.length === 0) return { md5: null, sha256: null, warning: '摘要列中未识别到有效 MD5 或 SHA-256' };
  return { md5: md5Values[0] ?? null, sha256: sha256Values[0] ?? null, warning: null };
}

function parseByteSize(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  const text = cellText(value);
  const exactBytes = /^(\d+)\s*(?:b|bytes?)$/i.exec(text);
  if (exactBytes) {
    const size = Number(exactBytes[1]);
    if (Number.isSafeInteger(size)) return size;
  }
  return 0;
}

function splitList(value) {
  return cellText(value).split(/[|,，;；、\n]+/).map((item) => item.trim()).filter(Boolean);
}

function columnValue(row, mapping, field) {
  const index = mapping[field];
  return index === undefined ? '' : row[index];
}

function safePackageKey(value) {
  return String(value).trim().replace(/\s+/g, ' ').slice(0, 255);
}

function normalizeMapping(headers, autoMapping, requestedMapping = {}) {
  const result = { ...autoMapping };
  for (const [field, indexValue] of Object.entries(requestedMapping)) {
    if (!Object.hasOwn(FIELD_ALIASES, field)) continue;
    if (indexValue === null || indexValue === '') {
      delete result[field];
      continue;
    }
    const index = Number(indexValue);
    if (Number.isInteger(index) && index >= 0 && index < headers.length) result[field] = index;
  }
  return result;
}

function makePreviewRows(data, headerRow, mapping, store, roundId, sheetName) {
  const inherited = Object.fromEntries(INHERIT_FIELDS.map((field) => [field, '']));
  const rows = [];
  for (let index = headerRow + 1; index < data.length; index += 1) {
    const rawRow = data[index] ?? [];
    if (!rawRow.some((cell) => cellText(cell))) continue;
    const values = {};
    for (const field of INHERIT_FIELDS) {
      const value = cellText(columnValue(rawRow, mapping, field));
      if (value) inherited[field] = value;
      values[field] = value || inherited[field];
    }
    for (const field of Object.keys(FIELD_ALIASES)) {
      if (values[field] === undefined) values[field] = cellText(columnValue(rawRow, mapping, field));
    }
    const sourceUrl = values.sourceUrl;
    const fileName = parseFileName(values.fileName, sourceUrl);
    const architecture = normalizeArchitecture(values.architecture);
    const digest = parseDigest(values.digest, fileName);
    const size = parseByteSize(columnValue(rawRow, mapping, 'displaySize'));
    const baseKey = values.deploymentPackage || values.type || fileName;
    const packageKey = safePackageKey(columnValue(rawRow, mapping, 'packageKey') || `${baseKey}${architecture ? ` / ${architecture}` : ''}`);
    const errors = [];
    const warnings = [];
    try {
      const parsedUrl = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) errors.push('下载地址必须使用 HTTP 或 HTTPS');
    } catch { errors.push('缺少有效的下载地址'); }
    if (!fileName) errors.push('未填写文件名，且无法从下载地址解析');
    if (fileName.length > 255 || /[\\/\0]/.test(fileName)) errors.push('文件名无效或超过 255 个字符');
    if (!packageKey) errors.push('无法生成包标识');
    if (digest.warning) warnings.push(digest.warning);
    if (!digest.md5 && !digest.sha256) warnings.push('未提供可用摘要；导入后仍会计算实际 SHA-256');
    const displaySize = cellText(columnValue(rawRow, mapping, 'displaySize'));
    if (displaySize && size === 0) warnings.push('表格大小作为说明保留，不作为精确字节数；接收时由下载响应探测');
    if (!architecture) warnings.push('未填写架构');
    const applicableProducts = splitList(values.applicableProducts);
    const targets = splitList(values.targets);
    const sourceMetadata = {
      type: values.type || null,
      deploymentPackage: values.deploymentPackage || null,
      purpose: values.purpose || null,
      applicableProducts,
      displaySize: displaySize || null,
      documentationUrl: values.documentationUrl || null,
      notes: values.notes || null,
      sourceSheet: sheetName,
      sourceRow: index + 1
    };
    rows.push({
      rowNumber: index + 1,
      candidate: {
        sourceUrl,
        fileName,
        packageKey,
        version: null,
        architecture: architecture || null,
        targets,
        size,
        md5: digest.md5,
        sha256: digest.sha256,
        sourceMetadata
      },
      errors,
      warnings,
      conflict: false
    });
    if (rows.length >= MAX_IMPORT_ROWS) break;
  }

  const seen = new Set();
  const existing = new Set(store.listRoundCandidates(roundId).map((candidate) => candidate.package_key.toLowerCase()));
  for (const row of rows) {
    const key = row.candidate.packageKey.toLowerCase();
    if (seen.has(key)) {
      row.warnings.push('导入表中包标识重复；确认导入时会跳过重复项，请修改包标识');
      row.conflict = true;
    } else if (existing.has(key)) {
      row.warnings.push('当前轮次已存在相同包标识；为避免覆盖，确认导入时会跳过该行');
      row.conflict = true;
    }
    seen.add(key);
  }
  return rows;
}

export async function previewCandidateWorkbook(buffer, { sheetName = null, mapping: requestedMapping = {}, store, roundId } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_WORKBOOK_BYTES) throw new Error('Excel 文件必须小于 12 MiB');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('请上传标准 .xlsx 文件');
  const sheets = await readExcelFile(buffer);
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('Excel 文件中没有工作表');
  const analyses = sheets.map((item) => ({ sheet: item.sheet, data: item.data, detected: detectHeaders(item.data) }));
  const selected = sheetName
    ? analyses.find((item) => item.sheet === sheetName)
    : analyses.find((item) => item.sheet === '完整部署包') ?? analyses.reduce((best, item) => !best || (item.detected?.score ?? 0) > (best.detected?.score ?? 0) ? item : best, null);
  if (!selected) throw new Error('指定的工作表不存在');
  if (/分卷|split/i.test(selected.sheet)) throw new Error('分卷工作表中的地址指向单个分卷，不能作为完整候选包导入；请改选完整部署包工作表');
  const detected = selected.detected;
  if (!detected || detected.score < 3) throw new Error('无法识别表头，请选择包含下载地址和文件名列的工作表');
  const mapping = normalizeMapping(detected.headers, detected.mapping, requestedMapping);
  const rows = makePreviewRows(selected.data, detected.headerRow, mapping, store, roundId, selected.sheet);
  const columnOptions = detected.headers.map((title, index) => ({ index, title: title || `第 ${index + 1} 列` }));
  return {
    sheets: analyses.map(({ sheet, detected: info }) => ({ name: sheet, headerRow: info ? info.headerRow + 1 : null, recognizedColumns: info ? Object.keys(info.mapping).length : 0 })),
    sheet: selected.sheet,
    headerRow: detected.headerRow + 1,
    columns: columnOptions,
    mapping,
    rows,
    truncated: selected.data.length - detected.headerRow - 1 > MAX_IMPORT_ROWS
  };
}

export { FIELD_ALIASES, MAX_IMPORT_ROWS, MAX_WORKBOOK_BYTES, detectHeaders, normalizeArchitecture, parseDigest, parseByteSize };
