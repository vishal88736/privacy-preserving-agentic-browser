# Open-Source Reuse, Attribution, and Clean-Room Adaptation

This document details the licensing, attribution, conceptual reuse, clean-room reimplementations, and novel architectural contributions of the **Privacy-Preserving Agentic Browser Extension** for the Smart India Hackathon (SIH).

---

## 1. Audited Repositories

### Repository A: Magnitude Browser Agent
- **Repository URL**: `https://github.com/magnitudedev/browser-agent`
- **License**: Apache License 2.0 (Copyright 2025 magnitudedev)
- **License Compliance**: Notice and redistribution conditions followed under Section 4 of the Apache License 2.0.
- **Architectural Concepts Reused & Adapted**:
  - **Iterative Control Loop**: Adapted the `Observe → Act → Verify` cycle (`packages/magnitude-core/src/agent/index.ts`).
  - **Visual & Coordinate Grounding**: Action schema semantics for relative coordinate clicking, double-clicking, scrolling, typing, and hovering (`packages/magnitude-core/src/actions/webActions.ts`).
  - **Accessibility Tree Perception**: Concepts from `renderMinimalAccessibilityTree` (`packages/magnitude-core/src/web/util.ts`) for flattening interactive DOM nodes into high-density semantic descriptors without bloating token budgets.
  - **Page Stability Waiting**: Waiting for DOM quietness and network idle before capturing observations (`packages/magnitude-core/src/web/stability.ts`).
- **Components Excluded / Not Reused**:
  - Desktop connectors, Playwright harness, and Claude Code CLI wrappers.
  - "Masking" in Magnitude (`memory/masking.ts`): Magnitude's masking was purely token-retention pruning (sliding window over past turns), **not** privacy/PII masking. Magnitude transmitted full unredacted screenshots and HTML to remote LLMs.
- **Implementation Mechanism**: Clean-room implementation in vanilla ES modules / TypeScript compatible with Chrome Extension Manifest V3.

---

### Repository B: AI Browser Agent
- **Repository URL**: `https://github.com/AyushPoojariUCD/ai-browser-agent`
- **License**: MIT License (Copyright 2025 Ayush Poojari)
- **License Compliance**: MIT license conditions preserved.
- **Architectural Concepts Reused & Adapted**:
  - **Task Decomposition & Intent Parsing**: High-level task structuring, step progress reporting, and user chat state transitions (`backend-node/llmActionPlanner.js`).
  - **Action Grammar**: High-level semantic actions (`type`, `click`, `select`, `wait`).
- **Components Excluded / Not Reused**:
  - Electron desktop wrapper (`frontend/electron/*`) and Python `browser-use` sub-process.
  - Critical Privacy Anti-Pattern: AI Browser Agent sent raw HTML (`${html}`) and target values directly into external OpenAI API prompts without sanitization, leaking all form values, PII, and credentials.
- **Implementation Mechanism**: Clean-room implementation targeting Chrome Extension APIs (`chrome.tabs`, `chrome.scripting`, `chrome.sidePanel`) with zero Electron dependencies.

---

