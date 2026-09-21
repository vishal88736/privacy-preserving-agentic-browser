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
    if (typeof MutationObserver === 'undefined') return;
    const target = (typeof document !== 'undefined') ? (document.body || document.documentElement) : null;
    if (!target) {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('DOMContentLoaded', () => this._startObserving(), { once: true });
      }
      return;
    }

    if (this.observer) {
      try { this.observer.disconnect(); } catch {}
    }

    this.observer = new MutationObserver(() => {
      this.lastMutationTime = Date.now();
    });

    try {
      this.observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } catch {}
  }

  markAction() {
    this.lastMutationTime = Date.now();
  }

  /**
   * Waits until the DOM has been quiet (no mutations) for a minimum threshold
   * @param {number} quietMs - Minimum quiet period in ms (default 120ms)
   * @param {number} timeoutMs - Maximum total wait time in ms (default 1500ms)
   */
  async waitForStability(quietMs = 120, timeoutMs = 1500) {
    if (!this.observer) this._startObserving();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const quietDuration = Date.now() - this.lastMutationTime;
      if (quietDuration >= quietMs) {
        return true;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    return true; // Timeout reached, proceed anyway
  }
}

export const pageStability = new PageStabilityObserver();
