# TheAgenticBrowser vendoring record

## Pinned source

- **Repository:** [TheAgenticAI/TheAgenticBrowser](https://github.com/TheAgenticAI/TheAgenticBrowser)
- **Pinned commit:** [`71daa285d65584333e0c69b963360f8b74fd980f`](https://github.com/TheAgenticAI/TheAgenticBrowser/commit/71daa285d65584333e0c69b963360f8b74fd980f)
- **Commit date and subject:** 2025-02-01, `Update README.md`
- **Pin policy:** This record names a full commit SHA. Do not replace it with a branch name or floating `main` reference.

The four Python files under `_upstream/` are reference material only. Each begins with the required safety banner, followed by the exact source bytes from the pinned commit. Thus the upstream payload is byte-identical after removing that one added banner line. The archived-file checksums below cover the full files, including the banner; source-payload checksums cover the bytes at the pinned commit.

## File map and SHA-256 checksums

| Upstream file at pinned commit | Use in this repository | Upstream payload SHA-256 | Vendored file | Vendored file SHA-256 |
| :--- | :--- | :--- | :--- | :--- |
| `core/agents/planner_agent.py` | Adapted as `planner.py`, `prompts.py`, and `schemas.py` | `eda1970a3e2cf22f075dc4af7746ec67c323cfb8b4febe51f045fa5563cba5d5` | [`_upstream/planner_agent.py`](_upstream/planner_agent.py) | `2064f8237f76295d23c1027e2da56e8d9f55e78a7a9766e23368f2aa2a977fac` |
| `core/agents/browser_agent.py` | Reference only; Playwright tools are excluded | `a34f4b370b1ee85476620b6203b34b769f91eda329ce6af0634abc058708c44a` | [`_upstream/browser_agent.py`](_upstream/browser_agent.py) | `e54b6d0e45addaff66266bab51f60777f3db8f1d3253ec5d5775ce2422981697` |
| `core/agents/critique_agent.py` | Adapted as `critic.py`, `prompts.py`, and `schemas.py` | `1a034eb300fc3f0a23c3844d2b820bf1d7dc4463184bf2c7a9e432f3371be478` | [`_upstream/critique_agent.py`](_upstream/critique_agent.py) | `1eaf9ab8508c951022a7e5b47b6e53966b789d5eae3cae9c0d9b94a2edf92358` |
| `core/orchestrator.py` | Adapted as `orchestrator.py`; loop moved to the extension | `84e75681ac2331052549bebd323e47dd99397977ea043eb23160d46b858307a2` | [`_upstream/orchestrator.py`](_upstream/orchestrator.py) | `c54677f398422d04773aefc3962b3fd57d08a29d74c18e7237bb206bc29487ce` |
| `LICENSE` | License text copied verbatim | `38671919a401868fd74740fec135459aa2b56a38be7c3dd62badff707729ab34` | [`LICENSE.TheAgentic`](LICENSE.TheAgentic) | `38671919a401868fd74740fec135459aa2b56a38be7c3dd62badff707729ab34` |

Verify the complete archived files (including the required banner) from the repository root:

```sh
sha256sum -c <<'EOF'
e54b6d0e45addaff66266bab51f60777f3db8f1d3253ec5d5775ce2422981697  backend/agentic/_upstream/browser_agent.py
1eaf9ab8508c951022a7e5b47b6e53966b789d5eae3cae9c0d9b94a2edf92358  backend/agentic/_upstream/critique_agent.py
c54677f398422d04773aefc3962b3fd57d08a29d74c18e7237bb206bc29487ce  backend/agentic/_upstream/orchestrator.py
2064f8237f76295d23c1027e2da56e8d9f55e78a7a9766e23368f2aa2a977fac  backend/agentic/_upstream/planner_agent.py
38671919a401868fd74740fec135459aa2b56a38be7c3dd62badff707729ab34  backend/agentic/LICENSE.TheAgentic
EOF
```

## Required license notice

The following Section 1.2(b) notice is reproduced from the upstream license:

> “This software is made available by TheAgentic, Inc., under the terms of the TheAgentic Community License Agreement, Version 1.0 located at http://www.TheAgentic.ai/TheAgentic-community-license.  BY INSTALLING, DOWNLOADING, ACCESSING, USING OR DISTRIBUTING ANY OF THE SOFTWARE, YOU AGREE TO THE TERMS OF SUCH LICENSE AGREEMENT.”

The complete license text is in [`LICENSE.TheAgentic`](LICENSE.TheAgentic). This summary does not replace the license.

## Adapted-file notices (Section 1.2(a))

The adapted modules identify their exact upstream source files and modifications in their module headers. In summary:

- The Planner and Critique `pydantic-ai` `result_type` declarations became ordinary Pydantic models validated from the existing backend client's JSON response.
- The live `/reason` call uses one universal prompt for plan management, action grounding, and critique. Planner inputs remain sanitized-only, value echo is forbidden, and protected values use device-local `LOCAL_*` tokens. The isolated Critique builder accepts an observation delta, and termination thresholds align with the extension's three-consecutive-failure breaker.
- The upstream Playwright tools and `mmid` selectors are not part of the adapted execution path. The extension remains the browser executor and owns tabs, confirmations, and the vault.
- The server-side orchestration loop was relocated to the extension. The backend composes one fused Planner + Critique reasoning call per step.

## Excluded-parts decision log

| Upstream piece | Verdict | Reason |
| :--- | :--- | :--- |
| `browser_agent.py` tool functions (10 Playwright tools, `mmid` selectors) | Reference only | Drives its own headless browser with raw DOM and screenshots, bypassing sanitization, the vault, policy engine, and risk gate. |
| `core/browser_manager.py`, `core/skills/*` | Not vendored | Same privacy and execution-boundary reason; the extension executor is the hands. |
| `core/utils/*` (`logfire`, `tiktoken`, `openai_client`) | Not vendored | Would add `pydantic-ai` 0.0.17, Logfire, and tiktoken; this project uses its existing `requests` client. |
| Planner prompts + plan/next-step schema | Adapted | Added sanitized-only input, no value echo, and `LOCAL_*` tokens. |
| Critique prompts + feedback/terminate schema | Adapted | Replaced screenshot-diff input with observation delta and aligned thresholds with the three-failure breaker. |
| Orchestrator loop design | Adapted, relocated | The loop lives in the extension, which owns tabs, confirmations, and the vault; the server makes one fused call per step. |

## Import safety guard

`_upstream/` is never imported. It requires `pydantic-ai`, which is deliberately not installed in this backend. Python files under `backend/`, `tests/`, and `scripts/` are guarded by the packaging script against static imports and dynamic import calls that name `_upstream`.

The equivalent repository check is:

```sh
rg -n --glob '*.py' '^[[:space:]]*(from|import)[[:space:]].*_upstream|import_module.*_upstream|__import__.*_upstream' backend tests scripts
```

No matches is the expected result.
