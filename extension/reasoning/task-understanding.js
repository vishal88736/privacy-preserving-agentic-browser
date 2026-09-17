/**
 * Task Understanding & State Machine
 * Maintains the internal semantic representation of the user's task.
 * Includes a local fallback interpreter so a failed /interpret call
 * never blanks the original request.
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
  const budget = lower.match(/(?:under|below|less than|upto|up to|<=|≤)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)\s*(k)?/i);
  if (budget) constraints.push(`price <= ${budget[1].replace(/,/g, '')}${budget[2] ? '000' : ''}`);
  if (/\bfirst\b/.test(lower)) constraints.push('first matching result');

  // L18: Better entity extraction with expanded stop-word filtering
  const entities = text
    .split(/[^A-Za-z0-9₹$]+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 12);

  // L20: Proper multi-step subgoal decomposition
  const subgoals = _buildSubgoals(intent, secondaryIntent, lower, constraints);

  return {
    intent,
    secondaryIntent,
    target: { type: 'page_task', entity: entities[0] || text.slice(0, 40), attributes: {} },
    constraints,
    entities,
    expected_state: `The page reflects: ${text}`,
    subgoals,
    current_subgoal: subgoals[0],
    current_subgoal_index: 0,
    confidence: 0.55
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

    this.expected_state = null;
    this.subgoals = [];
    this.current_subgoal = null;
    this.current_subgoal_index = 0;
    this.completed_subgoals = [];
    this.confidence = 0.0;

    this.expected_state_after_action = null;

    this.site = null;
    this.search_query = null;
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
    this.subgoals = modelUnderstanding.subgoals || this.subgoals;

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
    this.expected_final_state = modelUnderstanding.expected_final_state || this.expected_final_state;
    this.expected_state_after_action = modelUnderstanding.expected_state_after_action || this.expected_state_after_action;
    this.site = modelUnderstanding.site || this.site;
    this.search_query = modelUnderstanding.search_query || this.search_query;

    // L7: Handle verification_result-based subgoal advancement
    const verResult = modelUnderstanding.verification_result;
    if (verResult && this.shouldAdvanceSubgoal(verResult, newActiveSubgoal)) {
      this.advanceSubgoal();
    }
  }

  toPayload() {
    return {
      original_query: this.original_query,
      intent: this.intent,
      secondaryIntent: this.secondaryIntent,
      target: this.target,
      constraints: this.constraints,
      entities: this.entities,
      subgoals: this.subgoals,
      active_subgoal: this.getActiveSubgoal(),
      current_subgoal_index: this.current_subgoal_index,
      completed_subgoals: this.completed_subgoals,
      expected_state: this.expected_state,
      expected_state_after_action: this.expected_state_after_action,
      confidence: this.confidence
    };
  }
}
