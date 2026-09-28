import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../extension/background/agent-controller.js';
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
