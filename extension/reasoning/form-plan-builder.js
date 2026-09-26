import { ActionType, RiskLevel } from '../shared/constants.js';
import { defaultFormAnalyzer } from './form-analyzer.js';
import { defaultLocalValueResolver } from '../executor/local-value-resolver.js';

const REDACTED = new Set(['[REDACTED]', '[NON_SENSITIVE_TEXT]', '[example]']);

function normalize(value, semanticType = '') {
  let out = String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
  if (semanticType === 'country') {
    const aliases = {
      us: 'united states', usa: 'united states', 'u s': 'united states',
      'u s a': 'united states', 'united states of america': 'united states',
      in: 'india', uk: 'united kingdom', 'u k': 'united kingdom', 'great britain': 'united kingdom'
    };
    out = aliases[out] || out;
  }
  return out;
}

function checkboxTarget(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const v = String(value ?? '').trim().toLowerCase();
  if (['yes', 'true', '1', 'checked', 'agree', 'agreed', 'accepted', 'accept'].includes(v)) return true;
  if (['no', 'false', '0', 'unchecked', 'decline', 'declined', 'not agree', ''].includes(v)) return false;
  return null;
}

function normalizeDate(value) {
  const v = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v;
}

export class FormPlanBuilder {
  constructor(analyzer = defaultFormAnalyzer, valueResolver = defaultLocalValueResolver) {
    this.analyzer = analyzer;
    this.valueResolver = valueResolver;
  }

  decide(elements = [], userTask = '', taskHistory = []) {
    const plans = this.analyzer.analyzeForms(elements, userTask) || [];
    if (!plans.length) return { status: 'UNSUPPORTED', action: null, fields: [] };

    const fieldsById = new Map((elements || []).map((el) => [
      el.id || el.element_id || el.dom?.id,
      el.dom || el
    ]).filter(([id]) => Boolean(id)));
    const { resolvedIds, skippedIds } = this._handledUserFields(taskHistory);
    const verifiedIds = this._verifiedPlanFields(taskHistory);
    const actionable = [];
    const asks = [];

    // Pages commonly have a one-field email capture or search form before the
    // actual profile/application form. Select the strongest semantic form
    // rather than relying on DOM order, which can silently omit phone/email
    // fields from the user's intended form.
    const plan = plans.reduce((best, candidate) =>
      this._formScore(candidate) > this._formScore(best) ? candidate : best
    );
    const untrustedPlan = { ...plan, fields: (plan.fields || []).map((field) => ({ ...field })) };
    let localResolved;
    try {
      localResolved = this.valueResolver.resolve({
        action: ActionType.FILL_FORM_PLAN,
        value: { fields: untrustedPlan.fields }
      });
    } catch {
      // Resolution errors are represented as unavailable fields below. They
      // do not erase known work or push values to the model.
      localResolved = { fields: untrustedPlan.fields.map((field) => ({ ...field, status: 'UNAVAILABLE' })) };
    }

    const localFields = new Map((localResolved.fields || []).map((field) => [field.field_id, field]));
    for (const field of untrustedPlan.fields || []) {
      if (resolvedIds.has(field.field_id) || skippedIds.has(field.field_id)) continue;
      const resolved = localFields.get(field.field_id) || { ...field, status: 'UNAVAILABLE' };
      if (resolved.status === 'UNAVAILABLE' || resolved.status === 'AMBIGUOUS') {
        asks.push(this._askField(field, resolved));
        continue;
      }
      if (this._matchesCurrent(field, resolved, fieldsById.get(field.field_id), verifiedIds.has(field.field_id))) continue;
      // The target value exists only in this local stack frame. The returned
      // plan carries its symbolic source, never the resolved plaintext.
      actionable.push(field);
    }

    for (const field of plan.ambiguous || []) {
      if (!resolvedIds.has(field.field_id) && !skippedIds.has(field.field_id)) asks.push(this._askField(field));
    }

    if (actionable.length) {
      return {
        status: 'REMAINING',
        action: {
          action: ActionType.FILL_FORM_PLAN,
          risk: RiskLevel.MEDIUM,
          requires_confirmation: false,
          value: { form_id: plan.form_id, fields: actionable }
        },
        fields: actionable,
        askFields: asks
      };
    }

    if (asks.length) {
      const labels = asks.map((field) => field.label || field.field_id).filter(Boolean);
      return {
        status: 'ASK_USER',
        action: {
          action: ActionType.ASK_USER,
          risk: RiskLevel.LOW,
          requires_confirmation: false,
          value: {
            prompt: `Some fields need your input or a skip decision: ${labels.join(', ')}.`,
            ambiguousFields: asks
          }
        },
        fields: [],
        askFields: asks
      };
    }

    return { status: 'COMPLETE', action: null, fields: [], askFields: [] };
  }

