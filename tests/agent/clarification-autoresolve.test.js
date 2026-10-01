import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../extension/background/agent-controller.js';

/**
 * Clarification auto-resolution.
 *
 * The planner used to answer "please click the first video result" with
 * ASK_USER, handing the agent's own job back to the human. This covers the one
 * shape that is safe to resolve locally — a question describing an on-page
 * interaction, backed by a grounded candidate — and, just as importantly, the
 * shapes that must still stop and ask.
 */

const controller = new AgentController();

const ask = (prompt) => ({
  action: 'ASK_USER',
  risk: 'LOW',
  requires_confirmation: false,
  value: { prompt }
});

// `is_clickable` lives on pageState.elements, NOT on a ranked candidate.
// task-grounding.js never emits it on ranked_candidates; page-state-modeler.js
// computes it onto the element list. The resolver reads it from there, so the
// fixture has to mirror that split -- which is exactly the mismatch that made
// this whole resolver unreachable in production.
const candidate = (elementId, score, extra = {}) => ({
  element_id: elementId,
  label: `Result ${elementId}`,
  accessible_name: `Result ${elementId}`,
  score,
  ...extra
});

const taskWith = (candidates) => ({
  pageState: {
    ranked_candidates: candidates,
    // Tolerate null the way the production shape does.
    elements: (candidates || []).map((c) => ({ id: c.element_id, is_clickable: true }))
  }
});

const resolve = (prompt, candidates, { clickable = true } = {}) => {
  const task = taskWith(candidates);
  if (clickable === false) {
    task.pageState.elements = (candidates || []).map((c) => ({ id: c.element_id, is_clickable: false }));
  }
  return controller._resolveAgentDoableClarification(ask(prompt), {}, task);
};

test('a clarification describing a click on a grounded result is acted on instead', () => {
  const action = resolve(
    'Please click the first video result (e.g. the link titled "History of ISRO") to open the video and start playback.',
    [candidate('el_3', 9), candidate('el_4', 8)]
  );

  assert.equal(action.action, 'CLICK');
  assert.equal(action.target.element_id, 'el_3');
  assert.equal(action.requires_confirmation, false);
});

test('"the top result" also resolves rather than asking the user to choose', () => {
  const action = resolve('Please open the top result for me.', [candidate('el_7', 6)]);
  assert.equal(action.action, 'CLICK');
  assert.equal(action.target.element_id, 'el_7');
});

test('a near-tie is left to the user when the question does not defer the choice', () => {
  // The model did not ask for "the first" or "the top", so a two-point gap is
  // not evidence that one candidate is right.
  assert.equal(
    resolve('Which of these should I use?', [candidate('el_3', 9), candidate('el_4', 8)]),
    null
  );
});

test('a clearly leading candidate resolves even without a deferring phrase', () => {
  const action = resolve('Please open the matching result and continue.', [candidate('el_3', 22), candidate('el_4', 4)]);
  assert.equal(action.action, 'CLICK');
  assert.equal(action.target.element_id, 'el_3');
});

test('an OTP request still asks the user', () => {
  assert.equal(
    resolve('Please click Send Code, then tell me the OTP we receive.', [candidate('el_3', 20)]),
    null
  );
});

test('a CAPTCHA request still asks the user', () => {
  assert.equal(
    resolve('Please click the box, then confirm you are not a robot in the CAPTCHA.', [candidate('el_3', 20)]),
    null
  );
});

test('a request for the user to sign in still asks the user', () => {
  assert.equal(
    resolve('Please click Log in first, then sign in with your own account.', [candidate('el_3', 20)]),
    null
  );
});

test('a request to attach a file still asks the user', () => {
  assert.equal(
    resolve('Please click Choose File and attach the document.', [candidate('el_3', 20)]),
    null
  );
});

test('nothing is invented when the page grounds no clickable candidate', () => {
  assert.equal(resolve('Please click the first result.', []), null);
  assert.equal(resolve('Please click the first result.', null), null);
  // A candidate whose element is NOT marked clickable must not be clicked, even
  // though the candidate itself looks perfect. The flag lives on the element.
  assert.equal(resolve('Please click the first result.', [candidate('el_3', 9)], {
    clickable: false
  }), null);
});

test('a ranked candidate with no matching clickable element is not clicked', () => {
  // Defends the join itself: a candidate id absent from the element list has no
  // clickability evidence, so it must be filtered out rather than assumed.
  const task = {
    pageState: {
      ranked_candidates: [candidate('el_3', 9)],
      elements: [{ id: 'el_other', is_clickable: true }]
    }
  };
  assert.equal(
    controller._resolveAgentDoableClarification(ask('Please click the first result.'), {}, task),
    null
  );
});

test('a candidate that matched nothing is not clicked', () => {
  assert.equal(resolve('Please click the first result.', [candidate('el_3', 0)]), null);
});

test('a question that asks for no on-page interaction is left alone', () => {
  assert.equal(resolve('Which account should I use?', [candidate('el_3', 20)]), null);
  assert.equal(resolve('', [candidate('el_3', 20)]), null);
});

test('only an ASK_USER is ever rewritten', () => {
  const click = { action: 'CLICK', risk: 'LOW', requires_confirmation: false, target: { element_id: 'el_3' } };
  assert.equal(controller._resolveAgentDoableClarification(click, {}, taskWith([candidate('el_3', 9)])), null);
  assert.equal(controller._resolveAgentDoableClarification(null, {}, taskWith([candidate('el_3', 9)])), null);
});
