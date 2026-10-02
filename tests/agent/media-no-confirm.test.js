import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentController,
  isConfidentMediaPlay,
  mediaCurrentlyPlaying,
  taskGoalStatus
} from '../../extension/background/agent-controller.js';
import { taskManager, DEFAULT_SETTINGS } from '../../extension/background/task-manager.js';
import { defaultGPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { defaultActionExecutor } from '../../extension/executor/action-executor.js';
import { TaskState, localInterpretTask } from '../../extension/reasoning/task-understanding.js';
import { RiskLevel } from '../../extension/shared/constants.js';

function replaceMethod(target, name, value) {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  target[name] = value;
  return () => {
    if (hadOwn) target[name] = previous;
    else delete target[name];
  };
}

const LOW = { allowed: true, risk: RiskLevel.LOW, requiresConfirmation: false, reason: 'Standard.' };
const HIGH = { allowed: true, risk: RiskLevel.HIGH, requiresConfirmation: true, reason: 'High.' };
const LOW_GATE = { allowed: true, risk: RiskLevel.LOW, requiresConfirmation: false, reason: 'Standard.' };

function playTask(prompt) {
  const task = taskManager.createTask(prompt, 7);
  task.taskState = new TaskState(prompt);
  task.taskState.updateFromModel(localInterpretTask(prompt));
  return task;
}

// ---------- helper unit tests ----------

test('media fast-path fires only for LOW play clicks with a resolved target', () => {
  const target = { tag: 'a', label: 'ISRO launch video' };
  const click = { action: 'CLICK', target: { element_id: 'el_1' } };
  assert.equal(isConfidentMediaPlay(playTask('play the ISRO video'), click, LOW, target), true);
  // Backend-unknown intent (the side-panel screenshot case) still qualifies via the prompt.
  const unknown = playTask('play the ISRO video');
  unknown.taskState.intent = 'unknown';
  assert.equal(isConfidentMediaPlay(unknown, click, LOW, target), true);
  // Gate-demanded confirmations are never skipped.
  assert.equal(isConfidentMediaPlay(playTask('play the ISRO video'), click, HIGH, target), false);
  assert.equal(isConfidentMediaPlay(playTask('play the ISRO video'), click, LOW_GATE, target), true);
  // Not a play task, not a click, or no resolved target: no fast path.
  assert.equal(isConfidentMediaPlay(playTask('click the Search button'), click, LOW, target), false);
  assert.equal(isConfidentMediaPlay(playTask('play the ISRO video'),
    { action: 'TYPE', target: { element_id: 'el_1' } }, LOW, target), false);
  assert.equal(isConfidentMediaPlay(playTask('play the ISRO video'), click, LOW, null), false);
});

// ---------- controller-level tests ----------

function videoDom() {
  return {
    success: true,
    data: {
      snapshot_id: 'snapshot_media',
      mutation_revision: 0,
      url: 'https://www.youtube.com/results?search_query=isro',
      title: 'ISRO video search results - YouTube',
      viewport: { width: 1280, height: 800 },
      elements: [
        { id: 'el_1', tag: 'a', type: '', label: 'ISRO launches new rocket', value: '', bbox: [10, 10, 200, 120] }
      ],
      headings: [],
      result_items: [],
      visible_text: 'ISRO launches new rocket',
      scroll: { x: 0, y: 0 }
    }
  };
}

function driveController(prompt, plannedAction) {
  const previousChrome = globalThis.chrome;
  const previousTask = taskManager.currentTask;
  const previousSettings = taskManager.settings;
  const restore = [];
  const events = [];
  let execCalls = 0;

  globalThis.chrome = {
    tabs: { get: async () => ({ id: 7, url: 'https://www.youtube.com/results?search_query=isro', windowId: 3 }) }
  };
  taskManager.settings = { ...DEFAULT_SETTINGS };
  const task = playTask(prompt);

  restore.push(replaceMethod(defaultGPTOSSClient, 'planNextStep', async () => ({
    thought: 'Play the matching video',
    action: plannedAction,
    isTerminal: false,
    remoteCallMade: false
  })));
  restore.push(replaceMethod(defaultActionExecutor, 'execute', async () => {
    execCalls++;
    return { success: true };
  }));

  const controller = new AgentController();
  controller.notify = (event, data) => { events.push(event); };
  controller.clearOverlays = () => {};
  controller._waitForPageStability = async () => {};
  controller._maybeHandleNavigationBootstrap = async () => ({ handled: false });
  controller._extractDOM = async () => videoDom();

  return {
    task,
    controller,
    events,
    execCalls: () => execCalls,
    done: () => {
      for (const undo of restore.reverse()) undo();
      taskManager.currentTask = previousTask;
      taskManager.settings = previousSettings;
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    }
  };
}

test('play click with model requires_confirmation runs with no approval card', async () => {
  const ctx = driveController('play the ISRO video', {
    action: 'CLICK', target: { element_id: 'el_1' }, risk: 'LOW', requires_confirmation: true
  });
  try {
    await ctx.controller.runSingleStep(ctx.task);
    assert.equal(ctx.execCalls(), 1, 'the click must execute without waiting');
    assert.ok(!ctx.events.includes('CONFIRMATION_REQUIRED'), 'no approval card for a LOW play click');
    assert.equal(taskManager.getTask().pendingConfirmation, null);
  } finally {
    ctx.done();
  }
});

test('same cautious click outside a play task still asks approval', async () => {
  const ctx = driveController('click the ISRO result link', {
    action: 'CLICK', target: { element_id: 'el_1' }, risk: 'LOW', requires_confirmation: true
  });
  try {
    const pending = ctx.controller.runSingleStep(ctx.task);
    let guard = 500;
    while (!taskManager.getTask()?.pendingConfirmation && guard-- > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const prompt = taskManager.getTask()?.pendingConfirmation;
    assert.ok(prompt, 'approval prompt must be raised for non-play tasks');
    ctx.controller.handleUserConfirmation({
      approved: false, taskId: prompt.taskId, confirmationId: prompt.confirmationId
    });
    await pending;
    assert.equal(ctx.execCalls(), 0, 'declined click must never execute');
    assert.equal(taskManager.getTask().state, 'CANCELLED');
  } finally {
    ctx.done();
  }
});

// ---------- PLAY goal: recognize actually-playing media ----------

function playGoalFixture({ beforeMedia, afterMedia, title }) {
  const previousTask = taskManager.currentTask;
  const task = taskManager.createTask('play the ISRO video', 7);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));
  task.taskState.search_query = 'ISRO video';
  task.taskState.target = { type: 'video', entity: 'ISRO video' };
  taskManager.recordStep({
    thought: 'Click the top ISRO video link',
    action: { action: 'CLICK', target: { element_id: 'el_1' } },
    success: true
  }, task);
  const beforeObservation = {
    observation_id: 'obs-before',
    page: { url: 'https://www.youtube.com/results?search_query=isro', title: 'ISRO search - YouTube' },
    headings: [],
    visible_text: 'search results',
    elements: [{ id: 'el_1', tag: 'a', label: 'ISRO launches new rocket' }],
    local_media_state: { visible_count: beforeMedia.length, media: beforeMedia }
  };
  const fusedObservation = {
    observation_id: 'obs-after',
    page: { url: 'https://www.youtube.com/watch?v=abc123', title },
    headings: [{ text: title }],
    visible_text: 'watch page',
    elements: [{ id: 'el_9', tag: 'video', label: '' }],
    local_media_state: { visible_count: afterMedia.length, media: afterMedia }
  };
  const verificationContext = {
    stepNumber: 1,
    execution: { success: true },
    beforeObservation,
    verification: { verified: true, observation_id: 'obs-after', visible_state_changed: true }
  };
  return { task, fusedObservation, verificationContext, restore: () => { taskManager.currentTask = previousTask; } };
}

