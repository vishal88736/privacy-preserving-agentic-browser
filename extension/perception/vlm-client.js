/**
 * Server VLM Perception Client
 * Sends privacy-sanitized screenshots and DOM to remote VLM server (/vision)
 * and returns visual hierarchy, spatial relationships, and layout analysis.
 */

import { ServerDefaults } from '../shared/constants.js';
import { validateVisionPayload } from '../shared/schemas.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';

export class VLMClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL) {
    this.baseUrl = baseUrl;
    this.policyEngine = defaultPolicyEngine;
  }

  /**
   * Calls the server VLM endpoint with sanitized data for visual grounding.
   */
  async processVisuals(taskId, sanitizedScreenshot, sanitizedDom, metadata = {}) {
    const payload = {
      task_id: taskId,
      sanitized_screenshot: sanitizedScreenshot,
      sanitized_dom: sanitizedDom,
      metadata: {
        timestamp: Date.now(),
        ...metadata
      }
    };

    // 1. Validate payload schema
    validateVisionPayload(payload);

    try {
      // 2. Strict policy engine scan (guarantee no raw secrets leave browser).
      // Vision is optional: on a local policy rejection, continue with the
      // sanitized DOM-only observation instead of aborting the browser task.
      // The block is flagged so callers/metrics can surface it.
      this.policyEngine.enforceOutboundSafety(payload);
    } catch (err) {
      if (err?.name === 'OutboundPolicyViolationError') {
        console.warn('[VLMClient] Outbound privacy block; using DOM-only observation.');
        const fallback = this._domOnlyObservation(sanitizedDom);
        fallback._source = 'DOM_ONLY';
        fallback._error = String(err?.message || err).slice(0, 200);
        fallback.privacyBlocked = true;
        return fallback;
      }
      throw err;
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      let response;
      try {
        response = await fetch(`${this.baseUrl}${ServerDefaults.VISION_ENDPOINT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ac.signal
        });
      } finally {
        // Always clear the abort timer, even when fetch throws: an uncleared
        // timer keeps the service worker awake briefly.
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`VLM server responded with status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const obs = data.visual_observation || data;
      // Provenance honesty: the server falls back to a DOM-echo heuristic
      // when no vision model responds. Never label that "remote-vlm" —
      // downstream fusion must know it is not visual proof.
      obs._source = obs?.provenance || (obs?.grounding_source === 'vision_model' ? 'DOM_PLUS_REAL_VLM' : 'DOM_PLUS_HEURISTIC');
      return obs;
    } catch (err) {
      console.warn(`[VLMClient] Remote VLM request failed (${err.message}). Using local visual inference.`);
      const fallback = this._domOnlyObservation(sanitizedDom);
      fallback._source = 'DOM_ONLY';
      fallback._error = String(err?.message || err).slice(0, 200);
      return fallback;
    }
  }

  /**
   * Public DOM-only fallback for callers that skip the screenshot path
   * entirely (capture failed / local analysis unavailable). No image is
   * involved, so nothing sensitive can leak.
   */
  domOnlyObservation(sanitizedDom, errorNote = null) {
    const fallback = this._domOnlyObservation(sanitizedDom);
    fallback._source = 'DOM_ONLY';
    if (errorNote) fallback._error = String(errorNote).slice(0, 200);
    return fallback;
  }

  /**
   * Deterministic local fallback when remote VLM endpoint is not reachable
   * Generates visual annotations directly from sanitized DOM coordinates.
   */
  _domOnlyObservation(sanitizedDom) {
    const elements = sanitizedDom?.elements || [];
    const formElements = elements.filter(e => e.tag === 'input' || e.tag === 'select');
    const buttons = elements.filter(e => e.tag === 'button' || e.type === 'submit');
    const cards = sanitizedDom?.result_items?.length || 0;

    // Mirror the backend's page_type inference so fusion's page.page_type
    // stays meaningful offline (search_results/login/form/dashboard/...).
    const titleLower = String(sanitizedDom?.title || '').toLowerCase();
    let page_type = 'unknown';
    if (cards >= 2) page_type = 'search_results';
    else if (/login|sign in/.test(titleLower)) page_type = 'login';
    else if (/register|sign up|create account/.test(titleLower)) page_type = 'registration';
    else if (/checkout|cart|payment/.test(titleLower)) page_type = 'checkout';
    else if (formElements.length > 3) page_type = 'application_form';
    else if (formElements.length === 0 && buttons.length > 0) page_type = 'dashboard';

    return {
      detected_elements: [],
      provenance: 'DOM_ONLY',
      page_type,
      page_purpose: `DOM classification only: likely a ${page_type.replace(/_/g, ' ')} page.`,
      spatial_layout: null,
      visual_state: null
    };
  }
}

export const defaultVLMClient = new VLMClient();
