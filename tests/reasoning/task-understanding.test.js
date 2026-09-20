import test from 'node:test';
import assert from 'node:assert';
import { validateReasonPayload } from '../../extension/shared/schemas.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';

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

test('Constraint: "ask before submitting" sets confirmBeforeSubmit', () => {
  const client = new GPTOSSClient('http://localhost:9999'); // unreachable → forces fallback
  const observation = {
    page: { page_type: 'application_form' },
    elements: [
      { id: 'el_1', dom: { tag: 'button', type: 'submit', label: 'Submit Application' }, interaction: { clickable: true, typeable: false, uploadable: false } }
    ]
  };

  const result = client._localPlannerFallback(
    'Fill this form using my saved profile and ask before submitting.',
    observation,
    []
  );

  assert.ok(result.task_understanding, 'Should contain task_understanding');
  assert.ok(result.task_understanding.constraints.includes('must ask user before submitting'), 
    `Constraints should include "must ask user before submitting", got: ${JSON.stringify(result.task_understanding.constraints)}`);
});

test('Constraint: "don\'t submit" blocks SUBMIT and returns DONE', () => {
  const client = new GPTOSSClient('http://localhost:9999');
  const observation = {
    page: { page_type: 'application_form' },
    elements: [
      { id: 'el_1', dom: { tag: 'button', type: 'submit', label: 'Submit' }, interaction: { clickable: true, typeable: false, uploadable: false } }
    ]
  };

  const result = client._localPlannerFallback(
    "Don't submit the form.",
    observation,
    []
  );

  assert.ok(result.task_understanding, 'Should contain task_understanding');
  assert.ok(result.task_understanding.constraints.includes('must NOT submit the form'),
    `Constraints should include "must NOT submit the form", got: ${JSON.stringify(result.task_understanding.constraints)}`);
  assert.strictEqual(result.action.action, 'DONE', 'Action should be DONE when user says don\'t submit');
  assert.strictEqual(result.isTerminal, true, 'Should be terminal');
});

test('Diagnostic output: page_understanding included', () => {
  const client = new GPTOSSClient('http://localhost:9999');
  const observation = {
    page: { page_type: 'login', title: 'Login' },
    elements: [
      { id: 'el_1', dom: { tag: 'input', type: 'text', label: 'Username', name: 'name' }, interaction: { clickable: false, typeable: true, uploadable: false } }
    ]
  };

  const result = client._localPlannerFallback(
    'Fill my name.',
    observation,
    []
  );

  assert.ok(result.page_understanding, 'Should contain page_understanding');
  assert.strictEqual(result.page_understanding.page_type, 'login');
  // 'Fill my name.' triggers the bulk FormAnalyzer path (fused-shape aware),
  // so a single-field form yields FILL_FORM_PLAN, not per-field TYPE.
  assert.strictEqual(result.action.action, 'FILL_FORM_PLAN', 'Should bulk-fill the field');
  assert.ok((result.action.value.fields || []).some((f) => f.field_id === 'el_1'));
});

test('Simple click task produces correct action', () => {
  const client = new GPTOSSClient('http://localhost:9999');
  const observation = {
    page: { page_type: 'application_form' },
    elements: [
      { id: 'el_1', dom: { tag: 'button', type: 'submit', label: 'Submit Application' }, interaction: { clickable: true, typeable: false, uploadable: false } }
    ]
  };

  const result = client._localPlannerFallback(
    'Click the submit button.',
    observation,
    []
  );

  // "Click the submit button" doesn't say "don't submit", so it should not be blocked
  assert.ok(result.task_understanding, 'Should contain task_understanding');
  assert.ok(!result.task_understanding.constraints.includes('must NOT submit the form'),
    'Should NOT have doNotSubmit constraint for "click submit"');
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

test('Planner Flow: "open youtube and most popular karan aujla" executes clean subgoals sequentially', async () => {
  const client = new GPTOSSClient('http://localhost:9999'); // forces local deterministic planner
  const { TaskState } = await import('../../extension/reasoning/task-understanding.js');
  const state = new TaskState('open youtube and most popular karan aujla');

  // Initial step: on YouTube, search input and Mix button exist
  const observation = {
    page: { domain: 'youtube.com', title: 'YouTube' },
    elements: [
      { id: 'el_search', dom: { tag: 'input', id: 'search', name: 'search_query', placeholder: 'Search' }, interaction: { typeable: true } },
      { id: 'el_search_btn', dom: { tag: 'button', id: 'search-icon-legacy', label: 'Search' }, interaction: { clickable: true } },
      { id: 'el_mix', dom: { tag: 'a', label: 'Mix', href: '/watch?v=mix123' }, interaction: { clickable: true } }
    ]
  };

  // Navigation already happened
  const history = [
    { action: { action: 'NAVIGATE', target: { url: 'https://www.youtube.com' } }, success: true }
  ];
  state.advance(history[0].action, observation, { success: true });

  // Step 1 of reasoning: Planner MUST type clean query "karan aujla", NOT the raw prompt, and MUST NOT click Mix
  const step1 = client._localPlannerFallback(
    'open youtube and most popular karan aujla',
    observation,
    history,
    state
  );

  assert.strictEqual(step1.action.action, 'TYPE', 'Should type into search input');
  assert.strictEqual(step1.action.target.element_id, 'el_search');
  assert.strictEqual(step1.action.value, 'karan aujla', 'Must type clean query "karan aujla", NOT the full prompt!');

  // Record typing in history
  history.push({ action: step1.action, success: true });

  // Step 2: Click search button
  const step2 = client._localPlannerFallback(
    'open youtube and most popular karan aujla',
    observation,
    history,
    state
  );
  assert.strictEqual(step2.action.action, 'CLICK', 'Should click search button');
  assert.strictEqual(step2.action.target.element_id, 'el_search_btn');

  // Record search click and advance state
  history.push({ action: step2.action, success: true });
  state.advance(step2.action, observation, { success: true });

  // Step 3: On search results page, find popular video result
  const resultsObservation = {
    page: { domain: 'youtube.com/results', title: 'karan aujla - YouTube' },
    elements: [
      { id: 'el_search', dom: { tag: 'input', id: 'search', name: 'search_query', value: 'karan aujla' }, interaction: { typeable: true } },
      { id: 'el_prev_btn', dom: { tag: 'button', label: 'Previous' }, interaction: { clickable: true } },
      { id: 'el_video_1', dom: { tag: 'a', id: 'video-title', label: 'Karan Aujla - Tauba Tauba (100M views)', href: '/watch?v=abc' }, interaction: { clickable: true } }
    ]
  };

  const step3 = client._localPlannerFallback(
    'open youtube and most popular karan aujla',
    resultsObservation,
    history,
    state
  );
  assert.strictEqual(step3.action.action, 'CLICK', 'Should click video result');
  assert.strictEqual(step3.action.target.element_id, 'el_video_1');
  assert.ok(!step3.action.target.label.includes('Previous'), 'Must not click Previous button');

  // Record video click and advance state
  history.push({ action: step3.action, success: true });
  state.advance(step3.action, resultsObservation, { success: true });

  // Step 4: Verification / Goal achieved
  const step4 = client._localPlannerFallback(
    'open youtube and most popular karan aujla',
    resultsObservation,
    history,
    state
  );
  assert.strictEqual(step4.action.action, 'DONE', 'Should mark task as DONE after result is playing');
  assert.strictEqual(step4.isTerminal, true);
});

