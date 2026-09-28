import test from 'node:test';
import assert from 'node:assert';
import { validateReasonPayload } from '../../extension/shared/schemas.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';

function blockedClient() {
  const client = new GPTOSSClient('http://backend.test');
  client.policyEngine = {
    enforceOutboundSafety() {
      const error = new Error('synthetic outbound block');
      error.name = 'OutboundPolicyViolationError';
      throw error;
    }
  };
  return client;
}

function response(data) {
  return { ok: true, json: async () => data };
}

async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const observation = { page: { page_type: 'SEARCH' }, elements: [] };

test('Task Understanding Reasoning Schema', () => {
  const payload = {
    task: 'Fill application form',
    fused_observation: {
      page: { page_type: 'application_form' },
      form_state: { completion: { empty: 2, filled: 0 } },
      elements: []
    },
    task_history: []
  };
  
  assert.doesNotThrow(() => validateReasonPayload(payload));
});

test('unreachable planner returns plannerUnavailable and WAIT', async () => {
  const client = new GPTOSSClient('http://backend.test');
  client.post = async () => { throw new Error('backend offline'); };
  const result = await client.planNextStep('Search for laptops', observation);
  assert.equal(result.action.action, 'WAIT');
  assert.equal(result.plannerUnavailable, true);
  assert.equal(result.remoteCallMade, false);
  assert.equal(result.remoteCallAttempted, true);
});

test('malformed remote action waits for a new observation without plannerUnavailable', async () => {
  await withMockFetch(async () => response({ action: { action: 'NOT_AN_ACTION' } }), async () => {
    const result = await new GPTOSSClient('http://backend.test').planNextStep('Search for laptops', observation);
    assert.equal(result.action.action, 'WAIT');
    assert.equal(result.plannerUnavailable, undefined);
    assert.equal(result.remoteCallMade, true);
  });
});

test('privacy block returns WAIT and privacyBlocked without sending a request', async () => {
  const client = blockedClient();
  const result = await client.planNextStep('Search for laptops', observation);
  assert.equal(result.action.action, 'WAIT');
  assert.ok(result.privacyBlocked);
  assert.equal(result.remoteCallMade, false);
  assert.equal(result.remoteCallAttempted, false);
});

test('valid mocked response passes through the action, plan, and planner feedback', async () => {
  let sentBody;
  await withMockFetch(async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return response({
      action: { action: 'CLICK', target: { element_id: 'el_search' } },
      plan: 'Search the catalog, then inspect the results.',
      planner_feedback: 'The search field is ready.',
      terminate_assessment: false,
      final_response: ''
    });
  }, async () => {
    const result = await new GPTOSSClient('http://backend.test').planNextStep(
      'Search the catalog',
      { ...observation, elements: [{ id: 'el_search', dom: { tag: 'button', label: 'Search' } }] }
    );
    assert.equal(result.action.target.element_id, 'el_search');
    assert.equal(result.remoteCallMade, true);
    assert.equal(result.plan, 'Search the catalog, then inspect the results.');
    assert.equal(result.planner_feedback, 'The search field is ready.');
  });
  assert.equal(sentBody.task, 'Search the catalog');
});

test('interpretTask transport failure stays unknown and records the attempted call', async () => {
  const client = new GPTOSSClient('http://backend.test');
  client.post = async () => { throw new Error('backend offline'); };
  const result = await client.interpretTask('Search for laptops');
  assert.equal(result.intent, 'unknown');
  assert.equal(result.remoteCallAttempted, true);
  assert.equal(result.privacyBlocked, false);
});

test('Semantic Task Understanding: "open youtube and most popular karan aujla"', async () => {
  const { parseTaskSemantics, TaskState } = await import('../../extension/reasoning/task-understanding.js');

  const parsed = parseTaskSemantics('open youtube and most popular karan aujla');
  assert.strictEqual(parsed.site, 'YouTube');
  assert.strictEqual(parsed.intent, 'search_and_select');
  assert.strictEqual(parsed.search_query, 'karan aujla');
  assert.strictEqual(parsed.ranking_constraint, 'most popular');
  assert.ok(parsed.subgoals.length >= 4);
  assert.ok(parsed.subgoals[0].includes('open YouTube'));
  assert.ok(parsed.subgoals[1].includes('search for karan aujla'));
  assert.ok(parsed.subgoals[2].includes('most popular'));
  assert.ok(parsed.subgoals[3].includes('verify'));

  // Test state progression
  const state = new TaskState('open youtube and most popular karan aujla');
  assert.strictEqual(state.getActiveSubgoal(), 'open YouTube');

  state.advance({ action: 'NAVIGATE' }, null, { success: true });
  assert.strictEqual(state.getActiveSubgoal(), 'search for karan aujla');

  state.advance({ action: 'CLICK', target: { label: 'Search' } }, null, { success: true });
  assert.ok(state.getActiveSubgoal().includes('most popular'));

  state.advance({ action: 'CLICK', target: { label: 'Winning - Karan Aujla (Official Music Video)' } }, null, { success: true });
  assert.strictEqual(state.getActiveSubgoal(), 'verify selected result');
});

