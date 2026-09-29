# Architecture Decision: No Local LLM in the Extension

Referenced by `extension/reasoning/providers/planner-provider.js`. Status: **accepted**.

## Decision

Planning stays on the server reasoning endpoint. A local LLM is **not**
packaged, downloaded, or executed. The planner seam (`PlannerProviderChain`
with an inert `FutureLocalPlannerProvider`) exists so this can be revisited
without rewriting the agent loop.

## Arithmetic (measured, not estimated)

| Quantity | Value | Source |
|---|---|---|
| Packaged extension (`dist/chrome`) | ~48.1 MB | `npm run build:extensions` |
| Size budget | 50 MiB (52,428,800 B) | `scripts/package-extension.mjs` |
| Remaining headroom | **~4.3 MiB** | subtraction |
| Qwen3-0.6B Q4_K_M | ~400–500 MB on disk | upstream model card |
| LFM2.5-1.2B (Q4) | ~800 MB–1 GB on disk | upstream model card |
| Qwen3.5-4B Q4_K_M | ~2.5 GB on disk | upstream model card |

The smallest candidate is roughly **two orders of magnitude** over the
remaining headroom (0.4 GB vs 4.3 MB ≈ 100×). It cannot be bundled.

## Why runtime download is not the answer today

Fetching weights at runtime (the RunAnywhere model: download once, cache in
OPFS) would resolve the size problem but break three properties this project
treats as guarantees:

1. **Zero runtime network downloads for models and executable code.**
   Stated in `README.md` and enforced by the packaging script's asset
   verification. A first-run multi-hundred-MB download is the opposite of it.
2. **Offline operation.** Packaged assets work with no network; a cached model
   works only after a successful first download on an unmetered connection.
3. **Firefox support.** The download-and-cache path depends on OPFS plus
   offscreen documents plus WebGPU, a combination that is Chrome/Edge-first.
   The extension ships a Firefox manifest today.

## What would have to change first

1. Renegotiate (1): an explicit, user-consented model download with progress,
   checksum verification, and a fallback when it is absent.
2. Raise or scope the size budget, or split the build into a slim default and
   a local-model variant.
3. Decide Firefox: degraded (server planner only) or dropped for that variant.
4. Re-run the privacy review: a local model sees unsanitized context by
   design, so the "sanitized-only" contract must be restated for on-device
   inference (weights on disk, prompts in memory, nothing exfiltrated).

Until all four are done, local planning stays an interface, not an implementation.
