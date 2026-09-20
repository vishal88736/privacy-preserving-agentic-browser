/**
 * Tests for ActionValidator
 * Covers pre-execution validation: target checks, form state,
 * element availability, disabled state, and semantic subgoal alignment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionValidator } from '../../extension/executor/action-validator.js';
import { ActionType } from '../../extension/shared/constants.js';

function makeValidator() {
  return new ActionValidator();
}

// Helpers
function makeObs(elements = [], result_items = [], form_state = {}) {
  return { elements, result_items, form_state };
}

// ── TARGET_OPTIONAL_ACTIONS — always valid ────────────────────────────────

test('ActionValidator - DONE requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.DONE }, makeObs());
  assert.equal(r.valid, true);
});

test('ActionValidator - WAIT requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.WAIT }, makeObs());
  assert.equal(r.valid, true);
});

test('ActionValidator - NAVIGATE requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.NAVIGATE, target: { url: 'https://x.com' } }, makeObs());
  assert.equal(r.valid, true);
});

test('ActionValidator - SCROLL requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.SCROLL }, makeObs());
  assert.equal(r.valid, true);
});

test('ActionValidator - PRESS_KEY requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.PRESS_KEY, value: 'Enter' }, makeObs());
  assert.equal(r.valid, true);
});

test('ActionValidator - FILL_FORM_PLAN requires no target', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.FILL_FORM_PLAN, value: { fields: [] } }, makeObs());
  assert.equal(r.valid, true);
});

// ── Missing target ────────────────────────────────────────────────────────

test('ActionValidator - CLICK without target is invalid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.CLICK }, makeObs());
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('requires a target element'));
});

test('ActionValidator - TYPE without target is invalid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution({ action: ActionType.TYPE, value: 'hello' }, makeObs());
  assert.equal(r.valid, false);
});

// ── Placeholder/stale element ID ─────────────────────────────────────────

test('ActionValidator - element_id "el_xxx" is rejected as placeholder', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { element_id: 'el_xxx' } },
    makeObs([{ id: 'el_xxx', dom: {}, interaction: { clickable: true } }])
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not a real page element id'));
});

test('ActionValidator - element not in current DOM is stale', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { element_id: 'el_99' } },
    makeObs([{ id: 'el_1', dom: {}, interaction: { clickable: true } }])
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('no longer present'));
});

// ── Disabled element ──────────────────────────────────────────────────────

test('ActionValidator - clicking a disabled element is invalid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { element_id: 'el_5' } },
    makeObs([{ id: 'el_5', dom: { disabled: true }, interaction: { clickable: true } }])
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('disabled'));
});

// ── TYPE-specific validations ────────────────────────────────────────────

test('ActionValidator - TYPE into non-typeable element is invalid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.TYPE, target: { element_id: 'el_btn' }, value: 'text' },
    makeObs([{ id: 'el_btn', dom: { tag: 'button' }, interaction: { clickable: true, typeable: false } }])
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not a typeable'));
});

test('ActionValidator - TYPE into typeable field with same value is invalid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.TYPE, target: { element_id: 'el_input' }, value: 'Pune' },
    makeObs([{ id: 'el_input', dom: { tag: 'input', value: 'Pune' }, interaction: { typeable: true } }])
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('already contains'));
});

test('ActionValidator - TYPE into typeable field with different value is valid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.TYPE, target: { element_id: 'el_input' }, value: 'Delhi' },
    makeObs([{ id: 'el_input', dom: { tag: 'input', value: 'Pune' }, interaction: { typeable: true } }])
  );
  assert.equal(r.valid, true);
});

test('ActionValidator - TYPE with value_source bypasses same-value check', () => {
  const v = makeValidator();
  // Same text value but value_source means it is a resolved secret — should be allowed
  const r = v.validatePreExecution(
    { action: ActionType.TYPE, target: { element_id: 'el_input' }, value: 'ABCDE1234F', value_source: 'LOCAL_PAN' },
    makeObs([{ id: 'el_input', dom: { tag: 'input', value: 'ABCDE1234F' }, interaction: { typeable: true } }])
  );
  assert.equal(r.valid, true);
});

// ── SUBMIT — form completion guard ────────────────────────────────────────

test('ActionValidator - SUBMIT with unfilled fields is rejected', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.SUBMIT, target: { element_id: 'el_submit' } },
    makeObs(
      [{ id: 'el_submit', dom: { tag: 'button', type: 'submit' }, interaction: { clickable: true } }],
      [],
      { completion: { empty: 2 } }
    )
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('unfilled'));
});

test('ActionValidator - SUBMIT with all fields filled is valid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.SUBMIT, target: { element_id: 'el_submit' } },
    makeObs(
      [{ id: 'el_submit', dom: { tag: 'button', type: 'submit' }, interaction: { clickable: true } }],
      [],
      { completion: { empty: 0 } }
    )
  );
  assert.equal(r.valid, true);
});

// ── item_ id resolution ───────────────────────────────────────────────────

test('ActionValidator - CLICK on item_ id resolves to primary_action_id', () => {
  const v = makeValidator();
  const obs = makeObs(
    [{ id: 'el_10', dom: { tag: 'a', label: 'Lenovo Laptop' }, interaction: { clickable: true } }],
    [{ id: 'item_1', title: 'Lenovo Laptop', primary_action_id: 'el_10' }]
  );
  const action = { action: ActionType.CLICK, target: { element_id: 'item_1' } };
  const r = v.validatePreExecution(action, obs);
  assert.equal(r.valid, true);
  // The action target should be rewritten to the real element id
  assert.equal(action.target.element_id, 'el_10');
});

// ── Coordinate-based target ───────────────────────────────────────────────

test('ActionValidator - CLICK with coordinates (no element_id) is valid', () => {
  const v = makeValidator();
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { coordinates: { x: 300, y: 200 } } },
    makeObs()
  );
  assert.equal(r.valid, true);
});

// ── Semantic subgoal alignment ────────────────────────────────────────────

test('ActionValidator - rejects player control click when active subgoal is search', () => {
  const v = makeValidator();
  const taskState = {
    getActiveSubgoal: () => 'Search for cheapest laptop'
  };
  const obs = makeObs([
    { id: 'el_play', dom: { tag: 'button', label: 'Play' }, interaction: { clickable: true } },
    { id: 'el_search', dom: { tag: 'input', id: 'search', label: 'Search', placeholder: 'Search' }, interaction: { typeable: true } }
  ]);
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { element_id: 'el_play', label: 'Play' } },
    obs,
    taskState
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('does not advance active subgoal'));
});

test('ActionValidator - standard CLICK on search element passes semantic check', () => {
  const v = makeValidator();
  const taskState = { getActiveSubgoal: () => 'Search for cheapest laptop' };
  const obs = makeObs([
    { id: 'el_search_btn', dom: { tag: 'button', label: 'Search' }, interaction: { clickable: true } }
  ]);
  const r = v.validatePreExecution(
    { action: ActionType.CLICK, target: { element_id: 'el_search_btn', label: 'Search' } },
    obs,
    taskState
  );
  assert.equal(r.valid, true);
});
