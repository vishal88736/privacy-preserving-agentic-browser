/**
 * Local Secret Vault
 * User-configured values, encrypted at rest.
 *
 * Values live in memory as plaintext (the executor needs them), but everything
 * written to chrome.storage.local is AES-GCM ciphertext under a non-extractable
 * key held in IndexedDB. See vault-crypto.js for the threat model.
 *
 * If encryption is unavailable the vault refuses to persist anything rather
 * than silently writing plaintext back — a user who cannot tell the difference
 * would assume protection they are not getting.
 *
 * L11: getAllSecretsForUI now filters out non-string entries (like document blobs)
 *      to prevent policy engine false positives and memory bloat.
 *
 * Named documents
 * ---------------
 * A user can also store an identity document (Aadhaar scan, passport, PAN card)
 * under a name of their choosing. Documents live in a SEPARATE store from text
 * secrets so that every existing consumer of `memoryStore` — the outbound
 * policy engine, the DOM sanitizer, the UI vault dump — is structurally
 * incapable of ever seeing a document byte. `getAllSecretsForUI()` is the
 * outbound exact-match scanner and `getDocumentsSummary()` is what the planner
 * sees; they are different methods over different stores on purpose.
 *
 * There is no API here that takes a file path, a URL, or a file handle. The
 * only handle on a document is its validated name, and the only thing that
 * turns a name into bytes is `resolveDocument`, which runs in the background at
 * execution time.
 */

