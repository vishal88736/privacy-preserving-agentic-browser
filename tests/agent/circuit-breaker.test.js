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
