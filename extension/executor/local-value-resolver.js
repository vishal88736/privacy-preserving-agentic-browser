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
  'Scotland', 'Wales',
  // Canada and Australia
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
  'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Saskatchewan', 'Yukon', 'Australian Capital Territory', 'New South Wales',
  'Northern Territory', 'Queensland', 'South Australia', 'Tasmania', 'Victoria', 'Western Australia'
];

const COMMON_COUNTRIES = [
  'United States', 'United States of America', 'USA', 'US', 'Canada', 'CA', 'United Kingdom', 'UK', 'Australia', 'AU',
  'India', 'Ireland', 'New Zealand', 'Germany', 'France', 'Spain', 'Portugal', 'Italy',
  'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Japan', 'Singapore', 'Mexico',
  'Brazil', 'South Africa', 'United Arab Emirates'
];

const REGION_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AB', 'BC', 'MB', 'NB', 'NL', 'NT', 'NS', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
  'ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'
]);

export class LocalValueResolver {
  constructor(vault = defaultLocalVault, { regions = KNOWN_REGIONS, countries = COMMON_COUNTRIES } = {}) {
    this.vault = vault;
    this.regions = [...regions].sort((a, b) => b.length - a.length);
    this.countries = [...countries].sort((a, b) => b.length - a.length);
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
      const postalPatterns = [
        /\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i, // Canada
        /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, // United Kingdom
        /\b\d{5}(?:-\d{4})?\b/, // United States
        /\b\d{6}\b/, // India and other six-digit postal systems
        /(?:^|[,\s])(\d{4,6})(?=$|[,\s])/g // Common numeric postal codes
      ];
      let postal = null;
      for (const pattern of postalPatterns) {
        const candidates = [...address.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))];
        if (candidates.length) {
          const candidate = candidates[candidates.length - 1];
          postal = candidate[1] || candidate[0].trim();
          break;
        }
      }
      if (postal) parts.zip = postal.trim();
      let rest = postal ? address.replace(postal, ' ') : address;
      for (const country of this.countries) {
        const escapedCountry = country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rest = rest.replace(new RegExp(`(?:,\\s*)?${escapedCountry}\\s*$`, 'i'), '').trim();
      }
      const segs = rest.split(',').map((s) => s.trim()).filter(Boolean);
      let stateSegmentIndex = -1;
      for (const region of this.regions) {
        const escaped = region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regionIndex = segs.findIndex((segment) => new RegExp(`\\b${escaped}\\b[\\s-]*$`, 'i').test(segment));
        if (regionIndex >= 0) {
          const m = segs[regionIndex].match(new RegExp(`\\b${escaped}\\b`, 'i'));
          parts.state = m?.[0]?.trim() || region;
          stateSegmentIndex = regionIndex;
          break;
        }
      }
      if (!parts.state && segs.length >= 2) {
        const lastToken = segs[segs.length - 1].match(/\b([A-Z]{2,3})\b\s*$/)?.[1];
        if (lastToken && REGION_CODES.has(lastToken)) {
          parts.state = lastToken;
          stateSegmentIndex = segs.length - 1;
        }
      }
      if (parts.state) {
        if (stateSegmentIndex > 0) {
          parts.city = segs[stateSegmentIndex - 1].replace(/\s*-\s*$/, '').trim() || undefined;
        } else if (stateSegmentIndex === 0) {
          // Some addresses omit a comma between city and region ("Pune Maharashtra").
          const tokens = segs[0].replace(/[,-]+$/, '').split(/\s+/).filter(Boolean);
          const regionTokens = parts.state.split(/\s+/);
          const regionStart = tokens.findIndex((_, index) =>
            tokens.slice(index, index + regionTokens.length).join(' ').toLowerCase() === parts.state.toLowerCase()
          );
          if (regionStart > 0) parts.city = tokens.slice(0, regionStart).join(' ');
        }
        if (!parts.city && segs.length >= 2) {
          parts.city = segs[segs.length - 2].replace(/\s*-\s*$/, '').trim() || undefined;
        }
      } else if (segs.length >= 2) {
        // With no known administrative region, use the last location segment
        // before the postal code/country, not a fixed comma offset.
        parts.city = segs[segs.length - 1].trim() || undefined;
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
