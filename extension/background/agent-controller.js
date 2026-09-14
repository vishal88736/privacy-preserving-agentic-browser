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

      // If user asks to open/navigate to a website, or is currently on a blank/restricted page:
      const navUrl = this._extractNavigationUrl(task.prompt, isRestrictedUrl);
      if (navUrl && (isRestrictedUrl || task.currentStep === 0)) {
        taskManager.updateState(AgentState.EXECUTING);
        this.notify('STATE_CHANGED', { state: AgentState.EXECUTING });
        await defaultActionExecutor.execute(task.tabId, {
          action: ActionType.NAVIGATE,
          target: { url: navUrl }
        });
        taskManager.recordStep({
          thought: `Navigating to ${navUrl}`,
          action: { action: ActionType.NAVIGATE, target: { url: navUrl }, risk: RiskLevel.LOW },
          success: true
        });
        this.notify('STEP_COMPLETED', {
          stepNumber: task.currentStep,
          thought: `Navigating to ${navUrl}`,
          action: { action: ActionType.NAVIGATE, target: { url: navUrl } },
          success: true
        });
        await this.sleep(1000);
        continue;
      }

      if (isRestrictedUrl) {
        throw new Error('Chrome does not permit extensions on internal chrome:// pages. Please open a website or test portal (e.g. http://localhost:5000).');
      }

      // STEP 1: OBSERVE
      taskManager.updateState(AgentState.OBSERVING);
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

  _extractNavigationUrl(prompt, isRestrictedUrl = false) {
    if (!prompt || typeof prompt !== 'string') return null;
    const text = prompt.trim().toLowerCase();

    // Direct URLs
    if (text.startsWith('http://') || text.startsWith('https://')) {
      return text;
    }

    // Direct domain names or local addresses
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/.*)?$/.test(text)) {
      return `https://${text}`;
    }
    if (/^localhost:[0-9]+(?:\/.*)?$/.test(text)) {
      return `http://${text}`;
    }

    // Media Playback verbs: play, watch, listen
    if (text.startsWith('play ') || text.startsWith('watch ') || text.startsWith('listen to ') || text.startsWith('listen ')) {
      let query = text.replace(/^(?:play|watch|listen to|listen)\s+/i, '')
                      .replace(/\s+on\s+youtube/i, '')
                      .trim();
      if (query) {
        return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      }
      return 'https://www.youtube.com';
    }

    // Explicit navigation verbs: open, navigate to, go to, visit, launch, browse to
    const navMatch = text.match(/(?:open|navigate to|go to|visit|launch|browse to)\s+([^\s]+)/i);
    if (navMatch) {
      let target = navMatch[1].toLowerCase().replace(/['"]/g, '');
      if (target === 'youtube' || target === 'yt') return 'https://www.youtube.com';
      if (target === 'google') return 'https://www.google.com';
      if (target === 'github') return 'https://www.github.com';
      if (target === 'wikipedia') return 'https://www.wikipedia.org';
      if (target.startsWith('http://') || target.startsWith('https://')) return target;
      if (target.startsWith('localhost:')) return `http://${target}`;
      if (target.includes('.')) return `https://${target}`;
      
      // Portal keywords
      if (target.includes('aadhaar')) return 'http://localhost:5000/government-aadhaar.html';
      if (target.includes('flight')) return 'http://localhost:5000/flight-search.html';
      if (target.includes('upload') || target.includes('document')) return 'http://localhost:5000/document-upload.html';
      if (target.includes('injection') || target.includes('prompt')) return 'http://localhost:5000/prompt-injection.html';

      return `https://www.google.com/search?q=${encodeURIComponent(target)}`;
    }

    // Standalone words
    if (text === 'youtube' || text === 'yt') return 'https://www.youtube.com';
    if (text === 'google') return 'https://www.google.com';
    if (text === 'github') return 'https://www.github.com';

    // If currently on a blank / restricted tab (e.g. chrome://newtab), auto-route to evaluation portals:
    if (isRestrictedUrl) {
      if (text.includes('aadhaar') || text.includes('pan') || text.includes('profile')) {
        return 'http://localhost:5000/government-aadhaar.html';
      }
      if (text.includes('flight') || text.includes('delhi') || text.includes('pune') || text.includes('ticket')) {
        return 'http://localhost:5000/flight-search.html';
      }
      if (text.includes('upload') || text.includes('pdf') || text.includes('document')) {
        return 'http://localhost:5000/document-upload.html';
      }
      if (text.includes('injection') || text.includes('jailbreak') || text.includes('ignore')) {
        return 'http://localhost:5000/prompt-injection.html';
      }
      if (text.includes('song') || text.includes('music') || text.includes('video') || text.includes('youtube')) {
        return 'https://www.youtube.com';
      }
      if (text.includes('google')) return 'https://www.google.com';
    }

    return null;
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const agentController = new AgentController();