  _formScore(plan) {
    const fields = [...(plan?.fields || []), ...(plan?.ambiguous || [])];
    const usefulTypes = new Set(fields
      .map((field) => field.semantic_type)
      .filter((type) => type && !['other', 'comments', 'newsletter', 'terms'].includes(type)));
    const contactAndIdentity = new Set(['full_name', 'first_name', 'last_name', 'email', 'phone']);
    const priorityCount = fields.filter((field) => contactAndIdentity.has(field.semantic_type)).length;
    return fields.length * 10 + usefulTypes.size * 3 + priorityCount * 2;
  }

  _askField(field, resolved = null) {
    return {
      field_id: field.field_id,
      semantic_type: field.semantic_type,
      control_type: field.control_type,
      element_type: field.element_type,
      input_type: field.input_type,
      options: field.options,
      value_source: field.value_source || null,
      confidence: field.confidence,
      label: field.label || field.semantic_type || field.field_id,
      status: resolved?.status || 'AMBIGUOUS',
      reason: resolved?.unavailable_reason || field.reason || 'No unambiguous saved profile value is available.'
    };
  }

  _handledUserFields(history) {
    const resolvedIds = new Set();
    const skippedIds = new Set();
    for (const step of history || []) {
      for (const id of step?.result?.resolvedFieldIds || []) resolvedIds.add(id);
      for (const id of step?.result?.skippedFieldIds || []) skippedIds.add(id);
    }
    return { resolvedIds, skippedIds };
  }

  _verifiedPlanFields(history) {
    const ids = new Set();
    for (const step of history || []) {
      if (step?.action?.action !== ActionType.FILL_FORM_PLAN || step.success === false) continue;
      for (const detail of step?.result?.details || []) {
        if (detail?.success && (detail.field_id || detail.field)) ids.add(detail.field_id || detail.field);
      }
    }
    return ids;
  }

  _matchesCurrent(field, resolved, element, verifiedPreviously) {
    if (!element) return false;
    const type = field.control_type;
    const target = resolved.value;
    if (type === 'CHECKBOX') {
      const desired = checkboxTarget(target);
      return desired !== null && Boolean(element.checked) === desired;
    }
    if (type === 'RADIO') {
      return (element.options || []).some((option) => option?.checked && (
        normalize(option.value, field.semantic_type) === normalize(target, field.semantic_type) ||
        normalize(option.text, field.semantic_type) === normalize(target, field.semantic_type)
      ));
    }
    if (type === 'SELECT') {
      const selected = (element.options || []).find((option) => option?.selected);
      return Boolean(selected) && (
        normalize(selected.value, field.semantic_type) === normalize(target, field.semantic_type) ||
        normalize(selected.text, field.semantic_type) === normalize(target, field.semantic_type)
      );
    }

    const current = String(element.value ?? '').trim();
    if (REDACTED.has(current)) return verifiedPreviously;
    if (type === 'DATE') return normalizeDate(current) === normalizeDate(target);
    if (type === 'PHONE') return current.replace(/\D/g, '') === String(target ?? '').replace(/\D/g, '');
    return normalize(current, field.semantic_type) === normalize(target, field.semantic_type);
  }
}

export const defaultFormPlanBuilder = new FormPlanBuilder();
