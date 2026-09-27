/**
 * Local Secret Vault
 * User-configured values stored in chrome.storage.local. Chrome storage is
 * extension-scoped but NOT encrypted at rest by this module.
 *
 * L11: getAllSecretsForUI now filters out non-string entries (like document blobs)
 *      to prevent policy engine false positives and memory bloat.
 */

import { SymbolicSecretSource } from '../shared/constants.js';

export class LocalVault {
  constructor() {
    this.memoryStore = {};
    this.ready = this._loadFromStorage();
  }

  async _loadFromStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get('agent_local_vault');
        if (stored && stored.agent_local_vault) {
          const safe = {};
          for (const [key, value] of Object.entries(stored.agent_local_vault)) {
            if (isVaultKey(key) && typeof value === 'string') safe[key] = value;
          }
          // Remove old built-in demonstration values without shipping those
          // values in readable source. Hashes are used only for this one-time
          // exact migration comparison.
          for (const [key, digest] of Object.entries(LEGACY_DEMO_VALUE_HASHES)) {
            if (safe[key] && await sha256Hex(safe[key]) === digest) delete safe[key];
          }
          this.memoryStore = safe;
          if (Object.keys(safe).length !== Object.keys(stored.agent_local_vault).length) {
            await chrome.storage.local.set({ agent_local_vault: safe });
          }
        }
      } catch (e) {
        console.warn('Could not read from chrome.storage.local:', e);
      }
    }
  }

  async saveToStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.set({ agent_local_vault: this.memoryStore });
      } catch (e) {
        console.warn('Could not save to chrome.storage.local:', e);
      }
    }
  }

  /**
   * Resolves a symbolic token to its local plaintext value
   * @param {string} symbolicSource - e.g. LOCAL_AADHAAR
   * @returns {string|Object|null}
   */
  resolveSecret(symbolicSource) {
    if (!symbolicSource) return null;
    const value = this.memoryStore[symbolicSource] || null;
    // Privacy: never log plaintext values — token name + configured flag only.
    console.log(`[LocalVault] Resolving ${symbolicSource} -> ${value === null || value === undefined || value === '' ? '(not configured)' : '(configured, kept local)'}`);
    return value;
  }

  /**
   * Updates an entry in the vault
   */
  async updateSecret(symbolicSource, value) {
    await this.ready;
    if (!isVaultKey(symbolicSource)) throw new Error('Unsupported vault key.');
    if (typeof value !== 'string') throw new Error('Vault values must be text.');
    if (value.length > 4096) throw new Error('Vault value is too large.');
    this.memoryStore[symbolicSource] = value;
    await this.saveToStorage();
  }

  /**
   * Returns a sanitized summary of available vault keys (without plaintext values)
   * for display in UI or diagnostic status.
   */
  getAvailableKeysSummary() {
    return Object.keys(this.memoryStore).map(key => ({
      key,
      isConfigured: Boolean(this.memoryStore[key]),
      preview: key === SymbolicSecretSource.LOCAL_DOCUMENT 
        ? this.memoryStore[key]?.name 
        : '••••••••'
    }));
  }

  /**
   * L11: Returns only string-type secrets for outbound policy scanning.
   * Document blobs (objects) are excluded to prevent:
   * - False positive matches on base64 content
   * - Memory bloat from serializing large document content
   * - Accidental inclusion of document data in string-comparison scans
   */
  getAllSecretsForUI() {
    const filtered = {};
    for (const [key, value] of Object.entries(this.memoryStore)) {
      if (typeof value === 'string') {
        filtered[key] = value;
      }
      // Objects (like LOCAL_DOCUMENT) are intentionally excluded
    }
    return filtered;
  }
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

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const LEGACY_DEMO_VALUE_HASHES = Object.freeze({
  LOCAL_AADHAAR: '63194b3251ceb3f9b8cd5058b7a6280b290b8eb3fa9f2e9307c6d93e3e66ccf9',
  LOCAL_PAN: '6442fd73a940c1186d6268bd27f89233e12429902c7805037e8aab6e717be6d9',
  LOCAL_FULL_NAME: '7554067a189dc3af0793145b2e4218b748d51c204f6e87b5fd7b507e626285c3',
  LOCAL_DOB: 'a7f93df0154209611291f1524bcb0a488ec450445223d5c329c848fa03571f2f',
  LOCAL_PHONE: '7619ee8cea49187f309616e30ecf54be072259b43760f1f550a644945d5572f2',
  LOCAL_EMAIL: 'ed79ba7c86dbe2adb5b930124bac481465b8a77ab182f7819fd226d86fadefe7',
  LOCAL_ADDRESS: '2a3ddd130f62c4e31499412ae92ec9bb4a23da993c9bd713438801a8c74e8069',
  LOCAL_PASSWORD: '8687c59ab792afe5f9f8eb9a4ba434ed21ad91ff58dbb0f3c09a344b7d601aef',
  LOCAL_PROFILE: '7554067a189dc3af0793145b2e4218b748d51c204f6e87b5fd7b507e626285c3',
  LOCAL_COUNTRY: '79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621',
  LOCAL_GENDER: '0d248e82c62c9386878327d491c762a002152d42ab2c391a31c44d9f62675ddf',
  LOCAL_TERMS: '8a798890fe93817163b10b5f7bd2ca4d25d84c52739a645a889c173eee7d9d3d'
});

export const defaultLocalVault = new LocalVault();
