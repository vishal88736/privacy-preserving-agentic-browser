/**
 * The planner seam. The production planner stays the server; this suite proves
 * a local planner could be added later without touching the agent loop, and
 * that the inert local provider cannot degrade current behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultPlannerChain,
  DisabledPlannerProvider,
  FutureLocalPlannerProvider,
  FutureRunAnywherePlannerProvider,
  PLANNER_UNAVAILABLE,
  PlannerProviderChain,
  ServerPlannerProvider
} from '../../extension/reasoning/providers/planner-provider.js';

const request = { task: 't', fusedObservation: { elements: [] }, taskHistory: [] };

test('a client without planNextStep is rejected at construction', () => {
  assert.throws(() => new ServerPlannerProvider({}), TypeError);
  assert.throws(() => new ServerPlannerProvider(null), TypeError);
});

test('the server provider passes a successful plan through unchanged', async () => {
  const plan = { action: { action: 'CLICK' }, thought: 't' };
  const provider = new ServerPlannerProvider({ planNextStep: async () => plan });
  const out = await provider.plan(request);
  assert.equal(out.available, true);
  assert.equal(out.result, plan);
});

test('the server provider forwards the dead-man and privacy-block results', async () => {
  // These already carry controller-level semantics; the seam must not swallow
  // or reinterpret them.
  const dead = await new ServerPlannerProvider({ planNextStep: async () => ({ plannerUnavailable: true }) }).plan(request);
  assert.equal(dead.available, false);
  assert.equal(dead.reason, 'server-unavailable');

  const blocked = await new ServerPlannerProvider({ planNextStep: async () => ({ privacyBlocked: 'x' }) }).plan(request);
  assert.equal(blocked.available, true, 'a privacy block is a result, not an outage');
  assert.equal(blocked.reason, 'privacy-blocked');
});

test('a throwing client is an outage, not an exception at the caller', async () => {
  const out = await new ServerPlannerProvider({ planNextStep: async () => { throw new Error('boom'); } }).plan(request);
  assert.equal(out.available, false);
  assert.equal(out.reason, 'server-error');
});

test('the future local provider is inert by construction', async () => {
  const p = new FutureLocalPlannerProvider();
  assert.equal(p.available, false);
  const out = await p.plan(request);
  assert.equal(out.available, false);
  assert.match(out.reason, /not implemented/);
  assert.equal(out.result, null);
});

test('the named RunAnywhere extension point is disabled and adds no local model dependency', async () => {
  const provider = new FutureRunAnywherePlannerProvider();
  assert.equal(provider.id, 'future-runanywhere');
  assert.equal(provider.available, false);
  assert.equal((await provider.plan(request)).available, false);
});

test('the disabled provider always reports unavailable', async () => {
  const p = new DisabledPlannerProvider();
  assert.equal(p.available, false);
  assert.equal((await p.plan(request)).available, false);
  assert.equal(PLANNER_UNAVAILABLE.result, null);
});

test('the chain falls through the inert local provider to the server', async () => {
  // This is the production shape: adding the seam changed nothing.
  const plan = { action: { action: 'DONE' } };
  const chain = createDefaultPlannerChain({ planNextStep: async () => plan });
  const out = await chain.plan(request);
  assert.equal(out.available, true);
  assert.equal(out.result, plan);
  assert.deepEqual(chain.providers.map((provider) => provider.id), ['disabled', 'future-runanywhere', 'server']);
});

test('the chain reports the last reason when every provider is unavailable', async () => {
  const chain = new PlannerProviderChain([new FutureLocalPlannerProvider(), new DisabledPlannerProvider()]);
  const out = await chain.plan(request);
  assert.equal(out.available, false);
  assert.equal(out.result, null);
  assert.match(out.reason, /disabled/);
});

test('a provider that throws does not abort the chain', async () => {
  const plan = { action: { action: 'WAIT' } };
  const bad = { id: 'bad', plan: async () => { throw new Error('exploded'); } };
  const chain = new PlannerProviderChain([bad, new ServerPlannerProvider({ planNextStep: async () => plan })]);
  const out = await chain.plan(request);
  assert.equal(out.available, true);
  assert.equal(out.result, plan);
});

test('an empty chain fails honestly instead of stalling', async () => {
  const out = await new PlannerProviderChain([]).plan(request);
  assert.equal(out.available, false);
  assert.equal(out.reason, 'no providers configured');
});
