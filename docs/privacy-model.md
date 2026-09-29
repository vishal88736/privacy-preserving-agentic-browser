# Privacy Model and Data Boundary

## What this prototype does

The extension extracts a bounded set of interactive controls, headings, result cards, and visible text. Before model requests, it redacts fields classified by input type, labels, attributes, registered identifier patterns, and configured vault values. A packaged object detector and OCR engine analyze screenshots locally when visual evidence is needed. The DOM sanitizer, local OCR, and outbound policy share the rule registry in `extension/privacy/pii-rules.js`. Coverage remains finite and heuristic; it does not prove that arbitrary private data is absent.

The expected request path is:

```text
Untrusted page
  -> extension content script extracts bounded DOM evidence
  -> local DOM sanitizer and value-free sensitive-text audit
  -> when visual evidence is needed: screenshot sent to the open extension side panel
  -> local YOLOS-Tiny object detection and English OCR
  -> local screenshot masking
  -> if coverage is uncertain: skip the remote image request
  -> outbound policy engine
  -> extension-origin backend endpoint with sanitized task and page context
  -> reasoning provider (if configured)
  -> vision provider only when an image passed local checks
```

OCR text is used transiently for local pattern matching and is discarded before the side panel sends analysis results back to the background. Only object labels, categories, counts, confidences, boxes, and performance measurements are retained. The reasoning backend receives the sanitized task and page context. The vision backend receives a sanitized screenshot with sanitized DOM only when the image passes local checks. If screenshot capture, OCR, or object detection fails, the image is withheld and the task continues from sanitized DOM evidence.

Every outbound model request is made by one of two clients: `extension/perception/vlm-client.js` for `/vision` and `extension/reasoning/gpt-oss-client.js` for `/interpret` and `/reason`. Both enforce the shared outbound policy immediately before the request. Local model asset reads use extension-packaged URLs with remote model loading disabled; no runtime model download is configured.

The content script attaches an opaque snapshot ID and mutation revision to every observation-bound action. The content executor checks that pair before interacting and after scrolling a target into view. If the page changes while the server reasons or while confirmation is pending, the action is refused and the controller observes and grounds again. Multi-field form actions stop when a mutation makes the remaining observation stale.

The backend-driven `/agent` browser automation path is retired. The backend accepts model API requests only from Chrome/Firefox extension origins and binds to loopback by default. This limits browser-page access; it is not protection against another local process or a compromised extension.

## Detection coverage

| Data | Coverage | Limit |
|---|---|---|
| Password fields, labeled Aadhaar/PAN/card/phone/email/DOB/name/address fields | Partially supported | A deceptive or unlabeled field can evade semantic detection. |
| Aadhaar, PAN, US SSN, Canadian SIN, UK NIN/NHS, IBAN, cards, email, phone, DOB, IFSC, common account and credential patterns | Registered patterns are checked in DOM text, OCR, and outbound payloads | Coverage is finite; national formats, OCR, validators, and false positives/negatives vary. Passport and other country-specific IDs need an explicit rule or semantic field label. |
| Configured vault strings | Exact/normalized matching for strings of useful length | Values not configured in the vault and transformed/encoded variants may not match. |
| Names, addresses, account numbers, financial details | Partially detected from field labels and common account wording | Arbitrary names/addresses/account formats cannot be recognized reliably. |
| Arbitrary sensitive text | Not reliably detectable | Requires user review or a broader local classifier. |
| Text PII in ordinary screenshots | Scanned best-effort by local English OCR | OCR can miss text; unknown visual text can remain visible. |
| PII in canvas/video | Not analyzed for upload | A canvas/video surface causes screenshot withholding. |
| Faces/people | People may be detected as COCO `person` objects | The full detected person box is blacked out; YOLOS-Tiny is not a face detector and can miss people. |

The background captures screenshots only when visual evidence is needed, such as an explicitly visual task, an opaque visual surface, or sparse or poorly labeled DOM. Each captured screenshot goes to the open extension side panel for local analysis. The DOM sanitizer supplies category counts, not values, for recognized PII in page text. If OCR does not return enough matching boxes, a recognized OCR value has no usable box, or local vision does not complete, the sanitizer withholds the image and the controller skips the remote VLM request. The task can continue from sanitized DOM evidence. When image coverage is established, known sensitive form controls, detected text PII, and detected people are blacked out before an image is eligible for upload. This is not a guarantee that every sensitive pixel was found or masked.

## Vault and documents

