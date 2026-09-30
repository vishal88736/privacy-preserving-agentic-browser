/**
 * Semantic Capability Classifier
 * Derives a normalized semantic representation for every actionable element
 * from GENERAL browser semantics only: accessibility metadata, DOM role/type,
 * control relationships, visible text, and state. No site-specific rules.
 *
 * Evidence hierarchy (highest first):
 *   1. explicit accessibility semantics (aria-label / aria attributes)
 *   2. DOM role / type / attributes
 *   3. control relationships (in_form, label[for], form_id)
 *   4. visible text and labels
 *   5. surrounding page structure (context)
 *   6. current state (disabled / checked / value)
 *   7. visual evidence (handled by fusion, not here)
 *
 * Spatial proximity is never a semantic signal. It is only a tiebreaker
 * among candidates that are already semantically equivalent.
 */

export const SemanticType = Object.freeze({
  TEXT_INPUT: 'TEXT_INPUT',
  SEARCH_INPUT: 'SEARCH_INPUT',
  SELECT_OPTION: 'SELECT_OPTION',
  RADIO_OPTION: 'RADIO_OPTION',
  CHECK: 'CHECK',
  UNCHECK: 'UNCHECK',
  SUBMIT: 'SUBMIT',
  RESET: 'RESET',
  NAVIGATE: 'NAVIGATE',
  LINK: 'LINK',
  TAB: 'TAB',
  OPEN_MENU: 'OPEN_MENU',
  CLOSE_MENU: 'CLOSE_MENU',
  VOICE_INPUT: 'VOICE_INPUT',
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  NEXT: 'NEXT',
  PREVIOUS: 'PREVIOUS',
  UPLOAD: 'UPLOAD',
  DOWNLOAD: 'DOWNLOAD',
  BUTTON: 'BUTTON'
});

// Media / playback controls: semantically incompatible with text-entry,
// search, and submit intents. A visually adjacent control of this class must
// never be treated as an equivalent candidate.
const MEDIA_CONTROLS = new Set([
  SemanticType.VOICE_INPUT, SemanticType.PLAY, SemanticType.PAUSE,
  SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.DOWNLOAD
]);

/** Action -> element semantics that contradict it outright (state permitting). */
const ACTION_CONFLICTS = Object.freeze({
  TYPE: new Set([SemanticType.VOICE_INPUT, SemanticType.PLAY, SemanticType.PAUSE, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.DOWNLOAD, SemanticType.LINK]),
  SELECT: new Set([SemanticType.VOICE_INPUT, SemanticType.PLAY, SemanticType.PAUSE, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.LINK]),
  CLICK: new Set([]),
  SUBMIT: new Set([SemanticType.LINK, SemanticType.VOICE_INPUT, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.DOWNLOAD])
});

const SEARCH_HINT = /(?:\b|^)(?:search|query|find|look\s*up)(?:\b|$)/i;
const VOICE_HINT = /voice|microphone|\bmic\b|speak|dictat|speech/i;
const UPLOAD_HINT = /upload|attach|\bfile\b|\bimage\b/i;
const SUBMIT_HINT = /submit|apply|pay(?:\s|$)|place\s+(?:order|order)|send|confirm|continue|proceed|sign\s*in|log\s*in|next\s*step|create|save\s+(?:and|&)\s+(?:continue|submit)|register|get\s+started|book|search/i;
const RESET_HINT = /\breset\b|\bclear\b(\s+form|\s+field|\s+all)?|\bdefault\b/i;
const PLAY_HINT = /\bplay\b|\bwatch\b|\blisten\b|\bstart\s+(?:video|player|media)\b/i;
const PAUSE_HINT = /\bpause\b/i;
const NEXT_HINT = /\bnext\b/i;
const PREVIOUS_HINT = /\b(previous|prev|back)\b/i;
const DOWNLOAD_HINT = /\bdownload\b/i;

function accessibleName(el, dom) {
  // Accessibility semantics first, then label/placeholder/title/name.
  return String(
    dom.label || dom.ariaLabel || dom.placeholder || dom.title || dom.name ||
    el?.visual?.description || ''
  ).trim();
}

function visibleText(el, dom) {
  return String(dom.label || el?.visual?.description || '').trim();
}

function typeable(el, dom) {
  if (el?.interaction?.typeable !== undefined) return Boolean(el.interaction.typeable);
  if (dom.tag === 'textarea') return true;
  if (dom.tag !== 'input') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'file', 'image'].includes(String(dom.type || ''));
}

/**
 * Classify one element into the normalized semantic representation.
 * Accepts a fused element ({ dom, interaction, visual }) or a raw DOM-ish
 * object. Returns { semantic_type, capabilities, accessible_name,
 * visible_text, control_type, icon_only, evidence_sources, state }.
 */