import { SymbolicSecretSource, isDocumentToken, MAX_VAULT_DOCUMENT_BYTES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import {
  isEncryptionSupported,
  migrateLegacyVault,
  readEncryptedVault,
  writeEncryptedVault,
  writeEncryptedSecret,
  readEncryptedSecret,
  deleteEncryptedSecret,
  toBase64,
  fromBase64,
  VAULT_DOCUMENTS_STORAGE_KEY
} from './vault-crypto.js';

const log = createLogger({ scope: 'LocalVault', surface: 'background' });

/** Fallback type when the caller cannot report one; never inferred from bytes. */
const DEFAULT_DOCUMENT_MIME = 'application/octet-stream';
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

export class LocalVault {
  constructor() {
    this.memoryStore = {};
    /** Legacy values kept encrypted at rest but inactive until UI review. */
    this.pendingReviewStore = {};
    this.reviewRequired = false;
    /** name -> { bytes, fileName, mimeType, byteLength }. Never stringified. */
    this.documentStore = {};
    /** Set when at-rest encryption is impossible; surfaced in the UI. */
    this.storageError = null;
    // When there is no storage backend to hydrate from (tests, restricted
    // contexts) nothing is pending, so synchronous reads are safe at once.
    // With storage present, isReady stays false until `ready` resolves and
    // `_assertReady` keeps outbound consumers from scanning a half-loaded vault.
    this.isReady = typeof chrome === 'undefined' || !chrome.storage?.local;
    this.ready = this._loadFromStorage().finally(() => {
      this.isReady = true;
    });
  }

  /** Refuse synchronous reads while the encrypted records are still loading. */
  _assertReady() {
    if (this.isReady === false) {
      throw new Error('The Local Vault is still loading. Wait for vault.ready before reading it.');
    }
  }

  async _loadFromStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    if (!isEncryptionSupported()) {
      this.storageError = 'This browser cannot encrypt the vault at rest, so values will not be saved.';
      return;
    }
    try {
      // One-time migration from the pre-encryption plaintext layout.
      await migrateLegacyVault();
      const result = await readEncryptedVault();
      if (!result.ok) {
        this.storageError = result.reason;
        return;
      }
      const safe = {};
      for (const [key, value] of Object.entries(result.values)) {
        if (isVaultKey(key) && typeof value === 'string') safe[key] = value;
      }
      if (result.reviewRequired && Object.keys(safe).length) {
        // Older builds may have written built-in demonstration values. Do not
        // guess which values are real user data: preserve the complete set in
        // memory for the trusted vault UI and policy scanning, but keep it out
        // of planner summaries and value resolution until the user reviews it.
        this.pendingReviewStore = safe;
        this.reviewRequired = true;
        this.memoryStore = {};
      } else {
        this.memoryStore = safe;
      }
    } catch (e) {
      this.storageError = `The vault could not be read: ${e?.message || 'unknown error'}`;
      log.exception('Could not read the encrypted vault', e);
    }
    // Documents are loaded independently: an unreadable document set must not
    // cost the user their text secrets, and vice versa.
    await this._loadDocuments();
  }

  // ── Named documents ─────────────────────────────────────────────────────

  async _loadDocuments() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    if (!isEncryptionSupported()) return;
    try {
      const raw = await readEncryptedSecret(VAULT_DOCUMENTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const safe = {};
      for (const [name, entry] of Object.entries(parsed)) {
        // The name is re-validated on read as well as on write: storage is
        // profile data, and a tampered record must not become a live token.
        if (!isDocumentToken(name) || !entry || typeof entry !== 'object') continue;
        try {
          const bytes = fromBase64(String(entry.data || ''));
          if (!bytes.length || bytes.length > MAX_VAULT_DOCUMENT_BYTES) continue;
          safe[name] = {
            bytes,
            fileName: normalizeDocumentFileName(entry.fileName) || 'document',
            mimeType: normalizeDocumentMime(entry.mimeType),
            byteLength: bytes.length
          };
        } catch {
          // One unreadable record is dropped, not fatal: the others are still
          // valid documents the user chose to keep.
          log.warn(`Skipped an unreadable stored document record for ${name}.`);
        }
      }
      this.documentStore = safe;
    } catch (e) {
      log.exception('Could not read the stored documents', e);
    }
  }

  /** Serialize the document set into the single encrypted envelope. */
  async _persistDocuments() {
    // No storage backend means there is nothing to persist to (tests, sandboxed
    // contexts). In-memory storage is not plaintext at rest, so this is not the
    // failure case the encryption guard protects against.
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return true;
    if (!isEncryptionSupported()) {
      this.storageError = 'This browser cannot encrypt the vault at rest, so documents will not be saved.';
      log.warn('Refusing to write unencrypted document bytes.');
      return false;
    }
    const names = Object.keys(this.documentStore);
    if (!names.length) {
      await deleteEncryptedSecret(VAULT_DOCUMENTS_STORAGE_KEY);
      return true;
    }
    const record = {};
    for (const name of names) {
      const doc = this.documentStore[name];
      record[name] = {
        data: toBase64(doc.bytes),
        fileName: doc.fileName,
        mimeType: doc.mimeType
      };
    }
    await writeEncryptedSecret(VAULT_DOCUMENTS_STORAGE_KEY, JSON.stringify(record));
    return true;
  }

  /**
   * Stores (or replaces) a named document.
   *
   * The bytes are encrypted before they are persisted, and the in-memory copy
   * is only updated once that write succeeded: a document the vault could not
   * protect must not appear to the agent as if it had been.
   *
   * @param {string} name - LOCAL_DOCUMENT_<NAME>
   * @param {{bytes?: Uint8Array|ArrayBuffer|number[], data?: string, fileName?: string, mimeType?: string}} document
   *   Raw bytes, or base64 `data` (runtime messages are JSON-serialized, so the
   *   side panel sends the file's bytes base64-encoded).
   * @returns {Promise<{name: string, fileName: string, mimeType: string, byteLength: number}>}
   */
  async updateDocument(name, document) {
    await this.ready;
    if (!isDocumentToken(name)) {
      throw new Error('Unsupported document name. Use LOCAL_DOCUMENT_ followed by uppercase letters, digits, or underscores (e.g. LOCAL_DOCUMENT_AADHAAR).');
    }
    const bytes = typeof document?.data === 'string'
      ? decodeBase64Document(document.data)
      : toDocumentBytes(document?.bytes);
    if (!bytes.length) throw new Error('That file is empty, so there is nothing to store.');
    if (bytes.length > MAX_VAULT_DOCUMENT_BYTES) {
      throw new Error(`That document is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; the limit is 8 MB.`);
    }
    const record = {
      bytes,
      fileName: normalizeDocumentFileName(document?.fileName) || 'document',
      mimeType: normalizeDocumentMime(document?.mimeType),
      byteLength: bytes.length
    };
    const previous = this.documentStore[name];
    this.documentStore[name] = record;
    try {
      const persisted = await this._persistDocuments();
      if (!persisted) throw new Error(this.storageError || 'The encrypted vault is unavailable; the document was not saved.');
    } catch (e) {
      if (previous) this.documentStore[name] = previous;
      else delete this.documentStore[name];
      this.storageError = `The document could not be saved: ${e?.message || 'unknown error'}`;
      throw e;
    }
    // Privacy: the name and byte count only. Never the file name, never bytes.
    log.info(`Stored document ${name} (${record.byteLength} bytes, encrypted at rest)`);
    return { name, fileName: record.fileName, mimeType: record.mimeType, byteLength: record.byteLength };
  }

  /**
   * Resolves a document token to its bytes. Execution-time only.
   * @param {string} name - LOCAL_DOCUMENT_<NAME>
   * @returns {{name: string, bytes: Uint8Array, fileName: string, mimeType: string, byteLength: number}|null}
   */
  resolveDocument(name) {
    this._assertReady();
    if (!isDocumentToken(name)) return null;
    const doc = this.documentStore[name];
    if (!doc) return null;
    // Privacy: token name only — never the bytes, never the file name.
    log.info(`Resolving stored document ${name}`);
    return {
      name,
      bytes: doc.bytes,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      byteLength: doc.byteLength
    };
  }

  /** Names, file names, types and sizes. Explicitly no document bytes. */
  getDocumentsSummary() {
    this._assertReady();
    return Object.entries(this.documentStore)
      .map(([name, doc]) => ({
        name,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        byteLength: doc.byteLength
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** True when a token names a document the user actually stored. */
  hasDocument(name) {
    this._assertReady();
    return isDocumentToken(name) && Boolean(this.documentStore[name]);
  }

  async deleteDocument(name) {
    await this.ready;
    if (!isDocumentToken(name)) throw new Error('Unsupported document name.');
    if (!this.documentStore[name]) return false;
    const previous = this.documentStore[name];
    delete this.documentStore[name];
    try {
      const persisted = await this._persistDocuments();
      if (!persisted) throw new Error(this.storageError || 'The encrypted vault is unavailable; the document was not deleted.');
    } catch (e) {
      this.documentStore[name] = previous;
      throw e;
    }
    log.info(`Deleted stored document ${name}`);
    return true;
  }

  async saveToStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    if (this.reviewRequired) {
      throw new Error('Review the saved vault values in the Local Vault before enabling them.');
    }
    if (!isEncryptionSupported()) {
      this.storageError = 'This browser cannot encrypt the vault at rest, so values will not be saved.';
      log.warn('Refusing to write an unencrypted vault.');
      throw new Error(this.storageError);
    }
    try {
      await writeEncryptedVault(this.memoryStore);
      this.storageError = null;
    } catch (e) {
      this.storageError = `The vault could not be saved: ${e?.message || 'unknown error'}`;
      log.exception('Could not save the encrypted vault', e);
      throw new Error(this.storageError, { cause: e });
    }
  }

  /**
   * Resolves a symbolic token to its local plaintext value
   * @param {string} symbolicSource - e.g. LOCAL_AADHAAR
   * @returns {string|Object|null}
   */
  resolveSecret(symbolicSource) {
    this._assertReady();
    if (!symbolicSource) return null;
    const value = this.memoryStore[symbolicSource] || null;
    // Privacy: never log plaintext values — token name + configured flag only.
    log.info(`Resolving ${symbolicSource} -> ${value === null || value === undefined || value === '' ? '(not configured)' : '(configured, kept local)'}`);
    return value;
  }

  /**
   * Updates an entry in the vault
   */
  async updateSecret(symbolicSource, value) {
    await this.ready;
    if (this.reviewRequired) {
      throw new Error('Review the saved vault values in the Local Vault before enabling them.');
    }
    if (!isVaultKey(symbolicSource)) throw new Error('Unsupported vault key.');
    if (typeof value !== 'string') throw new Error('Vault values must be text.');
    if (value.length > 4096) throw new Error('Vault value is too large.');
    const hadPrevious = Object.prototype.hasOwnProperty.call(this.memoryStore, symbolicSource);
    const previous = this.memoryStore[symbolicSource];
    this.memoryStore[symbolicSource] = value;
    try {
      await this.saveToStorage();
    } catch (e) {
      if (hadPrevious) this.memoryStore[symbolicSource] = previous;
      else delete this.memoryStore[symbolicSource];
      throw e;
    }
  }

  /**
   * Explicitly activates values shown in the trusted vault review UI.
   * The encrypted record is replaced atomically so a partial review cannot
   * accidentally enable the remaining old values.
   */
  async confirmReview(values) {
    await this.ready;
    if (!this.reviewRequired) throw new Error('There is no saved-vault review pending.');
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('The reviewed vault values are invalid.');
    }

    // Start with every quarantined value so a UI version that does not render
    // a newly introduced key cannot silently erase it. Submitted keys are
    // explicit user choices: a blank value deletes that key; a nonblank value
    // replaces it.
    const reviewed = { ...this.pendingReviewStore };
    for (const [key, value] of Object.entries(values)) {
      if (!isVaultKey(key)) throw new Error('Unsupported vault key.');
      if (typeof value !== 'string') throw new Error('Vault values must be text.');
      if (value.length > 4096) throw new Error('Vault value is too large.');
      if (value === '') delete reviewed[key];
      else reviewed[key] = value;
    }

    try {
      await writeEncryptedVault(reviewed, { reviewed: true });
    } catch (e) {
      this.storageError = `The vault could not be saved: ${e?.message || 'unknown error'}`;
      throw new Error(this.storageError, { cause: e });
    }
    this.memoryStore = reviewed;
    this.pendingReviewStore = {};
    this.reviewRequired = false;
    this.storageError = null;
    return true;
  }

  /**
   * Returns a sanitized summary of available vault keys (without plaintext values)
   * for display in UI or diagnostic status.
   *
   * Stored documents are listed by name here so the planner and the side panel
   * can see which LOCAL_DOCUMENT_<NAME> tokens are actually available. The
   * filename and MIME type are labels for this local UI summary; only token
   * names are included in planner requests, and document bytes stay out.
   */
  getAvailableKeysSummary() {
    this._assertReady();
    const secrets = Object.keys(this.memoryStore).map(key => ({
      key,
      kind: 'secret',
      isConfigured: Boolean(this.memoryStore[key]),
      preview: '••••••••'
    }));
    const documents = this.getDocumentsSummary().map(doc => ({
      key: doc.name,
      kind: 'document',
      isConfigured: true,
      preview: `${doc.fileName} · ${doc.mimeType}`,
      byteLength: doc.byteLength,
      mimeType: doc.mimeType
    }));
    return [...secrets, ...documents];
  }

  /**
   * L11: Returns only string-type secrets for outbound policy scanning.
   * Document blobs (objects) are excluded to prevent:
   * - False positive matches on base64 content
   * - Memory bloat from serializing large document content
   * - Accidental inclusion of document data in string-comparison scans
   *
   * Documents live in `documentStore`, not `memoryStore`, so no document byte
   * can reach this object even by accident. That matters: every string here is
   * matched verbatim against outbound payloads, and a base64 blob in this list
   * would both bloat every scan and match unrelated content.
   */
  getActiveSecretsForUI() {
    this._assertReady();
    const filtered = {};
    for (const [key, value] of Object.entries(this.memoryStore)) {
      if (typeof value === 'string') {
        filtered[key] = value;
      }
      // Objects (like LOCAL_DOCUMENT) are intentionally excluded
    }
    return filtered;
  }

  /** Values that only the trusted vault UI may display for explicit review. */
  getPendingReviewForUI() {
    this._assertReady();
    return this.reviewRequired ? { ...this.pendingReviewStore } : {};
  }

  /**
   * The outbound policy scanner checks both active and quarantined values.
   * Quarantined values are not available to planners or local resolution, but
   * must still be recognized if they appear in an outbound payload.
   */
  getAllSecretsForUI() {
    return { ...this.getActiveSecretsForUI(), ...this.getPendingReviewForUI() };
  }
}

/**
 * A stored file name is page-visible the moment it is attached, so it is
 * reduced to a bare basename: no directory components, no traversal, no control
 * characters. This is a label, not a path — nothing opens a file by name.
 */
function normalizeDocumentFileName(fileName) {
  const base = String(fileName ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return base.slice(0, 128);
}

function normalizeDocumentMime(mimeType) {
  const value = String(mimeType ?? '').split(';')[0].trim();
  return MIME_PATTERN.test(value) ? value.toLowerCase() : DEFAULT_DOCUMENT_MIME;
}

function toDocumentBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const byte = Number(input[i]);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) return new Uint8Array(0);
      out[i] = byte;
    }
    return out;
  }
  return new Uint8Array(0);
}

