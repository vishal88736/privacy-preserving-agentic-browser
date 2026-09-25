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
        const queryTabs = () => new Promise((resolve) => {
          const query = { active: true };
          if (windowId !== null && windowId !== undefined) query.windowId = windowId;
          chrome.tabs.query(query, (tabs) => {
            if (chrome.runtime.lastError) resolve([]);
            else resolve(tabs || []);
          });
        });
        const activeBeforeCapture = (await queryTabs())[0];
        if (!activeBeforeCapture || (expectedTabId !== null && activeBeforeCapture.id !== expectedTabId)) {
          return { dataUrl: null, timestamp: Date.now(), captured: false, reason: 'active_tab_changed' };
        }

        const options = { format: 'jpeg', quality: 80 };
        const dataUrl = await new Promise((resolve) => {
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

        if (dataUrl) {
          // captureVisibleTab always reads the active tab. Check again so a
          // tab switch during capture cannot ground actions on the wrong page.
          const activeAfterCapture = (await queryTabs())[0];
          if (!activeAfterCapture || activeAfterCapture.id !== activeBeforeCapture.id ||
              (expectedTabId !== null && activeAfterCapture.id !== expectedTabId)) {
            return { dataUrl: null, timestamp: Date.now(), captured: false, reason: 'active_tab_changed' };
          }
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
