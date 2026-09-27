/**
 * GPT-OSS 120B Reasoning Client
 * Sends a COMPACT grounded observation (not a raw DOM dump) to /reason.
 */

import { ServerDefaults, ActionType, RiskLevel, SymbolicSecretSource } from '../shared/constants.js';
import { validateReasonPayload } from '../shared/schemas.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultActionParser } from './action-parser.js';
import { localInterpretTask, parseTaskSemantics } from './task-understanding.js';
import { defaultPromptBuilder } from './prompt-builder.js';
import { defaultFormAnalyzer } from './form-analyzer.js';
import { defaultFormPlanBuilder } from './form-plan-builder.js';
import { defaultTaskGrounding } from '../perception/task-grounding.js';
import { rankCandidates, ambiguousCandidates, requiredCapabilities, SemanticType } from '../perception/semantic-capability.js';

export class GPTOSSClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL, formPlanBuilder = defaultFormPlanBuilder) {
    this.baseUrl = baseUrl;
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
    this.formPlanBuilder = formPlanBuilder;
  }

  async post(endpoint, data) {
    // Diagnostic output may identify the route and schema keys, never the
    // task, page text, local values, or request body.
    console.debug(`[gpt-oss-client] POST ${endpoint}; fields=${Object.keys(data || {}).join(',')}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const resp = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    try {
      this.policyEngine.enforceOutboundSafety(payload);
      const response = await this.post('/interpret', payload);
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
    const interpreted = taskState || localInterpretTask(task);
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
    const isFormTask = String(interpreted?.intent || '').toUpperCase() === 'FILL_FORM' ||
      /\b(fill|form|application|register|sign\s*up|profile)\b/i.test(String(task || ''));
    // Route ordinary form-fill requests through the local semantic planner as
    // well. Relying on the remote model here caused it to omit recognized
    // contact fields (especially email and phone) after filling only one field.
    if (isFormTask) {
      const formDecision = this.formPlanBuilder.decide(
        fusedObservation?.elements || [], task, taskHistory
      );
      if (formDecision.status === 'REMAINING' || formDecision.status === 'ASK_USER') {
        return {
          task_understanding: {
            intent: 'FILL_FORM',
            constraints: interpreted.constraints || [],
            active_subgoal: 'fill form fields'
          },
          page_understanding: { page_type: fusedObservation?.page?.page_type || 'form' },
          thought: formDecision.status === 'REMAINING'
            ? 'Filling grounded form controls from local profile sources.'
            : 'Waiting for the user to resolve fields without a clear saved value.',
          action: formDecision.action,
          isTerminal: false,
          remoteCallMade: false,
          remoteCallAttempted: false,
          model_trace: { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'form_plan_builder' }
        };
      }

      const noSubmit = (interpreted.constraints || []).some((constraint) => /must\s*not\s*submit/i.test(String(constraint))) ||
        /\bdo not submit\b|\bdon't submit\b/i.test(String(task || ''));
      if (formDecision.status === 'COMPLETE' && noSubmit) {
        return {
          task_understanding: { intent: 'FILL_FORM', constraints: interpreted.constraints || [] },
          page_understanding: { page_type: fusedObservation?.page?.page_type || 'form' },
          thought: 'All actionable profile fields are resolved; the form was left unsubmitted.',
          action: { action: ActionType.DONE, risk: RiskLevel.LOW, requires_confirmation: false },
          isTerminal: true,
          remoteCallMade: false,
          remoteCallAttempted: false,
          model_trace: { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'form_plan_builder' }
        };
      }
    }

    const compactObs = defaultPromptBuilder.compactObservation(fusedObservation, pageState);
    const history = (taskHistory || []).slice(-5).map((s) => ({
      thought: s.thought,
      action: s.action?.action,
      target: s.action?.target?.element_id || s.action?.target?.label,
      success: s.success,
      error: s.error || undefined,
      ...(s.action?.action === ActionType.EXTRACT && s.success !== false && typeof s.result?.extractedText === 'string'
        ? { extracted_text: s.result.extractedText.slice(0, 3500) }
        : {})
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

    try {
      // A rejected payload is never sent. A privacy block is surfaced (flag +
      // thought) while the grounded local planner keeps the task alive; other
      // failures fall back to the local planner as well.
      this.policyEngine.enforceOutboundSafety(payload);
      // AbortController via post(): a hung backend must not block the agent
      // loop indefinitely (the loop is awaiting this request).
      const response = await this.post(ServerDefaults.REASON_ENDPOINT, payload);

      if (!response.ok) {
        throw new Error(`Reasoning server returned status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data && data.action && typeof data.action === 'object') {
        const isDone = data.action?.action === 'DONE';
        return {
          task_understanding: data.task_understanding,
          page_understanding: data.page_understanding,
          current_state: data.current_state,
          grounding: data.grounding,
          thought: data.thought || 'Planning next action based on semantic reasoning',
          action: data.action,
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
        // The payload was never sent. Surface the privacy block (category
        // names only, never matched values) and continue with the local
        // planner, which fills configured fields without network data.
        console.warn('[GPTOSSClient] Outbound privacy block; using grounded local planner.');
        try {
          const local = this._localPlannerFallback(task, fusedObservation, taskHistory, taskState, pageState);
          local.remoteCallMade = false;
          local.remoteCallAttempted = false;
          local.privacyBlocked = String(err.message || 'Outbound privacy block').slice(0, 200);
          local.thought = `[local-fallback] ${local.privacyBlocked} — continuing with the local planner.`;
          local.model_trace = { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'grounded_fallback', reason: 'privacy_policy' };
          return local;
        } catch (fallbackErr) {
          return {
            thought: `Outbound privacy block: ${err.message}`,
            action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
            isTerminal: false,
            privacyBlocked: String(err.message || 'Outbound privacy block').slice(0, 200),
            remoteCallMade: false,
            remoteCallAttempted: false,
            model_trace: { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'wait_fallback', reason: 'privacy_policy' }
          };
        }
      }
      console.warn(`[GPTOSSClient] Remote reasoning unavailable (${err.message}). Using grounded local planner.`);
      try {
        const local = this._localPlannerFallback(task, fusedObservation, taskHistory, taskState, pageState);
        local.remoteCallMade = false;
        local.remoteCallAttempted = true;
        local.model_trace = { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'grounded_fallback', reason: err?.name || 'remote_error' };
        return local;
      } catch (fallbackErr) {
        console.warn(`[GPTOSSClient] Local planner failed: ${fallbackErr.message}`);
        return {
          thought: `Network or Server Error: ${err.message}. Ensure backend is running.`,
          action: {
            action: ActionType.WAIT,
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false,
          remoteCallMade: false,
          remoteCallAttempted: true,
          model_trace: { component: 'reasoning', source: 'local', provider: null, model: null, planner: 'wait_fallback', reason: 'local_planner_error' }
        };
      }
    }
  }

  /**
   * Grounded deterministic planner used ONLY when the remote reasoner is
   * unreachable. It never invents element IDs, prices, or content: every
   * action targets an element present in the supplied observation, chosen
   * via lexical grounding + task semantics + history. The thought explicitly
   * marks this as a local fallback so callers never mistake it for LLM output.
   */
  _localPlannerFallback(task, fusedObservation, taskHistory = [], taskState = null, pageState = null) {
    const obs = fusedObservation || {};
    const elements = obs.elements || [];
    const history = taskHistory || [];
    const interpreted = localInterpretTask(task);
    const semantics = parseTaskSemantics(task);
    const lowerTask = String(task || '').toLowerCase();

    const doneAction = (thought) => ({
      task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
      page_understanding: { page_type: obs.page?.page_type || 'unknown' },
      thought: `[local-fallback] ${thought}`,
      action: { action: ActionType.DONE, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: true
    });


    const elById = new Map(elements.map((e) => [e.id, e]));
    const domOf = (e) => e?.dom || {};
    const interOf = (e) => e?.interaction || {};
    const labelOf = (e) => String(domOf(e).label || domOf(e).placeholder || domOf(e).name || e?.visual?.description || '').toLowerCase();
    const typeOf = (e) => String(domOf(e).type || '').toLowerCase();
    const tagOf = (e) => String(domOf(e).tag || '').toLowerCase();

    const doneTargets = new Set(
      taskHistory.filter((h) => h.success !== false && h.action).map((h) => `${h.action.action}::${h.action.target?.element_id || ''}::${h.action.value_source || h.action.value || ''}`)
    );
    const typedIds = new Set(
      taskHistory.filter((h) => h.action?.action === 'TYPE' && h.action.target?.element_id).map((h) => h.action.target.element_id)
    );
    // Also consider fields filled by FILL_FORM_PLAN as "typed"
    taskHistory.forEach(h => {
      if (h.success !== false && h.action?.action === 'FILL_FORM_PLAN' && h.action.value?.fields) {
        h.action.value.fields.forEach(f => typedIds.add(f.field_id));
      }
    });
    const clickedIds = new Set(
      taskHistory.filter((h) => h.action?.action === 'CLICK' && h.action.target?.element_id).map((h) => h.action.target.element_id)
    );

    const isSearchBox = (e) => {
      const l = `${labelOf(e)} ${domOf(e).name || ''} ${domOf(e).id || ''} ${typeOf(e)}`;
      return /search|find|query/.test(l) || typeOf(e) === 'search';
    };
    const isSubmitBtn = (e) => {
      const l = labelOf(e);
      return typeOf(e) === 'submit' || (tagOf(e) === 'button' && /submit|apply|pay|send|confirm|continue|proceed|upload/i.test(l));
    };
    const isUploadable = (e) => Boolean(interOf(e).uploadable) || typeOf(e) === 'file';
    const isTypeable = (e) => Boolean(interOf(e).typeable) || tagOf(e) === 'input' || tagOf(e) === 'textarea';
    const isClickable = (e) => Boolean(interOf(e).clickable) || tagOf(e) === 'button' || tagOf(e) === 'a';

    const secretForField = (e) => {
      if (domOf(e).value_source && (Object.values(SymbolicSecretSource).includes(domOf(e).value_source) || /^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(domOf(e).value_source))) {
        return domOf(e).value_source;
      }
      const l = `${labelOf(e)} ${domOf(e).name || ''} ${domOf(e).semantic_type || ''}`.toLowerCase();
      if (/aadhaar|aadhar/.test(l)) return SymbolicSecretSource.LOCAL_AADHAAR;
      if (/\bssn\b|social security/.test(l)) return SymbolicSecretSource.LOCAL_SSN;
      if (/\bsin\b|social insurance/.test(l)) return SymbolicSecretSource.LOCAL_SIN;
      if (/\bnin\b|national insurance/.test(l)) return SymbolicSecretSource.LOCAL_NIN;
      if (/\bnhs\b/.test(l)) return SymbolicSecretSource.LOCAL_NHS;
      if (/\biban\b/.test(l)) return SymbolicSecretSource.LOCAL_IBAN;
      if (/\bpan\b/.test(l)) return SymbolicSecretSource.LOCAL_PAN;
      if (/password|passcode|pin\b/.test(l)) return SymbolicSecretSource.LOCAL_PASSWORD;
      if (/email/.test(l)) return SymbolicSecretSource.LOCAL_EMAIL;
      if (/phone|mobile|tel/.test(l)) return SymbolicSecretSource.LOCAL_PHONE;
      if (/dob|birth|date of birth/.test(l)) return SymbolicSecretSource.LOCAL_DOB;
      if (/address/.test(l)) return SymbolicSecretSource.LOCAL_ADDRESS;
      if (/\bname\b|full.?name/.test(l)) return SymbolicSecretSource.LOCAL_FULL_NAME;
      if (/card|credit|debit/.test(l) && /cvv|cvc/.test(l)) return SymbolicSecretSource.LOCAL_CVV;
      if (/card|credit|debit/.test(l)) return SymbolicSecretSource.LOCAL_CREDIT_CARD;
      return null;
    };

    const mk = (action, targetId, extra = {}) => {
      const targetEl = targetId ? elById.get(targetId) : null;
      return {
        task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
        page_understanding: { page_type: obs.page?.page_type || 'unknown' },
        thought: `[local-fallback] ${extra.thought || `${action} ${targetId || ''}`.trim()}`,
        action: {
          action,
          ...(targetId ? { target: { element_id: targetId, label: labelOf(targetEl) || targetId } } : {}),
          risk: extra.risk || RiskLevel.LOW,
          requires_confirmation: extra.requires_confirmation || false,
          ...(extra.value !== undefined ? { value: extra.value } : {}),
          ...(extra.value_source ? { value_source: extra.value_source, value: null } : {})
        },
        isTerminal: false
      };
    };

    // 1. Extension-managed local file selection is unsupported. Tell the user
    // to choose the file directly on the site, keeping file bytes out of the
    // extension and model path.
    if (/upload|attach/i.test(lowerTask)) {
      return mk(ActionType.ASK_USER, null, { value: { prompt: 'Choose the file directly in the webpage file picker. The extension does not read or upload local documents.' }, thought: 'Local document selection is unsupported by the extension.' });
    }

    // 2. Fill empty typeable fields (form-filling) using FormAnalyzer
    const wantsFormFill = /fill|form|application|register|sign\s*up|aadhaar|kyc|profile/i.test(lowerTask) || interpreted.intent === 'FILL_FORM';
    
    const hasExecutedFormPlan = taskHistory.some(h => h.action?.action === 'FILL_FORM_PLAN' && h.success !== false);
    console.debug(`Local fallback form check: detected=${wantsFormFill}, prior_plan=${hasExecutedFormPlan}, element_count=${elements.length}`);
    if (wantsFormFill && elements.length > 0 && !hasExecutedFormPlan) {
      const plans = defaultFormAnalyzer.analyzeForms(elements, task);
      console.debug(`Local fallback form analysis: plan_count=${plans.length}`);
      if (plans && plans.length > 0) {
        const askFirst = interpreted.constraints.includes('must ask user before submitting');
        const plan = plans[0];
        const isSensitive = plan.fields?.some(f => 
          [SymbolicSecretSource.LOCAL_AADHAAR, SymbolicSecretSource.LOCAL_PAN, SymbolicSecretSource.LOCAL_PASSWORD, SymbolicSecretSource.LOCAL_CREDIT_CARD, SymbolicSecretSource.LOCAL_CVV, SymbolicSecretSource.LOCAL_DOCUMENT, SymbolicSecretSource.LOCAL_SSN, SymbolicSecretSource.LOCAL_SIN, SymbolicSecretSource.LOCAL_NIN, SymbolicSecretSource.LOCAL_NHS, SymbolicSecretSource.LOCAL_IBAN].includes(f.value_source) ||
          f.semantic_type === 'aadhaar' || f.semantic_type === 'pan' || f.semantic_type === 'password'
        ) || askFirst;
        
        return {
          task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
          page_understanding: { page_type: obs.page?.page_type || 'unknown' },
          current_state: { active_subgoal: interpreted.active_subgoal, completed_subgoals: interpreted.completed_subgoals, expected_state: interpreted.expected_state },
          thought: `[local-fallback] Detected forms, attempting bulk form fill...`,
          action: {
            action: 'FILL_FORM_PLAN',
            risk: RiskLevel.MEDIUM,
            requires_confirmation: askFirst,
            value: plan // send the plan
          },
          isTerminal: false
        };
      }
    }

    // 2b. Ambiguous fields: surface them via ASK_USER instead of guessing.
    // Runs after a bulk plan was executed; asks once per field (tracked in
    // history) then lets the flow converge to DONE / SUBMIT handling.
    if (wantsFormFill && elements.length > 0 && hasExecutedFormPlan) {
      const askedIds = new Set();
      taskHistory.forEach((h) => {
        const prev = h.action?.value?.ambiguousFields;
        if (h.action?.action === 'ASK_USER' && Array.isArray(prev)) {
          prev.forEach((f) => { if (f?.field_id) askedIds.add(f.field_id); });
        }
      });
      const pending = [];
      for (const p of (defaultFormAnalyzer.analyzeForms(elements, task) || [])) {
        for (const a of (p.ambiguous || [])) {
          if (!askedIds.has(a.field_id)) pending.push(a);
        }
      }
      if (pending.length) {
        const names = pending.map((a) => a.label || a.field_id).join(', ');
        return {
          task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
          page_understanding: { page_type: obs.page?.page_type || 'unknown' },
          thought: `[local-fallback] Requesting user clarification for: ${names}`,
          action: {
            action: ActionType.ASK_USER,
            risk: RiskLevel.LOW,
            requires_confirmation: false,
            value: {
              prompt: `The following fields need clarification: ${names}. Reply with the values or "skip".`,
              ambiguousFields: pending
            }
          },
          isTerminal: false
        };
      }
    }

    // Ambiguous-classified fields (newsletter, comments) are ASK_USER
    // territory: never single-fill them with a guessed profile value.
    const ambiguousIds = new Set();
    try {
      for (const p of (defaultFormAnalyzer.analyzeForms(elements, task) || [])) {
        for (const am of (p.ambiguous || [])) ambiguousIds.add(am.field_id);
      }
    } catch { /* analyzer failure must never block planning */ }

    const typeables = elements.filter((e) => isTypeable(e) && !typedIds.has(e.id) && !ambiguousIds.has(e.id));
    if (typeables.length) {
      // Prefer non-search fields for form fills; prefer search box for searches.
      const searchBoxes = typeables.filter(isSearchBox);
      const nonSearch = typeables.filter((e) => !isSearchBox(e));
      if (wantsFormFill && nonSearch.length) {
        const next = nonSearch[0];
        const secret = secretForField(next);
        if (secret) {
          const med = [SymbolicSecretSource.LOCAL_AADHAAR, SymbolicSecretSource.LOCAL_PAN, SymbolicSecretSource.LOCAL_PASSWORD].includes(secret);
          return mk(ActionType.TYPE, next.id, { value_source: secret, risk: med ? RiskLevel.MEDIUM : RiskLevel.LOW, thought: `Fill ${labelOf(next) || next.id} from ${secret}` });
        }
        return mk(ActionType.TYPE, next.id, { value_source: SymbolicSecretSource.LOCAL_PROFILE, thought: `Fill ${labelOf(next) || next.id} from local profile` });
      }
      // Generic route filling: bind "from X to Y" to controls whose labels
      // identify origin and destination. Do not infer field meaning from DOM
      // order; if the page does not label the route fields, leave it to the
      // remote reasoner or ask for clarification.
      const route = lowerTask.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:tomorrow|today|on\s+\d)|$)/i);
      if (route) {
        const origin = task.match(/\bfrom\s+(.+?)\s+to\s+/i)?.[1]?.trim();
        const destination = task.match(/\bfrom\s+.+?\s+to\s+(.+?)(?:\s+(?:tomorrow|today|on\s+\d)|$)/i)?.[1]?.trim();
        const originField = nonSearch.find((e) => /\b(from|origin|source|departure)\b/i.test(`${labelOf(e)} ${domOf(e).name || ''} ${domOf(e).id || ''}`));
        const destinationField = nonSearch.find((e) => /\b(to|destination|arrival)\b/i.test(`${labelOf(e)} ${domOf(e).name || ''} ${domOf(e).id || ''}`));
        if (origin && originField && !typedIds.has(originField.id)) {
          return mk(ActionType.TYPE, originField.id, { value: origin, thought: `Type the requested origin into the labeled origin field.` });
        }
        if (destination && destinationField && !typedIds.has(destinationField.id)) {
          return mk(ActionType.TYPE, destinationField.id, { value: destination, thought: `Type the requested destination into the labeled destination field.` });
        }
      }
      // Generic search/play: type the clean query into the search box.
      if (searchBoxes.length && semantics.search_query) {
        const box = searchBoxes[0];
        return mk(ActionType.TYPE, box.id, { value: semantics.search_query, thought: `Type search query "${semantics.search_query}"` });
      }
      // Fallback: type task-derived value into the first typeable.
      if (nonSearch.length && wantsFormFill) {
        const next = nonSearch[0];
        return mk(ActionType.TYPE, next.id, { value_source: SymbolicSecretSource.LOCAL_PROFILE, thought: `Fill ${next.id} from profile` });
      }
      if (searchBoxes.length === 0 && nonSearch.length && semantics.search_query) {
        return mk(ActionType.TYPE, nonSearch[0].id, { value: semantics.search_query, thought: `Type "${semantics.search_query}"` });
      }
    }

    // 3. After typing a search, click the best SUBMIT candidate — ranked by
    // semantic compatibility against the task, never by proximity or DOM
    // order. A nearby voice-input control is never an equivalent candidate.
    const typedSearch = [...typedIds].some((id) => isSearchBox(elById.get(id)));
    if (typedSearch || (semantics.search_query && taskHistory.some((h) => h.action?.action === 'TYPE'))) {
      const submission = this._selectSemantically(elements, {
        required: new Set([SemanticType.SUBMIT]),
        taskText: task,
        excludeIds: clickedIds
      }, { strict: true });
      if (submission.decision === 'AMBIGUOUS') {
        return this._askBetweenCandidates(submission.ambiguous, interpreted, obs);
      }
      if (submission.candidate) {
        return {
          ...mk(ActionType.CLICK, submission.candidate.element_id, { thought: `Submit search via ${submission.candidate.accessible_name || submission.candidate.element_id}` }),
          selection_evidence: {
            required_action: 'SUBMIT',
            candidate_ids: submission.compatible.slice(0, 5).map((c) => c.element_id),
            candidate_semantics: submission.compatible.slice(0, 5).map((c) => c.semantic_type),
            candidate_scores: submission.compatible.slice(0, 5).map((c) => c.score),
            selected_candidate: submission.candidate.element_id,
            selection_evidence: submission.candidate.evidence_sources
          }
        };
      }
      // No semantically-compatible submit control: fall through — never
      // click a nearby non-submit control.
    }

    // 4. Select a result only when the user asked to open/select/rank one.
    // The grounded reference resolver decides which current result matches;
    // never assume the first card is the user's intended target.
    const results = obs.result_items || [];
    const wantsResultSelection = Boolean(semantics.asks_to_select_result);
    if (results.length && wantsResultSelection) {
      const grounded = pageState?.resolved_references ||
        defaultTaskGrounding.ground(taskState || interpreted, obs).resolved_references;
      const selected = grounded.selected_item;
      const selectedId = selected?.element_id || grounded.cheapest || grounded.first_suitable;
      const pick = results.find((item) => item.primary_action_id === selectedId);
      if (pick?.primary_action_id && elById.has(pick.primary_action_id) && !clickedIds.has(pick.primary_action_id)) {
        return mk(ActionType.CLICK, pick.primary_action_id, { thought: `Open result "${pick.title || pick.id}"` });
      }
    }

    // A search task that has reached result content is complete if it only
    // asked to display results. Do not open a result as an extra action.
    if (results.length && !wantsResultSelection && taskHistory.some((h) =>
      h.success !== false && h.action?.action === 'TYPE' && isSearchBox(elById.get(h.action?.target?.element_id))
    )) {
      return doneAction('The requested search results are visible.');
    }

    // 5. Submit when the form looks complete.
    // SUBMIT is always HIGH risk + requires confirmation (safety gate
    // contract). The "must NOT submit" constraint returns a terminal DONE
    // with no target so the agent stops instead of submitting.
    const submitBtn = elements.find((e) => isSubmitBtn(e) && !clickedIds.has(e.id));
    if (submitBtn) {
      // If we already successfully submitted this form, we are done.
      if (taskHistory.some((h) => h.action?.action === ActionType.SUBMIT && h.action?.target?.element_id === submitBtn.id && h.success !== false)) {
        return doneAction('Form submitted successfully.');
      }
      
      const remainingTypeables = elements.filter((e) => isTypeable(e) && !isSearchBox(e) && !typedIds.has(e.id) && !ambiguousIds.has(e.id));
      if (remainingTypeables.length === 0 || !wantsFormFill) {
        if (interpreted.constraints.includes('must NOT submit the form')) {
          return doneAction(`User asked not to submit; stopping before ${submitBtn.id}.`);
        }
        const askFirst = interpreted.constraints.includes('must ask user before submitting');
        return mk(ActionType.SUBMIT, submitBtn.id, {
          risk: RiskLevel.HIGH, requires_confirmation: true, thought: `Submit via ${submitBtn.id}${askFirst ? ' (user asked to confirm)' : ''}`
        });
      }
    }

    // 6. If a video/result was just opened, the task is done. Check BEFORE
    // generic clicks so we never click "Previous" after succeeding.
    if (taskHistory.some((h) => h.action?.action === 'CLICK' && /video|watch/i.test(h.action.target?.element_id || h.action.target?.label || ''))) {
      return doneAction('Target content opened.');
    }

    // 7. Generic click: ranked semantically against the task intent. Noise
    // and media conflicts never outrank relevant targets, and proximity or
    // DOM order alone never decides. With no semantically compatible
    // candidate the agent waits instead of guessing; genuinely ambiguous
    // candidates are surfaced to the user.
    const clickables = elements.filter((e) => isClickable(e) && !isTypeable(e) && tagOf(e) !== 'select');
    if (clickables.length) {
      const genericRanked = rankCandidates(clickables, {
        required: requiredCapabilities(task, interpreted.intent, interpreted.active_subgoal),
        taskText: task,
        excludeIds: clickedIds
      });
      const genericCompatible = genericRanked.filter((c) => !c.conflict && c.score > 0);
      if (genericCompatible.length) {
        const ambiguous = ambiguousCandidates(genericCompatible, { taskText: task });
        if (ambiguous) {
          return this._askBetweenCandidates(ambiguous, interpreted, obs);
        }
        const top = genericCompatible[0];
        return {
          ...mk(ActionType.CLICK, top.element_id, { thought: `Click ${top.accessible_name || top.element_id}` }),
          selection_evidence: {
            required_action: 'CLICK',
            candidate_ids: genericCompatible.slice(0, 5).map((c) => c.element_id),
            candidate_semantics: genericCompatible.slice(0, 5).map((c) => c.semantic_type),
            candidate_scores: genericCompatible.slice(0, 5).map((c) => c.score),
            selected_candidate: top.element_id,
            selection_evidence: top.evidence_sources
          }
        };
      }
    }

    return {
      task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints },
      page_understanding: { page_type: obs.page?.page_type || 'unknown' },
      thought: '[local-fallback] No semantically compatible action available; waiting to re-observe.',
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false
    };
  }

  /**
   * Deterministic semantic candidate selection. `strict` restricts
   * compatibility to the required semantic set only (used for submit
   * selection); otherwise any non-conflicting candidate with positive score
   * is compatible. Returns the ranked list, the top candidate, and an
   * AMBIGUOUS decision when the task text cannot distinguish equals.
   */
  _selectSemantically(elements, { required, taskText, excludeIds }, { strict = false } = {}) {
    const ranked = rankCandidates(elements, { required, taskText, excludeIds });
    const compatible = ranked.filter((c) =>
      !c.conflict && (strict ? required.has(c.semantic_type) : (required.has(c.semantic_type) || c.score > 0))
    );
    const ambiguous = ambiguousCandidates(compatible, { taskText });
    return {
      ranked,
      compatible,
      candidate: compatible[0] || null,
      ambiguous,
      decision: ambiguous ? 'AMBIGUOUS' : (compatible[0] ? 'SELECTED' : 'NONE')
    };
  }

  /**
   * Surface a genuine ambiguity to the user instead of guessing. The choice
   * is presented through the existing clarification modal as a select field;
   * the controller maps the answer to a CLICK on the chosen element.
   */
  _askBetweenCandidates(candidates, interpreted, obs) {
    const options = (candidates || []).map((c) => ({
      text: c.accessible_name || c.element_id,
      value: c.element_id
    }));
    const names = options.map((o) => o.text).join(' | ');
    return {
      task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
      page_understanding: { page_type: obs.page?.page_type || 'unknown' },
      thought: '[local-fallback] Several semantically similar controls match this step; asking the user to choose.',
      action: {
        action: ActionType.ASK_USER,
        risk: RiskLevel.LOW,
        requires_confirmation: false,
        value: {
          prompt: `Multiple similar controls match this step: ${names}. Choose the correct one.`,
          ambiguousFields: [{
            field_id: 'candidate_choice',
            label: 'Choose the correct control',
            control_type: 'SELECT',
            element_type: 'select',
            options
          }]
        }
      },
      isTerminal: false,
      selection_evidence: {
        required_action: 'CLICK',
        candidate_ids: (candidates || []).map((c) => c.element_id),
        candidate_semantics: (candidates || []).map((c) => c.semantic_type),
        decision: 'AMBIGUOUS'
      }
    };
  }
}

export const defaultGPTOSSClient = new GPTOSSClient();
