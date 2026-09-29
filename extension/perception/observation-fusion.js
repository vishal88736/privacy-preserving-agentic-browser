/**
 * Observation Fusion Module
 * Builds the canonical semantic page representation from sanitized DOM and
 * carries separately sourced VLM summaries as observation-level evidence.
 */

import { classifyElement } from './semantic-capability.js';
import { normalizePerceptionProvenance, PerceptionProvenance } from './provenance.js';

export class ObservationFusion {
  /**
   * Fuses sanitized DOM semantics with separately sourced VLM summaries.
   * Current VLM providers return prose summaries, not screenshot-derived
   * control boxes, so controls remain DOM-grounded and receive no visual
   * confidence score.
   * @param {Array<Object>} sanitizedDomElements
   * @param {Object} vlmVisualObservation - prose summary fields from the VLM
   * @param {Object} pageMetadata - { url, title, viewport }
   * @returns {Object} Unified Observation Model
   */
  fuse(sanitizedDomElements, vlmVisualObservation, pageMetadata = {}) {
    const provenance = normalizePerceptionProvenance(vlmVisualObservation || {});
    const unifiedElements = sanitizedDomElements.map((domEl) => {
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
      provenance: PerceptionProvenance.DOM,
      confidence: null,
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
        required: Boolean(domEl.required),
        context: domEl.context || '',
        parent_element_id: domEl.parent_element_id || null,
        child_element_ids: Array.isArray(domEl.child_element_ids) ? domEl.child_element_ids : [],
        price_value: domEl.price_value ?? null,
        options: domEl.options
      },
      visual: null,
      interaction: {
        clickable: ['button', 'a'].includes(domEl.tag) || ['button', 'link'].includes(domEl.role) || Boolean(
          domEl.is_interactive && (
            (domEl.tag === 'input' && ['checkbox', 'radio', 'submit', 'button'].includes(domEl.type)) ||
            (domEl.tag !== 'input' && domEl.tag !== 'textarea' && domEl.tag !== 'select')
          )
        ),
        typeable: (domEl.tag === 'input' && domEl.type !== 'checkbox' && domEl.type !== 'radio' && domEl.type !== 'button' && domEl.type !== 'submit') || domEl.tag === 'textarea',
        uploadable: domEl.type === 'file'
      },
      matched_by: 'DOM_ONLY',
      match_confidence: null,
      };
    });

    // Collect list of sensitive categories present on page
    const sensitiveCategories = Array.from(new Set(
      unifiedElements
        .filter(el => el.dom?.sensitive)
        .map(el => el.dom.semantic_type)
    ));

    // Generate Form State
    const inputs = unifiedElements.filter(el =>
      el.interaction.typeable || el.interaction.uploadable || el.dom?.tag === 'select' ||
      ['checkbox', 'radio'].includes(String(el.dom?.type || '').toLowerCase())
    );
    const isMeaningfulValue = (v) => {
      if (v == null) return false;
      const s = String(v).trim();
      if (!s) return false;
      // Sanitizer placeholders mean "needs filling", not "filled".
      if (s === '[REDACTED]' || s === '[NON_SENSITIVE_TEXT]' || s === '[example]') return false;
      return true;
    };
    const isFieldFilled = (el) => {
      const type = String(el.dom?.type || '').toLowerCase();
      if (type === 'checkbox') return Boolean(el.dom?.checked);
      if (type === 'radio') {
        const group = el.dom?.form_id || '';
        const name = el.dom?.name || '';
        if (!name) return Boolean(el.dom?.checked);
        return inputs.some((candidate) =>
          String(candidate.dom?.type || '').toLowerCase() === 'radio' &&
          (candidate.dom?.form_id || '') === group &&
          (candidate.dom?.name || '') === name && Boolean(candidate.dom?.checked)
        );
      }
      if (el.dom?.tag === 'select') return Boolean(el.dom?.selected_option && isMeaningfulValue(el.dom.selected_option.value));
      return isMeaningfulValue(el.dom?.value);
    };
    const formFields = inputs.map((el) => ({
      id: el.id,
      role: el.role,
      semantic_type: el.dom?.semantic_type || 'UNKNOWN',
      state: isFieldFilled(el) ? 'FILLED' : 'EMPTY',
      required: Boolean(el.dom?.required),
      form_group_id: el.dom?.form_id || el.form_group_id || null,
      sensitive: Boolean(el.dom?.sensitive)
    }));
    const formGroups = new Map();
    for (const field of formFields) {
      if (!field.form_group_id) continue;
      if (!formGroups.has(field.form_group_id)) formGroups.set(field.form_group_id, []);
      formGroups.get(field.form_group_id).push(field);
    }
    const forms = [...formGroups.entries()].map(([form_group_id, fields]) => {
      const filled = fields.filter((field) => field.state === 'FILLED').length;
      const requiredEmpty = fields.filter((field) => field.required && field.state === 'EMPTY').length;
      const optionalEmpty = fields.filter((field) => !field.required && field.state === 'EMPTY').length;
      return {
        form_group_id,
        fields,
        completion: { filled, required_empty: requiredEmpty, optional_empty: optionalEmpty, empty: requiredEmpty + optionalEmpty, total: fields.length }
      };
    });
    const filledCount = formFields.filter((field) => field.state === 'FILLED').length;
    const emptyCount = formFields.filter((field) => field.state === 'EMPTY').length;
    const requiredEmptyCount = formFields.filter((field) => field.required && field.state === 'EMPTY').length;

    const formState = {
      detected: inputs.length > 0,
      purpose: vlmVisualObservation?.page_purpose || 'Unknown Form',
      fields: formFields,
      forms,
      completion: {
        filled: filledCount,
        empty: emptyCount,
        required_empty: requiredEmptyCount,
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
      // Local-only verifier evidence. PromptBuilder intentionally omits it.
      local_media_state: pageMetadata.local_media_state || { visible_count: 0, media: [] },
      elements: unifiedElements,
      visual_layout_summary: vlmVisualObservation?.spatial_layout || 'No visual layout analysis available.',
      visual_state_summary: vlmVisualObservation?.visual_state || 'Unknown; no visual state was inferred.',
      local_vision_context: pageMetadata.local_vision_context || null,
      detected_sensitive_categories: sensitiveCategories
    };
  }
}

export const defaultObservationFusion = new ObservationFusion();
