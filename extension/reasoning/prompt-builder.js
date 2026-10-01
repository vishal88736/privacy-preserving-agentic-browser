/**
 * Prompt Builder with Prompt-Injection Defenses
 * Constructs a compact, grounding-first planning prompt.
 * Untrusted webpage text is quarantined; the model may only act on listed IDs.
 *
 * L16: Always keeps submit buttons, selects, radio/checkbox elements
 * L21: Added symbolic token reference guide in prompt
 */

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

    // A file input is the ONLY way to attach a stored document, and UPLOAD cannot
    // be emitted without a grounded file input. On a long form with more than
    // 40 typeable controls ahead of it, a flat truncation dropped the file
    // input from the payload, so the model had nothing to aim UPLOAD at and the
    // feature became unreachable. Reserve slots for uploadables before
    // truncating the rest.
    const MAX_COMPACT_ELEMENTS = 40;
    const uploadables = picked.filter((el) => el.interaction?.uploadable);
    const others = picked.filter((el) => !el.interaction?.uploadable);
    const reserved = Math.min(uploadables.length, MAX_COMPACT_ELEMENTS);
    const budget = Math.max(0, MAX_COMPACT_ELEMENTS - reserved);
    const selected = [...others.slice(0, budget), ...uploadables.slice(0, reserved)];

    return selected.map((el) => ({
      id: el.id,
      el_id: el.el_id || el.id,
      role: el.role,
      label: el.dom?.label || el.dom?.placeholder || el.dom?.name || el.visual?.description || '',
      text: el.dom?.text || el.text || undefined,
      nearby_text: (el.dom?.context || el.nearby_text || '').slice(0, 140) || undefined,
      tag: el.dom?.tag || el.tag,
      input_type: el.dom?.type || el.input_type || undefined,
      type: el.dom?.type || el.input_type || undefined,
      placeholder: el.dom?.placeholder || el.placeholder || undefined,
      title: el.dom?.title || el.title || undefined,
      bbox: el.dom?.bbox || el.bounding_box || undefined,
      visible: el.visible !== false && el.dom?.is_visible !== false,
      enabled: el.enabled !== false && !el.dom?.disabled,
      checked: Boolean(el.dom?.checked ?? el.checked),
      selected: Boolean(el.dom?.selected ?? el.selected),
      selected_option: el.dom?.selected_option || el.selected_option || undefined,
      parent_element_id: el.dom?.parent_element_id || el.parent_element_id || undefined,
      child_element_ids: el.dom?.child_element_ids || el.child_element_ids || undefined,
      form_group_id: el.dom?.form_id || el.form_group_id || undefined,
      required: Boolean(el.dom?.required),
      // Structured semantic evidence (derived from general browser semantics):
      // the model chooses among grounded candidates instead of inventing
      // meaning from element IDs.
      semantic_type: el.semantics?.semantic_type || el.dom?.semantic_type || null,
      semantic_action_type: el.semantics?.semantic_type || el.dom?.semantic_type || el.semantic_action_type || null,
      capabilities: el.semantics?.capabilities || undefined,
      accessible_name: el.semantics?.accessible_name || undefined,
      evidence: (el.semantics?.evidence_sources || []).join('+') || undefined,
      context: (el.dom?.context || '').slice(0, 140) || undefined,
      provenance: el.provenance || 'DOM',
      confidence: el.confidence ?? null,
      price_value: el.dom?.price_value ?? undefined,
      sensitive: el.dom?.sensitive || false,
      value_source: el.dom?.value_source || null,
      current_value: el.dom?.value || '',
      // Select options, so a dropdown can actually be planned.
      //
      // The planner's contract is "SELECT uses a value that matches a known
      // option for the observed element; if options are missing, do not
      // guess". Without the list in the payload the model has no way to
      // produce a valid value, so every country/state/gender dropdown became
      // an ASK_USER or a rejected guess. Option text and value are
      // page-authored labels that the DOM sanitizer has already scrubbed.
      options: (el.dom?.options || el.options || undefined)?.slice?.(0, 40)?.map((option) => ({
        text: option?.text || '',
        value: option?.value || '',
        selected: Boolean(option?.selected)
      })),
      // Filled bit only (no value): lets the planner see that a redacted
      // field already holds something instead of re-typing it in a loop.
      filled: el.dom?.has_value === true,
      href: el.dom?.href || undefined,
      state: el.dom?.disabled ? 'disabled' : (el.dom?.checked ? 'checked' : (el.dom?.selected ? 'selected' : 'enabled')),
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
      perception_provenance: unifiedObservation.provenance || 'DOM_ONLY',
      visual_layout: unifiedObservation.visual_layout_summary,
      visual_state: unifiedObservation.visual_state_summary,
      // Privacy-safe derived media signal (not the raw verifier object).
      // The planner is otherwise blind to play state: after CLICK play the
      // next observation looks identical, so it clicks again (toggling pause)
      // and never emits DONE. Only paused/ended booleans are summarized —
      // no URLs, titles, ordinals, or ready_state values leave the device.
      media_summary: this._mediaSummary(unifiedObservation.local_media_state)
        || pageState?.media_summary || 'no playable media',
      media_playing: this._isMediaPlaying(unifiedObservation.local_media_state)
        || pageState?.media_playing === true,
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

  // Derived playback signal for the planner. Counts and booleans only —
  // the raw local_media_state object (with ordinals/ready_state) is never
  // serialized, per the privacy test below.
  _mediaSummary(localMediaState) {
    const media = Array.isArray(localMediaState?.media) ? localMediaState.media : [];
    if (!media.length) return 'no playable media';
    const playing = media.filter((m) => m && m.paused === false && m.ended !== true).length;
    const total = media.length;
    if (playing > 0) return total === 1 ? '1 media item playing' : `${total} media items (${playing} playing)`;
    return total === 1 ? '1 media item paused' : `${total} media items (all paused)`;
  }

  _isMediaPlaying(localMediaState) {
    const media = Array.isArray(localMediaState?.media) ? localMediaState.media : [];
    return media.some((m) => m && m.paused === false && m.ended !== true);
  }

}

export const defaultPromptBuilder = new PromptBuilder();
