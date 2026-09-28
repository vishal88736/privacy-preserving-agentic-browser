/**
 * Background Message Router
 * Handles IPC between Side Panel UI and Agent Controller.
 * Broadcasts are best-effort (panel may be closed); task state persists
 * in chrome.storage.session across service-worker restarts.
 */

import { MessageType } from '../shared/messages.js';
import { createLogger, LogLevel, levelEnabled } from '../shared/logger.js';
import { agentController } from './agent-controller.js';
import { taskManager } from './task-manager.js';
import { defaultLocalVault } from '../privacy/local-vault.js';

const log = createLogger({ scope: 'MessageRouter', surface: 'background' });

/**
 * Record a diagnostic forwarded by a content script.
 *
 * Only the four real levels are accepted, the level is resolved against a
 * server-side threshold rather than trusted from the page, and redaction is
 * re-applied here: the content world is page-adjacent, so a hostile page could
 * otherwise hand us pre-shaped "already safe" data. The log store's entry cap
 * bounds how much a page can push into it.
 *
 * The record is written under the *content script's* scope rather than the
 * router's, because the scope is what tells a reader which component failed.
 * `source: 'content-script'` plus the page origin is what distinguishes a
 * forwarded line from a background one.
 */
function recordForwardedLogEvent(payload) {
  const level = String(payload?.level || '').toLowerCase();
  if (!Object.values(LogLevel).includes(level)) return;
  if (level === LogLevel.DEBUG || !levelEnabled(level, log.level)) return;
  const message = typeof payload?.message === 'string' ? payload.message : '';
  if (!message) return;

  const scope = String(payload?.scope || 'Content').slice(0, 64);
  // Bound the scope charset too: it is attacker-influenced and ends up as a
  // storage key fragment and a console label.
  const safeScope = /^[A-Za-z0-9._-]+$/.test(scope) ? scope : 'Content';
  const forwarded = createLogger({
    scope: safeScope,
    surface: log.surface,
    store: log.store,
    level: log.level
  });
  forwarded[level](message, {
    source: 'content-script',
    origin: typeof payload?.url === 'string' ? payload.url.slice(0, 200) : null,
    ...(payload?.fields || {})
  });
}

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

    // Content-script diagnostics are one-way and never reach the page, so they
    // are handled before the user-control trust gate below — but only for a
    // sender that really is one of our content scripts.
    if (type === MessageType.LOG_EVENT) {
      if (classifySenderContext(sender, chromeApi.runtime.id) !== 'webpage-content-script') {
        sendResponse({ success: false, error: 'Untrusted message sender.' });
        return false;
      }
      recordForwardedLogEvent(payload);
      sendResponse({ success: true });
      return false;
    }

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
          controller.startTask(payload.prompt, payload.tabId).then(() => {
            sendResponse({ success: true, task: manager.getTask() });
          }).catch((err) => {
            log.exception('Task startup failed', err);
            manager.failTask(err?.message || 'Task startup failed.');
            const task = manager.getTask();
            controller.notify('TASK_FAILED', { error: task?.error, hint: task?.hint });
            sendResponse({
              success: false,
              error: task?.error || 'PrivAgent could not start this task.',
              hint: task?.hint || 'Reload the extension and try again.'
            });
          });
          return true;
        }
        break;

      case MessageType.PAUSE_TASK:
        sendResponse({ success: controller.pauseTask() });
        break;

      case MessageType.RESUME_TASK:
        sendResponse({ success: controller.resumeTask() });
        break;

      case MessageType.CANCEL_TASK:
        sendResponse({ success: controller.cancelTask(), task: manager.getTask() });
        break;

      case MessageType.USER_CONFIRM_ACTION:
        sendResponse({ success: controller.handleUserConfirmation(payload || {}) });
        break;

      case MessageType.USER_PROVIDE_INPUT:
        sendResponse({ success: controller.handleUserInput(payload || {}) });
        break;

      case MessageType.GET_AGENT_STATUS:
        manager.ready.then(() => sendResponse({
          task: manager.getTask(),
          settings: manager.settings,
          vaultSummary: vault.getAvailableKeysSummary()
        }));
        return true;

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
    // Tag every subsequent log line with the task it belongs to. A
    // service-worker log without this is close to useless: the worker restarts
    // constantly, so a stack trace would otherwise be unattributable.
    const task = manager.getTask();
    log.setContext(task
      ? { task_id: task.id, tab_id: task.tabId, state: task.state, step: task.currentStep }
      : { task_id: null, tab_id: null, state: null, step: null });
    try {
      chromeApi.runtime.sendMessage({
        type: MessageType.AGENT_STATUS_UPDATE,
        payload: { event, data, task }
      }, () => {
        // Panel closed or no listener — expected, ignore.
        const _ = (typeof chrome !== 'undefined' && chrome.runtime?.lastError) || chromeApi.runtime?.lastError;
      });
    } catch {
      // Side panel unavailable — task state remains persisted via taskManager.persist().
    }
  });
}
