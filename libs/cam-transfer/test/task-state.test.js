import assert from 'node:assert/strict';
import test from 'node:test';
import { displayTransferState } from '../src/task-state.js';

test('transfer state mapping keeps protocol values separate from display values', () => {
  assert.equal(displayTransferState('RUNNING'), 'TRANSFERRING');
  assert.equal(displayTransferState('RECEIVING'), 'TRANSFERRING');
  assert.equal(displayTransferState('ASSEMBLING'), 'VERIFYING');
  assert.equal(displayTransferState('WAITING_RECEIPT'), 'WAITING_CONFIRMATION');
  assert.equal(displayTransferState('QUEUED', { hasError: true, retryAt: new Date().toISOString() }), 'RETRY_WAIT');
  assert.equal(displayTransferState('COMPLETED'), 'COMPLETED');
  assert.equal(displayTransferState('RECEIVED'), 'COMPLETED');
});

test('control state takes precedence over transport progress', () => {
  assert.equal(displayTransferState('RUNNING', { controlState: 'PAUSE_REQUESTED' }), 'PAUSE_REQUESTED');
  assert.equal(displayTransferState('RUNNING', { controlState: 'CANCEL_REQUESTED' }), 'CANCEL_REQUESTED');
});
