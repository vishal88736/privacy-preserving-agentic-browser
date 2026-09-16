/**
 * Task Grounding
 * Binds the user's natural-language request to real page evidence
 * BEFORE the remote model plans an action. This is the missing
 * "what is the user asking + what on this page is relevant" stage.
 */

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'at', 'this',
  'that', 'my', 'me', 'i', 'please', 'using', 'with', 'from', 'into', 'open',
  'find', 'search', 'click', 'fill', 'use', 'show', 'get', 'the', 'page'
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}₹$]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t));
}

function parseBudget(text) {
  const s = String(text || '');
  const m = s.match(/(?:under|below|less than|upto|up to|<=|≤)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)\s*(k)?/i)
    || s.match(/(?:₹|rs\.?|inr)\s*([\d,]+)/i);
  if (!m) return null;
  let n = Number(String(m[1]).replace(/,/g, ''));
  if (m[2]) n *= 1000;
  return Number.isFinite(n) ? n : null;
}

function parseOrdinal(text) {
  const s = String(text || '').toLowerCase();
  if (/\bfirst\b|\b1st\b|\btop\b/.test(s)) return 1;
  if (/\bsecond\b|\b2nd\b/.test(s)) return 2;
  if (/\bthird\b|\b3rd\b/.test(s)) return 3;
  return null;
}

function wantsCheapest(text) {
  return /cheap|lowest|least expensive|min(?:imum)? price/i.test(String(text || ''));
}

function wantsLatest(text) {
  return /latest|newest|most recent/i.test(String(text || ''));
}

function haystack(el) {
  const d = el.dom || el;
  return [
    d.label, d.placeholder, d.name, d.href, d.context, d.value,
    el.visual?.description, el.role, d.tag, d.type
  ].filter(Boolean).join(' ').toLowerCase();
}

export class TaskGrounding {
  /**
   * @param {object} taskState
   * @param {object} fusedObservation
   */
  ground(taskState, fusedObservation) {
    const query = taskState?.original_query || taskState?.active_subgoal || '';
    const qTokens = tokens(query);
    const constraints = Array.isArray(taskState?.constraints) ? taskState.constraints : [];
    const allText = [query, ...constraints].join(' ');
    const budget = parseBudget(allText);
    const ordinal = parseOrdinal(allText);
    const cheapest = wantsCheapest(allText);
    const latest = wantsLatest(allText);

    const elements = fusedObservation?.elements || [];
    const resultItems = fusedObservation?.result_items || [];

    const scored = elements.map((el) => {
      const hay = haystack(el);
      let score = 0;
      for (const t of qTokens) {
        if (hay.includes(t)) score += 3;
      }
      const d = el.dom || {};
      if (el.interaction?.typeable && /search|find|type|fill|query/i.test(allText)) score += 4;
      if (el.interaction?.typeable && /search|query|find/i.test(hay)) score += 5;
      if (el.interaction?.clickable && /click|open|select|play/i.test(allText)) score += 2;
      if (el.interaction?.uploadable && /upload/i.test(allText)) score += 8;
      if (d.semantic_type && qTokens.some((t) => String(d.semantic_type).toLowerCase().includes(t))) score += 6;
      if (d.sensitive && /fill|form|aadhaar|pan|profile/i.test(allText)) score += 3;
      if (/nav|cookie|privacy policy|subscribe|sign in|login/i.test(hay) && !/login|sign in|nav/i.test(allText)) {
        score -= 4;
      }
      return {
        element_id: el.id,
        score,
        label: d.label || el.visual?.description || '',
        role: d.tag || el.role,
        type: d.type,
        price_value: d.price_value ?? null,
        context: (d.context || '').slice(0, 180),
        why: score > 0 ? 'lexical/intent match' : 'interactive but low relevance'
      };
    }).sort((a, b) => b.score - a.score);

    const ranked = scored.filter((s) => s.score > 0).slice(0, 24);
    if (ranked.length < 8) {
      ranked.push(...scored.filter((s) => s.score <= 0).slice(0, 8 - ranked.length));
    }

    let suitable = resultItems.slice();
    if (budget != null) {
      suitable = suitable.filter((it) => it.price_value == null || it.price_value <= budget);
    }
    if (cheapest) {
      suitable = suitable.slice().sort((a, b) => {
        if (a.price_value == null) return 1;
        if (b.price_value == null) return -1;
        return a.price_value - b.price_value;
      });
    }

    const resolved = {};
    if (suitable.length) {
      const pickIdx = ordinal ? Math.min(ordinal, suitable.length) - 1 : 0;
      const pick = suitable[pickIdx];
      if (cheapest) resolved.cheapest = pick.primary_action_id || pick.id;
      if (ordinal === 1 || /first|suitable/i.test(allText)) {
        resolved.first_suitable = pick.primary_action_id || pick.id;
      }
      if (/this|that|on this page/i.test(query) && pick.primary_action_id) {
        resolved.this = pick.primary_action_id;
      }
      resolved.selected_item = {
        id: pick.id,
        title: pick.title,
        price_text: pick.price_text,
        price_value: pick.price_value,
        element_id: pick.primary_action_id
      };
    }

    const searchEl = ranked.find((r) => /search|query|find/i.test(`${r.label} ${r.type} ${r.role}`))
      || scored.find((r) => r.type === 'search' || r.type === 'text');

    return {
      query,
      tokens: qTokens,
      budget,
      optimization: cheapest ? 'min_price' : (latest ? 'latest' : null),
      ordinal,
      ranked_candidates: ranked,
      result_sets: suitable.slice(0, 12).map((it) => ({
        id: it.id,
        title: it.title,
        price_text: it.price_text,
        price_value: it.price_value,
        element_id: it.primary_action_id,
        matches_budget: budget == null || (it.price_value != null && it.price_value <= budget)
      })),
      resolved_references: resolved,
      suggested_search_element: searchEl ? searchEl.element_id : null,
      ignored_noise: scored.filter((s) => s.score < 0).slice(0, 8).map((s) => s.element_id)
    };
  }
}

export const defaultTaskGrounding = new TaskGrounding();
