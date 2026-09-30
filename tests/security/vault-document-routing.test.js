import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMessageRouter } from '../../extension/background/message-router.js';
import { MessageType } from '../../extension/shared/messages.js';

/**
 * Who may store and read the user's identity documents.
 *
 * Documents are the most sensitive records the extension holds, and the new
 * message types are the only way in or out of them. They sit behind the same
 * sender gate as the rest of the vault: the extension's own side-panel
 * document, and nothing else. A webpage content script shares the extension ID,
 * so an ID check alone is not enough — the router requires the exact
 * extension-owned document, and a tab sender is rejected outright.
 */

const id = 'abcdefghijklmnopabcdefghijklmnop';
const sidePanel = { id, url: `chrome-extension://${id}/sidepanel/index.html`, frameId: 0 };
const webpage = { id, url: 'https://evil.example/attack', tab: { id: 8 }, frameId: 0 };

function harness() {
  let listener;
  const calls = [];
  const chromeApi = { runtime: { id, onMessage: { addListener(fn) { listener = fn; } }, sendMessage() {} } };
  const manager = { settings: {}, getTask: () => null, updateSettings: async (x) => x };
  const controller = {
    subscribe: () => {},
    startTask: () => true, pauseTask: () => true, resumeTask: () => true, cancelTask: () => true,
    handleUserConfirmation: () => true, handleUserInput: () => true
  };
  const vault = {
    getAllSecretsForUI: () => { calls.push(['vault-read']); return {}; },
    getAvailableKeysSummary: () => [],
    getDocumentsSummary: () => { calls.push(['documents-read']); return [{ name: 'LOCAL_DOCUMENT_AADHAAR', fileName: 'a.png', mimeType: 'image/png', byteLength: 3 }]; },
    updateDocument: async (name, doc) => { calls.push(['document-store', name, doc]); return { name, fileName: doc.fileName, mimeType: doc.mimeType, byteLength: 3 }; },
    deleteDocument: async (name) => { calls.push(['document-delete', name]); return true; }
  };
  setupMessageRouter(chromeApi, { agentController: controller, taskManager: manager, localVault: vault });
  return { listener, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a webpage can neither read, store, nor delete a stored document', async () => {
  const { listener, calls } = harness();
  const attacks = [
    [MessageType.GET_VAULT_DOCUMENTS, {}],
    [MessageType.STORE_VAULT_DOCUMENT, { name: 'LOCAL_DOCUMENT_AADHAAR', data: 'U0lOVEVTVElD' }],
    [MessageType.DELETE_VAULT_DOCUMENT, { name: 'LOCAL_DOCUMENT_AADHAAR' }]
  ];
  for (const [type, payload] of attacks) {
    let response;
    listener({ type, payload }, webpage, (value) => { response = value; });
    await settle();
    assert.equal(response?.success, false, `${type} must be rejected from a webpage`);
  }
  assert.deepEqual(calls, [], 'no vault access may happen at all');
});

test('the side panel can list stored documents and receives metadata only', async () => {
  const { listener, calls } = harness();
  let response;
  listener({ type: MessageType.GET_VAULT_DOCUMENTS, payload: {} }, sidePanel, (v) => { response = v; });
  await settle();
  assert.deepEqual(response.documents, [
    { name: 'LOCAL_DOCUMENT_AADHAAR', fileName: 'a.png', mimeType: 'image/png', byteLength: 3 }
  ]);
  assert.ok(!JSON.stringify(response).includes('U0lOVEVTVElD'));
  assert.deepEqual(calls, [['documents-read']]);
});

test('the side panel can store a document under a name the vault validates', async () => {
  const { listener, calls } = harness();
  let response;
  listener({
    type: MessageType.STORE_VAULT_DOCUMENT,
    payload: { name: 'LOCAL_DOCUMENT_AADHAAR', data: 'U0lOVEVTVElD', fileName: 'a.png', mimeType: 'image/png' }
  }, sidePanel, (v) => { response = v; });
  await settle();
  assert.equal(response.success, true);
  assert.equal(response.document.name, 'LOCAL_DOCUMENT_AADHAAR');
  assert.deepEqual(calls[0], ['document-store', 'LOCAL_DOCUMENT_AADHAAR', {
    data: 'U0lOVEVTVElD', fileName: 'a.png', mimeType: 'image/png'
  }]);
});

test('a malformed store request is refused before the vault is touched', async () => {
  const { listener, calls } = harness();
  for (const payload of [{}, { name: 'LOCAL_DOCUMENT_AADHAAR' }, { data: 'U0lOVEVTVElD' }]) {
    let response;
    listener({ type: MessageType.STORE_VAULT_DOCUMENT, payload }, sidePanel, (v) => { response = v; });
    await settle();
    assert.equal(response.success, false);
  }
  assert.deepEqual(calls, []);
});
