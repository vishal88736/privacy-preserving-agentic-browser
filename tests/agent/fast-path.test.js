import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../extension/background/agent-controller.js';
import { taskManager, DEFAULT_SETTINGS } from '../../extension/background/task-manager.js';
import { defaultScreenshotService } from '../../extension/perception/screenshot.js';
import { defaultScreenshotSanitizer } from '../../extension/privacy/screenshot-sanitizer.js';
import { defaultVLMClient } from '../../extension/perception/vlm-client.js';
import { defaultGPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { defaultActionExecutor } from '../../extension/executor/action-executor.js';
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

test('agent skips screenshot work when the sanitized DOM is sufficient', async () => {
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
      snapshot_id: 'snapshot_fast_path',
      mutation_revision: 0,
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
    assert.equal(captureCalls, 0);
    assert.equal(redactionCalls, 0);
    assert.equal(visionArgs, undefined);
    assert.equal(task.lastLLMPayload.screenshotStatus, 'skipped');
    assert.equal(task.lastLLMPayload.sampleElements[2].value, '[REDACTED]');
    assert.equal(task.agentLoopState, 'DONE');
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('controller re-observes and verifies a page change before planning the next action', async () => {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  const pageTitles = ['Continue page', 'Complete page'];
  let extractionIndex = 0;
  let planningIndex = 0;
  const executionContexts = [];

  globalThis.chrome = {
    tabs: { get: async () => ({ id: 8, url: 'https://example.test/form', windowId: 1 }) }
  };
  taskManager.settings = { ...DEFAULT_SETTINGS, alwaysConfirm: false };
  const task = taskManager.createTask('Click Continue', 8);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));

  restore.push(replaceMethod(defaultActionExecutor, 'execute', async (_tabId, action, observationContext) => {
    executionContexts.push(observationContext);
    return action.action === 'DONE' ? { success: true, isTerminal: true } : { success: true };
  }));
  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async () => {
    planningIndex++;
    return planningIndex === 1
      ? { thought: 'Click the observed Continue button.', action: { action: 'CLICK', target: { element_id: 'el_1' } } }
      : { thought: 'The page reached its completion state.', action: { action: 'DONE' }, final_response: 'Complete.' };
  }));

  const controller = new AgentController();
  controller.notify = () => {};
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._extractDOM = async () => {
    const title = pageTitles[extractionIndex];
    const snapshot = `snapshot_${++extractionIndex}`;
    return {
      success: true,
      data: {
        snapshot_id: snapshot,
        mutation_revision: 0,
        url: extractionIndex === 1 ? 'https://example.test/form' : 'https://example.test/complete',
        title,
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'el_1', tag: 'button', type: 'button', label: extractionIndex === 1 ? 'Continue' : 'Start over', value: '', bbox: [10, 10, 100, 30] },
          { id: 'el_2', tag: 'button', type: 'button', label: 'Help', value: '', bbox: [10, 50, 60, 30] },
          { id: 'el_3', tag: 'a', type: 'link', label: 'Home', value: '', href: '/', bbox: [10, 90, 60, 30] }
        ],
        headings: [], result_items: [],
        visible_text: 'A stable test page with enough visible content for DOM-first observation. '.repeat(4),
        scroll: { x: 0, y: 0 }
      }
    };
  };

  try {
    assert.equal(await controller.runSingleStep(task), true);
    assert.equal(task.pendingVerification?.stepNumber, 1);
    assert.equal(await controller.runSingleStep(task), false);
    assert.ok(extractionIndex >= 2, 'a fresh DOM observation must follow the dispatched click');
    assert.equal(executionContexts[0].snapshotId, 'snapshot_1');
    assert.equal(task.steps[0].diagnostic.post_action_verification.status, 'OBSERVED_STATE_CHANGE');
    assert.equal(task.lastVerification.visible_state_changed, true);
    assert.equal(task.agentLoopState, 'DONE');
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('controller sends no-change verification into the next planning call', async () => {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  let extractionIndex = 0;
  let planningIndex = 0;
  let verificationSeenByPlanner = null;

  globalThis.chrome = {
    tabs: { get: async () => ({ id: 9, url: 'https://example.test/form', windowId: 1 }) }
  };
  taskManager.settings = { ...DEFAULT_SETTINGS, fastMode: true, alwaysConfirm: false };
  const task = taskManager.createTask('Click Apply', 9);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));

  restore.push(replaceMethod(defaultActionExecutor, 'execute', async () => ({ success: true })));
  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async (_task, _observation, history) => {
    planningIndex++;
    if (planningIndex === 1) {
      // Element ids must use the content script's registry format (`el_<n>`).
      // The sanitizer reduces any other id to safe words, so a page-authored
      // id like "el_apply" would never survive to the grounding check.
      return { thought: 'Click the observed Apply button.', action: { action: 'CLICK', target: { element_id: 'el_1' } } };
    }
    verificationSeenByPlanner = history.at(-1)?.diagnostic?.post_action_verification || null;
    return { thought: 'Stop after considering the unchanged page.', action: { action: 'DONE' }, final_response: 'Done.' };
  }));

  const controller = new AgentController();
  controller.notify = () => {};
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._extractDOM = async () => {
    extractionIndex++;
    return {
      success: true,
      data: {
        snapshot_id: `unchanged_${extractionIndex}`,
        mutation_revision: extractionIndex,
        url: 'https://example.test/form',
        title: 'Application',
        viewport: { width: 1280, height: 800 },
        elements: [
          { id: 'el_1', tag: 'button', type: 'button', label: 'Apply', value: '', bbox: [10, 10, 90, 30], is_interactive: true },
          { id: 'el_2', tag: 'a', type: 'link', label: 'Help', href: '/help', bbox: [10, 50, 60, 30], is_interactive: true }
        ],
        headings: [], result_items: [],
        visible_text: 'Application form. Apply to continue. Help is available.',
        scroll: { x: 0, y: 0 }
      }
    };
  };

  try {
    assert.equal(await controller.runSingleStep(task), true);
    assert.equal(await controller.runSingleStep(task), false);
    assert.equal(task.lastVerification.status, 'OBSERVED_NO_VISIBLE_CHANGE');
    assert.equal(task.lastVerification.replan_required, true);
    assert.equal(task.lastVerification.no_progress_count, 1);
    assert.equal(verificationSeenByPlanner.visible_state_changed, false);
    assert.equal(verificationSeenByPlanner.target_present, true);
    assert.ok(extractionIndex >= 2, 'the dispatched click must be followed by a fresh observation');
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('every step reports what was sent to the VLM, including when nothing was', async () => {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  const events = [];

  globalThis.chrome = { tabs: { get: async () => ({ id: 11, url: 'https://example.test/form', windowId: 1 }) } };
  taskManager.settings = { ...DEFAULT_SETTINGS, alwaysConfirm: false };
  const task = taskManager.createTask('Read the page', 11);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));

  restore.push(replaceMethod(defaultActionExecutor, 'execute', async () => ({ success: true })));
  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async () => ({
    thought: 'Nothing to do.', action: { action: 'DONE' }, final_response: 'Read.'
  })));

  const controller = new AgentController();
  controller.notify = (event, data) => events.push({ event, data });
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._extractDOM = async () => ({
    success: true,
    data: {
      snapshot_id: 'snap_vlm', mutation_revision: 0,
      url: 'https://example.test/form', title: 'Form',
      viewport: { width: 1280, height: 800 },
      elements: [{ id: 'el_1', tag: 'p', label: 'Body text', value: '', bbox: [0, 0, 200, 40] }],
      headings: [], result_items: [], visible_text: 'Body text', scroll: { x: 0, y: 0 }
    }
  });

  try {
    await controller.runSingleStep(task);
    const vlmEvents = events.filter((e) => e.event === 'VLM_SCREENSHOT_DISPATCHED');
    assert.equal(vlmEvents.length, 1,
      'the panel must be told about the step even when no image was sent');
    const { data } = vlmEvents[0];
    assert.equal(data.sent, false, 'no image left the device, so sent must be false');
    assert.equal(data.sanitized_screenshot, null);
    assert.equal(data.task_id, task.id);
    assert.ok(['skipped', 'unavailable', 'withheld'].includes(data.redaction_status),
      `unexpected redaction_status: ${data.redaction_status}`);
  } finally {
    for (const undo of restore.reverse()) undo();
    taskManager.currentTask = previousTask;
    taskManager.settings = previousSettings;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
