/**
 * Task Manager
 * Tracks active task state, execution history, privacy metrics,
 * user-facing error detail, and agent settings.
 */

import { AgentState } from '../shared/constants.js';
import {
  BACKEND_TOKEN_STORAGE_KEY,
  deleteEncryptedSecret,
  readEncryptedSecret,
  writeEncryptedSecret
} from '../privacy/vault-crypto.js';

const SETTINGS_STORAGE_KEY = 'privagent_settings';

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: 'http://localhost:8000',
  backendToken: '',
  maxSteps: 25,
  alwaysConfirm: true,
  showDebug: false,
  // The backend URL is the single largest egress surface in the extension: it
  // decides where the sanitized-but-still-sensitive page context is sent. This
  // project is loopback-only by design (the Python side forces HOST to
  // 127.0.0.1), so a non-loopback backend is refused unless the user opts in
  // explicitly. See validateBackendUrl().
  allowRemoteBackend: false
});

/**
 * Validate a user-supplied backend URL.
 *
 * Returns { valid, reason, url }. Rejects non-http(s) schemes outright, and
 * refuses a non-loopback host unless the user has explicitly enabled remote
 * backends. This is the symmetric counterpart to the server's own loopback
 * enforcement: without it, a mistyped or edited setting silently redirects
 * every sanitized observation to an arbitrary host.
 */
export function validateBackendUrl(rawUrl, { allowRemote = false } = {}) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return { valid: false, reason: 'Backend URL is empty.', url: null };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, reason: 'Backend URL is not a valid URL.', url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Backend URL must use http or https.', url: null };
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback && !allowRemote) {
    return {
      valid: false,
      reason: `Refusing a non-loopback backend (${host}). This agent sends page context to its backend; enable "Allow a remote backend" in Settings if you really intend that.`,
      url: null
    };
  }
  return { valid: true, reason: null, url: value.replace(/\/+$/, '') };
}

