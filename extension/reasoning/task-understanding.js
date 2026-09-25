/**
 * Task Understanding & State Machine
 * Maintains the internal semantic representation of the user's task.
 * Includes a local interpreter for fast task startup and grounded fallback
 * planning, so task understanding does not depend on a separate model call.
 */

// L18: Expanded stop-word list — prevents noise entities from polluting grounding
const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'at',
  'is', 'it', 'its', 'be', 'do', 'did', 'does', 'was', 'were', 'been',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'shall',
  'please', 'just', 'also', 'very', 'too', 'then', 'than', 'so', 'but',
  'not', 'no', 'yes', 'ok', 'up', 'out', 'if', 'by', 'as', 'my', 'me',
  'we', 'he', 'she', 'you', 'they', 'our', 'your', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'about',
  'go', 'get', 'got', 'has', 'have', 'had', 'make', 'made', 'want',
  'need', 'use', 'using', 'used', 'try', 'am', 'are', 'i', 'now', 'how'
]);

// L19: Intent detection — SEARCH must be checked before FILL_FORM because
// "find the cheapest and fill booking" should start as SEARCH, not FILL_FORM.
// L20: Multi-intent patterns for composite decomposition.
const INTENT_RULES = [
  { pattern: /upload/i, intent: 'UPLOAD' },
  { pattern: /search|find|cheapest|lowest|look\s*for|browse|compare/i, intent: 'SEARCH' },
  { pattern: /fill|form|application|aadhaar|kyc|register|sign\s*up/i, intent: 'FILL_FORM' },
  { pattern: /play|watch|video|stream/i, intent: 'PLAY' },
  { pattern: /open|go\s*to|navigate|visit/i, intent: 'NAVIGATE' },
  { pattern: /click|select|choose|pick|tap/i, intent: 'CLICK' },
  { pattern: /extract|what\s*is|tell\s*me|price\s*of|read|show\s*me/i, intent: 'EXTRACT' },
  { pattern: /download/i, intent: 'DOWNLOAD' },
  { pattern: /login|log\s*in|sign\s*in/i, intent: 'LOGIN' },
  { pattern: /book|reserve|schedule/i, intent: 'BOOK' }
];

// L20: Detect secondary intents for compound tasks
const COMPOUND_PATTERNS = [
  { pattern: /and\s+(then\s+)?(open|click|select)/i, secondaryIntent: 'CLICK' },
  { pattern: /and\s+(then\s+)?(fill|complete)/i, secondaryIntent: 'FILL_FORM' },
  { pattern: /and\s+(then\s+)?(book|reserve|submit)/i, secondaryIntent: 'BOOK' },
  { pattern: /and\s+(then\s+)?(upload|attach)/i, secondaryIntent: 'UPLOAD' },
  { pattern: /and\s+(then\s+)?(play|watch)/i, secondaryIntent: 'PLAY' },
  { pattern: /and\s+(then\s+)?(extract|read|show|tell)/i, secondaryIntent: 'EXTRACT' },
  { pattern: /and\s+(then\s+)?(download)/i, secondaryIntent: 'DOWNLOAD' }
];

