import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core session expiry returns to a usable login screen', async () => {
  const script = await read('./core.js');
  assert.match(script, /function showLogin\(\) \{[\s\S]*?currentUser = null;/u);
  assert.match(script, /function showLogin\(\) \{[\s\S]*?csrf = null;/u);
  assert.match(script, /document\.querySelectorAll\('dialog\[open\]'\)\.forEach\(\(dialog\) => dialog\.close\('session-expired'\)\)/u);
  assert.match(script, /document\.body\.classList\.remove\('modal-open'\)/u);
  assert.match(script, /document\.querySelectorAll\('\.modal-backdrop'\)\.forEach\(\(backdrop\) => backdrop\.remove\(\)\)/u);
  assert.match(script, /if \(response\.status === 401[^\n]+showLogin\(\)/u);
});
