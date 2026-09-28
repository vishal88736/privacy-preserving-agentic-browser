"""TEST/REFERENCE-ONLY Critique construction, parsing, and assessment.

The live ``/reason`` path uses ``UNIVERSAL_TASK_PROMPT`` through
``compose_reasoning_messages``. These isolated role-specific helpers remain
for contract tests and are not called by production request handling.

Upstream source: TheAgenticBrowser (TheAgenticAI),
``core/agents/critique_agent.py`` (``CA_SYS_PROMPT``, ``CritiqueOutput``, and
``CritiqueInput``). The upstream ``pydantic-ai`` ``result_type`` is adapted
to the project's Pydantic ``CritiqueOutput`` and JSON parser. The upstream
tool response and screenshot-diff inputs become the extension's action
result and observation delta; raw screenshots do not leave the device.
Playwright tools are dropped, the termination threshold is 3 consecutive
failures, and the task loop is relocated to the extension.

Required license notice: "This software is made available by TheAgentic,
Inc., under the terms of the TheAgentic Community License Agreement, Version
1.0 located at http://www.TheAgentic.ai/TheAgentic-community-license. BY
INSTALLING, DOWNLOADING, ACCESSING, USING OR DISTRIBUTING ANY OF THE
SOFTWARE, YOU AGREE TO THE TERMS OF SUCH LICENSE AGREEMENT."

Modification notice (Section 1.2(a)): modified by the PrivAgent project as
described above; see ``agentic/__init__.py`` and ``VENDORING.md`` for the
complete adaptation map.
"""

import json
from typing import Any, Dict, List

from agentic.prompts import CRITIC_SYSTEM_PROMPT
from agentic.schemas import CritiqueOutput


def build_critic_messages(
    plan: str,
    current_step: str,
    action_result: Dict[str, Any],
    observation_delta: str,
) -> List[Dict[str, str]]:
    """Build the chat messages for one critique invocation.

    Mirrors the upstream orchestrator's critique prompt (``plan``,
    ``next_step``, ``tool_response``, ``tool_interactions``,
    ``ss_analysis``, ``browser_error``), with the privacy-preserving
    substitutions documented in ``prompts.py``: no screenshot diffs, no raw
    DOM, and the action result stands in for the tool response.
    """
    user_block = {
        "plan": plan or "(no plan recorded yet)",
        "current_step": current_step or "(unknown)",
        "action_result": action_result or {},
        "observation_delta": observation_delta or "(no change recorded)",
    }
    return [
        {"role": "system", "content": CRITIC_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user_block, separators=(",", ":"))},
    ]


def parse_critic_output(content: str) -> CritiqueOutput:
    """Parse the critic's JSON into a ``CritiqueOutput``.

    ``terminate=true`` without a usable ``final_response`` is coerced to
    ``terminate=false``: the upstream contract requires the two together,
    and a bare termination flag would end the task with no answer for the
    user.
    """
    data = _extract_json_object(content)
    feedback = data.get("feedback") if isinstance(data.get("feedback"), str) else ""
    terminate = data.get("terminate") is True
    final_response = (
        data.get("final_response") if isinstance(data.get("final_response"), str) else ""
    )
    if terminate and not final_response.strip():
        terminate = False
    return CritiqueOutput(
        feedback=feedback.strip(),
        terminate=terminate,
        final_response=final_response.strip(),
    )


def assess_termination(
    history: List[Dict[str, Any]],
    critic: CritiqueOutput,
    max_consecutive_failures: int = 3,
) -> Dict[str, Any]:
    """Deterministic termination backstop behind the critic's judgment.

    The upstream prompt terminates on "5+ loops / 7+ attempts". This backend
    aligns the constant with the extension's own circuit breaker
    (``MAX_CONSECUTIVE_FAILURES = 3`` in the agent controller) so the two
    layers cannot disagree about what "stuck" means: the server recommends
    termination on the same evidence the client enforces it on.
    """
    consecutive_failures = 0
    for step in reversed(history or []):
        if step.get("success") is False:
            consecutive_failures += 1
        else:
            break
    stuck = consecutive_failures >= max_consecutive_failures
    terminate = bool(critic.terminate) or stuck
    reason = None
    if stuck and not critic.terminate:
        reason = (
            f"deterministic backstop: {consecutive_failures} consecutive failed "
            "steps with no progress"
        )
    return {
        "terminate": terminate,
        "reason": reason,
        "consecutive_failures": consecutive_failures,
        "critic_terminate": bool(critic.terminate),
    }


def _extract_json_object(content: str) -> Dict[str, Any]:
    """Parse the first well-formed JSON object in text, else {}."""
    if not isinstance(content, str) or not content.strip():
        return {}
    text = content.strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start != -1:
        try:
            parsed, _ = decoder.raw_decode(text[start:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        start = text.find("{", start + 1)
    return {}
