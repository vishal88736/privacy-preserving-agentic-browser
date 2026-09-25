/**
 * Screenshot Capture Service for Browser Agent
 * Uses WebExtension tabs.captureVisibleTab to read the active viewport.
 */

export class ScreenshotService {
  /**
   * Captures the visible tab of the specified window.
   * @param {number} [windowId]
   * @param {number} [expectedTabId] Active tab the caller is observing.
   * @returns {Promise<{ dataUrl: string, width: number, height: number }>}
   */
  async captureTab(windowId = null, expectedTabId = null) {
    if (typeof chrome !== 'undefined' && chrome.tabs?.captureVisibleTab) {
      try {
        if (expectedTabId) {
          try {
            const cur = await chrome.tabs.get(expectedTabId);
            if (!cur.active) {
              await chrome.tabs.update(expectedTabId, { active: true });
              await new Promise((r) => setTimeout(r, 100));
            }
          } catch {}
        }
        const options = { format: 'jpeg', quality: 80 };
        const doCapture = () => new Promise((resolve) => {
          const callback = (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[ScreenshotService] captureVisibleTab notice:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(res || null);
            }
          };

          if (windowId) {
            chrome.tabs.captureVisibleTab(windowId, options, callback);
          } else {
            chrome.tabs.captureVisibleTab(options, callback);
          }
        });

        let dataUrl = await doCapture();
        if (!dataUrl) {
          await new Promise((r) => setTimeout(r, 150));
          dataUrl = await doCapture();
        }

        if (dataUrl) {
          return {
            dataUrl,
            timestamp: Date.now(),
            captured: true
          };
        }
      } catch (err) {
        console.warn('[ScreenshotService] captureTab non-fatal error:', err);
      }
    }

    // Safe fallback image for restricted pages, unit tests, or during tab navigation
    return {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      timestamp: Date.now(),
      captured: false
    };
  }
}

export const defaultScreenshotService = new ScreenshotService();
