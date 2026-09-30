/**
 * Action Executor
 * Coordinates message dispatch to content script to perform physical
 * browser DOM manipulations and simulated inputs.
 */

import { ActionType, isDocumentToken } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { validateNavigationUrl } from '../navigation/navigation.js';
import { defaultLocalValueResolver, VAULT_DOCUMENT_MARKER } from './local-value-resolver.js';
import { toBase64 } from '../privacy/vault-crypto.js';

const log = createLogger({ scope: 'ActionExecutor', surface: 'background' });
const CHROME_API_TIMEOUT_MS = 10000;
const OBSERVATION_BOUND_ACTIONS = new Set([
  ActionType.CLICK, ActionType.TYPE, ActionType.SELECT, ActionType.CHECK, ActionType.UNCHECK,
  ActionType.HOVER, ActionType.UPLOAD, ActionType.SUBMIT, ActionType.FILL_FORM_PLAN,
  ActionType.SCROLL, ActionType.PRESS_KEY, ActionType.EXTRACT
]);

/** True only for a descriptor this extension produced from the local vault. */
export function isVaultDocumentValue(value) {
  return Boolean(value) && typeof value === 'object' &&
    value[VAULT_DOCUMENT_MARKER] === true && typeof value.name === 'string';
}

/**
 * Make a resolved document survive the trip to the content script.
 *
 * `chrome.tabs.sendMessage` serializes its payload as JSON, so a Uint8Array
 * would arrive as `{"0":12,...}` and the content script could not build a File
 * from it. The bytes are therefore base64-encoded for transport and decoded
 * back inside the page. This object is posted to THIS extension's own content
 * script and is never included in a reasoning/backend request. The marker is
 * required on the receiving side, so nothing else can arrive claiming to be a
 * stored document. Once attached, the current page can read the file.
 */
function toTransportValue(value) {
  if (!isVaultDocumentValue(value)) return value;
  return {
    [VAULT_DOCUMENT_MARKER]: true,
    name: value.name,
    fileName: value.fileName,
    mimeType: value.mimeType,
    byteLength: value.byteLength,
    data: toBase64(value.bytes)
  };
}

function withTimeout(promise, ms = CHROME_API_TIMEOUT_MS, message = 'The browser did not respond in time.') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

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
  async execute(tabId, action, observationContext = null) {
    if (!tabId) {
      throw new Error('ActionExecutor requires a valid target tabId');
    }

    // Keep direct executor calls aligned with the planner/schema contract:
    // document bytes can only cross to the content script through UPLOAD.
    const carriesDocumentHandle = isDocumentToken(action?.value_source) ||
      isDocumentToken(action?.value) || isVaultDocumentValue(action?.value);
    if (carriesDocumentHandle && action?.action !== ActionType.UPLOAD) {
      return { success: false, error: 'Stored document tokens may only be used by UPLOAD actions.' };
    }
    if (action?.action === ActionType.UPLOAD &&
        (!isDocumentToken(action?.value_source) || action?.value !== undefined)) {
      return { success: false, error: 'UPLOAD requires a named stored document in value_source.' };
    }

    if (OBSERVATION_BOUND_ACTIONS.has(action?.action) &&
        (!observationContext || typeof observationContext.snapshotId !== 'string' ||
         !observationContext.snapshotId || !Number.isInteger(observationContext.mutationRevision))) {
      return {
        success: false,
        error: 'This action requires the current page observation. Re-observe before executing it.'
      };
    }

    if (action.action === ActionType.DONE) {
      return { success: true, isTerminal: true };
    }

    if (action.action === ActionType.OPEN_TAB) {
      const rawTarget = action.target?.url || action.value;
      if (!rawTarget) {
        throw new Error('OPEN_TAB action requires a target URL');
      }
      const validation = validateNavigationUrl(rawTarget);
      if (!validation.valid) {
        throw new Error(`New-tab navigation blocked: ${validation.reason}`);
      }
      const openedTab = await withTimeout(chrome.tabs.create({ url: validation.normalizedUrl, active: true }));
      if (!Number.isInteger(openedTab?.id)) {
        return { success: false, error: 'The browser did not return an ID for the new tab.' };
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated?.removeListener?.(listener);
          resolve();
        };
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === openedTab.id && changeInfo.status === 'complete') finish();
        };
        const timer = setTimeout(finish, 5000);
        if (openedTab.status === 'complete') finish();
        else chrome.tabs.onUpdated?.addListener?.(listener);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { success: true, openedUrl: validation.normalizedUrl, openedTabId: openedTab.id };
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
      await withTimeout(chrome.tabs.update(tabId, { url: targetUrl }));

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
        // Keep direct executor entry points safe too: controller startup warms
        // the vault, but resolution must never race decryption after a restart.
        await this.valueResolver.vault?.ready;
        resolvedValue = this.valueResolver.resolve(action);
      }
    } catch (e) {
      log.exception('Value resolver failed', e);
      return { success: false, error: e.message };
    }

    const payload = {
      action: action.action,
      target: action.target,
      // Only the transport form crosses into the page; a resolved string or
      // plan object is passed through untouched.
      resolvedValue: toTransportValue(resolvedValue),
      coordinates: action.target?.coordinates,
      deltaX: action.deltaX || action.target?.deltaX || 0,
      deltaY: action.deltaY || action.target?.deltaY || 300,
      timestamp: Date.now(),
      ...(observationContext ? { observationContext: {
        snapshotId: observationContext.snapshotId,
        mutationRevision: observationContext.mutationRevision
      } } : {})
    };

    // Dispatch execution command to Content Script in the tab
    const send = () => new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ success: false, error: 'Action execution timed out.' }), CHROME_API_TIMEOUT_MS);
      try {
        chrome.tabs.sendMessage(tabId, { type: MessageType.EXECUTE_ACTION, payload }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          finish(runtimeError
            ? { success: false, error: runtimeError.message }
            : (response || { success: true }));
        });
      } catch (error) {
        finish({ success: false, error: error?.message || 'Action dispatch failed.' });
      }
    });

    let result = await send();
    if (!result?.success && String(result?.error || '').includes('Could not establish connection') && chrome.scripting) {
      try {
        await withTimeout(chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/content.js']
        }), CHROME_API_TIMEOUT_MS, 'Content script injection timed out.');
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await send();
      } catch (injectErr) {
        log.exception('Content script injection failed', injectErr);
        return { success: false, error: injectErr?.message || 'Could not initialize the page action executor.' };
      }
    }
    return result;
  }
}

export const defaultActionExecutor = new ActionExecutor();
