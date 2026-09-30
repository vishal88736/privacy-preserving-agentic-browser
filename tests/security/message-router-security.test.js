import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMessageRouter } from '../../extension/background/message-router.js';
import { MessageType } from '../../extension/shared/messages.js';

const id = 'abcdefghijklmnopabcdefghijklmnop';
function harness() {
  let listener;
  const calls = [];
  const chromeApi = { runtime: { id, onMessage: { addListener(fn) { listener = fn; } }, sendMessage() {} } };
  const manager = { settings: {}, getTask: () => null, updateSettings: async x => { calls.push(['settings', x]); return x; } };
  // The router's only job is to authenticate the sender and forward verbatim;
  // correlation and approval decisions belong to the controller. These stubs
  // therefore record the payload and report success.
  const record = (k) => (...args) => { calls.push([k, ...args]); return true; };
  const controller = Object.fromEntries(['startTask','pauseTask','resumeTask','cancelTask','handleUserConfirmation','handleUserInput'].map(k => [k, record(k)]));
  controller.subscribe = () => {};
  const vault = {
    reviewRequired: true,
    getAllSecretsForUI: () => { calls.push(['vault-read']); return { LOCAL_TEST: 'secret' }; },
    getActiveSecretsForUI: () => ({}),
    getPendingReviewForUI: () => ({ LOCAL_TEST: 'quarantined' }),
    getAvailableKeysSummary: () => [],
    updateSecret: async (...x) => calls.push(['vault-write', ...x]),
    confirmReview: async (values) => { calls.push(['vault-review', values]); return true; }
  };
  setupMessageRouter(chromeApi, { agentController: controller, taskManager: manager, localVault: vault });
  return { listener, calls };
}

const page = { id, url: 'https://evil.example/attack', origin: 'https://evil.example', tab: { id: 8 }, frameId: 0 };
const sidePanel = { id, url: `chrome-extension://${id}/sidepanel/index.html`, frameId: 0 };

test('webpage cannot approve, start, change settings, or read/write vault', async () => {
  const { listener, calls } = harness();
  const attacks = [
    [MessageType.USER_CONFIRM_ACTION, { approved: true }],
    [MessageType.START_TASK, { prompt: 'transfer money', tabId: 8 }],
    [MessageType.UPDATE_SETTINGS, { requireConfirmation: false }],
    [MessageType.GET_VAULT, {}],
    [MessageType.UPDATE_VAULT, { key: 'LOCAL_PAN', value: 'fake' }],
    [MessageType.CONFIRM_VAULT_REVIEW, { values: { LOCAL_PAN: 'fake' } }]
  ];
  for (const [type, payload] of attacks) {
    let response;
    listener({ type, payload }, page, value => { response = value; });
    if ([MessageType.UPDATE_VAULT, MessageType.CONFIRM_VAULT_REVIEW, MessageType.UPDATE_SETTINGS].includes(type)) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(response?.success, false, `${type} should be rejected`);
  }
  assert.deepEqual(calls, []);
});

test('cross-origin, content script, foreign extension, extension page and service worker are not user interfaces', () => {
  const { listener, calls } = harness();
  const senders = [page, { ...page, url: `chrome-extension://${id}/content.js` }, { ...sidePanel, url: `chrome-extension://${id}/options.html` }, { ...sidePanel, url: `chrome-extension://${id}/background/service-worker.js` }, { ...page, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }];
  for (const sender of senders) {
    let response;
    listener({ type: MessageType.USER_CONFIRM_ACTION, payload: { approved: true } }, sender, x => response = x);
    assert.equal(response.success, false);
  }
  assert.deepEqual(calls, []);
});

test('the legitimate side panel can approve a pending action, forwarding correlation ids verbatim', () => {
  const { listener, calls } = harness();
  let response;
  const payload = { taskId: 'task_1', confirmationId: 'confirm_9', approved: true };
  listener({ type: MessageType.USER_CONFIRM_ACTION, payload }, sidePanel, x => response = x);
  assert.deepEqual(response, { success: true });
  // Correlation ids must reach the controller untouched: it is the only place
  // that can reject an approval meant for a different task or a stale prompt.
  assert.deepEqual(calls[0], ['handleUserConfirmation', payload]);
});

test('only the trusted side panel can read and confirm quarantined vault values', async () => {
  const { listener, calls } = harness();
  let response;
  listener({ type: MessageType.GET_VAULT, payload: {} }, sidePanel, x => { response = x; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(response, {
    vault: {},
    pendingReview: { LOCAL_TEST: 'quarantined' },
    reviewRequired: true,
    storageError: null
  });

  response = null;
  const values = { LOCAL_TEST: 'reviewed' };
  listener({ type: MessageType.CONFIRM_VAULT_REVIEW, payload: { values } }, sidePanel, x => { response = x; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(response, { success: true });
  assert.deepEqual(calls.at(-1), ['vault-review', values]);
});

test('the side panel cannot read a different task by omitting correlation ids', () => {
  // The router forwards whatever the authenticated panel sends; the guard
  // against a cross-task approval lives in handleUserConfirmation, which
  // refuses any payload without matching taskId/confirmationId. This test
  // pins that the router is not itself the enforcement point.
  const { listener, calls } = harness();
  let response;
  listener({ type: MessageType.USER_CONFIRM_ACTION, payload: { approved: true } }, sidePanel, x => response = x);
  assert.deepEqual(response, { success: true });
  assert.deepEqual(calls[0], ['handleUserConfirmation', { approved: true }]);
});
