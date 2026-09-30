import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { isDocumentToken, MAX_VAULT_DOCUMENT_BYTES } from '../../extension/shared/constants.js';
import { installFakeIndexedDB } from './fake-indexeddb.mjs';

/**
 * Named documents in the local vault.
 *
 * A stored identity document is the most sensitive thing this extension holds:
 * a scan of an Aadhaar card, a passport image, a PAN card. Two properties are
 * load-bearing and are pinned here —
 *
 *   1. The NAME is a security boundary. It becomes a token the remote model
 *      sees and can choose from, so it is restricted to `LOCAL_DOCUMENT_` plus
 *      uppercase/digits/underscores. That grammar cannot express a path, a
 *      directory, or a file id, which is what makes "read an arbitrary local
 *      file" unrepresentable rather than merely forbidden.
 *   2. The BYTES are encrypted with the same non-extractable AES-GCM key as
 *      every other secret. A base64 blob sitting in chrome.storage.local would
 *      be plaintext wearing a disguise, so the tests read the raw storage back
 *      and prove neither the file content nor its base64 is present.
 *
 * `getAllSecretsForUI()` is the exact-match scanner for every outbound payload
 * (policy engine, DOM sanitizer). A document blob in there would be scanned as
 * text on every request, so documents live in a separate store entirely.
 */

const hasWebCrypto = Boolean(globalThis.crypto?.subtle);

/** A chrome.storage.local stand-in that records what was actually written. */
function fakeChromeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    api: {
      storage: {
        local: {
          get: async (key) => (key in store ? { [key]: store[key] } : {}),
          set: async (obj) => { Object.assign(store, obj); },
          remove: async (keys) => {
            for (const key of [].concat(keys)) delete store[key];
          }
        }
      }
    }
  };
}

async function bootVault(initial = {}, sharedIdb = new Map()) {
  const { api, store } = fakeChromeStorage(initial);
  const restoreIdb = installFakeIndexedDB(sharedIdb);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = api;
  const vault = new LocalVault();
  await vault.ready;
  return {
    vault,
    store,
    sharedIdb,
    cleanup() {
      restoreIdb();
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    }
  };
}

/** Body of a synthetic "identity document". Never a real document. */
const DOCUMENT_TEXT = 'SYNTHETIC-IDENTITY-DOCUMENT-FIXTURE-BODY-0001';
const documentBytes = () => new TextEncoder().encode(DOCUMENT_TEXT);
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

// ── Name validation ────────────────────────────────────────────────────────

test('a well-formed document name is accepted', async () => {
  const vault = new LocalVault();
  for (const name of ['LOCAL_DOCUMENT_A', 'LOCAL_DOCUMENT_AADHAAR', 'LOCAL_DOCUMENT_PAN_CARD', `LOCAL_DOCUMENT_${'X'.repeat(48)}`]) {
    assert.equal(isDocumentToken(name), true, `${name} must be a valid document token`);
    await vault.updateDocument(name, { bytes: documentBytes(), fileName: 'id.pdf', mimeType: 'application/pdf' });
    assert.ok(vault.hasDocument(name));
  }
});

test('a document name that could name a path, a glob, or a foreign key is rejected', async () => {
  const vault = new LocalVault();
  const rejected = [
    '../../../etc/passwd',                       // traversal
    '/etc/passwd',                               // absolute path
    'C:\\Users\\me\\aadhar.pdf',                 // windows path
    'file:///home/me/passport.jpg',              // URL
    'LOCAL_DOCUMENT_aadhar',                     // lowercase: not the token grammar
    'LOCAL_DOCUMENT_AADHAAR;DROP',               // statement separator
    'LOCAL_DOCUMENT_AADHAAR\nX',                 // control character
    'LOCAL_AADHAAR',                             // not a document token
    'LOCAL_DOCUMENT',                            // the bare schema enum, not a name
    'LOCAL_CUSTOM_AADHAAR',                      // custom secrets are not documents
    `LOCAL_DOCUMENT_${'X'.repeat(49)}`,          // over the length bound
    '',
    null
  ];
  for (const name of rejected) {
    assert.equal(isDocumentToken(name), false, `${String(name)} must not be a document token`);
    await assert.rejects(
      vault.updateDocument(name, { bytes: documentBytes() }),
      /Unsupported document name/,
      `${String(name)} must be rejected by the vault`
    );
  }
  assert.deepEqual(vault.getDocumentsSummary(), [], 'no rejected name may leave a record');
});

