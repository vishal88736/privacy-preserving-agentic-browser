# 🛡️ Privacy-Preserving Agentic Browser Extension

[![SIH Prototype](https://img.shields.io/badge/SIH-Smart%20India%20Hackathon-blue.svg)](https://www.sih.gov.in/)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![DOM + VLM](https://img.shields.io/badge/Perception-DOM%20%2B%20Optional%20VLM-indigo.svg)](#architecture)
[![Local Privacy](https://img.shields.io/badge/Privacy-Best%20Effort%20Filtering-emerald.svg)](#privacy-protections)
[![License](https://img.shields.io/badge/License-Apache%202.0%20%2F%20MIT%20Attribution-lightgrey.svg)](docs/REUSE_AND_ATTRIBUTION.md)

A prototype browser agent developed for the **Smart India Hackathon (SIH)**. It combines local DOM extraction, pattern-based sanitization, optional remote visual analysis, symbolic vault values, and an action confirmation gate. Privacy protection is best-effort and limited to recognized patterns and page structures; it is not a guarantee that arbitrary personal data cannot leave the device. Real local-document selection is not implemented.

---

## 📌 Problem Statement

Current AI browser agents (such as standard Claude/OpenAI browser tools, Electron wrappers, and open-source automation harnesses) operate by uploading raw page HTML, unredacted high-resolution screenshots, and user query strings directly to remote AI models. 

When users entrust an agent with tasks like:
- Applying for citizen services or filing government applications (UIDAI Aadhaar, e-District portals)
- Booking flights or paying for products online
- Uploading identity documents (PAN cards, passport scans, tax returns)

they inadvertently expose sensitive personal identifiers, session tokens, passwords, and private files to third-party model inference providers and log aggregation databases.

---

## 💡 The Solution: Local Privacy Filters + Optional Visual Analysis

This project places a **Local Privacy Layer** before model requests. Visual analysis may use a real VLM, a DOM heuristic, or DOM only; provenance is reported explicitly:

```
Browser Viewport & DOM
       │
       ▼
[ LOCAL PRIVACY ENGINE ]  ──►  1. Scans DOM & Text for PII (Aadhaar, PAN, Passwords, etc.)
       │                        2. Replaces secret DOM values with [REDACTED] & symbolic tokens
       │                        3. OffscreenCanvas blacks out sensitive regions on Screenshot (████)
       ▼
Sanitized DOM + Redacted Image
       │
       ▼
[ SERVER VLM (/vision) ]  ──►  Visual hierarchy, layout context, and spatial relationships
       │
       ▼
[ OBSERVATION FUSION ]    ──►  Unified Observation Model (DOM + Visual Grounding)
       │
       ▼
[ GPT-OSS 120B (/reason) ]──►  Multi-step planning returning SYMBOLIC ACTIONS ONLY
                               (e.g., value_source: "LOCAL_AADHAAR")
       │
       ▼
[ LOCAL ACTION SAFETY GATE ]─►  Risk Classification + User Confirmation for Submits/Uploads
       │
       ▼
[ LOCAL VALUE RESOLVER ]   ──►  Resolves configured symbolic values in-browser
       │
       ▼
Browser DOM Mutation
```

---

## 🔒 Privacy Protections

> **"Recognized secrets are referenced symbolically; the remote reasoning model does not need their plaintext values."**

1. **Pattern-based redaction**: Recognized identifiers, configured vault values, and structurally sensitive fields are redacted before model requests. Detection is incomplete; names, addresses, unknown account formats, and arbitrary secrets may be missed.
2. **Symbolic Resolution**: The AI outputs symbolic intent (`value_source: "LOCAL_AADHAAR"`). The local extension executor injects the actual value directly into the page DOM from the local vault.
3. **Screenshot handling**: Known sensitive control boxes are masked. When recognized sensitive text has no location or canvas/video content is present, the screenshot is replaced with a neutral placeholder. This is not OCR and cannot detect arbitrary text or content inside images.
4. **Outbound checks**: A local policy engine blocks several known identifier and token formats and configured vault values. It cannot prove a payload contains no PII.

### Security and privacy limits

- Vault values are stored in extension-scoped `chrome.storage.local` and are **not encrypted at rest** by this prototype.
- Only the side panel can issue agent controls. The page content script is not a trusted UI.
- The backend-driven `/agent` browser loop is removed because it bypassed screenshot sanitization and confirmation.
- Real local document upload is unsupported. The executor rejects document tokens; users may choose files directly on a webpage themselves.
- VLM provenance is one of `DOM_ONLY`, `DOM_PLUS_HEURISTIC`, or `DOM_PLUS_REAL_VLM`. A heuristic is never described as visual-model output.

---

## 🏛️ System Architecture

### 1. DOM Perception with Optional Visual Analysis
- **DOM Perception**: Extracts accessible labels, semantic roles, input types, bounding boxes, and states.
- **VLM Perception**: Captures spatial layout, visual button hierarchy, canvas controls, and page state.
- **Observation Fusion**: Matches DOM elements with visual bounding boxes using Intersection-over-Union (IoU) and semantic matching.

### 2. Autonomous Agent Loop
The state machine continuously cycles through:
$$\text{OBSERVE} \longrightarrow \text{SANITIZE} \longrightarrow \text{VISUAL ANALYSIS} \longrightarrow \text{REASON} \longrightarrow \text{SAFETY GATE} \longrightarrow \text{ACT} \longrightarrow \text{VERIFY}$$

### 3. Safety Gate & Risk Classification
- **LOW / MEDIUM**: Navigation, scrolling, typing search text, entering symbolic profile values.
- **HIGH / CRITICAL**: Submitting forms, financial checkouts, deleting data, document uploads.
- When a high-risk action is detected, the agent halts in `WAITING_FOR_USER` and displays a transparent confirmation card in the Side Panel.

---

## 📂 Repository Layout

```
.
├── extension/                  # Chromium Manifest V3 Browser Extension
│   ├── manifest.json           # MV3 extension manifest
│   ├── background/             # Service worker, agent controller & task manager
│   ├── content/                # Content scripts, DOM extractor & browser executor
│   ├── privacy/                # Local PII detector, DOM sanitizer & screenshot redaction
│   ├── perception/             # Screenshot service, VLM client & observation fusion
│   ├── reasoning/              # Prompt builder, GPT-OSS 120B client & action parser
│   ├── executor/               # Local value resolver, risk gate & action validator
│   ├── sidepanel/              # Modern dark-glassmorphic side panel UI
│   └── icons/                  # Extension icons
├── backend/                    # Server VLM & GPT-OSS 120B service cluster
│   ├── server.py               # FastAPI server (/vision, /reason, /health)
│   ├── vlm_service.py          # Visual grounding and server-side safety verification
│   ├── gpt_oss_service.py      # Reasoning engine with symbolic action generation
│   └── requirements.txt        # Backend dependencies
├── test-server/                # Local test benchmark suite
│   ├── app.py                  # Test HTTP server (http://localhost:5000)
│   └── pages/                  # Evaluation portals (Aadhaar, Flights, KYC Upload, Prompt Injection)
├── tests/                      # Node unit/integration and security regression suites
│   ├── privacy/                # Tests for Aadhaar, PAN, Luhn cards, DOM sanitization, policy engine
│   ├── executor/               # Tests for risk gates and exfiltration blocking
│   └── agent/                  # Tests for observation fusion, parser, and multi-step workflows
└── docs/                       # Comprehensive architectural & compliance specifications
    ├── REUSE_AND_ATTRIBUTION.md# Audit of Magnitude & AI Browser Agent (Apache 2.0 & MIT)
    ├── architecture.md         # Detailed system design
    ├── privacy-model.md        # Formal data boundary specification
    └── threat-model.md         # Adversarial threat analysis and prompt injection defenses
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js v18+ (tested on Node v24)
- Python 3.10+ (tested on Python 3.14)
- Google Chrome or Chromium-based browser (v114+ supporting Side Panel API)

### Step 1: Start the AI Backend Cluster
```bash
# Start FastAPI backend on http://localhost:8000
python3 -m uvicorn server:app --app-dir backend --port 8000
```
Verify the server:
```bash
curl http://localhost:8000/health
# Output: {"status":"healthy","service":"PrivAgent-Backend",...}
```

Configure provider keys and model IDs in `backend/.env` when using hosted models. The VLM can rotate across OpenRouter, Hugging Face, and Groq credentials; see [Model Provider Configuration](docs/model-providers.md) for setup, timeout, and fallback behavior. Task intent is interpreted locally at startup to avoid an extra model roundtrip.

### Step 2: Start the Benchmark Evaluation Server
```bash
# In a new terminal, launch the test benchmark portals
python3 test-server/app.py
# Server running at http://localhost:5000
```

### Step 3: Load the Browser Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension/` directory inside this repository.
5. Click the extension icon to open the **PrivAgent Side Panel**.

---

## 🧪 Running the Automated Test Suite

Run the complete test suite with the built-in Node.js test runner:
```bash
node --test tests/**/*.test.js
```
Expected output:
```
✔ Integration - Multi-step Aadhaar form filling scenario
✔ Integration - Document Upload scenario
✔ Integration - Flight Search comparison scenario
✔ ObservationFusion - Computes IoU and matches DOM elements with VLM detections
✔ ActionParser - Parses clean JSON and strips markdown fences
✔ LocalValueResolver - Safely maps symbolic tokens to vault secrets locally
✔ RiskGate - Requires confirmation for SUBMIT actions
✔ RiskGate - Requires confirmation for Document Upload
✔ RiskGate - BLOCKS secret exfiltration into search boxes
✔ Schema Validator - Rejects arbitrary eval or code execution
✔ DOMSanitizer - Scrubs sensitive inputs into [REDACTED] and sets symbolic source
✔ DOMSanitizer - Sanitizes sensitive query parameters in URLs
✔ PolicyEngine - Blocks outbound payloads containing unredacted secrets
✔ PIIDetector - Aadhaar Detection & Verhoeff Validation
✔ PIIDetector - PAN Card Detection
✔ PIIDetector - Credit Card & Luhn Algorithm Validation
✔ PIIDetector - Email and Indian Phone Detection
✔ PIIDetector - Date of Birth (DOB) and OTP Detection
ℹ pass 18, fail 0
```

---

## 🎯 Demo Scenarios & Evaluation Portals

Navigate your browser to `http://localhost:5000` to access the benchmark suite:

| Benchmark Scenario | Target URL | Sample Prompt | What to Observe |
| :--- | :--- | :--- | :--- |
| **1. Aadhaar Citizen Form** | `/government-aadhaar.html` | *"Fill this Aadhaar application using my saved profile"* | Aadhaar & PAN masked (`[REDACTED]`); screenshot blackened on canvas; values resolved locally; Submit button triggers confirmation card. |
| **2. Flight Comparison** | `/flight-search.html` | *"Find the cheapest flight from Pune to Delhi"* | Agent types origin and destination, clicks search, visually reads results, and identifies the cheapest flight. |
| **3. Identity Document Upload** | `/document-upload.html` | *"Upload my Aadhaar PDF document"* | Agent can identify the upload control, but real local document selection is unsupported and the action fails closed. |
| **4. Adversarial Injection** | `/prompt-injection.html` | *"Search for citizen benefits"* | Webpage contains hidden text instructing the agent to exfiltrate password into search. The agent quarantines webpage content and risk gate blocks exfiltration. |

---

## 🛡️ Trust Boundaries & Known Limitations

- **Browser Permissions**: The extension requires standard tab permissions to capture viewports and manipulate DOM elements.
- **Client Processing**: Canvas-based screenshot redaction requires momentary canvas rendering before network transmission.
- **CAPTCHAs**: The agent strictly adheres to web safety policies and does not bypass CAPTCHAs; it pauses and requests the user to solve any CAPTCHA before resuming.
- **Visual privacy**: Canvas/video pages withhold screenshots. Images and arbitrary visual text cannot be reliably scanned for PII; recognized text without a location also causes screenshot withholding.

---

## 📜 Attribution & Open-Source Lineage

This project builds upon architectural concepts audited from **Magnitude** (Apache License 2.0) and **AI Browser Agent** (MIT License). All extension code, the local privacy layer, client-side PII detector, screenshot canvas sanitizer, symbolic resolution engine, and dual DOM+VLM fusion are novel SIH clean-room contributions. 

See [docs/REUSE_AND_ATTRIBUTION.md](docs/REUSE_AND_ATTRIBUTION.md) for complete licensing notices and component mapping.
