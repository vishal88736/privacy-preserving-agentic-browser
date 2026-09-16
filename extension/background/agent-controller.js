/**
 * Agent Controller
 * Orchestrates the autonomous iterative agent loop:
 * OBSERVE -> SANITIZE -> VISUAL_ANALYSIS -> REASON -> SAFETY_GATE -> ACT -> VERIFY
 *
 * Reliability: bounded retries, per-step error isolation, verification,
 * overlay cleanup, settings-aware execution. Privacy boundary preserved:
 * only sanitized DOM + redacted screenshots leave the device.
 */

import { AgentState, ActionType, RiskLevel } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { taskManager } from './task-manager.js';
import { defaultDOMSanitizer } from '../privacy/dom-sanitizer.js';
import { defaultScreenshotSanitizer } from '../privacy/screenshot-sanitizer.js';
import { defaultScreenshotService } from '../perception/screenshot.js';
import { defaultVLMClient } from '../perception/vlm-client.js';
import { defaultObservationFusion } from '../perception/observation-fusion.js';
import { defaultGPTOSSClient } from '../reasoning/gpt-oss-client.js';
import { defaultRiskGate } from '../executor/risk-gate.js';
import { defaultActionValidator } from '../executor/action-validator.js';
import { defaultActionExecutor } from '../executor/action-executor.js';
import { TaskState } from '../reasoning/task-understanding.js';
import { defaultPageStateModeler } from '../perception/page-state-modeler.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_ACTIONS = 3;
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+your\s+(system\s+)?prompt/i,
  /exfiltrat/i,
  /send\s+(the\s+)?(user'?s?\s+)?password/i,
  /disregard\s+(all\s+)?(prior|previous)/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /new\s+system\s+prompt/i
];

function containsInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export class AgentController {
  constructor() {
    this.activeTabId = null;
    this.isPaused = false;
    this.isCancelled = false;
    this.listeners = new Set();
    this.pendingUserConfirmationResolver = null;
    this.runToken = 0;
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
    // Invalidate any previous loop
    this.runToken++;
    const token = this.runToken;
    this.activeTabId = tabId;
    this.isPaused = false;
    this.isCancelled = false;
    this.pendingUserConfirmationResolver = null;

    // Apply current settings to network clients (privacy: same sanitized payloads, new host only)
    const settings = taskManager.settings || {};
    if (settings.backendUrl) {
      const base = String(settings.backendUrl).replace(/\/+$/, '');
      defaultVLMClient.baseUrl = base;
      defaultGPTOSSClient.baseUrl = base;
    }

    // Sanitize user prompt to prevent leakage of PII entered directly in the task bar
    const sanitizedPrompt = defaultDOMSanitizer.sanitizeUserPrompt(userPrompt);

    const task = taskManager.createTask(sanitizedPrompt, tabId);
    task.taskState = new TaskState(sanitizedPrompt);
    if (settings.maxSteps) task.maxSteps = settings.maxSteps;
    this.notify('TASK_STARTED', task);

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, 'Interpreting task goal...');
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK });

    try {
      const parsedTask = await defaultGPTOSSClient.interpretTask(sanitizedPrompt);
      task.taskState.updateFromModel(parsedTask);
      
      console.log("[TASK_INTERPRETED]", JSON.stringify(task.taskState.toPayload()));
      
      if (!task.taskState.intent || task.taskState.intent === 'unknown') {
        throw new Error('Task interpretation failed. Could not determine a valid intent or goal.');
      }
    } catch (e) {
      console.error('[AgentController] Pre-planning interpretation error:', e);
      taskManager.failTask(e?.message || 'Failed to interpret task');
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
      return;
    }

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, `Goal: ${task.taskState.goal}`);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK, goal: task.taskState.goal });

    this.runLoop(token).catch(err => {
      console.error('Agent loop encountered unhandled error:', err);
      taskManager.failTask(err?.message || 'Unexpected agent error');
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
    });
  }

  async runLoop(token) {
    const task = taskManager.getTask();

    while (task.state !== AgentState.COMPLETED && task.state !== AgentState.FAILED && task.state !== AgentState.CANCELLED) {
      if (token !== this.runToken || this.isCancelled) {
        taskManager.cancelTask();
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', task);
        break;
      }

      if (this.isPaused) {
        await this.sleep(300);
        continue;
      }

      if (task.currentStep >= task.maxSteps) {
        taskManager.failTask('Maximum step limit reached without achieving goal');
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      if ((task.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
        taskManager.failTask('The agent could not find the target element — the page may have changed.');
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      if (this._isRepeatingIdenticalAction(task)) {
        console.log("[REPLAN] No progress detected. Agent repeated identical step.");
        taskManager.failTask('The agent repeated the same step without making progress.');
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      try {
        const shouldContinue = await this.runSingleStep(task);
        if (!shouldContinue) break;
      } catch (stepErr) {
        // Deterministic privacy failure: retrying cannot help (same redacted
        // input would be blocked again). Fail fast with a user-safe message.
        if (stepErr && stepErr.name === 'OutboundPolicyViolationError') {
          console.error('[AgentController] Outbound privacy block, aborting task:', stepErr.message);
          taskManager.failTask(stepErr.message);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          break;
        }
        console.warn('[AgentController] Step failed, recovering:', stepErr?.message);
        taskManager.recordStep({
          thought: 'Step encountered a problem; re-analyzing the page.',
          action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
          success: false,
          error: String(stepErr?.message || stepErr).slice(0, 200)
        });
        this.notify('STEP_FAILED', {
          stepNumber: task.currentStep,
          thought: 'Step encountered a problem; re-analyzing the page.',
          action: { action: ActionType.WAIT },
          success: false
        });
        await this.sleep(700);
      }
    }
  }

  /**
   * Runs one OBSERVE→VERIFY cycle. Returns false when the loop should stop.
   */
  async runSingleStep(task) {
    // Check current tab URL and handle restricted pages / navigation
    let currentTab = null;
    try {
      currentTab = await chrome.tabs.get(task.tabId);
    } catch (e) {
      console.warn('[AgentController] Could not get tab info:', e);
    }

    const isRestrictedUrl = !currentTab?.url || (
      currentTab.url.startsWith('chrome://') ||
      currentTab.url.startsWith('chrome-extension://') ||
      currentTab.url.startsWith('edge://') ||
      currentTab.url === 'about:blank' ||
      currentTab.url.startsWith('view-source:')
    );

    // Never navigate the extension's own pages away: that would destroy the
    // panel. The user must focus a real webpage first.
    if (currentTab?.url?.startsWith('chrome-extension://')) {
      throw new Error('The agent cannot run inside its own panel tab. Please click on the webpage first, then start the task.');
    }

    if (isRestrictedUrl) {
      throw new Error('Chrome does not permit extensions on internal chrome:// pages. Please open a website or test portal (e.g. http://localhost:5000).');
    }

    // STEP 1: OBSERVE
    taskManager.updateState(AgentState.OBSERVING, 'Reading page structure and layout…');
    this.notify('STATE_CHANGED', { state: AgentState.OBSERVING, step: task.currentStep + 1 });

    const [domResponse, screenshotResponse] = await Promise.all([
      this._extractDOM(task.tabId),
      defaultScreenshotService.captureTab()
    ]);

    if (!domResponse?.success) {
      throw new Error(`Failed to observe tab: ${domResponse?.error || 'Target page not responding'}. If on a new tab, navigate to a website first.`);
    }

    const rawDOM = domResponse.data;

    // STEP 2: LOCAL PRIVACY SANITIZATION (Client-Side Boundary)
    taskManager.updateState(AgentState.SANITIZING, 'Redacting sensitive fields locally…');
    this.notify('STATE_CHANGED', { state: AgentState.SANITIZING });

    const { sanitizedElements, sensitiveCount, detectedCategories } =
      defaultDOMSanitizer.sanitizeElements(rawDOM.elements);

    const sanitizedDOM = { ...rawDOM, elements: sanitizedElements };

    const redactedScreenshot = await defaultScreenshotSanitizer.redactScreenshot(
      screenshotResponse.dataUrl,
      sanitizedElements,
      rawDOM.viewport
    );

    taskManager.updatePrivacyMetrics({
      sensitiveFieldsDetected: sensitiveCount,
      secretsKeptLocal: sensitiveCount,
      redactedRegionsCount: sensitiveCount,
      detectedCategories
    });
    this.notify('PRIVACY_UPDATED', task.privacyMetrics);

    // STEP 3: SERVER VLM PERCEPTION (sanitized data only)
    taskManager.updateState(AgentState.VISUAL_ANALYSIS, 'Interpreting the visual layout…');
    this.notify('STATE_CHANGED', { state: AgentState.VISUAL_ANALYSIS });

    const visualObservation = await defaultVLMClient.processVisuals(
      task.id,
      redactedScreenshot,
      sanitizedDOM,
      { viewport: rawDOM.viewport, title: rawDOM.title, url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url) }
    );

    taskManager.updatePrivacyMetrics({ serverCallsCount: 1 });

    // STEP 4: OBSERVATION FUSION + injection quarantine
    const fusedObservation = defaultObservationFusion.fuse(
      sanitizedElements,
      visualObservation,
      { domain: defaultDOMSanitizer.sanitizeUrl(rawDOM.url), title: rawDOM.title, viewport: rawDOM.viewport }
    );
    this.quarantineInjectedElements(fusedObservation);

    if (!task.taskState) {
      task.taskState = new TaskState(task.prompt);
    }

    // STEP 4.5: TASK-CONDITIONAL PAGE STATE MODELING
    const pageState = defaultPageStateModeler.modelPageState(fusedObservation, task.taskState);
    task.pageState = pageState;
    console.log("[PAGE_OBSERVED]", JSON.stringify(pageState));

    // STEP 5: REASONING & PLANNING
    taskManager.updateState(AgentState.PLANNING, `Planning next action for "${task.taskState.getActiveSubgoal()}"…`);
    this.notify('STATE_CHANGED', { state: AgentState.PLANNING, active_subgoal: task.taskState.getActiveSubgoal() });

    const planResult = await defaultGPTOSSClient.planNextStep(
      task.prompt,
      fusedObservation,
      task.steps,
      task.taskState,
      pageState
    );

    if (task.taskState && planResult.task_understanding) {
      task.taskState.updateFromModel(planResult.task_understanding);
      task.taskState.updateFromModel(planResult.current_state);
    }

    taskManager.updatePrivacyMetrics({ serverCallsCount: 1 });
    const proposedAction = planResult.action;

    if (proposedAction.action === ActionType.DONE || planResult.isTerminal) {
      taskManager.completeTask(planResult.thought);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: planResult.thought });
      return false;
    }

    // STEP 6: LOCAL SAFETY GATE & RISK VALIDATION
    taskManager.updateState(AgentState.VALIDATING_ACTION, 'Validating action and privacy…');
    this.notify('STATE_CHANGED', { state: AgentState.VALIDATING_ACTION, action: proposedAction });

    const preValidation = defaultActionValidator.validatePreExecution(proposedAction, fusedObservation, task.taskState);
    if (!preValidation.valid) {
      console.warn(`[AgentController] Action failed pre-validation: ${preValidation.reason}. Retrying observation.`);
      taskManager.recordStep({
        thought: preValidation.reason || 'Target changed; re-analyzing the page.',
        action: proposedAction,
        success: false,
        error: preValidation.reason
      });
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: preValidation.reason || 'The target element changed. Re-analyzing the page.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      await this.sleep(500);
      return true;
    }

    const fusedTarget = (fusedObservation.elements || [])
      .find((el) => el.id === proposedAction.target?.element_id) || null;
    const riskAssessment = defaultRiskGate.evaluate(proposedAction, {
      targetElement: proposedAction.target,
      targetDom: fusedTarget?.dom || null,
      currentUrl: rawDOM.url,
      pageTitle: rawDOM.title
    });

    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`);
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
      taskManager.setPendingConfirmation(proposedAction, confirmReason);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('CONFIRMATION_REQUIRED', {
        action: { ...proposedAction, risk: riskAssessment.risk },
        reason: confirmReason,
        privacySummary: {
          dataKeptLocal: proposedAction.value_source || 'No secrets disclosed',
          dataSharedWithServer: 'Sanitized layout metadata only'
        }
      });

      const userApproved = await new Promise((resolve) => {
        this.pendingUserConfirmationResolver = resolve;
      });

      taskManager.clearPendingConfirmation();

      if (!userApproved) {
        taskManager.cancelTask();
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User declined action confirmation' });
        return false;
      }
      taskManager.updateState(AgentState.EXECUTING, 'Approval received — continuing…');
    }

    // STEP 7: LOCAL EXECUTION (secrets resolved strictly locally)
    taskManager.updateState(AgentState.EXECUTING, 'Performing the action in the page…');
    this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: proposedAction });

    let execResult;
    try {
      execResult = await defaultActionExecutor.execute(task.tabId, proposedAction);
    } catch (execErr) {
      execResult = { success: false, error: execErr?.message || 'Execution failed' };
    }

    // STEP 8: VERIFY — execution result determines recovery
    taskManager.updateState(AgentState.VERIFYING, 'Checking the result…');
    this.notify('STATE_CHANGED', { state: AgentState.VERIFYING });

    if (!execResult || execResult.success === false) {
      const errMsg = execResult?.error || 'Action did not complete';
      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: execResult,
        success: false,
        error: String(errMsg).slice(0, 200)
      });
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: 'That action did not complete. The agent will try another way.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      await this.sleep(600);
      return true;
    }

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
      }
    });

    this.notify('STEP_COMPLETED', {
      stepNumber: task.currentStep,
      thought: planResult.thought,
      action: proposedAction,
      success: true,
      timestamp: Date.now()
    });

    await this.sleep(500);
    return true;
  }

  /**
   * True when the tail of the step history is N identical successful actions
   * against the same target — the planner is stuck in a loop.
   */
  _isRepeatingIdenticalAction(task) {
    const steps = task.steps || [];
    if (steps.length < MAX_IDENTICAL_ACTIONS) return false;
    const tail = steps.slice(-MAX_IDENTICAL_ACTIONS);
    
    // Check if state fingerprint is identical across these steps
    const stateFingerprint = (s) => {
      const p = s.diagnostic?.page_state || {};
      return `${p.url}::${p.summary}::${p.detected_form}`;
    };
    
    const keyOf = (s) => {
      const a = s?.action || {};
      const t = a.target || {};
      return `${a.action}::${t.element_id || t.url || ''}::${a.value_source || a.value || ''}`;
    };
    
    const firstAction = keyOf(tail[0]);
    const firstState = stateFingerprint(tail[0]);
    
    return tail.every((s) => s.success === true && keyOf(s) === firstAction && stateFingerprint(s) === firstState);
  }

  /**
   * Strips webpage-embedded instruction attacks from the observation copy
   * passed to the planner. Webpage text is untrusted data, never instructions.
   */
  quarantineInjectedElements(fusedObservation) {
    if (!fusedObservation || !Array.isArray(fusedObservation.elements)) return;
    let quarantined = 0;
    for (const elmt of fusedObservation.elements) {
      const label = elmt?.dom?.label || elmt?.visual?.description || '';
      if (containsInjection(label)) {
        quarantined++;
        if (elmt.dom) {
          elmt.dom.label = '[Untrusted page text — ignored]';
          elmt.dom.value = elmt.dom.sensitive ? '[REDACTED]' : '';
        }
        if (elmt.visual) elmt.visual.description = 'Untrusted page content (quarantined)';
      }
    }
    if (quarantined > 0) {
      console.warn(`[AgentController] Quarantined ${quarantined} injected element(s) from webpage content.`);
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

  handleUserConfirmation(approved) {
    if (this.pendingUserConfirmationResolver) {
      this.pendingUserConfirmationResolver(approved);
      this.pendingUserConfirmationResolver = null;
    }
  }

  pauseTask() {
    this.isPaused = true;
  }

  resumeTask() {
    this.isPaused = false;
  }

  cancelTask() {
    this.runToken++;
    this.isCancelled = true;
    taskManager.cancelTask();
    const task = taskManager.getTask();
    if (task) this.clearOverlays(task.tabId);
    if (this.pendingUserConfirmationResolver) {
      this.pendingUserConfirmationResolver(false);
      this.pendingUserConfirmationResolver = null;
    }
    this.notify('TASK_CANCELLED', task);
    this.notify('STATE_CHANGED', { state: AgentState.CANCELLED });
  }

  async _extractDOM(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: MessageType.EXTRACT_DOM }, async (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message;
          if (errMsg.includes('Could not establish connection') && typeof chrome !== 'undefined' && chrome.scripting) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content/content.js']
              });
              chrome.tabs.sendMessage(tabId, { type: MessageType.EXTRACT_DOM }, (retryRes) => {
                if (chrome.runtime.lastError) {
                  resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(retryRes || { success: false, error: 'Empty response' });
                }
              });
              return;
            } catch (injectErr) {
              resolve({ success: false, error: injectErr.message });
              return;
            }
          }
          resolve({ success: false, error: errMsg });
        } else {
          resolve(response || { success: false, error: 'Empty response' });
        }
      });
    });
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const agentController = new AgentController();
