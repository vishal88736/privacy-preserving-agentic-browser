import os
import re
from pathlib import Path


def _read_api_keys(*names):
    """Read single or comma/semicolon/whitespace separated provider keys."""
    keys = []
    for name in names:
        value = os.getenv(name, "")
        for key in re.split(r"[,;\s]+", value.strip()):
            key = key.strip().strip("'\"")
            if key and key not in keys:
                keys.append(key)
    return tuple(keys)


def load_env():
    # Look for .env in current working dir, backend folder, or project root
    candidates = [
        Path(".env"),
        Path("backend/.env"),
        Path(__file__).parent / ".env",
        Path(__file__).parent.parent / ".env"
    ]
    for env_path in candidates:
        if env_path.is_file():
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'").strip('"')
                            if k not in os.environ:
                                os.environ[k] = v
                break
            except Exception:
                pass

load_env()

_OPENROUTER_KEYS = _read_api_keys("OPENROUTER_API_KEYS", "OPENROUTER_API_KEY")
_HUGGINGFACE_KEYS = _read_api_keys(
    "HUGGINGFACE_API_KEYS", "HUGGINGFACE_API_KEY", "HF_API_KEYS", "HF_API_KEY", "HF_TOKEN"
)
_GROQ_KEYS = _read_api_keys("GROQ_API_KEYS", "GROQ_API_KEY")
_CONFIGURED_AI_BASE_URL = os.getenv("AI_BASE_URL")


def _default_ai_base_url():
    if _OPENROUTER_KEYS:
        return "https://openrouter.ai/api/v1"
    if _HUGGINGFACE_KEYS:
        return "https://router.huggingface.co/v1"
    if os.getenv("NVIDIA_API_KEY"):
        return "https://integrate.api.nvidia.com/v1"
    if os.getenv("GROK_API_KEY") or os.getenv("XAI_API_KEY"):
        return "https://api.x.ai/v1"
    if _GROQ_KEYS:
        return "https://api.groq.com/openai/v1"
    return "https://api.openai.com/v1"


def _reasoning_api_key(base_url):
    """Choose the provider-specific key matching the reasoning endpoint."""
    # An explicitly configured generic key remains the highest-priority
    # override. Otherwise, don't send (for example) an OpenRouter key to Groq
    # merely because both provider keys happen to be present in .env.
    if os.getenv("AI_API_KEY"):
        return os.getenv("AI_API_KEY")
    host = str(base_url or "").lower()
    if "groq.com" in host and _GROQ_KEYS:
        return _GROQ_KEYS[0]
    if "openrouter.ai" in host and _OPENROUTER_KEYS:
        return _OPENROUTER_KEYS[0]
    if "huggingface.co" in host and _HUGGINGFACE_KEYS:
        return _HUGGINGFACE_KEYS[0]
    if "api.x.ai" in host:
        return os.getenv("GROK_API_KEY") or os.getenv("XAI_API_KEY") or ""
    if "integrate.api.nvidia.com" in host:
        return os.getenv("NVIDIA_API_KEY", "")
    if "api.openai.com" in host:
        return os.getenv("OPENAI_API_KEY", "")
    return (
        (_OPENROUTER_KEYS[0] if _OPENROUTER_KEYS else "") or
        (_HUGGINGFACE_KEYS[0] if _HUGGINGFACE_KEYS else "") or
        os.getenv("NVIDIA_API_KEY") or
        os.getenv("GROK_API_KEY") or
        os.getenv("XAI_API_KEY") or
        (_GROQ_KEYS[0] if _GROQ_KEYS else "") or
        os.getenv("OPENAI_API_KEY") or
        os.getenv("GEMINI_API_KEY") or
        ""
    )


class Settings:
    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT", 8000))

    # Supports one general reasoning key plus provider-specific keys.
    API_KEY: str = _reasoning_api_key(_CONFIGURED_AI_BASE_URL or _default_ai_base_url())

    # Base URL for reasoning calls; VLM provider endpoints rotate independently.
    AI_BASE_URL: str = _CONFIGURED_AI_BASE_URL or _default_ai_base_url()

    VLM_MODEL: str = os.getenv("VLM_MODEL", "qwen2.5-vl-72b")
    VLM_OPENROUTER_MODEL: str = os.getenv("VLM_OPENROUTER_MODEL", "")
    VLM_HUGGINGFACE_MODEL: str = os.getenv("VLM_HUGGINGFACE_MODEL", "")
    VLM_GROQ_MODEL: str = os.getenv("VLM_GROQ_MODEL", "")
    OPENROUTER_API_KEYS: tuple = _OPENROUTER_KEYS
    HUGGINGFACE_API_KEYS: tuple = _HUGGINGFACE_KEYS
    GROQ_API_KEYS: tuple = _GROQ_KEYS
    VLM_PROVIDER_ORDER: str = os.getenv("VLM_PROVIDER_ORDER", "openrouter,huggingface,groq")
    VLM_MAX_ATTEMPTS: int = max(1, int(os.getenv("VLM_MAX_ATTEMPTS", "2")))
    VLM_REQUEST_TIMEOUT_SECONDS: float = max(1.0, float(os.getenv("VLM_REQUEST_TIMEOUT_SECONDS", "4")))
    REASONING_MODEL: str = os.getenv("REASONING_MODEL", "gpt-oss-120b")
    INTERPRETATION_REQUEST_TIMEOUT_SECONDS: float = max(1.0, float(os.getenv("INTERPRETATION_REQUEST_TIMEOUT_SECONDS", "10")))
    REASONING_REQUEST_TIMEOUT_SECONDS: float = max(1.0, float(os.getenv("REASONING_REQUEST_TIMEOUT_SECONDS", "12")))

    # Browser Agent Settings
    BROWSER_CDP_ENDPOINT: str = os.getenv("BROWSER_CDP_ENDPOINT", "http://localhost:9222")
    BROWSER_HEADLESS: bool = os.getenv("BROWSER_HEADLESS", "false").lower() == "true"
    AGENT_MAX_ITERATIONS: int = int(os.getenv("AGENT_MAX_ITERATIONS", "30"))

settings = Settings()
