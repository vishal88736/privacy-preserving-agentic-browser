/**
 * Strict Schemas & Validators for Privacy-Preserving Agentic Browser
 */

import { ActionType, RiskLevel, SymbolicSecretSource } from './constants.js';

export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * Validates an incoming Action object from the Reasoning LLM
 */
export function validateAction(action) {
  if (!action || typeof action !== 'object') {
    throw new ValidationError('Action must be a valid JSON object');
  }

  if (!action.action || !Object.values(ActionType).includes(action.action)) {
    throw new ValidationError(`Invalid action type: ${action.action}. Allowed types: ${Object.values(ActionType).join(', ')}`);
  }

  // Reject arbitrary script execution or eval immediately
  if ('eval' in action || 'script' in action || 'function' in action) {
    throw new ValidationError('Security violation: Arbitrary script execution is strictly forbidden');
  }

  // Validate target object if required by action
  const actionsRequiringTarget = [
    ActionType.CLICK,
    ActionType.TYPE,
    ActionType.SELECT,
    ActionType.CHECK,
    ActionType.UNCHECK,
    ActionType.HOVER,
    ActionType.UPLOAD,
    ActionType.SUBMIT
  ];

  if (actionsRequiringTarget.includes(action.action)) {
    if (!action.target || typeof action.target !== 'object') {
      throw new ValidationError(`Action ${action.action} requires a valid target object`);
    }
    if (!action.target.element_id && !action.target.coordinates) {
      throw new ValidationError(`Target must provide element_id or coordinates`);
    }
  }

  // Validate value sources for TYPE actions
  if (action.action === ActionType.TYPE) {
    if (!action.value && !action.value_source) {
      throw new ValidationError('TYPE action requires either value or value_source');
    }
    if (action.value_source && !Object.values(SymbolicSecretSource).includes(action.value_source) &&
        !/^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(action.value_source)) {
      throw new ValidationError(`Invalid value_source: ${action.value_source}`);
    }
  }

  if (action.action === ActionType.FILL_FORM_PLAN) {
    if (!action.value || !Array.isArray(action.value.fields) || action.value.fields.length === 0 || action.value.fields.length > 100) {
      throw new ValidationError('FILL_FORM_PLAN requires a bounded, non-empty fields array');
    }
    const seen = new Set();
    const allowedControls = new Set(['TEXT', 'EMAIL', 'PHONE', 'NUMBER', 'DATE', 'TEXTAREA', 'SELECT', 'CHECKBOX', 'RADIO']);
    for (const field of action.value.fields) {
      if (!field || typeof field !== 'object' || typeof field.field_id !== 'string' ||
          !/^[A-Za-z0-9_\-:]{1,160}$/.test(field.field_id) || seen.has(field.field_id)) {
        throw new ValidationError('FILL_FORM_PLAN contains a missing, invalid, or duplicate field target');
      }
      seen.add(field.field_id);
      if (field.control_type && !allowedControls.has(field.control_type)) {
        throw new ValidationError(`Invalid form control type: ${field.control_type}`);
      }
      if (field.value_source && !Object.values(SymbolicSecretSource).includes(field.value_source) &&
          !/^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(field.value_source)) {
        throw new ValidationError(`Invalid form value_source: ${field.value_source}`);
      }
    }
  }

  // Assign default risk if not provided
  if (!action.risk || !Object.values(RiskLevel).includes(action.risk)) {
    action.risk = RiskLevel.LOW;
  }

  if (typeof action.requires_confirmation !== 'boolean') {
    action.requires_confirmation = (action.risk === RiskLevel.HIGH || action.risk === RiskLevel.CRITICAL);
  }

  return true;
}

/**
 * Validates a sanitized element node before passing to observation fusion
 */
export function validateSanitizedElement(element) {
  if (!element || typeof element !== 'object') return false;
  if (!element.id || !element.tag) return false;
  
  // Strict check: sensitive elements must NOT contain unredacted secret values
  if (element.sensitive && element.value && element.value !== '[REDACTED]') {
    throw new ValidationError(`Security violation: Sensitive element ${element.id} contains unredacted value`);
  }

  return true;
}

/**
 * Validates outbound payload to /vision
 */
export function validateVisionPayload(payload) {
  if (!payload || !payload.task_id) {
    throw new ValidationError('Vision payload missing task_id');
  }
  if (!payload.sanitized_screenshot) {
    throw new ValidationError('Vision payload missing sanitized_screenshot');
  }
  if (!payload.sanitized_dom || !Array.isArray(payload.sanitized_dom.elements)) {
    throw new ValidationError('Vision payload missing sanitized_dom elements array');
  }
  return true;
}

/**
 * Validates outbound payload to /reason
 */
export function validateReasonPayload(payload) {
  if (!payload || !payload.task) {
    throw new ValidationError('Reason payload missing user task prompt');
  }
  if (!payload.fused_observation) {
    throw new ValidationError('Reason payload missing fused_observation');
  }
  return true;
}
