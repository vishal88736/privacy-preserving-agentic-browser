"""
Privacy-Preserving Agentic Backend Server
Exposes strict endpoints:
- POST /vision: Server VLM perception for layout and visual hierarchy
- POST /reason: GPT-OSS 120B reasoning and action planning with symbolic resolution
- POST /interpret: Local task interpretation (kept for tooling and tests)
- GET /health: Healthcheck and status
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional
import re
import uvicorn

from vlm_service import vlm_service
from gpt_oss_service import gpt_oss_service
from config import settings

_EXTENSION_ORIGIN_REGEX = r"^(?:chrome-extension://[a-p]{32}|moz-extension://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
_MODEL_ENDPOINTS = {"/vision", "/reason", "/interpret"}

app = FastAPI(
    title="Privacy-Preserving Browser Agent Backend",
    version="1.0.0",
    description="VLM Perception & GPT-OSS 120B Reasoning API"
)

# The legacy backend-driven browser loop is intentionally not mounted. It
# captured raw screenshots and auto-proceeded through high-risk actions, so it
# cannot share the extension's local privacy and confirmation boundary.

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=_EXTENSION_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def require_extension_origin(request, call_next):
    # CORS alone does not reject simple cross-origin requests. Explicitly
    # reject webpage-originated calls to model endpoints as well. Normalize
    # the path so trailing-slash variants cannot slip past the exact match.
    path = request.url.path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    if path in _MODEL_ENDPOINTS:
        origin = request.headers.get("origin", "")
        allowed_extension_origin = re.fullmatch(_EXTENSION_ORIGIN_REGEX, origin)
        if not allowed_extension_origin:
            from starlette.responses import JSONResponse
            return JSONResponse({"detail": "Extension origin required."}, status_code=403)
    return await call_next(request)

class VisionRequest(BaseModel):
    task_id: str
    sanitized_screenshot: str
    sanitized_dom: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)

class ReasonRequest(BaseModel):
    task: str
    task_state: Optional[Dict[str, Any]] = None
    page_state: Optional[Dict[str, Any]] = None
    fused_observation: Dict[str, Any]
    task_history: Optional[List[Dict[str, Any]]] = Field(default_factory=list)

class InterpretRequest(BaseModel):
    task: str


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "PrivAgent-Backend",
        "models": {
            "vlm": settings.VLM_MODEL,
            "reasoning": settings.REASONING_MODEL
        }
    }

@app.post("/vision")
def process_vision(req: VisionRequest):
    try:
        result = vlm_service.process_visuals(
            task_id=req.task_id,
            sanitized_screenshot=req.sanitized_screenshot,
            sanitized_dom=req.sanitized_dom,
            metadata=req.metadata or {}
        )
        return {"status": "success", "visual_observation": result}
    except ValueError as val_err:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(val_err))
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"VLM processing error: {type(e).__name__}")

@app.post("/reason")
def process_reason(req: ReasonRequest):
    try:
        plan = gpt_oss_service.plan_step(
            task=req.task,
            fused_observation=req.fused_observation,
            task_history=req.task_history or [],
            task_state=req.task_state,
            page_state=req.page_state
        )
        return plan
    except ValueError as val_err:
        # Outbound privacy / security rejections are controlled messages,
        # mapped to 400 like the /vision endpoint.
        raise HTTPException(status_code=400, detail=str(val_err))
    except Exception as e:
        import traceback; traceback.print_exc()
        # Log the type only: exception text can carry provider URLs, status
        # codes, or internal details that must not reach clients.
        raise HTTPException(status_code=500, detail=f"Reasoning error: {type(e).__name__}")

@app.post("/interpret")
def process_interpret(req: InterpretRequest):
    try:
        interpretation = gpt_oss_service.interpret_task(req.task)
        return interpretation
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Interpretation error: {type(e).__name__}")

if __name__ == "__main__":
    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
