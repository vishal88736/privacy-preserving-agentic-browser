/**
 * Visual Overlay & Agent Cursor
 * Renders an animated pulse cursor and active target highlight in the webpage
 * so the user can visually monitor the agent's actions in real-time.
 */

export class VisualOverlay {
  constructor() {
    this.cursorEl = null;
    this.highlightEl = null;
    this._ensureElements();
  }

  _ensureElements() {
    if (typeof document === 'undefined') return;

    if (!document.getElementById('privacy-agent-cursor')) {
      const cursor = document.createElement('div');
      cursor.id = 'privacy-agent-cursor';
      cursor.style.cssText = `
        position: fixed;
        width: 22px;
        height: 22px;
        background: radial-gradient(circle, rgba(99,102,241,0.9) 0%, rgba(79,70,229,0.5) 70%, transparent 100%);
        border: 2px solid #ffffff;
        border-radius: 50%;
        pointer-events: none;
        z-index: 2147483647;
        transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease;
        box-shadow: 0 0 12px rgba(99, 102, 241, 0.8);
        opacity: 0;
        transform: translate(-50%, -50%);
      `;
      document.documentElement.appendChild(cursor);
      this.cursorEl = cursor;
    } else {
      this.cursorEl = document.getElementById('privacy-agent-cursor');
    }

    if (!document.getElementById('privacy-agent-highlight')) {
      const highlight = document.createElement('div');
      highlight.id = 'privacy-agent-highlight';
      highlight.style.cssText = `
        position: absolute;
        border: 2px solid #6366f1;
        background: rgba(99, 102, 241, 0.12);
        border-radius: 6px;
        pointer-events: none;
        z-index: 2147483646;
        transition: all 0.2s ease;
        opacity: 0;
        box-shadow: 0 0 8px rgba(99, 102, 241, 0.4);
      `;
      document.documentElement.appendChild(highlight);
      this.highlightEl = highlight;
    } else {
      this.highlightEl = document.getElementById('privacy-agent-highlight');
    }
  }

  showCursor(x, y) {
    this._ensureElements();
    if (this.cursorEl) {
      this.cursorEl.style.left = `${x}px`;
      this.cursorEl.style.top = `${y}px`;
      this.cursorEl.style.opacity = '1';
    }
  }

  highlightElement(element) {
    this._ensureElements();
    if (!element || !this.highlightEl) return;
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    this.highlightEl.style.left = `${rect.left + scrollX - 3}px`;
    this.highlightEl.style.top = `${rect.top + scrollY - 3}px`;
    this.highlightEl.style.width = `${rect.width + 6}px`;
    this.highlightEl.style.height = `${rect.height + 6}px`;
    this.highlightEl.style.opacity = '1';

    // Move cursor to center of element
    this.showCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  clear() {
    if (this.cursorEl) this.cursorEl.style.opacity = '0';
    if (this.highlightEl) this.highlightEl.style.opacity = '0';
  }
}

export const visualOverlay = new VisualOverlay();
