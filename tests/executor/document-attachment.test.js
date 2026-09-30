import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { ActionExecutor } from '../../extension/executor/action-executor.js';
import { ActionValidator } from '../../extension/executor/action-validator.js';
import { RiskGate } from '../../extension/executor/risk-gate.js';
import { validateAction } from '../../extension/shared/schemas.js';
import { ActionType } from '../../extension/shared/constants.js';

/**
 * The document attachment path, end to end in the background.
 *
 * The invariant these tests exist to protect: the only thing that can turn a
 * name into file bytes is a vault entry the user created. A model can choose
 * WHICH of the user's own documents is attached; it can never name a file,
 * because no part of this path accepts a path, a URL, or a value.
 */

const BODY = 'SYNTHETIC-IDENTITY-DOCUMENT-FIXTURE';
const bytes = () => new TextEncoder().encode(BODY);

async function vaultWithDocument(name = 'LOCAL_DOCUMENT_AADHAAR') {
  const vault = new LocalVault();
  await vault.updateDocument(name, { bytes: bytes(), fileName: 'aadhar.png', mimeType: 'image/png' });
  return vault;
}

// ── Resolution ─────────────────────────────────────────────────────────────

test('a document token resolves to a descriptor carrying the bytes', async () => {
  const vault = await vaultWithDocument();
  const resolved = new LocalValueResolver(vault).resolve({
    action: ActionType.UPLOAD,
    target: { element_id: 'el_1' },
    value_source: 'LOCAL_DOCUMENT_AADHAAR'
  });
  assert.equal(resolved.__vaultDocument, true);
  assert.equal(resolved.name, 'LOCAL_DOCUMENT_AADHAAR');
  assert.equal(resolved.fileName, 'aadhar.png');
  assert.equal(resolved.mimeType, 'image/png');
  assert.deepEqual(Array.from(resolved.bytes), Array.from(bytes()));
});

test('a document the user never stored cannot be resolved', async () => {
  const vault = await vaultWithDocument();
  const resolver = new LocalValueResolver(vault);
  // A name that is a valid token but names nothing, and names that are not
  // valid tokens at all, are both unroutable — there is no fallback that
  // turns a name into a file.
  for (const source of ['LOCAL_DOCUMENT_PASSPORT', 'LOCAL_DOCUMENT', '../../etc/passwd', 'file:///etc/passwd', 'LOCAL_PAN']) {
    assert.throws(
      () => resolver.resolve({ action: ActionType.UPLOAD, value_source: source }),
      /not configured|No document named|Real document upload/,
      `${source} must not resolve to bytes`
    );
  }
});

test('a document token is not a form value', async () => {
  const vault = await vaultWithDocument();
  const plan = new LocalValueResolver(vault).resolve({
    action: ActionType.FILL_FORM_PLAN,
    value: { fields: [{ field_id: 'el_1', value_source: 'LOCAL_DOCUMENT_AADHAAR' }] }
  });
  assert.equal(plan.fields[0].status, 'UNAVAILABLE');
  assert.equal(plan.fields[0].value, undefined, 'bytes must never become a typed form value');
});

// ── Schema ─────────────────────────────────────────────────────────────────

test('the schema accepts a document token and refuses every other upload source', () => {
  assert.equal(validateAction({
    action: ActionType.UPLOAD,
    target: { element_id: 'el_1' },
    value_source: 'LOCAL_DOCUMENT_AADHAAR'
  }), true);
  // File bytes travel only through UPLOAD: a TYPE may never smuggle a stored
  // document token, even one aimed at a file input.
  assert.throws(
    () => validateAction({
      action: ActionType.TYPE,
      target: { element_id: 'el_1' },
      value_source: 'LOCAL_DOCUMENT_AADHAAR'
    }),
    /may only be used by UPLOAD/,
    'a TYPE action must not carry a stored document token'
  );

  for (const value_source of ['LOCAL_PAN', 'LOCAL_DOCUMENT', '../../../etc/passwd', '/etc/passwd', 'LOCAL_DOCUMENT_aadhar']) {
    assert.throws(
      () => validateAction({ action: ActionType.UPLOAD, target: { element_id: 'el_1' }, value_source }),
      /UPLOAD may only reference a stored document/,
      `${value_source} must not be an upload source`
    );
  }
  assert.throws(
    () => validateAction({ action: ActionType.UPLOAD, target: { element_id: 'el_1' }, value: '/home/me/passport.pdf' }),
    /UPLOAD takes no inline value/,
    'an upload may not carry a file path as its value'
  );
});

// ── Risk gate and pre-execution validation ─────────────────────────────────

test('attaching a stored document still requires the user to approve it', () => {
  const gate = new RiskGate();
  for (const action of [
    { action: ActionType.UPLOAD, target: { element_id: 'el_1' }, value_source: 'LOCAL_DOCUMENT_AADHAAR' },
    { action: ActionType.TYPE, target: { element_id: 'el_1' }, value_source: 'LOCAL_DOCUMENT_AADHAAR' }
  ]) {
    const assessment = gate.evaluate(action, {
      targetDom: { tag: 'input', type: 'file', label: 'Upload Aadhaar' }
    });
    assert.equal(assessment.allowed, true);
    assert.equal(assessment.risk, 'HIGH');
    assert.equal(assessment.requiresConfirmation, true);
  }
});

test('a document token may only be attached with UPLOAD, never typed', () => {
  const validator = new ActionValidator();
  const documentAction = {
    action: ActionType.TYPE,
    target: { element_id: 'el_1' },
    value_source: 'LOCAL_DOCUMENT_AADHAAR'
  };
  // Even on a file input, a TYPE carrying a document token is refused: the
  // attachment path is UPLOAD only.
  const onFileInput = validator.validatePreExecution(documentAction, {
    elements: [{ id: 'el_1', dom: { tag: 'input', type: 'file' }, interaction: { typeable: true } }]
  });
  assert.equal(onFileInput.valid, false);
  assert.match(onFileInput.reason, /UPLOAD/);

  const onTextInput = validator.validatePreExecution(documentAction, {
    elements: [{ id: 'el_1', dom: { tag: 'input', type: 'text' }, interaction: { typeable: true } }]
  });
  assert.equal(onTextInput.valid, false);
  assert.match(onTextInput.reason, /UPLOAD/);
});

// ── Transport to the content script ────────────────────────────────────────

test('the executor sends document bytes to the page base64-encoded, never as a live array', async () => {
  const vault = await vaultWithDocument();
  let sent = null;
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabs: {
      sendMessage: (_tabId, message, callback) => {
        sent = message;
        // Round-trip through JSON, exactly as the real message channel does.
        sent = JSON.parse(JSON.stringify(message));
        callback({ success: true });
      }
    }
  };
  try {
    const executor = new ActionExecutor(new LocalValueResolver(vault));
    const result = await executor.execute(7, {
      action: ActionType.UPLOAD,
      target: { element_id: 'el_1' },
      value_source: 'LOCAL_DOCUMENT_AADHAAR'
    }, { snapshotId: 'snap_1', mutationRevision: 1 });
    assert.equal(result.success, true);
    const document = sent.payload.resolvedValue;
    assert.equal(document.__vaultDocument, true);
    assert.equal(document.name, 'LOCAL_DOCUMENT_AADHAAR');
    assert.equal(document.fileName, 'aadhar.png');
    assert.equal(typeof document.data, 'string');
    assert.equal(document.bytes, undefined, 'a byte array cannot survive the message channel');
    assert.equal(Buffer.from(document.data, 'base64').toString('utf8'), BODY);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
