"""
Privacy-Preserving Agentic Backend Server
Exposes strict endpoints:
- POST /vision: Server VLM perception for layout and visual hierarchy
- POST /reason: GPT-OSS 120B reasoning and action planning with symbolic resolution
- GET /health: Healthcheck and status
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional
import uvicorn

from vlm_service import vlm_service
from gpt_oss_service import gpt_oss_service
from config import settings

app = FastAPI(
    title="Privacy-Preserving Browser Agent Backend",
    version="1.0.0",
    description="VLM Perception & GPT-OSS 120B Reasoning API"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    timestamp: Optional[int] = None

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
        raise HTTPException(status_code=500, detail=f"VLM processing error: {str(e)}")

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
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Reasoning error: {str(e)}")

@app.post("/interpret")
def process_interpret(req: InterpretRequest):
    try:
        interpretation = gpt_oss_service.interpret_task(req.task)
        return interpretation
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Interpretation error: {str(e)}")

if __name__ == "__main__":
    uvicorn.run(app, host=settings.HOST, port=settings.PORT)
