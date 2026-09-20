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
      if (domOf(e).value_source && Object.values(SymbolicSecretSource).includes(domOf(e).value_source)) {
        return domOf(e).value_source;
      }
      const l = `${labelOf(e)} ${domOf(e).name || ''} ${domOf(e).semantic_type || ''}`.toLowerCase();
      if (/aadhaar|aadhar/.test(l)) return SymbolicSecretSource.LOCAL_AADHAAR;
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

    // 1. Upload intent: attach local document to an upload control.
    if (/upload|attach/i.test(lowerTask)) {
      const up = elements.find((e) => isUploadable(e) && !doneTargets.has(`UPLOAD::${e.id}::${SymbolicSecretSource.LOCAL_DOCUMENT}`));
      if (up) {
        return mk(ActionType.UPLOAD, up.id, { value_source: SymbolicSecretSource.LOCAL_DOCUMENT, risk: RiskLevel.HIGH, requires_confirmation: true, thought: `Attach local document to ${up.id}` });
      }
    }

    // 2. Fill empty typeable fields (form-filling) using FormAnalyzer
    const wantsFormFill = /fill|form|application|register|sign\s*up|aadhaar|kyc|profile/i.test(lowerTask) || interpreted.intent === 'FILL_FORM';
    
    const hasExecutedFormPlan = taskHistory.some(h => h.action?.action === 'FILL_FORM_PLAN' && h.success !== false);
    console.log(`PrivacyAgent: wantsFormFill=${wantsFormFill}, hasExecutedFormPlan=${hasExecutedFormPlan}, elements.length=${elements.length}`);
    if (wantsFormFill && elements.length > 0 && !hasExecutedFormPlan) {
      const plans = defaultFormAnalyzer.analyzeForms(elements, task);
      console.log("PrivacyAgent: analyzeForms returned", JSON.stringify(plans));
      if (plans && plans.length > 0) {
        const askFirst = interpreted.constraints.includes('must ask user before submitting');
        const plan = plans[0];
        
        return {
          task_understanding: { intent: interpreted.intent, constraints: interpreted.constraints, target_entity: interpreted.target?.entity },
          page_understanding: { page_type: obs.page?.page_type || 'unknown' },
          thought: `[local-fallback] Detected forms, attempting bulk form fill...`,
          action: {
            action: 'FILL_FORM_PLAN',
            risk: RiskLevel.MEDIUM,
            value: plan // send the plan
          },
          isTerminal: false
        };
      }
    }

    const typeables = elements.filter((e) => isTypeable(e) && !typedIds.has(e.id));
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
      const remainingTypeables = elements.filter((e) => isTypeable(e) && !isSearchBox(e) && !typedIds.has(e.id));
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