export function classifyElement(el) {
  const dom = (el && typeof el === 'object' && el.dom && typeof el.dom === 'object') ? el.dom : (el || {});
  const interaction = (el && typeof el === 'object' && el.interaction) || {};
  const tag = String(dom.tag || '').toLowerCase();
  const type = String(dom.type || '').toLowerCase();
  const role = String(dom.role || el?.role || '').toLowerCase();
  const aria = String(dom.ariaLabel || '').trim();
  const name = accessibleName(el, dom);
  const nameLower = name.toLowerCase();
  const href = String(dom.href || '');
  const capabilities = new Set();
  const evidence = new Set();
  let semantic = null;

  // 1. Explicit accessibility semantics (aria) — highest priority.
  if (aria) evidence.add('accessibility');
  if (aria && VOICE_HINT.test(aria)) semantic = SemanticType.VOICE_INPUT;
  if (!semantic && aria && PLAY_HINT.test(aria)) semantic = SemanticType.PLAY;
  if (!semantic && aria && PAUSE_HINT.test(aria)) semantic = SemanticType.PAUSE;
  if (!semantic && aria && UPLOAD_HINT.test(aria)) semantic = SemanticType.UPLOAD;
  if (!semantic && aria && DOWNLOAD_HINT.test(aria)) semantic = SemanticType.DOWNLOAD;
  if (!semantic && aria && NEXT_HINT.test(aria)) semantic = SemanticType.NEXT;
  if (!semantic && aria && PREVIOUS_HINT.test(aria)) semantic = SemanticType.PREVIOUS;

  // 2. DOM role / type / attributes.
  if (dom.disabled) evidence.add('state');
  if (type === 'file') {
    semantic = semantic || SemanticType.UPLOAD;
  } else if (tag === 'select') {
    semantic = semantic || SemanticType.SELECT_OPTION;
  } else if (type === 'checkbox') {
    semantic = semantic || SemanticType.CHECK;
  } else if (type === 'radio') {
    semantic = semantic || SemanticType.RADIO_OPTION;
  } else if (role === 'checkbox') {
    semantic = semantic || SemanticType.CHECK;
  } else if (role === 'radio') {
    semantic = semantic || SemanticType.RADIO_OPTION;
  } else if (role === 'tab') {
    semantic = semantic || SemanticType.TAB;
  } else if (tag === 'a' || role === 'link') {
    evidence.add('dom');
    semantic = semantic || SemanticType.LINK;
  }

  // 3. Control relationships (form membership, submit type).
  const inForm = Boolean(dom.in_form || dom.form_id);
  if (inForm) evidence.add('form');
  if (type === 'submit' || (tag === 'input' && type === 'submit')) {
    semantic = SemanticType.SUBMIT;
  } else if (!semantic && tag === 'button' && inForm && SUBMIT_HINT.test(nameLower)) {
    // Visible-text evidence (4) combined with form relationship (3).
    evidence.add('text');
    semantic = SemanticType.SUBMIT;
  } else if (!semantic && tag === 'button' && RESET_HINT.test(nameLower)) {
    evidence.add('text');
    semantic = SemanticType.RESET;
  }

  // 4. Visible text and labels (for controls not yet classified).
  if (!semantic && typeable(el, dom)) {
    evidence.add('dom');
    const haystackText = `${nameLower} ${String(dom.name || '').toLowerCase()}`;
    if (type === 'search' || SEARCH_HINT.test(haystackText)) {
      semantic = SemanticType.SEARCH_INPUT;
    } else {
      semantic = SemanticType.TEXT_INPUT;
    }
  }

  if (!semantic && (tag === 'button' || role === 'button')) {
    evidence.add('text');
    if (VOICE_HINT.test(nameLower)) semantic = SemanticType.VOICE_INPUT;
    else if (PLAY_HINT.test(nameLower)) semantic = SemanticType.PLAY;
    else if (PAUSE_HINT.test(nameLower)) semantic = SemanticType.PAUSE;
    else if (NEXT_HINT.test(nameLower)) semantic = SemanticType.NEXT;
    else if (PREVIOUS_HINT.test(nameLower)) semantic = SemanticType.PREVIOUS;
    else if (UPLOAD_HINT.test(nameLower)) semantic = SemanticType.UPLOAD;
    else if (DOWNLOAD_HINT.test(nameLower)) semantic = SemanticType.DOWNLOAD;
    else if (SUBMIT_HINT.test(nameLower)) semantic = SemanticType.SUBMIT;
    else semantic = SemanticType.BUTTON;
  }

  if (!semantic) semantic = SemanticType.BUTTON;

  // 5. Surrounding page structure: link href carries navigation evidence.
  if (semantic === SemanticType.LINK && href) evidence.add('navigation');

  // Action capabilities derived from the semantic type.
  if (semantic === SemanticType.TEXT_INPUT || semantic === SemanticType.SEARCH_INPUT) {
    capabilities.add('TYPE');
    capabilities.add('CLICK');
  } else if (semantic === SemanticType.SELECT_OPTION) {
    capabilities.add('SELECT');
  } else if (semantic === SemanticType.CHECK || semantic === SemanticType.UNCHECK) {
    capabilities.add('CHECK');
    capabilities.add('UNCHECK');
  } else if (semantic === SemanticType.RADIO_OPTION) {
    capabilities.add('CLICK');
    capabilities.add('CHECK');
  } else if (semantic === SemanticType.UPLOAD) {
    capabilities.add('UPLOAD');
  } else if (semantic === SemanticType.SUBMIT || semantic === SemanticType.BUTTON ||
             semantic === SemanticType.LINK || semantic === SemanticType.TAB ||
             semantic === SemanticType.OPEN_MENU || semantic === SemanticType.CLOSE_MENU ||
             semantic === SemanticType.NAVIGATE) {
    capabilities.add('CLICK');
  } else if (semantic === SemanticType.PLAY || semantic === SemanticType.PAUSE ||
             semantic === SemanticType.NEXT || semantic === SemanticType.PREVIOUS ||
             semantic === SemanticType.VOICE_INPUT) {
    capabilities.add('CLICK');
  }

  return {
    semantic_type: semantic,
    capabilities: Array.from(capabilities),
    accessible_name: name || undefined,
    visible_text: visibleText(el, dom) || undefined,
    control_type: type || undefined,
    icon_only: Boolean(aria && !dom.label && !dom.placeholder) || undefined,
    evidence_sources: Array.from(evidence),
    state: dom.disabled ? 'disabled' : undefined
  };
}