test('resolveDocument and deleteDocument refuse anything that is not a document token', async () => {
  const vault = new LocalVault();
  await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.pdf' });
  assert.equal(vault.resolveSecret('LOCAL_DOCUMENT_AADHAAR'), null,
    'a document must not be readable as a text secret');
  assert.equal(vault.resolveDocument('../../etc/passwd'), null);
  assert.equal(vault.resolveDocument('LOCAL_AADHAAR'), null);
  assert.equal(vault.hasDocument('LOCAL_PAN'), false);
  await assert.rejects(vault.deleteDocument('nonsense'), /Unsupported document name/);
});

// ── Round trip ─────────────────────────────────────────────────────────────

test('a stored document resolves to the exact bytes, name, and type', async () => {
  const vault = new LocalVault();
  const bytes = documentBytes();
  const stored = await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', {
    bytes,
    fileName: 'aadhar-card.png',
    mimeType: 'image/png'
  });
  assert.deepEqual(stored, {
    name: 'LOCAL_DOCUMENT_AADHAAR',
    fileName: 'aadhar-card.png',
    mimeType: 'image/png',
    byteLength: bytes.length
  });

  const resolved = vault.resolveDocument('LOCAL_DOCUMENT_AADHAAR');
  assert.equal(resolved.name, 'LOCAL_DOCUMENT_AADHAAR');
  assert.equal(resolved.fileName, 'aadhar-card.png');
  assert.equal(resolved.mimeType, 'image/png');
  assert.equal(resolved.byteLength, bytes.length);
  assert.deepEqual(Array.from(resolved.bytes), Array.from(bytes));
});

test('base64 data is accepted, so a side panel can send a File without a Buffer', async () => {
  const vault = new LocalVault();
  await vault.updateDocument('LOCAL_DOCUMENT_PAN', {
    data: toBase64(documentBytes()),
    fileName: 'pan.jpg',
    mimeType: 'image/jpeg'
  });
  assert.equal(vault.resolveDocument('LOCAL_DOCUMENT_PAN').byteLength, documentBytes().length);
  await assert.rejects(vault.updateDocument('LOCAL_DOCUMENT_PAN', { data: 'not base64 !!' }), /could not be read/);
});

test('a stored file name is reduced to a bare basename', async () => {
  const vault = new LocalVault();
  await vault.updateDocument('LOCAL_DOCUMENT_PASSPORT', {
    bytes: documentBytes(),
    fileName: '../../home/vishal/Documents/passport scan.pdf'
  });
  const { fileName } = vault.resolveDocument('LOCAL_DOCUMENT_PASSPORT');
  assert.equal(fileName, 'passport scan.pdf');
  assert.ok(!fileName.includes('/') && !fileName.includes('\\'), 'no directory component may survive');
});

test('an unusable MIME type falls back instead of being stored verbatim', async () => {
  const vault = new LocalVault();
  await vault.updateDocument('LOCAL_DOCUMENT_X', { bytes: documentBytes(), mimeType: 'nonsense" onload=alert(1)' });
  assert.equal(vault.resolveDocument('LOCAL_DOCUMENT_X').mimeType, 'application/octet-stream');
});

// ── Privacy of the surrounding APIs ────────────────────────────────────────

test('getAllSecretsForUI never contains a document, in any form', async () => {
  const { vault, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', {
      bytes: documentBytes(),
      fileName: 'aadhar.png',
      mimeType: 'image/png'
    });
    const forScanning = vault.getAllSecretsForUI();
    const serialized = JSON.stringify(forScanning);
    assert.deepEqual(forScanning, {}, 'the outbound scanner must see no document entry');
    assert.ok(!serialized.includes(DOCUMENT_TEXT));
    assert.ok(!serialized.includes(toBase64(documentBytes())));
    assert.ok(!serialized.includes('AADHAAR'));
  } finally {
    cleanup();
  }
});

test('the documents summary carries names and metadata but never bytes', async () => {
  const { vault, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png', mimeType: 'image/png' });
    await vault.updateDocument('LOCAL_DOCUMENT_PAN', { bytes: documentBytes(), fileName: 'p.jpg', mimeType: 'image/jpeg' });
    const summary = vault.getDocumentsSummary();
    assert.deepEqual(summary.map((doc) => doc.name), ['LOCAL_DOCUMENT_AADHAAR', 'LOCAL_DOCUMENT_PAN']);
    for (const doc of summary) {
      assert.deepEqual(Object.keys(doc).sort(), ['byteLength', 'fileName', 'mimeType', 'name']);
      assert.equal(typeof doc.byteLength, 'number');
    }
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(DOCUMENT_TEXT));
    assert.ok(!serialized.includes(toBase64(documentBytes())));
  } finally {
    cleanup();
  }
});

