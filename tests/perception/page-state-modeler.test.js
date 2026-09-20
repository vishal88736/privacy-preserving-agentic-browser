/**
 * Tests for PageStateModeler
 * Covers page type inference, candidate element scoring,
 * and result/heading extraction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateModeler } from '../../extension/perception/page-state-modeler.js';

function makeModeler() {
  return new PageStateModeler();
}

// ── Task state stub ────────────────────────────────────────────────────────

function makeTaskState(overrides = {}) {
  return {
    original_query: 'Find cheapest laptop under ₹60,000',
    constraints: ['cheapest', 'price <= 60000'],
    intent: 'SEARCH',
    target_entity: 'laptop',
    subgoals: ['Search for laptops'],
    current_subgoal: 'Search for laptops',
    active_subgoal: 'Search for laptops',
    getActiveSubgoal: () => 'Search for laptops',
    toPayload: () => ({}),
    ...overrides
  };
}

// ── _inferPageType ────────────────────────────────────────────────────────

test('PageStateModeler - infers SEARCH_RESULTS when result_items present', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'flipkart.com', title: 'Laptops', url: 'https://flipkart.com/search?q=laptop' },
    elements: [],
    result_items: [{ id: 'i1', title: 'Laptop A', price_value: 45000 }, { id: 'i2', title: 'Laptop B', price_value: 50000 }],
    headings: [],
    visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'SEARCH_RESULTS');
});

test('PageStateModeler - infers SEARCH_RESULTS when URL has ?q=', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'google.com', title: 'Google Search', url: 'https://www.google.com/search?q=laptop' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'SEARCH_RESULTS');
});

test('PageStateModeler - infers LOGIN when URL has "login"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'accounts.google.com', title: 'Sign in', url: 'https://accounts.google.com/login' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'LOGIN');
});

test('PageStateModeler - infers REGISTRATION when URL has "signup"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'site.com', title: 'Create Account', url: 'https://site.com/signup' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'REGISTRATION');
});

test('PageStateModeler - infers CHECKOUT when URL has "checkout"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'shop.com', title: 'Checkout', url: 'https://shop.com/checkout/payment' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'CHECKOUT');
});

test('PageStateModeler - infers FORM when title contains "application"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'gov.in', title: 'KYC Application Form', url: 'https://gov.in/apply' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'FORM');
});

test('PageStateModeler - infers FORM when there are more than 3 inputs', () => {
  const m = makeModeler();
  const inputs = Array.from({ length: 5 }, (_, i) => ({
    id: `el_${i}`, role: 'input',
    dom: { tag: 'input', label: `Field ${i}` },
    interaction: { typeable: true, clickable: true }
  }));
  const fused = {
    page: { domain: 'site.com', title: 'My Page', url: 'https://site.com/page' },
    elements: inputs, result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'FORM');
});

test('PageStateModeler - infers VIDEO_PAGE when URL has "watch"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'youtube.com', title: 'Watch: Amazing Video', url: 'https://www.youtube.com/watch?v=abc123' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'VIDEO_PAGE');
});

test('PageStateModeler - infers SETTINGS when URL has "settings"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'app.com', title: 'Account Settings', url: 'https://app.com/settings/profile' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'SETTINGS');
});

test('PageStateModeler - infers PRODUCT_DETAIL when URL has "product"', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'shop.com', title: 'Laptop Model X', url: 'https://shop.com/product/laptop-x-12345' },
    elements: [], result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.equal(state.page_type, 'PRODUCT_DETAIL');
});

// ── modelPageState output structure ───────────────────────────────────────

test('PageStateModeler - modelPageState returns expected keys', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'test.com', title: 'Test', url: 'https://test.com' },
    elements: [], result_items: [], headings: [{ text: 'Hello World' }], visible_text: 'Hello World'
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.ok('page_type' in state);
  assert.ok('domain' in state);
  assert.ok('title' in state);
  assert.ok('url' in state);
  assert.ok('summary' in state);
  assert.ok('headings' in state);
  assert.ok('result_sets' in state);
  assert.ok('ranked_candidates' in state);
  assert.ok('resolved_references' in state);
  assert.ok('detected_form' in state);
  assert.ok('scroll' in state);
});

test('PageStateModeler - extracts headings correctly', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'test.com', title: 'T', url: 'https://test.com' },
    elements: [], result_items: [],
    headings: [{ text: 'Heading One' }, { text: 'Heading Two' }],
    visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.deepEqual(state.headings, ['Heading One', 'Heading Two']);
});

test('PageStateModeler - visible_text_excerpt is truncated to 1200 chars', () => {
  const m = makeModeler();
  const fused = {
    page: { domain: 'test.com', title: 'T', url: 'https://test.com' },
    elements: [], result_items: [], headings: [],
    visible_text: 'x'.repeat(5000)
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.ok(state.visible_text_excerpt.length <= 1200);
});

test('PageStateModeler - candidate elements include interactive elements only', () => {
  const m = makeModeler();
  const elements = [
    { id: 'el_btn', role: 'button', dom: { tag: 'button', label: 'Click Me' }, interaction: { clickable: true } },
    { id: 'el_div', role: 'div', dom: { tag: 'div', label: 'Just a div' }, interaction: {} }
  ];
  const fused = {
    page: { domain: 'test.com', title: 'T', url: 'https://test.com' },
    elements, result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  const ids = state.elements.map(e => e.element_id);
  assert.ok(ids.includes('el_btn'), 'Clickable button must be in candidates');
  assert.ok(!ids.includes('el_div'), 'Non-interactive div must NOT be in candidates');
});

test('PageStateModeler - summary string includes element counts', () => {
  const m = makeModeler();
  const elements = [
    { id: 'el_1', dom: { tag: 'input' }, interaction: { typeable: true } },
    { id: 'el_2', dom: { tag: 'button', label: 'Submit' }, interaction: { clickable: true } }
  ];
  const fused = {
    page: { domain: 'test.com', title: 'T', url: 'https://test.com' },
    elements, result_items: [], headings: [], visible_text: ''
  };
  const state = m.modelPageState(fused, makeTaskState());
  assert.ok(typeof state.summary === 'string');
  assert.ok(state.summary.includes('input') || state.summary.includes('1'));
});

test('PageStateModeler - handles missing/null page gracefully', () => {
  const m = makeModeler();
  assert.doesNotThrow(() => {
    const state = m.modelPageState({ elements: [], result_items: [], headings: [], visible_text: '' }, makeTaskState());
    assert.ok('domain' in state);
  });
});
