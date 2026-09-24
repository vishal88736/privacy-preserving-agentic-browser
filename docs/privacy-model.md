# Privacy Model and Data Boundary

## What this prototype does

The extension extracts a bounded set of interactive controls, headings, result cards, and visible text. Before model requests, it redacts fields classified by input type, labels, attributes, known identifier patterns, and configured vault values. The outbound policy checks a finite set of common identifier and token patterns. These controls reduce accidental disclosure; they do not prove that arbitrary private data is absent.

The expected request path is:

```text
Untrusted page
  -> extension content script extracts bounded DOM evidence
  -> local DOM sanitizer and pattern checks
  -> local screenshot masking / screenshot withholding
  -> outbound policy engine
  -> extension-origin backend endpoint
  -> VLM/LLM provider (if configured)
```

The backend-driven `/agent` browser automation path is retired. The backend accepts model API requests only from a Chrome extension origin and binds to loopback by default. This limits browser-page access; it is not protection against another local process or a compromised extension.

## Detection coverage

| Data | Coverage | Limit |
|---|---|---|
| Password fields, labeled Aadhaar/PAN/card/phone/email/DOB/name/address fields | Partially supported | A deceptive or unlabeled field can evade semantic detection. |
| Aadhaar, PAN, common card, email, Indian phone, date-like DOB, common API/bearer token patterns | Pattern detected | Formats vary; false negatives and false positives are possible. |
| Configured vault strings | Exact/normalized matching for strings of useful length | Values not configured in the vault and transformed/encoded variants may not match. |
| Names, addresses, account numbers, financial details | Partially detected from field labels and common account wording | Arbitrary names/addresses/account formats cannot be recognized reliably. |
| Arbitrary sensitive text | Not reliably detectable | Requires user review or a broader local classifier. |
| PII in canvas/video or text embedded in images | Not detected | Screenshot is withheld when canvas/video exists; image content can still be present in ordinary screenshots. |

Text recognized in the aggregate page excerpt is locally pattern-sanitized. If known sensitive text is found there without a reliable location, the screenshot is replaced by a neutral placeholder. Known sensitive form controls with bounding boxes are blacked out. Unknown visual text can remain visible; the project does not claim OCR-complete screenshot privacy.

## Vault and documents

Vault values are user-configured and stored in `chrome.storage.local`. This module does not encrypt them at rest, derive a key from a PIN, or guarantee memory erasure. Do not store high-value credentials unless you accept Chrome profile storage protections and their limits. The vault starts empty and rejects unsupported keys and non-text values.

Real local-document selection is not implemented. A `LOCAL_DOCUMENT` action fails closed. A user can select a file directly on the website; that file is handled by the website and is outside this extension's document-privacy guarantee. The old backend `/agent` file/screenshot route is removed.

## Visual provenance

Each observation reports one of:

- `DOM_ONLY`: no remote visual analysis was used, or the VLM request failed.
- `DOM_PLUS_HEURISTIC`: the backend derived a layout summary from sanitized DOM; this is not visual perception.
- `DOM_PLUS_REAL_VLM`: a configured remote vision model returned a result.

The VLM receives an image produced by the extension sanitizer and sanitized DOM through the normal extension route. This guarantee assumes the installed extension is trusted and unmodified. The backend cannot independently prove that an image has been visually redacted; arbitrary local callers and compromised extensions are outside this boundary.

## Claim status

| Claim | Status |
|---|---|
| Sensitive data never leaves the device | **NOT SUPPORTED** as an absolute claim. Known patterns and fields are redacted; unknown PII can escape. |
| VLM receives only sanitized screenshots | **PARTIALLY SUPPORTED** for the normal trusted-extension route; there is no server-side OCR proof. |
| Webpages cannot approve actions or change settings | **SUPPORTED** for router messages: only the exact side-panel document is authorized. |
| Vault values are encrypted | **NOT SUPPORTED**. Values are stored in extension-scoped Chrome storage without encryption by this code. |
| Dual perception is mandatory | **NOT SUPPORTED**. Provenance can be DOM-only, heuristic, or actual VLM. |
| Zero plaintext transmission | **NOT SUPPORTED** as an absolute guarantee. |
| Real local document handling | **NOT SUPPORTED** by the extension. |
| PII remains local | **PARTIALLY SUPPORTED** for recognized patterns/fields; arbitrary PII cannot be guaranteed local. |