/** Map raw technical failures to helpful user-facing messages. Never leaks secrets. */
export function friendlyError(rawMessage) {
  const raw = String(rawMessage || 'Unknown error');
  const low = raw.toLowerCase();

  if (low.includes('chrome does not permit') || low.includes('chrome://') || low.includes('browser internal page')) {
    return {
      error: 'This page cannot be automated (browser internal page).',
      hint: 'Open a website or a test portal such as http://localhost:5000, then start the task again.'
    };
  }
  if (low.includes('could not establish connection') || low.includes('target page not responding') || low.includes('failed to observe')) {
    return {
      error: 'The agent could not read the page.',
      hint: 'Reload the page, wait for it to finish loading, then retry. The agent will re-analyze the page.'
    };
  }
  if (low.includes('maximum step limit')) {
    return {
      error: 'The task took too many steps without finishing.',
      hint: 'Try a smaller first step (e.g. fill one section), then continue.'
    };
  }
  if (low.includes('no visible change after')) {
    return {
      error: 'The agent could not confirm that its last action changed the page.',
      hint: 'The action may still have succeeded. Check the page, then dismiss this message or retry from the current state.'
    };
  }
  if (low.includes('repeated the same step')) {
    return {
      error: 'The agent repeated the same step without making progress.',
      hint: 'The page may already reflect the goal (e.g. already submitted). Check the page, then retry with a smaller step.'
    };
  }
  if (low.includes('safety gate') || low.includes('security block')) {
    return {
      error: 'A proposed action was blocked by the safety gate.',
      hint: 'The agent will try a safer alternative, or you can adjust the task.'
    };
  }
  if (low.includes('privacy protection blocked')) {
    return {
      error: 'A local privacy check blocked the AI request.',
      hint: 'The request was not sent. Remove or rephrase the sensitive content, then retry. The value itself was not shown.'
    };
  }
  if (low.includes('outbound policy') || low.includes('unmasked')) {
    // Policy messages contain category/token names only. Extract that safe
    // metadata so a generic warning does not leave the user guessing, and
    // never include the matched value in the UI.
    const match = raw.match(/unredacted\s+([A-Z][A-Z0-9_]*)\s+pattern|raw value of\s+(LOCAL_[A-Z0-9_]+)/i);
    const tokenCategory = match?.[2]?.replace(/^LOCAL_/, '');
    const category = String(match?.[1] || tokenCategory || '').toUpperCase();
    const labels = {
      EMAIL: 'email address', PHONE: 'phone number', FULL_NAME: 'name',
      SSN: 'Social Security number', SIN: 'Social Insurance number',
      NIN: 'National Insurance number', NHS: 'NHS number', IBAN: 'IBAN',
      AADHAAR: 'Aadhaar number', PAN: 'PAN number', DOB: 'date of birth',
      CREDIT_CARD: 'payment card number', CVV: 'card security code',
      OTP: 'one-time code', PASSWORD: 'password', BANK_ACCOUNT: 'bank account number',
      API_KEY: 'API key', TOKEN: 'access token'
    };
    const detected = labels[category] || (category ? 'sensitive information' : null);
    return {
      error: detected
        ? `A local privacy check detected a possible ${detected} in page context and blocked the request.`
        : 'A local privacy check blocked a request that may contain sensitive information.',
      hint: 'The blocked request was not sent. Check the page context and retry, or continue manually. The value itself was not shown.'
    };
  }
  if (low.includes('not authenticated with the backend') || low.includes('not authenticated with the local backend')) {
    // The message is already the actionable instruction. friendlyError would
    // otherwise replace it with the generic default, which is exactly the
    // "error with no clue" experience this branch exists to prevent.
    return {
      error: String(rawMessage),
      hint: 'Open the side panel Settings, paste the value of BACKEND_SHARED_SECRET from your .env into "Backend access token", save, then start the task again.'
    };
  }
  if (low.includes('local credential') || low.includes('not configured')) {
    return {
      error: 'A required value is missing from the local vault.',
      hint: 'Open the vault and add the missing value, then retry.'
    };
  }
  if (low.includes('fetch failed') || low.includes('networkerror') || low.includes('load failed') || low.includes('status: 500') || low.includes('status: 503')) {
    return {
      error: 'The AI service is temporarily unavailable.',
      hint: 'Check that the backend is running, then retry the current step.'
    };
  }
  if (low.includes('ai planner is unavailable')) {
    return {
      error: 'The AI planner is temporarily unavailable.',
      hint: 'Check that the backend is running and configured, then start the task again.'
    };
  }
  if (low.includes('stale dom') || low.includes('no longer present') || low.includes('not found')) {
    return {
      error: 'The agent could not find the target element — the page may have changed.',
      hint: 'It will re-analyze the page. Retry if the problem persists.'
    };
  }
  if (low.includes('user declined') || low.includes('declined action')) {
    return {
      error: 'Stopped — an action was declined.',
      hint: 'You are in control. Adjust the task and start again when ready.'
    };
  }
  // Default: generic message. Raw detail stays in console logs only —
  // never surface raw exceptions (may contain page text or fragments).
  return {
    error: 'The task could not be completed.',
    hint: 'Retry the task, or take control to continue manually.'
  };
}

export class TaskManager {
  constructor() {
    this.currentTask = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this._persistQueue = Promise.resolve();
    this._persistPending = null;
    this.ready = this._loadSettings().then(() => this.restorePersistedTask());
  }

