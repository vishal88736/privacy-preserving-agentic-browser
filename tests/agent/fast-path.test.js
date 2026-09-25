import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../extension/background/agent-controller.js';
import { taskManager, DEFAULT_SETTINGS } from '../../extension/background/task-manager.js';
import { defaultScreenshotService } from '../../extension/perception/screenshot.js';
import { defaultScreenshotSanitizer } from '../../extension/privacy/screenshot-sanitizer.js';
import { defaultVLMClient } from '../../extension/perception/vlm-client.js';
import { defaultGPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { TaskState, localInterpretTask } from '../../extension/reasoning/task-understanding.js';

function replaceMethod(target, name, value) {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  target[name] = value;
  return () => {
    if (hadOwn) target[name] = previous;
    else delete target[name];
  };
}

test('agent sends a locally sanitized screenshot to the VLM on every observation', async () => {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  let captureCalls = 0;
  let redactionCalls = 0;
  let visionArgs;
  const rawScreenshot = 'data:image/png;base64,RAW';
  const safeScreenshot = 'data:image/webp;base64,SAFE';

  globalThis.chrome = {
    tabs: { get: async () => ({ id: 7, url: 'https://example.test/', windowId: 3 }) }
  };
  taskManager.settings = { ...DEFAULT_SETTINGS, fastMode: true };
  const task = taskManager.createTask('Click the Search button', 7);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));

  restore.push(replaceMethod(defaultScreenshotService, 'captureTab', async (windowId) => {
    captureCalls++;
    assert.equal(windowId, 3);
    return { dataUrl: rawScreenshot, timestamp: 1 };
  }));
  restore.push(replaceMethod(defaultScreenshotSanitizer, 'redactScreenshot', async (image, elements, viewport, audit) => {
    redactionCalls++;
    assert.equal(image, rawScreenshot);
    assert.ok(elements.some((element) => element.sensitive));
    assert.deepEqual(viewport, { width: 1280, height: 800 });
    assert.equal(audit.coverageEstablished, true);
    assert.equal(audit.maskedCount, 2);
    return safeScreenshot;
  }));
  restore.push(replaceMethod(defaultVLMClient, 'processVisuals', async (...args) => {
    visionArgs = args;
    return { _source: 'DOM_PLUS_REAL_VLM', detected_elements: [], page_type: 'search' };
  }));
  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async () => ({
    thought: 'Done for mandatory VLM test',
    action: { action: 'DONE', risk: 'LOW', requires_confirmation: false },
    isTerminal: true,
    remoteCallMade: false
  })));

  const controller = new AgentController();
  controller.notify = () => {};
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._analyzeScreenshotLocally = async () => ({
    completed: true,
    safeToTransmitAfterRedaction: true,
    unlocatedSensitiveCategories: [],
    objectDetections: [],
    people: [],
    piiRegions: [{ bbox: [10, 90, 200, 30], category: 'PASSWORD' }],
    piiCategories: ['PASSWORD'],
    unableToLocateSensitiveText: false,
    imageWidth: 1280,
    imageHeight: 800,
    model: 'Xenova/yolos-tiny',
    modelRevision: 'test',
    modelLoadMs: 10,
    inferenceMs: 20,
    totalMs: 30,
    assetBytes: 5000000,
    heapUsedBytes: null
  });
  controller._extractDOM = async () => ({
    success: true,
    data: {
      url: 'https://example.test/',
      title: 'Search',
      viewport: { width: 1280, height: 800 },
      elements: [
        { id: 'el_1', tag: 'button', type: 'button', label: 'Search', value: '', bbox: [10, 10, 80, 30] },
        { id: 'el_2', tag: 'input', type: 'search', label: 'Search field', value: '', bbox: [10, 50, 200, 30] },
        { id: 'el_3', tag: 'input', type: 'password', label: 'Password', value: 'local-secret', bbox: [10, 90, 200, 30] }
      ],
      headings: [],
      result_items: [],
      visible_text: 'Search page',
      scroll: { x: 0, y: 0 }
    }
  });

  try {
    const shouldContinue = await controller.runSingleStep(task);
    assert.equal(shouldContinue, false);
    assert.equal(captureCalls, 1);
    assert.equal(redactionCalls, 1);
    assert.equal(visionArgs[1], safeScreenshot);
    assert.equal(visionArgs[2].elements.some((element) => element.value === 'local-secret'), false);
    assert.equal(visionArgs.length, 4);
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
