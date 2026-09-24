/**
 * Local Value Resolver
 * Maps symbolic tokens (e.g. LOCAL_AADHAAR) to their actual values
 * from the LocalVault immediately prior to in-browser execution.
 */

import { defaultLocalVault } from '../privacy/local-vault.js';

// Canonical state/province names used to split a free-form address record
// into city/state/zip parts. Matched case-insensitively; the matched
// substring is returned as-is.
const KNOWN_REGIONS = [
  // Indian states & UTs
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Puducherry', 'Chandigarh',
  // Common US states + UK nations (profile portability)
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois',
  'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana',
  'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
  'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'Wisconsin', 'Wyoming', 'England',
  'Scotland', 'Wales'
];

export class LocalValueResolver {
  constructor(vault = defaultLocalVault) {
    this.vault = vault;
  }

  /**
   * Derives city/state/zip parts from a free-form address record such as
   * "Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045".
   * Returns whichever parts could be extracted ({city?, state?, zip?}).
   * Never throws: unparseable input yields {} and the caller marks the
   * field ambiguous so the planner asks the user.
   */
  parseAddressParts(address) {
    const parts = {};
    if (!address || typeof address !== 'string') return parts;
    try {
      const zipMatch = address.match(/\b(\d{6})\b/) || address.match(/\b(\d{5}(?:-\d{4})?)\b/);
      if (zipMatch) parts.zip = zipMatch[1];
      const rest = address.replace(zipMatch ? zipMatch[0] : '', ' ');
      for (const region of KNOWN_REGIONS) {
        const m = rest.match(new RegExp(`\\b${region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
        if (m) { parts.state = m[0].trim(); break; }
      }
      const segs = rest.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.state) {
        const idx = segs.findIndex((s) => s.toLowerCase().includes(parts.state.toLowerCase()));
        if (idx > 0) {
          parts.city = segs[idx - 1].replace(/\s*-\s*$/, '').trim() || undefined;
        } else if (segs.length >= 2 && idx === -1) {
          // Known-region match failed to align on comma segments (e.g.
          // "Pune Maharashtra"): fall back to the token before the state.
          const tokens = rest.split(/\s+/).filter(Boolean);
          const sIdx = tokens.findIndex((t) => parts.state.toLowerCase().includes(t.toLowerCase().replace(/[-,]$/, '')));
          if (sIdx > 0) parts.city = tokens[sIdx - 1].replace(/,$/, '');
        }
        if (!parts.city && segs.length >= 2) {
          parts.city = segs[segs.length - 2].replace(/\s*-\s*$/, '').trim() || undefined;
        }
      } else if (segs.length >= 2) {
        parts.city = segs[segs.length - 2].trim() || undefined;
      }
      if (!parts.city) delete parts.city;
      if (!parts.state) delete parts.state;
      if (!parts.zip) delete parts.zip;
    } catch { /* unparseable -> {} */ }
    return parts;
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
      // Work on a local clone so plaintext values never get written into the
      // action history, task status, or side-panel messages by mutation.
      const plan = {
        ...action.value,
        fields: action.value.fields.map((field) => ({ ...field }))
      };
      plan.fields.forEach((field) => {
        if (!field.value_source) {
          field.status = field.value !== undefined && field.value !== '' ? 'AVAILABLE' : 'UNAVAILABLE';
          return;
        }

        try {
          const resolved = this.vault.resolveSecret(field.value_source);
          if (resolved === null || resolved === undefined || resolved === '') {
            const directToken = { city: 'LOCAL_CITY', state: 'LOCAL_STATE', zip: 'LOCAL_ZIP' }[field.address_part];
            const directVal = directToken ? this.vault.resolveSecret(directToken) : null;
            if (field.address_part && directVal) {
              field.value = directVal;
              field.status = 'AVAILABLE';
            } else {
              field.status = 'UNAVAILABLE';
              field.unavailable_reason = 'The mapped local profile value is not configured.';
            }
            return;
          }

          let value = resolved;
          if (field.address_part && typeof resolved === 'string') {
            const directToken = {
              city: 'LOCAL_CITY',
              state: 'LOCAL_STATE',
              zip: 'LOCAL_ZIP'
            }[field.address_part];
            value = this.vault.resolveSecret(directToken) || this.parseAddressParts(resolved)[field.address_part];
            if (!value) {
              field.status = 'AMBIGUOUS';
              field.unavailable_reason = `Could not derive the ${field.address_part} from the saved address.`;
              return;
            }
          }

          if (field.semantic_type === 'first_name' && typeof value === 'string') {
            value = value.split(' ')[0] || value;
          } else if (field.semantic_type === 'last_name' && typeof value === 'string') {
            value = value.split(' ').slice(1).join(' ') || value;
          }
          field.value = value;
          field.status = 'AVAILABLE';
        } catch {
          // Missing local values are reported to the planner as unavailable;
          // they are never silently sent to the page as empty strings.
          field.status = 'UNAVAILABLE';
          field.unavailable_reason = 'The mapped local profile value is unavailable.';
        }
      });
      return plan;
    }

    if (action.value_source) {
      const resolved = this.vault.resolveSecret(action.value_source);
      if (resolved === null || resolved === undefined) {
        throw new Error(`Local credential "${action.value_source}" is not configured in your Local Vault.`);
      }
      if (action.value_source === 'LOCAL_DOCUMENT') {
        throw new Error('Real document upload is not supported. Choose the file directly on the webpage.');
      }
      // Privacy: token name only — never the plaintext value.
      console.log(`[LocalValueResolver] Resolved action value_source ${action.value_source} (kept local)`);
      return resolved;
    }
    return action.value || '';
  }
}

export const defaultLocalValueResolver = new LocalValueResolver();