### Repository C: TheAgenticBrowser
- **Repository URL**: [`https://github.com/TheAgenticAI/TheAgenticBrowser`](https://github.com/TheAgenticAI/TheAgenticBrowser)
- **Pinned source**: Commit [`71daa285d65584333e0c69b963360f8b74fd980f`](https://github.com/TheAgenticAI/TheAgenticBrowser/commit/71daa285d65584333e0c69b963360f8b74fd980f)
- **License**: TheAgentic Community License Agreement, Version 1.0; the complete pinned text is copied to [`backend/agentic/LICENSE.TheAgentic`](../backend/agentic/LICENSE.TheAgentic).
- **Compliance notes**: The four upstream Python files are preserved under `backend/agentic/_upstream/` as reference-only copies. The adapted modules carry prominent modification notices, and the required Section 1.2(b) notice is reproduced in `backend/agentic/VENDORING.md`. Hashes, exact file mapping, exclusions, and adaptations are recorded there.
- **Concepts reused and adapted**: Planner plan/next-step structure, Critique feedback/termination structure, and the Planner → executor → Critique workflow design. The live `/reason` path uses one `UNIVERSAL_TASK_PROMPT` system message per step, combining those roles with this executor's action contract; it is defined in `backend/agentic/prompts.py`. Prompts were changed for sanitized observations, value non-echo, `LOCAL_*` tokens, observation deltas, and the extension's three-failure breaker. The upstream `pydantic-ai` result types became ordinary Pydantic models. Role-specific prompt constants and their builder/parser modules were removed once the unified prompt made them unreachable; the upstream originals remain in `backend/agentic/_upstream/` for audit.
- **Components excluded**: Browser Agent Playwright tools and `mmid` selectors, browser manager, skills, and utility integrations (`logfire`, `tiktoken`, and upstream `openai_client`). These components would route execution or raw page data around the extension's privacy and safety controls or add dependencies that this project deliberately avoids.
- **Implementation mechanism**: **verbatim reference copy + documented adaptation, no dependency taken**. The upstream browser executor is reference-only; browser execution and the task loop remain in the extension. The live prompt never emits `UPLOAD`; a defensive client check routes any accidental model-emitted `UPLOAD` to `ASK_USER` so file selection stays with the user.

**SIH evaluator restriction note:** The upstream license prohibits use for an Excluded Purpose: a competing SaaS, PaaS, IaaS, or similar online service. It also grants no sublicensing right. SIH evaluation or redistribution does not create a sublicense; each recipient must agree directly to the upstream license terms to exercise its rights. See [`backend/agentic/LICENSE.TheAgentic`](../backend/agentic/LICENSE.TheAgentic) for the controlling text.

### Repository D: RunAnywhere / RA Browser Use (studied reference, NOT adopted)
- **Repository URL**: [`https://github.com/RunanywhereAI/on-device-browser-agent`](https://github.com/RunanywhereAI/on-device-browser-agent)
- **License**: Apache-2.0. Studied as a reference only; **no code, assets, models, or dependencies were taken**, so no attribution obligation is triggered.
- **Upstream provenance, stated plainly**: this project is itself a fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser) (Apache-2.0), and its own README credits "the agent architecture, the DOM serialization, and the extension foundation" to Nanobrowser. Its own distinct contribution is *where the model runs*: inside the extension via WebAssembly + WebGPU instead of a cloud provider. Its README also states the project is "Early development, not yet released" with the on-device inference backend "being wired up."
- **Idea actually adopted**: none of its runtime. This project already performs on-device inference — `extension/perception/local-vision.js` runs YOLOS-Tiny (ONNX Runtime Web, `q4`) and Tesseract OCR in WASM, from packaged assets only.
- **One idea adopted, partially**: executing local perception on **WebGPU with a WASM fallback** where a real GPU adapter is available. This required no new bytes: the vendored runtime was already the `jsep` build of `ort-wasm-simd-threaded`, which contains the WebGPU execution provider, so the change is feature detection plus a fallback rather than a new dependency. The packaged build grew by ~2 KB. See `extension/perception/local-vision.js` (`_selectBackend`, `_loadDetector`) and `tests/perception/local-vision-backend.test.js`.
- **Deliberately rejected**: running a **local LLM** in the extension, which is RA's central premise. It would require downloading model weights at runtime and caching them in OPFS, which contradicts this project's stated property of **zero runtime network downloads** for models and executable code, would consume the remaining packaging headroom, and would drop Firefox support (RA depends on Chrome's WebGPU, OPFS, and offscreen documents). Recorded as future work only.

### Packaged local-vision assets

The extension build includes these upstream assets so screenshot analysis does not fetch executable code or model files at runtime:

| Asset | Source and pinned version | Upstream license |
| :--- | :--- | :--- |
| Transformers.js browser runtime | [`@huggingface/transformers` 4.3.0](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| YOLOS-Tiny quantized ONNX weights | [`Xenova/yolos-tiny`, pinned revision in `extension/models/local-vision-assets.json`](https://huggingface.co/Xenova/yolos-tiny) | Review the upstream model card and repository terms before redistribution. |
| Tesseract.js and OCR core | [`tesseract.js` / `tesseract.js-core` 7.0.0](https://github.com/naptha/tesseract.js) | Apache-2.0 |
| ONNX Runtime Web | `onnxruntime-web`, exact package version pinned in `package-lock.json` | MIT |
| English OCR language data | `@tesseract.js-data/eng` best-int language data | See the upstream data package terms. |

`npm run prepare:local-vision-assets` copies the pinned npm package assets and downloads the pinned model revision plus English language data. The YOLOS ONNX file is checked against its SHA-256 before it is written. `extension/vendor/` and `extension/models/` are generated distributable assets, not original model/runtime implementations.

---

## 2. Summary of Architectural Lineage

| Component | Source / Inspiration | Implementation Type | Privacy Status |
| :--- | :--- | :--- | :--- |
| **Observe-Act-Verify Loop** | Magnitude | Clean-room rewrite for MV3 | Enhanced with Sanitization step |
| **Task State Machine** | AI Browser Agent & Magnitude | Re-architected as 14-state FSM | Strict state-transition guards |
| **DOM Element Grounding** | Magnitude (`renderMinimalAccessibilityTree`) | Re-implemented for Content Script | Enforces PII attribute scrubbing |
| **Visual Grounding** | Magnitude (`webActions.ts`) | Re-implemented with Bounding Box IoU | Local coordinate safety gate |
| **Local PII Detector** | Project implementation | Regex + contextual rules | Runs locally; pattern coverage is incomplete |
| **DOM Sanitizer** | **Novel SIH Contribution** | Written from scratch | Replaces secrets with `LOCAL_*` |
| **Screenshot Redaction** | Project implementation using upstream OCR/object detection | OCR boxes + object boxes + DOM boxes | Canvas masking before remote VLM |
| **Local Secret Vault** | **Novel SIH Contribution** | Written from scratch | Values stored locally; outbound checks are best-effort |
| **Local Safety Risk Gate** | **Novel SIH Contribution** | Written from scratch | Blocks exfiltration & prompt injection |
| **DOM/local-vision/VLM fusion** | Project implementation | DOM grounding, packaged local model, remote VLM | Heuristic and VLM provenance reported explicitly |
| **Local perception execution provider** | WebGPU/WASM dual-path idea inspired by RA Browser Use (studied reference, no code taken) | Adapter-detected WebGPU with WASM fallback on the same packaged `jsep` runtime | On-device either way; zero runtime downloads |
| **MV3 Side Panel UI** | **Novel SIH Contribution** | Written from scratch | Real-time privacy & step dashboard |
| **Planner + Critique reasoning** | TheAgenticBrowser (pinned; see `backend/agentic/VENDORING.md`) | `UNIVERSAL_TASK_PROMPT`; one fused backend call per step; legacy role prompts retained for tests only | Sanitized inputs; extension owns execution and loop; uploads route to the user |

---

## 3. Clean-Room Work & Privacy Limits

1. **No Proprietary or Leaked Code**: The project's agent integration is written for WebExtensions using modern standard APIs. The extension package also contains third-party open-source runtimes and model/data assets listed above.
2. **Pattern-based privacy controls**: The extension redacts recognized PII and checks outbound requests; this does not guarantee zero plaintext transmission for arbitrary or undetected data.
3. **Symbolic Resolution**: The reasoning model only produces symbolic references (e.g., `LOCAL_AADHAAR`), which are resolved strictly within the browser extension's local sandboxed execution context.
