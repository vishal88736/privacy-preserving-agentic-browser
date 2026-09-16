import test from 'node:test';
import assert from 'node:assert';
import { ElementRegistry } from '../../extension/content/element-registry.js';

test('ElementRegistry - Lookups survive re-extraction (clear + re-register same nodes)', () => {
  // Regression test (found live): clear() used to reset idToElement but NOT
  // the elementToId WeakMap, so after a second extraction every lookup
  // returned null and only the FIRST agent action per page could execute.
  const registry = new ElementRegistry();

  const nameInput = { fake: 'name-node' };
  const aadhaarInput = { fake: 'aadhaar-node' };

  // First extraction cycle
  const id1 = registry.register(nameInput);
  const id2 = registry.register(aadhaarInput);
  assert.strictEqual(id1, 'el_1');
  assert.strictEqual(id2, 'el_2');
  assert.strictEqual(registry.getElement('el_1'), nameInput);
  assert.strictEqual(registry.getElement('el_2'), aadhaarInput);

  // Second extraction cycle (same DOM nodes, e.g. after typing into el_1)
  registry.clear();
  const id1b = registry.register(nameInput);
  const id2b = registry.register(aadhaarInput);
  assert.strictEqual(id1b, 'el_1', 'Stable ids across extractions');
  assert.strictEqual(id2b, 'el_2', 'Stable ids across extractions');
  assert.strictEqual(registry.getElement('el_1'), nameInput, 'Lookup must work after re-extraction');
  assert.strictEqual(registry.getElement('el_2'), aadhaarInput, 'Lookup must work after re-extraction');

  // Unknown ids still miss
  assert.strictEqual(registry.getElement('el_99'), null);
});
