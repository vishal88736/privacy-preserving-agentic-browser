import test from 'node:test';
import assert from 'node:assert';
import { ObservationFusion, calculateIoU } from '../../extension/perception/observation-fusion.js';
import { ActionParser } from '../../extension/reasoning/action-parser.js';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { ActionType, SymbolicSecretSource } from '../../extension/shared/constants.js';

test('ObservationFusion - Computes IoU and matches DOM elements with VLM detections', () => {
  // Overlapping bounding boxes: [x, y, w, h]
  const box1 = [100, 100, 200, 50];
  const box2 = [100, 100, 200, 50]; // Identical -> IoU = 1.0
  assert.strictEqual(calculateIoU(box1, box2), 1.0);

  const box3 = [400, 400, 100, 100]; // Disjoint -> IoU = 0.0
  assert.strictEqual(calculateIoU(box1, box3), 0.0);

  const fusion = new ObservationFusion();
  const sanitizedDom = [
    {
      id: 'el_1',
      tag: 'button',
      label: 'Submit Application',
      bbox: [100, 200, 150, 40],
      sensitive: false,
      is_interactive: true
    }
  ];

  const visualObservation = {
    detected_elements: [
      {
        visual_id: 'vis_01',
        label: 'Primary Submit Button',
        bbox: [102, 201, 148, 39], // Near match
        confidence: 0.98
      }
    ],
    spatial_layout: 'One primary action button at center',
    visual_state: 'Ready'
  };

  const fused = fusion.fuse(sanitizedDom, visualObservation);

  assert.strictEqual(fused.elements.length, 1);
  const fusedEl = fused.elements[0];
  assert.strictEqual(fusedEl.id, 'el_1');
  assert.strictEqual(fusedEl.matched_by, 'IOU');
  assert.strictEqual(fusedEl.visual.visual_id, 'vis_01');
  assert.ok(fusedEl.match_confidence > 0.85);
});

test('ActionParser - Parses clean JSON and strips markdown fences', () => {
  const parser = new ActionParser();

  // Test standard code fence
  const rawWithFence = '```json\n{"action": "CLICK", "target": {"element_id": "el_1", "label": "Search"}}\n```';
  const parsed = parser.parse(rawWithFence);

  assert.strictEqual(parsed.action.action, ActionType.CLICK);
  assert.strictEqual(parsed.action.target.element_id, 'el_1');

  // Test response with preamble thoughts
  const rawWithThought = 'Here is the step:\n{"thought": "Entering city name", "action": {"action": "TYPE", "target": {"element_id": "el_origin"}, "value": "Pune"}}';
  const parsedThought = parser.parse(rawWithThought);

  assert.strictEqual(parsedThought.thought, 'Entering city name');
  assert.strictEqual(parsedThought.action.action, ActionType.TYPE);
  assert.strictEqual(parsedThought.action.value, 'Pune');
});

test('LocalValueResolver - Safely maps symbolic tokens to vault secrets locally', () => {
  const vault = new LocalVault();
  vault.memoryStore.LOCAL_AADHAAR = 'SYNTHETIC_AADHAAR_FIXTURE';
  const resolver = new LocalValueResolver(vault);

  // Resolving symbolic Aadhaar
  const aadhaarAction = {
    action: ActionType.TYPE,
    target: { element_id: 'el_aadhaar' },
    value_source: SymbolicSecretSource.LOCAL_AADHAAR
  };

  const resolvedAadhaar = resolver.resolve(aadhaarAction);
  assert.strictEqual(resolvedAadhaar, 'SYNTHETIC_AADHAAR_FIXTURE', 'Must resolve explicitly configured test fixture');

  // Non-sensitive action passes through regular value
  const searchAction = {
    action: ActionType.TYPE,
    target: { element_id: 'el_search' },
    value: 'Pune to Delhi'
  };
  assert.strictEqual(resolver.resolve(searchAction), 'Pune to Delhi');
});
