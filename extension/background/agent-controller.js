/**
 * Agent Controller
 * Orchestrates the autonomous iterative agent loop:
 * OBSERVE -> SANITIZE -> VISUAL_ANALYSIS -> REASON -> SAFETY_GATE -> ACT -> VERIFY
 *
 * Reliability: bounded retries, per-step error isolation, verification,
 * overlay cleanup, settings-aware execution. Privacy boundary preserved:
 * only sanitized DOM + redacted screenshots leave the device.
 *
 * L1: Post-navigation DOM re-stabilization
 * L2: Improved stuck-loop detection with sliding window
 * L5: Post-action stability wait before next observation
 * L6: Reset consecutiveFailures on subgoal advance
 * L12: Injection quarantine now scans context text and visible_text
 */

import { AgentState, ActionType, RiskLevel } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { taskManager } from './task-manager.js';
import { defaultDOMSanitizer } from '../privacy/dom-sanitizer.js';
import { defaultLocalVault } from '../privacy/local-vault.js';
import { defaultScreenshotSanitizer } from '../privacy/screenshot-sanitizer.js';
import { defaultScreenshotService } from '../perception/screenshot.js';
import { defaultVLMClient } from '../perception/vlm-client.js';
import { defaultObservationFusion } from '../perception/observation-fusion.js';
import { defaultGPTOSSClient } from '../reasoning/gpt-oss-client.js';
import { defaultFormPlanBuilder } from '../reasoning/form-plan-builder.js';
import { defaultRiskGate } from '../executor/risk-gate.js';
import { defaultActionValidator } from '../executor/action-validator.js';
import { defaultActionExecutor } from '../executor/action-executor.js';
import { TaskState, localInterpretTask } from '../reasoning/task-understanding.js';
import { defaultPageStateModeler } from '../perception/page-state-modeler.js';
import {
  PageCapability,
  classifyPageCapability,
  getNavigationGoal,
  getSiteHomepage,
  validateNavigationUrl,
  urlsMatchForVerification
} from '../navigation/navigation.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_ACTIONS = 3;
const NAV_VERIFY_TIMEOUT_MS = 12000;
const NAV_VERIFY_POLL_MS = 500;
const CHROME_API_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

class LocalVisionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalVisionRequiredError';
  }
}

class SupersededTaskError extends Error {
  constructor() {
    super('This task was replaced by a newer task.');
    this.name = 'SupersededTaskError';
  }
}

// L12: Expanded injection patterns — covers more social engineering attacks
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+your\s+(system\s+)?prompt/i,
  /exfiltrat/i,
  /send\s+(the\s+)?(user'?s?\s+)?password/i,
  /disregard\s+(all\s+)?(prior|previous)/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /new\s+system\s+prompt/i,
  /override\s+(all\s+)?(safety|security|rules)/i,
  /reveal\s+(your|the)\s+(secret|password|key|token)/i,
  /output\s+(all|every|the)\s+(secret|password|credential)/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /act\s+as\s+(if|though)\s+you\s+(are|were)/i,
  /pretend\s+(you\s+)?(are|were)\s/i,
  /do\s+not\s+follow\s+(your|the)\s+(rules|instructions)/i,
  /jailbreak/i,
  /prompt\s+injection/i
];

function containsInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

function clockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

async function measureStage(task, name, operation) {
  const started = clockNow();
  try {
    return await operation();
  } finally {
    task.activeStepTimings ||= {};
    task.activeStepTimings[name] = Math.max(0, Math.round(clockNow() - started));
  }
}

function isSparsePageSnapshot(rawDOM) {
  const elements = Array.isArray(rawDOM?.elements) ? rawDOM.elements : [];
  const visible = elements.filter((element) => element && element.is_visible !== false);
  const pageTextLength = String(rawDOM?.visible_text || '').trim().length;
  const headingsCount = Array.isArray(rawDOM?.headings) ? rawDOM.headings.length : 0;
  return visible.length < 3 && pageTextLength < 180 && headingsCount === 0;
}

function visualEvidenceNeed(task, rawDOM) {
  const elements = Array.isArray(rawDOM?.elements) ? rawDOM.elements : [];
  const visible = elements.filter((element) => element && element.is_visible !== false);
  const labeledCount = visible.filter((element) =>
    [element.label, element.ariaLabel, element.accessible_name, element.name, element.placeholder, element.title, element.text]
      .some((value) => typeof value === 'string' && value.trim())
  ).length;
  const prompt = String(task?.prompt || '');
  const explicitVisualRequest = /\b(visual(?:ly)?|image|picture|photo|color|colour|logo|icon|chart|graph|diagram|screenshot|appearance)\b/i.test(prompt) ||
    /\b(?:on|to|at|the)\s+(?:far\s+)?(?:left|right|above|below)\b|\b(?:left|right)\s+of\b|\b(?:above|below)\s+(?:the|a|an|it|that)\b/i.test(prompt);
  const sparseDOM = isSparsePageSnapshot(rawDOM);
  const poorlyLabeledDOM = visible.length >= 4 && labeledCount / visible.length < 0.45;
  return {
    needed: Boolean(rawDOM?.opaqueVisualSurface) || explicitVisualRequest || sparseDOM || poorlyLabeledDOM,
    visualQuery: explicitVisualRequest ? String(task?.prompt || '').slice(0, 500) : null
  };
}

