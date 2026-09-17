/**
 * Action Validator
 * Performs pre-execution consistency checks against the latest page DOM and fused observation.
 * L4: Now correctly skips validation for actions that don't require a target element.
 */

import { ActionType } from '../shared/constants.js';

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
  ActionType.ASK_USER
]);

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

    // L4: Skip all target validation for actions that don't need targets
    if (TARGET_OPTIONAL_ACTIONS.has(action.action)) {
      return { valid: true };
    }

    // Target-requiring actions must name a real element (or coordinates).
    // Previously a missing target fell through to valid:true and failed
    // opaquely in the content script.
    if (!action.target?.element_id && !action.target?.coordinates) {
      return {
        valid: false,
        reason: `Action "${action.action}" requires a target element from the current page observation.`
      };
    }

    if (action.action === ActionType.SUBMIT) {
      if (formState.completion && formState.completion.empty > 0) {
        return {
          valid: false,
          reason: `Form submission rejected: there are still ${formState.completion.empty} unfilled input fields. You must fill them first.`
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
      if (match.dom?.disabled) {
        return {
          valid: false,
          reason: `Target element "${action.target.element_id}" is currently disabled.`
        };
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
        const isPlayerControl = /previous|next|play|pause|volume|mute|replay|shuffle|mix|subscribe|like|dislike|share|clip|save|miniplayer/i.test(label);
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
          const isSearchBtn = /search/i.test(label) || match.dom?.id === 'search-icon-legacy';
          if (isPlayerControl && hasSearchInput && !isSearchBtn) {
            return {
              valid: false,
              reason: `Action "CLICK ${action.target.label || label}" does not advance active subgoal "${taskState.getActiveSubgoal()}". Search input is available and should be used first.`
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
    }

    return { valid: true };
  }
}

export const defaultActionValidator = new ActionValidator();