/**
 * Convert the user's request into required action semantics. Derived from
 * general intent verbs and browser semantics — never site-specific.
 */
export function requiredCapabilities(taskText, intent, activeSubgoal) {
  const text = String(taskText || '').toLowerCase();
  const subgoal = String(activeSubgoal || '').toLowerCase();
  const wanted = new Set();
  const intentUpper = String(intent || '').toUpperCase();

  // Phase detection: once the subgoal advances past navigation (search, form
  // fill, inspect, verify), requirements derive from the subgoal phase —
  // links from the finished "open X" part of a compound task must not
  // outrank current targets.
  const subgoalDrivesPhase = subgoal.includes('search') || subgoal.startsWith('fill form') ||
    subgoal.includes('inspect') || subgoal.includes('identify') || subgoal.includes('verify');
  const phaseText = subgoalDrivesPhase ? subgoal : text;

  if (/search|find|look\s*up|cheapest|lowest/i.test(phaseText) || intentUpper === 'SEARCH' || subgoal.includes('search')) {
    wanted.add(SemanticType.SEARCH_INPUT);
    wanted.add(SemanticType.SUBMIT);
  }
  if (/fill|form|application|register|sign\s*up|profile|kyc|onboard/i.test(phaseText) || intentUpper === 'FILL_FORM' || subgoal.startsWith('fill form')) {
    wanted.add(SemanticType.TEXT_INPUT);
    wanted.add(SemanticType.SELECT_OPTION);
    wanted.add(SemanticType.RADIO_OPTION);
    wanted.add(SemanticType.CHECK);
    wanted.add(SemanticType.SUBMIT);
  }
  if (/upload|attach/i.test(phaseText) || intentUpper === 'UPLOAD') wanted.add(SemanticType.UPLOAD);
  if (/play|watch|listen/i.test(phaseText) || intentUpper === 'PLAY') {
    wanted.add(SemanticType.PLAY);
    wanted.add(SemanticType.LINK);
  }
  if (!subgoalDrivesPhase && (/open|go\s+to|navigate|visit/i.test(text) || intentUpper === 'NAVIGATE')) {
    wanted.add(SemanticType.LINK);
    wanted.add(SemanticType.NAVIGATE);
  }
  if (/buy|order|checkout|purchase/i.test(phaseText)) wanted.add(SemanticType.SUBMIT);
  if (/click|press|select|choose|tap/i.test(phaseText) || intentUpper === 'CLICK') wanted.add(SemanticType.BUTTON);
  if (!wanted.size) {
    // Unknown intent: everything interactive is potentially relevant.
    wanted.add(SemanticType.BUTTON);
    wanted.add(SemanticType.LINK);
    wanted.add(SemanticType.TEXT_INPUT);
  }
  return wanted;
}

/** Semantic conflicts for a required set: opposite or unrelated media/nav semantics. */
function conflictsFor(required) {
  return (semantic) => {
    if (required.has(semantic)) return false;
    return MEDIA_CONTROLS.has(semantic) || semantic === SemanticType.RESET;
  };
}

