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
      return data.visual_observation || data;
    } catch (err) {
      console.warn(`[VLMClient] Remote VLM request failed (${err.message}). Using local visual inference.`);
      return this._localVisualInferenceFallback(sanitizedDom);
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

    return {
      detected_elements: visualElements,
      spatial_layout: `Structured layout containing ${formElements.length} form inputs and ${buttons.length} action buttons.`,
      visual_state: `Page loaded. ${elements.filter(e => e.sensitive).length} sensitive fields visually masked.`
    };
  }
}

export const defaultVLMClient = new VLMClient();
