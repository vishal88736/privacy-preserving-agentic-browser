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
    this._loadFromStorage();
  }

  async _loadFromStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get('agent_local_vault');
        if (stored && stored.agent_local_vault) {
          const safe = {};
          for (const [key, value] of Object.entries(stored.agent_local_vault)) {
            if (VAULT_KEYS.has(key) && typeof value === 'string') safe[key] = value;
          }
          // Remove legacy built-in demonstration credentials on upgrade.
          for (const [key, value] of Object.entries(LEGACY_DEMO_VALUES)) {
            if (safe[key] === value) delete safe[key];
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
    if (!VAULT_KEYS.has(symbolicSource)) throw new Error('Unsupported vault key.');
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
  SymbolicSecretSource.LOCAL_TERMS
]);

const LEGACY_DEMO_VALUES = {
  LOCAL_AADHAAR: '4821 7392 0184', LOCAL_PAN: 'ABCDE1234F',
  LOCAL_FULL_NAME: 'Vishal Agrawal', LOCAL_DOB: '15/08/2002',
  LOCAL_PHONE: '9876543210', LOCAL_EMAIL: 'vishal.agrawal@example.com',
  LOCAL_ADDRESS: 'Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045',
  LOCAL_PASSWORD: 'SecureDemoPass#2026', LOCAL_PROFILE: 'Vishal Agrawal',
  LOCAL_COUNTRY: 'us', LOCAL_GENDER: 'male', LOCAL_TERMS: 'yes'
};

export const defaultLocalVault = new LocalVault();
