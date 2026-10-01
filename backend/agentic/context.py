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
import re
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


# Element-id pattern for the extension's per-observation registry (el_1, el_2,
# ...). Ids are reassigned on every extraction, so any id quoted outside its
# own observation — history summaries, previous plan text — is stale by
# definition and must never be shown to the planner as a reusable handle.
STALE_ID_PATTERN = re.compile(r"\bel_\d+\b")

# Placeholder that replaces a stale id where prose must stay readable. It is
# deliberately not a valid target shape, so the grounding-repair guard can
# never mistake it for an executable element.
STALE_ID_PLACEHOLDER = "[stale-id]"


def scrub_stale_ids(text: str) -> str:
    """Replace observation-scoped element ids with an unusable placeholder."""
    if not isinstance(text, str) or not text:
        return text if isinstance(text, str) else ""
    return STALE_ID_PATTERN.sub(STALE_ID_PLACEHOLDER, text)


def summarize_history(task_history: Optional[List[Dict[str, Any]]]) -> str:
    """Compress step history into a short loop-memory string.

    Keeps what the planner and critic actually decide on: how many steps ran,
    the last step's outcome in detail, the consecutive-failure count (the
    same signal the circuit breakers use), the latest critic feedback, and
    any extracted answer text. Older steps collapse into counts — their full
    detail already had its chance to influence earlier calls.

    Element ids are NEVER repeated here, not even the last step's target:
    the extension reassigns every id on each observation, so a quoted id is
    always stale, and the planner copies what it sees — emitting the stale
    id, taking a grounding-repair WAIT, re-observing, and repeating until
    the stuck-loop breaker fails the task. The per-step verification block
    already carries the target outcome (present / state-changed) without
    naming an unusable handle.
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
    if last.get("success") is False:
        last_outcome = f"FAILED ({scrub_stale_ids(str(last.get('error') or 'unknown error'))[:160]})"
    else:
        last_outcome = "succeeded"
    parts = [
        f"steps={len(history)} (succeeded={successes}, failed={failures}, "
        f"consecutive_failures={consecutive_failures})",
        # No target id: it belongs to a previous observation (see docstring).
        f"last_step: {last_action or '?'} -> {last_outcome}",
    ]
    feedback = last.get("planner_feedback")
    if isinstance(feedback, str) and feedback.strip():
        # Critic feedback quotes previous plans, ids included — scrub the
        # stale handles so only the reasoning survives.
        parts.append(f"latest_critic_feedback: {scrub_stale_ids(feedback.strip())[:300]}")
    extracted = last.get("extracted_text")
    if isinstance(extracted, str) and extracted.strip():
        parts.append(f"last_extracted_text: {extracted.strip()[:300]}")
    verification = (last.get("diagnostic") or {}).get("post_action_verification")
    if isinstance(verification, dict):
        parts.append(
            "post_action_verification: "
            f"status={str(verification.get('status') or 'unknown')[:48]}, "
            f"visible_state_changed={bool(verification.get('visible_state_changed'))}, "
            f"target_present={bool(verification.get('target_present'))}, "
            f"target_state_changed={bool(verification.get('target_state_changed'))}"
        )
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


def _stored_document_tokens(stored_documents: Optional[List[str]]) -> List[str]:
    """Keep only well-formed ``LOCAL_DOCUMENT_<NAME>`` tokens, de-duplicated.

    The extension already validates names; re-validating here means a tampered
    or buggy client cannot widen the planner's vocabulary into something the
    extension would not accept anyway.
    """
    tokens = set()
    for raw in stored_documents or []:
        name = str(raw)
        if re.fullmatch(r"LOCAL_DOCUMENT_[A-Z0-9_]{1,48}", name):
            tokens.add(name)
    return sorted(tokens)


def build_page_evidence(
    fused_observation: Optional[Dict[str, Any]],
    page_state: Optional[Dict[str, Any]],
    allowed: set,
    task_history: Optional[List[Dict[str, Any]]],
    stored_documents: Optional[List[str]] = None,
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

    # VLM responses currently provide short prose summaries, not control
    # detections. Carry that evidence to the planner with its provenance and a
    # strict size cap; do not manufacture element boxes or confidence scores.
    visual_layout = state.get("visual_layout") or fused.get("visual_layout_summary") or ""
    visual_state = state.get("visual_state") or fused.get("visual_state_summary") or ""
    if not isinstance(visual_layout, str):
        visual_layout = ""
    if not isinstance(visual_state, str):
        visual_state = ""

    evidence = {
        "PAGE_STATE": {
            "url": state.get("url"),
            "title": state.get("title"),
            "page_type": state.get("page_type"),
            "perception_provenance": state.get("provenance") or fused.get("provenance") or "DOM_ONLY",
            "visual_layout": visual_layout[:500],
            "visual_state": visual_state[:500],
            # Derived playback signal (booleans/counts only, never raw media
            # objects). Without this the planner cannot tell playing from
            # paused: after CLICK play every later observation looks identical,
            # so it clicks again (toggling pause) and never emits DONE.
            "media_summary": state.get("media_summary") or fused.get("media_summary") or "no playable media",
            "media_playing": bool(state.get("media_playing") or fused.get("media_playing")),
            # Form fill counts only (no values) so the planner can terminate
            # fill tasks itself instead of re-filling a completed form.
            "form_completion": state.get("form_completion") or (
                (fused.get("form_state") or {}).get("completion")
                if isinstance(fused.get("form_state"), dict) else None
            ),
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
        # Token names of the documents the user stored in their local vault.
        # Names are not personal values and never leave the extension as
        # anything else, but they are the whole vocabulary an UPLOAD may use:
        # an action naming anything absent from this list is unroutable.
        "STORED_DOCUMENTS": _stored_document_tokens(stored_documents),
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
