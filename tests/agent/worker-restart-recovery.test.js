import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager, taskManager } from '../../extension/background/task-manager.js';
import { AgentController } from '../../extension/background/agent-controller.js';
import { AgentState, ActionType, RiskLevel } from '../../extension/shared/constants.js';

/**
 * MV3 service workers are terminated whenever they go idle, and a task that
 * waits on the user is idle by definition. These tests pin what a restarted
 * worker is allowed to do with the snapshot it finds: keep a pending decision
 * answerable, and never let a task look like it is still running.
 */

function stubStorageSession(snapshot) {
  const store = snapshot ? { privagent_task: snapshot } : {};
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => { Object.assign(store, obj); }
      },
      local: { get: async () => ({}), set: async () => {} }
    }
  };
  return store;
}

function baseSnapshot(overrides = {}) {
  return {
    id: 'task_1',
    prompt: 'Submit the application',
    tabId: 7,
    state: AgentState.EXECUTING,
    currentStep: 2,
    maxSteps: 25,
    startTime: Date.now() - 5000,
    endTime: null,
    privacyMetrics: {},
    ...overrides
  };
}

test('a mid-step snapshot is restored as FAILED, never as still running', async () => {
  const previousChrome = globalThis.chrome;
  try {
    stubStorageSession(baseSnapshot());
    const tm = new TaskManager();
    const restored = await tm.restorePersistedTask();

    assert.equal(restored.state, AgentState.FAILED);
    assert.ok(restored.endTime, 'an interrupted task must be closed out');
    assert.equal(restored.pendingConfirmation, null);
    assert.match(restored.error, /restarted/i);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('a WAITING_FOR_USER confirmation prompt survives the restart and stays answerable', async () => {
  const previousChrome = globalThis.chrome;
  try {
    stubStorageSession(baseSnapshot({
      state: AgentState.WAITING_FOR_USER,
      pendingConfirmation: {
        action: { action: ActionType.SUBMIT, risk: RiskLevel.HIGH },
        reason: 'Form submission requires approval.',
        taskId: 'task_1',
        confirmationId: 'confirm_7',
        timestamp: Date.now()
      }
    }));
    const tm = new TaskManager();
    const restored = await tm.restorePersistedTask();

    assert.equal(restored.state, AgentState.WAITING_FOR_USER,
      'the decision is still the user\'s to make, so the prompt must stay live');
    assert.equal(restored.pendingConfirmation.confirmationId, 'confirm_7');
    assert.equal(restored.pendingConfirmation.taskId, 'task_1');
    assert.ok(restored.interruptedWhileAwaitingUser);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('a WAITING_FOR_USER snapshot with no prompt is still failed', async () => {
  const previousChrome = globalThis.chrome;
  try {
    // A prompt that cannot be correlated is exactly the dead modal this
    // recovery path exists to avoid, so it must not be restored as pending.
    stubStorageSession(baseSnapshot({ state: AgentState.WAITING_FOR_USER, pendingConfirmation: null }));
    const tm = new TaskManager();
    const restored = await tm.restorePersistedTask();
    assert.equal(restored.state, AgentState.FAILED);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('a terminal snapshot is restored unchanged', async () => {
  const previousChrome = globalThis.chrome;
  try {
    const done = Date.now();
    stubStorageSession(baseSnapshot({ state: AgentState.COMPLETED, result: 'Submitted', endTime: done }));
    const tm = new TaskManager();
    const restored = await tm.restorePersistedTask();
    assert.equal(restored.state, AgentState.COMPLETED);
    assert.equal(restored.result, 'Submitted');
    assert.equal(restored.endTime, done);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('an approval arriving with no surviving loop reports success but never implies the action ran', async () => {
  const previousTask = taskManager.currentTask;
  try {
    const task = taskManager.createTask('Submit the application', 7);
    taskManager.setPendingConfirmation(
      { action: { action: ActionType.SUBMIT, risk: RiskLevel.HIGH } },
      'Form submission requires approval.',
      { confirmationId: 'confirm_7' }
    );
    // No resolver is installed: this is the post-restart case.
    const controller = new AgentController();
    const accepted = controller.handleUserConfirmation({
      taskId: task.id, confirmationId: 'confirm_7', approved: true
    });

    assert.equal(accepted, true, 'a correlated answer is still accepted');
    assert.equal(taskManager.getTask().state, AgentState.CANCELLED,
      'the task must reach a terminal state rather than wait forever');
    assert.equal(taskManager.getTask().pendingConfirmation, null);
  } finally {
    taskManager.currentTask = previousTask;
  }
});

test('a stale confirmation id is rejected and leaves the prompt waiting', async () => {
  const previousTask = taskManager.currentTask;
  try {
    const task = taskManager.createTask('Submit the application', 7);
    taskManager.setPendingConfirmation(
      { action: { action: ActionType.SUBMIT, risk: RiskLevel.HIGH } },
      'Form submission requires approval.',
      { confirmationId: 'confirm_7' }
    );
    const controller = new AgentController();
    const accepted = controller.handleUserConfirmation({
      taskId: task.id, confirmationId: 'confirm_OLD', approved: true
    });

    assert.equal(accepted, false);
    assert.equal(taskManager.getTask().state, AgentState.WAITING_FOR_USER);
    assert.ok(taskManager.getTask().pendingConfirmation);
  } finally {
    taskManager.currentTask = previousTask;
  }
});

test('a confirmation id belonging to a different task is rejected', async () => {
  const previousTask = taskManager.currentTask;
  try {
    const task = taskManager.createTask('Submit the application', 7);
    taskManager.setPendingConfirmation(
      { action: { action: ActionType.SUBMIT, risk: RiskLevel.HIGH } },
      'Form submission requires approval.',
      { confirmationId: 'confirm_7' }
    );
    const controller = new AgentController();
    const accepted = controller.handleUserConfirmation({
      taskId: 'task_from_another_run', confirmationId: 'confirm_7', approved: true
    });

    assert.equal(accepted, false, 'a leftover click from a previous task must not approve this one');
    assert.equal(taskManager.getTask().state, AgentState.WAITING_FOR_USER);
  } finally {
    taskManager.currentTask = previousTask;
  }
});

test('a user-input answer with no surviving loop stops the task instead of hanging', async () => {
  const previousTask = taskManager.currentTask;
  try {
    taskManager.createTask('Fill the ambiguous registration form', 7);
    taskManager.setPendingUserInput({ prompt: 'Which newsletter?' }, { requestId: 'req_1' });
    const controller = new AgentController();
    const accepted = controller.handleUserInput({
      taskId: taskManager.getTask().id, requestId: 'req_1', answers: { f_1: 'Weekly' }
    });

    assert.equal(accepted, true);
    assert.equal(taskManager.getTask().state, AgentState.FAILED);
    assert.equal(taskManager.getTask().pendingUserInput, null);
  } finally {
    taskManager.currentTask = previousTask;
  }
});
