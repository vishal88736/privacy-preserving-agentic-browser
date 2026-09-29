/**
 * GPT-OSS 120B Reasoning Client
 * Sends a COMPACT grounded observation (not a raw DOM dump) to /reason.
 *
 * Planning is backend-LLM-only. The regex-driven local planner fallback and
 * the form-plan-builder route were removed: when the reasoning backend is
 * unreachable the client reports planner-unavailable instead of inventing a
 * heuristic plan, so a dead backend can never masquerade as a working agent.
 * The UPLOAD guard below is NOT part of that removal — it is a safety
 * boundary (local documents must never be read or uploaded by the agent).
 */

import { ServerDefaults, ActionType, RiskLevel, SymbolicSecretSource } from '../shared/constants.js';
import { validateAction, validateReasonPayload } from '../shared/schemas.js';
import { createLogger } from '../shared/logger.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultDOMSanitizer } from '../privacy/dom-sanitizer.js';
import { defaultActionParser } from './action-parser.js';
import { defaultPromptBuilder } from './prompt-builder.js';
import { defaultTaskGrounding } from '../perception/task-grounding.js';

const log = createLogger({ scope: 'GPTOSSClient', surface: 'background' });

/**
 * Interpretation reported when the backend cannot be reached. The intent is
 * honestly unknown: without the planner there is nothing to classify with,
 * and the keyword interpreter that used to fill this gap is gone.
 */
const UNKNOWN_INTERPRETATION = Object.freeze({
  intent: 'unknown',
  target: null,
  constraints: [],
  entities: [],
  expected_state: 'Completed task',
  subgoals: [],
  confidence: 0.0
});

function sanitizePlannerText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return defaultDOMSanitizer.sanitizeUserPrompt(value).slice(0, maxLength);
}