export function localInterpretTask(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  const lower = text.toLowerCase();

  // L19: Walk intent rules in correct priority order
  let intent = 'ACT';
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(lower)) {
      intent = rule.intent;
      break;
    }
  }

  // L20: Detect secondary intent for compound tasks
  let secondaryIntent = null;
  for (const cp of COMPOUND_PATTERNS) {
    if (cp.pattern.test(lower)) {
      secondaryIntent = cp.secondaryIntent;
      break;
    }
  }

  const constraints = [];
  if (/cheap|lowest|least\s*expensive|min(?:imum)?\s*price/i.test(lower)) constraints.push('cheapest');
  if (/latest|newest|most\s*recent/i.test(lower)) constraints.push('latest');
  if (/best|top\s*rated|highest\s*rated/i.test(lower)) constraints.push('best_rated');
  if (/most\s*popular|most\s*viewed|trending/i.test(lower)) constraints.push('most popular');
  if (/ask\s*before\s*submitt|confirm\s*before|ask\s*me\s*before/i.test(lower)) constraints.push('must ask user before submitting');
  if (/\bdon'?t\s+submit\b|do\s+not\s+submit|never\s+submit/i.test(lower)) constraints.push('must NOT submit the form');
  const budget = lower.match(/(?:under|below|less than|upto|up to|<=|≤)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)\s*(k)?/i);
  if (budget) constraints.push(`price <= ${budget[1].replace(/,/g, '')}${budget[2] ? '000' : ''}`);
  if (/\bfirst\b/.test(lower)) constraints.push('first matching result');

  // L18: Better entity extraction with expanded stop-word filtering
  const entities = text
    .split(/[^A-Za-z0-9₹$]+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 12);

  // General-purpose structured interpretation (spec section 3).
  const semantics = parseTaskSemantics(text);

  // L20: Proper multi-step subgoal decomposition
  const subgoals = semantics.subgoals?.length
    ? semantics.subgoals
    : _buildSubgoals(intent, secondaryIntent, lower, constraints);

  return {
    goal: text,
    intent,
    secondaryIntent,
    target: { type: 'page_task', entity: entities[0] || text.slice(0, 40), attributes: {} },
    constraints,
    entities,
    preferences: semantics.preferences || [],
    ordering: semantics.ordering || null,
    references: semantics.references || [],
    required_actions: semantics.required_actions || [],
    success_criteria: semantics.success_criteria || [`The page reflects: ${text}`],
    ambiguities: semantics.ambiguities || [],
    site: semantics.site || null,
    search_query: semantics.search_query || null,
    ranking_constraint: semantics.ranking_constraint || null,
    expected_state: `The page reflects: ${text}`,
    subgoals,
    current_subgoal: subgoals[0],
    current_subgoal_index: 0,
    confidence: 0.55
  };
}

