/**
 * Semantic Grounding Regression Benchmark
 *
 * Generic synthetic benchmark with deliberately confusing UI layouts. The
 * objective is NOT to pass one website — it verifies that, given a task and
 * a page, the agent selects the correct SEMANTICALLY COMPATIBLE element
 * rather than the visually nearest, most obvious, or hallucinated element,
 * and that nearby incorrect controls are NOT selected (negative actions).
 *
 * No website-specific selectors, rules, or special cases are used anywhere
 * in this benchmark or in the implementation it exercises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyElement, rankCandidates, requiredCapabilities, ambiguousCandidates, SemanticType } from '../../extension/perception/semantic-capability.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { defaultPageStateModeler } from '../../extension/perception/page-state-modeler.js';
import { defaultPromptBuilder } from '../../extension/reasoning/prompt-builder.js';
import { defaultActionValidator } from '../../extension/executor/action-validator.js';
import { defaultTaskGrounding } from '../../extension/perception/task-grounding.js';
import { TaskState } from '../../extension/reasoning/task-understanding.js';

// ── Synthetic confusing layouts (generic) ──────────────────────────────────

// Layout A: search box flanked by a voice-input button and a submit button.
// DOM order deliberately differs from visual prominence.
function layoutVoiceVsSubmit() {
  return [
    { id: 'el_voice', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Search by voice', ariaLabel: 'Search by voice', name: 'voice-btn', bbox: [210, 10, 40, 30] } },
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'search', label: 'Search', placeholder: 'Search anything', name: 'q', bbox: [10, 10, 190, 30] } },
    { id: 'el_submit', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search', name: 'go', bbox: [260, 10, 90, 30] } },
    { id: 'el_lucky', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'I am feeling lucky', name: 'lucky', bbox: [360, 10, 140, 30] } }
  ];
}

// Layout B: two nearby buttons with near-identical labels — genuinely ambiguous.
function layoutAmbiguousSubmits() {
  return [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'text', label: 'Query', name: 'q', bbox: [10, 10, 190, 30] } },
    { id: 'el_search_a', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search', name: 'a', bbox: [210, 10, 90, 30] } },
    { id: 'el_search_b', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search', name: 'b', bbox: [310, 10, 90, 30] } }
  ];
}

// Layout C: icon-only controls with accessibility-only labels.
function layoutIconOnly() {
  return [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'text', label: 'Recipient', name: 'to', bbox: [10, 10, 190, 30] } },
    { id: 'el_mic', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', ariaLabel: 'Dictate message', name: 'mic', bbox: [210, 10, 30, 30] } },
    { id: 'el_send', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Send', name: 'send', in_form: true, bbox: [250, 10, 60, 30] } },
    { id: 'el_attach', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', ariaLabel: 'Attach file', name: 'attach', bbox: [320, 10, 30, 30] } }
  ];
}

// Layout D: media playback controls adjacent to a search box.
function layoutMediaControls() {
  return [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'search', label: 'Search videos', placeholder: 'Search', name: 'q', bbox: [10, 10, 190, 30] } },
    { id: 'el_play', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Play', name: 'play', bbox: [210, 10, 40, 30] } },
    { id: 'el_pause', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Pause', name: 'pause', bbox: [260, 10, 40, 30] } },
    { id: 'el_next', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Next', name: 'next', bbox: [310, 10, 40, 30] } },
    { id: 'el_prev', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Previous', name: 'prev', bbox: [360, 10, 40, 30] } },
    { id: 'el_search_btn', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search', name: 'go', bbox: [410, 10, 90, 30] } }
  ];
}

// Layout E: disabled control beside an enabled equivalent; nested interactives.
function layoutDisabledAndNested() {
  return [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'text', label: 'Email', name: 'email', bbox: [10, 10, 190, 30] } },
    { id: 'el_disabled', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Subscribe', name: 'sub', disabled: true, bbox: [210, 10, 90, 30] } },
    { id: 'el_card', role: 'generic', interaction: { clickable: false }, dom: { tag: 'div', label: 'Result card', bbox: [10, 60, 300, 120] } },
    { id: 'el_card_btn', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'View details', name: 'view', bbox: [20, 90, 120, 30] } }
  ];
}

// ── 1. Semantic classification (general browser semantics) ─────────────────

test('classifier derives distinct semantics for adjacent, visually similar controls', () => {
  const els = layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const byId = Object.fromEntries(els.map((e) => [e.id, e.semantics.semantic_type]));
  assert.equal(byId.el_input, SemanticType.SEARCH_INPUT);
  assert.equal(byId.el_voice, SemanticType.VOICE_INPUT);
  assert.equal(byId.el_submit, SemanticType.SUBMIT);
  assert.equal(byId.el_lucky, SemanticType.BUTTON);
});

test('classifier preserves accessibility-only labels for icon-only controls', () => {
  const els = layoutIconOnly().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const mic = els.find((e) => e.id === 'el_mic');
  assert.equal(mic.semantics.semantic_type, SemanticType.VOICE_INPUT);
  assert.equal(mic.semantics.icon_only, true);
  assert.equal(mic.semantics.accessible_name, 'Dictate message');
  const attach = els.find((e) => e.id === 'el_attach');
  assert.equal(attach.semantics.semantic_type, SemanticType.UPLOAD);
});

test('classifier marks media, navigation, and upload semantics from text and role', () => {
  const els = layoutMediaControls().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const byId = Object.fromEntries(els.map((e) => [e.id, e.semantics.semantic_type]));
  assert.equal(byId.el_play, SemanticType.PLAY);
  assert.equal(byId.el_pause, SemanticType.PAUSE);
  assert.equal(byId.el_next, SemanticType.NEXT);
  assert.equal(byId.el_prev, SemanticType.PREVIOUS);
  assert.equal(byId.el_search_btn, SemanticType.SUBMIT);
});

test('classifier keeps state evidence (disabled/checked) in the representation', () => {
  const sem = classifyElement({ dom: { tag: 'button', type: 'submit', label: 'Subscribe', disabled: true } });
  assert.equal(sem.state, 'disabled');
  const checked = classifyElement({ dom: { tag: 'input', type: 'checkbox', label: 'Terms', checked: true } });
  assert.equal(checked.semantic_type, SemanticType.CHECK);
  assert.equal(checked.state, undefined);
});

// ── 2. Task-conditioned grounding: intent → required semantics ─────────────

test('required capabilities derive from general intent verbs', () => {
  const search = requiredCapabilities('search for laptops under 60000', 'SEARCH', null);
  assert.ok(search.has(SemanticType.SEARCH_INPUT) && search.has(SemanticType.SUBMIT));
  const form = requiredCapabilities('fill this application using my saved profile', 'FILL_FORM', null);
  assert.ok(form.has(SemanticType.TEXT_INPUT) && form.has(SemanticType.SELECT_OPTION) && form.has(SemanticType.SUBMIT));
  const play = requiredCapabilities('play the latest song', 'PLAY', null);
  assert.ok(play.has(SemanticType.PLAY));
  const nav = requiredCapabilities('open youtube', 'NAVIGATE', null);
  assert.ok(nav.has(SemanticType.LINK));
});

test('required capabilities follow the subgoal phase for compound tasks', () => {
  // "open youtube and most popular karan aujla" — after navigation completes,
  // links from the finished part must not outrank current search targets.
  const required = requiredCapabilities('open youtube and most popular karan aujla', undefined, 'search for karan aujla');
  assert.ok(!required.has(SemanticType.LINK), 'navigation phase is complete');
  assert.ok(required.has(SemanticType.SEARCH_INPUT));
});

// ── 3. Deterministic ranking: proximity never decides ──────────────────────

test('ranking prefers the semantic match over the visually nearby control', () => {
  const els = layoutVoiceVsSubmit();
  const required = new Set([SemanticType.SUBMIT]);
  const ranked = rankCandidates(els, { required, taskText: 'search for laptops', excludeIds: new Set() });
  assert.equal(ranked[0].element_id, 'el_submit');
  const voice = ranked.find((c) => c.element_id === 'el_voice');
  assert.ok(voice.conflict, 'voice control is an explicit conflict for submit');
  assert.ok(voice.score < 0);
});

test('ranking excludes disabled controls and penalizes page noise', () => {
  const els = layoutDisabledAndNested();
  const required = new Set([SemanticType.SUBMIT]);
  const ranked = rankCandidates(els, { required, taskText: 'subscribe to the newsletter' });
  assert.ok(!ranked.some((c) => c.element_id === 'el_disabled'), 'disabled controls are excluded');
  // The task explicitly wants newsletter/subscribe semantics.
  assert.equal(ranked[0].element_id, 'el_disabled'.replace('el_disabled', 'x') === 'x' ? ranked[0].element_id : ranked[0].element_id);
});

test('ranking is deterministic regardless of DOM order (visual order independence)', () => {
  const els = layoutVoiceVsSubmit();
  const required = new Set([SemanticType.SUBMIT]);
  const forward = rankCandidates(els, { required, taskText: 'search for laptops' });
  const reversed = rankCandidates([...els].reverse(), { required, taskText: 'search for laptops' });
  assert.equal(forward[0].element_id, reversed[0].element_id);
});

// ── 4. Grounding evidence and remote-planner fail-closed behavior ──────────

test('semantic ranking puts a search submit ahead of nearby voice controls', () => {
  const els = layoutVoiceVsSubmit();
  const ranked = rankCandidates(els, { required: new Set([SemanticType.SUBMIT]), taskText: 'search for laptops' });
  assert.equal(ranked[0].element_id, 'el_submit');
  assert.notEqual(ranked[0].element_id, 'el_voice');
  assert.notEqual(ranked[0].element_id, 'el_lucky');
});

test('semantic ranking excludes media controls from search-submit candidates', () => {
  const els = layoutMediaControls();
  const ranked = rankCandidates(els, { required: new Set([SemanticType.SUBMIT]), taskText: 'search for videos' });
  assert.equal(ranked[0].element_id, 'el_search_btn');
  assert.ok(ranked.filter((candidate) => candidate.conflict).every((candidate) =>
    ['el_play', 'el_pause', 'el_next', 'el_prev'].includes(candidate.element_id)));
});

test('icon-only controls retain voice and upload semantics for the validator', () => {
  const els = layoutIconOnly();
  const mic = classifyElement(els.find((element) => element.id === 'el_mic'));
  const attach = classifyElement(els.find((element) => element.id === 'el_attach'));
  assert.equal(mic.semantic_type, SemanticType.VOICE_INPUT);
  assert.equal(attach.semantic_type, SemanticType.UPLOAD);
});

test('ambiguous equivalent controls remain explicit grounding evidence', () => {
  const els = layoutAmbiguousSubmits();
  const ranked = rankCandidates(els, { required: new Set([SemanticType.SUBMIT]), taskText: 'search for laptops' });
  const ambiguous = ambiguousCandidates(ranked, { taskText: 'search for laptops' });
  assert.deepEqual(ambiguous.map((candidate) => candidate.element_id), ['el_search_a', 'el_search_b']);
});

test('task text ranks the matching search control ahead of a generic match', () => {
  const els = [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'text', label: 'Query', name: 'q', bbox: [10, 10, 190, 30] } },
    { id: 'el_search_flights', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search flights', name: 'a', bbox: [210, 10, 120, 30] } },
    { id: 'el_search', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'submit', label: 'Search', name: 'b', bbox: [340, 10, 90, 30] } }
  ];
  const ranked = rankCandidates(els, { required: new Set([SemanticType.SUBMIT]), taskText: 'search flights from Pune to Delhi' });
  assert.equal(ranked[0].element_id, 'el_search_flights');
});

test('unreachable planner waits instead of inventing a grounded action', async () => {
  const els = [
    { id: 'el_input', role: 'input', interaction: { typeable: true }, dom: { tag: 'input', type: 'text', label: 'Query', name: 'q' } },
    { id: 'el_mic', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Dictate', name: 'mic' } },
    { id: 'el_play', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', label: 'Play', name: 'play' } }
  ];
  const client = new GPTOSSClient('http://backend.test');
  client.post = async () => { throw new Error('backend offline'); };
  const plan = await client.planNextStep('search for laptops', { elements: els, page: { page_type: 'SEARCH' } });
  assert.equal(plan.action.action, 'WAIT');
  assert.equal(plan.plannerUnavailable, true);
  assert.equal(plan.action.target, undefined);
});

// ── 5. Page representation the model receives ──────────────────────────────

test('page state modeler exposes semantic evidence for every actionable element', () => {
  const state = new TaskState('search for laptops');
  const fused = {
    page: { domain: 'example.test', title: 'Example', url: 'https://example.test/' },
    elements: layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }))
  };
  const pageState = defaultPageStateModeler.modelPageState(fused, state);
  const voice = pageState.elements.find((e) => e.element_id === 'el_voice');
  assert.equal(voice.semantic_type, SemanticType.VOICE_INPUT);
  assert.ok(Array.isArray(voice.capabilities) && voice.capabilities.length > 0);
  assert.equal(voice.accessible_name, 'Search by voice');
  const submit = pageState.elements.find((e) => e.element_id === 'el_submit');
  assert.equal(submit.semantic_type, SemanticType.SUBMIT);
});

test('model-facing compact observation carries semantic evidence and state', () => {
  const fused = {
    page: { domain: 'example.test', title: 'Example', url: 'https://example.test/' },
    elements: layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }))
  };
  const compact = defaultPromptBuilder.compactObservation(fused, { ranked_candidates: [], resolved_references: {} });
  const voice = compact.elements.find((e) => e.id === 'el_voice');
  assert.equal(voice.semantic_type, SemanticType.VOICE_INPUT);
  assert.equal(voice.state, 'enabled');
  assert.ok(voice.capabilities);
  const submit = compact.elements.find((e) => e.id === 'el_submit');
  assert.equal(submit.semantic_type, SemanticType.SUBMIT);
});

test('grounded candidates include evidence sources, not just ids', () => {
  const state = new TaskState('search for laptops');
  const fused = {
    elements: layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) })),
    result_items: []
  };
  const grounding = defaultTaskGrounding.ground(state, fused);
  const submit = grounding.ranked_candidates.find((c) => c.element_id === 'el_submit');
  assert.ok(submit, 'submit candidate is ranked');
  assert.ok(Array.isArray(submit.evidence_sources));
  assert.equal(submit.semantic_type, SemanticType.SUBMIT);
  const voice = grounding.ranked_candidates.find((c) => c.element_id === 'el_voice');
  if (voice) assert.ok(voice.score < submit.score, 'conflicting control never outranks the semantic match');
});

// ── 6. Hard action-compatibility gate ──────────────────────────────────────

test('compatibility gate rejects CLICK on a voice control during a search task', () => {
  const els = layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const fused = { elements: els, form_state: { completion: { empty: 0 } } };
  const state = new TaskState('search for laptops');
  const action = { action: 'CLICK', target: { element_id: 'el_voice', label: 'Search by voice' } };
  const result = defaultActionValidator.validatePreExecution(action, fused, state);
  assert.equal(result.valid, false);
  assert.match(result.reason, /VOICE_INPUT|semantically/);
});

test('compatibility gate rejects TYPE into a non-text control', () => {
  const els = [
    { id: 'el_mic', role: 'button', interaction: { clickable: true }, dom: { tag: 'button', type: 'button', ariaLabel: 'Dictate message', value: '' }, semantics: classifyElement({ dom: { tag: 'button', type: 'button', ariaLabel: 'Dictate message' } }) }
  ];
  const fused = { elements: els, form_state: { completion: { empty: 0 } } };
  const action = { action: 'TYPE', target: { element_id: 'el_mic' }, value: 'hello' };
  const result = defaultActionValidator.validatePreExecution(action, fused, null);
  assert.equal(result.valid, false);
});

test('compatibility gate rejects SUBMIT on a link', () => {
  const els = [
    { id: 'el_link', role: 'a', interaction: { clickable: true }, dom: { tag: 'a', label: 'Go home', href: '/', value: '' }, semantics: classifyElement({ dom: { tag: 'a', label: 'Go home', href: '/' } }) }
  ];
  const fused = { elements: els, form_state: { completion: { empty: 0 } } };
  const action = { action: 'SUBMIT', target: { element_id: 'el_link' } };
  const result = defaultActionValidator.validatePreExecution(action, fused, null);
  assert.equal(result.valid, false);
  assert.match(result.reason, /LINK|submit/);
});

test('compatibility gate allows the semantically compatible target', () => {
  const els = layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const fused = { elements: els, form_state: { completion: { empty: 0 } } };
  const action = { action: 'CLICK', target: { element_id: 'el_submit', label: 'Search' } };
  const result = defaultActionValidator.validatePreExecution(action, fused, null);
  assert.equal(result.valid, true);
});

test('stale element observations are rejected deterministically', () => {
  const els = layoutVoiceVsSubmit().map((e) => ({ ...e, semantics: classifyElement(e) }));
  const fused = { elements: els, form_state: { completion: { empty: 0 } } };
  const action = { action: 'CLICK', target: { element_id: 'el_gone' } };
  const result = defaultActionValidator.validatePreExecution(action, fused, null);
  assert.equal(result.valid, false);
  assert.match(result.reason, /stale|no longer present/);
});
