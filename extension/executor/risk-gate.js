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
    // DOM-level type of the target when the caller resolved it from the
    // latest observation (e.g. <button type="submit">, <input type="submit">).
    const targetType = String(context.targetDom?.type || '').toLowerCase();
    const targetTag = String(context.targetDom?.tag || '').toLowerCase();

    // 1. Critical Security Rejections
    // Prevent exfiltration: Never allow a LOCAL_* secret to be entered into search or query fields
    if (value_source && Object.values(SymbolicSecretSource).includes(value_source)) {
      const targetText = `${targetLabel} ${(target?.placeholder || '').toLowerCase()} ${(target?.name || '').toLowerCase()} ${String(context.targetDom?.placeholder || '').toLowerCase()} ${String(context.targetDom?.name || '').toLowerCase()} ${String(context.targetDom?.type || '').toLowerCase()}`;
      if (/search|query|find|google|bing|duckduckgo/i.test(targetText)) {
        return {
          allowed: false,
          risk: RiskLevel.CRITICAL,
          requiresConfirmation: false,
          reason: `Security Block: Attempted to inject local secret (${value_source}) into a public search or query field.`
        };
      }
    }

    // 2. High-Risk Action: Form Submissions.
    // Covers explicit SUBMIT, label-matched commit buttons, AND clicks on
    // native submit controls that are actually form-associated
    // (e.g. <button type="submit">Send message</button> inside a <form>).
    // A typeless <button> outside any form cannot submit, so it stays low-risk.
    const inForm = context.targetDom?.in_form === true;
    const isSubmitControl = (targetType === 'submit' && (inForm || targetTag === 'input')) ||
      (targetTag === 'button' && inForm && /^(submit|apply|pay|send|confirm|continue|proceed)$/i.test(targetLabel.trim()));
    if (verb === ActionType.SUBMIT || isSubmitControl ||
        (verb === ActionType.CLICK && /submit|apply|pay|proceed to pay|checkout|confirm booking|agree and continue/i.test(targetLabel))) {
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

    // 4. Medium-Risk: Typing sensitive identity values into input fields.
    // All identity-bound tokens get MEDIUM so privacy UI can highlight them;
    // none require confirmation (values stay local by construction).
    if (value_source && [
      SymbolicSecretSource.LOCAL_AADHAAR,
      SymbolicSecretSource.LOCAL_PAN,
      SymbolicSecretSource.LOCAL_PASSWORD,
      SymbolicSecretSource.LOCAL_PHONE,
      SymbolicSecretSource.LOCAL_EMAIL,
      SymbolicSecretSource.LOCAL_ADDRESS,
      SymbolicSecretSource.LOCAL_DOB,
      SymbolicSecretSource.LOCAL_FULL_NAME,
      SymbolicSecretSource.LOCAL_CREDIT_CARD,
      SymbolicSecretSource.LOCAL_CVV,
      SymbolicSecretSource.LOCAL_PROFILE
    ].includes(value_source)) {
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
