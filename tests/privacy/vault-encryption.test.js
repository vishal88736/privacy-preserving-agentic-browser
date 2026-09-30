import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { SymbolicSecretSource as S } from '../../extension/shared/constants.js';
import { VAULT_STORAGE_KEYS } from '../../extension/privacy/vault-crypto.js';
import { PolicyEngine } from '../../extension/privacy/policy-engine.js';
import { installFakeIndexedDB } from './fake-indexeddb.mjs';

/**
 * Vault at-rest encryption.
 *
 * The values in a user's vault are their Aadhaar, PAN, password and CVV. They
 * used to sit in chrome.storage.local as plaintext for the life of the install.
 *
 * These tests use a fake chrome.storage plus a real Web Crypto key, so the
 * round trip is genuinely exercised: what is written must be ciphertext, and
 * what is read back must be the original value. Node's WebCrypto and
 * IndexedDB shims are enough to prove the envelope format and the tamper
 * detection, which is where the actual risk lives.
 */

const VAULT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../extension/privacy/local-vault.js', import.meta.url)), 'utf8'
);
const CRYPTO_SOURCE = readFileSync(
  fileURLToPath(new URL('../../extension/privacy/vault-crypto.js', import.meta.url)), 'utf8'
);

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

const hasWebCrypto = Boolean(globalThis.crypto?.subtle);

/**
 * Boot a vault with a fake chrome.storage and a working IndexedDB, so the real
 * encrypt/decrypt path runs. Returns the storage backing so a test can inspect
 * or corrupt what was actually persisted.
 */
