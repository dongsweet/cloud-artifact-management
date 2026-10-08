import assert from 'node:assert/strict';
import test from 'node:test';
import { detectHeaders, normalizeArchitecture, parseByteSize, parseDigest } from '../src/candidate-import.js';

test('candidate workbook import recognizes common header aliases and skips a leading note row', () => {
  const result = detectHeaders([
    ['使用说明：请先核对摘要'],
    ['类型', '部署包', '包名/版本', '所属产品', '大小', 'CPU架构', '完整包内网下载', '完整包MD5/sha256值'],
    ['ISO', 'Linux', 'linux.iso', 'Stack', '5.96 GB', 'x86', 'http://repo.test/linux.iso', '0'.repeat(32)]
  ]);
  assert.equal(result.headerRow, 1);
  assert.equal(result.mapping.sourceUrl, 6);
  assert.equal(result.mapping.fileName, 2);
  assert.equal(result.mapping.digest, 7);
});

test('candidate workbook import normalizes architectures, digest labels and exact byte sizes', () => {
  assert.equal(normalizeArchitecture('X86 | arm'), 'x86_64 | arm64');
  assert.deepEqual(parseDigest('sha256：\n' + 'a'.repeat(64), 'package.tar'), { md5: null, sha256: 'a'.repeat(64), warning: null });
  assert.equal(parseByteSize('5.96 GB'), 0);
  assert.equal(parseByteSize('4096 bytes'), 4096);
});