const VAULT_KEYS = new Set([
  SymbolicSecretSource.LOCAL_AADHAAR, SymbolicSecretSource.LOCAL_PAN,
  SymbolicSecretSource.LOCAL_FULL_NAME, SymbolicSecretSource.LOCAL_DOB,
  SymbolicSecretSource.LOCAL_PHONE, SymbolicSecretSource.LOCAL_EMAIL,
  SymbolicSecretSource.LOCAL_ADDRESS, SymbolicSecretSource.LOCAL_CITY,
  SymbolicSecretSource.LOCAL_STATE, SymbolicSecretSource.LOCAL_ZIP,
  SymbolicSecretSource.LOCAL_PASSWORD, SymbolicSecretSource.LOCAL_CREDIT_CARD,
  SymbolicSecretSource.LOCAL_CVV, SymbolicSecretSource.LOCAL_PROFILE,
  SymbolicSecretSource.LOCAL_COUNTRY, SymbolicSecretSource.LOCAL_GENDER,
  SymbolicSecretSource.LOCAL_TERMS,
  SymbolicSecretSource.LOCAL_SSN, SymbolicSecretSource.LOCAL_SIN,
  SymbolicSecretSource.LOCAL_NIN, SymbolicSecretSource.LOCAL_NHS,
  SymbolicSecretSource.LOCAL_IBAN
]);

function isVaultKey(key) {
  return VAULT_KEYS.has(key) || /^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(String(key || ''));
}

/** Strict base64 decode; anything malformed is an error, never empty bytes. */
function decodeBase64Document(text) {
  const value = String(text || '');
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('The document data could not be read. Re-select the file and try again.');
  }
  return fromBase64(value);
}

export const defaultLocalVault = new LocalVault();
