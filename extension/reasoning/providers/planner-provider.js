/**
 * Planner provider seam.
 *
 * The production planner is the server reasoning endpoint. This module exists so
 * that a local planner can be introduced later as a *provider* rather than as a
 * rewrite of the agent loop: the controller depends on this interface, not on a
 * transport.
 *
 * It is deliberately NOT implemented with a local LLM. See
 * `docs/ARCHITECTURE_DECISIONS.md` for the size, memory, download, and Firefox
 * arithmetic that rules that out today, and for what would have to change first.
 *
 * Design rules that any future provider must uphold:
 *
 *  1. It receives SANITIZED context only — exactly what `ServerPlannerProvider`
 *     receives. A local planner is not a licence to move private values off
 *     the device or into a prompt unredacted.
 *  2. It returns the same structured action contract, so the safety gate, the
 *     vault-backed value resolver, and the executor are unchanged.
 *  3. It is advisory about risk and confirmation. A local model must not be
 *     able to lower `risk` or set `requires_confirmation: false` to bypass a
 *     human approval; the gate re-derives risk from the action, not the model.
 *  4. It must be able to report "unavailable" and let the provider chain fall
 *     through, so a local planner can never strand a task when the model fails
 *     to load.
 */

/** @typedef {'server'|'local'} PlannerProviderId */

/** Sentinel a provider returns when it cannot serve a request. */
export const PLANNER_UNAVAILABLE = Object.freeze({
  available: false,
  reason: 'provider-unavailable',
  result: null
});

const DEFAULT_TIMEOUT_MS = 25000;

/** A provider that always reports unavailable. The production default today. */
export class DisabledPlannerProvider {
  constructor(id = 'disabled') {
    this.id = id;
  }

  get available() { return false; }

  async plan() { return { ...PLANNER_UNAVAILABLE, reason: `${this.id}: disabled` }; }
}

/**
 * Adapts the existing server reasoning client to the provider interface.
 *
 * This is the only provider wired into the agent loop today. It is a thin
 * adapter: no new behaviour, so the current end-to-end path is unchanged.
 */
export class ServerPlannerProvider {
  constructor(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!client || typeof client.planNextStep !== 'function') {
      throw new TypeError('ServerPlannerProvider requires a client with planNextStep()');
    }
    this.id = 'server';
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  get available() { return true; }

  /**
   * @param {object} request sanitized observation + task + history
   * @returns {Promise<{available: boolean, reason: string|null, result: object|null}>}
   */
  async plan(request) {
    const { task, fusedObservation, taskHistory, taskState, pageState } = request || {};
    try {
      const result = await this.client.planNextStep(task, fusedObservation, taskHistory, taskState, pageState);
      // The client's dead-man and privacy-block results are passed through
      // untouched so the controller's existing handling keeps working.
      if (result?.plannerUnavailable) {
        return { available: false, reason: 'server-unavailable', result };
      }
      if (result?.privacyBlocked) {
        return { available: true, reason: 'privacy-blocked', result };
      }
      return { available: true, reason: null, result };
    } catch (error) {
      return { available: false, reason: 'server-error', result: null, error };
    }
  }
}

/**
 * Placeholder for a future on-device planner (for example a WebGPU-hosted
 * small language model). It is inert by construction: `available` is false, so
 * a chain that includes it degrades to the server provider instead of
 * silently producing worse plans.
 *
 * When this is implemented, the model must be loaded from packaged assets only,
 * or the zero-runtime-download guarantee must be renegotiated explicitly.
 */
export class FutureLocalPlannerProvider {
  constructor({ id = 'future-local', modelId = null } = {}) {
    this.id = id;
    this.modelId = modelId;
  }

  get available() { return false; }

  async plan() {
    return {
      ...PLANNER_UNAVAILABLE,
      reason: `${this.id}: not implemented (no local model is packaged)`
    };
  }
}

/** Named extension point for a future RunAnywhere-backed local planner.
 *
 * This is intentionally only a disabled provider. PrivAgent has no packaged
 * local language model and this class must not fetch or cache one.
 */
export class FutureRunAnywherePlannerProvider extends FutureLocalPlannerProvider {
  constructor(options = {}) {
    super({ id: 'future-runanywhere', ...options });
  }
}

/**
 * Ordered provider chain. The first available provider that returns a usable
 * result wins; if every provider reports unavailable the last reason is
 * surfaced so the task fails with an honest cause rather than a silent stall.
 */
export class PlannerProviderChain {
  constructor(providers = []) {
    this.providers = providers.filter(Boolean);
  }

  get available() { return this.providers.length > 0; }

  async plan(request) {
    if (!this.providers.length) {
      return { ...PLANNER_UNAVAILABLE, reason: 'no providers configured' };
    }
    let lastReason = 'all planners unavailable';
    for (const provider of this.providers) {
      let outcome;
      try {
        outcome = await provider.plan(request);
      } catch (error) {
        lastReason = `${provider.id}: threw`;
        continue;
      }
      if (outcome?.available) return outcome;
      lastReason = outcome?.reason || `${provider.id}: unavailable`;
    }
    return { available: false, reason: lastReason, result: null };
  }
}

/**
 * The composition used in production: the local provider is present in the
 * chain as an explicit, inert seam so adding one later is a wiring change, not
 * an architectural change.
 */
export function createDefaultPlannerChain(client) {
  return new PlannerProviderChain([
    new DisabledPlannerProvider(),
    new FutureRunAnywherePlannerProvider(),
    new ServerPlannerProvider(client)
  ]);
}
