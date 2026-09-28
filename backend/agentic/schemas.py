"""Structured outputs for the Planner and Critique agents.

Upstream sources: TheAgenticBrowser (TheAgenticAI),
``core/agents/planner_agent.py`` (``PLANNER_AGENT_OP``) and
``core/agents/critique_agent.py`` (``CritiqueOutput``, ``CritiqueInput``).

Required license notice: "This software is made available by TheAgentic,
Inc., under the terms of the TheAgentic Community License Agreement, Version
1.0 located at http://www.TheAgentic.ai/TheAgentic-community-license. BY
INSTALLING, DOWNLOADING, ACCESSING, USING OR DISTRIBUTING ANY OF THE
SOFTWARE, YOU AGREE TO THE TERMS OF SUCH LICENSE AGREEMENT."

Modification notice (Section 1.2(a)): modified by the PrivAgent project.
Changes versus upstream:

* Upstream models are ``pydantic-ai`` ``result_type`` declarations consumed
  by ``Agent.run``. Here they are plain Pydantic models parsed from the
  JSON returned by the backend's OpenAI-compatible client, because no new
  dependencies are introduced.
* ``result_type`` declarations became plain Pydantic models validated from
  the JSON returned by the existing backend client; ``pydantic-ai`` is not
  imported or installed.
* ``StepReasoning`` is new: it extends the upstream planner/critic outputs
  with the symbolic ``action`` this project's extension executes. The
  upstream Browser Agent emitted Playwright tool calls; here the planner's
  ``next_step`` is grounded to one ``ActionType`` action with an
  observation element id, which is what the risk gate and executor enforce.
* ``CritiqueInput`` is folded into the per-step call: the extension's step
  history (``ACTION_HISTORY``) carries the tool response, so no separate
  input model is needed.
* Upstream Playwright tools are dropped. The executor validates symbolic
  action output against the sanitized observation and local risk gate.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class PlannerOutput(BaseModel):
    """What the Planner decides for this step.

    Mirrors upstream ``PLANNER_AGENT_OP`` (``plan`` + ``next_step``).
    """

    plan: str = Field(
        default="",
        description="Complete step-by-step plan for the task, revised with the latest feedback.",
    )
    next_step: str = Field(
        default="",
        description="The single next action to execute, in plain language.",
    )


class CritiqueOutput(BaseModel):
    """What the Critique decides after reviewing the last executed step.

    Mirrors upstream ``CritiqueOutput`` (``feedback`` + ``terminate`` +
    ``final_response``).
    """

    feedback: str = Field(
        default="",
        description="Assessment of the last step against the plan, plus guidance for the next step.",
    )
    terminate: bool = Field(
        default=False,
        description="True when the request is satisfied or no further progress is possible.",
    )
    final_response: str = Field(
        default="",
        description="The answer to send the user when terminating. Must contain the actual answer, not a status message.",
    )


class StepReasoning(BaseModel):
    """The full per-step reasoning response: planner + critic + action.

    The fields include both the fused ``/reason`` names and the individual
    Planner/Critique parser names. ``action`` keeps the exact symbolic-action
    object the extension validates (``validateAction``).
    """

    plan: str = ""
    next_step: str = ""
    feedback: str = ""
    terminate: bool = False
    planner_feedback: str = ""
    terminate_assessment: bool = False
    final_response: str = ""
    thought: str = ""
    action: Dict[str, Any] = Field(default_factory=dict)
    task_understanding: Dict[str, Any] = Field(default_factory=dict)
    page_understanding: Dict[str, Any] = Field(default_factory=dict)
    grounding: Dict[str, Any] = Field(default_factory=dict)
    current_state: Dict[str, Any] = Field(default_factory=dict)
    is_terminal: bool = False
    extra: Dict[str, Any] = Field(default_factory=dict)

    model_config = {"extra": "allow"}
