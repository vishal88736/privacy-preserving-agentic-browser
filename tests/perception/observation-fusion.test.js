/**
 * Tests for canonical DOM semantics and separately sourced visual summaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationFusion } from '../../extension/perception/observation-fusion.js';

test('ObservationFusion keeps element grounding DOM-only while carrying real VLM prose separately', () => {
  const fusion = new ObservationFusion();
  const domEl = [{
    id: 'el_1', tag: 'button', label: 'Submit', bbox: [100, 200, 150, 40],
    sensitive: false, is_interactive: true
  }];
  const vlmObs = {
    grounding_source: 'vision_model',
    provenance: 'DOM_PLUS_REAL_VLM',
    detected_elements: [{ visual_id: 'invented-box', label: 'Submit button', bbox: [100, 200, 150, 40], confidence: 0.97 }],
    spatial_layout: 'single button', visual_state: 'ready'
  };
  const fused = fusion.fuse(domEl, vlmObs);
  assert.equal(fused.elements.length, 1);
  const el = fused.elements[0];
  assert.equal(el.id, 'el_1');
  assert.equal(fused.provenance, 'REAL_VLM');
  assert.equal(el.matched_by, 'DOM_ONLY');
  assert.equal(el.visual, null);
  assert.equal(el.provenance, 'DOM');
  assert.equal(el.confidence, null);
});

test('ObservationFusion - DOM element with no VLM match is DOM_ONLY', () => {
  const fusion = new ObservationFusion();
  const domEl = [{ id: 'el_2', tag: 'input', label: 'Search', bbox: [50, 50, 200, 30], sensitive: false, is_interactive: true }];
  const vlmObs = { detected_elements: [], spatial_layout: '', visual_state: '' };
  const fused = fusion.fuse(domEl, vlmObs);
  assert.equal(fused.elements.length, 1);
  assert.equal(fused.elements[0].matched_by, 'DOM_ONLY');
});

test('DOM heuristic annotations are not promoted to fabricated VLM detections', () => {
  const fusion = new ObservationFusion();
  const domEl = [{ id: 'el_1', tag: 'button', label: 'Search', bbox: [10, 20, 80, 30], is_interactive: true }];
  const fused = fusion.fuse(domEl, {
    grounding_source: 'dom_heuristic',
    provenance: 'DOM_PLUS_HEURISTIC',
    detected_elements: [{ visual_id: 'invented', label: 'Search button', bbox: [10, 20, 80, 30], confidence: 0.99 }]
  });

  assert.equal(fused.provenance, 'DOM_PLUS_HEURISTIC');
  assert.equal(fused.elements[0].visual, null);
  assert.equal(fused.elements[0].provenance, 'DOM');
});

test('canonical fused elements retain semantic state and relationship fields', () => {
  const fusion = new ObservationFusion();
  const fused = fusion.fuse([{
    id: 'el_1', tag: 'select', role: 'combobox', accessible_name: 'Country', label: 'Country',
    text: 'Country', context: 'Shipping address', placeholder: 'Choose country', title: 'Country selector',
    type: 'select-one', href: '', bbox: [10, 20, 100, 30], is_visible: true, disabled: false,
    selected: true, selected_option: { index: 1, text: 'India', value: 'in' },
    parent_element_id: 'el_2', child_element_ids: ['el_3'], form_id: 'form_1'
  }], { detected_elements: [] });
  const element = fused.elements[0];

  assert.equal(element.el_id, 'el_1');
  assert.equal(element.accessible_name, 'Country');
  assert.equal(element.nearby_text, 'Shipping address');
  assert.equal(element.selected_option.value, 'in');
  assert.equal(element.parent_element_id, 'el_2');
  assert.deepEqual(element.child_element_ids, ['el_3']);
  assert.equal(element.form_group_id, 'form_1');
  assert.equal(element.enabled, true);
  assert.equal(element.provenance, 'DOM');
});

test('ObservationFusion - fused elements have interaction object', () => {
  const fusion = new ObservationFusion();
  const domEl = [{ id: 'el_3', tag: 'input', label: 'Email', bbox: [10, 10, 200, 30], sensitive: false, is_interactive: true }];
  const fused = fusion.fuse(domEl, { detected_elements: [], spatial_layout: '', visual_state: '' });
  const el = fused.elements[0];
  assert.ok(typeof el.interaction === 'object', 'interaction object must be present');
});

test('ObservationFusion - page metadata is propagated to output', () => {
  const fusion = new ObservationFusion();
  const pageMetadata = { url: 'https://shop.test', title: 'Laptops', viewport: { width: 1280, height: 720 } };
  const fused = fusion.fuse([], { detected_elements: [], spatial_layout: '', visual_state: '' }, pageMetadata);
  assert.equal(fused.page?.url, 'https://shop.test');
  assert.equal(fused.page?.title, 'Laptops');
});

test('ObservationFusion - handles null/undefined vlmVisualObservation gracefully', () => {
  const fusion = new ObservationFusion();
  const domEl = [{ id: 'el_1', tag: 'button', label: 'OK', bbox: [0, 0, 50, 30], sensitive: false, is_interactive: true }];
  assert.doesNotThrow(() => {
    const fused = fusion.fuse(domEl, null);
    assert.ok(fused.elements.length >= 1);
  });
});

test('ObservationFusion - handles empty inputs without throwing', () => {
  const fusion = new ObservationFusion();
  assert.doesNotThrow(() => {
    const fused = fusion.fuse([], { detected_elements: [], spatial_layout: '', visual_state: '' });
    assert.equal(fused.elements.length, 0);
  });
});

test('ObservationFusion - sensitive flag is preserved on fused element', () => {
  const fusion = new ObservationFusion();
  const domEl = [{
    id: 'el_pass', tag: 'input', label: 'Password',
    bbox: [0, 0, 100, 30], sensitive: true, is_interactive: true,
    semantic_type: 'PASSWORD', value_source: 'LOCAL_PASSWORD'
  }];
  const fused = fusion.fuse(domEl, { detected_elements: [], spatial_layout: '', visual_state: '' });
  const el = fused.elements[0];
  assert.equal(el.dom.sensitive, true);
  assert.equal(el.dom.semantic_type, 'PASSWORD');
  assert.equal(el.dom.value_source, 'LOCAL_PASSWORD');
});

test('ObservationFusion - visual_layout_summary and visual_state_summary propagated', () => {
  const fusion = new ObservationFusion();
  const vlmObs = {
    grounding_source: 'vision_model', provenance: 'DOM_PLUS_REAL_VLM',
    detected_elements: [], spatial_layout: 'grid layout', visual_state: 'results loaded'
  };
  const fused = fusion.fuse([], vlmObs);
  assert.equal(fused.visual_layout_summary, 'grid layout');
  assert.equal(fused.visual_state_summary, 'results loaded');
  assert.equal(fused.provenance, 'REAL_VLM');
});

test('ObservationFusion scopes required and empty field counts to individual forms', () => {
  const fusion = new ObservationFusion();
  const fused = fusion.fuse([
    { id: 'header_search', tag: 'input', type: 'search', form_id: 'form_header', value: '', is_interactive: true },
    { id: 'booking_required', tag: 'input', type: 'text', form_id: 'form_booking', required: true, value: '', is_interactive: true },
    { id: 'booking_optional', tag: 'input', type: 'text', form_id: 'form_booking', required: false, value: '', is_interactive: true }
  ], { detected_elements: [] });
  const header = fused.form_state.forms.find((form) => form.form_group_id === 'form_header');
  const booking = fused.form_state.forms.find((form) => form.form_group_id === 'form_booking');
  assert.equal(header.completion.required_empty, 0);
  assert.equal(booking.completion.required_empty, 1);
  assert.equal(booking.completion.optional_empty, 1);
});

test('ObservationFusion evaluates required radio groups without crossing form boundaries', () => {
  const fusion = new ObservationFusion();
  const fused = fusion.fuse([
    { id: 'delivery_home', tag: 'input', type: 'radio', name: 'delivery', form_id: 'form_one', required: true, checked: false, is_interactive: true },
    { id: 'delivery_pickup', tag: 'input', type: 'radio', name: 'delivery', form_id: 'form_one', required: true, checked: true, is_interactive: true },
    { id: 'other_delivery', tag: 'input', type: 'radio', name: 'delivery', form_id: 'form_two', required: true, checked: false, is_interactive: true },
    { id: 'unnamed_selected', tag: 'input', type: 'radio', form_id: 'form_three', required: true, checked: true, is_interactive: true },
    { id: 'unnamed_empty', tag: 'input', type: 'radio', form_id: 'form_three', required: true, checked: false, is_interactive: true }
  ], { detected_elements: [] });
  assert.equal(fused.form_state.forms.find((form) => form.form_group_id === 'form_one').completion.required_empty, 0);
  assert.equal(fused.form_state.forms.find((form) => form.form_group_id === 'form_two').completion.required_empty, 1);
  assert.equal(fused.form_state.forms.find((form) => form.form_group_id === 'form_three').completion.required_empty, 1);
});
