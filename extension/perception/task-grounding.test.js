import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskGrounding } from './task-grounding.js';
import { localInterpretTask } from '../reasoning/task-understanding.js';
import { PromptBuilder } from '../reasoning/prompt-builder.js';

test('localInterpret extracts search + cheapest + first', () => {
  const u = localInterpretTask('Find the cheapest laptop under ₹60,000 and open the first suitable result.');
  assert.equal(u.intent, 'SEARCH');
  assert.ok(u.constraints.some((c) => /cheap/i.test(c)));
  assert.ok(u.subgoals.length >= 1);
});

test('grounds cheapest matching result to a real element', () => {
  const fused = {
    elements: [
      { id: 'el_1', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Home', context: 'nav' } },
      { id: 'el_10', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Acer Aspire', context: 'Acer Aspire 8GB ₹72,000', price_value: 72000 } },
      { id: 'el_11', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Lenovo IdeaPad', context: 'Lenovo IdeaPad 8GB ₹45,990', price_value: 45990 } },
      { id: 'el_12', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'HP 15s', context: 'HP 15s 16GB ₹58,490', price_value: 58490 } },
      { id: 'el_3', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'search', label: 'Search', placeholder: 'Search laptops' } }
    ],
    result_items: [
      { id: 'item_1', title: 'Acer Aspire', price_text: '₹72,000', price_value: 72000, primary_action_id: 'el_10' },
      { id: 'item_2', title: 'Lenovo IdeaPad', price_text: '₹45,990', price_value: 45990, primary_action_id: 'el_11' },
      { id: 'item_3', title: 'HP 15s', price_text: '₹58,490', price_value: 58490, primary_action_id: 'el_12' }
    ]
  };
  const taskState = {
    original_query: 'Find the cheapest laptop under ₹60,000 and open the first suitable result.',
    constraints: ['cheapest', 'price <= 60000', 'first matching result']
  };
  const g = new TaskGrounding().ground(taskState, fused);
  assert.equal(g.budget, 60000);
  assert.equal(g.optimization, 'min_price');
  assert.equal(g.resolved_references.cheapest, 'el_11');
  assert.equal(g.resolved_references.first_suitable, 'el_11');
  assert.equal(g.resolved_references.selected_item.price_value, 45990);
  assert.ok(!g.result_sets.some((r) => r.price_value > 60000));
  assert.ok(g.ranked_candidates.some((c) => c.element_id === 'el_3'));
});

test('compact observation only lists real ids and result sets', () => {
  const fused = {
    page: { domain: 'shop.test', title: 'Laptops' },
    visual_layout_summary: 'grid',
    visual_state_summary: 'results',
    headings: [{ text: 'Laptops' }],
    visible_text: 'Lenovo IdeaPad 45990',
    form_state: {},
    elements: [
      { id: 'el_11', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Lenovo IdeaPad', context: '₹45,990' } },
      { id: 'el_99', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Cookie settings' } }
    ]
  };
  const pageState = {
    ranked_candidates: [{ element_id: 'el_11', score: 9, label: 'Lenovo IdeaPad' }],
    result_sets: [{ id: 'item_2', title: 'Lenovo IdeaPad', price_value: 45990, element_id: 'el_11' }],
    resolved_references: { cheapest: 'el_11' }
  };
  const compact = new PromptBuilder().compactObservation(fused, pageState);
  assert.ok(compact.elements.some((e) => e.id === 'el_11'));
  assert.equal(compact.resolved_references.cheapest, 'el_11');
  assert.equal(compact.result_sets[0].element_id, 'el_11');
});
