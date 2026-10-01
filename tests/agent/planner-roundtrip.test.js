import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController, latestConfirmationReview, plannerStepMetadata } from '../../extension/background/agent-controller.js';
import { taskManager, friendlyError } from '../../extension/background/task-manager.js';
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

test('booking confirmation can display only the latest successful extracted review', () => {
  const valid = latestConfirmationReview([{
    action: { action: ActionType.EXTRACT },
    success: true,
    result: { extractedText: 'Flight: 8:10 PM. Total: $820.' }
  }]);
  assert.equal(valid, 'Flight: 8:10 PM. Total: $820.');
  assert.equal(latestConfirmationReview([{
    action: { action: ActionType.EXTRACT },
    success: false,
    result: { extractedText: 'Do not show a failed review.' }
  }]), '');
  assert.equal(latestConfirmationReview([{
    action: { action: ActionType.CLICK },
    success: true,
    result: { extractedText: 'Do not reuse stale extraction.' }
  }]), '');
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

test('a backend 401 is reported as an auth fault with the real fix, not a generic outage', () => {
  // The most common first-run failure. Before this, a 401 surfaced as "The AI
  // planner is temporarily unavailable", which sent users hunting for a
  // backend that was running perfectly.
  const client = new GPTOSSClient('http://127.0.0.1:8000');
  const rejection = client._backendAuthRejected(401);
  assert.equal(rejection.authRejected, true);
  assert.equal(rejection.plannerUnavailable, undefined);
  assert.match(rejection.thought, /rejected this extension's access token/i);
  assert.match(rejection.thought, /not authenticated/i);
  assert.equal(rejection.action.action, 'WAIT');
});

test('friendlyError keeps the auth instruction instead of the generic default', () => {
  const message = 'The extension is not authenticated with the backend. Open Settings and paste the BACKEND_SHARED_SECRET value from your .env into "Backend access token", then save.';
  const { error, hint } = friendlyError(message);
  assert.match(error, /BACKEND_SHARED_SECRET/);
  assert.match(hint, /Backend access token/);
});

test('friendlyError explains when a successful action could not be confirmed', () => {
  const result = friendlyError('The page showed no visible change after 3 verified actions.');
  assert.match(result.error, /could not confirm/i);
  assert.match(result.hint, /may still have succeeded/i);
});

test('friendlyError explains local privacy categories without showing matched values', () => {
  const result = friendlyError('Outbound policy blocked payload: Unredacted Aadhaar pattern found in request body');
  assert.match(result.error, /possible Aadhaar number/i);
  assert.match(result.hint, /request was not sent/i);
  assert.doesNotMatch(JSON.stringify(result), /1234\s?5678\s?9012/);
});

test('friendlyError keeps the planner-unavailable cause instead of the generic default', () => {
  // The controller hands friendlyError a message that already contains the
  // remedy. It must not collapse "nothing is listening" and "the backend hung"
  // into one indistinguishable sentence.
  const unreachable = friendlyError(
    'Planner unavailable: the reasoning backend could not be reached (fetch failed).'
  );
  assert.match(unreachable.error, /could not reach the reasoning backend/i);
  assert.match(unreachable.hint, /fetch failed/,
    'the underlying cause must survive into the hint');

  const timeout = friendlyError(
    'Planner unavailable: the reasoning backend could not be reached (The operation was aborted).'
  );
  assert.match(timeout.hint, /aborted/);
  assert.doesNotMatch(JSON.stringify(timeout), /undefined/);
});

test('friendlyError on a planner-unavailable message never leaks page content', () => {
  // The detail is interpolated into the hint, so it must come from the error
  // object only -- never from page text that reached the planner.
  const result = friendlyError(
    'Planner unavailable: the reasoning backend could not be reached (TypeError: Failed to fetch).'
  );
  assert.doesNotMatch(result.error, /TypeError|Failed to fetch/,
    'the raw exception type belongs in logs, not the user-facing headline');
});

// ── Every wait on the side panel is bounded ───────────────────────────────
//
// Three waits in the loop resolve only when the side panel answers: the
// approval card, the ASK_USER modal, and resume-after-pause. The first two
// already had deadlines; the pause wait did not, so a closed or crashed panel
// left the task parked in PAUSED forever with nothing logged and no way to
// reach a terminal state. This asserts all three carry a bound.

test('all three panel-dependent waits are bounded', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../extension/background/agent-controller.js', import.meta.url),
    'utf8'
  );
  for (const constant of ['CONFIRMATION_TIMEOUT_MS', 'USER_INPUT_TIMEOUT_MS', 'PAUSE_TIMEOUT_MS']) {
    assert.match(source, new RegExp(`const ${constant} = \\d+;`),
      `${constant} must be a declared, finite bound`);
  }
  // Each of the three waits must race against a timer, not await bare.
  const races = source.match(/Promise\.race\(\[/g) || [];
  assert.ok(races.length >= 3,
    `expected at least three Promise.race waits, found ${races.length}`);
  // The pause wait specifically: it must RACE a timer. A bare await here is the
  // exact shape of the bug -- a promise that only the side panel can resolve, so
  // a closed panel parks the task forever. Checked by body, not by counting
  // Promise.race occurrences, so an unrelated race elsewhere cannot mask it.
  const waitBody = source.slice(source.indexOf('async _waitWhilePaused('));
  const waitEnd = waitBody.indexOf('\n  }\n');
  const pauseWait = waitBody.slice(0, waitEnd === -1 ? undefined : waitEnd);
  assert.match(pauseWait, /Promise\.race\(/,
    'the pause wait must race a timeout');
  assert.match(pauseWait, /PAUSE_TIMEOUT_MS/,
    'the pause wait must use its declared bound');
  assert.doesNotMatch(pauseWait, /^\s*await this\._awaitOwned\(task, token, new Promise\(\(resolve\) => \{ this\.pauseResolver = resolve; \}\)\);$/m,
    'a bare await on the pause resolver is the unbounded-wait bug');
});

test('resumeTask clears the pause expiry timer', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../../extension/background/agent-controller.js', import.meta.url),
    'utf8'
  );
  const body = source.slice(source.indexOf('  resumeTask() {'));
  const end = body.indexOf('\n  }\n');
  assert.match(body.slice(0, end === -1 ? undefined : end), /_pauseExpiryTimer/,
    'resuming must clear the timer, or it outlives the pause it watches');
});
