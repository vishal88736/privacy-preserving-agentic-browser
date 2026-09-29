/**
 * Per-step state contract for the background agent loop.
 *
 * This is deliberately independent of UI task statuses (PAUSED, WAITING_FOR_USER,
 * etc.). It constrains the observation-to-action lifecycle and records the
 * active phase on the persisted task for diagnostics.
 */

export const AgentLoopState = Object.freeze({
  OBSERVE: 'OBSERVE',
  UNDERSTAND: 'UNDERSTAND',
  GROUND: 'GROUND',
  PLAN: 'PLAN',
  VALIDATE: 'VALIDATE',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  REPLAN: 'REPLAN',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED'
});

const transitions = Object.freeze({
  [AgentLoopState.OBSERVE]: new Set([AgentLoopState.UNDERSTAND, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.UNDERSTAND]: new Set([AgentLoopState.GROUND, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.GROUND]: new Set([AgentLoopState.PLAN, AgentLoopState.VERIFY, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.PLAN]: new Set([AgentLoopState.VALIDATE, AgentLoopState.DONE, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.VALIDATE]: new Set([AgentLoopState.EXECUTE, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.EXECUTE]: new Set([AgentLoopState.VERIFY, AgentLoopState.REPLAN, AgentLoopState.BLOCKED]),
  [AgentLoopState.VERIFY]: new Set([AgentLoopState.REPLAN, AgentLoopState.DONE, AgentLoopState.BLOCKED]),
  [AgentLoopState.REPLAN]: new Set([AgentLoopState.OBSERVE, AgentLoopState.PLAN, AgentLoopState.DONE, AgentLoopState.BLOCKED]),
  [AgentLoopState.DONE]: new Set(),
  [AgentLoopState.BLOCKED]: new Set()
});

export class AgentLoopStateMachine {
  constructor(onTransition = () => {}) {
    this.state = null;
    this.onTransition = onTransition;
    this.observationId = null;
  }

  transition(nextState, detail = null) {
    if (!Object.values(AgentLoopState).includes(nextState)) {
      throw new TypeError(`Unknown agent loop state: ${nextState}`);
    }
    if (this.state === null) {
      if (nextState !== AgentLoopState.OBSERVE) {
        throw new Error('An agent step must begin in OBSERVE.');
      }
    } else if (!transitions[this.state].has(nextState)) {
      throw new Error(`Invalid agent loop transition: ${this.state} -> ${nextState}`);
    }
    this.state = nextState;
    this.onTransition(nextState, detail);
    return nextState;
  }

  bindObservation(observationId) {
    if (this.state !== AgentLoopState.OBSERVE || typeof observationId !== 'string' || !observationId) {
      throw new Error('Only OBSERVE can bind a non-empty observation id.');
    }
    this.observationId = observationId;
    return observationId;
  }

  assertObservation(observationId) {
    if (!this.observationId || observationId !== this.observationId) {
      throw new Error('The action was planned against a stale observation.');
    }
    return true;
  }
}
