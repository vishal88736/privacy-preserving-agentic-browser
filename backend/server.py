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
import hmac
import logging
import threading
import time
import uvicorn
from starlette.responses import JSONResponse

from vlm_service import vlm_service
from gpt_oss_service import gpt_oss_service
from config import settings
import logging_config
from privacy_rules import OutboundPrivacyError

logger = logging.getLogger(__name__)

_EXTENSION_ORIGIN_REGEX = r"^(?:chrome-extension://[a-p]{32}|moz-extension://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
_MODEL_ENDPOINTS = {"/vision", "/reason", "/interpret"}
_MAX_REQUEST_BYTES = 5 * 1024 * 1024
_BUCKET_CAPACITY = 60.0
_BUCKET_REFILL_PER_SECOND = 1.5
_rate_buckets = {}
_rate_lock = threading.Lock()

app = FastAPI(
    title="Privacy-Preserving Browser Agent Backend",
    version="1.0.0",
    description="VLM Perception & GPT-OSS 120B Reasoning API"
)

# The legacy backend-driven browser loop is intentionally not mounted. It
# captured raw screenshots and auto-proceeded through high-risk actions, so it
# cannot share the extension's local privacy and confirmation boundary.

def _security_response(scope, receive, send, status_code, detail):
    return JSONResponse({"detail": detail}, status_code=status_code)(scope, receive, send)


def _client_label(scope):
    """Peer address for a rejection record, or 'unknown'.

    Only used so repeated rejections from one local process are attributable.
    """
    try:
        return (scope.get("client") or ("unknown", 0))[0]
    except Exception:
        return "unknown"


