/**
 * Type Definitions and Data Structures for Privacy-Preserving Agentic Browser
 */

/**
 * @typedef {Object} DOMElementNode
 * @property {string} id - Unique identifier assigned to element (e.g. el_1)
 * @property {string} tag - HTML tag name (input, button, a, select, textarea, etc.)
 * @property {string} [role] - ARIA role
 * @property {string} [type] - Input type attribute (text, password, number, file, etc.)
 * @property {string} [name] - Element name attribute
 * @property {string} [label] - Associated or computed accessible label
 * @property {string} [placeholder] - Placeholder text
 * @property {string} [value] - Current value (sanitized to [REDACTED] if sensitive)
 * @property {boolean} sensitive - True if PII or secret detected
 * @property {string} [semantic_type] - e.g. AADHAAR, PAN, PASSWORD, EMAIL, PHONE, etc.
 * @property {string} [value_source] - e.g. LOCAL_AADHAAR, LOCAL_PASSWORD, etc.
 * @property {number[]} bbox - [x, y, width, height] viewport coordinates
 * @property {boolean} is_visible - True if within viewport and visible
 * @property {boolean} is_interactive - True if focusable or clickable
 * @property {boolean} [disabled]
 * @property {boolean} [checked]
 */

/**
 * @typedef {Object} VisualElementNode
 * @property {string} visual_id
 * @property {string} label
 * @property {string} role
 * @property {number[]} bbox - [x, y, width, height]
 * @property {number} confidence
 * @property {string} visual_description
 */

/**
 * @typedef {Object} UnifiedElementNode
 * @property {string} id
 * @property {DOMElementNode} dom
 * @property {VisualElementNode} [visual]
 * @property {Object} interaction
 * @property {boolean} interaction.clickable
 * @property {boolean} interaction.typeable
 * @property {boolean} interaction.uploadable
 * @property {string} [matched_by] - 'IOU' | 'SEMANTIC_LABEL' | 'DOM_ONLY' | 'VISUAL_ONLY'
 */

/**
 * @typedef {Object} UnifiedObservation
 * @property {string} observation_id
 * @property {number} timestamp
 * @property {Object} page
 * @property {string} page.url_domain
 * @property {string} page.title
 * @property {number[]} page.viewport - [width, height]
 * @property {UnifiedElementNode[]} elements
 * @property {string} visual_layout_summary
 * @property {string} visual_state_summary
 * @property {string[]} detected_sensitive_categories
 */

export const Types = {};
