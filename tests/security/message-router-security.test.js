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
  const controller = Object.fromEntries(['startTask','pauseTask','resumeTask','cancelTask','handleUserConfirmation','handleUserInput'].map(k => [k, (...args) => calls.push([k, ...args])]));
  controller.subscribe = () => {};
  const vault = { getAllSecretsForUI: () => { calls.push(['vault-read']); return { LOCAL_TEST: 'secret' }; }, getAvailableKeysSummary: () => [], updateSecret: async (...x) => calls.push(['vault-write', ...x]) };
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
    [MessageType.UPDATE_VAULT, { key: 'LOCAL_PAN', value: 'fake' }]
  ];
  for (const [type, payload] of attacks) {
    let response;
    listener({ type, payload }, page, value => { response = value; });
    if (type === MessageType.UPDATE_VAULT || type === MessageType.UPDATE_SETTINGS) await new Promise(resolve => setImmediate(resolve));
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

test('the legitimate side panel can approve a pending action', () => {
  const { listener, calls } = harness();
  let response;
  listener({ type: MessageType.USER_CONFIRM_ACTION, payload: { approved: true } }, sidePanel, x => response = x);
  assert.deepEqual(response, { success: true });
  assert.deepEqual(calls[0], ['handleUserConfirmation', true]);
});
