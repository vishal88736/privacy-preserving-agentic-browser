/**
 * GPT-OSS 120B Reasoning Client
 * Connects to the server-hosted reasoning endpoint (/reason), passes
 * the sanitized unified observation, and receives the structured semantic action plan.
 */

import { ServerDefaults, ActionType, SymbolicSecretSource, RiskLevel } from '../shared/constants.js';
import { validateReasonPayload } from '../shared/schemas.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultActionParser } from './action-parser.js';
import { TaskState } from './task-understanding.js';

export class GPTOSSClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL) {
    this.baseUrl = baseUrl;
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
  }

  /**
   * Dispatches task interpretation request to backend before loop starts
   */
  async interpretTask(taskPrompt) {
    const payload = { task: taskPrompt };
    
    // Safety scan
    this.policyEngine.enforceOutboundSafety(payload);

    try {
      const response = await fetch(`${this.baseUrl}/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Interpret returned ${response.status}`);
      const data = await response.json();
      return data;
    } catch (err) {
      console.warn(`[GPTOSSClient] interpretTask failed: ${err.message}`);
      return {
        intent: 'unknown',
        target: null,
        expected_state: null,
        confidence: 0.0
      };
    }
  }

  /**
   * Dispatches task reasoning request to backend
   */
  async planNextStep(task, fusedObservation, taskHistory = [], taskState = null, pageState = null) {
    const payload = {
      task,
      task_state: taskState ? (taskState.toPayload ? taskState.toPayload() : taskState) : null,
      page_state: pageState || null,
      fused_observation: fusedObservation,
      task_history: taskHistory,
      timestamp: Date.now()
    };

    // 1. Validate payload
    validateReasonPayload(payload);

    // 2. Scan outbound data to ensure no plaintext secrets are leaking
    this.policyEngine.enforceOutboundSafety(payload);

    try {
      const response = await fetch(`${this.baseUrl}${ServerDefaults.REASON_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Reasoning server returned status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (typeof data.action === 'object') {
        const isDone = data.action?.action === 'DONE';
        return {
          task_understanding: data.task_understanding,
          page_understanding: data.page_understanding,
          current_state: data.current_state,
          thought: data.thought || 'Planning next action based on semantic reasoning',
          action: data.action,
          isTerminal: isDone
        };
      }
      return this.actionParser.parse(data.raw_response || JSON.stringify(data));
    } catch (err) {
      console.warn(`[GPTOSSClient] Remote reasoning call failed (${err.message}). No generic local fallback available.`);
      return {
        thought: `Network or Server Error: ${err.message}. Ensure backend is running.`,
        action: {
          action: ActionType.WAIT,
          risk: RiskLevel.LOW,
          requires_confirmation: false
        },
        isTerminal: false
      };
    }
  }
}

export const defaultGPTOSSClient = new GPTOSSClient();
