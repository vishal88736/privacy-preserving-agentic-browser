/**
 * Task Understanding & State Machine
 * Maintains the internal semantic representation of the user's task.
 */

export class TaskState {
  constructor(rawPrompt) {
    this.original_query = rawPrompt || '';
    
    // Semantic fields
    this.intent = 'unknown';
    this.target = null; // { type, entity, attributes }
    this.constraints = [];
    this.entities = [];
    
    this.expected_state = null;
    this.subgoals = [];
    this.current_subgoal = null;
    this.completed_subgoals = [];
    this.confidence = 0.0;
    
    this.expected_state_after_action = null; 
    
    // Legacy support fields for UI mapping if needed
    this.site = null;
    this.search_query = null;
  }

  getActiveSubgoal() {
    return this.current_subgoal || 'accomplish task';
  }

  isCompleted() {
    return this.intent === 'done';
  }

  /**
   * Syncs the local state with the model's task understanding
   */
  updateFromModel(modelUnderstanding) {
    if (!modelUnderstanding) return;
    
    // Map interpretTask schema
    this.intent = modelUnderstanding.intent || this.intent;
    this.target = modelUnderstanding.target || this.target;
    this.constraints = modelUnderstanding.constraints || this.constraints;
    this.entities = modelUnderstanding.entities || this.entities;
    this.subgoals = modelUnderstanding.subgoals || this.subgoals;
    this.current_subgoal = modelUnderstanding.current_subgoal || this.current_subgoal;
    this.expected_state = modelUnderstanding.expected_state || this.expected_state;
    this.confidence = modelUnderstanding.confidence ?? this.confidence;
    
    // Also map legacy fields or step-by-step updates
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
