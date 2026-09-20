/**
 * DOM Extractor
 * Collects interactive controls AND the page evidence the agent needs to
 * understand user requests: headings, result cards, prices, nearby context,
 * viewport/scroll, and a visible-text excerpt.
 */

import { registry } from './element-registry.js';

const CARD_SELECTORS = [
  '[data-asin]',
  '[data-product-id]',
  '[data-sku]',
  '[data-product]',
  '.s-result-item',
  '.product-card',
  '.product',
  '.flight-card',
  '.search-result',
  '.result-item',
  '.listing-card',
  '.item-card',
  'article',
  '[role="listitem"]'
].join(',');

const CONTAINER_SEL = 'article, li, tr, form, fieldset, [role="listitem"], [class*="card"], [class*="product"], [class*="result"], [class*="item"], [class*="flight"], [class*="listing"], [data-product], [data-asin]';

export class DOMExtractor {
  getAccessibleLabel(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.innerText.trim();
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.innerText.trim();
    }

    const parentLabel = element.closest('label');
    if (parentLabel) {
      return parentLabel.innerText.trim();
    }

    if (element.placeholder) return element.placeholder.trim();
    if (element.title) return element.title.trim();
    if (element.name) return element.name.trim();

    if (element.innerText && element.innerText.trim()) {
      return element.innerText.trim().slice(0, 80);
    }

    return '';
  }

  isElementVisible(element, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }

  getContextText(node) {
    const container = node.closest(CONTAINER_SEL) || node.parentElement;
    if (!container) return '';
    return String(container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  }

  parsePrice(text) {
    if (!text) return null;
    const m = String(text).match(/(?:₹|Rs\.?\s*|INR\s*|USD\s*|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  bboxOf(rect) {
    return [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height)
    ];
  }

  containsBBox(outer, inner) {
    return inner[0] >= outer[0] - 6 &&
      inner[1] >= outer[1] - 6 &&
      inner[0] + inner[2] <= outer[0] + outer[2] + 6 &&
      inner[1] + inner[3] <= outer[1] + outer[3] + 6;
  }

  extractHeadings() {
    const out = [];
    for (const h of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      const rect = h.getBoundingClientRect();
      if (!this.isElementVisible(h, rect)) continue;
      const text = (h.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ tag: h.tagName.toLowerCase(), text: text.slice(0, 160), bbox: this.bboxOf(rect) });
      if (out.length >= 12) break;
    }
    return out;
  }

  extractResultItems(interactive) {
    const cards = [];
    const seen = new Set();
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(CARD_SELECTORS));
    } catch {
      nodes = [];
    }

    for (const node of nodes) {
      if (seen.has(node) || node.closest('nav, header, footer, [role="navigation"]')) continue;
      const rect = node.getBoundingClientRect();
      if (!this.isElementVisible(node, rect) || rect.height < 40 || rect.width < 80) continue;
      seen.add(node);
      cards.push({ node, rect, bbox: this.bboxOf(rect) });
      if (cards.length >= 24) break;
    }

    const items = [];
    for (let i = 0; i < cards.length; i++) {
      const { node, bbox } = cards[i];
      const text = String(node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 360);
      if (text.length < 8) continue;
      const price_value = this.parsePrice(text);
      const priceMatch = text.match(/(?:₹|Rs\.?\s*|INR\s*|\$|€|£)\s*[\d,]+(?:\.\d{1,2})?/i);
      const heading = (node.querySelector('h1, h2, h3, h4, a, [class*="title"], [class*="name"]')?.innerText || '')
        .replace(/\s+/g, ' ').trim().slice(0, 140);
      const nested = interactive.filter((el) => el.bbox && this.containsBBox(bbox, el.bbox));
      const primary = nested.find((el) => el.tag === 'a' || el.tag === 'button' || el.role === 'button') || nested[0] || null;
      items.push({
        id: `item_${i + 1}`,
        title: heading || text.slice(0, 80),
        text,
        price_text: priceMatch ? priceMatch[0] : null,
        price_value,
        primary_action_id: primary?.id || null,
        nested_element_ids: nested.map((el) => el.id).slice(0, 8),
        bbox
      });
    }
    return items;
  }

  extractPageElements() {
    registry.clear();
    const selector = 'input, button, a, select, textarea, [role="button"], [role="textbox"], [role="checkbox"], [role="option"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const rawNodes = Array.from(document.querySelectorAll(selector));

    const extracted = [];

    for (const node of rawNodes) {
      const rect = node.getBoundingClientRect();
      const isVisible = this.isElementVisible(node, rect);

      if (!isVisible && node.type !== 'file') continue;
      if (extracted.length >= 80) break;

      const id = registry.register(node);
      const tag = node.tagName.toLowerCase();
      const label = this.getAccessibleLabel(node);
      const context = this.getContextText(node);
      const price_value = this.parsePrice(`${label} ${context}`);

      // Extract form context
      const formEl = node.closest('form');
      const form_id = formEl ? registry.register(formEl) : null;
      const fieldsetEl = node.closest('fieldset');
      const legendEl = fieldsetEl ? fieldsetEl.querySelector('legend') : null;
      const legend = legendEl ? legendEl.innerText.trim() : '';

      let options = undefined;
      if (tag === 'select') {
        options = Array.from(node.options || []).map(o => ({
          text: String(o.text || '').trim(),
          value: String(o.value || '').trim()
        }));
      } else if (node.type === 'radio' && node.name) {
        // Find other radios in the same group to build options
        const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${node.name}"]`));
        options = group.map(r => ({
          text: this.getAccessibleLabel(r),
          value: r.value || ''
        }));
      }

      extracted.push({
        id,
        tag,
        type: node.type || '',
        name: node.name || '',
        label,
        placeholder: node.placeholder || '',
        value: node.value || '',
        autocomplete: node.autocomplete || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        ariaDescribedBy: node.getAttribute('aria-describedby') ? document.getElementById(node.getAttribute('aria-describedby'))?.innerText?.trim() || '' : '',
        role: node.getAttribute('role') || '',
        href: node.getAttribute('href') || '',
        disabled: Boolean(node.disabled),
        in_form: Boolean(node.form || formEl),
        form_id,
        fieldset_legend: legend,
        checked: Boolean(node.checked),
        context,
        price_value,
        options,
        bbox: this.bboxOf(rect),
        is_interactive: true,
        is_visible: isVisible
      });
    }

    const main = document.querySelector('main, [role="main"], #content, .content') || document.body;
    const visible_text = String(main?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    return {
      url: window.location.href,
      title: document.title || 'Untitled Document',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: Math.round(window.scrollX || 0),
        y: Math.round(window.scrollY || 0),
        maxY: Math.round(document.documentElement.scrollHeight || 0)
      },
      headings: this.extractHeadings(),
      result_items: this.extractResultItems(extracted),
      visible_text,
      elements: extracted
    };
  }
}

export const defaultDOMExtractor = new DOMExtractor();
