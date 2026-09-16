/**
 * Local Secret Vault
 * Secure, local-only storage for user credentials, personal identity numbers,
 * and test documents. Plaintext values are never transmitted across the network.
 */

import { SymbolicSecretSource } from '../shared/constants.js';

export class LocalVault {
  constructor() {
    this.memoryStore = {
      [SymbolicSecretSource.LOCAL_AADHAAR]: '4821 7392 0184',
      [SymbolicSecretSource.LOCAL_PAN]: 'ABCDE1234F',
      [SymbolicSecretSource.LOCAL_FULL_NAME]: 'Vishal Agrawal',
      [SymbolicSecretSource.LOCAL_DOB]: '15/08/2002',
      [SymbolicSecretSource.LOCAL_PHONE]: '9876543210',
      [SymbolicSecretSource.LOCAL_EMAIL]: 'vishal.agrawal@example.com',
      [SymbolicSecretSource.LOCAL_ADDRESS]: 'Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045',
      [SymbolicSecretSource.LOCAL_PASSWORD]: 'SecureDemoPass#2026',
      [SymbolicSecretSource.LOCAL_PROFILE]: 'Vishal Agrawal',
      [SymbolicSecretSource.LOCAL_DOCUMENT]: {
        name: 'Aadhaar_Card_Verified.pdf',
        type: 'application/pdf',
        size: 142850,
        content: 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXr...'
      }
    };
    this._loadFromStorage();
  }

  async _loadFromStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get('agent_local_vault');
        if (stored && stored.agent_local_vault) {
          this.memoryStore = { ...this.memoryStore, ...stored.agent_local_vault };
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
    return this.memoryStore[symbolicSource] || null;
  }

  /**
   * Updates an entry in the vault
   */
  async updateSecret(symbolicSource, value) {
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

  getAllSecretsForUI() {
    return { ...this.memoryStore };
  }
}

export const defaultLocalVault = new LocalVault();