Vault values are user-configured and held in memory as plaintext, because the executor needs the real value at the moment it writes into a page. What is written to `chrome.storage.local`, however, is AES-256-GCM ciphertext.

The key is generated once as a **non-extractable** `CryptoKey` and persisted in IndexedDB. IndexedDB can hold the key handle but cannot serialise its material, so the key bytes exist in no readable form — not in IndexedDB, not in `chrome.storage.local`, not in the profile directory on disk. Each value gets a fresh 12-byte IV per write, because GCM under a reused IV leaks plaintext relationships. A pre-existing plaintext vault is migrated on first load and the plaintext record is deleted.

What this does and does not cover:

- **Covers** a stolen profile directory, a backup or synced copy, and any other process reading those files as the same OS user.
- **Does not cover** malware, or a devtools session on the extension's own origin. A key that cannot be exported is not a key that cannot be used: anything that can run code as this extension can ask the browser to decrypt. The honest claim is "not readable as data at rest", not "unbreakable".
- **No user passphrase.** The key is not derived from a PIN, so there is nothing for a user to forget and no separate secret to protect. That is a deliberate trade: it buys key-material safety at the cost of the passphrase-based protection that would also resist code running as this extension.
- If Web Crypto or IndexedDB is unavailable, the vault **refuses to persist** rather than silently falling back to plaintext writes.
- A failed decrypt (tampered or corrupted record) is reported and the whole vault is withheld, rather than returning a partial set that could be mistaken for a complete profile.

The backend shared secret is stored the same way, in its own encrypted record, and is never written into the settings blob.

The vault starts empty, accepts `LOCAL_CUSTOM_*` text keys, and rejects other key formats and non-text values. Custom rule registration is code-configured through `registerPIIRule` in `extension/privacy/pii-rules.js`.

Real local-document selection is not implemented. A `LOCAL_DOCUMENT` action fails closed. A user can select a file directly on the website; that file is handled by the website and is outside this extension's document-privacy guarantee. The old backend `/agent` file/screenshot route is removed.

## Visual provenance

Each fused observation reports one canonical provenance value:

- `DOM_ONLY`: no real remote VLM result was used.
- `DOM_PLUS_HEURISTIC`: the backend derived a layout summary from sanitized DOM without screenshot-derived element detections.
- `REAL_VLM`: a configured remote vision model returned visual analysis. The current server returns prose layout/state summaries; it does not produce screenshot-derived control boxes, so interactive targets stay DOM-grounded.
- `LOCAL_MODEL`: identifies packaged local perception metadata; it does not claim remote VLM output.

The current VLM service does not produce screenshot-derived control boxes. Its DOM annotations remain `DOM` provenance, and element fusion does not create visual-only targets. The planner receives real VLM prose only when the source is `REAL_VLM`; otherwise it receives a labeled DOM heuristic or DOM-only fallback.

The controller captures screenshots only when visual evidence is needed. A captured image must pass the local vision and redaction checks before it is eligible for the VLM endpoint; otherwise the controller reasons from sanitized DOM without sending an image. A DOM heuristic fallback may be used when no server vision model responds. This guarantee assumes the installed extension is trusted and unmodified. The backend cannot independently prove that an image has been visually redacted; arbitrary local callers and compromised extensions are outside this boundary.

## Claim status

| Claim | Status |
|---|---|
| Sensitive data never leaves the device | **NOT SUPPORTED** as an absolute claim. Known patterns and fields are redacted; unknown PII can escape. |
| VLM receives only sanitized screenshots | **PARTIALLY SUPPORTED** for the normal trusted-extension route; detection is best-effort and there is no server-side visual proof. |
| Webpages cannot approve actions or change settings | **SUPPORTED** for router messages: only the extension side panel is authorized. |
| Vault values are encrypted at rest | **SUPPORTED** for data at rest. AES-256-GCM under a non-extractable key held in IndexedDB, so the bytes are unreadable in the profile directory, in backups, and to another process reading those files. **NOT** resistant to code executing as this extension. No user passphrase. |
| A screenshot is sent on every observation | **NOT SUPPORTED**; visual inference is conditional, and uncertain images are withheld. |
| Zero plaintext transmission | **NOT SUPPORTED** as an absolute guarantee. |
| Real local document handling | **NOT SUPPORTED** by the extension. |
| PII remains local | **PARTIALLY SUPPORTED** for recognized patterns/fields; arbitrary PII cannot be guaranteed local. |
