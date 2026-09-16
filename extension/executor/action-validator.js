/**
 * Action Validator
 * Performs pre-execution consistency checks against the latest page DOM and fused observation.
 */

import { ActionType } from '../shared/constants.js';

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

    if (action.action === ActionType.DONE || action.action === ActionType.WAIT || action.action === ActionType.NAVIGATE) {
      return { valid: true };
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
        if ((activeSubgoal.startsWith('inspect') || activeSubgoal.startsWith('select')) && action.action === ActionType.CLICK) {
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

