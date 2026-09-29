/**
 * Observation Fusion Module
 * Combines DOM perception + VLM visual perception into a single unified
 * observation representation with spatial IoU and semantic cross-referencing.
 */

import { classifyElement } from './semantic-capability.js';
import { hasRealVlmDetections, normalizePerceptionProvenance, PerceptionProvenance } from './provenance.js';

export function calculateIoU(boxA, boxB) {
  if (!boxA || !boxB || boxA.length !== 4 || boxB.length !== 4) return 0;
  const [xA, yA, wA, hA] = boxA;
  const [xB, yB, wB, hB] = boxB;

  const x1 = Math.max(xA, xB);
  const y1 = Math.max(yA, yB);
  const x2 = Math.min(xA + wA, xB + wB);
  const y2 = Math.min(yA + hA, yB + hB);

  const intersectionW = Math.max(0, x2 - x1);
  const intersectionH = Math.max(0, y2 - y1);
  const intersectionArea = intersectionW * intersectionH;

  const areaA = wA * hA;
  const areaB = wB * hB;
  const unionArea = areaA + areaB - intersectionArea;

  if (unionArea <= 0) return 0;
  return intersectionArea / unionArea;
}

export class ObservationFusion {
  /**
   * Fuses sanitized DOM elements with VLM visual detections
   * @param {Array<Object>} sanitizedDomElements
   * @param {Object} vlmVisualObservation - { detected_elements, spatial_layout, visual_state }
   * @param {Object} pageMetadata - { url, title, viewport }
   * @returns {Object} Unified Observation Model
   */
  fuse(sanitizedDomElements, vlmVisualObservation, pageMetadata = {}) {
    const provenance = normalizePerceptionProvenance(vlmVisualObservation || {});
    // The backend's current detected_elements list is a DOM echo used by its
    // heuristic. It has no screenshot-derived boxes. Never promote it to a
    // visual detection unless the response carries an explicit REAL_VLM
    // detection provenance of its own.
    const visualElements = hasRealVlmDetections(vlmVisualObservation || {})
      ? vlmVisualObservation.detected_elements
      : [];
    const matchedVisualIndices = new Set();
    const unifiedElements = [];

    const buildElement = (domEl, visual, matchedBy, matchConfidence, matched) => {
      const semantics = classifyElement(domEl);
      const visible = domEl.is_visible !== false;
      const selectedOption = domEl.selected_option ||
        (Array.isArray(domEl.options) ? domEl.options.find((option) => option?.selected) : null);
      return {
      id: domEl.id,
      el_id: domEl.id,
      tag: domEl.tag,
      role: domEl.role || domEl.tag,
      accessible_name: domEl.accessible_name || domEl.label || semantics.accessible_name || '',
      label: domEl.label || '',
      text: domEl.text || '',
      nearby_text: domEl.context || '',
      placeholder: domEl.placeholder || '',
      title: domEl.title || '',
      input_type: domEl.type || '',
      href: domEl.href || '',
      bounding_box: domEl.bbox || null,
      visible,
      enabled: visible && !Boolean(domEl.disabled),
      disabled: Boolean(domEl.disabled),
      checked: Boolean(domEl.checked),
      selected: Boolean(domEl.selected || selectedOption),
      selected_option: selectedOption ? {
        index: selectedOption.index,
        text: selectedOption.text || '',
        value: selectedOption.value || ''
      } : null,
      parent_element_id: domEl.parent_element_id || null,
      child_element_ids: Array.isArray(domEl.child_element_ids) ? domEl.child_element_ids : [],
      form_group_id: domEl.form_id || null,
      semantic_action_type: semantics.semantic_type,
      provenance: matched ? PerceptionProvenance.REAL_VLM : PerceptionProvenance.DOM,
      confidence: matched ? bestConfidence(visual) : null,
      actionable: true,
      // Normalized semantic representation derived from general browser
      // semantics (accessibility, role/type, control relationships, text,
      // state). The reasoner must not rediscover these from raw markup.
      semantics,
      dom: {
        id: domEl.id,
        tag: domEl.tag,
        type: domEl.type,
        name: domEl.name,
        label: domEl.label,
        accessible_name: domEl.accessible_name || domEl.label || '',
        text: domEl.text || '',
        title: domEl.title || '',
        placeholder: domEl.placeholder,
        autocomplete: domEl.autocomplete || '',
        ariaLabel: domEl.ariaLabel || '',
        ariaDescribedBy: domEl.ariaDescribedBy || '',
        fieldset_legend: domEl.fieldset_legend || '',
        value: domEl.value,
        href: domEl.href || '',
        sensitive: domEl.sensitive,
        semantic_type: domEl.semantic_type,
        value_source: domEl.value_source,
        checked: Boolean(domEl.checked),
        selected: Boolean(domEl.selected || selectedOption),
        selected_option: selectedOption ? {
          index: selectedOption.index,
          text: selectedOption.text || '',
          value: selectedOption.value || ''
        } : null,
        bbox: domEl.bbox,
        is_interactive: domEl.is_interactive,
        is_visible: visible,
        disabled: Boolean(domEl.disabled),
        in_form: Boolean(domEl.in_form),
        form_id: domEl.form_id || null,
        context: domEl.context || '',
        parent_element_id: domEl.parent_element_id || null,
        child_element_ids: Array.isArray(domEl.child_element_ids) ? domEl.child_element_ids : [],
        price_value: domEl.price_value ?? null,
        options: domEl.options
      },
      visual: visual || null,
      interaction: {
        clickable: ['button', 'a'].includes(domEl.tag) || (matched && domEl.tag === 'select') || ['button', 'link'].includes(domEl.role) || Boolean(domEl.is_interactive && ((domEl.tag === 'input' && (domEl.type === 'checkbox' || domEl.type === 'radio' || domEl.type === 'submit' || domEl.type === 'button')) || (domEl.tag !== 'input' && domEl.tag !== 'textarea' && (matched || domEl.tag !== 'select')))),
        typeable: (domEl.tag === 'input' && domEl.type !== 'checkbox' && domEl.type !== 'radio' && domEl.type !== 'button' && domEl.type !== 'submit') || domEl.tag === 'textarea',
        uploadable: domEl.type === 'file'
      },
      matched_by: matchedBy,
      match_confidence: matchConfidence ?? null,
      };
    };

    const bestConfidence = (visual) => {
      const confidence = Number(visual?.confidence);
      return Number.isFinite(confidence) ? confidence : null;
    };

    // 1. Match DOM elements with Visual detections
    for (const domEl of sanitizedDomElements) {
      let bestMatch = null;
      let highestIoU = 0;
      let matchedIndex = -1;

      for (let i = 0; i < visualElements.length; i++) {
        if (matchedVisualIndices.has(i)) continue;
        const visEl = visualElements[i];

        // Spatial IoU check
        const iou = calculateIoU(domEl.bbox, visEl.bbox);
        if (iou > highestIoU && iou >= 0.35) {
          highestIoU = iou;
          bestMatch = visEl;
          matchedIndex = i;
        }
      }

      if (bestMatch && matchedIndex >= 0) {
        matchedVisualIndices.add(matchedIndex);
        unifiedElements.push(buildElement(domEl, {
          visual_id: bestMatch.visual_id,
          description: bestMatch.visual_description || bestMatch.label,
          confidence: bestMatch.confidence,
          visual_bbox: bestMatch.bbox
        }, 'IOU', highestIoU, true));
      } else {
        // DOM elements remain grounded to the page, but we do not fabricate a
        // visual description or confidence when no real visual detection exists.
        unifiedElements.push(buildElement(domEl, null, 'DOM_ONLY', undefined, false));
      }
    }

    // 2. Add remaining unmatched visual elements (e.g. canvas elements, image buttons)
    for (let i = 0; i < visualElements.length; i++) {
      if (!matchedVisualIndices.has(i)) {
        const visEl = visualElements[i];
        unifiedElements.push({
          id: `vis_target_${i + 1}`,
          role: visEl.role || 'visual_control',
          dom: null,
          visual: {
            visual_id: visEl.visual_id,
            description: visEl.visual_description || visEl.label,
            confidence: visEl.confidence,
            visual_bbox: visEl.bbox
          },
          semantics: classifyElement({ role: visEl.role, visual: { description: visEl.visual_description || visEl.label } }),
          interaction: {
            clickable: false,
            typeable: false,
            uploadable: false
          },
          matched_by: 'VISUAL_ONLY',
          provenance: PerceptionProvenance.REAL_VLM,
          confidence: bestConfidence(visEl),
          actionable: false
        });
      }
    }

    // Collect list of sensitive categories present on page
    const sensitiveCategories = Array.from(new Set(
      unifiedElements
        .filter(el => el.dom?.sensitive)
        .map(el => el.dom.semantic_type)
    ));

    // Generate Form State
    const inputs = unifiedElements.filter(el => el.interaction.typeable || el.interaction.uploadable || el.dom?.tag === 'select');
    const isMeaningfulValue = (v) => {
      if (v == null) return false;
      const s = String(v).trim();
      if (!s) return false;
      // Sanitizer placeholders mean "needs filling", not "filled".
      if (s === '[REDACTED]' || s === '[NON_SENSITIVE_TEXT]' || s === '[example]') return false;
      return true;
    };
    const formFields = inputs.map(el => ({
      id: el.id,
      role: el.role,
      semantic_type: el.dom?.semantic_type || 'UNKNOWN',
      state: isMeaningfulValue(el.dom?.value) ? 'FILLED' : 'EMPTY',
      sensitive: Boolean(el.dom?.sensitive)
    }));

    const filledCount = formFields.filter(f => f.state === 'FILLED').length;
    const emptyCount = formFields.filter(f => f.state === 'EMPTY').length;

    const formState = {
      detected: inputs.length > 0,
      purpose: vlmVisualObservation?.page_purpose || 'Unknown Form',
      fields: formFields,
      completion: {
        filled: filledCount,
        empty: emptyCount,
        total: inputs.length
      }
    };

    return {
      observation_id: pageMetadata.snapshot_id || pageMetadata.observation_id || `obs_${Date.now()}`,
      mutation_revision: Number.isInteger(pageMetadata.mutation_revision) ? pageMetadata.mutation_revision : null,
      timestamp: Date.now(),
      provenance,
      local_perception: pageMetadata.local_vision_context ? {
        provenance: PerceptionProvenance.LOCAL_MODEL,
        model: pageMetadata.local_vision_context.model || null,
        model_revision: pageMetadata.local_vision_context.model_revision || null
      } : null,
      page: {
        domain: pageMetadata.domain || 'localhost',
        title: pageMetadata.title || 'Application',
        url: pageMetadata.url || pageMetadata.domain || '',
        viewport: pageMetadata.viewport || [1280, 800],
        scroll: pageMetadata.scroll || null,
        page_type: vlmVisualObservation?.page_type || 'unknown',
        page_purpose: vlmVisualObservation?.page_purpose || 'Unknown',
      },
      form_state: formState,
      headings: pageMetadata.headings || [],
      result_items: pageMetadata.result_items || [],
      visible_text: pageMetadata.visible_text || '',
      elements: unifiedElements,
      visual_layout_summary: vlmVisualObservation?.spatial_layout || 'No visual layout analysis available.',
      visual_state_summary: vlmVisualObservation?.visual_state || 'Unknown; no visual state was inferred.',
      local_vision_context: pageMetadata.local_vision_context || null,
      detected_sensitive_categories: sensitiveCategories
    };
  }
}

export const defaultObservationFusion = new ObservationFusion();