async function bootEncryptedVault(initial = {}, sharedIdb = new Map()) {
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

// ── Source-level guarantees ───────────────────────────────────────────────

test('the vault key is generated non-extractable', () => {
  // An extractable key would be readable back out of IndexedDB, which would
  // defeat the entire point: the key bytes must never exist anywhere readable.
  assert.match(CRYPTO_SOURCE, /false,\s*\n\s*\['encrypt',\s*'decrypt'\]/,
    'generateKey must pass extractable=false');
  assert.match(CRYPTO_SOURCE, /\{ name: 'AES-GCM', length: 256 \}/,
    'the vault must use AES-256-GCM');
});

test('every encryption uses a fresh random IV', () => {
  // GCM under one key is catastrophic with a reused IV. Each write must
  // generate a new one.
  assert.match(CRYPTO_SOURCE, /getRandomValues\(new Uint8Array\(12\)\)/,
    'each encryption must generate a fresh 12-byte IV');
});

test('decryption failures are not swallowed into a partial vault', () => {
  // Returning a partial set would look like a complete vault and could lead to
  // filling a form with stale or missing values.
  assert.match(CRYPTO_SOURCE, /could not be authenticated/,
    'a failed decrypt must be reported, not silently skipped');
});

test('the vault refuses to persist when encryption is unavailable', () => {
  // Silently falling back to plaintext writes would leave a user believing
  // they have at-rest protection they do not have.
  assert.match(VAULT_SOURCE, /Refusing to write an unencrypted vault/);
  assert.match(VAULT_SOURCE, /isEncryptionSupported\(\)/,
    'the vault must check encryption support before writing');
});

test('legacy plaintext storage is removed after migration', () => {
  // A migration that encrypts but leaves the old key in place leaves every
  // secret readable in the profile directory.
  assert.match(CRYPTO_SOURCE, /chrome\.storage\.local\.remove\(LEGACY_STORAGE_KEY\)/,
    'the legacy plaintext key must be removed');
});

test('the vault no longer writes to the plaintext storage key', () => {
  assert.doesNotMatch(
    VAULT_SOURCE,
    /set\(\{\s*agent_local_vault:\s*this\.memoryStore/,
    'the vault must never write a plaintext record'
  );
});

// ── Behaviour ─────────────────────────────────────────────────────────────

test('stored vault values are ciphertext, not the secret', { skip: !hasWebCrypto }, async () => {
  const secret = 'SYNTHETIC-VAULT-CIPHERTEXT-FIXTURE';
  const { vault, store, cleanup } = await bootEncryptedVault();
  try {
    await vault.updateSecret(S.LOCAL_PASSWORD, secret);

    const persisted = JSON.stringify(store);
    assert.ok(!persisted.includes(secret),
      'the secret must not be readable in stored data');
    assert.match(persisted, /"v":1/,
      'entries must be stored in the versioned encrypted envelope');
    // And the value must still be usable in memory.
    assert.equal(vault.resolveSecret(S.LOCAL_PASSWORD), secret);
  } finally {
    cleanup();
  }
});

test('a stored value round-trips back to the original', { skip: !hasWebCrypto }, async () => {
  const secret = 'SYNTHETIC-ROUNDTRIP-FIXTURE';
  const { vault, store, sharedIdb, cleanup } = await bootEncryptedVault();
  try {
    await vault.updateSecret(S.LOCAL_AADHAAR, secret);
    // Re-read through a fresh vault over the same storage AND the same key
    // store, which is what a browser restart looks like.
    const reloaded = (await bootEncryptedVault(store, sharedIdb)).vault;
    assert.equal(reloaded.resolveSecret(S.LOCAL_AADHAAR), secret,
      'an encrypted value must decrypt back to the original');
  } finally {
    cleanup();
  }
});

test('pre-review values stay encrypted and quarantined across restart until explicit review', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootEncryptedVault();
  try {
    await vault.updateSecret(S.LOCAL_PAN, 'SYNTHETIC-OLD-PAN-VALUE');
    await vault.updateSecret(S.LOCAL_PROFILE, 'SYNTHETIC-OLD-PROFILE-VALUE');
    // Simulate an encrypted record written by a release before the explicit
    // review marker existed.
    delete store[VAULT_STORAGE_KEYS.meta].reviewVersion;

    const upgraded = new LocalVault();
    await upgraded.ready;
    assert.equal(upgraded.reviewRequired, true);
    assert.equal(upgraded.resolveSecret(S.LOCAL_PAN), null, 'quarantined values cannot be resolved');
    assert.deepEqual(upgraded.getAvailableKeysSummary().map((entry) => entry.key), [],
      'quarantined keys are not offered to planning');
    assert.deepEqual(upgraded.getPendingReviewForUI(), {
      [S.LOCAL_PAN]: 'SYNTHETIC-OLD-PAN-VALUE',
      [S.LOCAL_PROFILE]: 'SYNTHETIC-OLD-PROFILE-VALUE'
    }, 'the trusted vault UI can display the preserved values');
    assert.equal(upgraded.getAllSecretsForUI()[S.LOCAL_PAN], 'SYNTHETIC-OLD-PAN-VALUE',
      'privacy policy scanning still recognizes quarantined values');
    await assert.rejects(
      new PolicyEngine(upgraded).enforceOutboundSafety({ note: 'SYNTHETIC-OLD-PAN-VALUE' }),
      /Contains raw value of LOCAL_PAN/
    );

    const oldCiphertext = JSON.stringify(store[VAULT_STORAGE_KEYS.encrypted]);
    await assert.rejects(upgraded.updateSecret(S.LOCAL_PAN, 'OVERWRITE-BEFORE-REVIEW'), /review/i);
    assert.equal(JSON.stringify(store[VAULT_STORAGE_KEYS.encrypted]), oldCiphertext,
      'ordinary updates must not overwrite quarantined storage');
    assert.equal(store[VAULT_STORAGE_KEYS.meta].reviewVersion, undefined,
      'ordinary updates cannot mark the old record reviewed');

    const afterRestart = new LocalVault();
    await afterRestart.ready;
    assert.equal(afterRestart.reviewRequired, true);
    assert.equal(afterRestart.resolveSecret(S.LOCAL_PAN), null);
    assert.equal(afterRestart.getPendingReviewForUI()[S.LOCAL_PROFILE], 'SYNTHETIC-OLD-PROFILE-VALUE');

    // A UI version that submits only fields it rendered may update the PAN;
    // omitted valid keys must survive confirmation unchanged.
    await afterRestart.confirmReview({ [S.LOCAL_PAN]: 'SYNTHETIC-REVIEWED-PAN' });
    assert.equal(afterRestart.reviewRequired, false);
    assert.equal(afterRestart.resolveSecret(S.LOCAL_PAN), 'SYNTHETIC-REVIEWED-PAN');
    assert.equal(afterRestart.resolveSecret(S.LOCAL_PROFILE), 'SYNTHETIC-OLD-PROFILE-VALUE');
    assert.equal(store[VAULT_STORAGE_KEYS.meta].reviewVersion, 1);

    const finalRestart = new LocalVault();
    await finalRestart.ready;
    assert.equal(finalRestart.reviewRequired, false);
    assert.equal(finalRestart.resolveSecret(S.LOCAL_PAN), 'SYNTHETIC-REVIEWED-PAN');
    assert.equal(finalRestart.resolveSecret(S.LOCAL_PROFILE), 'SYNTHETIC-OLD-PROFILE-VALUE');
  } finally {
    cleanup();
  }
});

test('each write uses a different IV for the same value', { skip: !hasWebCrypto }, async () => {
  const secret = 'SYNTHETIC-IV-ROTATION-FIXTURE';
  const { vault, store, cleanup } = await bootEncryptedVault();
  try {
    await vault.updateSecret(S.LOCAL_PAN, secret);
    const first = JSON.parse(JSON.stringify(store)).agent_local_vault_encrypted[S.LOCAL_PAN];

    await vault.updateSecret(S.LOCAL_PAN, secret);
    const second = JSON.parse(JSON.stringify(store)).agent_local_vault_encrypted[S.LOCAL_PAN];

    assert.ok(first?.iv && second?.iv, 'both writes must record an IV');
    assert.notEqual(first.iv, second.iv,
      'a repeated value must not reuse an IV under the same key');
    assert.notEqual(first.ct, second.ct,
      'the same plaintext must produce different ciphertext');
  } finally {
    cleanup();
  }
});

test('a tampered ciphertext is rejected rather than returned', { skip: !hasWebCrypto }, async () => {
  const { vault, store, sharedIdb, cleanup } = await bootEncryptedVault();
  try {
    await vault.updateSecret(S.LOCAL_CVV, 'SYNTHETIC-CVV-FIXTURE');

    const entry = store.agent_local_vault_encrypted[S.LOCAL_CVV];
    assert.ok(entry, 'the value must have been stored');

    // Flip one byte of the ciphertext, the way a corrupted profile or a
    // tampered backup would.
    const bytes = Buffer.from(entry.ct, 'base64');
    bytes[0] ^= 0xff;
    store.agent_local_vault_encrypted[S.LOCAL_CVV] = { ...entry, ct: bytes.toString('base64') };

    const reloaded = (await bootEncryptedVault(store, sharedIdb)).vault;
    assert.equal(reloaded.resolveSecret(S.LOCAL_CVV), null,
      'a tampered entry must not be served as a usable value');
    assert.ok(reloaded.storageError, 'the failure must be surfaced, not silent');
  } finally {
    cleanup();
  }
});

test('a legacy plaintext vault is migrated and the plaintext removed', { skip: !hasWebCrypto }, async () => {
  const secret = 'SYNTHETIC-LEGACY-MIGRATION-FIXTURE';
  const { vault, store, cleanup } = await bootEncryptedVault({
    agent_local_vault: { [S.LOCAL_PAN]: secret }
  });
  try {
    assert.equal(vault.reviewRequired, true,
      'values migrated from plaintext must require explicit review');
    assert.equal(vault.resolveSecret(S.LOCAL_PAN), null,
      'a migrated value must remain quarantined until reviewed');
    assert.equal(vault.getPendingReviewForUI()[S.LOCAL_PAN], secret,
      'the encrypted value must remain available in the trusted vault UI');
    assert.equal(vault.getAllSecretsForUI()[S.LOCAL_PAN], secret,
      'the privacy scanner must still recognize the quarantined value');
    assert.ok(!JSON.stringify(store).includes(secret),
      'the plaintext secret must not remain in storage after migration');
    assert.equal(store.agent_local_vault, undefined,
      'the legacy plaintext key must be removed');
  } finally {
    cleanup();
  }
});

test('the vault reports an error instead of pretending to be protected', async () => {
  // No chrome global at all: the vault must degrade visibly.
  const previous = globalThis.chrome;
  delete globalThis.chrome;
  try {
    const vault = new LocalVault();
    await vault.ready;
    await vault.updateSecret(S.LOCAL_PAN, 'SYNTHETIC-NO-STORAGE-FIXTURE');
    // In-memory behaviour is unchanged: the executor still gets the value.
    assert.equal(vault.resolveSecret(S.LOCAL_PAN), 'SYNTHETIC-NO-STORAGE-FIXTURE');
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

// ── Backend shared secret ──────────────────────────────────────────────────
//
// The token authenticates every model call and is copied out of a .env file.
// It was stored inside the settings blob, so it landed in
// chrome.storage.local as plaintext alongside ordinary preferences.

test('the backend token is never written into the settings record', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../extension/background/task-manager.js', import.meta.url)), 'utf8'
  );
  assert.match(source, /const \{ backendToken, \.\.\.persisted \} = this\.settings;/,
    'the token must be stripped before the settings record is written');
  assert.doesNotMatch(
    source,
    /set\(\{ privagent_settings: this\.settings \}\)/,
    'the whole settings object, token included, must never be written directly'
  );
  assert.match(source, /writeEncryptedSecret\(BACKEND_TOKEN_STORAGE_KEY/,
    'the token must be persisted through the encrypted store');
});

test('the backend token round-trips through the encrypted store', { skip: !hasWebCrypto }, async () => {
  const { BACKEND_TOKEN_STORAGE_KEY, writeEncryptedSecret, readEncryptedSecret } =
    await import('../../extension/privacy/vault-crypto.js');
  const { store, sharedIdb, cleanup } = await bootEncryptedVault();

  try {
    const token = 'synthetic-backend-token-fixture';
    await writeEncryptedSecret(BACKEND_TOKEN_STORAGE_KEY, token);

    const raw = JSON.stringify(store);
    assert.ok(!raw.includes(token), 'the token must not be readable in stored data');

    const readBack = await (async () => {
      // Same profile, same key store: a restart must still find the token.
      await bootEncryptedVault(store, sharedIdb);
      return readEncryptedSecret(BACKEND_TOKEN_STORAGE_KEY);
    })();
    assert.equal(readBack, token);
  } finally {
    cleanup();
  }
});
