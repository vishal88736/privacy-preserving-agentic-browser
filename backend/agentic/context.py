"""Compact per-step request context for the reasoning call.

Authored by the PrivAgent project (original code; no upstream source, so no
upstream license notice applies to this file).

Motivation: providers reject oversized requests (observed HTTP 413 from the
LLM endpoint), and every extra token costs latency on each loop step. The
user message therefore carries exactly three compact parts:

1. Short summary of history (not full step dumps).
2. Relevant observation only (not the full element list).
3. Current request (unchanged).

Key names (``PAGE_STATE``, ``ALLOWED_ELEMENT_IDS``, ``AVAILABLE_ELEMENTS``,
``ACTION_HISTORY``) are kept stable so the live prompt and its contract tests
stay valid — only the values compact. ``ALLOWED_ELEMENT_IDS`` is never
truncated: it is the authority the grounding-repair guard checks targets
against, and a partial id set would turn valid targets into false
hallucinations.
"""

import json
from typing import Any, Dict, List, Optional

# Serialized budget for the page-evidence block. ~12K chars ≈ 3K tokens,
# keeping the full request (system + user + completion) comfortably inside
# 32K-context models and far below provider request-size limits.
MAX_EVIDENCE_CHARS = 12000

# Relevance-ordered element cap. Ranked/resolved/suggested elements come
# first; the remainder fills the budget in observation order.
MAX_ELEMENTS = 40

# Visible-text excerpt cap. The client already compacts this; the server-side
# cap is the backstop, with the omitted count kept honest.
MAX_VISIBLE_TEXT_CHARS = 1500

# Heading cap. Headings are orientation, not evidence; the first few suffice.
MAX_HEADINGS = 8


def summarize_history(task_history: Optional[List[Dict[str, Any]]]) -> str:
    """Compress step history into a short loop-memory string.

    Keeps what the planner and critic actually decide on: how many steps ran,
    the last step's outcome in detail, the consecutive-failure count (the
    same signal the circuit breakers use), the latest critic feedback, and
    any extracted answer text. Older steps collapse into counts — their full
    detail already had its chance to influence earlier calls.
    """
    history = [s for s in (task_history or []) if isinstance(s, dict)]
    if not history:
        return ""
    successes = sum(1 for s in history if s.get("success") is not False)
    failures = len(history) - successes
    consecutive_failures = 0
    for step in reversed(history):
        if step.get("success") is False:
            consecutive_failures += 1
        else:
            break
    last = history[-1]
    last_action = last.get("action")
    if isinstance(last_action, dict):
        last_action = last_action.get("action")
    target = last.get("target")
    if isinstance(target, dict):
        target = target.get("element_id") or target.get("label")
    if last.get("success") is False:
        last_outcome = f"FAILED ({str(last.get('error') or 'unknown error')[:160]})"
    else:
        last_outcome = "succeeded"
    parts = [
        f"steps={len(history)} (succeeded={successes}, failed={failures}, "
        f"consecutive_failures={consecutive_failures})",
        f"last_step: {last_action or '?'} on {target or '?'} -> {last_outcome}",
    ]
    feedback = last.get("planner_feedback")
    if isinstance(feedback, str) and feedback.strip():
        parts.append(f"latest_critic_feedback: {feedback.strip()[:300]}")
    extracted = last.get("extracted_text")
    if isinstance(extracted, str) and extracted.strip():
        parts.append(f"last_extracted_text: {extracted.strip()[:300]}")
    return "\n".join(parts)


def _collect_relevant_ids(page_state: Optional[Dict[str, Any]]) -> List[str]:
    """Element ids the page model already ranked, resolved, or suggested."""
    ids: List[str] = []

    def _add(value: Any) -> None:
        if isinstance(value, str) and value and value not in ids:
            ids.append(value)
        elif isinstance(value, dict):
            for key in ("element_id", "id"):
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate and candidate not in ids:
                    ids.append(candidate)
                    break

    state = page_state or {}
    for candidate in state.get("ranked_candidates") or []:
        _add(candidate)
    resolved = state.get("resolved_references") or {}
    if isinstance(resolved, dict):
        for candidate in resolved.values():
            _add(candidate)
    _add(state.get("suggested_search_element"))
    return ids


