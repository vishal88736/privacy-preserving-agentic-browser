/**
 * Local Action Safety Gate & Risk Classifier
 * Evaluates actions produced by the AI reasoning model and decides whether
 * the action is safe to execute automatically or requires explicit human confirmation.
 */

import { ActionType, RiskLevel, SymbolicSecretSource } from '../shared/constants.js';

export class RiskGate {
  /**
   * Evaluates an action's risk level and determines confirmation requirement.
   * @param {Object} action - Action object from reasoning engine
   * @param {Object} context - { targetElement, currentUrl, pageTitle }
   * @returns {{ allowed: boolean, risk: string, requiresConfirmation: boolean, reason: string }}
   */
  evaluate(action, context = {}) {
    const { action: verb, target, value, value_source } = action;
    const targetLabel = (target?.label || '').toLowerCase();

    // 1. Critical Security Rejections
    // Prevent exfiltration: Never allow a LOCAL_* secret to be entered into search or query fields
    if (value_source && Object.values(SymbolicSecretSource).includes(value_source)) {
      if (/search|query|find|google|bing|duckduckgo/i.test(targetLabel)) {
        return {
          allowed: false,
          risk: RiskLevel.CRITICAL,
          requiresConfirmation: false,
          reason: `Security Block: Attempted to inject local secret (${value_source}) into a public search or query field.`
        };
      }
    }

    // 2. High-Risk Action: Form Submissions
    if (verb === ActionType.SUBMIT || (verb === ActionType.CLICK && /submit|apply|pay|proceed to pay|checkout|confirm booking|agree and continue/i.test(targetLabel))) {
      return {
        allowed: true,
        risk: RiskLevel.HIGH,
        requiresConfirmation: true,
        reason: 'Form submission or final transaction step requires user approval.'
      };
    }

    // 3. High-Risk Action: Document Uploads
    if (verb === ActionType.UPLOAD || value_source === SymbolicSecretSource.LOCAL_DOCUMENT) {
      return {
        allowed: true,
        risk: RiskLevel.HIGH,
        requiresConfirmation: true,
        reason: 'Uploading identity or sensitive local documents requires user approval.'
      };
    }

    // 4. Medium-Risk: Typing sensitive identity values into input fields
    if (value_source === SymbolicSecretSource.LOCAL_AADHAAR || value_source === SymbolicSecretSource.LOCAL_PAN || value_source === SymbolicSecretSource.LOCAL_PASSWORD) {
      return {
        allowed: true,
        risk: RiskLevel.MEDIUM,
        requiresConfirmation: false,
        reason: `Filling sensitive field using protected local credential (${value_source}). Value stays local.`
      };
    }

    // 5. Low-Risk: Navigation, scrolling, clicking normal links, typing non-sensitive search terms
    return {
      allowed: true,
      risk: RiskLevel.LOW,
      requiresConfirmation: false,
      reason: 'Standard interactive action.'
    };
  }
}

export const defaultRiskGate = new RiskGate();
