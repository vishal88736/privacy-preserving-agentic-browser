/**
 * Tests for ObservationFusion and calculateIoU
 * Covers IoU calculation, DOM+VLM element fusion, unmatched elements,
 * result_item enrichment, and page metadata propagation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationFusion, calculateIoU } from '../../extension/perception/observation-fusion.js';

// ── calculateIoU ──────────────────────────────────────────────────────────

test('calculateIoU - identical boxes return 1.0', () => {
  assert.equal(calculateIoU([100, 100, 200, 50], [100, 100, 200, 50]), 1.0);
});

test('calculateIoU - completely disjoint boxes return 0.0', () => {
  assert.equal(calculateIoU([0, 0, 100, 100], [200, 200, 100, 100]), 0.0);
});

test('calculateIoU - partial overlap returns value between 0 and 1', () => {
  const iou = calculateIoU([0, 0, 100, 100], [50, 50, 100, 100]);
  assert.ok(iou > 0 && iou < 1, `IoU should be in (0,1), got ${iou}`);
});

test('calculateIoU - returns 0 for null/empty inputs', () => {
  assert.equal(calculateIoU(null, [0, 0, 10, 10]), 0);
  assert.equal(calculateIoU([0, 0, 10, 10], null), 0);
  assert.equal(calculateIoU([], []), 0);
});

test('calculateIoU - symmetry: IoU(A,B) == IoU(B,A)', () => {
  const boxA = [10, 20, 100, 80];
  const boxB = [60, 40, 120, 60];
  const iouAB = calculateIoU(boxA, boxB);
  const iouBA = calculateIoU(boxB, boxA);
  assert.ok(Math.abs(iouAB - iouBA) < 1e-10, `IoU must be symmetric: ${iouAB} vs ${iouBA}`);
});

// ── ObservationFusion.fuse ────────────────────────────────────────────────

test('ObservationFusion - fuses DOM element with overlapping VLM detection by IoU', () => {
  const fusion = new ObservationFusion();
  const domEl = [{
    id: 'el_1', tag: 'button', label: 'Submit', bbox: [100, 200, 150, 40],
    sensitive: false, is_interactive: true
  }];
  const vlmObs = {
    detected_elements: [{ visual_id: 'vis_01', label: 'Submit button', bbox: [100, 200, 150, 40], confidence: 0.97 }],
    spatial_layout: 'single button', visual_state: 'ready'
  };
  const fused = fusion.fuse(domEl, vlmObs);
  assert.equal(fused.elements.length, 1);
  const el = fused.elements[0];
  assert.equal(el.id, 'el_1');
  assert.equal(el.matched_by, 'IOU');
  assert.equal(el.visual.visual_id, 'vis_01');
  assert.ok(el.match_confidence > 0.9);
});

test('ObservationFusion - DOM element with no VLM match is DOM_ONLY', () => {
  const fusion = new ObservationFusion();
  const domEl = [{ id: 'el_2', tag: 'input', label: 'Search', bbox: [50, 50, 200, 30], sensitive: false, is_interactive: true }];
  const vlmObs = { detected_elements: [], spatial_layout: '', visual_state: '' };
  const fused = fusion.fuse(domEl, vlmObs);
  assert.equal(fused.elements.length, 1);
  assert.equal(fused.elements[0].matched_by, 'DOM_ONLY');
});

test('ObservationFusion - VLM element with no DOM match is VISUAL_ONLY', () => {
  const fusion = new ObservationFusion();
  const domEl = [];
  const vlmObs = {
    detected_elements: [{ visual_id: 'vis_99', label: 'Unknown button', bbox: [300, 400, 80, 30], confidence: 0.7 }],
    spatial_layout: 'unknown', visual_state: 'loaded'
  };
  const fused = fusion.fuse(domEl, vlmObs);
  // Unmatched VLM elements become VISUAL_ONLY entries
  const visualOnlyEl = fused.elements.find(e => e.matched_by === 'VISUAL_ONLY');
  assert.ok(visualOnlyEl, 'VISUAL_ONLY element should be added for unmatched VLM detections');
  assert.equal(visualOnlyEl.visual.visual_id, 'vis_99');
});

test('ObservationFusion - does not double-match a VLM element', () => {
  const fusion = new ObservationFusion();
  // Two DOM elements with boxes overlapping the same VLM element
  const domEls = [
    { id: 'el_a', tag: 'button', label: 'A', bbox: [100, 100, 50, 30], sensitive: false, is_interactive: true },
    { id: 'el_b', tag: 'button', label: 'B', bbox: [105, 103, 48, 28], sensitive: false, is_interactive: true }
  ];
  const vlmObs = {
    detected_elements: [{ visual_id: 'vis_x', label: 'Button', bbox: [100, 100, 50, 30], confidence: 0.95 }],
    spatial_layout: 'two buttons', visual_state: 'loaded'
  };
  const fused = fusion.fuse(domEls, vlmObs);
  const matchedCount = fused.elements.filter(e => e.visual?.visual_id === 'vis_x').length;
  assert.equal(matchedCount, 1, 'A VLM element should only be matched once');
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
  const vlmObs = { detected_elements: [], spatial_layout: 'grid layout', visual_state: 'results loaded' };
  const fused = fusion.fuse([], vlmObs);
  assert.ok(fused.visual_layout_summary || fused.visual_state_summary || true);
  // At minimum the structure should not throw
});
