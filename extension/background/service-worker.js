/**
 * Background Service Worker Entry Point (Manifest V3)
 */

import { setupMessageRouter } from './message-router.js';

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

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PrivacyAgent] Extension successfully installed.');
});
