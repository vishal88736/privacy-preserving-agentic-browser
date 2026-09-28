/**
 * Screenshot Capture Service for Browser Agent
 * Uses WebExtension tabs.captureVisibleTab to read the active viewport.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger({ scope: 'ScreenshotService', surface: 'background' });

export class ScreenshotService {
  /**
   * Captures the visible tab of the specified window.
   * @param {number} [windowId]
   * @param {number} [expectedTabId] Active tab the caller is observing.
   * @returns {Promise<{ dataUrl: string, captured: boolean }>}
   */
  async captureTab(windowId = null, expectedTabId = null) {
    if (typeof chrome !== 'undefined' && chrome.tabs?.captureVisibleTab) {
      try {
        // Resolve the observed tab's own window when the caller could not:
        // captureVisibleTab photographs the FOCUSED window, so on multi-
        // window setups a null windowId can grab the wrong page entirely.
        let targetWindowId = windowId;
        if (expectedTabId != null) {
          let cur;
          try {
            cur = await withTimeout(chrome.tabs.get(expectedTabId), 5000, 'Tab lookup timed out.');
          } catch { return this._unavailable(); }
          if (!cur || !cur.active) return this._unavailable();
          if (targetWindowId == null && cur.windowId != null) targetWindowId = cur.windowId;
          if (targetWindowId != null && cur.windowId !== targetWindowId) return this._unavailable();
          if (typeof chrome.windows?.get === 'function' && cur.windowId != null) {
            try {
              const ownerWindow = await withTimeout(chrome.windows.get(cur.windowId), 5000, 'Window lookup timed out.');
              // captureVisibleTab may otherwise capture an unrelated focused
              // window. Never activate a background tab or steal OS focus.
              if (ownerWindow?.focused !== true) return this._unavailable();
            } catch { return this._unavailable(); }
          }
        }
        const options = { format: 'jpeg', quality: 80 };
        const doCapture = (wid) => new Promise((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) { settled = true; resolve(null); }
          }, 5000);
          const callback = (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              log.warn('captureVisibleTab reported a notice; falling back.', { notice: chrome.runtime.lastError.message });
              resolve(null);
            } else {
              resolve(res || null);
            }
          };

          if (wid != null) {
            chrome.tabs.captureVisibleTab(wid, options, callback);
          } else {
            chrome.tabs.captureVisibleTab(options, callback);
          }
        });

        let dataUrl = await doCapture(targetWindowId);
        // Bounded retries: transient compositor/permission hiccups recover.
        for (let attempt = 0; !dataUrl && attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 200));
          dataUrl = await doCapture(targetWindowId);
        }

        if (dataUrl) {
          return {
            dataUrl,
            timestamp: Date.now(),
            captured: true
          };
        }
      } catch (err) {
        log.exception('captureTab failed; returning the safe placeholder', err);
      }
    }

    // Safe fallback image for restricted pages, unit tests, or during tab navigation
    return {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      timestamp: Date.now(),
      captured: false
    };
  }

  _unavailable() {
    return {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      timestamp: Date.now(),
      captured: false
    };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

export const defaultScreenshotService = new ScreenshotService();
