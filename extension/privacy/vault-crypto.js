/**
 * At-rest encryption for the Local Vault.
 *
 * `chrome.storage.local` is extension-scoped but NOT encrypted: Aadhaar, PAN,
 * passwords and CVVs sat in the profile directory as plaintext for the life of
 * the install, recoverable from a disk image, a backup, or any process running
 * as the same user.
 *
 * Design
 * ------
 * A non-extractable AES-GCM CryptoKey is generated once and persisted in
 * IndexedDB. IndexedDB can store a CryptoKey handle but cannot serialise its
 * material, so the key bytes never exist in any form that can be read back —
 * not from IndexedDB, not from chrome.storage, not from disk. Only code
 * running inside this extension, in this profile, can ask the browser to
 * decrypt with it.
 *
 * What this does and does not defend against:
 *   - Protects: a stolen profile directory, a backup, a synced copy, another
 *     process reading the files as the same OS user.
 *   - Does not protect: malware or a devtools session with the extension's own
 *     origin. A key that cannot be exported is not the same as a key that cannot
 *     be used, and anything that can run code as this extension can call
 *     `decrypt()`. The honest boundary is "not readable as data at rest", not
 *     "unbreakable".
 *
 * Per-value random IVs are stored alongside each ciphertext; GCM forbids IV
 * reuse under one key, so each write generates a fresh 12-byte IV.
 */

const DB_NAME = 'privagent_vault_crypto';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const KEY_ID = 'vault-aes-gcm';

/** AES-GCM payload envelope stored in chrome.storage.local. */
const VAULT_STORAGE_KEY = 'agent_local_vault_encrypted';
/** Previous plaintext key, read once for migration then removed. */
const LEGACY_STORAGE_KEY = 'agent_local_vault';
/** Non-secret marker recording the crypto schema version. */
const VAULT_META_KEY = 'agent_local_vault_meta';
// This marker is independent of the AES envelope version. It records that a
// user explicitly reviewed values recovered from older vault builds.
const VAULT_REVIEW_VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function isCryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle) && typeof globalThis.indexedDB !== 'undefined';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the vault key database.'));
  });
}

function idbRequest(store, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = store.transaction;
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Vault key database request failed.'));
    // A transaction that never commits leaves the request pending forever.
    transaction.onabort = () => reject(transaction.error || new Error('Vault key transaction aborted.'));
  });
}

/** Load the vault key, generating one on first use. */
async function loadOrCreateKey() {
  const db = await openDatabase();
  try {
    const store = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE);
    const existing = await idbRequest(store, 'readonly', (s) => s.get(KEY_ID));
    if (existing) return existing;

    const key = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      // Non-extractable: the browser will never reveal these bytes, which is
      // the entire point. IndexedDB stores the handle, not the material.
      false,
      ['encrypt', 'decrypt']
    );
    const writable = db.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE);
    await idbRequest(writable, 'readwrite', (s) => s.put(key, KEY_ID));
    return key;
  } finally {
    db.close();
  }
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encrypt one string into a self-describing envelope. */
export async function encryptValue(plaintext, key) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return {
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext))
  };
}

/** Decrypt one envelope. Throws if the data was tampered with. */
export async function decryptValue(envelope, key) {
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ct)
  );
  return dec.decode(plaintext);
}

function looksLikeEnvelope(value) {
  return Boolean(value) && typeof value === 'object'
    && value.v === 1 && typeof value.iv === 'string' && typeof value.ct === 'string';
}

/**
 * True when this environment can encrypt at rest.
 *
 * Callers use this to decide whether to store encrypted. When it is false the
 * vault must say so rather than silently falling back to plaintext writes.
 */
export function isEncryptionSupported() {
  return isCryptoAvailable() && typeof btoa === 'function' && typeof atob === 'function';
}

/**
 * Read and decrypt the vault.
 * @returns {Promise<{ok: boolean, values: Object, reason?: string}>}
 */
export async function readEncryptedVault() {
  if (!isEncryptionSupported()) {
    return { ok: false, values: {}, reason: 'This browser does not provide Web Crypto or IndexedDB, so the vault cannot be encrypted at rest.' };
  }
  let key;
  try {
    key = await loadOrCreateKey();
  } catch (error) {
    return { ok: false, values: {}, reason: `The vault key is unavailable: ${error?.message || 'unknown error'}` };
  }

  const [stored, metaStored] = await Promise.all([
    chrome.storage.local.get(VAULT_STORAGE_KEY),
    chrome.storage.local.get(VAULT_META_KEY)
  ]);
  const envelope = stored?.[VAULT_STORAGE_KEY];
  if (!envelope || typeof envelope !== 'object') return { ok: true, values: {} };

  const values = {};
  for (const [name, entry] of Object.entries(envelope)) {
    if (!looksLikeEnvelope(entry)) {
      return { ok: false, values: {}, reason: `Stored vault entry for "${name}" is not a valid encrypted record.` };
    }
    try {
      values[name] = await decryptValue(entry, key);
    } catch {
      // GCM authentication failure: the ciphertext was altered, or it belongs
      // to a key this profile no longer has. Refuse the whole vault rather
      // than returning a partial set that could be mistaken for complete.
      return { ok: false, values: {}, reason: `The vault entry for "${name}" could not be authenticated; it may have been altered.` };
    }
  }
  const meta = metaStored?.[VAULT_META_KEY];
  const reviewRequired = Object.keys(envelope).length > 0 && meta?.reviewVersion !== VAULT_REVIEW_VERSION;
  return { ok: true, values, reviewRequired };
}

