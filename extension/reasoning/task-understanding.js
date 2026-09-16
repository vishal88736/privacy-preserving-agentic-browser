/**
 * Task Understanding & State Machine
 * Maintains the internal semantic representation of the user's task.
 * Includes a local fallback interpreter so a failed /interpret call
 * never blanks the original request.
 */

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'please']);

export function localInterpretTask(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  const lower = text.toLowerCase();
  let intent = 'ACT';
  if (/upload/.test(lower)) intent = 'UPLOAD';
  else if (/fill|form|application|aadhaar|kyc/.test(lower)) intent = 'FILL_FORM';
  else if (/search|find|cheapest|lowest|look for/.test(lower)) intent = 'SEARCH';
  else if (/play|watch|video/.test(lower)) intent = 'PLAY';
  else if (/open|go to|navigate|visit/.test(lower)) intent = 'NAVIGATE';
  else if (/click|select|choose/.test(lower)) intent = 'CLICK';
  else if (/extract|what is|tell me|price of/.test(lower)) intent = 'EXTRACT';

  const constraints = [];
  if (/cheap|lowest/.test(lower)) constraints.push('cheapest');
  if (/latest|newest/.test(lower)) constraints.push('latest');
  const budget = lower.match(/(?:under|below|less than|upto|up to)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)\s*(k)?/i);
  if (budget) constraints.push(`price <= ${budget[1]}${budget[2] ? '000' : ''}`);
  if (/\bfirst\b/.test(lower)) constraints.push('first matching result');

  const entities = text
    .split(/[^A-Za-z0-9₹]+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 12);

  const subgoals = [];
  if (intent === 'SEARCH' || /find|search/.test(lower)) subgoals.push('search for the requested item');
  if (/open|click|first|result/.test(lower)) subgoals.push('open the matching result');
  if (intent === 'FILL_FORM') subgoals.push('fill required fields from local profile');
  if (intent === 'UPLOAD') subgoals.push('attach the local document');
  if (!subgoals.length) subgoals.push('accomplish the user request');

  return {
    intent,
    target: { type: 'page_task', entity: entities[0] || text.slice(0, 40), attributes: {} },
    constraints,
    entities,
    expected_state: `The page reflects: ${text}`,
    subgoals,
    current_subgoal: subgoals[0],
    confidence: 0.55
  };
}

export class TaskState {
  constructor(rawPrompt) {
    this.original_query = rawPrompt || '';

    this.intent = 'unknown';
    this.target = null;
    this.constraints = [];
    this.entities = [];

    this.expected_state = null;
    this.subgoals = [];
    this.current_subgoal = null;
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
    return this.current_subgoal || this.subgoals?.[0] || this.original_query || 'accomplish task';
  }

  isCompleted() {
    return this.intent === 'done';
  }

  updateFromModel(modelUnderstanding) {
    if (!modelUnderstanding) return;

    this.intent = modelUnderstanding.intent || this.intent;
    this.target = modelUnderstanding.target || this.target;
    this.constraints = modelUnderstanding.constraints || this.constraints;
    this.entities = modelUnderstanding.entities || this.entities;
    this.subgoals = modelUnderstanding.subgoals || this.subgoals;
    this.current_subgoal = modelUnderstanding.current_subgoal || modelUnderstanding.active_subgoal || this.current_subgoal;
    this.expected_state = modelUnderstanding.expected_state || modelUnderstanding.expected_final_state || this.expected_state;
    this.confidence = modelUnderstanding.confidence ?? this.confidence;

    this.target_entity = modelUnderstanding.target_entity || this.target_entity;
    this.expected_final_state = modelUnderstanding.expected_final_state || this.expected_final_state;
    this.expected_state_after_action = modelUnderstanding.expected_state_after_action || this.expected_state_after_action;
    this.site = modelUnderstanding.site || this.site;
    this.search_query = modelUnderstanding.search_query || this.search_query;
  }

  toPayload() {
    return {
      original_query: this.original_query,
      intent: this.intent,
      target: this.target,
      constraints: this.constraints,
      entities: this.entities,
      subgoals: this.subgoals,
      active_subgoal: this.getActiveSubgoal(),
      completed_subgoals: this.completed_subgoals,
      expected_state: this.expected_state,
      expected_state_after_action: this.expected_state_after_action,
      confidence: this.confidence
    };
  }
}
