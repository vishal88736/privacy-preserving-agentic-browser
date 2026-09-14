import os

class Settings:
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", 8000))
    VLM_MODEL: str = os.getenv("VLM_MODEL", "qwen2.5-vl-72b")
    REASONING_MODEL: str = os.getenv("REASONING_MODEL", "gpt-oss-120b")
    API_KEY: str = os.getenv("AI_API_KEY", "")

settings = Settings()
