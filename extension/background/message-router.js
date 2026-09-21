/**
 * Background Message Router
 * Handles IPC between Side Panel UI and Agent Controller.
 * Broadcasts are best-effort (panel may be closed); task state persists
 * in chrome.storage.session across service-worker restarts.
 */

import { MessageType } from '../shared/messages.js';
import { agentController } from './agent-controller.js';
import { taskManager } from './task-manager.js';
import { defaultLocalVault } from '../privacy/local-vault.js';

/**
 * True when the sender is a webpage content-script context (has a tab and is
 * not an extension page). Extension pages — including the side panel, even
 * when loaded in a tab — carry chrome-extension:// URLs and stay allowed.
 */
function isWebpageContext(sender) {
  return Boolean(sender?.tab) && !String(sender?.url || '').startsWith('chrome-extension://');
}

export function setupMessageRouter() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message || {};

    switch (type) {
      case MessageType.START_TASK:
        if (!payload?.prompt || !payload?.tabId) {
          sendResponse({ success: false, error: 'Task needs a prompt and an active tab.' });
        } else {
          agentController.startTask(payload.prompt, payload.tabId);
          sendResponse({ success: true, task: taskManager.getTask() });
        }
        break;

      case MessageType.PAUSE_TASK:
        agentController.pauseTask();
        sendResponse({ success: true });
        break;

      case MessageType.RESUME_TASK:
        agentController.resumeTask();
        sendResponse({ success: true });
        break;

      case MessageType.CANCEL_TASK:
        agentController.cancelTask();
        sendResponse({ success: true, task: taskManager.getTask() });
        break;

      case MessageType.USER_CONFIRM_ACTION:
        agentController.handleUserConfirmation(Boolean(payload?.approved));
        sendResponse({ success: true });
        break;

      case MessageType.USER_PROVIDE_INPUT:
        agentController.handleUserInput(payload || {});
        sendResponse({ success: true });
        break;

      case MessageType.GET_AGENT_STATUS:
        sendResponse({
          task: taskManager.getTask(),
          settings: taskManager.settings,
          vaultSummary: defaultLocalVault.getAvailableKeysSummary()
        });
        break;

      case MessageType.GET_VAULT:
        // Vault plaintext must never be exposed to webpage contexts.
        if (isWebpageContext(sender)) {
          sendResponse({ vault: null, error: 'Vault is only available to the extension panel.' });
          break;
        }
        sendResponse({
          vault: defaultLocalVault.getAllSecretsForUI()
        });
        break;

      case MessageType.UPDATE_VAULT:
        if (isWebpageContext(sender)) {
          sendResponse({ success: false, error: 'Vault is only available to the extension panel.' });
          break;
        }
        if (!payload?.key) {
          sendResponse({ success: false, error: 'Missing vault key.' });
          break;
        }
        defaultLocalVault.updateSecret(payload.key, payload.value).then(() => {
          sendResponse({ success: true });
        }).catch((err) => {
          sendResponse({ success: false, error: err?.message || 'Vault update failed.' });
        });
        return true;

      case MessageType.UPDATE_SETTINGS:
        taskManager.updateSettings(payload || {}).then((settings) => {
          sendResponse({ success: true, settings });
        }).catch((err) => {
          sendResponse({ success: false, error: err?.message || 'Settings update failed.' });
        });
        return true;

      default:
        break;
    }
    return false;
  });

  // Broadcast agent updates to all open side panels (best-effort).
  agentController.subscribe((event, data) => {
    try {
      const task = taskManager.getTask();
      chrome.runtime.sendMessage({
        type: MessageType.AGENT_STATUS_UPDATE,
        payload: { event, data, task }
      }, () => {
        // Panel closed or no listener — expected, ignore.
        if (chrome.runtime?.lastError) { /* noop */ }
      });
    } catch {
      // Side panel unavailable — task state remains persisted via taskManager.persist().
    }
  });
}
