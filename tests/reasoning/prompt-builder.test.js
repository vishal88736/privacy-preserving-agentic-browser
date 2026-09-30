/**
 * Tests for PromptBuilder
 * Covers compactElements, compactObservation, and its security/content checks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptBuilder } from '../../extension/reasoning/prompt-builder.js';
import { ActionType, SymbolicSecretSource } from '../../extension/shared/constants.js';

function makeBuilder() {
  return new PromptBuilder();
}

// ── Test fixtures ─────────────────────────────────────────────────────────

function makeElements(extra = []) {
  return [
    { id: 'el_1', role: 'input', dom: { tag: 'input', type: 'search', label: 'Search', placeholder: 'Search products' }, interaction: { typeable: true } },
    { id: 'el_2', role: 'button', dom: { tag: 'button', label: 'Search' }, interaction: { clickable: true } },
    { id: 'el_3', role: 'a', dom: { tag: 'a', label: 'Lenovo Laptop', context: 'Lenovo IdeaPad ₹45,990', price_value: 45990, href: '/lenovo' }, interaction: { clickable: true } },
    ...extra
  ];
}

function makePageState(extra = {}) {
  return {
    ranked_candidates: [{ element_id: 'el_3', score: 9, label: 'Lenovo Laptop' }],
    resolved_references: { cheapest: 'el_3' },
    result_sets: [{ id: 'item_1', title: 'Lenovo', price_value: 45990, element_id: 'el_3' }],
    ...extra
  };
}

function makeObs(elements = makeElements(), extra = {}) {
  return {
    page: { domain: 'shop.test', title: 'Laptops', scroll: null },
    visual_layout_summary: 'grid layout',
    visual_state_summary: 'results loaded',
    headings: [{ text: 'Laptops For You' }],
    visible_text: 'Lenovo IdeaPad 45990',
    form_state: { completion: { empty: 0 } },
    elements,
    result_items: [],
    ...extra
  };
}

// ── compactElements ────────────────────────────────────────────────────────

test('PromptBuilder - compactElements keeps ranked candidates', () => {
  const b = makeBuilder();
  const pageState = makePageState();
  const obs = makeObs();
  const compact = b.compactElements(obs, pageState);
  assert.ok(compact.some(e => e.id === 'el_3'), 'Ranked element must be included');
});

test('PromptBuilder - compactElements keeps typeable inputs', () => {
  const b = makeBuilder();
  const compact = b.compactElements(makeObs(), {});
  assert.ok(compact.some(e => e.id === 'el_1'), 'Typeable input must always be included');
});

test('PromptBuilder - compactElements keeps submit buttons', () => {
  const b = makeBuilder();
  const elements = [
    ...makeElements(),
    { id: 'el_submit', role: 'button', dom: { tag: 'button', type: 'submit', in_form: true, label: 'Submit' }, interaction: { clickable: true } }
  ];
  const compact = b.compactElements(makeObs(elements), {});
  assert.ok(compact.some(e => e.id === 'el_submit'), 'Submit button must be kept');
});

test('PromptBuilder - compactElements includes mustKeep resolved references', () => {
  const b = makeBuilder();
  const pageState = { ranked_candidates: [], resolved_references: { selected: 'el_3' }, result_sets: [] };
  const compact = b.compactElements(makeObs(), pageState);
  assert.ok(compact.some(e => e.id === 'el_3'), 'Resolved reference element must be kept');
});

test('PromptBuilder - compactElements output shape has required fields', () => {
  const b = makeBuilder();
  const compact = b.compactElements(makeObs(), makePageState());
  assert.ok(compact.length > 0);
  const el = compact[0];
  assert.ok('id' in el);
  assert.ok('role' in el);
  assert.ok('label' in el);
  assert.ok('clickable' in el);
  assert.ok('typeable' in el);
  assert.ok('disabled' in el);
});

test('PromptBuilder - compactElements caps at 40 elements max', () => {
  const b = makeBuilder();
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `el_${i}`, role: 'a',
    dom: { tag: 'a', label: `Link ${i}` },
    interaction: { clickable: true }
  }));
  const compact = b.compactElements(makeObs(many), {});
  assert.ok(compact.length <= 40, 'Must cap at 40 elements');
});

// ── compactObservation ────────────────────────────────────────────────────

test('PromptBuilder - compactObservation returns page domain/title', () => {
  const b = makeBuilder();
  const obs = makeObs();
  const result = b.compactObservation(obs, makePageState());
  assert.equal(result.page.domain, 'shop.test');
  assert.equal(result.page.title, 'Laptops');
});

test('PromptBuilder - compactObservation includes resolved_references', () => {
  const b = makeBuilder();
  const result = b.compactObservation(makeObs(), makePageState());
  assert.equal(result.resolved_references.cheapest, 'el_3');
});

test('PromptBuilder - compactObservation includes result_sets', () => {
  const b = makeBuilder();
  const result = b.compactObservation(makeObs(), makePageState());
  assert.ok(Array.isArray(result.result_sets));
  assert.equal(result.result_sets[0].element_id, 'el_3');
});

test('PromptBuilder - local media verification state is not serialized to the server', () => {
  const b = makeBuilder();
  const result = b.compactObservation(makeObs(makeElements(), {
    local_media_state: {
      visible_count: 1,
      media: [{ ordinal: 0, tag: 'video', paused: false, ended: false, ready_state: 4 }]
    }
  }), makePageState());

  assert.equal(Object.hasOwn(result, 'local_media_state'), false);
  assert.doesNotMatch(JSON.stringify(result), /local_media_state|ready_state/);
});

test('PromptBuilder - compactObservation truncates visible_text to 1200 chars', () => {
  const b = makeBuilder();
  const longText = 'x'.repeat(5000);
  const obs = makeObs(makeElements(), { visible_text: longText });
  const result = b.compactObservation(obs, {});
  assert.ok(result.visible_text.length <= 1200, 'visible_text must be truncated to 1200 chars');
});

// ── Select options must reach the planner ──────────────────────────────────
//
// The regression: the planner's contract is "SELECT uses a value that matches a
// known option for the observed element; if options are missing, do not guess".
// The option list never reached the payload, so no dropdown on any page could be
// planned and the model had to ask the user to choose instead.

const selectElement = (options) => ({
  id: 'el_5',
  role: 'select',
  dom: { tag: 'select', type: 'select-one', label: 'Country', value: '', has_value: false, options },
  interaction: { typeable: false, clickable: true }
});

test('PromptBuilder - a select carries its options so a value can be chosen', () => {
  const b = makeBuilder();
  const obs = makeObs(makeElements([selectElement([
    { text: 'Choose...', value: '', selected: true },
    { text: 'India', value: 'IN', selected: false },
    { text: 'United States', value: 'US', selected: false }
  ])]));
  const compact = b.compactElements(obs, makePageState());
  const select = compact.find((e) => e.id === 'el_5');
  assert.ok(select, 'the select must be included');
  assert.ok(Array.isArray(select.options), 'the options must be present');
  assert.deepEqual(select.options.map((o) => o.value), ['', 'IN', 'US']);
});

test('PromptBuilder - a long option list is capped', () => {
  const b = makeBuilder();
  const many = Array.from({ length: 500 }, (_, i) => ({ text: `Option ${i}`, value: `v${i}` }));
  const obs = makeObs(makeElements([selectElement(many)]));
  const compact = b.compactElements(obs, makePageState());
  assert.equal(compact.find((e) => e.id === 'el_5').options.length, 40);
});

test('PromptBuilder - a plain input gets no options field', () => {
  const b = makeBuilder();
  const compact = b.compactElements(makeObs(), makePageState());
  assert.equal(compact.find((e) => e.id === 'el_1').options, undefined);
});
