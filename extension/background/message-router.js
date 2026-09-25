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

/** Classify sender using WebExtension identity and its extension document URL. */
export function classifySenderContext(sender, runtimeId) {
  if (!sender) return 'unknown';
  if (sender.id !== runtimeId) return 'foreign-extension';
  let url;
  try { url = new URL(sender.url || ''); } catch { return 'unknown'; }
  const chromeExtensionUrl = url.protocol === 'chrome-extension:' && url.hostname === runtimeId;
  // Firefox's moz-extension host is a browser-generated UUID, while sender.id
  // remains the declared add-on ID checked above.
  const firefoxExtensionUrl = url.protocol === 'moz-extension:' && Boolean(url.hostname);
  if (!chromeExtensionUrl && !firefoxExtensionUrl) return sender.tab ? 'webpage-content-script' : 'unknown';
  if (sender.frameId !== undefined && sender.frameId !== 0) return 'extension-subframe';
  if (url.pathname === '/background/service-worker.js') return 'service-worker';
  if (url.pathname === '/sidepanel/index.html') return 'side-panel';
  return 'extension-page';
}

/** Only the visible first-party side panel may issue user-authorized commands. */
export function isTrustedUserInterface(sender, runtimeId) {
  return classifySenderContext(sender, runtimeId) === 'side-panel';
}

export function setupMessageRouter(chromeApi = chrome, deps = {}) {
  const controller = deps.agentController || agentController;
  const manager = deps.taskManager || taskManager;
  const vault = deps.localVault || defaultLocalVault;
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message || {};

    // Background initiated local inference is answered by the open side panel.
    // Ignore it here so this control-only router cannot race that response.
    if (type === MessageType.LOCAL_VISION_ANALYZE && sender?.id === chromeApi.runtime.id && !sender.tab) {
      return false;
    }

    // All messages handled here are user controls or disclose extension state.
    // Webpage content scripts share the extension ID, so ID-only checks are
    // insufficient: require the exact extension-owned side-panel document.
    if (!isTrustedUserInterface(sender, chromeApi.runtime.id)) {
      sendResponse({ success: false, error: 'Untrusted message sender.' });
      return false;
    }

    switch (type) {
      case MessageType.START_TASK:
        if (!payload?.prompt || !payload?.tabId) {
          sendResponse({ success: false, error: 'Task needs a prompt and an active tab.' });
        } else {
          controller.startTask(payload.prompt, payload.tabId);
          sendResponse({ success: true, task: manager.getTask() });
        }
        break;

      case MessageType.PAUSE_TASK:
        controller.pauseTask();
        sendResponse({ success: true });
        break;

      case MessageType.RESUME_TASK:
        controller.resumeTask();
        sendResponse({ success: true });
        break;

      case MessageType.CANCEL_TASK:
        controller.cancelTask();
        sendResponse({ success: true, task: manager.getTask() });
        break;

      case MessageType.USER_CONFIRM_ACTION:
        controller.handleUserConfirmation(Boolean(payload?.approved));
        sendResponse({ success: true });
        break;

      case MessageType.USER_PROVIDE_INPUT:
        controller.handleUserInput(payload || {});
        sendResponse({ success: true });
        break;

      case MessageType.GET_AGENT_STATUS:
        sendResponse({
          task: manager.getTask(),
          settings: manager.settings,
          vaultSummary: vault.getAvailableKeysSummary()
        });
        break;

      case MessageType.GET_VAULT:
        // Vault plaintext must never be exposed to webpage contexts.
        sendResponse({
          vault: vault.getAllSecretsForUI()
        });
        break;

      case MessageType.UPDATE_VAULT:
        if (!payload?.key) {
          sendResponse({ success: false, error: 'Missing vault key.' });
          break;
        }
        vault.updateSecret(payload.key, payload.value).then(() => {
          sendResponse({ success: true });
        }).catch((err) => {
          sendResponse({ success: false, error: err?.message || 'Vault update failed.' });
        });
        return true;

      case MessageType.UPDATE_SETTINGS:
        manager.updateSettings(payload || {}).then((settings) => {
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
  controller.subscribe((event, data) => {
    try {
      const task = manager.getTask();
      chromeApi.runtime.sendMessage({
        type: MessageType.AGENT_STATUS_UPDATE,
        payload: { event, data, task }
      }, () => {
        // Panel closed or no listener — expected, ignore.
        if (chromeApi.runtime?.lastError) { /* noop */ }
      });
    } catch {
      // Side panel unavailable — task state remains persisted via taskManager.persist().
    }
  });
}
