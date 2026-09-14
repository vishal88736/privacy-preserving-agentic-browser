/**
 * Action Validator
 * Performs pre-execution consistency checks against the latest page DOM.
 */

import { ActionType } from '../shared/constants.js';

export class ActionValidator {
  /**
   * Validates if the action can be safely dispatched to the browser tab
   * @param {Object} action
   * @param {Array<Object>} availableElements
   * @returns {{ valid: boolean, reason?: string }}
   */
  validatePreExecution(action, availableElements = []) {
    if (action.action === ActionType.DONE || action.action === ActionType.WAIT) {
      return { valid: true };
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
    }

    return { valid: true };
  }
}

export const defaultActionValidator = new ActionValidator();
