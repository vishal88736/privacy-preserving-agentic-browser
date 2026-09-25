# Model Provider Configuration

## VLM provider rotation

The VLM runs from the backend. Its credentials stay in the backend environment and are never sent to the extension. Configure comma-separated key lists with `OPENROUTER_API_KEYS`, `HUGGINGFACE_API_KEYS`, and `GROQ_API_KEYS`. The existing single-key variables (`OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` / `HF_TOKEN`, and `GROQ_API_KEY`) also work.

Each vision request starts with the next configured provider/key pair in `VLM_PROVIDER_ORDER`. On an HTTP error, the backend tries up to `VLM_MAX_ATTEMPTS` pairs, then uses the local DOM heuristic. A timed-out provider returns to the heuristic immediately; the next request starts with the next credential/provider. Configure a provider-specific model with `VLM_OPENROUTER_MODEL`, `VLM_HUGGINGFACE_MODEL`, or `VLM_GROQ_MODEL`; if it is blank, `VLM_MODEL` is used. Set models that accept image inputs at the provider endpoint.

The defaults cap each VLM provider request at four seconds and try at most two credentials/providers. Override them with `VLM_REQUEST_TIMEOUT_SECONDS` and `VLM_MAX_ATTEMPTS`. The provider endpoints are OpenRouter `/api/v1/chat/completions`, Hugging Face `router.huggingface.co/v1/chat/completions`, and Groq `/openai/v1/chat/completions`.

## Reasoning provider

Reasoning still uses one OpenAI-compatible endpoint from `AI_BASE_URL` and one key from `AI_API_KEY` or the existing provider-specific key variables. Set `REASONING_MODEL` to a model supported by that endpoint. Each reasoning call has a 12-second default timeout, configurable through `REASONING_REQUEST_TIMEOUT_SECONDS`. The extension now parses the task locally at startup, avoiding a separate remote `/interpret` call; the reasoning request receives the sanitized task and grounded page state as before.

Copy [backend/.env.example](../backend/.env.example) to `backend/.env` and replace the example model IDs and keys. Never commit the real `.env` file.

## Official API references

- [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [Hugging Face OpenAI-compatible chat completions](https://huggingface.co/docs/inference-providers/index)
- [Groq vision API](https://console.groq.com/docs/vision)
