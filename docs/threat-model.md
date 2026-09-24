# Threat Model

## Untrusted inputs

Webpage DOM, text, labels, attributes, screenshots, and model outputs are untrusted. Page content can attempt indirect prompt injection, forge labels/buttons, mutate elements between observation and action, or send runtime messages from the page's extension content-script context.

## Controls in the supported path

- Background user-control messages require Chrome's sender identity and the exact `chrome-extension://<id>/sidepanel/index.html` URL. A webpage content script shares the extension ID but has a webpage URL and is rejected.
- Content-script executor commands accept messages only from the extension service worker.
- The backend-driven `/agent` routes are removed. The backend binds to loopback by default and model endpoints reject non-extension browser origins.
- Sensitive values are pattern/semantics-sanitized locally; the outbound policy checks known formats and configured strings.
- Known sensitive interactive controls are screenshot-masked. Screenshots are withheld for identified unlocated sensitive text and canvas/video surfaces.
- The local action validator and risk gate run before execution. Detached stale element references are rejected.
- Real document upload through the extension is unsupported and fails closed.

## Residual risks

The extension cannot recognize all names, addresses, account numbers, financial details, arbitrary secrets, or PII rendered in images. Canvas/video causes screenshot withholding, but ordinary images and unknown visual text are not OCR-scanned. The backend cannot prove visual redaction from a request payload; its privacy claim depends on a trusted, unmodified extension and browser-origin controls. Another local process, a compromised browser/extension, or a malicious model provider is outside this boundary.

Vault values are stored in `chrome.storage.local` without encryption implemented by this project. Do not describe this as encrypted storage. Remote model failures may leave the agent in DOM-only operation; provenance makes that explicit, and the system does not claim a VLM result in that state.
