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
   * For bulk FILL_FORM_PLAN: sensitive tokens throw when missing so the
   * failure is loud; generic profile fallbacks resolve to '' instead.
   * @param {Object} action
   * @returns {string|Object|null}
   */
  resolve(action) {
    if (action.action === 'FILL_FORM_PLAN' && action.value && action.value.fields) {
      // Deeply resolve form fields
      const STRICT_SOURCES = new Set([
        'LOCAL_AADHAAR', 'LOCAL_PAN', 'LOCAL_PASSWORD', 'LOCAL_DOCUMENT',
        'LOCAL_CREDIT_CARD', 'LOCAL_CVV'
      ]);
      action.value.fields.forEach(field => {
        if (field.value_source) {
          try {
            const resolved = this.vault.resolveSecret(field.value_source);
            if (resolved === null || resolved === undefined || resolved === '') {
              if (STRICT_SOURCES.has(field.value_source)) {
                throw new Error(`Local credential "${field.value_source}" for field "${field.field_id}" is not configured in your Local Vault.`);
              }
              field.value = '';
            } else {
              if (field.semantic_type === 'first_name' && typeof resolved === 'string') {
                field.value = resolved.split(' ')[0] || resolved;
              } else if (field.semantic_type === 'last_name' && typeof resolved === 'string') {
                field.value = resolved.split(' ').slice(1).join(' ') || resolved;
              } else {
                field.value = resolved;
              }
              console.log(`[LocalValueResolver] Resolved ${field.value_source} for ${field.field_id}: ${resolved}`);
            }
          } catch (e) {
            console.warn(`[LocalValueResolver] Failed to resolve ${field.value_source}: ${e.message}`);
            if (STRICT_SOURCES.has(field.value_source)) {
              throw e;
            }
            field.value = '';
          }
        }
      });
      return action.value;
    }

    if (action.value_source) {
      const resolved = this.vault.resolveSecret(action.value_source);
      if (resolved === null || resolved === undefined) {
        throw new Error(`Local credential "${action.value_source}" is not configured in your Local Vault.`);
      }
      console.log(`[LocalValueResolver] Resolved action value_source ${action.value_source}`);
      return resolved;
    }
    return action.value || '';
  }
}

export const defaultLocalValueResolver = new LocalValueResolver();
