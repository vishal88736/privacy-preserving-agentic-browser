# Model Provider Configuration

## VLM provider rotation

The VLM runs from the backend. Its credentials stay in the backend environment and are never sent to the extension. Configure comma-separated key lists with `OPENROUTER_API_KEYS`, `HUGGINGFACE_API_KEYS`, and `GROQ_API_KEYS`. The existing single-key variables (`OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` / `HF_TOKEN`, and `GROQ_API_KEY`) also work.

The extension captures and locally sanitizes a screenshot for every observation before sending it with sanitized DOM to the VLM endpoint. If no configured vision model responds, the backend returns an explicitly labeled DOM heuristic fallback.

Each vision request starts with the next configured provider/key pair in `VLM_PROVIDER_ORDER`. On an HTTP error, the backend tries up to `VLM_MAX_ATTEMPTS` pairs, then uses the local DOM heuristic. A timed-out provider returns to the heuristic immediately; the next request starts with the next credential/provider. Configure a provider-specific model with `VLM_OPENROUTER_MODEL`, `VLM_HUGGINGFACE_MODEL`, or `VLM_GROQ_MODEL`; if it is blank, `VLM_MODEL` is used. Set models that accept image inputs at the provider endpoint.

The defaults cap each VLM provider request at four seconds and try at most two credentials/providers. Override them with `VLM_REQUEST_TIMEOUT_SECONDS` and `VLM_MAX_ATTEMPTS`. The provider endpoints are OpenRouter `/api/v1/chat/completions`, Hugging Face `router.huggingface.co/v1/chat/completions`, and Groq `/openai/v1/chat/completions`.

## Reasoning provider

Reasoning uses one OpenAI-compatible Chat Completions endpoint from `AI_BASE_URL`. Set `REASONING_MODEL` to a model ID supported by that endpoint. Each reasoning call has a 12-second default timeout, configurable through `REASONING_REQUEST_TIMEOUT_SECONDS`. The extension parses the task locally at startup, avoiding a separate remote `/interpret` call; the reasoning request receives the sanitized task and grounded page state as before.

### Amazon Bedrock

Bedrock works through its OpenAI-compatible Chat Completions API without adding a Python dependency. Configure a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK` (or `BEDROCK_API_KEY`) and set `BEDROCK_REGION` (or the standard `AWS_REGION` / `AWS_DEFAULT_REGION`). For example:

```dotenv
AI_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
AWS_BEARER_TOKEN_BEDROCK=<your Bedrock API key>
REASONING_MODEL=openai.gpt-oss-120b-1:0
```

Use the region where the model is available and the exact Bedrock model ID enabled for your account. Choose a model that supports Chat Completions on the selected endpoint; model availability differs by endpoint and region. The server sends the Bedrock API key as a Bearer token. Short-term Bedrock keys expire and must be refreshed in the environment; this backend does not refresh them automatically. Long-term AWS access-key/secret credentials and SigV4 signing are not implemented by this HTTP client; use a Bedrock API key for this configuration. Bedrock reasoning does not configure image understanding: keep a separate supported VLM provider configured if you need vision-model calls. AWS account model access and service quotas still apply, so Bedrock can also return rate-limit errors when its quotas are reached.

The recommended Runtime endpoint above is the default. If a model or capability is only available through Bedrock Mantle, set `AI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1` explicitly.

When no `AI_BASE_URL` is set, a Bedrock endpoint is selected automatically if a Bedrock API key and AWS region are configured and no higher-priority provider credentials are present. If multiple providers are configured, set `AI_BASE_URL` explicitly to choose Bedrock.

Copy [backend/.env.example](../backend/.env.example) to `backend/.env` and replace the example model IDs and keys. Never commit the real `.env` file.

## Official API references

- [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [Hugging Face OpenAI-compatible chat completions](https://huggingface.co/docs/inference-providers/index)
- [Groq vision API](https://console.groq.com/docs/vision)
- [Amazon Bedrock OpenAI-compatible Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
- [Amazon Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)
- [Bedrock model and endpoint compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html)
- [Bedrock inference quotas and scaling](https://docs.aws.amazon.com/bedrock/latest/userguide/scaling-throughput-best-practices.html)