  async _loadSettings() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
        if (stored?.[SETTINGS_STORAGE_KEY]) {
          this.settings = { ...DEFAULT_SETTINGS, ...stored[SETTINGS_STORAGE_KEY] };
        }
        // The backend shared secret authenticates every model call. It is a
        // credential, not a preference, so it is kept out of the settings blob
        // and stored under its own encrypted record instead — otherwise it
        // would sit in plaintext in the profile directory, which is exactly
        // what the vault encryption exists to prevent.
        const tokenRecord = await readEncryptedSecret(BACKEND_TOKEN_STORAGE_KEY);
        if (tokenRecord) this.settings.backendToken = tokenRecord;
      }
    } catch { /* keep defaults */ }
  }

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...(patch || {}) };
    this.settings.maxSteps = Math.min(50, Math.max(1, Number(this.settings.maxSteps) || DEFAULT_SETTINGS.maxSteps));
    const token = typeof patch?.backendToken === 'string' ? patch.backendToken.trim() : null;
    // Refuse to persist a backend URL that would move page context off-device.
    // Validation runs before any write so a rejected value leaves the previous
    // working URL in place rather than half-applying the patch.
    if (typeof patch?.backendUrl === 'string') {
      const check = validateBackendUrl(patch.backendUrl, {
        allowRemote: patch.allowRemoteBackend === true || this.settings.allowRemoteBackend === true
      });
      if (!check.valid) throw new Error(check.reason);
      this.settings.backendUrl = check.url;
    }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        if (token !== null) {
          // Keep it in memory for this session either way; persist it encrypted.
          if (token) await writeEncryptedSecret(BACKEND_TOKEN_STORAGE_KEY, token);
          else await deleteEncryptedSecret(BACKEND_TOKEN_STORAGE_KEY);
        }
        // Never write the token into the settings record.
        const { backendToken, ...persisted } = this.settings;
        persisted.allowRemoteBackend = this.settings.allowRemoteBackend === true;
        this.settings.backendToken = backendToken;
        await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: persisted });
      }
    } catch { /* non-fatal */ }
    return this.settings;
  }

  createTask(userPrompt, tabId) {
    this.currentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      prompt: userPrompt,
      tabId,
      state: AgentState.IDLE,
      stateDetail: '',
      startTime: Date.now(),
      activeStepStartedAt: null,
      activeStepTimings: {},
      lastStepTimings: null,
      terminalStepTimings: null,
      steps: [],
      visionSamples: [],
      privacyMetrics: {
        sensitiveFieldsDetected: 0,
        sensitiveFieldsCurrent: 0,
        secretsKeptLocal: 0,
        redactedRegionsCount: 0,
        redactedRegionsCurrent: 0,
        serverCallsCount: 0,
        privacyBlocks: 0,
        localVisionLatencyMs: 0,
        localModelAssetBytes: null,
        localOcrPiiRegions: 0,
        localPeopleMasked: 0,
        detectedCategories: []
      },
      currentStep: 0,
      taskIntent: null,
      maxSteps: this.settings.maxSteps || DEFAULT_SETTINGS.maxSteps,
      pendingConfirmation: null,
      pendingUserInput: null,
      error: null,
      hint: null,
      consecutiveFailures: 0,
      lastTargetKey: null
    };
    this.persist();
    return this.currentTask;
  }

  getTask() {
    return this.currentTask;
  }

  _isCurrent(expectedTask) {
    return !expectedTask || this.currentTask === expectedTask;
  }

  _isTerminal(task) {
    return [AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(task?.state);
  }

  updateState(newState, detail = '', expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      task.state = newState;
      if (detail) task.stateDetail = detail;
      this.persist();
      return true;
    }
    return false;
  }

  recordStep(stepData, expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      const timingMs = this.captureStepTiming(task);
      if (timingMs) {
        stepData = {
          ...stepData,
          diagnostic: { ...(stepData.diagnostic || {}), timing_ms: timingMs }
        };
      }
      this.currentTask.currentStep++;
      this.currentTask.steps.push({
        stepNumber: this.currentTask.currentStep,
        timestamp: Date.now(),
        ...stepData
      });
      if (stepData?.success === false) {
        this.currentTask.consecutiveFailures = (this.currentTask.consecutiveFailures || 0) + 1;
      } else {
        this.currentTask.consecutiveFailures = 0;
      }
      this.persist();
    }
  }

  updatePrivacyMetrics(metricsUpdate, expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      const pm = task.privacyMetrics;
      // Per-observation counts re-count ALL page fields on every step, so
      // accumulate the delta over the previous observation — otherwise
      // cumulative totals inflate by field-count × steps.
      if (typeof metricsUpdate.sensitiveFieldsDetected === 'number') {
        const prev = pm.sensitiveFieldsCurrent || 0;
        const delta = Math.max(0, metricsUpdate.sensitiveFieldsDetected - prev);
        pm.sensitiveFieldsCurrent = metricsUpdate.sensitiveFieldsDetected;
        pm.sensitiveFieldsDetected = (pm.sensitiveFieldsDetected || 0) + delta;
        pm.secretsKeptLocal = (pm.secretsKeptLocal || 0) + delta;
      }
      if (typeof metricsUpdate.redactedRegionsCount === 'number') {
        const prev = pm.redactedRegionsCurrent || 0;
        const delta = Math.max(0, metricsUpdate.redactedRegionsCount - prev);
        pm.redactedRegionsCurrent = metricsUpdate.redactedRegionsCount;
        pm.redactedRegionsCount = (pm.redactedRegionsCount || 0) + delta;
      }
      if (metricsUpdate.serverCallsCount) pm.serverCallsCount += metricsUpdate.serverCallsCount;
      if (metricsUpdate.privacyBlocks) pm.privacyBlocks = (pm.privacyBlocks || 0) + metricsUpdate.privacyBlocks;
      if (typeof metricsUpdate.localVisionLatencyMs === 'number') pm.localVisionLatencyMs += metricsUpdate.localVisionLatencyMs;
      if (typeof metricsUpdate.localModelAssetBytes === 'number') pm.localModelAssetBytes = metricsUpdate.localModelAssetBytes;
      if (typeof metricsUpdate.localOcrPiiRegions === 'number') pm.localOcrPiiRegions += metricsUpdate.localOcrPiiRegions;
      if (typeof metricsUpdate.localPeopleMasked === 'number') pm.localPeopleMasked += metricsUpdate.localPeopleMasked;
      if (metricsUpdate.detectedCategories) {
        const set = new Set([...pm.detectedCategories, ...metricsUpdate.detectedCategories]);
        pm.detectedCategories = Array.from(set);
      }
      this.persist();
    }
  }

  setPendingConfirmation(action, reason, correlation = {}, expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      // Derived here for the same reason as setPendingUserInput: an approval
      // that cannot be correlated is an approval that can never be delivered.
      const taskId = correlation.taskId || task.id;
      task.state = AgentState.WAITING_FOR_USER;
      task.pendingConfirmation = { action, reason, ...correlation, taskId, timestamp: Date.now() };
      this.persist();
      return true;
    }
    return false;
  }

  clearPendingConfirmation(expectedTask = null) {
    if (this._isCurrent(expectedTask) && this.currentTask) {
      this.currentTask.pendingConfirmation = null;
      this.persist();
      return true;
    }
    return false;
  }

  setPendingUserInput(inputData, correlation = {}, expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      // taskId is derived here rather than trusted from the caller: a call site
      // that forgot it would leave the prompt permanently unanswerable, because
      // handleUserInput fails closed on a taskId mismatch.
      const taskId = correlation.taskId || task.id;
      task.state = AgentState.WAITING_FOR_USER;
      task.pendingUserInput = { ...inputData, ...correlation, taskId, timestamp: Date.now() };
      this.persist();
      return true;
    }
    return false;
  }

  clearPendingUserInput(expectedTask = null) {
    if (this._isCurrent(expectedTask) && this.currentTask) {
      this.currentTask.pendingUserInput = null;
      this.persist();
      return true;
    }
    return false;
  }

  completeTask(result = 'Task completed successfully', expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      if (Number.isFinite(task.activeStepStartedAt)) {
        task.terminalStepTimings = this.captureStepTiming(task);
      }
      task.state = AgentState.COMPLETED;
      task.pendingConfirmation = null;
      task.pendingUserInput = null;
      task.result = result;
      task.endTime = Date.now();
      this.persist();
      return true;
    }
    return false;
  }

  failTask(rawError, expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      if (Number.isFinite(task.activeStepStartedAt)) {
        task.terminalStepTimings = this.captureStepTiming(task);
      }
      const { error, hint } = friendlyError(rawError);
      task.state = AgentState.FAILED;
      task.pendingConfirmation = null;
      task.pendingUserInput = null;
      task.error = error;
      task.hint = hint;
      task.endTime = Date.now();
      this.persist();
      return true;
    }
    return false;
  }

  captureStepTiming(task = this.currentTask) {
    if (!task || !Number.isFinite(task.activeStepStartedAt)) return null;
    const now = globalThis.performance?.now?.() ?? Date.now();
    const timingMs = {
      ...(task.activeStepTimings || {}),
      total_ms: Math.max(0, Math.round(now - task.activeStepStartedAt))
    };
    task.lastStepTimings = timingMs;
    task.activeStepStartedAt = null;
    task.activeStepTimings = {};
    return timingMs;
  }

  /**
   * Restores the last persisted task snapshot after a service-worker restart.
   *
   * A fresh worker has no in-memory loop and no prompt resolvers, so a task
   * that was mid-step cannot be resumed and is honestly downgraded to FAILED.
   * A task that was WAITING_FOR_USER is different: nothing was executing, the
   * decision is still the user's to make, and the pending prompt carries the
   * correlation ids the panel needs to answer it. That prompt is therefore
   * preserved instead of being nulled into a dead modal that silently accepts
   * nothing.
   */
  async restorePersistedTask() {
    if (this.currentTask) return this.currentTask;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.session) return null;
      const stored = await chrome.storage.session.get('privagent_task');
      const snapshot = stored?.privagent_task;
      if (!snapshot || !snapshot.id) return null;
      const restored = {
        ...snapshot,
        steps: snapshot.steps || [],
        visionSamples: snapshot.visionSamples || [],
        privacyMetrics: { ...snapshot.privacyMetrics },
        consecutiveFailures: 0,
        lastTargetKey: null
      };
      if (!this._isTerminal(restored)) {
        const awaitingUser = restored.state === AgentState.WAITING_FOR_USER
          && Boolean(restored.pendingConfirmation || restored.pendingUserInput);
        if (awaitingUser) {
          // Keep the prompt live. AgentController.handleUserConfirmation /
          // handleUserInput finalize the task directly when no resolver
          // survives, so an answer is never silently dropped.
          restored.interruptedWhileAwaitingUser = true;
          restored.stateDetail = 'Waiting for your decision. The agent was restarted, but your approval is still required.';
        } else {
          restored.state = AgentState.FAILED;
          restored.error = 'The browser restarted the agent service before the task finished.';
          restored.hint = 'The interrupted task was stopped safely. Check the page before starting it again.';
          restored.endTime = Date.now();
          restored.pendingConfirmation = null;
          restored.pendingUserInput = null;
        }
      }
      this.currentTask = restored;
      this.persist();
      return restored;
    } catch {
      return null;
    }
  }

  cancelTask(expectedTask = null) {
    const task = this.currentTask;
    if (this._isCurrent(expectedTask) && task && !this._isTerminal(task)) {
      if (Number.isFinite(task.activeStepStartedAt)) {
        task.terminalStepTimings = this.captureStepTiming(task);
      }
      task.state = AgentState.CANCELLED;
      task.pendingConfirmation = null;
      task.pendingUserInput = null;
      task.endTime = Date.now();
      this.persist();
      return true;
    }
    return false;
  }

  /** Best-effort snapshot so the panel can restore after SW restart. */
  persist() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        const t = this.currentTask;
        if (!t) return this._persistQueue;
        // Capture a fresh snapshot at write time and serialize writes. The
        // previous fire-and-forget calls could complete out of order and
        // replace a terminal task with an older EXECUTING snapshot.
        this._persistPending = t;
        this._persistQueue = this._persistQueue.catch(() => {}).then(async () => {
          const latest = this._persistPending;
          this._persistPending = null;
          if (!latest || latest !== this.currentTask) return;
          const snapshot = {
            id: latest.id, prompt: latest.prompt, tabId: latest.tabId, state: latest.state,
            stateDetail: latest.stateDetail || '',
            currentStep: latest.currentStep, maxSteps: latest.maxSteps,
            result: latest.result || null, error: latest.error || null, hint: latest.hint || null,
            pendingConfirmation: latest.pendingConfirmation || null,
            pendingUserInput: latest.pendingUserInput || null,
            privacyMetrics: latest.privacyMetrics,
            lastLLMPayload: latest.lastLLMPayload || null,
            taskIntent: latest.taskIntent || null,
            agentLoopState: latest.agentLoopState || null,
            startTime: latest.startTime,
            endTime: latest.endTime || null,
            // Heartbeat: written on every persist so a restore can tell a task
            // that was waiting on the user (recoverable across a worker restart)
            // from one that was interrupted mid-step (not recoverable).
            lastProgressAt: Date.now(),
            lastStepTimings: latest.lastStepTimings || null,
            terminalStepTimings: latest.terminalStepTimings || null,
            visionSamples: (latest.visionSamples || []).slice(-40),
            steps: (latest.steps || []).slice(-20)
          };
          await chrome.storage.session.set({ privagent_task: snapshot });
          if (this._persistPending && this._persistPending !== latest) this.persist();
        });
        return this._persistQueue.catch(() => {});
      }
    } catch { /* non-fatal */ }
    return Promise.resolve();
  }
}

export const taskManager = new TaskManager();