test('the outbound policy engine still accepts a payload that names a stored document', async () => {
  const { PolicyEngine } = await import('../../extension/privacy/policy-engine.js');
  const { vault, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png', mimeType: 'image/png' });
    const engine = new PolicyEngine(vault);
    // The planner is told which documents exist. That is a token, not a value,
    // so it must survive the outbound scan — and must not drag the document
    // itself into the scan in the first place.
    assert.equal(await engine.enforceOutboundSafety({
      task: 'Upload my Aadhaar',
      stored_documents: ['LOCAL_DOCUMENT_AADHAAR']
    }), true);
    // The bytes still never get to the scan: a payload that tried to carry
    // them is not something the extension builds, and the vault no longer
    // feeds the engine anything to match against.
    assert.deepEqual(vault.getAllSecretsForUI(), {});
  } finally {
    cleanup();
  }
});

test('a document body is still a violation if it ever appeared in an outbound payload', async () => {
  const { PolicyEngine } = await import('../../extension/privacy/policy-engine.js');
  const { vault, cleanup } = await bootVault();
  try {
    // Deliberately not a real document: a numeric body of the shape a policy
    // rule must still catch, proving document storage did not weaken the
    // outbound gate for content that DOES reach it.
    const aadhaar = new Uint8Array(12);
    aadhaar.set([2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]);
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: aadhaar, fileName: 'a.png', mimeType: 'image/png' });
    const engine = new PolicyEngine(vault);
    await assert.rejects(
      () => engine.enforceOutboundSafety({ note: 'My aadhaar: 3456 7890 1234' }),
      /Outbound policy blocked payload/,
      'the PII rules must keep working regardless of what the vault holds'
    );
  } finally {
    cleanup();
  }
});

test('stored document names appear in the UI key summary so the planner can see them', async () => {
  const { vault, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png', mimeType: 'image/png' });
    const row = vault.getAvailableKeysSummary().find((entry) => entry.key === 'LOCAL_DOCUMENT_AADHAAR');
    assert.ok(row, 'the side panel must be able to list the stored documents');
    assert.equal(row.kind, 'document');
    assert.equal(row.isConfigured, true);
    assert.ok(!JSON.stringify(row).includes(toBase64(documentBytes())));
  } finally {
    cleanup();
  }
});

// ── Limits ─────────────────────────────────────────────────────────────────

test('a document over the 8 MB cap is refused and nothing is stored', async () => {
  const vault = new LocalVault();
  const oversize = new Uint8Array(MAX_VAULT_DOCUMENT_BYTES + 1);
  await assert.rejects(
    vault.updateDocument('LOCAL_DOCUMENT_HUGE', { bytes: oversize, fileName: 'huge.pdf' }),
    /limit is 8 MB/
  );
  assert.equal(vault.hasDocument('LOCAL_DOCUMENT_HUGE'), false);
  assert.deepEqual(vault.getDocumentsSummary(), []);
});

test('a document exactly at the cap is accepted', async () => {
  const vault = new LocalVault();
  const atCap = new Uint8Array(MAX_VAULT_DOCUMENT_BYTES).fill(7);
  await vault.updateDocument('LOCAL_DOCUMENT_AT_CAP', { bytes: atCap, fileName: 'cap.bin' });
  assert.equal(vault.resolveDocument('LOCAL_DOCUMENT_AT_CAP').byteLength, MAX_VAULT_DOCUMENT_BYTES);
});

test('an empty document is refused', async () => {
  const vault = new LocalVault();
  await assert.rejects(vault.updateDocument('LOCAL_DOCUMENT_EMPTY', { bytes: new Uint8Array(0) }), /empty/);
  await assert.rejects(vault.updateDocument('LOCAL_DOCUMENT_EMPTY', { bytes: [1, 'x', 3] }), /empty/);
});

// ── At rest ────────────────────────────────────────────────────────────────

