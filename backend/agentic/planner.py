"""TEST/REFERENCE-ONLY Planner message construction and output parsing.

The live ``/reason`` path uses ``UNIVERSAL_TASK_PROMPT`` through
``compose_reasoning_messages``. These isolated role-specific helpers remain
for contract tests and are not called by production request handling.

Upstream source: TheAgenticBrowser (TheAgenticAI),
``core/agents/planner_agent.py`` (``PA_SYS_PROMPT`` and
``PLANNER_AGENT_OP``), called from upstream ``core/orchestrator.py``. The
upstream ``pydantic-ai`` ``result_type`` is adapted to the project's Pydantic
``PlannerOutput`` and JSON parser, using the shared OpenAI-compatible
transport (owned by ``gpt_oss_service``). The prompt accepts sanitized-only
observations, forbids value echo, and uses ``LOCAL_*`` tokens. Playwright
tools are dropped and the loop is relocated to the browser extension.

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

from agentic.prompts import PLANNER_SYSTEM_PROMPT
from agentic.schemas import PlannerOutput


def build_planner_messages(
    task: str,
    plan: str,
    feedback: str,
    observation_summary: Dict[str, Any],
    history: List[Dict[str, Any]],
    current_url: str = "",
) -> List[Dict[str, str]]:
    """Build the chat messages for one planner invocation.

    Mirrors the upstream orchestrator's planner prompt (``User Query`` +
    ``Previous Plan``/``Feedback``), except the observation the planner sees
    is the already-sanitized page evidence: raw DOM never reaches this
    prompt, so the planner cannot leak what it was never shown.
    """
    if plan or feedback:
        user_block = {
            "USER_QUERY": task,
            "PREVIOUS_PLAN": plan or "(none yet)",
            "FEEDBACK": feedback or "(none yet)",
            "CURRENT_URL": current_url or "(unknown)",
            "SANITIZED_OBSERVATION": observation_summary,
            "ACTION_HISTORY": history,
        }
    else:
        user_block = {
            "USER_QUERY": task,
            "FEEDBACK": "None — this is a new task; produce the initial plan and first step.",
            "CURRENT_URL": current_url or "(unknown)",
            "SANITIZED_OBSERVATION": observation_summary,
            "ACTION_HISTORY": [],
        }
    return [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user_block, separators=(",", ":"))},
    ]


def parse_planner_output(content: str) -> PlannerOutput:
    """Parse the planner's JSON into a ``PlannerOutput``.

    The planner is instructed to emit ``plan``/``next_step`` (plus the
    critic-discipline fields when composed). Parsing is lenient about extra
    keys and strict about the two that matter: an empty ``next_step`` is a
    malformed plan, not an invitation to guess.
    """
    data = _extract_json_object(content)
    plan = data.get("plan") if isinstance(data.get("plan"), str) else ""
    next_step = data.get("next_step") if isinstance(data.get("next_step"), str) else ""
    if not next_step.strip():
        raise ValueError("Planner returned no next_step")
    return PlannerOutput(plan=plan.strip(), next_step=next_step.strip())


def _extract_json_object(content: str) -> Dict[str, Any]:
    """Parse the first well-formed JSON object in text, else {}.

    A local duplicate of the backend's balanced extractor, kept dependency-
    free so this module stays importable without the service modules.
    """
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
