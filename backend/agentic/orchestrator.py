"""Per-step composition of the Planner + Critique reasoning call.

Upstream source: TheAgenticBrowser (TheAgenticAI),
``core/orchestrator.py``. Upstream the Orchestrator runs the whole Planner ->
Browser Agent -> Critique loop server-side, driving its own headless
Playwright browser across as many LLM roundtrips as the task needs.

Required license notice: "This software is made available by TheAgentic,
Inc., under the terms of the TheAgentic Community License Agreement, Version
1.0 located at http://www.TheAgentic.ai/TheAgentic-community-license. BY
INSTALLING, DOWNLOADING, ACCESSING, USING OR DISTRIBUTING ANY OF THE
SOFTWARE, YOU AGREE TO THE TERMS OF SUCH LICENSE AGREEMENT."

Modification notice (Section 1.2(a)): modified by the PrivAgent project. The
server-side loop was deliberately NOT adopted, for two load-bearing reasons:

1. The loop owns the browser. Upstream that browser is a headless Playwright
   instance fed with raw DOM and screenshots. Adopting it here would route
   page content around this project's privacy layer (client-side
   sanitization, local vault, outbound policy engine) and its safety layer
   (risk gate, human confirmations). Execution therefore stays in the
   extension.
2. The extension already owns a step loop with persistence across service-
   worker restarts, confirmation gating, and telemetry. A second,
   server-side loop would fight it over who advances the task.

Adaptations (Section 1.2(a)): the ``pydantic-ai`` agent calls and Playwright
tool execution are dropped. The browser loop is relocated to the extension,
which owns tabs, confirmations, and the vault. This module composes ONE
reasoning call per step with one universal system prompt. It combines plan
management, action grounding, progress critique, and the pre-existing
symbolic-action contract. The extension's step history is the loop memory:
each ``/reason`` call sees prior action results and current page evidence.

The unified prompt carries the cross-task rules in that single call; it adds
no round trip or endpoint, and the extension's action contract is unchanged.
"""

from typing import Dict, List

from agentic.prompts import UNIVERSAL_TASK_PROMPT


def compose_reasoning_messages(user_content: str) -> List[Dict[str, str]]:
    """Build the one-prompt, per-step [system, user] message pair."""
    return [
        {"role": "system", "content": UNIVERSAL_TASK_PROMPT},
        {"role": "user", "content": user_content},
    ]
