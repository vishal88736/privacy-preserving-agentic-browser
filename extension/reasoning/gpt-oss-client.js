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
        remoteCallMade: false
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
          remoteCallMade: false
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
          remoteCallMade: false
        };
      }
    }

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
      if (err?.name === 'OutboundPolicyViolationError') {
        // The payload was never sent. Surface the privacy block (category
        // names only, never matched values) and continue with the local
        // planner, which fills configured fields without network data.
        console.warn('[GPTOSSClient] Outbound privacy block; using grounded local planner.');
        try {
          const local = this._localPlannerFallback(task, fusedObservation, taskHistory, taskState);
          local.privacyBlocked = String(err.message || 'Outbound privacy block').slice(0, 200);
          local.thought = `[local-fallback] ${local.privacyBlocked} — continuing with the local planner.`;
          return local;
        } catch (fallbackErr) {
          return {
            thought: `Outbound privacy block: ${err.message}`,
            action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
            isTerminal: false,
            privacyBlocked: String(err.message || 'Outbound privacy block').slice(0, 200)
          };
        }
      }
      console.warn(`[GPTOSSClient] Remote reasoning unavailable (${err.message}). Using grounded local planner.`);
      try {
        return this._localPlannerFallback(task, fusedObservation, taskHistory, taskState);
      } catch (fallbackErr) {
        console.warn(`[GPTOSSClient] Local planner failed: ${fallbackErr.message}`);
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

  /**
   * Grounded deterministic planner used ONLY when the remote reasoner is
   * unreachable. It never invents element IDs, prices, or content: every
   * action targets an element present in the supplied observation, chosen
   * via lexical grounding + task semantics + history. The thought explicitly
   * marks this as a local fallback so callers never mistake it for LLM output.
   */
  _localPlannerFallback(task, fusedObservation, taskHistory = [], taskState = null) {
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
      // Flight from/to: "from PUNE to DELHI".
      const fromTo = lowerTask.match(/from\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s+tomorrow|\s+today|$)/i);
      if (fromTo && nonSearch.length >= 1) {
        const origin = fromTo[1].trim().replace(/\b(cheapest|flight|flights)\b/gi, '').trim() || fromTo[1].trim();
        const dest = fromTo[2].trim().replace(/\b(cheapest|flight|flights)\b/gi, '').trim() || fromTo[2].trim();
        const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
        // Heuristic: first input = origin, second = destination.
        if (!typedIds.size && nonSearch.length >= 2) {
          return mk(ActionType.TYPE, nonSearch[0].id, { value: cap(origin.split(' ')[0]), thought: `Type origin ${origin}` });
        }
        if (nonSearch.length >= 2) {
          const alreadyTypedOrigin = [...typedIds].length >= 1;
          if (alreadyTypedOrigin) {
            const destEl = nonSearch.find((e) => !typedIds.has(e.id));
            if (destEl) return mk(ActionType.TYPE, destEl.id, { value: cap(dest.split(' ')[0]), thought: `Type destination ${dest}` });
          }
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

    // 3. After typing a search, click the search button (not player controls).
    const typedSearch = [...typedIds].some((id) => isSearchBox(elById.get(id)));
    if (typedSearch || (semantics.search_query && taskHistory.some((h) => h.action?.action === 'TYPE'))) {
      const btn = elements.find((e) => {
        if (!isClickable(e) || clickedIds.has(e.id)) return false;
        const l = labelOf(e);
        if (/search/i.test(l)) return true;
        return domOf(e).id === 'search-icon-legacy';
      });
      if (btn) return mk(ActionType.CLICK, btn.id, { thought: `Submit search via ${btn.id}` });
    }

    // 4. Results: click cheapest/first/video result, skipping player controls.
    const results = obs.result_items || [];
    if (results.length) {
      let pick = results[0];
      if (/\bpro\b/i.test(lowerTask)) pick = results.find(r => /\bpro\b/i.test(r.title || r.text)) || pick;
      else if (/\bteam\b/i.test(lowerTask)) pick = results.find(r => /\bteam\b/i.test(r.title || r.text)) || pick;
      else if (/\bbasic\b/i.test(lowerTask)) pick = results.find(r => /\bbasic\b/i.test(r.title || r.text)) || pick;

      if (pick.primary_action_id && elById.has(pick.primary_action_id) && !clickedIds.has(pick.primary_action_id)) {
        return mk(ActionType.CLICK, pick.primary_action_id, { thought: `Open result "${pick.title || pick.id}"` });
      }
    }
    // Video results: links with views/title that are not player controls.
    const videoLink = elements.find((e) => {
      if (tagOf(e) !== 'a' || clickedIds.has(e.id)) return false;
      const l = labelOf(e);
      if (/previous|next|play|pause|volume|mute|mix|subscribe|like|share/i.test(l)) return false;
      return /views|official|video|song/i.test(l) || /watch\?v=/.test(domOf(e).href || '');
    });
    if (videoLink && taskHistory.some((h) => h.action?.action === 'CLICK' || h.action?.action === 'TYPE')) {
      return mk(ActionType.CLICK, videoLink.id, { thought: `Open video result ${videoLink.id}` });
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

    // 7. Generic click: first unclicked non-noise button/link. Player
    // controls are never generic targets (they stall search/select flows).
    const genericClick = elements.find((e) => {
      if (!isClickable(e) || clickedIds.has(e.id) || isSubmitBtn(e)) return false;
      if (wantsFormFill && ambiguousIds.has(e.id)) return false; // unasked opt-ins: never toggle blindly
      const l = labelOf(e);
      if (/cookie|privacy policy|subscribe|terms|copyright|footer/i.test(l)) return false;
      if (/previous|next|play|pause|volume|mute|replay|shuffle|mix|like|dislike|share|clip|save|miniplayer/i.test(l)) return false;
      return true;
    });
    if (genericClick) return mk(ActionType.CLICK, genericClick.id, { thought: `Click ${genericClick.id}` });

    return {
      task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints },
      page_understanding: { page_type: obs.page?.page_type || 'unknown' },
      thought: '[local-fallback] No grounded action available; waiting to re-observe.',
      action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
      isTerminal: false
    };
  }
}

export const defaultGPTOSSClient = new GPTOSSClient();
