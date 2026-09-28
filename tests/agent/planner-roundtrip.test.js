import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController, plannerStepMetadata } from '../../extension/background/agent-controller.js';
import { taskManager } from '../../extension/background/task-manager.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { ActionType } from '../../extension/shared/constants.js';

test('critic termination with a final answer completes before action validation', () => {
  const controller = new AgentController();
  const task = { tabId: 9 };
  const events = [];
  const originalCompleteTask = taskManager.completeTask;
  taskManager.completeTask = (answer, owner) => events.push(['complete', answer, owner]);
  controller.clearOverlays = (tabId) => events.push(['clear', tabId]);
  controller.notify = (event, payload) => events.push([event, payload]);
  try {
    const completed = controller._completeFromCriticTermination(
      task,
      { terminate_assessment: true, final_response: 'The requested answer is here.' },
      { action: ActionType.WAIT }
    );
    assert.equal(completed, true);
    assert.deepEqual(events, [
      ['complete', 'The requested answer is here.', task],
      ['clear', 9],
      ['TASK_COMPLETED', { result: 'The requested answer is here.' }]
    ]);
  } finally {
    taskManager.completeTask = originalCompleteTask;
  }
});

test('critic cannot terminate without a final answer and DONE remains the primary terminal action', () => {
  const controller = new AgentController();
  let completed = false;
  const originalCompleteTask = taskManager.completeTask;
  taskManager.completeTask = () => { completed = true; };
  try {
    assert.equal(controller._completeFromCriticTermination(
      { tabId: 1 }, { terminate_assessment: true, final_response: '  ' }, { action: ActionType.WAIT }
    ), false);
    assert.equal(controller._completeFromCriticTermination(
      { tabId: 1 }, { terminate_assessment: true, final_response: 'Answer' }, { action: ActionType.DONE }
    ), false);
    assert.equal(completed, false);
  } finally {
    taskManager.completeTask = originalCompleteTask;
  }
});

test('planner unavailable fails before risk evaluation and records the remote call metric', () => {
  const controller = new AgentController();
  const task = { tabId: 5 };
  const events = [];
  const original = {
    updatePrivacyMetrics: taskManager.updatePrivacyMetrics,
    failTask: taskManager.failTask
  };
  taskManager.updatePrivacyMetrics = (metrics) => events.push(['metrics', metrics]);
  taskManager.failTask = (message, owner) => { owner.error = message; events.push(['fail', message, owner]); };
  controller.clearOverlays = (tabId) => events.push(['clear', tabId]);
  controller.notify = (event, payload) => events.push([event, payload]);
  try {
    assert.equal(controller._handlePlannerFailure(task, {
      plannerUnavailable: true,
      remoteCallAttempted: true
    }), false);
  } finally {
    taskManager.updatePrivacyMetrics = original.updatePrivacyMetrics;
    taskManager.failTask = original.failTask;
  }
  assert.deepEqual(events.map(([kind]) => kind), ['metrics', 'fail', 'clear', 'TASK_FAILED']);
  assert.deepEqual(events[0][1], { serverCallsCount: 1 });
  assert.match(events.at(-1)[1].error, /planner is unavailable/i);
});

test('privacy block fails immediately and increments both privacy counters', () => {
  const controller = new AgentController();
  const task = { tabId: 6, privacyMetrics: { privacyBlocks: 1 } };
  const events = [];
  const original = {
    updatePrivacyMetrics: taskManager.updatePrivacyMetrics,
    failTask: taskManager.failTask
  };
  taskManager.updatePrivacyMetrics = (metrics) => events.push(['metrics', metrics]);
  taskManager.failTask = (message, owner) => { owner.error = message; events.push(['fail', message, owner]); };
  controller.clearOverlays = (tabId) => events.push(['clear', tabId]);
  controller.notify = (event, payload) => events.push([event, payload]);
  try {
    assert.equal(controller._handlePlannerFailure(task, {
      privacyBlocked: true,
      remoteCallAttempted: true
    }), false);
  } finally {
    taskManager.updatePrivacyMetrics = original.updatePrivacyMetrics;
    taskManager.failTask = original.failTask;
  }
  assert.deepEqual(events.filter(([kind]) => kind === 'metrics').map(([, value]) => value), [
    { serverCallsCount: 1 }, { privacyBlocks: 1 }
  ]);
  assert.deepEqual(events.map(([kind]) => kind), [
    'metrics', 'metrics', 'PRIVACY_UPDATED', 'fail', 'clear', 'TASK_FAILED'
  ]);
  assert.match(events.at(-1)[1].error, /privacy protection blocked/i);
});

test('planner plan and feedback recorded at step N return in step N+1 history', async () => {
  const stepN = {
    action: { action: ActionType.TYPE, target: { element_id: 'el_query' } },
    success: true,
    ...plannerStepMetadata({
      plan: 'Search the catalog and inspect a result.',
      planner_feedback: 'The query was entered successfully.',
      terminate_assessment: false
    })
  };
  let sentBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ action: { action: ActionType.WAIT } }) };
  };
  try {
    const result = await new GPTOSSClient('http://backend.test').planNextStep(
      'Search the catalog', { elements: [] }, [stepN]
    );
    assert.equal(result.remoteCallMade, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sentBody.task_history[0].plan, 'Search the catalog and inspect a result.');
  assert.equal(sentBody.task_history[0].planner_feedback, 'The query was entered successfully.');
  assert.equal(sentBody.task_history[0].terminate_assessment, false);
});
