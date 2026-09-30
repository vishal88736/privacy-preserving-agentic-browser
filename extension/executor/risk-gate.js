/**
 * Local Action Safety Gate & Risk Classifier
 * Evaluates actions produced by the AI reasoning model and decides whether
 * the action is safe to execute automatically or requires explicit human confirmation.
 */

import { ActionType, RiskLevel, SymbolicSecretSource, isDocumentToken } from '../shared/constants.js';

export class RiskGate {
  /**
   * Evaluates an action's risk level and determines confirmation requirement.
   * @param {Object} action - Action object from reasoning engine
   * @param {Object} context - { targetDom, observationElements, currentUrl, pageTitle }.
   *   targetDom is the caller's resolved DOM for the action's target; the gate
   *   never reads the model's own target label.
   * @returns {{ allowed: boolean, risk: string, requiresConfirmation: boolean, reason: string }}
   */
  evaluate(action, context = {}) {
    const { action: verb, value, value_source } = action || {};
    const targetDom = context.targetDom || null;
    // Labels are read from the resolved DOM only. The model's own
    // target.label is attacker-influenceable, so it must never drive a safety
    // decision: an unresolvable target yields no label rather than a
    // trusted-looking one.
    const targetLabel = [
      targetDom?.label,
      targetDom?.ariaLabel,
      targetDom?.accessible_name,
      targetDom?.text,
      targetDom?.name,
      targetDom?.placeholder
    ].filter((part) => typeof part === 'string').join(' ').toLowerCase();
    const localSource = (source) => Boolean(source && (
      Object.values(SymbolicSecretSource).includes(source) ||
      /^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(source) ||
      isDocumentToken(source)
    ));
    const nestedSources = verb === ActionType.FILL_FORM_PLAN && Array.isArray(value?.fields)
      ? value.fields.map((field) => field?.value_source).filter(Boolean)
      : [];
    const usesSensitiveLocalValue = localSource(value_source) || nestedSources.some(localSource);
    const plannedTargetDoms = verb === ActionType.FILL_FORM_PLAN && Array.isArray(value?.fields)
      ? value.fields.map((field) => context.observationElements?.find((element) => element.id === field?.field_id)?.dom).filter(Boolean)
      : [];
    // DOM-level type of the target when the caller resolved it from the
    // latest observation (e.g. <button type="submit">, <input type="submit">).
    const targetType = String(targetDom?.type || '').toLowerCase();
    const targetTag = String(targetDom?.tag || '').toLowerCase();
    // Verbs that write a value into a page element, so the destination of a
    // protected value must be inspectable before the write is approved.
    const writesValue = verb === ActionType.TYPE || verb === ActionType.SELECT;

    // 1. Critical Security Rejections
    // Prevent exfiltration: Never allow a LOCAL_* secret to be entered into search or query fields
    if (usesSensitiveLocalValue) {
      const candidateDoms = [targetDom, ...plannedTargetDoms].filter(Boolean);
      // Fail closed. If the destination element could not be resolved from the
      // latest observation there is no evidence it is not a public search box,
      // so a protected value must not be written at all.
      if ((writesValue || nestedSources.length > 0) && candidateDoms.length === 0) {
        return {
          allowed: false,
          risk: RiskLevel.CRITICAL,
          requiresConfirmation: false,
          reason: `Security Block: the target element for local secret (${value_source || nestedSources.join(', ')}) could not be verified, so the value was not written.`
        };
      }
      const targetTexts = candidateDoms.map((dom) => [
        dom?.label, dom?.ariaLabel, dom?.accessible_name, dom?.text, dom?.name, dom?.placeholder, dom?.type
      ].filter((part) => typeof part === 'string').join(' ').toLowerCase());
      if (targetTexts.some((text) => /search|query|find|google|bing|duckduckgo/i.test(text))) {
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
    // A submit control with no form owner cannot submit, so it stays low-risk.
    // HTMLButtonElement.type reflects 'submit' as its default, so a typeless
    // button outside a form reports 'submit' yet still has no form owner.
    const inForm = targetDom?.in_form === true;
    const nativeSubmitControl = targetType === 'submit' && inForm;
    const typelessSubmitButton = targetTag === 'button' && inForm && !targetDom?.type;
    const submitControl = nativeSubmitControl || typelessSubmitButton;
    // Phrases that commit something irreversible on their own, whatever the
    // control's declared type: a <button type="button"> with an onclick
    // handler can still place an order or move money.
    const strongIrreversibleLabel = /\b(?:place\s+(?:an?\s+)?order|order\s+now|purchase|buy\s+now|checkout|book\s+now|reserve|confirm\s+booking|pay(?:\s+now)?|sign\s+in|log\s+in|delete|remove|transfer|wire|donate)\b/i.test(targetLabel);
    // Generic commit verbs only mean "submit" when the control can actually
    // submit. A plain <button type="button"> labelled "Send message" is a UI
    // action, not a form submission, so the DOM type stays authoritative here.
    const weakCommitLabel = /\b(?:send|submit|apply|publish|post|confirm|continue|proceed|finish|authorize)\b/i.test(targetLabel);
    const irreversibleLabel = strongIrreversibleLabel || (submitControl && weakCommitLabel);
    if (verb === ActionType.SUBMIT || submitControl ||
        (verb === ActionType.CLICK && irreversibleLabel)) {
      return {
        allowed: true,
        risk: RiskLevel.HIGH,
        requiresConfirmation: true,
        reason: 'Form submission or final transaction step requires user approval.'
      };
    }

    // 3. High-Risk Action: Document Uploads
    // Unchanged in severity, widened in coverage: a named stored document
    // (LOCAL_DOCUMENT_<NAME>) is now a real source, and attaching one still
    // requires the user's explicit approval exactly like the UPLOAD verb does.
    const attachesDocument = isDocumentToken(value_source) ||
      nestedSources.some((source) => isDocumentToken(source));
    if (verb === ActionType.UPLOAD || value_source === SymbolicSecretSource.LOCAL_DOCUMENT ||
        nestedSources.includes(SymbolicSecretSource.LOCAL_DOCUMENT) || attachesDocument) {
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
    if (usesSensitiveLocalValue) {
      return {
        allowed: true,
        risk: verb === ActionType.FILL_FORM_PLAN ? RiskLevel.HIGH : RiskLevel.MEDIUM,
        requiresConfirmation: verb === ActionType.FILL_FORM_PLAN,
        reason: verb === ActionType.FILL_FORM_PLAN
          ? 'This form plan contains protected local values and requires user approval before filling.'
          : `Filling a sensitive field with protected local data (${value_source || nestedSources.join(', ')}).`
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
