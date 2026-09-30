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
- An agent-controlled file attachment can name only a document the user stored in the local vault under a validated `LOCAL_DOCUMENT_<NAME>` token. No part of the action schema, resolver, or executor accepts a path, URL, or file handle, so reading an arbitrary local file is not expressible. A generic request to upload a file is routed to `ASK_USER`, where the user chooses the file in the page's own picker. The synthetic demo upload is a separate fixed-body test path. Attaching a stored document is classified HIGH risk and requires explicit user confirmation.
- Stored document bytes are encrypted at rest with the same non-extractable key as the other vault secrets and are excluded from the exact-match outbound scan. File bytes, names, and MIME types are omitted from reasoning/model requests, but validated document tokens are sent so the planner can select a saved item; those names can reveal document types. After HIGH-risk user confirmation, the extension passes the selected bytes to its content script and attaches them to the current site's file input. The page can read the file, and form submission can transmit it to that site.

## Residual risks

The extension cannot recognize all names, addresses, account numbers, financial details, arbitrary secrets, or PII rendered in images. Canvas/video causes screenshot withholding. OCR scans ordinary screenshots, but can miss text and is English-only. Person boxes can be missed and are not face-specific. The backend cannot prove visual redaction from a request payload; its privacy claim depends on a trusted, unmodified extension and browser-origin controls. Another local process, a compromised browser/extension, or a malicious model provider is outside this boundary.

Vault values and stored documents are encrypted at rest in `chrome.storage.local` under a non-extractable AES-GCM key held in IndexedDB; the bytes are unreadable as data, but anything able to run code as this extension can still use the key to decrypt. Remote VLM failures may leave the agent with DOM and local annotations but no server VLM result; provenance makes that explicit. The browser side panel must remain open while local analysis is active.

A stored document is disclosed to whichever site the user is on once the user approves the attachment; the page may read it before form submission, and its form may transmit the bytes to the site. The reasoning service also sees the validated document token names, which can reveal what kinds of documents the user holds. The extension cannot tell an honest page from one that will keep the file.