test('document bytes are encrypted at rest, not stored as base64', { skip: !hasWebCrypto }, async () => {
  const { vault, store, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', {
      bytes: documentBytes(),
      fileName: 'aadhar.png',
      mimeType: 'image/png'
    });
    const persisted = JSON.stringify(store);
    assert.ok(!persisted.includes(DOCUMENT_TEXT), 'the file body must not be readable in storage');
    assert.ok(!persisted.includes(toBase64(documentBytes())), 'the encoded body must not be readable either');
    assert.match(persisted, /"v":1/, 'documents must use the same encrypted envelope as other secrets');
    assert.ok(store.agent_local_vault_documents_encrypted, 'documents live in their own encrypted record');
  } finally {
    cleanup();
  }
});

test('a stored document survives a restart', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', {
      bytes: documentBytes(),
      fileName: 'aadhar.png',
      mimeType: 'image/png'
    });
    const reloaded = (await bootVault(store, sharedIdb)).vault;
    const resolved = reloaded.resolveDocument('LOCAL_DOCUMENT_AADHAAR');
    assert.ok(resolved, 'a document stored before a restart must still be there after it');
    assert.deepEqual(Array.from(resolved.bytes), Array.from(documentBytes()));
    assert.equal(resolved.fileName, 'aadhar.png');
  } finally {
    cleanup();
  }
});

test('deleting a document removes it from disk as well as memory', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png' });
    await vault.updateDocument('LOCAL_DOCUMENT_PAN', { bytes: documentBytes(), fileName: 'p.png' });
    assert.equal(await vault.deleteDocument('LOCAL_DOCUMENT_AADHAAR'), true);
    assert.equal(await vault.deleteDocument('LOCAL_DOCUMENT_AADHAAR'), false, 'deleting twice is not an error');

    const reloaded = (await bootVault(store, sharedIdb)).vault;
    assert.equal(reloaded.hasDocument('LOCAL_DOCUMENT_AADHAAR'), false);
    assert.equal(reloaded.hasDocument('LOCAL_DOCUMENT_PAN'), true, 'the other document must be untouched');
  } finally {
    cleanup();
  }
});

test('a record whose stored name is not a valid token is dropped, not revived', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png' });
    // A profile downgrade, a bug, or a tampered-then-re-encrypted record could
    // leave a key that is not a valid token. Reading re-validates, so such a
    // record never becomes a token the model could select.
    const { writeEncryptedSecret, VAULT_DOCUMENTS_STORAGE_KEY } =
      await import('../../extension/privacy/vault-crypto.js');
    await writeEncryptedSecret(VAULT_DOCUMENTS_STORAGE_KEY, JSON.stringify({
      '../../../etc/passwd': { data: toBase64(documentBytes()), fileName: 'x', mimeType: 'text/plain' },
      'LOCAL_AADHAAR': { data: toBase64(documentBytes()), fileName: 'y', mimeType: 'text/plain' },
      LOCAL_DOCUMENT_AADHAAR: { data: toBase64(documentBytes()), fileName: 'a.png', mimeType: 'image/png' }
    }));

    const reloaded = (await bootVault(store, sharedIdb)).vault;
    assert.deepEqual(reloaded.getDocumentsSummary().map((doc) => doc.name), ['LOCAL_DOCUMENT_AADHAAR'],
      'only the well-formed name may come back');
  } finally {
    cleanup();
  }
});

test('a document store that cannot be read is not served as a partial set', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootVault();
  try {
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png' });
    const envelope = store.agent_local_vault_documents_encrypted;
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] ^= 0xff;
    store.agent_local_vault_documents_encrypted = { ...envelope, ct: bytes.toString('base64') };

    const reloaded = (await bootVault(store, sharedIdb)).vault;
    assert.equal(reloaded.hasDocument('LOCAL_DOCUMENT_AADHAAR'), false,
      'a document whose ciphertext failed authentication must not be served');
  } finally {
    cleanup();
  }
});

test('without storage the vault still works in memory and never claims persistence', async () => {
  const previous = globalThis.chrome;
  delete globalThis.chrome;
  try {
    const vault = new LocalVault();
    await vault.ready;
    await vault.updateDocument('LOCAL_DOCUMENT_AADHAAR', { bytes: documentBytes(), fileName: 'a.png' });
    assert.equal(vault.resolveDocument('LOCAL_DOCUMENT_AADHAAR').byteLength, documentBytes().length);
    assert.equal(await vault.deleteDocument('LOCAL_DOCUMENT_AADHAAR'), true);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
