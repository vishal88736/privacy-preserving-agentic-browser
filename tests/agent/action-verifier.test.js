import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionVerifier, actionVerificationSummary } from '../../extension/agent/verifier/action-verifier.js';

const before = {
  observation_id: 'snapshot_1',
  page: { url: 'https://example.test/form', title: 'Form' },
  elements: [{ id: 'el_1', tag: 'button', label: 'Continue', visible: true, enabled: true, dom: { value: null } }]
};

test('post-action verifier requires a distinct fresh observation', () => {
  const verifier = new ActionVerifier();
  const missing = verifier.verify({ action: { action: 'CLICK' }, execution: { success: true }, beforeObservation: before, afterObservation: before });
  assert.equal(missing.verified, false);
  assert.equal(missing.status, 'POST_ACTION_OBSERVATION_MISSING');
});

test('post-action verifier records visible page changes after re-observation', () => {
  const verifier = new ActionVerifier();
  const result = verifier.verify({
    action: { action: 'CLICK', targetId: 'el_1' },
    execution: { success: true },
    beforeObservation: before,
    afterObservation: {
      observation_id: 'snapshot_2',
      page: { url: 'https://example.test/complete', title: 'Complete' },
      elements: []
    }
  });
  assert.deepEqual(result, {
    status: 'OBSERVED_STATE_CHANGE',
    verified: true,
    observation_id: 'snapshot_2',
    visible_state_changed: true,
    target_present: false,
    target_state_changed: true
  });
});

test('verification metadata for a form plan contains field IDs but never values', () => {
  const summary = actionVerificationSummary({
    action: 'FILL_FORM_PLAN',
    value: { fields: [
      { field_id: 'el_1', value: 'Jane Doe' },
      { field_id: 'el_2', value: 'jane@example.com' }
    ] }
  });
  assert.deepEqual(summary, { action: 'FILL_FORM_PLAN', targetIds: ['el_1', 'el_2'] });
  assert.doesNotMatch(JSON.stringify(summary), /Jane Doe|jane@example\.com/);
});
