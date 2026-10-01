/**
 * GPT-OSS 120B Reasoning Client
 * Sends a COMPACT grounded observation (not a raw DOM dump) to /reason.
 *
 * Planning is backend-LLM-only. When the reasoning backend is unreachable,
 * the client reports planner-unavailable instead of inventing a heuristic
 * plan, so a dead backend can never masquerade as a working agent.
 * The UPLOAD guard below is NOT part of that removal — it is a safety
 * boundary. It still refuses to let the agent read an arbitrary local file:
 * an upload is possible only for a document the USER stored and named, and any
 * other UPLOAD is still routed to ASK_USER.
 */

import { ServerDefaults, ActionType, RiskLevel, isDocumentToken } from '../shared/constants.js';
import { validateAction, validateReasonPayload } from '../shared/schemas.js';
import { createLogger } from '../shared/logger.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultDOMSanitizer } from '../privacy/dom-sanitizer.js';
import { defaultLocalVault } from '../privacy/local-vault.js';
import { defaultActionParser } from './action-parser.js';
import { defaultPromptBuilder } from './prompt-builder.js';

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
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL, { vault = defaultLocalVault } = {}) {
    this.baseUrl = baseUrl;
    this.authToken = '';
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
    this.vault = vault;
  }

  /**
   * Names of the documents the user has stored, or [] when there are none.
   *
   * Names are safe to send (a token, not a value); the bytes are not, and no
   * call on this path ever reads them. This list is the entire vocabulary the
   * model is given for attaching a file: anything not on it is unroutable, and
   * the resolver will refuse to resolve a token that names nothing.
   */
  async _storedDocumentTokens() {
    try {
      await this.vault.ready;
      return this.vault.getDocumentsSummary().map((doc) => doc.name);
    } catch {
      return [];
    }
  }

  /**
   * Is this an upload the user actually authorized?
   *
   * All three must hold: the model named one of the user's stored documents
   * (never a path, a URL, or an inline body), that document exists right now,
   * and the target is a file input the current observation actually saw. A
   * model that emits UPLOAD with anything else gets ASK_USER instead, which is
   * what this guard has always done.
   */
  _isAuthorizedDocumentUpload(action, fusedObservation, storedTokens) {
    if (action?.action !== ActionType.UPLOAD) return false;
    if (!isDocumentToken(action.value_source)) return false;
    if (!storedTokens.includes(action.value_source)) return false;
    if (this.vault.hasDocument && !this.vault.hasDocument(action.value_source)) return false;
    const targetId = action.target?.element_id;
    if (!targetId) return false;
    const element = (fusedObservation?.elements || []).find((item) => item.id === targetId);
    const domType = String(element?.dom?.type || element?.dom?.input_type || '').toLowerCase();
    return domType === 'file';
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

  _backendPrivacyBlocked() {
    return {
      task_understanding: { intent: 'unknown', constraints: [] },
      page_understanding: { page_type: 'unknown' },
      thought: 'The backend rejected this request at its outbound privacy boundary. The model was not called.',
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false,
      privacyBlocked: 'backend_outbound_privacy_gate',
      remoteCallMade: false,
      remoteCallAttempted: true,
      model_trace: { component: 'reasoning', source: 'blocked', provider: null, model: null, planner: 'privacy_blocked' }
    };
  }

  /**
   * Dead-man result for an unreachable planner.
   *
   * The controller fails the task on `plannerUnavailable` rather than looping:
   * without the backend there is no planner, and three WAITs would burn steps to
   * reach the same conclusion.
   *
   * `kind` distinguishes a backend that is not LISTENING from one that answered
   * and was unusable, because the user's fix is different in each case. This is
   * derived from the error, never from anything the server returned, so it
   * cannot be influenced by page content.
   */
  _plannerUnavailable(cause) {
    const detail = cause?.message || cause || 'unknown error';
    const low = String(detail).toLowerCase();
    const name = String(cause?.name || '');
    let kind = 'unreachable';
    if (name === 'AbortError' || low.includes('abort')) {
      // The 25s request budget expired. The backend accepted the connection
      // and then went quiet -- a hung or overloaded server, not a missing one.
      kind = 'timeout';
    } else if (low.includes('http 5') || low.includes('returned 5')) {
      kind = 'server_error';
    } else if (low.includes('returned 4') && !low.includes('401') && !low.includes('403')) {
      kind = 'rejected';
    }
    const advice = {
      unreachable: 'Start the backend (python3 -m uvicorn server:app --app-dir backend --port 8000), then start the task again.',
      timeout: 'The backend accepted the request but did not answer within 25s. Check the backend log for a stalled model call, then retry.',
      server_error: 'The backend returned a server error. Check the backend log, then retry.',
      rejected: 'The backend refused the request. Check the backend log for the reason.'
    }[kind];
    return {
      task_understanding: { intent: 'unknown', constraints: [] },
      page_understanding: { page_type: 'unknown' },
      thought: `Planner unavailable: the reasoning backend could not be reached (${detail}).`,
      // The actionable instruction travels in the result so the side panel can
      // show the actual fix rather than "service unavailable".
      unavailableAdvice: advice,
      unavailableKind: kind,
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false,
      plannerUnavailable: true,
      remoteCallMade: false,
      remoteCallAttempted: true,
      model_trace: { component: 'reasoning', source: 'unavailable', provider: null, model: null, planner: 'unavailable', reason: kind }
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
    // The outbound scanner must see the decrypted vault before it decides
    // whether a request contains one of the user's configured values.
    await Promise.all([this.vault?.ready, defaultLocalVault.ready]);
    const payload = { task: taskPrompt };
    let remoteCallAttempted = false;
    try {
      await this.policyEngine.enforceOutboundSafety(payload);
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
      // An unreachable backend is an ordinary, expected condition (the user may
      // simply not have started it yet). Logging it as an ERROR puts a red entry
      // in chrome://extensions for something the next step reports properly and
      // actionably, which trains people to ignore this panel. Keep the detail --
      // it is the fastest way to diagnose a misconfigured backendUrl -- but at
      // warn level. Privacy violations stay at error, since those are real.
      const isPrivacyBlock = err?.name === 'OutboundPolicyViolationError';
      const detail = String(err?.message || err || 'unknown error').slice(0, 200);
      if (isPrivacyBlock) {
        log.error(`Interpret blocked by the outbound privacy policy: ${detail}`);
      } else {
        log.warn(`Interpret unavailable (${detail}); continuing with unknown intent.`);
      }
      return {
        ...UNKNOWN_INTERPRETATION,
        remoteCallAttempted,
        privacyBlocked: isPrivacyBlock,
        // PolicyEngine messages contain only a safe category/reason, never
        // the matched value. Preserve that diagnostic for the task UI.
        ...(err?.name === 'OutboundPolicyViolationError'
          ? { privacyBlockMessage: String(err.message || 'Outbound policy blocked payload.').slice(0, 200) }
          : {})
      };
    }
  }

  async planNextStep(task, fusedObservation, taskHistory = [], taskState = null, pageState = null) {
    // Do not sanitize, scan, or choose the empty-document fallback against a
    // vault that is still being decrypted after a service-worker restart.
    await Promise.all([this.vault?.ready, defaultLocalVault.ready]);
    // taskState is seeded from the backend /interpret call at task start, so
    // it is always present on the live path. There is no local keyword
    // interpreter anymore: an unknown intent means "ask the planner", which
    // is exactly what the backend planner + critic loop is for.
    const interpreted = taskState || { intent: 'unknown', constraints: [] };
    const storedDocuments = await this._storedDocumentTokens();
    if ((String(interpreted?.intent || '').toUpperCase() === 'UPLOAD' || /\b(upload|attach)\b/i.test(String(task || ''))) &&
        !storedDocuments.length) {
      // Nothing the user stored can be attached, so there is nothing the agent
      // may do here beyond telling the user to pick a file themselves.
      return {
        task_understanding: { intent: 'UPLOAD', constraints: interpreted.constraints || [] },
        page_understanding: { page_type: fusedObservation?.page?.page_type || 'document_upload' },
        thought: 'No matching document is stored in the Local Vault. The user can choose a file in the webpage or save a document in the vault first.',
        action: {
          action: ActionType.ASK_USER,
          risk: RiskLevel.LOW,
          requires_confirmation: false,
          value: { prompt: 'Choose the file directly in the webpage file picker, or save it in Vault → Documents so PrivAgent can attach it after your confirmation.' }
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
        terminate_assessment: s.terminate_assessment === true,
        diagnostic: s.diagnostic?.post_action_verification ? {
          post_action_verification: {
            status: String(s.diagnostic.post_action_verification.status || 'unknown'),
            visible_state_changed: s.diagnostic.post_action_verification.visible_state_changed === true,
            target_present: s.diagnostic.post_action_verification.target_present === true,
            target_state_changed: s.diagnostic.post_action_verification.target_state_changed === true
          }
        } : undefined
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
      // Stored document tokens are disclosed to the reasoning backend/model so
      // it can name only a document the user saved. File names, types, and
      // bytes stay out of this payload.
      stored_documents: storedDocuments,
      timestamp: Date.now()
    };

    validateReasonPayload(payload);

    try {
      // A rejected payload is never sent. Privacy blocks and transport failures
      // are reported to the controller so they cannot turn into fake WAIT
      // actions or be mistaken for successful planning.
      await this.policyEngine.enforceOutboundSafety(payload);
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
        if (response.status === 400) {
          let errorBody = null;
          try { errorBody = await response.json(); } catch { /* non-JSON errors are handled below */ }
          if (errorBody?.detail?.code === 'OUTBOUND_PRIVACY_BLOCK') {
            return this._backendPrivacyBlocked();
          }
          throw new Error(`Reasoning server returned status: 400 ${response.statusText}`);
        }
        throw new Error(`Reasoning server returned status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data && data.action && typeof data.action === 'object') {
        // The live prompt only permits UPLOAD for a document listed in
        // STORED_DOCUMENTS. Fail closed if the model emits the legacy action
        // anyway, or names a document the user never stored: never let it
        // reach the action executor or a page file input.
        if (data.action.action === ActionType.UPLOAD &&
            !this._isAuthorizedDocumentUpload(data.action, fusedObservation, storedDocuments)) {
          log.warn('Remote planner emitted an upload without a stored document; routing to user');
          data.action = {
            action: ActionType.ASK_USER,
            risk: RiskLevel.LOW,
            requires_confirmation: false,
            value: {
              prompt: 'Choose the file directly in the webpage file picker, or save the intended document in Vault → Documents and try again.'
            }
          };
          data.thought = 'I could not verify that this is a stored document and an observed file field, so the user must choose the file on the page.';
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
