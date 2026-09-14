/**
 * Background Service Worker Entry Point (Manifest V3)
 */

import { setupMessageRouter } from './message-router.js';

console.log('[PrivacyAgent] Background service worker initializing...');

// Configure side panel to open upon extension icon click
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set side panel behavior:', error));
}

setupMessageRouter();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PrivacyAgent] Extension successfully installed.');
});
