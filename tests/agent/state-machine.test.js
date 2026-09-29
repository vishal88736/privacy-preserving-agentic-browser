import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoopState, AgentLoopStateMachine } from '../../extension/agent/state-machine.js';

test('the observation-to-action lifecycle follows explicit states and re-observes before replanning', () => {
  const seen = [];
  const machine = new AgentLoopStateMachine((state) => seen.push(state));
  machine.transition(AgentLoopState.OBSERVE);
  machine.bindObservation('snapshot_a');
  machine.transition(AgentLoopState.UNDERSTAND);
  machine.transition(AgentLoopState.GROUND);
  machine.transition(AgentLoopState.PLAN);
  machine.transition(AgentLoopState.VALIDATE);
  machine.transition(AgentLoopState.EXECUTE);
  machine.transition(AgentLoopState.VERIFY);
  machine.transition(AgentLoopState.REPLAN);
  machine.transition(AgentLoopState.OBSERVE);
  machine.bindObservation('snapshot_b');

  assert.deepEqual(seen, [
    'OBSERVE', 'UNDERSTAND', 'GROUND', 'PLAN', 'VALIDATE', 'EXECUTE', 'VERIFY', 'REPLAN', 'OBSERVE'
  ]);
  assert.equal(machine.assertObservation('snapshot_b'), true);
  assert.throws(() => machine.assertObservation('snapshot_a'), /stale observation/i);
});

test('terminal states and invalid transitions fail closed', () => {
  const machine = new AgentLoopStateMachine();
  assert.throws(() => machine.transition(AgentLoopState.PLAN), /begin in OBSERVE/i);
  machine.transition(AgentLoopState.OBSERVE);
  assert.throws(() => machine.transition(AgentLoopState.EXECUTE), /Invalid agent loop transition/i);
  machine.transition(AgentLoopState.BLOCKED);
  assert.throws(() => machine.transition(AgentLoopState.OBSERVE), /Invalid agent loop transition/i);
});

test('a fresh observation can verify the prior action before replanning', () => {
  const machine = new AgentLoopStateMachine();
  machine.transition(AgentLoopState.OBSERVE);
  machine.bindObservation('snapshot_after_action');
  machine.transition(AgentLoopState.UNDERSTAND);
  machine.transition(AgentLoopState.GROUND);
  machine.transition(AgentLoopState.VERIFY);
  machine.transition(AgentLoopState.REPLAN);
  machine.transition(AgentLoopState.PLAN);
  assert.equal(machine.state, AgentLoopState.PLAN);
});
