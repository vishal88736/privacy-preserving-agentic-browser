/**
 * Local Value Resolver
 * Maps symbolic tokens (e.g. LOCAL_AADHAAR) to their actual values
 * from the LocalVault immediately prior to in-browser execution.
 */

import { defaultLocalVault } from '../privacy/local-vault.js';

export class LocalValueResolver {
  constructor(vault = defaultLocalVault) {
    this.vault = vault;
  }

  /**
   * Resolves the target value for an action.
   * If value_source is provided, queries the local vault.
   * If regular value is provided, returns it as-is.
   * @param {Object} action
   * @returns {string|Object|null}
   */
  resolve(action) {
    if (action.value_source) {
      const resolved = this.vault.resolveSecret(action.value_source);
      if (resolved === null || resolved === undefined) {
        throw new Error(`Local credential "${action.value_source}" is not configured in your Local Vault.`);
      }
      return resolved;
    }
    return action.value || '';
  }
}

export const defaultLocalValueResolver = new LocalValueResolver();
