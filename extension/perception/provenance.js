/** Canonical provenance labels for every perception result sent to reasoning. */
export const PerceptionProvenance = Object.freeze({
  DOM_ONLY: 'DOM_ONLY',
  DOM_PLUS_HEURISTIC: 'DOM_PLUS_HEURISTIC',
  REAL_VLM: 'REAL_VLM',
  LOCAL_MODEL: 'LOCAL_MODEL',
  DOM: 'DOM'
});

const REAL_VLM_LABELS = new Set(['REAL_VLM', 'DOM_PLUS_REAL_VLM']);

/** Normalize legacy backend names without upgrading unproven output. */
export function normalizePerceptionProvenance(observation = {}) {
  const reported = String(observation.provenance || observation._source || '').toUpperCase();
  const source = String(observation.grounding_source || '').toLowerCase();

  if (source === 'vision_model' && REAL_VLM_LABELS.has(reported)) {
    return PerceptionProvenance.REAL_VLM;
  }
  if (reported === PerceptionProvenance.DOM_PLUS_HEURISTIC || source === 'dom_heuristic') {
    return PerceptionProvenance.DOM_PLUS_HEURISTIC;
  }
  return PerceptionProvenance.DOM_ONLY;
}

/**
 * Layout summaries do not make their DOM-echo annotations visual detections.
 * Only an explicitly sourced, real VLM detection list may enter visual fusion.
 */
export function hasRealVlmDetections(observation = {}) {
  return normalizePerceptionProvenance(observation) === PerceptionProvenance.REAL_VLM &&
    observation.detected_elements_provenance === PerceptionProvenance.REAL_VLM &&
    Array.isArray(observation.detected_elements);
}
