/**
 * Tests for PromptBuilder
 * Covers compactElements, compactObservation, _scrollContext,
 * and buildPlanningPrompt security/content checks.
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

test('PromptBuilder - compactObservation truncates visible_text to 1200 chars', () => {
  const b = makeBuilder();
  const longText = 'x'.repeat(5000);
  const obs = makeObs(makeElements(), { visible_text: longText });
  const result = b.compactObservation(obs, {});
  assert.ok(result.visible_text.length <= 1200, 'visible_text must be truncated to 1200 chars');
});

// ── _scrollContext ────────────────────────────────────────────────────────

test('PromptBuilder - _scrollContext: returns unknown when null', () => {
  const b = makeBuilder();
  const r = b._scrollContext(null);
  assert.ok(r.toLowerCase().includes('unknown'));
});

test('PromptBuilder - _scrollContext: says "at the top" when y=0', () => {
  const b = makeBuilder();
  const r = b._scrollContext({ y: 0, maxY: 3000 });
  assert.ok(r.includes('top'));
});

test('PromptBuilder - _scrollContext: says "bottom" when scrolled to end', () => {
  const b = makeBuilder();
  const r = b._scrollContext({ y: 3000, maxY: 3000 });
  assert.ok(r.includes('bottom') || r.includes('%'));
});

test('PromptBuilder - _scrollContext: no scrollable content case', () => {
  const b = makeBuilder();
  const r = b._scrollContext({ y: 0, maxY: 0 });
  assert.ok(r.includes('fully visible') || r.includes('no scrollable'));
});

// ── buildPlanningPrompt ────────────────────────────────────────────────────

test('PromptBuilder - buildPlanningPrompt returns a string', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Find cheapest laptop', makeObs(), [], null, makePageState());
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 100);
});

test('PromptBuilder - buildPlanningPrompt contains user task', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Find cheapest laptop', makeObs(), [], null, makePageState());
  assert.ok(prompt.includes('Find cheapest laptop'), 'Prompt must include the user task');
});

test('PromptBuilder - buildPlanningPrompt lists allowed action types', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test', makeObs(), [], null, null);
  assert.ok(prompt.includes(ActionType.CLICK), 'Prompt must list CLICK as allowed action');
  assert.ok(prompt.includes(ActionType.TYPE), 'Prompt must list TYPE as allowed action');
  assert.ok(prompt.includes(ActionType.DONE), 'Prompt must list DONE as allowed action');
});

test('PromptBuilder - buildPlanningPrompt contains allowed element IDs only', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test', makeObs(), [], null, makePageState());
  // The prompt should contain the allowed IDs, not a free-form list
  assert.ok(prompt.includes('el_1') || prompt.includes('el_2') || prompt.includes('el_3'));
});

test('PromptBuilder - buildPlanningPrompt includes privacy/security policy header', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test task', makeObs(), [], null, null);
  assert.ok(prompt.includes('NEVER output plaintext secrets') || prompt.includes('SECURITY'), 'Prompt must include privacy policy');
});

test('PromptBuilder - buildPlanningPrompt includes symbolic token reference (L21)', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test task', makeObs(), [], null, null);
  assert.ok(prompt.includes('LOCAL_AADHAAR'), 'Prompt must include LOCAL_AADHAAR symbolic token reference');
  assert.ok(prompt.includes('LOCAL_PAN'), 'Prompt must include LOCAL_PAN symbolic token reference');
});

test('PromptBuilder - buildPlanningPrompt wraps webpage content in untrusted tags', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test task', makeObs(), [], null, null);
  assert.ok(prompt.includes('<untrusted_webpage_content>'), 'Must quarantine untrusted content');
  assert.ok(prompt.includes('</untrusted_webpage_content>'));
});

test('PromptBuilder - buildPlanningPrompt includes task history (last 5 steps)', () => {
  const b = makeBuilder();
  const history = [
    { step: 1, action: { action: 'TYPE' }, success: true },
    { step: 2, action: { action: 'CLICK' }, success: true }
  ];
  const prompt = b.buildPlanningPrompt('Test', makeObs(), history, null, null);
  assert.ok(prompt.includes('TASK HISTORY') || prompt.includes('history'), 'Prompt must include task history');
});

test('PromptBuilder - buildPlanningPrompt contains JSON output format hint', () => {
  const b = makeBuilder();
  const prompt = b.buildPlanningPrompt('Test', makeObs(), [], null, null);
  assert.ok(prompt.includes('"thought"'), 'Prompt must include thought field in output format');
  assert.ok(prompt.includes('"action"'), 'Prompt must include action field in output format');
});
