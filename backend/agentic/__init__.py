"""Planner + Critique agents for the reasoning backend.

Origin
------
Adapted from TheAgenticBrowser by TheAgenticAI
(https://github.com/TheAgenticAI/TheAgenticBrowser): planner role from
``core/agents/planner_agent.py``, critique role from
``core/agents/critique_agent.py``, and loop design from
``core/orchestrator.py``. The upstream browser implementation is preserved
only as a non-importable reference in ``_upstream/browser_agent.py``.

License notice (required by Section 1.2(b) of the upstream license; reproduced
verbatim on every file in this package):

    "This software is made available by TheAgentic, Inc., under the terms of
    the TheAgentic Community License Agreement, Version 1.0 located at
    http://www.TheAgentic.ai/TheAgentic-community-license. BY INSTALLING,
    DOWNLOADING, ACCESSING, USING OR DISTRIBUTING ANY OF THE SOFTWARE, YOU
    AGREE TO THE TERMS OF SUCH LICENSE AGREEMENT."

Modification notice (required by Section 1.2(a)): every module in this package
was modified by the PrivAgent project. The adaptations are documented at the
top of each file. In short:

* The upstream Planner and Critique use ``pydantic-ai`` ``result_type``
  declarations. The adapted schemas are ordinary Pydantic models; prompts
  and parsers use the backend's existing OpenAI-compatible ``requests``
  client. Planner prompts accept sanitized observations only, forbid value
  echo, and use ``LOCAL_*`` tokens. Critique input uses the observation delta
  instead of screenshot diffs, with the 3-failure threshold.
* The upstream Browser Agent's tools (Playwright selectors, ``mmid``
  attributes, screenshot diffing) are deliberately NOT vendored: executing
  them would bypass this project's privacy layer (client-side sanitization,
  local vault, outbound policy engine, risk gate, confirmations). Execution
  stays in the browser extension; only the plan/critique reasoning was
  adopted.
* The upstream Orchestrator runs the whole loop server-side. Here the loop
  lives in the extension's agent controller (which owns tabs, confirmations,
  and the vault). ``orchestrator.compose_reasoning_messages`` uses one
  universal system prompt per call, with the extension's step history as loop
  memory. The separate Planner/Critique builders and parsers remain available
  for isolated contract tests.

Public surface
--------------
``compose_reasoning_messages`` (via ``orchestrator``) is what
``gpt_oss_service.plan_step`` calls, and it sends only the universal task
prompt. ``planner`` and ``critic`` retain their separate message builders and
parsers for isolated contract tests; production request handling does not use
them.
"""

from agentic.orchestrator import compose_reasoning_messages
from agentic.schemas import CritiqueOutput, PlannerOutput, StepReasoning

__all__ = [
    "CritiqueOutput",
    "PlannerOutput",
    "StepReasoning",
    "compose_reasoning_messages",
]

# The role-specific prompt constants (PLANNER_SYSTEM_PROMPT,
# CRITIC_SYSTEM_PROMPT, ACTION_CONTRACT_PROMPT) and their builder/parser
# helpers were removed: nothing on the request path referenced them, and the
# live `/reason` call composes exactly one UNIVERSAL_TASK_PROMPT. Keeping
# unreachable adapted code from a restrictive upstream license shipped dead in
# the backend is a compliance and review liability, so the adaptation now lives
# only where it runs. The upstream originals remain in _upstream/ for audit.