// General site + query + reference extraction. Works for ANY site/query,
// not just example prompts: detects a site token, strips verbs/site/ranking
// words to isolate the clean search query, and records references.
export function parseTaskSemantics(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  const lower = text.toLowerCase();

  const SITE_NAMES = {
    youtube: 'YouTube', google: 'Google', amazon: 'Amazon', flipkart: 'Flipkart',
    bing: 'Bing', duckduckgo: 'DuckDuckGo', github: 'GitHub', stackoverflow: 'StackOverflow',
    gmail: 'Gmail', drive: 'Drive', maps: 'Maps', facebook: 'Facebook',
    twitter: 'Twitter', instagram: 'Instagram', linkedin: 'LinkedIn', reddit: 'Reddit'
  };
  const siteMatch = lower.match(/\b(youtube|google|amazon|flipkart|bing|duckduckgo|github|stackoverflow|gmail|drive|maps|facebook|twitter|instagram|linkedin|reddit|x\.com)\b/i);
  const siteKey = siteMatch ? siteMatch[1].toLowerCase() : null;
  const site = siteKey === 'x.com' ? 'X' : (SITE_NAMES[siteKey] || null);

  let ranking_constraint = null;
  if (/most\s*popular|most\s*viewed|trending/i.test(text)) ranking_constraint = 'most popular';
  else if (/latest|newest|most\s*recent/i.test(text)) ranking_constraint = 'latest';
  else if (/cheap|lowest|least\s*expensive/i.test(text)) ranking_constraint = 'cheapest';
  else if (/best|top\s*rated|highest\s*rated/i.test(text)) ranking_constraint = 'best_rated';

  // Clean search query: remove leading verbs, site opens, ranking adjectives.
  // Handles "search YouTube for X", "find the most popular videos of X",
  // "open google and search for X", "play latest song from X".
  let q = text
    .replace(/^(please\s+)?(could\s+you\s+)?(open|go\s*to|navigate\s*to|visit|search(\s+for)?|find|look\s*for|play|watch|show\s*me)\b\s*/i, '')
    .replace(/\b(open|go\s*to|navigate|visit)\s+(youtube|google|amazon|flipkart|bing|github|stackoverflow)\b\s*(and\s+)?/i, '')
    .replace(/\b(youtube|google|amazon|flipkart|bing|github|stackoverflow|duckduckgo)\b\s*(and\s+)?/i, '')
    .replace(/^search\s+(for\s+)?/i, '')
    .replace(/\bsearch\s+(for\s+)?/gi, '')
    .replace(/\b(most\s*popular|most\s*viewed|trending|latest|newest|most\s*recent|cheapest|lowest)\b\s*/gi, '')
    .replace(/\b(songs?|videos?|results?|items?|products?)\s+(of|for|from)\b\s*/i, '')
    .replace(/\b(of|for|from)\b\s*/i, (m, w, off) => (off === 0 ? '' : m))
    .replace(/\b(play|watch|search\s*for|search)\b\s*/gi, '')
    .trim();
  // Strip leftover leading connectors ("for X", "and X", "the X" when X follows).
  q = q.replace(/^(for|and|the)\s+/i, '').replace(/\s{2,}/g, ' ').trim();
  q = q.replace(/\s{2,}/g, ' ').trim();
  const search_query_init = q || null;

  const references = [];
  if (/\bthis\b/i.test(text)) references.push('this');
  if (/\bthat\b/i.test(text)) references.push('that');
  if (/\bfirst\b|\b1st\b/i.test(text)) references.push('first');
  if (/\bsecond\b|\b2nd\b/i.test(text)) references.push('second');
  if (/\bthird\b|\b3rd\b/i.test(text)) references.push('third');
  if (/cheapest|lowest/i.test(text)) references.push('cheapest');
  if (/on\s+this\s+page/i.test(text)) references.push('on this page');

  let ordering = null;
  if (/cheapest|lowest|price/i.test(text)) ordering = 'price_asc';
  else if (/latest|newest|most\s*recent/i.test(text)) ordering = 'newest';
  else if (/most\s*popular|most\s*viewed/i.test(text)) ordering = 'popularity';

  const preferences = [];
  if (/non-?stop/i.test(text)) preferences.push('non-stop');
  if (/in\s*stock/i.test(text)) preferences.push('in stock');

  const required_actions = [];
  if (/search|find|look\s*for/i.test(lower)) required_actions.push('SEARCH');
  if (/open|click|select|choose/i.test(lower)) required_actions.push('CLICK');
  if (/fill|form|register|sign\s*up/i.test(lower)) required_actions.push('FILL_FORM');
  if (/upload|attach/i.test(lower)) required_actions.push('UPLOAD');
  if (/download/i.test(lower)) required_actions.push('DOWNLOAD');
  if (/book|reserve/i.test(lower)) required_actions.push('BOOK');
  if (/play|watch/i.test(lower)) required_actions.push('PLAY');
  if (/tell\s*me|what\s*is|extract|price\s*of|read|show\s*me/i.test(lower)) required_actions.push('EXTRACT');

  const ambiguities = [];
  // Intent for semantic planners.
  let intent = 'search_and_select';
  if (/login|sign\s*in/i.test(lower)) intent = 'login';
  else if (/fill|form|register|kyc|apply/i.test(lower)) intent = 'fill_form';
  else if (/upload/i.test(lower)) intent = 'upload';
  else if (/book|reserve/i.test(lower)) intent = 'book';
  else if (/download/i.test(lower)) intent = 'download';
  else if (/extract|what\s*is|tell\s*me|price\s*of/i.test(lower)) intent = 'extract';

  // search_query is only meaningful for search/select flows. For form, auth,
  // upload, and booking tasks the "query" would just echo the whole request.
  let search_query = search_query_init;
  if (intent !== 'search_and_select') {
    search_query = null;
  }
  if (!search_query && /search|find|play|open/i.test(lower)) ambiguities.push('search query is unclear');

  // Ordered subgoals for open-ended tasks. Search-style subgoals only for
  // search/select intents; form/fill/upload/etc. use the structured builder
  // so "Fill this form..." never becomes "search for Fill this form...".
  const subgoals = [];
  if (intent === 'search_and_select') {
    if (site) subgoals.push(`open ${site}`);
    if (search_query) subgoals.push(`search for ${search_query}`);
    if (ranking_constraint) subgoals.push(`select ${ranking_constraint} result`);
    else if (/open|click|select/i.test(lower) && search_query) subgoals.push('open the matching result');
  } else {
    const mapped = intent === 'fill_form' ? 'FILL_FORM' : intent === 'upload' ? 'UPLOAD'
      : intent === 'login' ? 'LOGIN' : intent === 'book' ? 'BOOK'
      : intent === 'download' ? 'DOWNLOAD' : intent === 'extract' ? 'EXTRACT' : 'ACT';
    subgoals.push(..._buildSubgoals(mapped, null, lower, []));
  }
  if (!subgoals.length) {
    const fallback = _buildSubgoals('ACT', null, lower, []);
    subgoals.push(...fallback);
  }
  subgoals.push('verify selected result');

  return {
    site,
    intent,
    search_query,
    ranking_constraint,
    references,
    ordering,
    preferences,
    required_actions,
    success_criteria: [`The page reflects: ${text}`],
    ambiguities,
    subgoals,
    confidence: 0.6
  };
}