class RequestGuardMiddleware:
    """Authenticate model calls and cap request bytes before JSON parsing."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        if len(path) > 1 and path.endswith("/"):
            path = path.rstrip("/")
        method = scope.get("method", "GET").upper()
        if path not in _MODEL_ENDPOINTS or method == "OPTIONS":
            return await self.app(scope, receive, send)

        headers = {key.decode("latin1").lower(): value.decode("latin1") for key, value in scope.get("headers", [])}
        origin = headers.get("origin", "")
        if not re.fullmatch(_EXTENSION_ORIGIN_REGEX, origin):
            logger.warning(
                "Rejected %s %s: Origin header is not a valid extension origin.",
                method, path, extra={"privagent_client": _client_label(scope)},
            )
            return await _security_response(scope, receive, send, 403, "Extension origin required.")
        if settings.EXTENSION_ORIGINS and origin not in settings.EXTENSION_ORIGINS:
            logger.warning(
                "Rejected %s %s: origin is not in the configured allowlist.",
                method, path, extra={"privagent_client": _client_label(scope), "privagent_origin": origin},
            )
            return await _security_response(scope, receive, send, 403, "This extension origin is not allowed.")

        configured_secret = settings.BACKEND_SHARED_SECRET
        if len(configured_secret) < 32:
            logger.error(
                "Cannot serve %s %s: BACKEND_SHARED_SECRET is unset or shorter than 32 characters.",
                method, path,
            )
            return await _security_response(scope, receive, send, 503, "Backend shared secret is not configured.")
        supplied_secret = headers.get("x-privagent-token", "")
        if not supplied_secret or not hmac.compare_digest(supplied_secret, configured_secret):
            # Never log the presented token, not even truncated: it is a
            # credential and this file is meant to be attachable to a report.
            # Distinguish "header absent" from "wrong value" and report the
            # presented length: an empty header means the extension never
            # stored a token, a full-length mismatch means the secret changed
            # after it was saved. Both look identical as a bare 401 otherwise,
            # and that ambiguity costs a debugging round every time.
            logger.warning(
                "Rejected %s %s: %s (presented length %d, expected %d).",
                method, path,
                "no backend access token presented" if not supplied_secret
                else "backend access token does not match BACKEND_SHARED_SECRET",
                len(supplied_secret), len(configured_secret),
                extra={"privagent_client": _client_label(scope)},
            )
            return await _security_response(scope, receive, send, 401, "Backend access token is invalid.")

        client = scope.get("client") or ("unknown", 0)
        now = time.monotonic()
        rate_limited = False
        with _rate_lock:
            tokens, last_time = _rate_buckets.get(client[0], (_BUCKET_CAPACITY, now))
            tokens = min(_BUCKET_CAPACITY, tokens + max(0.0, now - last_time) * _BUCKET_REFILL_PER_SECOND)
            if tokens < 1.0:
                _rate_buckets[client[0]] = (tokens, now)
                rate_limited = True
            else:
                _rate_buckets[client[0]] = (tokens - 1.0, now)
            if len(_rate_buckets) > 256:
                stale_before = now - 300
                for key, (_, timestamp) in list(_rate_buckets.items()):
                    if timestamp < stale_before:
                        _rate_buckets.pop(key, None)
        if rate_limited:
            logger.warning(
                "Rate limited %s %s.", method, path,
                extra={"privagent_client": _client_label(scope), "endpoint": path},
            )
            return await _security_response(scope, receive, send, 429, "Too many model requests. Try again shortly.")

        if method in {"POST", "PUT", "PATCH"}:
            try:
                content_length = int(headers.get("content-length", "0"))
            except ValueError:
                logger.warning("Rejected %s %s: unparseable Content-Length.", method, path,
                               extra={"privagent_client": _client_label(scope)})
                return await _security_response(scope, receive, send, 400, "Invalid Content-Length header.")
            if content_length > _MAX_REQUEST_BYTES:
                logger.warning(
                    "Rejected %s %s: Content-Length %s exceeds the %s byte cap.",
                    method, path, content_length, _MAX_REQUEST_BYTES,
                    extra={"privagent_client": _client_label(scope), "content_length": content_length},
                )
                return await _security_response(scope, receive, send, 413, "Request body is too large.")

            body_parts = []
            body_size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                if message["type"] != "http.request":
                    continue
                part = message.get("body", b"")
                body_size += len(part)
                if body_size > _MAX_REQUEST_BYTES:
                    logger.warning(
                        "Rejected %s %s: streamed body exceeded the %s byte cap.",
                        method, path, _MAX_REQUEST_BYTES,
                        extra={"privagent_client": _client_label(scope)},
                    )
                    return await _security_response(scope, receive, send, 413, "Request body is too large.")
                body_parts.append(part)
                if not message.get("more_body", False):
                    break

            body = b"".join(body_parts)
            delivered = False

            async def replay_body():
                nonlocal delivered
                if delivered:
                    return {"type": "http.request", "body": b"", "more_body": False}
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}

            return await self.app(scope, replay_body, send)

        return await self.app(scope, receive, send)


# Middleware execution order:
# In Starlette / FastAPI, middleware added later executes first (LIFO order).
# 1. CORSMiddleware (added second) executes FIRST, handling CORS preflight (OPTIONS)
#    requests without requiring extension auth headers.
# 2. RequestGuardMiddleware (added first) executes SECOND, enforcing loopback origin,
#    secret token auth, rate limits, and request body size caps.
app.add_middleware(RequestGuardMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=_EXTENSION_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VisionRequest(BaseModel):
    task_id: str = Field(min_length=1, max_length=128)
    sanitized_screenshot: str = Field(min_length=1, max_length=1_600_000)
    sanitized_dom: Dict[str, Any] = Field(max_length=128)
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, max_length=64)

class ReasonRequest(BaseModel):
    task: str = Field(min_length=1, max_length=3500)
    task_state: Optional[Dict[str, Any]] = Field(default=None, max_length=64)
    page_state: Optional[Dict[str, Any]] = Field(default=None, max_length=64)
    fused_observation: Dict[str, Any] = Field(max_length=128)
    task_history: Optional[List[Dict[str, Any]]] = Field(default_factory=list, max_length=50)
    # Names of the identity documents the user stored in their local vault.
    # Tokens only, never file names or bytes: the planner is told what it may
    # reference, and this list is the whole vocabulary for an UPLOAD action.
    stored_documents: Optional[List[str]] = Field(default_factory=list, max_length=32)

class InterpretRequest(BaseModel):
    task: str = Field(min_length=1, max_length=3500)


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
        # A ValueError here is a controlled privacy/security rejection, not a
        # defect: the full traceback would be noise on every rejected payload.
        logger.info("Vision request rejected by the boundary gate: %s", val_err)
        raise HTTPException(status_code=400, detail=str(val_err))
    except Exception as e:
        # exc_info records the traceback in the log file. The response body
        # still carries only the exception type, because the text can name
        # provider URLs and upstream bodies.
        logger.exception("VLM processing error (%s)", type(e).__name__, extra={"task_id": req.task_id})
        raise HTTPException(status_code=500, detail=f"VLM processing error: {type(e).__name__}")

@app.post("/reason")
def process_reason(req: ReasonRequest):
    try:
        plan = gpt_oss_service.plan_step(
            task=req.task,
            fused_observation=req.fused_observation,
            task_history=req.task_history or [],
            task_state=req.task_state,
            page_state=req.page_state,
            stored_documents=req.stored_documents or []
        )
        return plan
    except OutboundPrivacyError as val_err:
        # The client can distinguish a boundary rejection from an unavailable
        # backend and show an accurate privacy message.
        logger.info("Reasoning request rejected by the boundary gate: %s", val_err)
        raise HTTPException(status_code=400, detail={
            "code": "OUTBOUND_PRIVACY_BLOCK",
            "message": "The request contained a sensitive value that was not sanitized locally."
        })
    except Exception as e:
        # Log the type only: exception text can carry provider URLs, status
        # codes, or internal details that must not reach clients.
        logger.exception("Reasoning error (%s)", type(e).__name__)
        raise HTTPException(status_code=500, detail=f"Reasoning error: {type(e).__name__}")

@app.post("/interpret")
def process_interpret(req: InterpretRequest):
    try:
        interpretation = gpt_oss_service.interpret_task(req.task)
        return interpretation
    except Exception as e:
        logger.exception("Interpretation error (%s)", type(e).__name__)
        raise HTTPException(status_code=500, detail=f"Interpretation error: {type(e).__name__}")

if __name__ == "__main__":
    logger.info(
        "Starting PrivAgent backend on %s:%s (vlm=%s, reasoning=%s); log file %s",
        settings.HOST, settings.PORT, settings.VLM_MODEL, settings.REASONING_MODEL,
        logging_config.log_file_path(),
    )
    # log_config routes uvicorn's startup banner and access log into the same
    # JSONL file; without it uvicorn reinstalls its own handlers and the access
    # log never reaches the file.
    uvicorn.run(
        app,
        host=settings.HOST,
        port=settings.PORT,
        log_config=logging_config.uvicorn_log_config(),
    )
