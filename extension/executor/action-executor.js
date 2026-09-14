/**
 * Action Executor
 * Coordinates message dispatch to content script to perform physical
 * browser DOM manipulations and simulated inputs.
 */

import { ActionType } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { defaultLocalValueResolver } from './local-value-resolver.js';

export class ActionExecutor {
  constructor(valueResolver = defaultLocalValueResolver) {
    this.valueResolver = valueResolver;
  }

  /**
   * Executes a planned action within a browser tab.
   * @param {number} tabId
   * @param {Object} action - Action specification
   * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
   */
  async execute(tabId, action) {
    if (!tabId) {
      throw new Error('ActionExecutor requires a valid target tabId');
    }

    // Resolve local secret if symbolic source is provided
    let resolvedValue = null;
    if (action.value_source || action.value) {
      resolvedValue = this.valueResolver.resolve(action);
    }

    const payload = {
      action: action.action,
      target: action.target,
      resolvedValue,
      coordinates: action.target?.coordinates,
      timestamp: Date.now()
    };

    // Dispatch execution command to Content Script in the tab
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: MessageType.EXECUTE_ACTION, payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: chrome.runtime.lastError.message
            });
          } else {
            resolve(response || { success: true });
          }
        }
      );
    });
  }
}

export const defaultActionExecutor = new ActionExecutor();
