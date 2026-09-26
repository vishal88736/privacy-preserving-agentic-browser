# Privacy Model and Data Boundary

## What this prototype does

The extension extracts a bounded set of interactive controls, headings, result cards, and visible text. Before model requests, it redacts fields classified by input type, labels, attributes, registered identifier patterns, and configured vault values. A packaged object detector and OCR engine also analyze each current screenshot inside the extension. The DOM sanitizer, local OCR, and outbound policy share the rule registry in `extension/privacy/pii-rules.js`. Coverage remains finite and heuristic; it does not prove that arbitrary private data is absent.

The expected request path is:

```text
Untrusted page
  -> extension content script extracts bounded DOM evidence
  -> local DOM sanitizer and value-free sensitive-text audit
  -> screenshot sent to the open extension side panel
  -> local YOLOS-Tiny object detection and English OCR
  -> local screenshot masking / screenshot withholding
  -> outbound policy engine
  -> extension-origin backend endpoint
  -> VLM/LLM provider (if configured)
```

OCR text is used transiently for local pattern matching and is discarded before the side panel sends analysis results back to the background. Only object labels, categories, counts, confidences, boxes, and performance measurements are retained. The server receives the sanitized screenshot plus sanitized DOM. A model or OCR initialization failure stops the task before a screenshot request is made.

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

The background sends each captured screenshot to the open extension side panel for local analysis. The DOM sanitizer supplies category counts, not values, for recognized PII in page text. If OCR does not return enough matching boxes for those categories, or a recognized OCR value has no usable box, the screenshot is replaced with a neutral placeholder. Known sensitive form controls with bounding boxes and detected people are blacked out. This is not a guarantee that every sensitive pixel was found or masked. Closing the side panel or failing to load the packaged assets stops the task before image upload.

## Vault and documents

Vault values are user-configured and stored in `chrome.storage.local`. This module does not encrypt them at rest, derive a key from a PIN, or guarantee memory erasure. The vault starts empty, accepts built-in values and `LOCAL_CUSTOM_*` text keys, and rejects other key formats and non-text values. Custom rule registration is code-configured through `registerPIIRule` in `extension/privacy/pii-rules.js`.

Real local-document selection is not implemented. A `LOCAL_DOCUMENT` action fails closed. A user can select a file directly on the website; that file is handled by the website and is outside this extension's document-privacy guarantee. The old backend `/agent` file/screenshot route is removed.

## Visual provenance

Each observation reports one of:

- `DOM_ONLY`: the server VLM request failed; local object/OCR checks still ran, with no server VLM result claimed.
- `DOM_PLUS_HEURISTIC`: the backend derived a layout summary from sanitized DOM without server VLM detections.
- `DOM_PLUS_REAL_VLM`: a configured remote vision model returned a result.

The controller captures a screenshot on every observation, requires the local vision pass to finish, and sends only sanitizer output and sanitized DOM through the normal extension route to the VLM endpoint. A DOM heuristic fallback may be used when no server vision model responds. This guarantee assumes the installed extension is trusted and unmodified. The backend cannot independently prove that an image has been visually redacted; arbitrary local callers and compromised extensions are outside this boundary.

## Claim status

| Claim | Status |
|---|---|
| Sensitive data never leaves the device | **NOT SUPPORTED** as an absolute claim. Known patterns and fields are redacted; unknown PII can escape. |
| VLM receives only sanitized screenshots | **PARTIALLY SUPPORTED** for the normal trusted-extension route; detection is best-effort and there is no server-side visual proof. |
| Webpages cannot approve actions or change settings | **SUPPORTED** for router messages: only the extension side panel is authorized. |
| Vault values are encrypted | **NOT SUPPORTED**. Values are stored in extension-scoped storage without encryption by this code. |
| The VLM endpoint is requested on every observation | **SUPPORTED** by the normal controller path; backend/provider failures can return an explicitly labeled DOM fallback. |
| Zero plaintext transmission | **NOT SUPPORTED** as an absolute guarantee. |
| Real local document handling | **NOT SUPPORTED** by the extension. |
| PII remains local | **PARTIALLY SUPPORTED** for recognized patterns/fields; arbitrary PII cannot be guaranteed local. |
