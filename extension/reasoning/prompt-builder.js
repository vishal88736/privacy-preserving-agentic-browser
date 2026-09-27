/**
 * Prompt Builder with Prompt-Injection Defenses
 * Constructs a compact, grounding-first planning prompt.
 * Untrusted webpage text is quarantined; the model may only act on listed IDs.
 *
 * L16: Always keeps submit buttons, selects, radio/checkbox elements
 * L17: Added explicit scroll context (percentage, below-fold indicator)
 * L21: Added symbolic token reference guide in prompt
 */

import { ActionType, SymbolicSecretSource } from '../shared/constants.js';

export class PromptBuilder {
  selectRelevantVisibleText(text, task, maxChars = 1200) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (source.length <= maxChars) return { text: source, sourceChars: source.length, omittedChars: 0 };

    const stopWords = new Set([
      'the', 'and', 'for', 'from', 'with', 'that', 'this', 'then', 'than', 'into',
      'open', 'click', 'find', 'show', 'get', 'please', 'page', 'site', 'website',
      'use', 'using', 'want', 'need', 'have', 'has', 'are', 'was', 'were', 'what',
      'where', 'when', 'which', 'who', 'how', 'you', 'your', 'not', 'but', 'all'
    ]);
    const terms = [...new Set((String(task || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])
      .filter((term) => !stopWords.has(term)))];
    const chunks = [];
    for (let start = 0; start < source.length; start += 360) {
      const end = Math.min(source.length, start + 360);
      const value = source.slice(start, end).trim();
      const lower = value.toLowerCase();
      const chunkTerms = new Set(lower.match(/[\p{L}\p{N}]{3,}/gu) || []);
      const score = terms.reduce((sum, term) => sum + (chunkTerms.has(term) ? 1 : 0), 0);
      chunks.push({ start, value, score });
    }
    const matching = chunks.filter((chunk) => chunk.score > 0);
    const pool = matching.length ? matching : chunks;
    pool.sort((a, b) => b.score - a.score || a.start - b.start);

