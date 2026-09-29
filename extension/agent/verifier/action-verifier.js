const ELEMENT_STATE_FIELDS = [
  'id', 'tag', 'role', 'accessible_name', 'label', 'text', 'nearby_text', 'placeholder', 'title',
  'input_type', 'href', 'bounding_box', 'visible', 'enabled', 'checked', 'selected', 'selected_option'
];

function elementState(element) {
  const state = {};
  for (const field of ELEMENT_STATE_FIELDS) state[field] = element?.[field] ?? null;
  // This is already sanitized by DOMSanitizer; sensitive values are markers or
  // symbolic references. Keep it only in memory for change comparison.
  state.value = element?.dom?.value ?? null;
  return state;
}

function observationSignature(observation) {
  return JSON.stringify({
    url: observation?.page?.url || '',
    title: observation?.page?.title || '',
    elements: (observation?.elements || []).map(elementState)
  });
}

function targetIdsFor(action = {}) {
  if (Array.isArray(action.targetIds)) return action.targetIds.filter((id) => typeof id === 'string');
  return action.targetId ? [action.targetId] : [];
}

/**
 * Verifies that a successful execution was followed by a distinct, grounded
 * page observation. It reports visible state changes without claiming that a
 * dispatched click necessarily caused the site's intended effect.
 */
export class ActionVerifier {
  verify({ action, execution, beforeObservation, afterObservation } = {}) {
    if (execution?.success !== true) {
      return { status: 'EXECUTION_FAILED', verified: false, visible_state_changed: false };
    }
    if (!afterObservation?.observation_id ||
        afterObservation.observation_id === beforeObservation?.observation_id) {
      return { status: 'POST_ACTION_OBSERVATION_MISSING', verified: false, visible_state_changed: false };
    }

    const beforeById = new Map((beforeObservation?.elements || []).map((element) => [element.id, element]));
    const afterById = new Map((afterObservation?.elements || []).map((element) => [element.id, element]));
    const targetIds = targetIdsFor(action);
    const targetPresent = targetIds.length === 0 || targetIds.every((id) => afterById.has(id));
    const targetStateChanged = targetIds.some((id) => {
      const before = beforeById.get(id);
      const after = afterById.get(id);
      return !before || !after || JSON.stringify(elementState(before)) !== JSON.stringify(elementState(after));
    });
    const visibleStateChanged = observationSignature(beforeObservation) !== observationSignature(afterObservation);

    return {
      status: visibleStateChanged ? 'OBSERVED_STATE_CHANGE' : 'OBSERVED_NO_VISIBLE_CHANGE',
      verified: true,
      observation_id: afterObservation.observation_id,
      visible_state_changed: visibleStateChanged,
      target_present: targetPresent,
      target_state_changed: targetStateChanged
    };
  }
}

export function actionVerificationSummary(action = {}) {
  const targetIds = action.action === 'FILL_FORM_PLAN'
    ? (action.value?.fields || []).map((field) => field?.field_id).filter((id) => typeof id === 'string')
    : (action.target?.element_id ? [action.target.element_id] : []);
  return {
    action: String(action.action || 'UNKNOWN'),
    ...(targetIds.length === 1 ? { targetId: targetIds[0] } : {}),
    ...(targetIds.length > 1 ? { targetIds } : {}),
    ...(typeof action.value_source === 'string' ? { valueSource: action.value_source } : {})
  };
}

export const defaultActionVerifier = new ActionVerifier();
