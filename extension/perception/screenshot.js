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
        // Resolve the observed tab's own window when the caller could not:
        // captureVisibleTab photographs the FOCUSED window, so on multi-
        // window setups a null windowId can grab the wrong page entirely.
        let targetWindowId = windowId;
        if (expectedTabId) {
          try {
            const cur = await chrome.tabs.get(expectedTabId);
            if (!targetWindowId && cur?.windowId) targetWindowId = cur.windowId;
            if (cur && !cur.active) {
              // Make the observed tab visible in its own window (required for
              // captureVisibleTab) and focus that window so the capture
              // targets the right page.
              await chrome.tabs.update(expectedTabId, { active: true });
              if (typeof chrome.windows?.update === 'function' && cur.windowId) {
                try { await chrome.windows.update(cur.windowId, { focused: true }); } catch { /* non-fatal */ }
              }
              // Let the compositor settle before capturing.
              await new Promise((r) => setTimeout(r, 250));
            }
          } catch {}
        }
        const options = { format: 'jpeg', quality: 80 };
        const doCapture = (wid) => new Promise((resolve) => {
          const callback = (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[ScreenshotService] captureVisibleTab notice:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(res || null);
            }
          };

          if (wid) {
            chrome.tabs.captureVisibleTab(wid, options, callback);
          } else {
            chrome.tabs.captureVisibleTab(options, callback);
          }
        });

        let dataUrl = await doCapture(targetWindowId);
        // Bounded retries: transient compositor/permission hiccups recover.
        for (let attempt = 0; !dataUrl && attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 200));
          // Last resort: capture the focused window when the tab's own
          // window capture keeps failing.
          dataUrl = await doCapture(attempt === 1 ? null : targetWindowId);
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