    const selected = [];
    let used = 0;
    for (const chunk of pool) {
      const separatorLength = selected.length ? 3 : 0;
      const remaining = maxChars - used - separatorLength;
      if (remaining <= 0) break;
      const value = chunk.value.slice(0, remaining);
      selected.push({ start: chunk.start, value });
      used += separatorLength + value.length;
    }
    selected.sort((a, b) => a.start - b.start);
    const selectedText = selected.map((chunk) => chunk.value).join(' … ');
    return {
      text: selectedText,
      sourceChars: source.length,
      omittedChars: Math.max(0, source.length - selected.reduce((sum, chunk) => sum + chunk.value.length, 0))
    };
  }

  compactElements(unifiedObservation, pageState) {
    const rankedIds = new Set((pageState?.ranked_candidates || []).map((c) => c.element_id));
    const mustKeep = new Set();
    const refs = pageState?.resolved_references || {};
    Object.values(refs).forEach((v) => {
      if (typeof v === 'string') mustKeep.add(v);
      if (v && typeof v === 'object' && v.element_id) mustKeep.add(v.element_id);
    });
    if (pageState?.suggested_search_element) mustKeep.add(pageState.suggested_search_element);

    const source = unifiedObservation.elements || [];
    const picked = [];
    for (const el of source) {
      const isRankedOrRequired = rankedIds.has(el.id) || mustKeep.has(el.id);
      const isTypeable = el.interaction?.typeable;
      const isUploadable = el.interaction?.uploadable;
      // L16: Always keep submit buttons, select dropdowns, radio/checkbox elements
      const isSubmitBtn = (el.dom?.type === 'submit') || (el.dom?.tag === 'button' && el.dom?.in_form);
      const isSelectOrChoice = (el.dom?.tag === 'select') ||
        (el.dom?.type === 'radio') || (el.dom?.type === 'checkbox');

      if (isRankedOrRequired || isTypeable || isUploadable || isSubmitBtn || isSelectOrChoice) {
        picked.push(el);
      }
    }
    // Always keep a small fallback of other interactive controls
    if (picked.length < 20) {
      for (const el of source) {
        if (picked.includes(el)) continue;
        picked.push(el);
        if (picked.length >= 28) break;
      }
    }

    return picked.slice(0, 40).map((el) => ({
      id: el.id,
      role: el.role,
      label: el.dom?.label || el.dom?.placeholder || el.dom?.name || el.visual?.description || '',
      tag: el.dom?.tag,
      type: el.dom?.type,
      // Structured semantic evidence (derived from general browser semantics):
      // the model chooses among grounded candidates instead of inventing
      // meaning from element IDs.
      semantic_type: el.semantics?.semantic_type || el.dom?.semantic_type || null,
      capabilities: el.semantics?.capabilities || undefined,
      accessible_name: el.semantics?.accessible_name || undefined,
      evidence: (el.semantics?.evidence_sources || []).join('+') || undefined,
      context: (el.dom?.context || '').slice(0, 140) || undefined,
      price_value: el.dom?.price_value ?? undefined,
      sensitive: el.dom?.sensitive || false,
      value_source: el.dom?.value_source || null,
      current_value: el.dom?.value || '',
      href: el.dom?.href || undefined,
      state: el.dom?.disabled ? 'disabled' : (el.dom?.checked ? 'checked' : 'enabled'),
      clickable: Boolean(el.interaction?.clickable),
      typeable: Boolean(el.interaction?.typeable),
      uploadable: Boolean(el.interaction?.uploadable),
      disabled: Boolean(el.dom?.disabled)
    }));
  }

  compactObservation(unifiedObservation, pageState, task = '') {
    const visibleText = this.selectRelevantVisibleText(
      unifiedObservation.visible_text || pageState?.visible_text_excerpt || '',
      task
    );
    return {
      page: {
        domain: unifiedObservation.page?.domain,
        title: unifiedObservation.page?.title,
        page_type: pageState?.page_type || unifiedObservation.page?.page_type,
        scroll: unifiedObservation.page?.scroll || pageState?.scroll,
        viewport: unifiedObservation.page?.viewport || null
      },
      visual_layout: unifiedObservation.visual_layout_summary,
      visual_state: unifiedObservation.visual_state_summary,
      headings: pageState?.headings || (unifiedObservation.headings || []).map((h) => h.text),
      result_sets: pageState?.result_sets || unifiedObservation.result_items || [],
      ranked_candidates: pageState?.ranked_candidates || [],
      resolved_references: pageState?.resolved_references || {},
      form_state: unifiedObservation.form_state,
      visible_text: visibleText.text,
      visible_text_source_chars: visibleText.sourceChars,
      visible_text_omitted_chars: visibleText.omittedChars,
      elements: this.compactElements(unifiedObservation, pageState)
    };
  }

  // L17: Generate a human-readable scroll context summary. The viewport
  // height comes from the observation (carried by the content script), never
  // from a global `window` reference that is absent in service workers and
  // test environments.
  _scrollContext(scroll, viewport = null) {
    if (!scroll) return 'Scroll position unknown.';
    const { y, maxY } = scroll;
    const viewportH = (Array.isArray(viewport) && Number.isFinite(viewport[1]) && viewport[1] > 0)
      ? viewport[1]
      : ((viewport && Number.isFinite(viewport.height) && viewport.height > 0) ? viewport.height : 800);
    if (!maxY || maxY <= 0) return 'Page is fully visible (no scrollable content).';
    const pct = Math.round((y / Math.max(1, maxY - viewportH)) * 100);
    const clampedPct = Math.min(100, Math.max(0, pct));
    const remainingPx = Math.max(0, maxY - y - viewportH);
    if (clampedPct === 0) return `At the top of the page. ~${remainingPx}px of content below the fold.`;
    if (clampedPct >= 95) return 'At the bottom of the page. No more content below.';
    return `Scrolled ${clampedPct}% down the page. ~${remainingPx}px of content below the fold.`;
  }

}

export const defaultPromptBuilder = new PromptBuilder();
