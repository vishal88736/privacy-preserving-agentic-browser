/**
 * Action Validator
 * Performs pre-execution consistency checks against the latest page DOM and fused observation.
 * L4: Now correctly skips validation for actions that don't require a target element.
 */

import { ActionType, isDocumentToken } from '../shared/constants.js';
import { SemanticType } from '../perception/semantic-capability.js';
import { validateNavigationUrl } from '../navigation/navigation.js';

// L4: Actions that do NOT require a target element_id and should bypass target validation
const TARGET_OPTIONAL_ACTIONS = new Set([
  ActionType.DONE,
  ActionType.WAIT,
  ActionType.NAVIGATE,
  ActionType.SCROLL,
  ActionType.GO_BACK,
  ActionType.GO_FORWARD,
  ActionType.EXTRACT,
  ActionType.PRESS_KEY,
  ActionType.OPEN_TAB,
  ActionType.SWITCH_TAB,
  ActionType.ASK_USER,
  ActionType.FILL_FORM_PLAN
]);

// Hard semantic-compatibility gate: element semantics that contradict the
// requested action outright. Derived from general browser semantics — never
// site-specific rules.
const SEMANTIC_TYPE_CONFLICTS = {
  TYPE: new Set([SemanticType.VOICE_INPUT, SemanticType.PLAY, SemanticType.PAUSE, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.DOWNLOAD, SemanticType.LINK]),
  SELECT: new Set([SemanticType.VOICE_INPUT, SemanticType.PLAY, SemanticType.PAUSE, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.LINK]),
  SUBMIT: new Set([SemanticType.LINK, SemanticType.VOICE_INPUT, SemanticType.NEXT, SemanticType.PREVIOUS, SemanticType.DOWNLOAD])
};

function isVaultDocumentDescriptor(value) {
  return Boolean(value) && typeof value === 'object' && value.__vaultDocument === true;
}

function actionCarriesDocument(action) {
  if (isDocumentToken(action?.value_source) || isDocumentToken(action?.value) || isVaultDocumentDescriptor(action?.value)) return true;
  return action?.action === ActionType.FILL_FORM_PLAN &&
    Array.isArray(action.value?.fields) && action.value.fields.some((field) =>
      isDocumentToken(field?.value_source) || isDocumentToken(field?.value) || isVaultDocumentDescriptor(field?.value)
    );
}

