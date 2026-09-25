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

test('agent DOM fast path skips screenshot capture and redaction', async () => {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  let captureCalls = 0;
  let redactionCalls = 0;
  let visionArgs;

  globalThis.chrome = {
    tabs: { get: async () => ({ id: 7, url: 'https://example.test/', windowId: 3 }) }
  };
  taskManager.settings = { ...DEFAULT_SETTINGS, fastMode: true };
  const task = taskManager.createTask('Click the Search button', 7);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));

  restore.push(replaceMethod(defaultScreenshotService, 'captureTab', async () => {
    captureCalls++;
    throw new Error('screenshot capture should be skipped');
  }));
  restore.push(replaceMethod(defaultScreenshotSanitizer, 'redactScreenshot', async () => {
    redactionCalls++;
    throw new Error('screenshot redaction should be skipped');
  }));
  restore.push(replaceMethod(defaultVLMClient, 'processVisuals', async (...args) => {
    visionArgs = args;
    return { _source: 'DOM_ONLY', detected_elements: [], page_type: 'unknown' };
  }));
  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async () => ({
    thought: 'Done for fast-path test',
    action: { action: 'DONE', risk: 'LOW', requires_confirmation: false },
    isTerminal: true,
    remoteCallMade: false
  })));

  const controller = new AgentController();
  controller.notify = () => {};
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._extractDOM = async () => ({
    success: true,
    data: {
      url: 'https://example.test/',
      title: 'Search',
      viewport: { width: 1280, height: 800 },
      elements: [
        { id: 'el_1', tag: 'button', type: 'button', label: 'Search', value: '', bbox: [10, 10, 80, 30] },
        { id: 'el_2', tag: 'input', type: 'search', label: 'Search field', value: '', bbox: [10, 50, 200, 30] }
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
    assert.equal(captureCalls, 0);
    assert.equal(redactionCalls, 0);
    assert.equal(visionArgs[1], null);
    assert.equal(visionArgs[4].fastPath, true);
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
