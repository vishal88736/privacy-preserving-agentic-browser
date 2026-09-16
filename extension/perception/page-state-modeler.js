/**
 * Page State Modeler
 * Builds a compact, task-conditioned view of the current page so the
 * reasoner sees relevant evidence instead of an undifferentiated DOM dump.
 */

import { defaultTaskGrounding } from './task-grounding.js';

export class PageStateModeler {
  modelPageState(fusedObservation, taskState) {
    const page = fusedObservation?.page || {};
    const elements = fusedObservation?.elements || [];
    const domain = page.domain || 'unknown';
    const title = page.title || 'unknown';
    const url = page.url || domain || '';

    const candidateElements = [];
    let formInputs = 0;
    let links = 0;
    let buttons = 0;

    for (const el of elements) {
      const dom = el.dom || {};
      const interaction = el.interaction || {};
      const visual = el.visual || {};

      if (interaction.clickable || interaction.typeable || interaction.uploadable || dom.tag === 'select') {
        if (interaction.typeable) formInputs++;
        if (dom.tag === 'a') links++;
        if (dom.tag === 'button') buttons++;

        const label = (dom.label || dom.name || dom.placeholder || visual.description || '').trim();

        candidateElements.push({
          element_id: el.id,
          role: dom.tag || el.role,
          type: dom.type || undefined,
          label: label || undefined,
          value: dom.value || undefined,
          href: dom.href || undefined,
          context: (dom.context || '').slice(0, 160) || undefined,
          price_value: dom.price_value ?? undefined,
          sensitive: dom.sensitive || undefined,
          semantic_type: dom.semantic_type || undefined,
          is_typeable: interaction.typeable || undefined,
          is_clickable: interaction.clickable || undefined
        });
      }
    }

    const grounding = defaultTaskGrounding.ground(taskState, fusedObservation);
    const page_type = this._inferPageType(url, title, formInputs, links, fusedObservation);

    return {
      url: domain,
      title: title,
      page_type: page_type,
      summary: `Page contains ${formInputs} inputs, ${buttons} buttons, ${links} links, ${(fusedObservation.result_items || []).length} result cards.`,
      elements: candidateElements,
      detected_form: fusedObservation?.form_state?.detected || false,
      headings: (fusedObservation.headings || []).map((h) => h.text),
      result_sets: grounding.result_sets,
      ranked_candidates: grounding.ranked_candidates,
      resolved_references: grounding.resolved_references,
      budget: grounding.budget,
      optimization: grounding.optimization,
      suggested_search_element: grounding.suggested_search_element,
      visible_text_excerpt: String(fusedObservation.visible_text || '').slice(0, 1200),
      scroll: page.scroll || null
    };
  }

  _inferPageType(url, title, formsCount, linksCount, fused) {
    const urlLower = String(url || '').toLowerCase();
    const titleLower = String(title || '').toLowerCase();
    const items = fused?.result_items || [];

    if (items.length >= 2) return 'SEARCH_RESULTS';
    if (urlLower.includes('search') || urlLower.includes('query=') || urlLower.includes('q=') || titleLower.includes('search')) {
      return 'SEARCH_RESULTS';
    }
    if (urlLower.includes('login') || urlLower.includes('signin') || titleLower.includes('login') || titleLower.includes('sign in')) {
      return 'LOGIN';
    }
    if (urlLower.includes('checkout') || urlLower.includes('cart')) {
      return 'CHECKOUT';
    }
    if (formsCount > 3) {
      return 'FORM';
    }
    if (urlLower.includes('video') || urlLower.includes('watch')) {
      return 'VIDEO_PAGE';
    }
    return 'UNKNOWN';
  }
}

export const defaultPageStateModeler = new PageStateModeler();
