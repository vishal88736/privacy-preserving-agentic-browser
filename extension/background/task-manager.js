/**
 * Task Manager
 * Tracks active task state, execution history, and privacy metrics.
 */

import { AgentState } from '../shared/constants.js';

export class TaskManager {
  constructor() {
    this.currentTask = null;
  }

  createTask(userPrompt, tabId) {
    this.currentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      prompt: userPrompt,
      tabId,
      state: AgentState.IDLE,
      startTime: Date.now(),
      steps: [],
      privacyMetrics: {
        sensitiveFieldsDetected: 0,
        secretsKeptLocal: 0,
        redactedRegionsCount: 0,
        serverCallsCount: 0,
        detectedCategories: []
      },
      currentStep: 0,
      maxSteps: 25,
      pendingConfirmation: null,
      error: null
    };
    return this.currentTask;
  }

  getTask() {
    return this.currentTask;
  }

  updateState(newState) {
    if (this.currentTask) {
      this.currentTask.state = newState;
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
    }
  }

  updatePrivacyMetrics(metricsUpdate) {
    if (this.currentTask) {
      const pm = this.currentTask.privacyMetrics;
      if (metricsUpdate.sensitiveFieldsDetected) pm.sensitiveFieldsDetected += metricsUpdate.sensitiveFieldsDetected;
      if (metricsUpdate.secretsKeptLocal) pm.secretsKeptLocal += metricsUpdate.secretsKeptLocal;
      if (metricsUpdate.redactedRegionsCount) pm.redactedRegionsCount += metricsUpdate.redactedRegionsCount;
      if (metricsUpdate.serverCallsCount) pm.serverCallsCount += metricsUpdate.serverCallsCount;
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
    }
  }

  clearPendingConfirmation() {
    if (this.currentTask) {
      this.currentTask.pendingConfirmation = null;
    }
  }

  completeTask(result = 'Task completed successfully') {
    if (this.currentTask) {
      this.currentTask.state = AgentState.COMPLETED;
      this.currentTask.result = result;
      this.currentTask.endTime = Date.now();
    }
  }

  failTask(error) {
    if (this.currentTask) {
      this.currentTask.state = AgentState.FAILED;
      this.currentTask.error = error;
      this.currentTask.endTime = Date.now();
    }
  }

  cancelTask() {
    if (this.currentTask) {
      this.currentTask.state = AgentState.CANCELLED;
      this.currentTask.endTime = Date.now();
    }
  }
}

export const taskManager = new TaskManager();
