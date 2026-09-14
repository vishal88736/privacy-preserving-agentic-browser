/**
 * Agent Controller
 * Orchestrates the autonomous iterative agent loop:
 * OBSERVE -> SANITIZE -> VISUAL_ANALYSIS -> REASON -> PLAN -> SAFETY_GATE -> ACT -> VERIFY
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

export class AgentController {
  constructor() {
    this.activeTabId = null;
    this.isPaused = false;
    this.isCancelled = false;
    this.listeners = new Set();
    this.pendingUserConfirmationResolver = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('Listener notification error:', err);
      }
    }
  }

  /**
   * Starts a new user task
   */
  async startTask(userPrompt, tabId) {
    this.activeTabId = tabId;
    this.isPaused = false;
    this.isCancelled = false;
    this.pendingUserConfirmationResolver = null;

    const task = taskManager.createTask(userPrompt, tabId);
    this.notify('TASK_STARTED', task);

    taskManager.updateState(AgentState.UNDERSTANDING_TASK);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK });

    // Begin iterative agent loop
    this.runLoop().catch(err => {
      console.error('Agent loop encountered unhandled error:', err);
      taskManager.failTask(err.message);
      this.notify('TASK_FAILED', { error: err.message });
    });
  }

  /**
   * The core iterative control loop
   */
  async runLoop() {
    const task = taskManager.getTask();

    while (task.state !== AgentState.COMPLETED && task.state !== AgentState.FAILED && task.state !== AgentState.CANCELLED) {
      if (this.isCancelled) {
        taskManager.cancelTask();
        this.notify('TASK_CANCELLED', task);
        break;
      }

      if (this.isPaused) {
        await this.sleep(300);
        continue;
      }

      if (task.currentStep >= task.maxSteps) {
        taskManager.failTask('Maximum step limit reached without achieving goal');
        this.notify('TASK_FAILED', { error: 'Maximum step limit reached' });
        break;
      }

      // STEP 1: OBSERVE
      taskManager.updateState(AgentState.OBSERVING);
      this.notify('STATE_CHANGED', { state: AgentState.OBSERVING, step: task.currentStep + 1 });

      const [domResponse, screenshotResponse] = await Promise.all([
        this._extractDOM(task.tabId),
        defaultScreenshotService.captureTab()
      ]);

      if (!domResponse?.success) {
        throw new Error(`Failed to extract DOM from tab: ${domResponse?.error || 'Unknown error'}`);
      }

      const rawDOM = domResponse.data;

      // STEP 2: LOCAL PRIVACY SANITIZATION (Client-Side Boundary)
      taskManager.updateState(AgentState.SANITIZING);
      this.notify('STATE_CHANGED', { state: AgentState.SANITIZING });

      const { sanitizedElements, sensitiveCount, detectedCategories } = 
        defaultDOMSanitizer.sanitizeElements(rawDOM.elements);

      const sanitizedDOM = {
        ...rawDOM,
        elements: sanitizedElements
      };

      // Redact sensitive regions on Offscreen Canvas
      const redactedScreenshot = await defaultScreenshotSanitizer.redactScreenshot(
        screenshotResponse.dataUrl,
        sanitizedElements,
        rawDOM.viewport
      );

      // Record Privacy Metrics
      taskManager.updatePrivacyMetrics({
        sensitiveFieldsDetected: sensitiveCount,
        secretsKeptLocal: sensitiveCount,
        redactedRegionsCount: sensitiveCount,
        detectedCategories
      });
      this.notify('PRIVACY_UPDATED', task.privacyMetrics);

      // STEP 3: SERVER VLM PERCEPTION (Visual Understanding)
      taskManager.updateState(AgentState.VISUAL_ANALYSIS);
      this.notify('STATE_CHANGED', { state: AgentState.VISUAL_ANALYSIS });

      const visualObservation = await defaultVLMClient.processVisuals(
        task.id,
        redactedScreenshot,
        sanitizedDOM,
        { viewport: rawDOM.viewport }
      );

      taskManager.updatePrivacyMetrics({ serverCallsCount: 1 });

      // STEP 4: OBSERVATION FUSION (DOM + VLM together)
      const fusedObservation = defaultObservationFusion.fuse(
        sanitizedElements,
        visualObservation,
        { domain: defaultDOMSanitizer.sanitizeUrl(rawDOM.url), title: rawDOM.title, viewport: rawDOM.viewport }
      );

      // STEP 5: REASONING & PLANNING (GPT-OSS 120B)
      taskManager.updateState(AgentState.PLANNING);
      this.notify('STATE_CHANGED', { state: AgentState.PLANNING });

      const planResult = await defaultGPTOSSClient.planNextStep(
        task.prompt,
        fusedObservation,
        task.steps
      );

      taskManager.updatePrivacyMetrics({ serverCallsCount: 1 });
      const proposedAction = planResult.action;

      // Check for terminal DONE
      if (proposedAction.action === ActionType.DONE || planResult.isTerminal) {
        taskManager.completeTask(planResult.thought);
        this.notify('TASK_COMPLETED', { result: planResult.thought });
        break;
      }

      // STEP 6: LOCAL SAFETY GATE & RISK VALIDATION
      taskManager.updateState(AgentState.VALIDATING_ACTION);
      this.notify('STATE_CHANGED', { state: AgentState.VALIDATING_ACTION, action: proposedAction });

      // Check pre-execution validity
      const preValidation = defaultActionValidator.validatePreExecution(proposedAction, fusedObservation.elements);
      if (!preValidation.valid) {
        console.warn(`[AgentController] Action failed pre-validation: ${preValidation.reason}. Retrying observation.`);
        await this.sleep(400);
        continue;
      }

      // Check safety and confirmation requirements
      const riskAssessment = defaultRiskGate.evaluate(proposedAction, {
        targetElement: proposedAction.target,
        currentUrl: rawDOM.url,
        pageTitle: rawDOM.title
      });

      if (!riskAssessment.allowed) {
        taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`);
        this.notify('TASK_FAILED', { error: riskAssessment.reason });
        break;
      }

      // If action requires human approval, pause and prompt
      if (riskAssessment.requiresConfirmation || proposedAction.requires_confirmation) {
        taskManager.setPendingConfirmation(proposedAction, riskAssessment.reason);
        this.notify('CONFIRMATION_REQUIRED', {
          action: proposedAction,
          reason: riskAssessment.reason,
          privacySummary: {
            dataKeptLocal: proposedAction.value_source || 'No secrets disclosed',
            dataSharedWithServer: 'Sanitized layout metadata only'
          }
        });

        // Wait for user click in Side Panel
        const userApproved = await new Promise((resolve) => {
          this.pendingUserConfirmationResolver = resolve;
        });

        taskManager.clearPendingConfirmation();

        if (!userApproved) {
          taskManager.cancelTask();
          this.notify('TASK_CANCELLED', { reason: 'User declined action confirmation' });
          break;
        }
      }

      // STEP 7: LOCAL EXECUTION (Value resolved strictly locally)
      taskManager.updateState(AgentState.EXECUTING);
      this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: proposedAction });

      const execResult = await defaultActionExecutor.execute(task.tabId, proposedAction);

      // STEP 8: VERIFY
      taskManager.updateState(AgentState.VERIFYING);
      this.notify('STATE_CHANGED', { state: AgentState.VERIFYING });

      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: execResult,
        success: execResult.success
      });

      this.notify('STEP_COMPLETED', {
        stepNumber: task.currentStep,
        thought: planResult.thought,
        action: proposedAction,
        success: execResult.success
      });

      // Brief stability pause before next observation cycle
      await this.sleep(500);
    }
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
    this.isCancelled = true;
    if (this.pendingUserConfirmationResolver) {
      this.pendingUserConfirmationResolver(false);
      this.pendingUserConfirmationResolver = null;
    }
  }

  async _extractDOM(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: MessageType.EXTRACT_DOM }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
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