test('PLAY completes when the player is already playing on arrival', () => {
  // The old ordinal matcher sees "same slot already playing" and reports no
  // transition, even though the watch page is demonstrably playing.
  const playing = { ordinal: 0, tag: 'video', paused: false, ended: false };
  const ctx = playGoalFixture({
    beforeMedia: [{ ...playing, paused: false }],
    afterMedia: [playing],
    title: 'ISRO launches new rocket - YouTube'
  });
  try {
    assert.equal(mediaCurrentlyPlaying(ctx.fusedObservation), true);
    const status = taskGoalStatus(ctx.task, ctx.fusedObservation, ctx.verificationContext);
    assert.deepEqual(status, { satisfied: true, message: 'The requested media is now playing.' });
  } finally {
    ctx.restore();
  }
});

test('PLAY completes after clicking the watch-page Play (k) button', () => {
  // YouTube labels its player control "Play (k)" / "Pause (k)". The strict
  // play-label regex rejected the "(k)" shortcut hint, so the click was never
  // recognized as a play trigger and PLAY tasks failed on the watch page even
  // after playback visibly started.
  const previousTask = taskManager.currentTask;
  const task = taskManager.createTask('play the ISRO video', 7);
  task.taskState = new TaskState(task.prompt);
  task.taskState.updateFromModel(localInterpretTask(task.prompt));
  task.taskState.search_query = 'ISRO video';
  task.taskState.target = { type: 'video', entity: 'ISRO video' };
  taskManager.recordStep({
    thought: 'Click Play on the watch page',
    action: { action: 'CLICK', target: { element_id: 'el_play' } },
    success: true
  }, task);
  const title = 'ISRO launches new rocket - YouTube';
  const beforeObservation = {
    observation_id: 'obs-before',
    page: { url: 'https://www.youtube.com/watch?v=abc123', title },
    headings: [],
    visible_text: 'watch page paused',
    elements: [{ id: 'el_play', tag: 'button', label: 'Play (k)' }],
    local_media_state: { visible_count: 1, media: [{ ordinal: 0, tag: 'video', paused: true, ended: false }] }
  };
  const fusedObservation = {
    observation_id: 'obs-after',
    page: { url: 'https://www.youtube.com/watch?v=abc123', title },
    headings: [{ text: title }],
    visible_text: 'watch page playing',
    elements: [{ id: 'el_play', tag: 'button', label: 'Pause (k)' }],
    local_media_state: { visible_count: 1, media: [{ ordinal: 0, tag: 'video', paused: false, ended: false }] }
  };
  const verificationContext = {
    stepNumber: 1,
    execution: { success: true },
    beforeObservation,
    verification: { verified: true, observation_id: 'obs-after', visible_state_changed: true }
  };
  try {
    const status = taskGoalStatus(task, fusedObservation, verificationContext);
    assert.deepEqual(status, { satisfied: true, message: 'The requested media is now playing.' });
  } finally {
    taskManager.currentTask = previousTask;
  }
});

test('PLAY still waits when nothing is playing or the title mismatches', () => {
  const paused = { ordinal: 0, tag: 'video', paused: true, ended: false };
  const ctxPaused = playGoalFixture({
    beforeMedia: [],
    afterMedia: [paused],
    title: 'ISRO launches new rocket - YouTube'
  });
  try {
    assert.equal(mediaCurrentlyPlaying(ctxPaused.fusedObservation), false);
    assert.equal(taskGoalStatus(ctxPaused.task, ctxPaused.fusedObservation, ctxPaused.verificationContext), null);
  } finally {
    ctxPaused.restore();
  }
  const playing = { ordinal: 0, tag: 'video', paused: false, ended: false };
  const ctxWrongVideo = playGoalFixture({
    beforeMedia: [],
    afterMedia: [playing],
    title: 'Funny cats compilation - YouTube'
  });
  try {
    assert.equal(taskGoalStatus(ctxWrongVideo.task, ctxWrongVideo.fusedObservation, ctxWrongVideo.verificationContext), null);
  } finally {
    ctxWrongVideo.restore();
  }
});
