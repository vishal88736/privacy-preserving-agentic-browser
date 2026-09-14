/**
 * Content Script Element Registry
 * Maps assigned IDs (el_1, el_2, ...) to actual DOM elements and manages
 * element discovery.
 */

export class ElementRegistry {
  constructor() {
    this.idToElement = new Map();
    this.elementToId = new WeakMap();
    this.counter = 1;
  }

  clear() {
    this.idToElement.clear();
    this.counter = 1;
  }

  register(element) {
    if (this.elementToId.has(element)) {
      return this.elementToId.get(element);
    }
    const id = `el_${this.counter++}`;
    this.idToElement.set(id, element);
    this.elementToId.set(element, id);
    return id;
  }

  getElement(id) {
    return this.idToElement.get(id) || null;
  }
}

export const registry = new ElementRegistry();
