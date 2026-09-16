/**
 * Page State Modeler
 * Processes the fused observation to extract a compact, semantic representation 
 * of the current page for the reasoning model, without hardcoding site-specific rules.
 */

export class PageStateModeler {
  /**
   * Models the current page to reduce noise for the reasoning model
   * @param {Object} fusedObservation - Unified observation from ObservationFusion
   * @param {Object} taskState - Current TaskState
   * @returns {Object} Structured Page State
   */
  modelPageState(fusedObservation, taskState) {
    const page = fusedObservation?.page || {};
    const elements = fusedObservation?.elements || [];
    const domain = page.domain || 'unknown';
    const title = page.title || 'unknown';
    const url = page.url || '';
    
    const candidateElements = [];
    let formInputs = 0;
    let links = 0;
    let buttons = 0;

    for (const el of elements) {
      const dom = el.dom || {};
      const interaction = el.interaction || {};
      const visual = el.visual || {};
      
      // Keep interactive elements
      if (interaction.clickable || interaction.typeable || interaction.uploadable || dom.tag === 'select') {
        if (interaction.typeable) formInputs++;
        if (dom.tag === 'a') links++;
        if (dom.tag === 'button') buttons++;

        const label = (dom.label || dom.name || dom.placeholder || visual.description || '').trim();
        
        // Build stable semantic identity
        candidateElements.push({
          element_id: el.id,
          role: dom.tag || el.role,
          type: dom.type || undefined,
          label: label || undefined,
          value: dom.value || undefined,
          href: dom.href || undefined,
          sensitive: dom.sensitive || undefined,
          semantic_type: dom.semantic_type || undefined,
          is_typeable: interaction.typeable || undefined,
          is_clickable: interaction.clickable || undefined
        });
      }
    }

    const page_type = this._inferPageType(url, title, formInputs, links);

    return {
      url: domain,
      title: title,
      page_type: page_type,
      summary: `Page contains ${formInputs} inputs, ${buttons} buttons, and ${links} links.`,
      elements: candidateElements,
      detected_form: fusedObservation?.form_state?.detected || false
    };
  }

  _inferPageType(url, title, formsCount, linksCount) {
    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();

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
