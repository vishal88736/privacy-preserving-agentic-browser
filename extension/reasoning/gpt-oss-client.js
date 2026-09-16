/**
 * GPT-OSS 120B Reasoning Client
 * Sends a COMPACT grounded observation (not a raw DOM dump) to /reason.
 */

import { ServerDefaults, ActionType, RiskLevel } from '../shared/constants.js';
import { validateReasonPayload } from '../shared/schemas.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultActionParser } from './action-parser.js';
import { localInterpretTask } from './task-understanding.js';
import { defaultPromptBuilder } from './prompt-builder.js';

export class GPTOSSClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL) {
    this.baseUrl = baseUrl;
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
  }

  async interpretTask(taskPrompt) {
    const payload = { task: taskPrompt };
    this.policyEngine.enforceOutboundSafety(payload);

    try {
      const response = await fetch(`${this.baseUrl}/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Interpret returned ${response.status}`);
      const data = await response.json();
      if (!data || data.intent === 'unknown') {
        return localInterpretTask(taskPrompt);
      }
      return data;
    } catch (err) {
      console.warn(`[GPTOSSClient] interpretTask failed: ${err.message}`);
      return localInterpretTask(taskPrompt);
    }
  }

  async planNextStep(task, fusedObservation, taskHistory = [], taskState = null, pageState = null) {
    const compactObs = defaultPromptBuilder.compactObservation(fusedObservation, pageState);
    const history = (taskHistory || []).slice(-5).map((s) => ({
      thought: s.thought,
      action: s.action?.action,
      target: s.action?.target?.element_id || s.action?.target?.label,
      success: s.success,
      error: s.error || undefined
    }));

    const payload = {
      task,
      task_state: taskState ? (taskState.toPayload ? taskState.toPayload() : taskState) : null,
      page_state: pageState || null,
      fused_observation: compactObs,
      task_history: history,
      timestamp: Date.now()
    };

    validateReasonPayload(payload);
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
          grounding: data.grounding,
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