// L20: Build ordered subgoals from intent + secondary intent
function _buildSubgoals(intent, secondaryIntent, lower, constraints) {
  const subgoals = [];

  // Primary intent subgoals
  switch (intent) {
    case 'SEARCH':
      subgoals.push('search for the requested item');
      if (constraints.includes('cheapest')) subgoals.push('identify the cheapest matching result');
      if (constraints.some(c => c.startsWith('price <='))) subgoals.push('filter results within budget');
      break;
    case 'FILL_FORM':
      subgoals.push('locate the form fields');
      subgoals.push('fill required fields from local profile');
      break;
    case 'UPLOAD':
      subgoals.push('locate the upload input');
      subgoals.push('attach the local document');
      break;
    case 'NAVIGATE':
      subgoals.push('navigate to the target page');
      break;
    case 'LOGIN':
      subgoals.push('locate login fields');
      subgoals.push('fill credentials from local vault');
      subgoals.push('submit the login form');
      break;
    case 'PLAY':
      if (/search|find/.test(lower)) subgoals.push('search for the video');
      subgoals.push('play the target video');
      break;
    case 'CLICK':
      subgoals.push('locate the target element');
      subgoals.push('click the target element');
      break;
    case 'EXTRACT':
      subgoals.push('locate the requested information on the page');
      subgoals.push('extract the target data');
      break;
    case 'BOOK':
      subgoals.push('locate the booking/reservation form');
      subgoals.push('fill booking details');
      subgoals.push('confirm and submit the booking');
      break;
    default:
      subgoals.push('accomplish the user request');
  }

  // Secondary intent subgoals (compound task)
  if (secondaryIntent) {
    switch (secondaryIntent) {
      case 'CLICK':
        subgoals.push('open the matching result');
        break;
      case 'FILL_FORM':
        subgoals.push('fill the form on the target page');
        break;
      case 'BOOK':
        subgoals.push('complete the booking/reservation');
        break;
      case 'UPLOAD':
        subgoals.push('attach the required document');
        break;
      case 'PLAY':
        subgoals.push('play the selected content');
        break;
      case 'EXTRACT':
        subgoals.push('extract the requested information');
        break;
      case 'DOWNLOAD':
        subgoals.push('download the target file');
        break;
    }
  }

  // Always add open/click if the user says "open" or "click" in a search task
  if (intent === 'SEARCH' && /open|click|first|result/.test(lower) && !subgoals.includes('open the matching result')) {
    subgoals.push('open the matching result');
  }

  if (!subgoals.length) subgoals.push('accomplish the user request');

  return subgoals;
}

