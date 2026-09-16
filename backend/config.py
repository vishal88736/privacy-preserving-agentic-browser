import os
from pathlib import Path

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

class Settings:
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", 8000))

    # Supports AI_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY, GROK_API_KEY, XAI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
    API_KEY: str = (
        os.getenv("AI_API_KEY") or
        os.getenv("OPENROUTER_API_KEY") or
        os.getenv("NVIDIA_API_KEY") or
        os.getenv("GROK_API_KEY") or
        os.getenv("XAI_API_KEY") or
        os.getenv("GROQ_API_KEY") or
        os.getenv("OPENAI_API_KEY") or
        os.getenv("GEMINI_API_KEY") or
        ""
    )

    # Base URL for API calls (OpenAI, OpenRouter, NVIDIA, Grok/xAI, Groq, Ollama, vLLM, etc.)
    AI_BASE_URL: str = os.getenv(
        "AI_BASE_URL",
        "https://openrouter.ai/api/v1" if os.getenv("OPENROUTER_API_KEY") else (
            "https://integrate.api.nvidia.com/v1" if os.getenv("NVIDIA_API_KEY") else (
                "https://api.x.ai/v1" if (os.getenv("GROK_API_KEY") or os.getenv("XAI_API_KEY")) else (
                    "https://api.groq.com/openai/v1" if os.getenv("GROQ_API_KEY") else "https://api.openai.com/v1"
                )
            )
        )
    )

    VLM_MODEL: str = os.getenv("VLM_MODEL", "qwen2.5-vl-72b")
    REASONING_MODEL: str = os.getenv("REASONING_MODEL", "gpt-oss-120b")

settings = Settings()

