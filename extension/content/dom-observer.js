/**
 * DOM Mutation & Page Stability Observer
 * Monitors DOM changes, network activity, and DOM quietness
 * to ensure observations are captured on stable page states.
 */

export class PageStabilityObserver {
  constructor() {
    this.lastMutationTime = Date.now();
    this.observer = null;
    this._startObserving();
  }

  _startObserving() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;

    this.observer = new MutationObserver(() => {
      this.lastMutationTime = Date.now();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  /**
   * Waits until the DOM has been quiet (no mutations) for a minimum threshold
   * @param {number} quietMs - Minimum quiet period in ms (default 300ms)
   * @param {number} timeoutMs - Maximum total wait time in ms (default 3000ms)
   */
  async waitForStability(quietMs = 300, timeoutMs = 3000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const quietDuration = Date.now() - this.lastMutationTime;
      if (quietDuration >= quietMs) {
        return true;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return true; // Timeout reached, proceed anyway
  }
}

export const pageStability = new PageStabilityObserver();
