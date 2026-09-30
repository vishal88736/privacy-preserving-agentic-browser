import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController, unmetRequiredFields } from '../../extension/background/agent-controller.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { ActionType, RiskLevel } from '../../extension/shared/constants.js';

test('AgentController has no local form-plan builder or DONE guard', () => {
  const controller = new AgentController();
  assert.equal(AgentController.length, 0);
  assert.equal('formPlanBuilder' in controller, false);
  assert.equal('_guardProfileFormCompletion' in controller, false);
});

test('remote DONE passes through unchanged even when form fields remain blank', async () => {
  const originalFetch = globalThis.fetch;
  const action = { action: ActionType.DONE, risk: RiskLevel.LOW, requires_confirmation: false };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ action: { ...action }, final_response: 'The requested task is complete.' }) });
  try {
    const client = new GPTOSSClient('http://backend.test');
    const result = await client.planNextStep(
      'Fill this form using my saved profile, but do not submit it.',
      { elements: [{ id: 'el_terms', dom: { tag: 'input', type: 'checkbox', label: 'Agree to terms', checked: false } }] },
      []
    );
    assert.deepEqual(result.action, action);
    assert.equal(result.final_response, 'The requested task is complete.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── A fill task may not claim DONE over a visibly unfilled form ───────────

function fillTask(intent = 'FILL_FORM') {
  return {
    state: 'EXECUTING',
    prompt: 'fill the form with my details',
    taskState: { intent, required_actions: [], constraints: [] },
    steps: []
  };
}

function formObservation(fieldStates) {
  const labels = { el_1: 'Name', el_2: 'Phone number', el_3: 'date of birth' };
  return {
    elements: Object.keys(labels).map((id) => ({ id, dom: { label: labels[id] } })),
    form_state: {
      fields: Object.entries(fieldStates).map(([id, state]) => ({
        id, state, required: id !== 'el_3', semantic_type: 'X'
      }))
    }
  };
}

test('required fields that are still empty block a claimed completion', () => {
  // The planner sees sanitized counts and reported COMPLETED while "Phone
  // number" sat empty on the page. The claim is re-checked locally.
  const unmet = unmetRequiredFields(fillTask(), formObservation({
    el_1: 'FILLED', el_2: 'EMPTY', el_3: 'EMPTY'
  }));
  assert.deepEqual(unmet, ['Phone number']);
});

test('an empty OPTIONAL field does not block completion', () => {
  const unmet = unmetRequiredFields(fillTask(), formObservation({
    el_1: 'FILLED', el_2: 'FILLED', el_3: 'EMPTY'
  }));
  assert.deepEqual(unmet, []);
});

test('a fully filled form reports nothing unmet', () => {
  const unmet = unmetRequiredFields(fillTask(), formObservation({
    el_1: 'FILLED', el_2: 'FILLED', el_3: 'FILLED'
  }));
  assert.deepEqual(unmet, []);
});

test('the completion check applies only to fill tasks', () => {
  // A PLAY/SEARCH task on a page that happens to contain a form must not be
  // blocked by that form's empty fields.
  const observation = formObservation({ el_1: 'EMPTY', el_2: 'EMPTY', el_3: 'EMPTY' });
  assert.deepEqual(unmetRequiredFields(fillTask('PLAY'), observation), []);
  assert.deepEqual(unmetRequiredFields(fillTask('SEARCH'), observation), []);
  assert.ok(unmetRequiredFields(fillTask('FILL_FORM'), observation).length > 0);
});

test('a page with no form fields is never treated as unmet', () => {
  assert.deepEqual(unmetRequiredFields(fillTask(), { elements: [], form_state: { fields: [] } }), []);
});
