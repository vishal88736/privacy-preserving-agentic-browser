/**
 * Observation Fusion Module
 * Combines DOM perception + VLM visual perception into a single unified
 * observation representation with spatial IoU and semantic cross-referencing.
 */

export function calculateIoU(boxA, boxB) {
  if (!boxA || !boxB || boxA.length !== 4 || boxB.length !== 4) return 0;
  const [xA, yA, wA, hA] = boxA;
  const [xB, yB, wB, hB] = boxB;

  const x1 = Math.max(xA, xB);
  const y1 = Math.max(yA, yB);
  const x2 = Math.min(xA + wA, xB + wB);
  const y2 = Math.min(yA + hA, yB + hB);

  const intersectionW = Math.max(0, x2 - x1);
  const intersectionH = Math.max(0, y2 - y1);
  const intersectionArea = intersectionW * intersectionH;

  const areaA = wA * hA;
  const areaB = wB * hB;
  const unionArea = areaA + areaB - intersectionArea;

  if (unionArea <= 0) return 0;
  return intersectionArea / unionArea;
}

export class ObservationFusion {
  /**
   * Fuses sanitized DOM elements with VLM visual detections
   * @param {Array<Object>} sanitizedDomElements
   * @param {Object} vlmVisualObservation - { detected_elements, spatial_layout, visual_state }
   * @param {Object} pageMetadata - { url, title, viewport }
   * @returns {Object} Unified Observation Model
   */
  fuse(sanitizedDomElements, vlmVisualObservation, pageMetadata = {}) {
    const visualElements = vlmVisualObservation?.detected_elements || [];
    const matchedVisualIndices = new Set();
    const unifiedElements = [];

    // 1. Match DOM elements with Visual detections
    for (const domEl of sanitizedDomElements) {
      let bestMatch = null;
      let highestIoU = 0;
      let matchedIndex = -1;

      for (let i = 0; i < visualElements.length; i++) {
        if (matchedVisualIndices.has(i)) continue;
        const visEl = visualElements[i];

        // Spatial IoU check
        const iou = calculateIoU(domEl.bbox, visEl.bbox);
        if (iou > highestIoU && iou >= 0.35) {
          highestIoU = iou;
          bestMatch = visEl;
          matchedIndex = i;
        }
      }

      if (bestMatch && matchedIndex >= 0) {
        matchedVisualIndices.add(matchedIndex);
        unifiedElements.push({
          id: domEl.id,
          role: domEl.role || domEl.tag,
          dom: {
            id: domEl.id,
            tag: domEl.tag,
            type: domEl.type,
            name: domEl.name,
            label: domEl.label,
            placeholder: domEl.placeholder,
            value: domEl.value,
            href: domEl.href || '',
            sensitive: domEl.sensitive,
            semantic_type: domEl.semantic_type,
            value_source: domEl.value_source,
            bbox: domEl.bbox,
            is_interactive: domEl.is_interactive,
            disabled: Boolean(domEl.disabled),
            in_form: Boolean(domEl.in_form)
          },
          visual: {
            visual_id: bestMatch.visual_id,
            description: bestMatch.visual_description || bestMatch.label,
            confidence: bestMatch.confidence || 0.9,
            visual_bbox: bestMatch.bbox
          },
          interaction: {
            clickable: domEl.tag === 'button' || domEl.tag === 'a' || domEl.role === 'button',
            typeable: domEl.tag === 'input' || domEl.tag === 'textarea',
            uploadable: domEl.type === 'file'
          },
          matched_by: 'IOU',
          match_confidence: highestIoU
        });
      } else {
        // Fallback: DOM-grounded element without visual match
        unifiedElements.push({
          id: domEl.id,
          role: domEl.role || domEl.tag,
          dom: {
            id: domEl.id,
            tag: domEl.tag,
            type: domEl.type,
            name: domEl.name,
            label: domEl.label,
            placeholder: domEl.placeholder,
            value: domEl.value,
            href: domEl.href || '',
            sensitive: domEl.sensitive,
            semantic_type: domEl.semantic_type,
            value_source: domEl.value_source,
            bbox: domEl.bbox,
            is_interactive: domEl.is_interactive,
            disabled: Boolean(domEl.disabled),
            in_form: Boolean(domEl.in_form)
          },
          visual: {
            description: domEl.sensitive 
              ? `Redacted sensitive input (${domEl.semantic_type})` 
              : `DOM element ${domEl.label || domEl.tag}`,
            confidence: 0.8
          },
          interaction: {
            clickable: domEl.tag === 'button' || domEl.tag === 'a' || domEl.role === 'button',
            typeable: domEl.tag === 'input' || domEl.tag === 'textarea',
            uploadable: domEl.type === 'file'
          },
          matched_by: 'DOM_ONLY'
        });
      }
    }

    // 2. Add remaining unmatched visual elements (e.g. canvas elements, image buttons)
    for (let i = 0; i < visualElements.length; i++) {
      if (!matchedVisualIndices.has(i)) {
        const visEl = visualElements[i];
        unifiedElements.push({
          id: `vis_target_${i + 1}`,
          role: visEl.role || 'visual_control',
          dom: null,
          visual: {
            visual_id: visEl.visual_id,
            description: visEl.visual_description || visEl.label,
            confidence: visEl.confidence,
            visual_bbox: visEl.bbox
          },
          interaction: {
            clickable: true,
            typeable: false,
            uploadable: false
          },
          matched_by: 'VISUAL_ONLY'
        });
      }
    }

    // Collect list of sensitive categories present on page
    const sensitiveCategories = Array.from(new Set(
      unifiedElements
        .filter(el => el.dom?.sensitive)
        .map(el => el.dom.semantic_type)
    ));

    return {
      observation_id: `obs_${Date.now()}`,
      timestamp: Date.now(),
      page: {
        domain: pageMetadata.domain || 'localhost',
        title: pageMetadata.title || 'Application',
        viewport: pageMetadata.viewport || [1280, 800]
      },
      elements: unifiedElements,
      visual_layout_summary: vlmVisualObservation?.spatial_layout || 'Standard web layout',
      visual_state_summary: vlmVisualObservation?.visual_state || 'Interactive',
      detected_sensitive_categories: sensitiveCategories
    };
  }
}

export const defaultObservationFusion = new ObservationFusion();