export class TaskState {
  constructor(rawPrompt) {
    this.original_query = rawPrompt || '';

    this.intent = 'unknown';
    this.secondaryIntent = null;
    this.target = null;
    this.constraints = [];
    this.entities = [];
    this.preferences = [];
    this.ordering = null;
    this.references = [];
    this.required_actions = [];
    this.success_criteria = [];
    this.ambiguities = [];

    this.expected_state = null;
    this.subgoals = [];
    this.current_subgoal = null;
    this.current_subgoal_index = 0;
    this.completed_subgoals = [];
    this.confidence = 0.0;

    this.expected_state_after_action = null;

    this.site = null;
    this.search_query = null;
    this.ranking_constraint = null;

    // If constructed with a real prompt, seed a sensible default task so
    // getActiveSubgoal() is meaningful before updateFromModel() runs.
    if (rawPrompt) {
      try {
        const seed = parseTaskSemantics(rawPrompt);
        this.subgoals = seed.subgoals || [];
        this.current_subgoal = this.subgoals[0] || null;
        this.site = seed.site || null;
        this.search_query = seed.search_query || null;
        this.ranking_constraint = seed.ranking_constraint || null;
        this.references = seed.references || [];
        this.required_actions = seed.required_actions || [];
      } catch { /* keep unknown */ }
    }
  }

  get goal() {
    return this.original_query;
  }

  getActiveSubgoal() {
    return this.current_subgoal || this.subgoals?.[this.current_subgoal_index] || this.original_query || 'accomplish task';
  }

  isCompleted() {
    return this.intent === 'done';
  }

  // L7: Advance to the next subgoal — enables progressive task completion
  advanceSubgoal(completedSubgoalOverride = null) {
    const completed = completedSubgoalOverride || this.current_subgoal;
    if (completed && !this.completed_subgoals.includes(completed)) {
      this.completed_subgoals.push(completed);
    }

    if (this.subgoals && this.current_subgoal_index < this.subgoals.length - 1) {
      this.current_subgoal_index++;
      this.current_subgoal = this.subgoals[this.current_subgoal_index];
      return true; // Advanced successfully
    }
    return false; // No more subgoals
  }

  // Backward-compatible alias: advance(action, observation, result).
  // Advances one subgoal on successful non-WAIT actions; syncs when the
  // observation shows we reached a new stage (e.g. results page).
  advance(action = null, observation = null, result = null) {
    const ok = !result || result.success !== false;
    const verb = action?.action || action;
    if (!ok) return false;
    if (verb && verb !== 'WAIT' && verb !== 'DONE') {
      return this.advanceSubgoal();
    }
    return false;
  }

  // L7: Check if the current subgoal appears to be satisfied based on model feedback
  shouldAdvanceSubgoal(verification_result, active_subgoal_from_model) {
    if (!this.subgoals || this.subgoals.length <= 1) return false;

    // If the model says SUCCESS or reports a different active subgoal than ours, advance
    if (verification_result === 'SUCCESS' || verification_result === 'SUBGOAL_COMPLETE') {
      return true;
    }

    // If the model's active_subgoal differs from ours (model jumped ahead), sync up
    if (active_subgoal_from_model && this.subgoals.includes(active_subgoal_from_model)) {
      const modelIdx = this.subgoals.indexOf(active_subgoal_from_model);
      if (modelIdx > this.current_subgoal_index) {
        return true;
      }
    }

    return false;
  }