export class GPTOSSClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL) {
    this.baseUrl = baseUrl;
    this.authToken = '';
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
  }

  /**
   * Dead-man result for an unreachable planner.
   *
   * The controller fails the task immediately on `plannerUnavailable`
   * instead of retrying: without the backend there is no planner, and three
   * WAIT loops would only burn steps before reaching the same conclusion.
   * The thought names the failure plainly so the user-facing error says
   * "AI service unavailable" instead of something cryptic.
   */
  /**
   * The backend rejected our credentials (401/403).
   *
   * This is a settings fault in the side panel, not a service outage, and it
   * is by far the most common first-run failure. It gets its own flag and its
   * own message so the user is told to paste the token rather than to restart
   * a backend that is already healthy.
   */
  _backendAuthRejected(status) {
    return {
      task_understanding: { intent: 'unknown', constraints: [] },
      page_understanding: { page_type: 'unknown' },
      thought: `The backend rejected this extension's access token (HTTP ${status}). The backend is running; the extension is not authenticated.`,
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false,
      authRejected: true,
      remoteCallMade: false,
      remoteCallAttempted: true,
      model_trace: { component: 'reasoning', source: 'unauthenticated', provider: null, model: null, planner: 'auth_rejected', reason: `http_${status}` }
    };
  }

  _plannerUnavailable(cause) {
    const detail = cause?.message || cause || 'unknown error';
    return {
      task_understanding: { intent: 'unknown', constraints: [] },
      page_understanding: { page_type: 'unknown' },
      thought: `Planner unavailable: the reasoning backend could not be reached (${detail}). Ensure the backend is running and configured, then start the task again.`,
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false,
      plannerUnavailable: true,
      remoteCallMade: false,
      remoteCallAttempted: true,
      model_trace: { component: 'reasoning', source: 'unavailable', provider: null, model: null, planner: 'unavailable', reason: cause?.name || 'remote_error' }
    };
  }

  async post(endpoint, data) {
    // Diagnostic output may identify the route and schema keys, never the
    // task, page text, local values, or request body.
    log.debug(`POST ${endpoint}; fields=${Object.keys(data || {}).join(',')}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const resp = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { 'X-PrivAgent-Token': this.authToken } : {})
        },
        body: JSON.stringify(data),
        signal: ac.signal
      });
      clearTimeout(timer);
      return resp;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async interpretTask(taskPrompt) {
    const payload = { task: taskPrompt };
    let remoteCallAttempted = false;
    try {
      this.policyEngine.enforceOutboundSafety(payload);
      remoteCallAttempted = true;
      const response = await this.post('/interpret', payload);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return { ...UNKNOWN_INTERPRETATION, authRejected: true };
        throw new Error(`Interpret returned ${response.status}`);
      }
      const data = await response.json();
      if (!data || data.intent === 'unknown') {
        return { ...UNKNOWN_INTERPRETATION, remoteCallAttempted };
      }
      return { ...data, remoteCallAttempted };
    } catch (err) {
      log.exception('interpretTask failed; reporting unknown intent', err);
      return {
        ...UNKNOWN_INTERPRETATION,
        remoteCallAttempted,
        privacyBlocked: err?.name === 'OutboundPolicyViolationError'
      };
    }
  }

  async planNextStep(task, fusedObservation, taskHistory = [], taskState = null, pageState = null) {
    // taskState is seeded from the backend /interpret call at task start, so
    // it is always present on the live path. There is no local keyword
    // interpreter anymore: an unknown intent means "ask the planner", which
    // is exactly what the backend planner + critic loop is for.
    const interpreted = taskState || { intent: 'unknown', constraints: [] };
    if (String(interpreted?.intent || '').toUpperCase() === 'UPLOAD' || /\b(upload|attach)\b/i.test(String(task || ''))) {
      return {
        task_understanding: { intent: 'UPLOAD', constraints: interpreted.constraints || [] },
        page_understanding: { page_type: fusedObservation?.page?.page_type || 'document_upload' },
        thought: 'Local document selection is unsupported; the user must choose the file in the webpage.',
        action: {
          action: ActionType.ASK_USER,
          risk: RiskLevel.LOW,
          requires_confirmation: false,
          value: { prompt: 'Choose the file directly in the webpage file picker. The extension does not read or upload local documents.' }
        },
        isTerminal: false,
        remoteCallMade: false,
        remoteCallAttempted: false,
        model_trace: { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'upload_guard' }
      };
    }
    const compactObs = defaultPromptBuilder.compactObservation(fusedObservation, pageState, task);
    const compactPageState = pageState ? {
      ...pageState,
      visible_text_excerpt: compactObs.visible_text,
      visible_text_source_chars: compactObs.visible_text_source_chars,
      visible_text_omitted_chars: compactObs.visible_text_omitted_chars
    } : null;
    const recentHistory = (taskHistory || []).slice(-5);
    const history = recentHistory.map((s, index) => ({
      thought: s.thought,
      action: s.action?.action,
      target: s.action?.target?.element_id || s.action?.target?.label,
      success: s.success,
      error: s.error || undefined,
      ...(index === recentHistory.length - 1 ? {
        plan: sanitizePlannerText(s.planner_plan, 8000),
        planner_feedback: sanitizePlannerText(s.planner_feedback, 3000),
        terminate_assessment: s.terminate_assessment === true
      } : {}),
      ...(s.action?.action === ActionType.EXTRACT && s.success !== false && typeof s.result?.extractedText === 'string'
        ? { extracted_text: s.result.extractedText.slice(0, 3500) }
        : {})
    }));

    const payload = {
      task,
      task_state: taskState ? (taskState.toPayload ? taskState.toPayload() : taskState) : null,
      page_state: compactPageState,
      fused_observation: compactObs,
      task_history: history,
      timestamp: Date.now()
    };

    validateReasonPayload(payload);

    try {
      // A rejected payload is never sent. Privacy blocks and transport failures
      // are reported to the controller so they cannot turn into fake WAIT
      // actions or be mistaken for successful planning.
      this.policyEngine.enforceOutboundSafety(payload);
      // AbortController via post(): a hung backend must not block the agent
      // loop indefinitely (the loop is awaiting this request).
      const response = await this.post(ServerDefaults.REASON_ENDPOINT, payload);

      if (!response.ok) {
        // 401/403 are configuration faults, not outages. They are separated
        // here so the task can name the real fix instead of reporting a
        // generic "planner unavailable" that sends the user hunting for a
        // server that is running perfectly well.
        if (response.status === 401 || response.status === 403) {
          return this._backendAuthRejected(response.status);
        }
        throw new Error(`Reasoning server returned status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data && data.action && typeof data.action === 'object') {
        // The live prompt excludes UPLOAD and directs file selection to the
        // user. Fail closed if a model nevertheless emits the legacy action:
        // never let it reach the action executor or page file input.
        if (data.action.action === ActionType.UPLOAD) {
          log.warn('Remote planner emitted unsupported UPLOAD; routing to user');
          data.action = {
            action: ActionType.ASK_USER,
            risk: RiskLevel.LOW,
            requires_confirmation: false,
            value: {
              prompt: 'Choose the file directly in the webpage file picker. The extension does not read or upload local documents.'
            }
          };
          data.thought = 'Local document selection is unsupported; the user must choose the file in the webpage.';
          data.final_response = '';
        }
        try {
          validateAction(data.action);
        } catch (validationError) {
          // A malformed action cannot be salvaged locally anymore. WAIT and
          // re-observe: the next planner call sees the failure in history
          // and the critic steers it away from repeating the shape. Three
          // consecutive failures trip the controller's circuit breaker.
          log.exception('Remote action failed schema validation; waiting to re-observe', validationError);
          return {
            task_understanding: { intent: interpreted?.intent || 'unknown', constraints: interpreted?.constraints || [] },
            thought: `The planner returned an action that failed validation (${validationError?.message || 'invalid schema'}). Re-observing before retrying.`,
            action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
            plan: sanitizePlannerText(data.plan, 8000),
            planner_feedback: sanitizePlannerText(data.planner_feedback, 3000),
            terminate_assessment: data.terminate_assessment === true,
            final_response: sanitizePlannerText(data.final_response, 3500),
            isTerminal: false,
            remoteCallMade: true,
            remoteCallAttempted: true,
            model_trace: { component: 'reasoning', source: 'remote', provider: null, model: null, planner: 'invalid_action_schema' }
          };
        }
        const isDone = data.action?.action === 'DONE';
        return {
          task_understanding: data.task_understanding,
          page_understanding: data.page_understanding,
          current_state: data.current_state,
          grounding: data.grounding,
          thought: data.thought || 'Planning next action based on semantic reasoning',
          action: data.action,
          plan: sanitizePlannerText(data.plan, 8000),
          planner_feedback: sanitizePlannerText(data.planner_feedback, 3000),
          terminate_assessment: data.terminate_assessment === true,
          final_response: sanitizePlannerText(data.final_response, 3500),
          isTerminal: isDone,
          remoteCallMade: true,
          remoteCallAttempted: true,
          model_trace: data.model_trace || { component: 'reasoning', source: 'remote', provider: null, model: null }
        };
      }
      const parsed = this.actionParser.parse(data?.raw_response || JSON.stringify(data || {}));
      parsed.remoteCallMade = true;
      parsed.remoteCallAttempted = true;
      parsed.model_trace = data?.model_trace || { component: 'reasoning', source: 'remote', provider: null, model: null };
      return parsed;
    } catch (err) {
      if (err?.name === 'OutboundPolicyViolationError') {
        // The payload was never sent. The controller fails the task with a
        // privacy-specific explanation and records the blocked request.
        log.warn('Outbound privacy block; returning the block to the controller.', { violation: err.message });
        return {
          thought: `Outbound privacy block: ${err.message}`,
          action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
          isTerminal: false,
          privacyBlocked: String(err.message || 'Outbound privacy block').slice(0, 200),
          remoteCallMade: false,
          remoteCallAttempted: false,
          model_trace: { component: 'reasoning', source: 'unavailable', provider: null, model: null, planner: 'privacy_blocked' }
        };
      }
      log.exception('Remote reasoning unavailable; reporting planner-unavailable', err);
      return this._plannerUnavailable(err);
    }
  }

}

export const defaultGPTOSSClient = new GPTOSSClient();
