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
  // The filled bit is the only change signal that survives redaction.
  //
  // For every field the sanitizer treats as sensitive — a name, an email, a
  // phone, an address, an Aadhaar — `value` is the same '[REDACTED]' marker
  // before and after a successful TYPE. Comparing it therefore reports "no
  // visible change" for a fill that demonstrably worked, and after
  // MAX_VERIFICATION_NO_PROGRESS such fills the loop concludes it cannot
  // confirm progress and aborts the task mid-form.
  //
  // `has_value` is the extractor's strict boolean: it records only whether a
  // control currently holds something, never a value or a length, so it is
  // privacy-safe to compare and is exactly the signal a fill produces.
  state.has_value = element?.dom?.has_value === true;
  return state;
}

function observationSignature(observation) {
  return JSON.stringify({
    url: observation?.page?.url || '',
    title: observation?.page?.title || '',
    visible_text: String(observation?.visible_text || '').replace(/\s+/g, ' ').slice(0, 3000),
    result_items: (observation?.result_items || []).map((item) => ({
      title: item?.title || '', text: item?.text || '', primary_action_id: item?.primary_action_id || null
    })),
    // Native media can start or pause without changing DOM/text. Only compare
    // the strict local schema; no URL, media text, or precise position exists.
    local_media_state: {
      visible_count: observation?.local_media_state?.visible_count || 0,
      media: (observation?.local_media_state?.media || []).map((item) => ({
        ordinal: item?.ordinal,
        tag: item?.tag,
        paused: item?.paused,
        ended: item?.ended,
        ready_state: item?.ready_state
      }))
    },
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
