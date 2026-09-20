/**
 * Action Executor
 * Coordinates message dispatch to content script to perform physical
 * browser DOM manipulations and simulated inputs.
 */

import { ActionType } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { validateNavigationUrl } from '../navigation/navigation.js';
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

    if (action.action === ActionType.DONE) {
      return { success: true, isTerminal: true };
    }

    if (action.action === ActionType.NAVIGATE) {
      const rawTarget = action.target?.url || action.value;
      if (!rawTarget) {
        throw new Error('NAVIGATE action requires a target URL');
      }
      // Deterministic scheme/host validation — never navigate to
      // javascript:/data:/file:/chrome: etc., even if a model invented them.
      const validation = validateNavigationUrl(rawTarget);
      if (!validation.valid) {
        throw new Error(`Navigation blocked: ${validation.reason}`);
      }
      const targetUrl = validation.normalizedUrl;
      await chrome.tabs.update(tabId, { url: targetUrl });

      // Wait for navigation and document load
      await new Promise((resolve) => {
        let timer = null;
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo.status === 'complete') {
            if (chrome.tabs?.onUpdated?.removeListener) {
              chrome.tabs.onUpdated.removeListener(listener);
            }
            clearTimeout(timer);
            resolve();
          }
        };
        if (chrome.tabs?.onUpdated?.addListener) {
          chrome.tabs.onUpdated.addListener(listener);
        }
        timer = setTimeout(() => {
          if (chrome.tabs?.onUpdated?.removeListener) {
            chrome.tabs.onUpdated.removeListener(listener);
          }
          resolve();
        }, 3000);
      });

      // Brief delay to allow content script initialization on the new page
      await new Promise(r => setTimeout(r, 600));
      return { success: true, navigatedTo: targetUrl };
    }

    // Resolve local secret if symbolic source is provided
    let resolvedValue = null;
    try {
      if (action.value_source || action.value) {
        resolvedValue = this.valueResolver.resolve(action);
      }
    } catch (e) {
      console.error("[ActionExecutor] Value resolver error:", e);
      return { success: false, error: e.message };
    }

    const payload = {
      action: action.action,
      target: action.target,
      resolvedValue,
      coordinates: action.target?.coordinates,
      deltaX: action.deltaX || action.target?.deltaX || 0,
      deltaY: action.deltaY || action.target?.deltaY || 300,
      timestamp: Date.now()
    };

    // Dispatch execution command to Content Script in the tab
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: MessageType.EXECUTE_ACTION, payload },
        async (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message;
            // Resilient auto-injection if tab existed prior to extension reload
            if (errMsg.includes('Could not establish connection') && typeof chrome !== 'undefined' && chrome.scripting) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  files: ['content/content.js']
                });
                chrome.tabs.sendMessage(
                  tabId,
                  { type: MessageType.EXECUTE_ACTION, payload },
                  (retryRes) => {
                    if (chrome.runtime.lastError) {
                      resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                      resolve(retryRes || { success: true });
                    }
                  }
                );
                return;
              } catch (injectErr) {
                console.error("[ActionExecutor] Injection error:", injectErr);
                resolve({ success: false, error: injectErr.message });
                return;
              }
            }
            console.error("[ActionExecutor] sendMessage error:", errMsg);
            resolve({ success: false, error: errMsg });
          } else {
            resolve(response || { success: true });
          }
        }
      );
    });
  }
}

export const defaultActionExecutor = new ActionExecutor();
