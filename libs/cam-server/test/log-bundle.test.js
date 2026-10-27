import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeRuntimeLogs } from '../src/log-bundle.js';

test('categorizeRuntimeLogs keeps selected categories and classifies transfer and errors', () => {
  const input = Buffer.from([
    '{"level":30,"time":"2026-01-01T00:00:01.000Z","msg":"服务已启动"}',
    '{"level":30,"time":"2026-01-01T00:00:02.000Z","transferTaskId":"TR-1","msg":"开始传输分块"}',
    '{"level":50,"time":"2026-01-01T00:00:03.000Z","msg":"下载失败"}',
    ''
  ].join('\n'));
  const result = categorizeRuntimeLogs(input, ['runtime', 'transfer', 'error']);
  assert.equal(result.runtime.toString().split('\n').filter(Boolean).length, 3);
  assert.match(result.transfer.toString(), /TR-1/);
  assert.doesNotMatch(result.transfer.toString(), /服务已启动/);
  assert.match(result.error.toString(), /下载失败/);
  assert.equal(Object.keys(categorizeRuntimeLogs(input, ['error'])).join(','), 'error');
});
