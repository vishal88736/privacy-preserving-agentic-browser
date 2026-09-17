/**
 * Page State Modeler
 * Builds a compact, task-conditioned view of the current page so the
 * reasoner sees relevant evidence instead of an undifferentiated DOM dump.
 *
 * L14: Added PRODUCT_DETAIL, SETTINGS, HOME, DASHBOARD, PAYMENT page types
 */

import { defaultTaskGrounding } from './task-grounding.js';

export class PageStateModeler {
  modelPageState(fusedObservation, taskState) {
    const page = fusedObservation?.page || {};
    const elements = fusedObservation?.elements || [];
    const domain = page.domain || 'unknown';
    const title = page.title || 'unknown';
    // Preserve the full URL for reasoning (path/query matter for page-type
    // inference); keep domain separately. Previously this returned only the
    // domain under the `url` key, losing /search, /login, ?q= signals.
    const fullUrl = page.url || domain || '';
    const url = fullUrl;

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
    const page_type = this._inferPageType(fullUrl, title, formInputs, links, buttons, fusedObservation);

    return {
      url: fullUrl,
      domain,
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
      scroll: page.scroll || null,
      // Backward-compatible aliases expected by older tests/consumers.
      active_subgoal: taskState?.getActiveSubgoal ? taskState.getActiveSubgoal() : (taskState?.active_subgoal || taskState?.current_subgoal || null),
      relevant_elements: grounding.ranked_candidates,
      irrelevant_elements_count: (grounding.ignored_noise || []).length
    };
  }

  // L14: Expanded page type inference with many more categories
  _inferPageType(url, title, formsCount, linksCount, buttonsCount, fused) {
    const urlLower = String(url || '').toLowerCase();
    const titleLower = String(title || '').toLowerCase();
    const items = fused?.result_items || [];
    const headings = (fused?.headings || []).map(h => (h.text || '').toLowerCase()).join(' ');

    // Search results — highest priority, items present
    if (items.length >= 2) return 'SEARCH_RESULTS';
    if (urlLower.includes('search') || urlLower.includes('query=') || urlLower.includes('q=') || titleLower.includes('search results')) {
      return 'SEARCH_RESULTS';
    }

    // Login / Sign-in
    if (urlLower.includes('login') || urlLower.includes('signin') || titleLower.includes('login') || titleLower.includes('sign in')) {
      return 'LOGIN';
    }

    // Registration / Sign-up
    if (urlLower.includes('register') || urlLower.includes('signup') || titleLower.includes('register') || titleLower.includes('sign up') || titleLower.includes('create account')) {
      return 'REGISTRATION';
    }

    // L14: Payment / Checkout
    if (urlLower.includes('checkout') || urlLower.includes('cart') || urlLower.includes('payment') || titleLower.includes('checkout') || titleLower.includes('payment')) {
      return 'CHECKOUT';
    }

    // L14: Product detail page — single item with price, add to cart
    if (/product|item|detail|dp\//.test(urlLower) || /add to cart|buy now|add to bag/i.test(headings)) {
      return 'PRODUCT_DETAIL';
    }

    // L14: Settings / Account / Profile pages
    if (/settings|preferences|account|profile/i.test(urlLower) || /settings|preferences|account/i.test(titleLower)) {
      return 'SETTINGS';
    }

    // Video / Media
    if (urlLower.includes('video') || urlLower.includes('watch') || urlLower.includes('youtube') || titleLower.includes('watch')) {
      return 'VIDEO_PAGE';
    }

    // Application / KYC / Document forms
    if (/form|apply|application|onboard|kyc|verification|document/i.test(titleLower)) {
      return 'FORM';
    }

    // Generic forms (many inputs)
    if (formsCount > 3) {
      return 'FORM';
    }

    // L14: Dashboard — has buttons/links but few form inputs
    if (formsCount <= 1 && buttonsCount >= 3 && linksCount >= 5) {
      return 'DASHBOARD';
    }

    // L14: Home / Landing page — many links, minimal forms
    if (linksCount > 10 && formsCount <= 2) {
      return 'HOME';
    }

    // Search page (has search bar but no results yet)
    if (/search|find/i.test(titleLower)) {
      return 'SEARCH_PAGE';
    }

    return 'UNKNOWN';
  }
}

export const defaultPageStateModeler = new PageStateModeler();