  updateFromModel(modelUnderstanding) {
    if (!modelUnderstanding) return;

    this.intent = modelUnderstanding.intent || this.intent;
    this.secondaryIntent = modelUnderstanding.secondaryIntent || modelUnderstanding.secondary_intent || this.secondaryIntent;
    this.target = modelUnderstanding.target || this.target;
    this.constraints = modelUnderstanding.constraints || this.constraints;
    this.entities = modelUnderstanding.entities || this.entities;
    this.preferences = modelUnderstanding.preferences || this.preferences;
    this.ordering = modelUnderstanding.ordering || this.ordering;
    this.references = modelUnderstanding.references || this.references;
    this.required_actions = modelUnderstanding.required_actions || this.required_actions;
    this.success_criteria = modelUnderstanding.success_criteria || this.success_criteria;
    this.ambiguities = modelUnderstanding.ambiguities || this.ambiguities;
    // Seed subgoals on first update if we have none yet.
    if ((!this.subgoals || !this.subgoals.length) && modelUnderstanding.subgoals) {
      this.subgoals = modelUnderstanding.subgoals;
      this.current_subgoal = this.current_subgoal || this.subgoals[this.current_subgoal_index] || null;
    } else {
      this.subgoals = modelUnderstanding.subgoals || this.subgoals;
    }

    // L7: Handle subgoal progression from model feedback
    const newActiveSubgoal = modelUnderstanding.current_subgoal || modelUnderstanding.active_subgoal;
    if (newActiveSubgoal && this.current_subgoal && newActiveSubgoal !== this.current_subgoal) {
      // Model is reporting a different active subgoal — check if we should advance
      if (this.subgoals.includes(newActiveSubgoal)) {
        const newIdx = this.subgoals.indexOf(newActiveSubgoal);
        if (newIdx > this.current_subgoal_index) {
          // Mark all intermediate subgoals as completed
          for (let i = this.current_subgoal_index; i < newIdx; i++) {
            if (!this.completed_subgoals.includes(this.subgoals[i])) {
              this.completed_subgoals.push(this.subgoals[i]);
            }
          }
          this.current_subgoal_index = newIdx;
        }
      }
      this.current_subgoal = newActiveSubgoal;
    } else if (newActiveSubgoal) {
      this.current_subgoal = newActiveSubgoal;
    }

    this.expected_state = modelUnderstanding.expected_state || modelUnderstanding.expected_final_state || this.expected_state;
    this.confidence = modelUnderstanding.confidence ?? this.confidence;

    this.target_entity = modelUnderstanding.target_entity || this.target_entity;
    this.expected_final_state = modelUnderstanding.expected_final_state || this.expected_state_after_action || this.expected_state;
    this.expected_state_after_action = modelUnderstanding.expected_state_after_action || this.expected_state_after_action;
    this.site = modelUnderstanding.site || this.site;
    this.search_query = modelUnderstanding.search_query || this.search_query;
    this.ranking_constraint = modelUnderstanding.ranking_constraint || this.ranking_constraint;

    // L7: Handle verification_result-based subgoal advancement
    const verResult = modelUnderstanding.verification_result;
    if (verResult && this.shouldAdvanceSubgoal(verResult, newActiveSubgoal)) {
      this.advanceSubgoal();
    }
  }

  toPayload() {
    return {
      goal: this.original_query,
      original_query: this.original_query,
      intent: this.intent,
      secondaryIntent: this.secondaryIntent,
      target: this.target,
      constraints: this.constraints,
      entities: this.entities,
      preferences: this.preferences,
      ordering: this.ordering,
      references: this.references,
      required_actions: this.required_actions,
      success_criteria: this.success_criteria,
      ambiguities: this.ambiguities,
      site: this.site,
      search_query: this.search_query,
      ranking_constraint: this.ranking_constraint,
      subgoals: this.subgoals,
      active_subgoal: this.getActiveSubgoal(),
      current_subgoal_index: this.current_subgoal_index,
      completed_subgoals: this.completed_subgoals,
      expected_state: this.expected_state,
      expected_final_state: this.expected_final_state,
      expected_state_after_action: this.expected_state_after_action,
      confidence: this.confidence
    };
  }
}