test('Search Query Extraction across various queries', async () => {
  const { parseTaskSemantics } = await import('../../extension/reasoning/task-understanding.js');

  const q1 = parseTaskSemantics('search YouTube for Karan Aujla songs');
  assert.strictEqual(q1.search_query, 'Karan Aujla songs');

  const q2 = parseTaskSemantics('find the most popular videos of Karan Aujla');
  assert.strictEqual(q2.search_query, 'Karan Aujla');
  assert.strictEqual(q2.ranking_constraint, 'most popular');

  const q3 = parseTaskSemantics('open google and search for artificial intelligence news');
  assert.strictEqual(q3.site, 'Google');
  assert.strictEqual(q3.search_query, 'artificial intelligence news');
});

test('Page State Modeler: filters irrelevant player controls when searching', async () => {
  const { defaultPageStateModeler } = await import('../../extension/perception/page-state-modeler.js');
  const { TaskState } = await import('../../extension/reasoning/task-understanding.js');

  const state = new TaskState('open youtube and most popular karan aujla');
  state.advance({ action: 'NAVIGATE' }); // now in search subgoal

  const fusedObservation = {
    page: { domain: 'youtube.com', title: 'YouTube' },
    elements: [
      { id: 'el_search', dom: { tag: 'input', id: 'search', name: 'search_query', placeholder: 'Search' }, interaction: { typeable: true } },
      { id: 'el_search_btn', dom: { tag: 'button', id: 'search-icon-legacy', label: 'Search' }, interaction: { clickable: true } },
      { id: 'el_mix', dom: { tag: 'a', label: 'Mix' }, interaction: { clickable: true } },
      { id: 'el_prev', dom: { tag: 'button', label: 'Previous (SHIFT+p)' }, interaction: { clickable: true } },
      { id: 'el_like', dom: { tag: 'button', label: 'Like' }, interaction: { clickable: true } }
    ]
  };

  const pageState = defaultPageStateModeler.modelPageState(fusedObservation, state);
  assert.strictEqual(pageState.active_subgoal, 'search for karan aujla');
  
  const relevantIds = pageState.relevant_elements.map(e => e.id);
  assert.ok(relevantIds.includes('el_search'), 'Search input should be relevant');
  assert.ok(relevantIds.includes('el_search_btn'), 'Search button should be relevant');
  assert.strictEqual(pageState.irrelevant_elements_count, 3, 'Mix, Previous, Like should be marked irrelevant');
});

test('Action Validator: Rejects irrelevant actions inconsistent with active subgoal', async () => {
  const { defaultActionValidator } = await import('../../extension/executor/action-validator.js');
  const { TaskState } = await import('../../extension/reasoning/task-understanding.js');

  const state = new TaskState('open youtube and most popular karan aujla');
  state.advance({ action: 'NAVIGATE' }); // active subgoal is "search for karan aujla"

  const fusedObservation = {
    elements: [
      { id: 'el_search', dom: { tag: 'input', id: 'search', name: 'search_query', placeholder: 'Search' }, interaction: { typeable: true } },
      { id: 'el_mix', dom: { tag: 'a', label: 'Mix' }, interaction: { clickable: true } },
      { id: 'el_prev', dom: { tag: 'button', label: 'Previous (SHIFT+p)' }, interaction: { clickable: true } }
    ]
  };

  // 1. Proposing CLICK Mix when search is active -> REJECT
  const valMix = defaultActionValidator.validatePreExecution(
    { action: 'CLICK', target: { element_id: 'el_mix', label: 'Mix' } },
    fusedObservation,
    state
  );
  assert.strictEqual(valMix.valid, false, 'CLICK Mix should be rejected');
  assert.ok(valMix.reason.includes('does not advance active subgoal'));

  // 2. Proposing CLICK Previous when search is active -> REJECT
  const valPrev = defaultActionValidator.validatePreExecution(
    { action: 'CLICK', target: { element_id: 'el_prev', label: 'Previous (SHIFT+p)' } },
    fusedObservation,
    state
  );
  assert.strictEqual(valPrev.valid, false, 'CLICK Previous should be rejected');

  // 3. Proposing TYPE into search with clean query -> ACCEPT
  const valSearch = defaultActionValidator.validatePreExecution(
    { action: 'TYPE', target: { element_id: 'el_search', label: 'Search' }, value: 'Karan Aujla' },
    fusedObservation,
    state
  );
  assert.strictEqual(valSearch.valid, true, 'TYPE into search should be valid');
});

test('interpretTask privacy failure stays unknown and reports a blocked unsent call', async () => {
  const result = await blockedClient().interpretTask('Search for laptops');
  assert.equal(result.intent, 'unknown');
  assert.equal(result.remoteCallAttempted, false);
  assert.equal(result.privacyBlocked, true);
});
