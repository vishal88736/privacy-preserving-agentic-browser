# Threat Model

## Untrusted inputs

Webpage DOM, text, labels, attributes, screenshots, and model outputs are untrusted. Page content can attempt indirect prompt injection, forge labels/buttons, mutate elements between observation and action, or send runtime messages from the page's extension content-script context.

## Controls in the supported path

- Background user-control messages require the extension's own sender identity and side-panel context. Chrome and Firefox extension origins are handled separately; page content scripts have a tab sender and are rejected.
- Content-script executor commands require a message from the same extension without a webpage tab sender.
- Local screenshot-analysis messages are handled by the extension side panel. OCR text is discarded locally; only categories, boxes, counts, and object labels return to the background.
- The backend-driven `/agent` routes are removed. The backend binds to loopback by default and model endpoints reject non-extension browser origins.
- Sensitive values are pattern/semantics-sanitized locally; the outbound policy checks known formats and configured strings.
- Known sensitive interactive controls, OCR-matched text, and detected person boxes are screenshot-masked. Screenshots are withheld for unlocated or unmatched sensitive text and canvas/video surfaces. Local-analysis failures stop the task before image upload.
- The local action validator and risk gate run before execution. Detached stale element references are rejected.
- Real document upload through the extension is unsupported and fails closed.

## Residual risks

The extension cannot recognize all names, addresses, account numbers, financial details, arbitrary secrets, or PII rendered in images. Canvas/video causes screenshot withholding. OCR scans ordinary screenshots, but can miss text and is English-only. Person boxes can be missed and are not face-specific. The backend cannot prove visual redaction from a request payload; its privacy claim depends on a trusted, unmodified extension and browser-origin controls. Another local process, a compromised browser/extension, or a malicious model provider is outside this boundary.

Vault values are stored in `chrome.storage.local` without encryption implemented by this project. Remote VLM failures may leave the agent with DOM and local annotations but no server VLM result; provenance makes that explicit. The browser side panel must remain open while local analysis is active.