function nameTokenScore(name, taskText) {
  const tokens = String(taskText || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const nameLower = String(name || '').toLowerCase();
  let score = 0;
  for (const t of tokens) if (nameLower.includes(t)) score += 2;
  return Math.min(score, 6);
}

// Generic page noise: footer/legal/cookie/nav chrome is never a strong
// candidate unless the task explicitly asks for it.
const NOISE_HINT = /cookie|privacy policy|terms(?:\s+of\s+use)?|copyright|footer|about\s+us|contact\s+us|newsletter|sign\s*in|log\s*in/i;

/**
 * Deterministic candidate ranking against the requested action.
 * Scores semantic compatibility, accessible-name compatibility, role,
 * control type, form relationship, state, visible text, and nearby context —
 * and explicitly penalizes semantic conflicts. Geometry (prominence) is only
 * a tiebreaker among already-equivalent candidates, never a semantic signal.
 *
 * @param {Array<Object>} elements - fused elements (or DOM-ish objects)
 * @param {Object} options - { required: Set<SemanticType>, taskText, excludeIds: Set, capabilityFilter, geometryRef: [x,y] }
 * @returns {Array<Object>} ranked candidates with scores, evidence, conflicts
 */
export function rankCandidates(elements, { required = new Set(), taskText = '', excludeIds = new Set(), capabilityFilter = null, geometryRef = null } = {}) {
  const isConflict = conflictsFor(required);
  const taskWantsNoise = NOISE_HINT.test(String(taskText || ''));
  const ranked = [];

  for (const el of elements || []) {
    const dom = (el?.dom && typeof el.dom === 'object') ? el.dom : (el || {});
    if (excludeIds && excludeIds.has(el.id)) continue;
    if (dom.disabled) continue;

    const sem = el?.semantics || classifyElement(el);
    if (capabilityFilter && !(sem.capabilities || []).includes(capabilityFilter)) continue;
    const name = sem.accessible_name || '';
    let score = 0;
    const evidence = [...(sem.evidence_sources || [])];

    // 1. Semantic compatibility (dominant signal).
    if (required.has(sem.semantic_type)) score += 10;
    // 2. Explicit conflict penalty.
    if (isConflict(sem.semantic_type)) {
      score -= 8;
      evidence.push(`conflict:${sem.semantic_type}`);
    }
    // 3. Generic page noise penalty.
    if (!taskWantsNoise && NOISE_HINT.test(name)) {
      score -= 5;
      evidence.push('page_noise');
    }
    // 4. Accessible-name compatibility with the task.
    score += nameTokenScore(name, taskText);
    // 5. Control relationship: form members are strong submit candidates.
    if (required.has(SemanticType.SUBMIT) && (dom.in_form || dom.form_id) && sem.semantic_type === SemanticType.SUBMIT) score += 3;
    // 6. Visible text bonus.
    if (sem.visible_text && required.size && nameTokenScore(sem.visible_text, taskText) >= 4) score += 1;
    // 7. Geometry tiebreaker ONLY among semantically equivalent candidates.
    if (geometryRef && Array.isArray(dom.bbox) && required.has(sem.semantic_type)) {
      const [gx, gy] = geometryRef;
      const dist = Math.hypot((dom.bbox[0] + (dom.bbox[2] || 0) / 2) - gx, (dom.bbox[1] + (dom.bbox[3] || 0) / 2) - gy);
      score += Math.max(0, 2 - dist / 400);
    }

    ranked.push({
      element_id: el.id,
      semantic_type: sem.semantic_type,
      role: dom.tag || el?.role || '',
      accessible_name: name || undefined,
      state: sem.state || 'enabled',
      score,
      conflict: isConflict(sem.semantic_type) || undefined,
      evidence_sources: Array.from(new Set(evidence)),
      capabilities: sem.capabilities
    });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Deterministic ambiguity check: several semantically plausible candidates
 * that the task text cannot distinguish. Returns the ambiguous set or null.
 */
export function ambiguousCandidates(ranked, { epsilon = 2, minScore = 1, taskText = '' } = {}) {
  const plausible = (ranked || []).filter((c) => !c.conflict && c.score >= minScore);
  if (plausible.length < 2) return null;
  const [top, second] = plausible;
  if (top.score - second.score > epsilon) return null;
  if (top.semantic_type !== second.semantic_type) return null;
  // Task text can still disambiguate: prefer the candidate whose accessible
  // name better matches the task keywords.
  if (taskText) {
    const scoreOf = (c) => nameTokenScore(c.accessible_name, taskText);
    if (scoreOf(top) !== scoreOf(second)) return null;
  }
  return plausible.filter((c) => c.score >= second.score);
}