export class ActionValidator {
  /**
   * Validates if the action can be safely dispatched to the browser tab
   * @param {Object} action
   * @param {Object} fusedObservation
   * @param {Object} [taskState] - Optional active TaskState for semantic goal alignment
   * @returns {{ valid: boolean, reason?: string }}
   */
  validatePreExecution(action, fusedObservation = {}, taskState = null) {
    const availableElements = fusedObservation.elements || [];
    const formState = fusedObservation.form_state || { completion: { empty: 0 } };

    // File bytes must travel only through UPLOAD. TYPE can never turn a
    // document token or descriptor into text, even when aimed at a file input
    // or invoked without the shared schema validation layer.
    if (action?.action !== ActionType.UPLOAD && actionCarriesDocument(action)) {
      return { valid: false, reason: 'A stored document can only be attached with UPLOAD on a file input.' };
    }

    // A destination URL is a navigation decision whichever verb carries it.
    // OPEN_TAB previously reached the content script with only a scheme regex,
    // so it could open a browser-internal or local host that NAVIGATE refuses
    // — the same policy, two outcomes. Both are checked here now.
    if (action.action === ActionType.OPEN_TAB || action.action === ActionType.NAVIGATE) {
      const url = action.target?.url ?? action.value;
      if (typeof url === 'string' && url.trim()) {
        const check = validateNavigationUrl(url.trim());
        if (!check.valid) {
          return {
            valid: false,
            reason: `${action.action} destination rejected: ${check.reason}`
          };
        }
      }
    }

    if (action.action === ActionType.FILL_FORM_PLAN) {
      const seen = new Set();
      for (const field of action.value?.fields || []) {
        const id = field?.field_id;
        if (!id || seen.has(id)) {
          return { valid: false, reason: 'Form plan contains a missing or duplicate field target.' };
        }
        seen.add(id);
        const match = availableElements.find((element) => element.id === id);
        if (!match) return { valid: false, reason: `Form field "${id}" is no longer present in the current observation.` };
        if (match.dom?.disabled) return { valid: false, reason: `Form field "${id}" is disabled.` };
        const domTag = String(match.dom?.tag || '').toLowerCase();
        const domType = String(match.dom?.type || '').toLowerCase();
        const domRole = String(match.dom?.role || '').toLowerCase();
        const expectedControl = domTag === 'select' ? 'SELECT'
          : domTag === 'textarea' || match.dom?.is_contenteditable === true || domRole === 'textbox' ? 'TEXTAREA'
            : domType === 'radio' || domRole === 'radio' ? 'RADIO'
              : domType === 'checkbox' || domRole === 'checkbox' ? 'CHECKBOX'
                : domType === 'email' ? 'EMAIL'
                  : domType === 'tel' ? 'PHONE'
                    : domType === 'number' ? 'NUMBER'
                      : ['date', 'datetime-local', 'month', 'week'].includes(domType) ? 'DATE' : 'TEXT';
        if (field.control_type && field.control_type !== expectedControl) {
          return { valid: false, reason: `Form field "${id}" changed control type after planning.` };
        }
        if (match.dom?.readonly || String(match.dom?.ariaReadonly || '').toLowerCase() === 'true') {
          return { valid: false, reason: `Form field "${id}" is read-only.` };
        }
        const nativeTextControl = ['input', 'textarea'].includes(domTag) &&
          !['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(domType);
        const customEditable = match.dom?.is_contenteditable === true || domRole === 'textbox';
        const supportedControl = domTag === 'select' ||
          ['checkbox', 'radio'].includes(domType) || ['checkbox', 'radio'].includes(domRole) ||
          nativeTextControl || customEditable;
        if (!supportedControl) {
          return { valid: false, reason: `Form field "${id}" is not a supported writable form control.` };
        }
      }
    }

    // L4: Skip all target validation for actions that don't need targets
    if (TARGET_OPTIONAL_ACTIONS.has(action.action)) {
      return { valid: true };
    }

    // Target-requiring actions must name a real element. Previously a missing
    // target fell through to valid:true and failed opaquely in the content
    // script. Raw coordinates are rejected too: a coordinate-only target has no
    // element to ground against, so it would skip the semantic gate, the
    // disabled check, the staleness check, and the risk gate's DOM inspection
    // while still clicking whatever occupies those pixels.
    if (!action.target?.element_id || typeof action.target.element_id !== 'string') {
      return {
        valid: false,
        reason: `Action "${action.action}" requires an element_id from the current page observation; raw coordinates are not an acceptable target.`
      };
    }

    if (action.action === ActionType.SUBMIT) {
      const submitTarget = availableElements.find((element) => element.id === action.target?.element_id);
      const targetFormId = submitTarget?.dom?.form_id || submitTarget?.form_group_id || null;
      const targetForm = targetFormId
        ? (formState.forms || []).find((form) => form.form_group_id === targetFormId)
        : null;
      const requiredEmpty = Number(targetForm?.completion?.required_empty || 0);
      if (requiredEmpty > 0) {
        return {
          valid: false,
          reason: `Form submission rejected: this form still has ${requiredEmpty} required field${requiredEmpty === 1 ? '' : 's'} to fill.`
        };
      }
    }

    if (action.target?.element_id) {
      let eid = action.target.element_id;
      if (String(eid).startsWith('item_')) {
        const item = (fusedObservation.result_items || []).find((i) => i.id === eid);
        if (item?.primary_action_id) {
          action.target.element_id = item.primary_action_id;
          eid = item.primary_action_id;
        }
      }
      if (eid === 'el_xxx' || !/^[A-Za-z0-9_\-:]+$/.test(String(eid))) {
        return {
          valid: false,
          reason: `Target element "${eid}" is not a real page element id.`
        };
      }
      const match = availableElements.find(el => el.id === action.target.element_id);
      if (!match) {
        return {
          valid: false,
          reason: `Target element "${action.target.element_id}" is no longer present on the page (stale DOM).`
        };
      }
      if (match.actionable === false) {
        return {
          valid: false,
          reason: `Target element "${action.target.element_id}" has no local browser target and cannot be executed.`
        };
      }
      const domTag = String(match.dom?.tag || match.tag || '').toLowerCase();
      const domType = String(match.dom?.type || match.input_type || '').toLowerCase();
      const hiddenStoredDocumentInput = action.action === ActionType.UPLOAD &&
        domTag === 'input' && domType === 'file' && isDocumentToken(action.value_source);
      if ((match.visible === false || match.dom?.is_visible === false) && !hiddenStoredDocumentInput) {
        return {
          valid: false,
          reason: `Target element "${action.target.element_id}" is not visible in the current observation.`
        };
      }
      if (match.dom?.disabled || (match.enabled === false && !hiddenStoredDocumentInput)) {
        return {
          valid: false,
          reason: `Target element "${action.target.element_id}" is currently disabled.`
        };
      }

      const semanticType = String(match.semantics?.semantic_type || match.semantic_action_type || '').toUpperCase();
      if (action.action === ActionType.SELECT && domTag !== 'select') {
        return { valid: false, reason: `SELECT requires a native select element; target "${action.target.element_id}" is ${domTag || 'unknown'}.` };
      }
      if ([ActionType.CHECK, ActionType.UNCHECK].includes(action.action) &&
          !(['checkbox', 'radio'].includes(domType) || ['checkbox', 'radio'].includes(String(match.dom?.role || '').toLowerCase()))) {
        return { valid: false, reason: `${action.action} requires a checkbox or radio control.` };
      }
      if (action.action === ActionType.UNCHECK &&
          (domType === 'radio' || String(match.dom?.role || '').toLowerCase() === 'radio')) {
        return { valid: false, reason: 'A radio option cannot be unchecked without selecting another option.' };
      }
      if (action.action === ActionType.UPLOAD && domType !== 'file') {
        return { valid: false, reason: 'UPLOAD requires a file input element.' };
      }
      if (action.action === ActionType.SUBMIT &&
          domTag !== 'form' && domType !== 'submit' && semanticType !== SemanticType.SUBMIT) {
        return { valid: false, reason: 'SUBMIT requires a form or submit control from the current observation.' };
      }

      // ── HARD SEMANTIC COMPATIBILITY GATE ──
      // An element whose derived semantics (general browser semantics, not
      // site-specific rules) contradict the requested action is rejected
      // deterministically: re-observe → re-ground → re-plan, never execute
      // the guessed action.
      const semType = semanticType;
      if (semType) {
        if (action.action === ActionType.TYPE && SEMANTIC_TYPE_CONFLICTS.TYPE.has(semType)) {
          return {
            valid: false,
            reason: `Element "${action.target.element_id}" is a ${semType} control, not a text input. Use a semantically compatible target.`
          };
        }
        if (action.action === ActionType.SELECT && SEMANTIC_TYPE_CONFLICTS.SELECT.has(semType)) {
          return {
            valid: false,
            reason: `Element "${action.target.element_id}" is a ${semType} control, not a select dropdown.`
          };
        }
        if (action.action === ActionType.SUBMIT && semType !== SemanticType.SUBMIT &&
            String(match.dom?.tag || '').toLowerCase() !== 'form' &&
            SEMANTIC_TYPE_CONFLICTS.SUBMIT.has(semType)) {
          return {
            valid: false,
            reason: `Element "${action.target.element_id}" is a ${semType} control, not a submit control.`
          };
        }
      }

      if (action.action === ActionType.TYPE) {
        if (!match.interaction?.typeable) {
          return {
            valid: false,
            reason: `Target element "${action.target.element_id}" is not a typeable input field.`
          };
        }
        
        // Prevent typing into already-filled fields with the same value
        if (match.dom?.value && action.value === match.dom?.value && !action.value_source) {
          return {
            valid: false,
            reason: `Target element "${action.target.element_id}" already contains the requested value.`
          };
        }
      }

      // ── SEMANTIC ACTION RELEVANCE VALIDATION ──
      if (taskState) {
        const activeSubgoal = String(
          taskState.getActiveSubgoal ? taskState.getActiveSubgoal() : (taskState.current_subgoal || '')
        ).toLowerCase();

        const label = String(match.dom?.label || match.visual?.description || action.target.label || '').toLowerCase();
        // Derived semantics are more robust than label regex; the label
        // regex stays as fallback for observations without semantics.
        const isPlayerControl = ['PLAY', 'PAUSE', 'NEXT', 'PREVIOUS', 'VOICE_INPUT'].includes(String(match.semantics?.semantic_type || '').toUpperCase()) ||
          /previous|next|play|pause|volume|mute|replay|shuffle|mix|subscribe|like|dislike|share|clip|save|miniplayer|voice/i.test(label);
        const hasSearchInput = availableElements.some(el =>
          el.dom?.tag === 'input' && (
            /search|find|query/i.test(el.dom?.name || '') ||
            /search|find/i.test(el.dom?.placeholder || '') ||
            el.dom?.id === 'search' ||
            /search/i.test(el.dom?.label || '')
          )
        );

        // Subgoal: Search
        if ((activeSubgoal.startsWith('search for') || activeSubgoal.includes('search')) && action.action === ActionType.CLICK) {
          // Derived semantics distinguish a real search submit from a nearby
          // control whose label merely contains "search" (e.g. voice input);
          // the label regex stays as fallback for observations without
          // semantics.
          const semTypeUpper = String(match.semantics?.semantic_type || '').toUpperCase();
          const isSearchBtn = match.semantics
            ? (semTypeUpper === SemanticType.SEARCH_INPUT || semTypeUpper === SemanticType.SUBMIT)
            : (/search/i.test(label) || match.dom?.id === 'search-icon-legacy');
          if (isPlayerControl && hasSearchInput && !isSearchBtn) {
            const semName = match.semantics?.semantic_type || 'playback';
            return {
              valid: false,
              reason: `Action "CLICK ${action.target.label || label}" is a ${semName} control and does not advance active subgoal "${taskState.getActiveSubgoal()}". Search input is available and should be used first.`
            };
          }
        }

        // Subgoal: Inspect / Select Result
        if ((activeSubgoal.startsWith('inspect') || activeSubgoal.startsWith('select') || activeSubgoal.includes('identify')) && action.action === ActionType.CLICK) {
          if (isPlayerControl) {
            return {
              valid: false,
              reason: `Action "CLICK ${action.target.label || label}" is an irrelevant playback control. The active subgoal is to select the requested result.`
            };
          }
        }

        // Subgoal: Form filling
        if (activeSubgoal.startsWith('fill form') && action.action === ActionType.CLICK) {
          const isFormBtn = match.dom?.tag === 'button' || match.dom?.type === 'submit';
          if (!isFormBtn && match.dom?.tag === 'a') {
            return {
              valid: false,
              reason: `Action "CLICK ${action.target.label || label}" navigates away from the form before required fields are filled.`
            };
          }
        }
      }

      // Reject CLICK on SELECT elements to guide model to use SELECT
      if (action.action === ActionType.CLICK && match.dom?.tag === 'select') {
        return {
          valid: false,
          reason: `Cannot CLICK a select element directly. You MUST use the "SELECT" action with the desired value for element "${action.target.element_id}".`
        };
      }
    }

    return { valid: true };
  }
}

export const defaultActionValidator = new ActionValidator();
