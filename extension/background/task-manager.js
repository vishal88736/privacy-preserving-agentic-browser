/**
 * Task Manager
 * Tracks active task state, execution history, privacy metrics,
 * user-facing error detail, and agent settings.
 */

import { AgentState } from '../shared/constants.js';

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: 'http://localhost:8000',
  maxSteps: 25,
  alwaysConfirm: true,
  showDebug: false
});

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
      CREDIT_CARD: 'payment card number', API_KEY: 'API key', TOKEN: 'access token'
    };
    const detected = labels[category] || (category ? 'sensitive information' : null);
    return {
      error: detected
        ? `A local privacy check detected a possible ${detected} in page context and blocked the request.`
        : 'A local privacy check blocked a request that may contain sensitive information.',
      hint: 'The blocked request was not sent. Check the page context and retry, or continue manually. The value itself was not shown.'
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
    this._loadSettings();
  }

  async _loadSettings() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get('privagent_settings');
        if (stored?.privagent_settings) {
          this.settings = { ...DEFAULT_SETTINGS, ...stored.privagent_settings };
        }
      }
    } catch { /* keep defaults */ }
  }

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...(patch || {}) };
    this.settings.maxSteps = Math.min(50, Math.max(1, Number(this.settings.maxSteps) || DEFAULT_SETTINGS.maxSteps));
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ privagent_settings: this.settings });
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
      steps: [],
      visionSamples: [],
      privacyMetrics: {
        sensitiveFieldsDetected: 0,
        sensitiveFieldsCurrent: 0,
        secretsKeptLocal: 0,
        redactedRegionsCount: 0,
        serverCallsCount: 0,
        localVisionLatencyMs: 0,
        localModelAssetBytes: null,
        localOcrPiiRegions: 0,
        localPeopleMasked: 0,
        detectedCategories: []
      },
      currentStep: 0,
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

  updateState(newState, detail = '') {
    if (this.currentTask) {
      this.currentTask.state = newState;
      if (detail) this.currentTask.stateDetail = detail;
    }
  }

  recordStep(stepData) {
    if (this.currentTask) {
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

  updatePrivacyMetrics(metricsUpdate) {
    if (this.currentTask) {
      const pm = this.currentTask.privacyMetrics;
      if (metricsUpdate.sensitiveFieldsDetected) pm.sensitiveFieldsDetected += metricsUpdate.sensitiveFieldsDetected;
      // Per-observation (current page) counts overwrite; cumulative totals above accumulate.
      if (typeof metricsUpdate.sensitiveFieldsDetected === 'number') pm.sensitiveFieldsCurrent = metricsUpdate.sensitiveFieldsDetected;
      if (typeof metricsUpdate.redactedRegionsCount === 'number') pm.redactedRegionsCurrent = metricsUpdate.redactedRegionsCount;
      if (metricsUpdate.secretsKeptLocal) pm.secretsKeptLocal += metricsUpdate.secretsKeptLocal;
      if (metricsUpdate.redactedRegionsCount) pm.redactedRegionsCount += metricsUpdate.redactedRegionsCount;
      if (metricsUpdate.serverCallsCount) pm.serverCallsCount += metricsUpdate.serverCallsCount;
      if (typeof metricsUpdate.localVisionLatencyMs === 'number') pm.localVisionLatencyMs += metricsUpdate.localVisionLatencyMs;
      if (typeof metricsUpdate.localModelAssetBytes === 'number') pm.localModelAssetBytes = metricsUpdate.localModelAssetBytes;
      if (typeof metricsUpdate.localOcrPiiRegions === 'number') pm.localOcrPiiRegions += metricsUpdate.localOcrPiiRegions;
      if (typeof metricsUpdate.localPeopleMasked === 'number') pm.localPeopleMasked += metricsUpdate.localPeopleMasked;
      if (metricsUpdate.detectedCategories) {
        const set = new Set([...pm.detectedCategories, ...metricsUpdate.detectedCategories]);
        pm.detectedCategories = Array.from(set);
      }
    }
  }

  setPendingConfirmation(action, reason) {
    if (this.currentTask) {
      this.currentTask.state = AgentState.WAITING_FOR_USER;
      this.currentTask.pendingConfirmation = { action, reason, timestamp: Date.now() };
      this.persist();
    }
  }

  clearPendingConfirmation() {
    if (this.currentTask) {
      this.currentTask.pendingConfirmation = null;
    }
  }

  setPendingUserInput(inputData) {
    if (this.currentTask) {
      this.currentTask.state = AgentState.WAITING_FOR_USER;
      this.currentTask.pendingUserInput = { ...inputData, timestamp: Date.now() };
      this.persist();
    }
  }

  clearPendingUserInput() {
    if (this.currentTask) {
      this.currentTask.pendingUserInput = null;
    }
  }

  completeTask(result = 'Task completed successfully') {
    if (this.currentTask) {
      this.currentTask.state = AgentState.COMPLETED;
      this.currentTask.result = result;
      this.currentTask.endTime = Date.now();
      this.persist();
    }
  }

  failTask(rawError) {
    if (this.currentTask) {
      const { error, hint } = friendlyError(rawError);
      this.currentTask.state = AgentState.FAILED;
      this.currentTask.error = error;
      this.currentTask.hint = hint;
      this.currentTask.rawError = String(rawError || '').slice(0, 300);
      this.currentTask.endTime = Date.now();
      this.persist();
    }
  }

  cancelTask() {
    if (this.currentTask) {
      this.currentTask.state = AgentState.CANCELLED;
      this.currentTask.pendingConfirmation = null;
      this.currentTask.pendingUserInput = null;
      this.currentTask.endTime = Date.now();
      this.persist();
    }
  }

  /** Best-effort snapshot so the panel can restore after SW restart. */
  persist() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        const t = this.currentTask;
        if (!t) return;
        chrome.storage.session.set({
          privagent_task: {
            id: t.id, prompt: t.prompt, tabId: t.tabId, state: t.state,
            currentStep: t.currentStep, maxSteps: t.maxSteps,
            result: t.result || null, error: t.error || null, hint: t.hint || null,
            pendingConfirmation: t.pendingConfirmation || null,
            pendingUserInput: t.pendingUserInput || null,
            privacyMetrics: t.privacyMetrics,
            lastLLMPayload: t.lastLLMPayload || null,
            visionSamples: (t.visionSamples || []).slice(-40),
            steps: (t.steps || []).slice(-20)
          }
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }
}

export const taskManager = new TaskManager();
