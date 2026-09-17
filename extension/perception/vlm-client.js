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
   * Calls the server VLM endpoint with sanitized data
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

    // 2. Strict policy engine scan (guarantee no raw secrets leave browser)
    this.policyEngine.enforceOutboundSafety(payload);

    try {
      const response = await fetch(`${this.baseUrl}${ServerDefaults.VISION_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`VLM server responded with status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const obs = data.visual_observation || data;
      // Mark provenance so fusion/logs never mistake remote vs local.
      obs._source = 'remote-vlm';
      return obs;
    } catch (err) {
      console.warn(`[VLMClient] Remote VLM request failed (${err.message}). Using local visual inference.`);
      const fallback = this._localVisualInferenceFallback(sanitizedDom);
      fallback._source = 'local-fallback';
      fallback._error = String(err?.message || err).slice(0, 200);
      return fallback;
    }
  }

  /**
   * Deterministic local fallback when remote VLM endpoint is not reachable
   * Generates visual annotations directly from sanitized DOM coordinates.
   */
  _localVisualInferenceFallback(sanitizedDom) {
    const elements = sanitizedDom?.elements || [];
    const visualElements = elements.map((el, idx) => ({
      visual_id: `vis_${idx + 1}`,
      role: el.tag === 'input' ? 'input_field' : (el.tag === 'button' ? 'button' : el.tag),
      label: el.label || el.placeholder || el.name || `Element ${idx + 1}`,
      bbox: el.bbox || [0, 0, 100, 30],
      confidence: 0.95,
      visual_description: el.sensitive 
        ? `Redacted sensitive ${el.semantic_type || 'field'}` 
        : `Interactive ${el.tag} with label "${el.label || el.placeholder || ''}"`
    }));

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
      detected_elements: visualElements,
      page_type,
      page_purpose: `Likely a ${page_type.replace(/_/g, ' ')} page (local layout fallback).`,
      spatial_layout: `Structured layout containing ${formElements.length} form inputs and ${buttons.length} action buttons.`,
      visual_state: `Page loaded. ${elements.filter(e => e.sensitive).length} sensitive fields visually masked.`
    };
  }
}

export const defaultVLMClient = new VLMClient();