/**
 * Encrypt and persist the vault, then remove any plaintext copy.
 * @param {Object} values
 */
export async function writeEncryptedVault(values, { reviewed = true } = {}) {
  if (!isEncryptionSupported()) {
    throw new Error('Encryption is unavailable in this environment.');
  }
  const key = await loadOrCreateKey();
  const envelope = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value === '') continue;
    envelope[name] = await encryptValue(value, key);
  }
  await chrome.storage.local.set({
    [VAULT_STORAGE_KEY]: envelope,
    [VAULT_META_KEY]: {
      encrypted: true,
      version: 1,
      reviewVersion: reviewed ? VAULT_REVIEW_VERSION : 0,
      updatedAt: Date.now()
    }
  });
  // Drop the legacy plaintext key if one is still present, so a migration never
  // leaves readable secrets behind.
  const legacy = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  if (legacy?.[LEGACY_STORAGE_KEY]) {
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  }
}

/**
 * One-time migration: read a pre-existing plaintext vault, encrypt it, and
 * remove the plaintext. Returns the values so the caller can keep them in
 * memory, or null when there was nothing to migrate.
 */
export async function migrateLegacyVault() {
  const stored = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  const legacy = stored?.[LEGACY_STORAGE_KEY];
  if (!legacy || typeof legacy !== 'object' || !Object.keys(legacy).length) return null;
  if (!isEncryptionSupported()) return null;
  const values = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (typeof value === 'string' && value !== '') values[key] = value;
  }
  // Values recovered from the old plaintext layout stay encrypted but are not
  // activated until the user reviews them in the trusted vault UI.
  await writeEncryptedVault(values, { reviewed: false });
  return values;
}

/** Remove every stored vault record. Used when encryption becomes unusable. */
export async function clearVaultStorage() {
  await chrome.storage.local.remove([VAULT_STORAGE_KEY, LEGACY_STORAGE_KEY, VAULT_META_KEY]);
}

// ── Single encrypted values ───────────────────────────────────────────────
//
// Some credentials are not vault entries but still must not sit in
// chrome.storage.local as plaintext: the backend shared secret authenticates
// every model call and is copied from a .env file on the developer's machine.
// They reuse the same key and the same envelope, stored in their own key so
// each is written independently.

/** Storage key for the encrypted backend shared secret. */
export const BACKEND_TOKEN_STORAGE_KEY = 'agent_backend_token_encrypted';

/**
 * Storage key for the named-document store.
 *
 * Document bytes are identity documents (Aadhaar scans, passports, PAN cards),
 * so they are the most sensitive thing this extension holds. They are stored
 * as ONE encrypted envelope under the same non-extractable AES-GCM key as every
 * other secret — never as loose base64 in chrome.storage.local, which would be
 * plaintext with a cosmetic disguise.
 */
export const VAULT_DOCUMENTS_STORAGE_KEY = 'agent_local_vault_documents_encrypted';

/**
 * Store one value as an encrypted envelope.
 * @returns {Promise<boolean>} whether the value was persisted
 */
export async function writeEncryptedSecret(storageKey, value) {
  if (!isEncryptionSupported()) return false;
  const key = await loadOrCreateKey();
  await chrome.storage.local.set({ [storageKey]: await encryptValue(String(value), key) });
  return true;
}

/** Read and decrypt one stored value, or null when absent/unreadable. */
export async function readEncryptedSecret(storageKey) {
  if (!isEncryptionSupported()) return null;
  const stored = await chrome.storage.local.get(storageKey);
  const envelope = stored?.[storageKey];
  if (!looksLikeEnvelope(envelope)) return null;
  try {
    const key = await loadOrCreateKey();
    return await decryptValue(envelope, key);
  } catch {
    // Authentication failure: refuse rather than return a wrong value.
    return null;
  }
}

/** Remove a stored encrypted value. */
export async function deleteEncryptedSecret(storageKey) {
  await chrome.storage.local.remove(storageKey);
}

export const VAULT_STORAGE_KEYS = Object.freeze({
  encrypted: VAULT_STORAGE_KEY,
  legacy: LEGACY_STORAGE_KEY,
  meta: VAULT_META_KEY,
  documents: VAULT_DOCUMENTS_STORAGE_KEY
});