export class AgentController {
  constructor(formPlanBuilder = defaultFormPlanBuilder) {
    this.formPlanBuilder = formPlanBuilder;
    this.activeTabId = null;
    this.isPaused = false;
    this.isCancelled = false;
    this.listeners = new Set();
    this.pendingUserConfirmationResolver = null;
    this.pendingUserInputResolver = null;
    this.runToken = 0;
    this.pauseResolver = null;
    this.pausedFromState = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    taskManager.persist();
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('Listener notification error:', err);
      }
    }
  }

  async startTask(userPrompt, tabId) {
    await taskManager.ready;
    const previousTask = taskManager.getTask();
    // Invalidate any previous loop. Disarm its pending user prompts first so
    // the superseded loop's await resolves and it exits via the token check
    // instead of hanging as a zombie promise or cancelling this new task.
    this.runToken++;
    const token = this.runToken;
    this.activeTabId = tabId;
    this.isPaused = false;
    this.isCancelled = false;
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    }
    this.pausedFromState = null;
    if (previousTask && ![AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(previousTask.state)) {
      taskManager.cancelTask(previousTask);
    }
    if (this.pendingUserConfirmationResolver) {
      const staleResolve = this.pendingUserConfirmationResolver;
      this.pendingUserConfirmationResolver = null;
      staleResolve(false);
    }
    if (this.pendingUserInputResolver) {
      const staleResolve = this.pendingUserInputResolver;
      this.pendingUserInputResolver = null;
      staleResolve({ cancelled: true });
    }
    taskManager.clearPendingConfirmation();
    taskManager.clearPendingUserInput();

    // Apply current settings to network clients (privacy: same sanitized payloads, new host only)
    const settings = taskManager.settings || {};
    if (settings.backendUrl) {
      const base = String(settings.backendUrl).replace(/\/+$/, '');
      defaultVLMClient.baseUrl = base;
      defaultGPTOSSClient.baseUrl = base;
    }
    defaultVLMClient.authToken = String(settings.backendToken || '');
    defaultGPTOSSClient.authToken = String(settings.backendToken || '');

    // Sanitize user prompt to prevent leakage of PII entered directly in the task bar
    const sanitizedPrompt = defaultDOMSanitizer.sanitizeUserPrompt(userPrompt);

    const task = taskManager.createTask(sanitizedPrompt, tabId);
    // Tag ownership so a stale loop can tell its own task from a newer one.
    task.runToken = token;
    task.taskState = new TaskState(sanitizedPrompt);
    task.taskIntent = task.taskState.intent || null;
    if (settings.maxSteps) task.maxSteps = settings.maxSteps;
    this.notify('TASK_STARTED', task);

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, 'Interpreting task goal...', task);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK });

    // Seed task state locally. The first /reason request already receives the
    // complete sanitized request and grounded page state, so a separate remote
    // /interpret roundtrip only adds startup latency.
    task.taskState.updateFromModel(localInterpretTask(sanitizedPrompt));
    console.log("[TASK_INTERPRETED]", JSON.stringify(task.taskState.toPayload()));

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, `Goal: ${task.taskState.goal}`, task);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK, goal: task.taskState.goal });

    this.runLoop(token).catch(err => {
      if (err?.name === 'SupersededTaskError' || taskManager.getTask() !== task) return;
      console.error('Agent loop encountered unhandled error:', err);
      taskManager.failTask(err?.message || 'Unexpected agent error', task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
    });
  }

  _assertTaskOwner(task, token) {
    if (token !== this.runToken || taskManager.getTask() !== task || task?.runToken !== token) {
      throw new SupersededTaskError();
    }
  }

  async _awaitOwned(task, token, promise) {
    const result = await promise;
    this._assertTaskOwner(task, token);
    if (this.isPaused) await this._waitWhilePaused(task, token);
    this._assertTaskOwner(task, token);
    return result;
  }

  async _waitWhilePaused(task, token) {
    while (this.isPaused) {
      await new Promise((resolve) => { this.pauseResolver = resolve; });
      this._assertTaskOwner(task, token);
    }
  }

  async _analyzeScreenshotLocally(screenshot, viewport, expectedSensitiveCounts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      // Keep this below Chrome's single-event five-minute ceiling and short
      // enough that a local model cannot leave a task waiting indefinitely.
      const timeout = setTimeout(() => finish(reject, new LocalVisionRequiredError('Local visual analysis timed out.')), 20000);
      try {
        chrome.runtime.sendMessage({
          type: MessageType.LOCAL_VISION_ANALYZE,
          payload: { screenshot, viewport, expectedSensitiveCounts }
        }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            finish(reject, new LocalVisionRequiredError('Open the agent side panel to run local screenshot analysis.'));
          } else if (!response?.success || response.analysis?.completed !== true) {
            console.error('[AgentController] Local vision failed:', response?.error);
            finish(reject, new LocalVisionRequiredError(response?.error ? `Local vision failed: ${response.error}` : 'Local screenshot analysis did not complete.'));
          } else {
            finish(resolve, response.analysis);
          }
        });
      } catch {
        finish(reject, new LocalVisionRequiredError('The extension could not start local screenshot analysis.'));
      }
    });
  }

  async runLoop(token) {
    const task = taskManager.getTask();

    while (task.state !== AgentState.COMPLETED && task.state !== AgentState.FAILED && task.state !== AgentState.CANCELLED) {
      if (token !== this.runToken || this.isCancelled) {
        // A newer task took over (or an explicit cancel already ran). Cancel
        // the task only if this loop still owns the CURRENT task — cancelling
        // unconditionally would kill the newer task that just started.
        const current = taskManager.getTask();
        if (current && current.runToken === token && current.state !== AgentState.CANCELLED) {
          taskManager.cancelTask(current);
          this.clearOverlays(current.tabId);
          this.notify('TASK_CANCELLED', current);
        }
        break;
      }

      if (this.isPaused) {
        await this._waitWhilePaused(task, token);
        continue;
      }

      if (task.currentStep >= task.maxSteps) {
        taskManager.failTask('Maximum step limit reached without achieving goal', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      if ((task.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
        const lastError = task.steps?.length ? task.steps[task.steps.length - 1].error : 'The agent could not find the target element — the page may have changed.';
        taskManager.failTask(lastError || 'The task encountered too many consecutive errors.', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      // L2: Improved stuck-loop detection
      if (this._isStuckInLoop(task)) {
        console.log("[REPLAN] No progress detected. Agent is stuck in a loop.");
        taskManager.failTask('The agent repeated the same step without making progress.', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      try {
        const shouldContinue = await this._awaitOwned(task, token, this.runSingleStep(task, token));
        if (!shouldContinue) break;
      } catch (stepErr) {
        if (stepErr?.name === 'SupersededTaskError' || token !== this.runToken || taskManager.getTask() !== task) break;
        // Deterministic privacy failure: retrying cannot help (same redacted
        // input would be blocked again). Fail fast with a user-safe message.
        if (stepErr && stepErr.name === 'OutboundPolicyViolationError') {
          console.error('[AgentController] Outbound privacy block, aborting task:', stepErr.message);
          taskManager.failTask(stepErr.message, task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          break;
        }
        if (stepErr && stepErr.name === 'LocalVisionRequiredError') {
          taskManager.failTask('Local screenshot analysis is unavailable. No screenshot was sent to the server.', task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: stepErr.message });
          break;
        }
        // Fail fast on restricted URLs and the extension's own panel tab
        if (stepErr?.message?.includes('Chrome does not permit extensions on internal') ||
            stepErr?.message?.includes('browser internal page') ||
            stepErr?.message?.includes('cannot run inside its own panel tab')) {
          taskManager.failTask(stepErr.message, task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          break;
        }
        console.warn('[AgentController] Step failed, recovering:', stepErr?.message);
        await this._awaitOwned(task, token, measureStage(task, 'step_error_recovery_wait_ms', () => this.sleep(700)));
        taskManager.recordStep({
          thought: `Step encountered a problem (${stepErr?.message || 'Unknown error'}); re-analyzing the page.`,
          action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
          success: false,
          error: String(stepErr?.message || stepErr).slice(0, 200)
        }, task);
        this.notify('STEP_FAILED', {
          stepNumber: task.currentStep,
          thought: `Step encountered a problem (${stepErr?.message || 'Unknown error'}); re-analyzing the page.`,
          action: { action: ActionType.WAIT },
          success: false
        });
      }
    }
  }

  /**
   * Runs one OBSERVE→VERIFY cycle. Returns false when the loop should stop.
   * `token` is the owning loop's run token; a mismatch after an await means a
   * newer task took over and this step must not act on (or cancel) it.
   */
  async runSingleStep(task, token = this.runToken) {
    if (task.runToken == null) task.runToken = token;
    this._assertTaskOwner(task, token);
    task.activeStepStartedAt = clockNow();
    task.activeStepTimings = {};
    // Check current tab URL and classify what this page allows.
    let currentTab = null;
    try {
      currentTab = await this._awaitOwned(task, token, measureStage(task, 'tab_lookup_ms', () =>
        withTimeout(chrome.tabs.get(task.tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.')));
    } catch (e) {
      if (e?.name === 'SupersededTaskError') throw e;
      console.warn('[AgentController] Could not get tab info:', e);
    }
    this._assertTaskOwner(task, token);

    const currentUrl = currentTab?.url || '';
    const capability = classifyPageCapability(currentUrl);
    let taskIntent = task.taskState?.intent;
    if (!taskIntent) {
      try { taskIntent = localInterpretTask(task.prompt).intent; } catch { taskIntent = 'unknown'; }
    }
    console.log(`[TASK] intent=${taskIntent}`);
    try {
      console.log(`[PAGE] capability=${capability} url=${defaultDOMSanitizer.sanitizeUrl(currentUrl) || capability}`);
    } catch {
      console.log(`[PAGE] capability=${capability}`);
    }

    // Capability-aware bootstrap BEFORE any DOM observation: pure NAVIGATE
    // tasks never need content-script extraction (internal pages have none),
    // and compound tasks from internal pages navigate to the site first.
    // Never navigates the extension's own panel tab away.
    const bootstrap = await this._awaitOwned(task, token, this._maybeHandleNavigationBootstrap(task, currentTab, capability, token));
    if (bootstrap?.handled) return bootstrap.shouldContinue;

    if (capability !== PageCapability.AUTOMATABLE_WEB) {
      // Never inject content scripts into browser/extension internals.
      if (capability === PageCapability.EXTENSION_INTERNAL) {
        throw new Error('The agent cannot run inside its own panel tab. Please click on the webpage first, then start the task.');
      }
      throw new Error(`This page cannot be automated (browser internal page: ${capability}). Open a website or test portal (e.g. http://localhost:5000), then start the task again.`);
    }

    // L1/L5: Wait for page to stabilize before observing (handles SPA transitions, AJAX)
    await this._awaitOwned(task, token, measureStage(task, 'stability_wait_ms', () => this._waitForPageStability(task.tabId)));

    // STEP 1: OBSERVE
    taskManager.updateState(AgentState.OBSERVING, 'Reading page structure and layout…', task);
    this.notify('STATE_CHANGED', { state: AgentState.OBSERVING, step: task.currentStep + 1 });

    const observationStarted = clockNow();
    const domResponse = await this._awaitOwned(task, token, measureStage(task, 'dom_capture_ms', () => this._extractDOM(task.tabId)));

    if (!domResponse?.success) {
      throw new Error(`Failed to observe tab: ${domResponse?.error || 'Target page not responding'}. If on a new tab, navigate to a website first.`);
    }

    let rawDOM = domResponse.data;
    // A nearly-empty interactive surface usually means the page is mid-SPA
    // transition (blank frame between routes). Wait briefly and re-extract
    // once before planning against a stale or empty view.
    if (isSparsePageSnapshot(rawDOM)) {
      await this._awaitOwned(task, token, measureStage(task, 'dom_retry_wait_ms', () => this.sleep(500)));
      const reextract = await this._awaitOwned(task, token, measureStage(task, 'dom_retry_ms', () => this._extractDOM(task.tabId)));
      if (reextract?.success && Array.isArray(reextract.data?.elements) &&
          reextract.data.elements.length > rawDOM.elements.length) {
        rawDOM = reextract.data;
      }
    }
    const expectedSensitiveCounts = defaultDOMSanitizer.getUnlocatedSensitiveCounts(rawDOM);
    const visualNeed = visualEvidenceNeed(task, rawDOM);
    let screenshotResponse = { dataUrl: null, captured: false, skipped: true };
    if (visualNeed.needed) {
      screenshotResponse = await this._awaitOwned(task, token, measureStage(task, 'screenshot_capture_ms', async () => {
        try {
          const tab = await withTimeout(chrome.tabs.get(task.tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
          this._assertTaskOwner(task, token);
          return await defaultScreenshotService.captureTab(tab?.windowId ?? null, task.tabId);
        } catch (error) {
          if (error?.name === 'SupersededTaskError') throw error;
          return defaultScreenshotService.captureTab(null, task.tabId);
        }
      }));
      if (screenshotResponse?.captured === false || !screenshotResponse?.dataUrl) {
        console.warn('[AgentController] Screenshot capture failed; continuing from the sanitized DOM only.');
      }
    }
    task.activeStepTimings.observation_ms = Math.max(0, Math.round(clockNow() - observationStarted));
    // Screenshots stay local and are captured only when the live DOM is
    // insufficient, an opaque visual surface exists, or the task asks for
    // visual evidence.
    const screenshotAvailable = Boolean(screenshotResponse?.dataUrl) && screenshotResponse?.captured !== false;

    // Screenshot pixels are sent only to the extension side panel for local
    // object detection and OCR. If capture or analysis is unavailable, remote
    // visual inference stays off and the task continues from sanitized DOM.
    let localVision = null;
    if (screenshotAvailable) {
      try {
        localVision = await this._awaitOwned(task, token, measureStage(task, 'local_vision_ms', () =>
          this._analyzeScreenshotLocally(screenshotResponse.dataUrl, rawDOM.viewport, expectedSensitiveCounts)
        ));
      } catch (visionErr) {
        if (visionErr?.name === 'SupersededTaskError') throw visionErr;
        if (visionErr?.name !== 'LocalVisionRequiredError') throw visionErr;
        console.warn('[AgentController] Local visual analysis unavailable; continuing from sanitized DOM only.');
      }
    }

    // STEP 2: LOCAL PRIVACY SANITIZATION (Client-Side Boundary)
    taskManager.updateState(AgentState.SANITIZING, 'Redacting sensitive fields locally…', task);
    this.notify('STATE_CHANGED', { state: AgentState.SANITIZING });

    const sanitizedPage = await this._awaitOwned(task, token, measureStage(task, 'dom_sanitization_ms', async () => ({
      ...defaultDOMSanitizer.sanitizeElements(rawDOM.elements),
      extras: defaultDOMSanitizer.sanitizePageExtras(rawDOM)
    })));
    const { sanitizedElements, sensitiveCount, detectedCategories } = sanitizedPage;
    const extras = sanitizedPage.extras;
    const screenshotPrivacyAudit = {
      coverageEstablished: Array.isArray(rawDOM.elements),
      // Local OCR compares category counts with the DOM's value-free audit
      // counts. Any unmatched occurrence sets forceWithhold below.
      unlocatedSensitiveText: defaultDOMSanitizer.hasUnlocatedSensitiveText(rawDOM),
      opaqueVisualSurface: Boolean(rawDOM.opaqueVisualSurface),
      maskedCount: sensitiveCount + (localVision ? localVision.piiRegions.length + localVision.people.length : 0),
      localVisionCompleted: localVision?.completed === true,
      forceWithhold: localVision ? localVision.safeToTransmitAfterRedaction !== true : true
    };

    const sanitizedDOM = {
      ...rawDOM,
      // Keep current-page context useful while stripping query values and
      // pattern-shaped PII from URL/title fields before any server request.
      url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
      title: defaultDOMSanitizer.sanitizeUserPrompt(rawDOM.title || ''),
      elements: sanitizedElements,
      headings: extras.headings,
      result_items: extras.result_items,
      visible_text: extras.visible_text,
      scroll: extras.scroll,
      // This contains labels, counts, confidence and geometry only. OCR text is
      // intentionally discarded by the local engine and never reaches IPC.
      local_vision_context: localVision ? {
        model: localVision.model,
        model_revision: localVision.modelRevision,
        people_masked: localVision.people.length,
        pii_regions_masked: localVision.piiRegions.length,
        pii_categories_masked: localVision.piiCategories,
        unresolved_sensitive_categories: localVision.unlocatedSensitiveCategories,
        detected_objects: localVision.objectDetections.slice(0, 30),
        person_regions: localVision.people.map((person) => ({ bbox: person.bbox, confidence: person.confidence })),
        analysis_ms: localVision.totalMs,
        model_load_ms: localVision.modelLoadMs,
        inference_ms: localVision.inferenceMs,
        asset_bytes: localVision.assetBytes
      } : null
    };

    const localMaskElements = localVision ? [
      ...sanitizedElements,
      ...localVision.piiRegions.map((region) => ({ bbox: region.bbox, sensitive: true, semantic_type: region.category })),
      ...localVision.people.map((person) => ({ bbox: person.bbox, sensitive: true, semantic_type: 'PERSON' }))
    ] : sanitizedElements;

    // A screenshot is captured only for visual tasks or when the live DOM is
    // insufficient. It must pass local redaction before any remote VLM call.
    const redactedScreenshot = screenshotAvailable
      ? await this._awaitOwned(task, token, measureStage(task, 'screenshot_redaction_ms', () => defaultScreenshotSanitizer.redactScreenshot(
          screenshotResponse.dataUrl,
          localMaskElements,
          rawDOM.viewport,
          screenshotPrivacyAudit
      )))
      : null;
    const canUseRemoteVision = Boolean(redactedScreenshot) &&
      defaultScreenshotSanitizer.lastRedactionStatus !== 'withheld';

    if (screenshotAvailable && localVision) {
      task.visionSamples ||= [];
      task.visionSamples.push({
        step: task.currentStep + 1,
        objects: localVision.objectDetections,
        pii: localVision.piiRegions.map(({ bbox, category }) => ({ bbox, category })),
        redactions: localMaskElements.filter((region) => region.sensitive && Array.isArray(region.bbox)).map((region) => ({
          bbox: region.bbox,
          category: region.semantic_type || 'SENSITIVE'
        })),
        localVisionLatencyMs: localVision.totalMs,
        clientHeapBytes: localVision.heapUsedBytes,
        clientAssetBytes: localVision.assetBytes
      });
    }

    taskManager.updatePrivacyMetrics({
      sensitiveFieldsDetected: sensitiveCount,
      secretsKeptLocal: sensitiveCount,
      redactedRegionsCount: sensitiveCount + (localVision ? localVision.piiRegions.length + localVision.people.length : 0),
      localVisionLatencyMs: localVision?.totalMs || 0,
      localModelAssetBytes: localVision?.assetBytes,
      localOcrPiiRegions: localVision?.piiRegions.length || 0,
      localPeopleMasked: localVision?.people.length || 0,
      detectedCategories: [...new Set([
        ...detectedCategories,
        ...(localVision?.piiCategories || []),
        ...(localVision?.people.length ? ['PERSON'] : [])
      ])]
    }, task);
    // Transparency: record exactly what leaves the device for the "What is
    // sent to the AI" panel. Never includes vault plaintext — only counts,
    // symbolic tokens, redacted samples and the sanitized task text.
    try {
      const tokens = Array.from(new Set(
        (sanitizedElements || []).map((e) => e.value_source).filter(Boolean)
      )).slice(0, 12);
      const sampleElements = (sanitizedElements || []).slice(0, 3).map((e) => ({
        id: e.id,
        tag: e.tag,
        label: String(e.label || e.placeholder || e.name || '').slice(0, 40),
        value: e.value,
        value_source: e.value_source || null
      }));
      const screenshotStatus = !visualNeed.needed
        ? 'skipped'
        : redactedScreenshot
          ? (defaultScreenshotSanitizer.lastRedactionStatus || 'unknown')
          : 'unavailable';
      task.lastLLMPayload = {
        taskSent: String(task.prompt || '').slice(0, 140),
        elementsSent: (sanitizedElements || []).length,
        redactedCount: sensitiveCount,
        detectedCategories: detectedCategories || [],
        localVision: localVision ? {
          model: localVision.model,
          analysisMs: localVision.totalMs,
          modelLoadMs: localVision.modelLoadMs,
          inferenceMs: localVision.inferenceMs,
          modelAssetBytes: localVision.assetBytes,
          peopleMasked: localVision.people.length,
          ocrRegionsMasked: localVision.piiRegions.length,
          ocrCategoriesMasked: localVision.piiCategories,
          heapUsedBytes: localVision.heapUsedBytes
        } : undefined,
        tokens,
        screenshotStatus,
        screenshot: screenshotStatus === 'withheld'
          ? 'withheld (neutral placeholder)'
          : screenshotStatus === 'masked'
            ? 'masked known sensitive regions'
            : screenshotStatus === 'checked'
              ? 'processed; no known sensitive regions to mask'
              : screenshotStatus === 'skipped'
                ? 'skipped; structured DOM evidence was sufficient'
              : 'unavailable on this page; no image was sent',
        sampleElements,
        modelTrace: { vision: null, reasoning: null },
        timestamp: Date.now()
      };
    } catch { /* transparency is best-effort */ }
    this.notify('PRIVACY_UPDATED', task.privacyMetrics);

    // STEP 3: SERVER VLM PERCEPTION (sanitized data only, when visual evidence is needed)
    taskManager.updateState(AgentState.VISUAL_ANALYSIS, 'Interpreting the visual layout…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VISUAL_ANALYSIS });

    const visualObservation = canUseRemoteVision
      ? await this._awaitOwned(task, token, measureStage(task, 'vlm_request_ms', () => defaultVLMClient.processVisuals(
          task.id,
          redactedScreenshot,
          sanitizedDOM,
          {
            viewport: rawDOM.viewport,
            // Sanitized copy: the raw title never leaves the device.
            title: sanitizedDOM.title,
            url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
            visual_query: visualNeed.visualQuery,
            privacy_redaction_summary: {
              dom_regions: sensitiveCount,
              ocr_regions: localVision?.piiRegions.length || 0,
              people_regions: localVision?.people.length || 0,
              screenshot_withheld: defaultScreenshotSanitizer.lastRedactionStatus === 'withheld',
              unresolved_sensitive_categories: localVision?.unlocatedSensitiveCategories || []
            }
          }
      )))
      // No screenshot exists to send: continue from the sanitized DOM only
      // instead of failing the task.
      : defaultVLMClient.domOnlyObservation(
          sanitizedDOM,
          visualNeed.needed
            ? 'The screenshot could not be captured or passed local privacy checks; no image was sent.'
            : 'Visual inference was skipped because structured DOM evidence was sufficient.'
        );

    if (task.lastLLMPayload) {
      task.lastLLMPayload.modelTrace ||= { vision: null, reasoning: null };
      task.lastLLMPayload.modelTrace.vision = visualObservation?.model_trace || {
        component: 'vision', source: visualObservation?._source || 'unknown', provider: null, model: null
      };
    }

    if (visualObservation.remoteCallAttempted) {
      taskManager.updatePrivacyMetrics({ serverCallsCount: 1 }, task);
    }
    if (visualObservation?.privacyBlocked) {
      taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
    }

    const objectSummary = localVision ? localVision.objectDetections.slice(0, 12).map((item) => item.label).join(', ') : '';
    const localVisionNote = localVision
      ? `Local ${localVision.model} and OCR checks completed in ${localVision.totalMs} ms; detected objects: ${objectSummary || 'none'}. Masked ${localVision.people.length} people and ${localVision.piiRegions.length} OCR-identified sensitive regions. OCR text was discarded locally.`
      : !visualNeed.needed
        ? 'Screenshot and visual inference were skipped because the structured DOM supplied usable page evidence.'
        : 'Local screenshot analysis was unavailable on this page; continuing from the sanitized DOM only. No screenshot was sent.';
    const remoteVisionNote = redactedScreenshot && !canUseRemoteVision
      ? 'Remote visual inference was skipped because local privacy checks withheld the screenshot.'
      : '';
    visualObservation.spatial_layout = [visualObservation.spatial_layout, localVisionNote, remoteVisionNote].filter(Boolean).join(' ');
    visualObservation.visual_state = [visualObservation.visual_state, localVisionNote, remoteVisionNote].filter(Boolean).join(' ');

    // STEP 4: OBSERVATION FUSION + injection quarantine
    const { fusedObservation, pageState } = await this._awaitOwned(task, token, measureStage(task, 'fusion_and_page_state_ms', async () => {
      const fusedObservation = defaultObservationFusion.fuse(
        sanitizedElements,
        visualObservation,
        {
          domain: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
          url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
          // Sanitized copy: the raw title never leaves the device.
          title: sanitizedDOM.title,
          viewport: rawDOM.viewport,
          scroll: extras.scroll,
          headings: extras.headings,
          result_items: extras.result_items,
          visible_text: extras.visible_text,
          local_vision_context: sanitizedDOM.local_vision_context
        }
      );
      this.quarantineInjectedElements(fusedObservation);

      if (!task.taskState) task.taskState = new TaskState(task.prompt);
      return { fusedObservation, pageState: defaultPageStateModeler.modelPageState(fusedObservation, task.taskState) };
    }));

    // STEP 4.5: TASK-CONDITIONAL PAGE STATE MODELING
    task.pageState = pageState;
    console.log("[PAGE_OBSERVED]", JSON.stringify(pageState));

    // STEP 5: REASONING & PLANNING
    // Storage initialization must not block task creation or the initial UI
    // updates or unrelated tasks. Wait only for form tasks, immediately before
    // local profile resolution.
    const needsLocalProfile = String(taskIntent || '').toUpperCase() === 'FILL_FORM' ||
      /\b(fill|form|application|register|sign\s*up|profile)\b/i.test(String(task.prompt || ''));
    if (needsLocalProfile) {
      taskManager.updateState(AgentState.PLANNING, 'Loading local profile values…', task);
      this.notify('STATE_CHANGED', { state: AgentState.PLANNING });
      await this._awaitOwned(task, token, measureStage(task, 'local_profile_ready_ms', () => defaultLocalVault.ready));
    }
    taskManager.updateState(AgentState.PLANNING, `Planning next action for "${task.taskState.getActiveSubgoal()}"…`, task);
    this.notify('STATE_CHANGED', { state: AgentState.PLANNING, active_subgoal: task.taskState.getActiveSubgoal() });

    const planResult = await this._awaitOwned(task, token, measureStage(task, 'reasoning_request_ms', () => defaultGPTOSSClient.planNextStep(
      task.prompt,
      fusedObservation,
      task.steps,
      task.taskState,
      pageState
    )));
    if (task.lastLLMPayload) {
      task.lastLLMPayload.modelTrace ||= { vision: null, reasoning: null };
      task.lastLLMPayload.modelTrace.reasoning = planResult?.model_trace || {
        component: 'reasoning', source: planResult?.remoteCallMade === false ? 'local' : 'unknown', provider: null, model: null
      };
    }

    // L6/L7: Track previous subgoal for advancement detection
    const prevSubgoal = task.taskState.getActiveSubgoal();

    if (task.taskState && planResult.task_understanding) {
      task.taskState.updateFromModel(planResult.task_understanding);
      task.taskState.updateFromModel(planResult.current_state);
    }

    // L6: If the subgoal advanced, reset consecutive failures
    const newSubgoal = task.taskState.getActiveSubgoal();
    if (prevSubgoal !== newSubgoal) {
      console.log(`[SUBGOAL_ADVANCED] "${prevSubgoal}" → "${newSubgoal}"`);
      task.consecutiveFailures = 0;
    }

    if (planResult.remoteCallAttempted !== false) taskManager.updatePrivacyMetrics({ serverCallsCount: 1 }, task);
    if (planResult?.privacyBlocked) taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
    let proposedAction = planResult.action;

    // A model's DONE is not evidence that a form is complete. Reconcile the
    // latest local observation against configured local sources before
    // accepting terminal output.
    const guarded = this._guardProfileFormCompletion(task, taskIntent, planResult, sanitizedElements);
    proposedAction = guarded.action;

    // A model's terminal flag is advisory only. Complete the task only when
    // it emits the explicit DONE action; otherwise a malformed response can
    // report success while asking the browser to WAIT or keep interacting.
    if (proposedAction?.action === ActionType.DONE) {
      taskManager.completeTask(planResult.thought, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: planResult.thought });
      return false;
    }

    // STEP 6: LOCAL SAFETY GATE & RISK VALIDATION
    taskManager.updateState(AgentState.VALIDATING_ACTION, 'Validating action and privacy…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VALIDATING_ACTION, action: proposedAction });

    const preValidation = defaultActionValidator.validatePreExecution(proposedAction, fusedObservation, task.taskState);
    if (!preValidation.valid) {
      console.warn(`[AgentController] Action failed pre-validation: ${preValidation.reason}. Retrying observation.`);
      await this._awaitOwned(task, token, measureStage(task, 'prevalidation_recovery_wait_ms', () => this.sleep(500)));
      taskManager.recordStep({
        thought: preValidation.reason || 'Target changed; re-analyzing the page.',
        action: proposedAction,
        success: false,
        error: preValidation.reason
      }, task);
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: preValidation.reason || 'The target element changed. Re-analyzing the page.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      return true;
    }

    const fusedTarget = (fusedObservation.elements || [])
      .find((el) => el.id === proposedAction.target?.element_id) || null;
    const riskAssessment = defaultRiskGate.evaluate(proposedAction, {
      targetElement: proposedAction.target,
      targetDom: fusedTarget?.dom || null,
      observationElements: fusedObservation.elements || [],
      currentUrl: rawDOM.url,
      pageTitle: rawDOM.title
    });

    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return false;
    }

    // Settings can force confirmation for high-risk actions even if the model disagrees
    const needsConfirm = riskAssessment.requiresConfirmation ||
      proposedAction.requires_confirmation ||
      ((taskManager.settings?.alwaysConfirm !== false) &&
        (riskAssessment.risk === RiskLevel.HIGH || riskAssessment.risk === RiskLevel.CRITICAL));

    if (needsConfirm) {
      // Explain WHY approval is needed: the safety gate's reason when it
      // demanded confirmation, otherwise the agent's own request.
      const confirmReason = riskAssessment.requiresConfirmation
        ? riskAssessment.reason
        : 'The agent requested your approval before this step.';
      const confirmationId = globalThis.crypto?.randomUUID?.() || `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      taskManager.setPendingConfirmation(proposedAction, confirmReason, { confirmationId, taskId: task.id }, task);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('CONFIRMATION_REQUIRED', {
        confirmationId,
        taskId: task.id,
        action: { ...proposedAction, risk: riskAssessment.risk },
        reason: confirmReason,
        privacySummary: {
          dataKeptLocal: proposedAction.value_source || 'No secrets disclosed',
          dataSharedWithServer: 'Sanitized layout metadata only'
        }
      });

      const confirmationWaitStarted = clockNow();
      const userApproved = await this._awaitOwned(task, token, new Promise((resolve) => {
        this.pendingUserConfirmationResolver = resolve;
      }));
      task.activeStepTimings.confirmation_wait_ms = Math.max(0, Math.round(clockNow() - confirmationWaitStarted));

      // Superseded by a newer task: the new loop owns the task state now.
      // Acting here (clearing its state or cancelling) would kill it.
      this._assertTaskOwner(task, token);

      taskManager.clearPendingConfirmation(task);

      if (!userApproved) {
        taskManager.cancelTask(task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User declined action confirmation' });
        return false;
      }
      taskManager.updateState(AgentState.EXECUTING, 'Approval received — continuing…', task);
    }

    // STEP 7: LOCAL EXECUTION (secrets resolved strictly locally)
    this._assertTaskOwner(task, token);
    taskManager.updateState(AgentState.EXECUTING, 'Performing the action in the page…', task);
    this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: proposedAction });

    let execResult;
    try {
      execResult = await this._awaitOwned(task, token, measureStage(task, 'action_execution_ms', () => defaultActionExecutor.execute(task.tabId, proposedAction)));
    } catch (execErr) {
      if (execErr?.name === 'SupersededTaskError') throw execErr;
      execResult = { success: false, error: execErr?.message || 'Execution failed' };
    }

    if (proposedAction.action === ActionType.OPEN_TAB && execResult?.success && Number.isInteger(execResult.openedTabId)) {
      // Continue the same task in the tab that was actually opened so
      // multi-step requests can inspect and act on its loaded page.
      task.tabId = execResult.openedTabId;
    }
    if (proposedAction.action === ActionType.EXTRACT && execResult?.success && typeof execResult.extractedText === 'string') {
      // Extraction can contain user data even when the normal DOM snapshot
      // would redact it. Scrub it before storing it in task history or sending
      // the result back for a grounded answer.
      execResult.extractedText = defaultDOMSanitizer.sanitizeUserPrompt(execResult.extractedText).slice(0, 3500);
      if (execResult.url) execResult.url = defaultDOMSanitizer.sanitizeUrl(execResult.url);
      if (execResult.title) execResult.title = defaultDOMSanitizer.sanitizeUserPrompt(execResult.title);
    }

    // Intercept ASK_USER / needs_user_input to pause and await user clarification
    if (proposedAction.action === ActionType.ASK_USER || execResult?.needs_user_input) {
      const askData = {
        prompt: execResult?.prompt || proposedAction.value?.prompt || 'User clarification required',
        ambiguousFields: execResult?.ambiguousFields || proposedAction.value?.ambiguousFields || [],
        action: proposedAction
      };
      const requestId = globalThis.crypto?.randomUUID?.() || `input_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      askData.requestId = requestId;
      askData.taskId = task.id;
      taskManager.setPendingUserInput(askData, { requestId, taskId: task.id }, task);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('USER_INPUT_REQUIRED', askData);

      const userWaitStarted = clockNow();
      const userInput = await this._awaitOwned(task, token, new Promise((resolve) => {
        this.pendingUserInputResolver = resolve;
      }));
      task.activeStepTimings.user_wait_ms = Math.max(0, Math.round(clockNow() - userWaitStarted));

      // Superseded by a newer task: the new loop owns the task state now.
      this._assertTaskOwner(task, token);

      taskManager.clearPendingUserInput(task);

      if (userInput?.cancelled) {
        taskManager.cancelTask(task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User cancelled input request' });
        return false;
      }

      // If user saved any values to vault:
      const userInputApplyStarted = clockNow();
      if (Array.isArray(userInput?.saveToVault)) {
        for (const item of userInput.saveToVault) {
          if (item?.key && item?.value !== undefined) {
            try {
              await this._awaitOwned(task, token, defaultLocalVault.updateSecret(item.key, item.value));
            } catch (vErr) {
              console.warn('[AgentController] Could not save vault secret:', vErr);
            }
          }
        }
      }

      // Apply user answers locally. Store field IDs and execution outcomes
      // only; answer strings can contain personal values.
      const resolvedFieldIds = [];
      const answerIds = Object.keys(userInput?.answers || {});
      if (userInput?.answers && Object.keys(userInput.answers).length > 0) {
        for (const [fieldId, val] of Object.entries(userInput.answers)) {
          if (val !== undefined && val !== null && val !== '') {
            const fieldMeta = (askData.ambiguousFields || []).find(f => f.field_id === fieldId);
            try {
              let answerAction;
              if (fieldId === 'candidate_choice') {
                // Semantic-candidate choice from the ambiguity modal: the
                // answer is the chosen element's id — click it.
                answerAction = { action: ActionType.CLICK, target: { element_id: val } };
              } else if (fieldMeta?.control_type === 'SELECT' || fieldMeta?.element_type === 'select') {
                answerAction = { action: ActionType.SELECT, target: { element_id: fieldId }, value: val };
              } else if (fieldMeta?.control_type === 'CHECKBOX' || fieldMeta?.input_type === 'checkbox') {
                const checked = val === true || ['yes', 'true', '1', 'checked', 'agree', 'accepted'].includes(String(val).toLowerCase());
                answerAction = { action: checked ? ActionType.CHECK : ActionType.UNCHECK, target: { element_id: fieldId } };
              } else if (fieldMeta?.control_type === 'RADIO' || fieldMeta?.input_type === 'radio') {
                answerAction = {
                  action: ActionType.FILL_FORM_PLAN,
                  value: { fields: [{ field_id: fieldId, control_type: 'RADIO', semantic_type: fieldMeta.semantic_type, value: String(val) }] }
                };
              } else {
                answerAction = { action: ActionType.TYPE, target: { element_id: fieldId }, value: String(val) };
              }
              const answerResult = await this._awaitOwned(task, token, defaultActionExecutor.execute(task.tabId, answerAction));
              if (answerResult?.success) resolvedFieldIds.push(fieldId);
            } catch {
              console.warn('[AgentController] Could not apply a user-provided field value.');
            }
          }
        }
      }
      const skippedFieldIds = (askData.ambiguousFields || [])
        .map((field) => field.field_id)
        .filter((id) => !resolvedFieldIds.includes(id));

      task.activeStepTimings.user_input_apply_ms = Math.max(0, Math.round(clockNow() - userInputApplyStarted));
      await this._awaitOwned(task, token, measureStage(task, 'user_input_followup_wait_ms', () => this.sleep(400)));

      // Record step in history with user's responses
      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: {
          needs_user_input: Boolean(execResult?.needs_user_input),
          resolvedFieldIds,
          skippedFieldIds,
          answeredFieldIds: answerIds.filter((id) => resolvedFieldIds.includes(id))
        },
        success: true
      }, task);

      this.notify('STEP_COMPLETED', {
        stepNumber: task.currentStep,
        thought: 'User clarification received and applied',
        action: proposedAction,
        success: true,
        timestamp: Date.now()
      });
      return true;
    }

    // STEP 8: VERIFY — execution result determines recovery
    taskManager.updateState(AgentState.VERIFYING, 'Checking the result…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VERIFYING });

    if (!execResult || execResult.success === false) {
      const errMsg = execResult?.error || 'Action did not complete';
      await this._awaitOwned(task, token, measureStage(task, 'failed_action_recovery_wait_ms', () => this.sleep(600)));
      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: execResult,
        success: false,
        error: String(errMsg).slice(0, 200),
        diagnostic: { model_trace: task.lastLLMPayload?.modelTrace || null }
      }, task);
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: 'That action did not complete. The agent will try another way.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      return true;
    }

    // Settle the page before saving the step timing so this stage is included
    // in the per-step latency record. The next observation still performs its
    // own mutation-based stability check.
    const postActionWait = this._getPostActionWait(proposedAction.action);
    await this._awaitOwned(task, token, measureStage(task, 'post_action_wait_ms', () => this.sleep(postActionWait)));

    taskManager.recordStep({
      thought: planResult.thought,
      action: proposedAction,
      result: execResult,
      success: true,
      diagnostic: {
        task_understanding: planResult.task_understanding,
        page_understanding: planResult.page_understanding,
        current_state: planResult.current_state,
        task_state: task.taskState?.toPayload(),
        page_state: task.pageState,
        model_trace: task.lastLLMPayload?.modelTrace || null,
        // Decision diagnostics: safe metadata only (ids, semantic types,
        // scores, evidence sources) — never raw personal data, secrets,
        // page contents, or model responses.
        decision: {
          task_intent: taskIntent || null,
          required_action: planResult.selection_evidence?.required_action || proposedAction?.action || null,
          candidate_ids: planResult.selection_evidence?.candidate_ids || null,
          candidate_semantics: planResult.selection_evidence?.candidate_semantics || null,
          candidate_scores: planResult.selection_evidence?.candidate_scores || null,
          selected_candidate: planResult.selection_evidence?.selected_candidate || proposedAction?.target?.element_id || null,
          selection_evidence: planResult.selection_evidence?.selection_evidence || null,
          validation_result: 'PASSED'
        }
      }
    });

    this.notify('STEP_COMPLETED', {
      stepNumber: task.currentStep,
      thought: planResult.thought,
      action: proposedAction,
      result: execResult,
      diagnostic: {
        task_understanding: planResult.task_understanding,
        page_understanding: planResult.page_understanding,
        current_state: planResult.current_state,
        task_state: task.taskState?.toPayload(),
        page_state: task.pageState,
        model_trace: task.lastLLMPayload?.modelTrace || null,
      },
      success: true,
      timestamp: Date.now()
    });

    return true;
  }

  _guardProfileFormCompletion(task, taskIntent, planResult, sanitizedElements) {
    let action = planResult?.action;
    const profileDrivenForm = /\b(saved profile|my profile|local vault|saved details|profile details)\b/i.test(String(task?.prompt || ''));
    if (action?.action === ActionType.DONE && taskIntent === 'FILL_FORM' && profileDrivenForm) {
      const formDecision = this.formPlanBuilder.decide(sanitizedElements, task.prompt, task.steps);
      if (formDecision.status === 'REMAINING' || formDecision.status === 'ASK_USER') {
        action = formDecision.action;
        planResult.isTerminal = false;
        planResult.thought = formDecision.status === 'REMAINING'
          ? 'The form still has configured profile fields to resolve.'
          : 'The form has fields that require user input or an explicit skip decision.';
      }
    }
    return { action, planResult };
  }

  /**
   * Capability-aware navigation bootstrap (runs before OBSERVE).
   *
   * - Pure NAVIGATE tasks ("open youtube"): validated deterministic
   *   navigation in task.tabId, verified by URL — from ANY page except the
   *   extension panel. No DOM extraction, no VLM, no grounding needed.
   * - Compound tasks starting on a non-automatable page with a known site
   *   ("search youtube for cats" from chrome://newtab): navigate to the
   *   site homepage first, then let the normal loop re-observe and continue.
   * - Otherwise: { handled:false } and the caller applies the normal
   *   pipeline (or a controlled unsupported-page error).
   *
   * Returns { handled:boolean, shouldContinue:boolean }.
   */
  async _maybeHandleNavigationBootstrap(task, currentTab, capability, token = task.runToken) {
    const notHandled = { handled: false, shouldContinue: true };
    let goal = null;
    try {
      goal = getNavigationGoal(task.prompt);
    } catch {
      goal = null;
    }

    // Never navigate the extension panel tab away.
    if (capability === PageCapability.EXTENSION_INTERNAL) return notHandled;

    if (goal?.url) {
      const validation = validateNavigationUrl(goal.url);
      console.log(`[NAVIGATION] target=${validation.normalizedUrl || goal.url} validated=${validation.valid}`);
      if (!validation.valid) {
        taskManager.failTask(`Navigation blocked: ${validation.reason}`, task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
        return { handled: true, shouldContinue: false };
      }

      // If already on the target destination host/URL for a compound task, skip redundant re-navigation
      const currentHost = (() => { try { return new URL(currentTab?.url || '').hostname.toLowerCase(); } catch { return ''; } })();
      const targetHost = validation.host?.toLowerCase() || '';
      if (!goal.isPure && currentHost && targetHost && (currentHost === targetHost || currentHost.endsWith('.' + targetHost))) {
        if (task.taskState?.getActiveSubgoal()?.toLowerCase()?.startsWith('open ')) {
          try { task.taskState.advanceSubgoal?.(); } catch {}
        }
        return notHandled;
      }

      return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, currentTab, validation.normalizedUrl, {
        pure: goal.isPure,
        thought: goal.isPure
          ? `Navigate to ${validation.host} (pure navigation request; no page interaction needed).`
          : `Navigate to ${validation.host} first, then continue the task on the new page.`
      }, token));
    }

    // Compound task stranded on a non-automatable page or starting on another site:
    // hop to the task's site homepage (if deterministically known), then re-observe.
    const site = task.taskState?.site;
    let home = site ? getSiteHomepage(site) : null;
    const currentHost = (() => { try { return new URL(currentTab?.url || '').hostname.toLowerCase(); } catch { return ''; } })();
    const targetSiteHost = site?.toLowerCase();

    // If already on that site, do not navigate again
    if (home && currentHost && targetSiteHost && (currentHost === targetSiteHost || currentHost.includes(targetSiteHost))) {
      home = null;
      if (task.taskState?.getActiveSubgoal()?.toLowerCase()?.startsWith('open ')) {
        try { task.taskState.advanceSubgoal?.(); } catch {}
      }
    }

    if (capability !== PageCapability.AUTOMATABLE_WEB) {
      // Smart bootstrap: If on a blank new tab with a search/find task
      // and no specific website was mentioned ("Find cheapest flight...", "Search for laptops..."),
      // automatically navigate to Google so the agent can execute the search!
      const currentUrl = currentTab?.url || '';
      const isNewTabOrBlank = capability === PageCapability.ABOUT_BLANK ||
        currentUrl.includes('newtab') ||
        currentUrl === 'about:blank';

      if (!home && isNewTabOrBlank) {
        home = 'https://www.google.com/';
      }
    }

    if (home) {
      const validation = validateNavigationUrl(home);
      if (!validation.valid) return notHandled;
      console.log(`[NAVIGATION] target=${validation.normalizedUrl} validated=true`);
      return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, currentTab, validation.normalizedUrl, {
        pure: false,
        thought: `Navigate to ${home.includes('google') ? 'Google' : site} first, then continue the task.`
      }, token));
    }

    return notHandled;
  }

  /**
   * Validated tab navigation + verification for the bootstrap path.
   * Always uses task.tabId (never the focused window/tab). Uses the same
   * defaultActionExecutor NAVIGATE implementation as the normal pipeline —
   * no competing navigation path. Records honest steps: success only after
   * URL verification, failure otherwise (never fake success).
   */
  async _executeBootstrapNavigation(task, currentTab, normalizedUrl, { pure, thought }, token = task.runToken) {
    const navAction = {
      action: ActionType.NAVIGATE,
      target: { url: normalizedUrl },
      risk: RiskLevel.LOW,
      requires_confirmation: false
    };

    // Existing safety gate still applies (defense in depth).
    let riskAssessment = { allowed: true, risk: RiskLevel.LOW, reason: 'Standard interactive action.' };
    try {
      riskAssessment = defaultRiskGate.evaluate(navAction, {
        targetElement: navAction.target,
        targetDom: null,
        currentUrl: currentTab?.url || '',
        pageTitle: currentTab?.title || ''
      });
    } catch (e) {
      console.warn('[AgentController] Risk evaluation failed, continuing with LOW:', e?.message);
    }
    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
      return { handled: true, shouldContinue: false };
    }

    // Persist pre-navigation state so a service-worker restart mid-flight
    // leaves an honest EXECUTING task (with history), never a fake DONE.
    taskManager.updateState(AgentState.EXECUTING, `Navigating to ${normalizedUrl}…`, task);
    this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: navAction });
    console.log(`[NAVIGATION] tabId=${task.tabId} status=started`);

    let execResult;
    try {
      this._assertTaskOwner(task, token);
      execResult = await this._awaitOwned(task, token, measureStage(task, 'navigation_execution_ms', () => defaultActionExecutor.execute(task.tabId, navAction)));
    } catch (execErr) {
      if (execErr?.name === 'SupersededTaskError') throw execErr;
      execResult = { success: false, error: execErr?.message || 'Navigation failed' };
    }
    if (!execResult || execResult.success === false) {
      const errMsg = String(execResult?.error || 'Navigation did not complete').slice(0, 200);
      console.log('[NAVIGATION] status=failed');
      taskManager.recordStep({ thought, action: navAction, result: execResult, success: false, error: errMsg }, task);
      this.notify('STEP_FAILED', { stepNumber: task.currentStep, thought, action: navAction, success: false, timestamp: Date.now() });
      return { handled: true, shouldContinue: true };
    }

    const verification = await this._awaitOwned(task, token, measureStage(task, 'navigation_verification_ms', () => this._verifyNavigation(task.tabId, normalizedUrl, task, token)));
    console.log(`[NAVIGATION] status=${verification.ok ? 'completed' : 'failed'}`);
    console.log(`[VERIFY] url=${verification.actualUrl || '(unknown)'} success=${verification.ok}`);
    if (!verification.ok) {
      const errMsg = verification.actualUrl
        ? `Navigation reached ${verification.actualUrl} instead of the requested destination.`
        : 'Navigation timed out before the new page could be verified.';
      taskManager.recordStep({ thought, action: navAction, result: execResult, success: false, error: errMsg.slice(0, 200) }, task);
      this.notify('STEP_FAILED', { stepNumber: task.currentStep, thought: errMsg, action: navAction, success: false, timestamp: Date.now() });
      return { handled: true, shouldContinue: true };
    }

    if (pure) {
      taskManager.recordStep({
        thought: `${thought} Verified at ${verification.actualUrl}.`,
        action: navAction,
        result: execResult,
        success: true,
        diagnostic: { bootstrap_navigation: true, verified_url: verification.actualUrl }
      }, task);
      this.notify('STEP_COMPLETED', { stepNumber: task.currentStep, thought, action: navAction, success: true, timestamp: Date.now() });
      try {
        if (task.taskState?.advanceSubgoal) task.taskState.advanceSubgoal();
        else if (task.taskState?.advance) task.taskState.advance(navAction, null, { success: true });
      } catch { /* non-fatal */ }
      taskManager.completeTask(`Navigated to ${verification.actualUrl}.`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: `Navigated to ${verification.actualUrl}.` });
      return { handled: true, shouldContinue: false };
    }

    try {
      if (task.taskState?.getActiveSubgoal()?.toLowerCase()?.startsWith('open ')) {
        task.taskState.advanceSubgoal?.();
      }
    } catch {}

    await this._awaitOwned(task, token, measureStage(task, 'post_action_wait_ms', () => this.sleep(this._getPostActionWait(ActionType.NAVIGATE))));
    taskManager.recordStep({
      thought: `${thought} Verified at ${verification.actualUrl}.`,
      action: navAction,
      result: execResult,
      success: true,
      diagnostic: { bootstrap_navigation: true, verified_url: verification.actualUrl }
    }, task);
    this.notify('STEP_COMPLETED', { stepNumber: task.currentStep, thought, action: navAction, success: true, timestamp: Date.now() });
    return { handled: true, shouldContinue: true };
  }

  /** Poll task.tabId until its URL matches the destination (redirect-tolerant). */
  async _verifyNavigation(tabId, expectedUrl, task = null, token = this.runToken) {
    const deadline = Date.now() + NAV_VERIFY_TIMEOUT_MS;
    let actualUrl = '';
    while (Date.now() < deadline) {
      try {
        const tab = await withTimeout(chrome.tabs.get(tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
        if (task) this._assertTaskOwner(task, token);
        actualUrl = tab?.url || '';
        if (actualUrl && urlsMatchForVerification(expectedUrl, actualUrl)) {
          return { ok: true, actualUrl };
        }
      } catch {
        // Tab may be mid-navigation; keep polling until the timeout.
      }
      if (task) await this._awaitOwned(task, token, this.sleep(NAV_VERIFY_POLL_MS));
      else await this.sleep(NAV_VERIFY_POLL_MS);
    }
    try {
      const tab = await withTimeout(chrome.tabs.get(tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
      if (task) this._assertTaskOwner(task, token);
      actualUrl = tab?.url || actualUrl;
    } catch { /* keep last value */ }
    return { ok: false, actualUrl };
  }

  /**
   * L2: Improved stuck-loop detection.
   * Catches both exact repetition AND alternating patterns (A→B→A→B).
   * Also checks if state fingerprint hasn't changed across recent steps.
   */
  _isStuckInLoop(task) {
    const steps = task.steps || [];
    if (steps.length < MAX_IDENTICAL_ACTIONS) return false;
    const tail = steps.slice(-MAX_IDENTICAL_ACTIONS);

    const keyOf = (s) => {
      const a = s?.action || {};
      const t = a.target || {};
      // Action signature only (type + element + symbolic source): thought
      // text never participates, so loops hidden behind slightly different
      // reasoning are still detected.
      return `${a.action}::${t.element_id || t.url || ''}::${a.value_source || ''}`;
    };

    // Check 1: Exact same action repeated N times
    const stateFingerprint = (s) => {
      const p = s.diagnostic?.page_state || {};
      // Include result-set size and text excerpt so genuinely different pages
      // never collide on "undefined::undefined::undefined".
      const resultCount = Array.isArray(p.result_sets) ? p.result_sets.length : (p.result_sets ? 1 : 0);
      const textHead = String(p.visible_text_excerpt || '').slice(0, 80);
      return `${p.url || ''}::${p.page_type || ''}::${p.summary || ''}::${resultCount}::${textHead}`;
    };

    const firstAction = keyOf(tail[0]);
    const firstState = stateFingerprint(tail[0]);
    const allIdentical = tail.every((s) => s.success === true && keyOf(s) === firstAction && stateFingerprint(s) === firstState);
    if (allIdentical) return true;

    // L2: Check 2: Alternating pattern detection (A→B→A→B)
    if (steps.length >= 4) {
      const last4 = steps.slice(-4);
      const keys = last4.map(keyOf);
      if (keys[0] === keys[2] && keys[1] === keys[3] && keys[0] !== keys[1]) {
        // Check that no actual progress is being made (page state unchanged)
        const states = last4.map(stateFingerprint);
        if (states[0] === states[2] && states[1] === states[3]) {
          console.warn('[AgentController] Alternating stuck loop detected:', keys);
          return true;
        }
      }
    }

    // L2: Check 3: All recent steps are failures with the same NON-EMPTY error.
    // Empty errors (no diagnostic) are not a loop signal — the original
    // circuit-breaker ignored failing sequences entirely.
    if (steps.length >= MAX_IDENTICAL_ACTIONS) {
      const recentFails = steps.slice(-MAX_IDENTICAL_ACTIONS);
      if (recentFails.every(s => s.success === false)) {
        const errors = recentFails.map(s => (s.error || '').slice(0, 50));
        if (errors[0] && new Set(errors).size === 1) {
          console.warn('[AgentController] Repeated identical failures detected');
          return true;
        }
      }
    }

    return false;
  }

  // Backward-compatible alias for older tests: exact-repeat circuit breaker.
  _isRepeatingIdenticalAction(task) {
    return this._isStuckInLoop(task);
  }

  /**
   * L12: Strips webpage-embedded instruction attacks from the observation copy
   * passed to the planner. Webpage text is untrusted data, never instructions.
   * Now also scans context text and visible_text.
   */
  quarantineInjectedElements(fusedObservation) {
    if (!fusedObservation) return;
    
    let quarantined = 0;

    // L12: Scan element labels, descriptions, AND context text
    if (Array.isArray(fusedObservation.elements)) {
      for (const elmt of fusedObservation.elements) {
        const dom = elmt?.dom || {};
        const candidateText = [
          dom.label, dom.ariaLabel, dom.accessible_name, dom.placeholder,
          dom.ariaDescribedBy, dom.fieldset_legend, dom.context, dom.value,
          ...(Array.isArray(dom.options) ? dom.options.flatMap((option) =>
            typeof option === 'string' ? [option] : [option?.text, option?.value, option?.label]
          ) : []),
          elmt?.semantics?.accessible_name, elmt?.visual?.description
        ];
        if (candidateText.some(containsInjection)) {
          quarantined++;
          if (elmt.dom) {
            elmt.dom.label = '[Untrusted page text — ignored]';
            elmt.dom.value = elmt.dom.sensitive ? '[REDACTED]' : '';
            elmt.dom.placeholder = '';
            elmt.dom.ariaLabel = '';
            elmt.dom.accessible_name = '';
            elmt.dom.ariaDescribedBy = '';
            elmt.dom.fieldset_legend = '';
            elmt.dom.context = '[Untrusted page content — quarantined]';
            if (Array.isArray(elmt.dom.options)) elmt.dom.options = elmt.dom.options.map((option) =>
              typeof option === 'string' ? '[Untrusted option — quarantined]' :
                { ...option, text: '[Untrusted option — quarantined]', label: '[Untrusted option — quarantined]', value: option?.value_redacted ? '[REDACTED]' : '' }
            );
          }
          if (elmt.semantics) elmt.semantics.accessible_name = '[Untrusted page text — ignored]';
          if (elmt.visual) elmt.visual.description = 'Untrusted page content (quarantined)';
        }
      }
    }

    // L12: Scan visible_text for injection attempts
    if (fusedObservation.visible_text && containsInjection(fusedObservation.visible_text)) {
      quarantined++;
      // Don't blank visible_text entirely — strip the injected portions
      for (const re of INJECTION_PATTERNS) {
        const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        fusedObservation.visible_text = fusedObservation.visible_text.replace(globalRe, '[INJECTION_QUARANTINED]');
      }
    }

    // L12: Scan headings for injection
    if (Array.isArray(fusedObservation.headings)) {
      for (const heading of fusedObservation.headings) {
        const headingText = heading?.text || (typeof heading === 'string' ? heading : '');
        if (containsInjection(headingText)) {
          quarantined++;
          if (typeof heading === 'object' && heading.text) {
            heading.text = '[Untrusted heading — quarantined]';
          }
        }
      }
    }

    // L12: Scan result_items text content
    if (Array.isArray(fusedObservation.result_items)) {
      for (const item of fusedObservation.result_items) {
        if (containsInjection(item?.title) || containsInjection(item?.text)) {
          quarantined++;
          if (containsInjection(item.title)) item.title = '[Untrusted item — quarantined]';
          if (containsInjection(item.text)) item.text = '[Untrusted content — quarantined]';
        }
      }
    }

    if (quarantined > 0) {
      console.warn(`[AgentController] Quarantined ${quarantined} injected element(s)/text from webpage content.`);
    }
  }

  /**
   * L1/L5: Wait for the page to stabilize by sending a CHECK_PAGE_STABILITY
   * message to the content script.
   */
  async _waitForPageStability(tabId) {
    try {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(done, 800);
        chrome.tabs.sendMessage(
          tabId,
          { type: MessageType.CHECK_PAGE_STABILITY, payload: { quietMs: 120 } },
          () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
              // Expected if content script is not injected yet or tab is not ready.
            }
            done();
          }
        );
      });
    } catch {
      await this.sleep(150);
    }
  }

  /**
   * L5: Determine how long to wait after an action for the page to settle.
   * Navigation/click actions need longer waits for SPA transitions.
   */
  _getPostActionWait(actionType) {
    switch (actionType) {
      case ActionType.NAVIGATE:
        return 500;
      case ActionType.CLICK:
      case ActionType.SUBMIT:
        return 150;
      case ActionType.TYPE:
        return 60;
      case ActionType.SELECT:
        return 80;
      case ActionType.SCROLL:
        return 120;
      default:
        return 60;
    }
  }

  clearOverlays(tabId) {
    try {
      if (tabId != null && typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
        chrome.tabs.sendMessage(tabId, { type: MessageType.CLEAR_OVERLAYS }, () => {
          if (chrome.runtime?.lastError) { /* page may be gone — ignore */ }
        });
      }
    } catch { /* non-fatal */ }
  }

  handleUserConfirmation(payload = {}) {
    const task = taskManager.getTask();
    const pending = task?.pendingConfirmation;
    if (!task || task.id !== payload.taskId || !pending ||
        pending.taskId !== payload.taskId || pending.confirmationId !== payload.confirmationId) return false;
    const resolve = this.pendingUserConfirmationResolver;
    this.pendingUserConfirmationResolver = null;
    if (resolve) {
      resolve(Boolean(payload.approved));
      return true;
    }
    // Correlated prompt but no live loop: the worker was suspended while
    // waiting, so nothing is going to execute the approved action. Finalize
    // honestly rather than reporting success, and never imply the action ran.
    taskManager.cancelTask(task);
    this.notify('TASK_CANCELLED', {
      reason: payload.approved
        ? 'Approved, but the agent service restarted before the action could run. Nothing was submitted.'
        : 'Action declined.'
    });
    return true;
  }

  handleUserInput(payload) {
    const task = taskManager.getTask();
    const pending = task?.pendingUserInput;
    if (!task || task.id !== payload?.taskId || !pending ||
        pending.taskId !== payload.taskId || pending.requestId !== payload.requestId) return false;
    const resolve = this.pendingUserInputResolver;
    this.pendingUserInputResolver = null;
    if (resolve) {
      resolve(payload);
      return true;
    }
    // Correlated prompt but no live loop: the answers cannot be consumed, so
    // stop the task instead of leaving a prompt that silently does nothing.
    taskManager.failTask(
      'The browser restarted the agent service before your answer could be used.',
      task
    );
    this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
    return true;
  }

  pauseTask() {
    const task = taskManager.getTask();
    if (!task || [AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(task.state)) return false;
    if (this.isPaused) return true;
    this.pausedFromState = task.state;
    this.isPaused = true;
    taskManager.updateState(AgentState.PAUSED, 'Paused. Resume to continue the task.', task);
    this.notify('STATE_CHANGED', { state: AgentState.PAUSED });
    return true;
  }

  resumeTask() {
    const task = taskManager.getTask();
    if (!task || !this.isPaused || task.state !== AgentState.PAUSED) return false;
    this.isPaused = false;
    taskManager.updateState(this.pausedFromState || AgentState.OBSERVING, 'Resuming task…', task);
    this.pausedFromState = null;
    const resolve = this.pauseResolver;
    this.pauseResolver = null;
    if (resolve) resolve();
    this.notify('STATE_CHANGED', { state: task.state });
    return true;
  }

  cancelTask() {
    const current = taskManager.getTask();
    if (!current || [AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(current.state)) return false;
    this.runToken++;
    this.isCancelled = true;
    const task = current;
    taskManager.cancelTask(task);
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    }
    if (task) this.clearOverlays(task.tabId);
    if (this.pendingUserConfirmationResolver) {
      this.pendingUserConfirmationResolver(false);
      this.pendingUserConfirmationResolver = null;
    }
    if (this.pendingUserInputResolver) {
      this.pendingUserInputResolver({ cancelled: true });
      this.pendingUserInputResolver = null;
    }
    this.notify('TASK_CANCELLED', task);
    this.notify('STATE_CHANGED', { state: AgentState.CANCELLED });
    return true;
  }

  async _extractDOM(tabId) {
    const sendExtractionMessage = () => new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ success: false, error: 'Page extraction timed out.' }), CHROME_API_TIMEOUT_MS);
      try {
        chrome.tabs.sendMessage(tabId, { type: MessageType.EXTRACT_DOM }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          finish(runtimeError
            ? { success: false, error: runtimeError.message }
            : (response || { success: false, error: 'Empty response' }));
        });
      } catch (error) {
        finish({ success: false, error: error?.message || 'Page extraction failed.' });
      }
    });

    const initial = await sendExtractionMessage();
    if (initial?.success || !String(initial?.error || '').includes('Could not establish connection') || !chrome.scripting) {
      return initial;
    }
    try {
      await withTimeout(chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js']
      }), CHROME_API_TIMEOUT_MS, 'Content script injection timed out.');
      await this.sleep(250);
      return await sendExtractionMessage();
    } catch (error) {
      return { success: false, error: error?.message || 'Could not initialize page extraction.' };
    }
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const agentController = new AgentController();
