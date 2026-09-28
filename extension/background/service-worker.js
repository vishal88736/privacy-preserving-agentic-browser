/**
 * Background Service Worker Entry Point (Manifest V3)
 */

import { setupMessageRouter } from './message-router.js';
import { taskManager } from './task-manager.js';
import { createLogger, getLogStore, installGlobalErrorHandlers, LOG_LEVEL_STORAGE_KEY, normalizeLevel } from '../shared/logger.js';

const log = createLogger({ scope: 'PrivacyAgent', surface: 'background' });

// Install the uncaught-error and unhandled-rejection handlers before anything
// else runs. The worker is suspended without warning, so a rejection that is
// not captured here is not merely unlogged: it is lost with the context.
installGlobalErrorHandlers(log);

// Restore the persisted ring buffer before the first entry is written, so a
// restart appends to the previous run's log instead of replacing it.
getLogStore('background').hydrate().catch(() => {});

log.info('Background service worker initializing...');

// Configure Chrome's side panel; Firefox opens the equivalent sidebar from
// the browser's sidebar controls using the manifest's sidebar_action entry.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => log.exception('Failed to set side panel behavior', error));
}
if (!chrome.sidePanel && chrome.sidebarAction?.open && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.sidebarAction.open().catch((error) => log.exception('Failed to open Firefox sidebar', error));
  });
}

setupMessageRouter();

/**
 * The log level is read from extension storage so it can be raised without a
 * rebuild. A corrupt value falls back to `info` rather than silencing logs.
 */
async function applyConfiguredLogLevel() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(LOG_LEVEL_STORAGE_KEY);
      const requested = stored?.[LOG_LEVEL_STORAGE_KEY];
      if (requested) log.setLevel(normalizeLevel(requested));
    }
  } catch (error) {
    log.warn('Could not read the configured log level; using the default.', { error });
  }
}
void applyConfiguredLogLevel();

// A periodic alarm wakes a suspended extension so the session task snapshot is
// loaded and an orphaned nonterminal task is marked interrupted by
// TaskManager.restorePersistedTask(). The alarm is a recovery trigger, not a
// keepalive mechanism; the agent never assumes that its worker stays alive.
if (chrome.alarms) {
  chrome.alarms.create('agent-recovery-watchdog', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'agent-recovery-watchdog') void taskManager.ready;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  log.info('Extension successfully installed.');
});
