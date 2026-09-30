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

test('post-action verifier detects page text changes even when controls are unchanged', () => {
  const verifier = new ActionVerifier();
  const result = verifier.verify({
    action: { action: 'CLICK', target: { element_id: 'el_1' } },
    execution: { success: true },
    beforeObservation: { ...before, visible_text: 'Choose a delivery method.' },
    afterObservation: {
      ...before,
      observation_id: 'snapshot_2',
      visible_text: 'Your order is confirmed.'
    }
  });
  assert.equal(result.visible_state_changed, true);
  assert.equal(result.status, 'OBSERVED_STATE_CHANGE');
});

test('post-action verifier recognizes native media starting when DOM and text are unchanged', () => {
  const verifier = new ActionVerifier();
  const beforeObservation = {
    ...before,
    local_media_state: {
      visible_count: 1,
      media: [{ ordinal: 0, tag: 'video', paused: true, ended: false, ready_state: 2 }]
    }
  };
  const result = verifier.verify({
    action: { action: 'CLICK', targetId: 'el_1' },
    execution: { success: true },
    beforeObservation,
    afterObservation: {
      ...beforeObservation,
      observation_id: 'snapshot_2',
      local_media_state: {
        visible_count: 1,
        media: [{ ordinal: 0, tag: 'video', paused: false, ended: false, ready_state: 4 }]
      }
    }
  });

  assert.equal(result.verified, true);
  assert.equal(result.visible_state_changed, true);
  assert.equal(result.status, 'OBSERVED_STATE_CHANGE');
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

// ── Redacted fields must still register as progress ────────────────────────
//
// The regression: for every field the sanitizer treats as sensitive, `value`
// is the identical '[REDACTED]' marker before and after a successful TYPE.
// Comparing it reported "no visible change" for a fill that demonstrably
// worked, so after three filled PII fields the no-progress breaker aborted
// the task mid-form. `has_value` is the extractor's privacy-safe filled bit.

const redactedField = (value, hasValue) => ({
  observation_id: null,
  page: { url: 'https://example.test/form', title: 'Form' },
  elements: [{
    id: 'el_1',
    tag: 'input',
    type: 'email',
    label: 'Email address',
    visible: true,
    enabled: true,
    dom: { value, has_value: hasValue, sensitive: true }
  }]
});

test('a successful TYPE into a redacted field counts as a visible change', () => {
  const verifier = new ActionVerifier();
  const result = verifier.verify({
    action: { action: 'TYPE', targetId: 'el_1' },
    execution: { success: true },
    beforeObservation: { ...redactedField('[REDACTED]', false), observation_id: 'snapshot_1' },
    afterObservation: { ...redactedField('[REDACTED]', true), observation_id: 'snapshot_2' }
  });

  assert.equal(result.verified, true);
  assert.equal(result.status, 'OBSERVED_STATE_CHANGE');
  assert.equal(result.visible_state_changed, true,
    'a filled redacted field is progress even though the marker is unchanged');
  assert.equal(result.target_state_changed, true);
});

test('an unfilled redacted field still reports no change', () => {
  const verifier = new ActionVerifier();
  const result = verifier.verify({
    action: { action: 'TYPE', targetId: 'el_1' },
    execution: { success: true },
    beforeObservation: { ...redactedField('[REDACTED]', false), observation_id: 'snapshot_1' },
    afterObservation: { ...redactedField('[REDACTED]', false), observation_id: 'snapshot_2' }
  });

  assert.equal(result.status, 'OBSERVED_NO_VISIBLE_CHANGE');
  assert.equal(result.visible_state_changed, false);
});

test('the filled bit is compared as a boolean, never a value', () => {
  // has_value is the extractor's strict "control holds something" flag. The
  // verifier must not read a value or a length out of it, because a length is
  // itself identifying for some fields.
  const verifier = new ActionVerifier();
  const result = verifier.verify({
    action: { action: 'TYPE', targetId: 'el_1' },
    execution: { success: true },
    beforeObservation: { ...redactedField('[REDACTED]', false), observation_id: 'snapshot_1' },
    afterObservation: { ...redactedField('[REDACTED]', true), observation_id: 'snapshot_2' }
  });
  assert.equal(result.visible_state_changed, true);
  assert.equal(JSON.stringify(result).includes('E2E'), false,
    'the verification summary must not carry a field value');
});
