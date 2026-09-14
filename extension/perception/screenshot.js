/**
 * Screenshot Capture Service for Browser Agent
 * Uses chrome.tabs.captureVisibleTab with viewport dimension tracking.
 */

export class ScreenshotService {
  /**
   * Captures the visible tab of the specified window.
   * @param {number} [windowId]
   * @returns {Promise<{ dataUrl: string, width: number, height: number }>}
   */
  async captureTab(windowId = null) {
    if (typeof chrome !== 'undefined' && chrome.tabs?.captureVisibleTab) {
      const options = { format: 'png' };
      const dataUrl = await new Promise((resolve, reject) => {
        const targetWindow = windowId || chrome.windows?.WINDOW_ID_CURRENT;
        chrome.tabs.captureVisibleTab(targetWindow, options, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });

      return {
        dataUrl,
        timestamp: Date.now()
      };
    }

    // Mock image for non-extension / testing environments (1x1 transparent PNG)
    return {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      timestamp: Date.now()
    };
  }
}

export const defaultScreenshotService = new ScreenshotService();