def _element_id(element: Any) -> Optional[str]:
    if not isinstance(element, dict):
        return None
    for key in ("id", "element_id"):
        candidate = element.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def select_relevant_elements(
    fused_observation: Optional[Dict[str, Any]],
    page_state: Optional[Dict[str, Any]],
    max_elements: int = MAX_ELEMENTS,
) -> List[Dict[str, Any]]:
    """Order observation elements by relevance; drop the rest.

    Relevant-first means ranked/resolved/suggested ids, then everything else
    in observation order. Element dicts are kept whole — slimming fields
    would silently drop the labels and evidence the grounding rules read.
    """
    elements = [
        el for el in ((fused_observation or {}).get("elements", []) or [])
        if isinstance(el, dict)
    ]
    if len(elements) <= max_elements:
        return elements
    relevant = set(_collect_relevant_ids(page_state))
    prioritized = [el for el in elements if _element_id(el) in relevant]
    remainder = [el for el in elements if _element_id(el) not in relevant]
    return (prioritized + remainder)[:max_elements]


def build_page_evidence(
    fused_observation: Optional[Dict[str, Any]],
    page_state: Optional[Dict[str, Any]],
    allowed: set,
    task_history: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """Assemble the compact page-evidence block for one reasoning call.

    Priority order when the byte budget bites: visible text beyond its cap,
    then unranked elements, then headings. ``ALLOWED_ELEMENT_IDS`` and the
    history summary are never cut — the first is a safety authority, the
    second is the loop memory.
    """
    state = page_state or {}
    fused = fused_observation or {}

    visible_text = state.get("visible_text_excerpt") or fused.get("visible_text") or ""
    omitted = state.get("visible_text_omitted_chars") or 0
    if not isinstance(visible_text, str):
        visible_text = str(visible_text)
    if len(visible_text) > MAX_VISIBLE_TEXT_CHARS:
        omitted += len(visible_text) - MAX_VISIBLE_TEXT_CHARS
        visible_text = visible_text[:MAX_VISIBLE_TEXT_CHARS]

    headings = state.get("headings") or []
    if isinstance(headings, list):
        headings = headings[:MAX_HEADINGS]

    evidence = {
        "PAGE_STATE": {
            "url": state.get("url"),
            "title": state.get("title"),
            "page_type": state.get("page_type"),
            "summary": state.get("summary"),
            "headings": headings,
            "result_sets": state.get("result_sets") or fused.get("result_sets"),
            "ranked_candidates": state.get("ranked_candidates"),
            "resolved_references": state.get("resolved_references") or fused.get("resolved_references"),
            "suggested_search_element": state.get("suggested_search_element"),
            "budget": state.get("budget"),
            "optimization": state.get("optimization"),
            "visible_text_excerpt": visible_text,
            "visible_text_omitted_chars": omitted,
        },
        "ALLOWED_ELEMENT_IDS": sorted(allowed),
        "AVAILABLE_ELEMENTS": select_relevant_elements(fused, state),
        "ACTION_HISTORY": summarize_history(task_history),
    }
    if _serialized_len(evidence) <= MAX_EVIDENCE_CHARS:
        return evidence

    # Over budget: drop unranked elements first, keeping every relevant one.
    relevant = set(_collect_relevant_ids(state))
    elements = evidence["AVAILABLE_ELEMENTS"]
    kept_relevant = [el for el in elements if _element_id(el) in relevant]
    kept_unranked = [el for el in elements if _element_id(el) not in relevant]
    while kept_unranked and _serialized_len(evidence) > MAX_EVIDENCE_CHARS:
        kept_unranked.pop()
        evidence["AVAILABLE_ELEMENTS"] = kept_relevant + kept_unranked
    if _serialized_len(evidence) <= MAX_EVIDENCE_CHARS:
        return evidence

    # Still over (pathological page): drop headings, then shrink the excerpt.
    # Relevant elements, allowed ids, and the history summary survive regardless.
    evidence["PAGE_STATE"]["headings"] = []
    if _serialized_len(evidence) <= MAX_EVIDENCE_CHARS:
        return evidence
    excerpt = evidence["PAGE_STATE"]["visible_text_excerpt"]
    over = _serialized_len(evidence) - MAX_EVIDENCE_CHARS
    if isinstance(excerpt, str) and len(excerpt) > over:
        evidence["PAGE_STATE"]["visible_text_excerpt"] = excerpt[: len(excerpt) - over]
        evidence["PAGE_STATE"]["visible_text_omitted_chars"] = (
            evidence["PAGE_STATE"]["visible_text_omitted_chars"] or 0
        ) + over
    return evidence


def _serialized_len(value: Any) -> int:
    try:
        return len(json.dumps(value, separators=(",", ":")))
    except (TypeError, ValueError):
        return MAX_EVIDENCE_CHARS + 1
