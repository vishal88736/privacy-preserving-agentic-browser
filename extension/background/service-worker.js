/**
 * Background Service Worker Entry Point (Manifest V3)
 */

import { setupMessageRouter } from './message-router.js';
import { taskManager } from './task-manager.js';

console.log('[PrivacyAgent] Background service worker initializing...');

// Configure Chrome's side panel; Firefox opens the equivalent sidebar from
// the browser's sidebar controls using the manifest's sidebar_action entry.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set side panel behavior:', error));
}
if (!chrome.sidePanel && chrome.sidebarAction?.open && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.sidebarAction.open().catch((error) => console.error('Failed to open Firefox sidebar:', error));
  });
}

setupMessageRouter();

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
  console.log('[PrivacyAgent] Extension successfully installed.');
});
