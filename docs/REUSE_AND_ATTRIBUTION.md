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

## 2. Summary of Architectural Lineage

| Component | Source / Inspiration | Implementation Type | Privacy Status |
| :--- | :--- | :--- | :--- |
| **Observe-Act-Verify Loop** | Magnitude | Clean-room rewrite for MV3 | Enhanced with Sanitization step |
| **Task State Machine** | AI Browser Agent & Magnitude | Re-architected as 14-state FSM | Strict state-transition guards |
| **DOM Element Grounding** | Magnitude (`renderMinimalAccessibilityTree`) | Re-implemented for Content Script | Enforces PII attribute scrubbing |
| **Visual Grounding** | Magnitude (`webActions.ts`) | Re-implemented with Bounding Box IoU | Local coordinate safety gate |
| **Local PII Detector** | **Novel SIH Contribution** | Written from scratch | 100% Local (Regex + Contextual) |
| **DOM Sanitizer** | **Novel SIH Contribution** | Written from scratch | Replaces secrets with `LOCAL_*` |
| **Screenshot Redaction** | **Novel SIH Contribution** | Written from scratch | Canvas blackout before remote VLM |
| **Local Secret Vault** | **Novel SIH Contribution** | Written from scratch | Values stored locally; outbound checks are best-effort |
| **Local Safety Risk Gate** | **Novel SIH Contribution** | Written from scratch | Blocks exfiltration & prompt injection |
| **DOM/VLM Observation Fusion** | **Novel SIH Contribution** | Written from scratch | Optional vision with explicit DOM-only/heuristic/VLM provenance |
| **MV3 Side Panel UI** | **Novel SIH Contribution** | Written from scratch | Real-time privacy & step dashboard |

---

## 3. Clean-Room Work & Privacy Limits

1. **No Proprietary or Leaked Code**: All implementation files in this extension are written specifically for Chrome Manifest V3 using modern standard Web APIs.
2. **Pattern-based privacy controls**: The extension redacts recognized PII and checks outbound requests; this does not guarantee zero plaintext transmission for arbitrary or undetected data.
3. **Symbolic Resolution**: The reasoning model only produces symbolic references (e.g., `LOCAL_AADHAAR`), which are resolved strictly within the browser extension's local sandboxed execution context.
