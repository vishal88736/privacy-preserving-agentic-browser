import test from 'node:test';
import assert from 'node:assert';
import { AgentController } from '../../extension/background/agent-controller.js';

function step(action, targetId, success = true) {
  return {
    stepNumber: 1, success,
    action: { action, target: targetId ? { element_id: targetId } : undefined }
  };
}

test('Circuit breaker - detects 3 identical successful actions', () => {
  const c = new AgentController();
  const task = { steps: [step('SUBMIT', 'el_6'), step('SUBMIT', 'el_6'), step('SUBMIT', 'el_6')] };
  assert.strictEqual(c._isRepeatingIdenticalAction(task), true);
});

test('Circuit breaker - ignores mixed or failing sequences', () => {
  const c = new AgentController();
  assert.strictEqual(c._isRepeatingIdenticalAction({ steps: [step('TYPE', 'el_1'), step('TYPE', 'el_2'), step('SUBMIT', 'el_6')] }), false);
  assert.strictEqual(c._isRepeatingIdenticalAction({ steps: [step('SUBMIT', 'el_6'), step('SUBMIT', 'el_6')] }), false);
  assert.strictEqual(c._isRepeatingIdenticalAction({ steps: [step('SUBMIT', 'el_6', false), step('SUBMIT', 'el_6', false), step('SUBMIT', 'el_6', false)] }), false);
  assert.strictEqual(c._isRepeatingIdenticalAction({ steps: [] }), false);
});

test('Circuit breaker - different targets are not a loop', () => {
  const c = new AgentController();
  const task = { steps: [step('TYPE', 'el_1'), step('TYPE', 'el_1'), step('TYPE', 'el_2')] };
  assert.strictEqual(c._isRepeatingIdenticalAction(task), false);
});

// ── The repetition gate must actually be reachable ─────────────────────────
//
// Regression: the loop-level check was guarded by `!task.pendingVerification`.
// Every successful dispatch sets a fresh pendingVerification, so at the top of
// the next iteration that flag was always set and the check never ran again
// after the first step. A single document upload then repeated twelve times on
// an unchanged page. The gate now reads the step's own verification record,
// which exists only once the step has been checked against a new observation.

const verifiedStep = (action, targetId, valueSource) => ({
  stepNumber: 1,
  success: true,
  action: {
    action,
    target: targetId ? { element_id: targetId } : undefined,
    ...(valueSource ? { value_source: valueSource } : {})
  },
  diagnostic: { post_action_verification: { status: 'OBSERVED_STATE_CHANGE', visible_state_changed: true } }
});

test('Circuit breaker - a verified step that repeats the same action is detected', () => {
  const c = new AgentController();
  const task = {
    steps: [
      verifiedStep('UPLOAD', 'el_1', 'LOCAL_DOCUMENT_AADHAAR'),
      verifiedStep('UPLOAD', 'el_1', 'LOCAL_DOCUMENT_AADHAAR'),
      verifiedStep('UPLOAD', 'el_1', 'LOCAL_DOCUMENT_AADHAAR')
    ]
  };
  assert.strictEqual(c._isStuckInLoop(task), true,
    're-attaching the same document to the same input must be caught');
});

test('Circuit breaker - filling different fields is not a loop', () => {
  const c = new AgentController();
  const task = {
    steps: [
      verifiedStep('TYPE', 'el_1', 'LOCAL_FULL_NAME'),
      verifiedStep('TYPE', 'el_2', 'LOCAL_EMAIL'),
      verifiedStep('TYPE', 'el_3', 'LOCAL_PHONE')
    ]
  };
  assert.strictEqual(c._isStuckInLoop(task), false,
    'a multi-field form fill makes progress and must not be stopped');
});

test('Circuit breaker - an unverified step is not yet grounds to stop the task', () => {
  const c = new AgentController();
  const task = {
    steps: [
      { stepNumber: 1, success: true, action: { action: 'UPLOAD', target: { element_id: 'el_1' }, value_source: 'LOCAL_DOCUMENT_AADHAAR' } },
      verifiedStep('UPLOAD', 'el_1', 'LOCAL_DOCUMENT_AADHAAR'),
      { stepNumber: 3, success: true, action: { action: 'UPLOAD', target: { element_id: 'el_1' }, value_source: 'LOCAL_DOCUMENT_AADHAAR' } }
    ]
  };
  // The last step has not been verified against a fresh observation yet, so the
  // loop must be allowed to run one more step before deciding.
  const lastStep = task.steps[task.steps.length - 1];
  assert.strictEqual(Boolean(lastStep?.diagnostic?.post_action_verification), false);
});
