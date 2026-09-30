import test from 'node:test';
import assert from 'node:assert/strict';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { ActionType } from '../../extension/shared/constants.js';

/**
 * Planner-side rules for attaching a stored document.
 *
 * The planner used to refuse every upload and route to ASK_USER. That refusal
 * is still the default; what changed is the single exception: the model may
 * name one of the documents the USER stored. Everything that is not exactly
 * that — no source, a source the user never stored, a target that is not a
 * file input — still becomes ASK_USER, which is the behaviour that has always
 * existed.
 */

const fileObservation = {
  elements: [
    { id: 'el_file', dom: { tag: 'input', type: 'file', label: 'Upload Identity PDF' }, interaction: { uploadable: true } },
    { id: 'el_note', dom: { tag: 'input', type: 'text', label: 'Notes' }, interaction: { typeable: true } }
  ]
};

async function vaultWithDocuments(...names) {
  const vault = new LocalVault();
  for (const name of names) {
    await vault.updateDocument(name, {
      bytes: new TextEncoder().encode('SYNTHETIC-IDENTITY-DOCUMENT'),
      fileName: `${name.slice(15).toLowerCase()}.png`,
      mimeType: 'image/png'
    });
  }
  return vault;
}

async function withMockFetch(response, run) {
  const original = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, json: async () => response };
  };
  try {
    return { result: await run(), sentBody: () => sentBody };
  } finally {
    globalThis.fetch = original;
  }
}

const modelUpload = (value_source) => ({
  action: { action: ActionType.UPLOAD, target: { element_id: 'el_file' }, ...(value_source ? { value_source } : {}) },
  plan: 'Attach the requested identity document.',
  planner_feedback: '',
  terminate_assessment: false
});

test('with nothing stored, an upload request still asks the user to pick the file', async () => {
  const client = new GPTOSSClient('http://backend.test', { vault: await vaultWithDocuments() });
  const step = await client.planNextStep('Upload my Aadhaar PDF', fileObservation, []);
  assert.equal(step.action.action, ActionType.ASK_USER);
  assert.match(step.action.value.prompt, /Choose the file directly/i);
  assert.equal(step.remoteCallMade, false, 'no planner call is made when nothing can be attached');
});

test('an upload naming a document the user stored is planned, then executed like any other action', async () => {
  const vault = await vaultWithDocuments('LOCAL_DOCUMENT_AADHAAR');
  const client = new GPTOSSClient('http://backend.test', { vault });
  const { result, sentBody } = await withMockFetch(modelUpload('LOCAL_DOCUMENT_AADHAAR'), () =>
    client.planNextStep('Upload my Aadhaar PDF', fileObservation, [])
  );
  assert.equal(result.action.action, ActionType.UPLOAD);
  assert.equal(result.action.value_source, 'LOCAL_DOCUMENT_AADHAAR');
  assert.equal(result.action.target.element_id, 'el_file');
  assert.equal(result.remoteCallMade, true);
  // The planner learns the token names, and nothing else about the documents.
  assert.deepEqual(sentBody().stored_documents, ['LOCAL_DOCUMENT_AADHAAR']);
  const serialized = JSON.stringify(sentBody());
  assert.ok(!serialized.includes('SYNTHETIC-IDENTITY-DOCUMENT'), 'document bytes must never be sent');
  assert.ok(!serialized.includes('aadhar.png'), 'the stored file name must not be sent');
});

test('an upload the user did not authorize is still routed to the user', async () => {
  const vault = await vaultWithDocuments('LOCAL_DOCUMENT_AADHAAR');
  const client = new GPTOSSClient('http://backend.test', { vault });
  for (const action of [
    modelUpload(undefined),                                  // no source at all
    modelUpload('LOCAL_DOCUMENT_PASSPORT'),                   // a document the user never stored
    modelUpload('/home/me/passport.pdf'),                     // a path, not a token
    modelUpload('LOCAL_PAN'),                                 // a text secret is not a file
    { ...modelUpload('LOCAL_DOCUMENT_AADHAAR'), action: { action: ActionType.UPLOAD, target: { element_id: 'el_note' }, value_source: 'LOCAL_DOCUMENT_AADHAAR' } },
    { ...modelUpload('LOCAL_DOCUMENT_AADHAAR'), action: { action: ActionType.UPLOAD, value_source: 'LOCAL_DOCUMENT_AADHAAR' } }
  ]) {
    const { result } = await withMockFetch(action, () =>
      client.planNextStep('Upload my Aadhaar PDF', fileObservation, [])
    );
    assert.equal(result.action.action, ActionType.ASK_USER,
      `${JSON.stringify(action.action)} must be routed to the user`);
    assert.match(result.action.value.prompt, /Choose the file directly/i);
    assert.equal(result.action.target, undefined, 'the rejected action must not keep its target');
  }
});

test('a task that never mentions an upload is unaffected by stored documents', async () => {
  const vault = await vaultWithDocuments('LOCAL_DOCUMENT_AADHAAR', 'LOCAL_DOCUMENT_PAN');
  const client = new GPTOSSClient('http://backend.test', { vault });
  const { result, sentBody } = await withMockFetch(
    { action: { action: ActionType.TYPE, target: { element_id: 'el_note' }, value: 'hello' }, plan: '', terminate_assessment: false },
    () => client.planNextStep('Type hello in the notes field', fileObservation, [])
  );
  assert.equal(result.action.action, ActionType.TYPE);
  assert.deepEqual(sentBody().stored_documents, ['LOCAL_DOCUMENT_AADHAAR', 'LOCAL_DOCUMENT_PAN']);
});
