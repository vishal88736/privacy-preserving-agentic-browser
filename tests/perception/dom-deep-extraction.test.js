import test from 'node:test';
import assert from 'node:assert';
import { DOMExtractor } from '../../extension/content/dom-extractor.js';
import { PageStabilityObserver } from '../../extension/content/dom-observer.js';
import { VLMClient } from '../../extension/perception/vlm-client.js';

test('DOMExtractor - queryAllDeep pierces open Shadow DOM roots', () => {
  const extractor = new DOMExtractor();

  // Create a mock DOM hierarchy with a shadow root
  const shadowHost = {
    shadowRoot: {
      querySelectorAll: (sel) => {
        if (sel.includes('button')) {
          return [{ tagName: 'BUTTON', innerText: 'Inside Shadow Root', getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 30 }) }];
        }
        return [];
      }
    }
  };

  const mockRoot = {
    querySelectorAll: (sel) => {
      if (sel === '*') return [shadowHost];
      if (sel.includes('input')) {
        return [{ tagName: 'INPUT', type: 'text', getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 30 }) }];
      }
      return [];
    }
  };

  const buttons = extractor.queryAllDeep('button', mockRoot);
  assert.strictEqual(buttons.length, 1);
  assert.strictEqual(buttons[0].innerText, 'Inside Shadow Root');

  const inputs = extractor.queryAllDeep('input', mockRoot);
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].tagName, 'INPUT');
});

test('PageStabilityObserver - default fast debounce and markAction', async () => {
  const observer = new PageStabilityObserver();
  assert.ok(typeof observer.waitForStability === 'function');
  assert.ok(typeof observer.markAction === 'function');

  // markAction should update lastMutationTime
  const prev = observer.lastMutationTime;
  observer.markAction();
  assert.ok(observer.lastMutationTime >= prev);

  // Fast stability wait completes quickly when quiet
  const start = Date.now();
  const stable = await observer.waitForStability(50, 500);
  const elapsed = Date.now() - start;
  assert.strictEqual(stable, true);
  assert.ok(elapsed < 200, `Expected fast resolve under 200ms, took ${elapsed}ms`);
});

test('VLMClient - processVisuals fastPath skips remote server call', async () => {
  const client = new VLMClient('http://127.0.0.1:9999'); // Non-existent remote server
  const sanitizedDom = {
    title: 'Test Portal',
    elements: [
      { id: 'el_1', tag: 'input', label: 'Search query', sensitive: false, bbox: [10, 20, 100, 30] },
      { id: 'el_2', tag: 'button', label: 'Submit Search', sensitive: false, bbox: [120, 20, 80, 30] }
    ]
  };

  // With fastPath: true, it should resolve immediately via local inference without network error
  const res = await client.processVisuals('task_123', 'data:image/png;base64,...', sanitizedDom, {}, { fastPath: true });
  assert.strictEqual(res._source, 'DOM_ONLY');
  assert.deepEqual(res.detected_elements, []);
});
