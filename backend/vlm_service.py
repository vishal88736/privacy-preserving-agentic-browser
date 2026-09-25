"""
Server visual/layout perception.
Uses the sanitized screenshot when a vision model is configured; otherwise
builds a high-signal layout summary from the ENRICHED DOM (cards, prices,
headings) instead of re-labeling inputs only.
"""

import re
import threading
from typing import Dict, Any, List, Optional
import json
import requests
from config import settings


_PROVIDERS = {
    "openrouter": {
        "label": "OpenRouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "keys_setting": "OPENROUTER_API_KEYS",
        "model_setting": "VLM_OPENROUTER_MODEL",
    },
    "huggingface": {
        "label": "Hugging Face",
        "url": "https://router.huggingface.co/v1/chat/completions",
        "keys_setting": "HUGGINGFACE_API_KEYS",
        "model_setting": "VLM_HUGGINGFACE_MODEL",
    },
    "groq": {
        "label": "Groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "keys_setting": "GROQ_API_KEYS",
        "model_setting": "VLM_GROQ_MODEL",
    },
}


class VLMProviderRotator:
    """Round-robin configured VLM credentials, with bounded failover."""

    def __init__(self):
        self._cursor = 0
        self._lock = threading.Lock()

    def ordered_candidates(self) -> List[Dict[str, str]]:
        order = [name.strip().lower() for name in settings.VLM_PROVIDER_ORDER.split(",") if name.strip()]
        profiles: List[Dict[str, str]] = []
        for name in order:
            spec = _PROVIDERS.get(name)
            if not spec:
                continue
            keys = tuple(getattr(settings, spec["keys_setting"], ()) or ())
            model = getattr(settings, spec["model_setting"], "") or settings.VLM_MODEL
            for key in keys:
                profiles.append({
                    "provider": spec["label"],
                    "url": spec["url"],
                    "key": key,
                    "model": model,
                })

        any_supported_keys = any(
            getattr(settings, spec["keys_setting"], ()) for spec in _PROVIDERS.values()
        )
        # Preserve the original single-endpoint configuration (AI_API_KEY,
        # OpenAI-compatible local servers, etc.) if provider keys are absent.
        if not profiles and not any_supported_keys and settings.API_KEY:
            profiles.append({
                "provider": "configured endpoint",
                "url": f"{settings.AI_BASE_URL.rstrip('/')}/chat/completions",
                "key": settings.API_KEY,
                "model": settings.VLM_MODEL,
            })

        if not profiles:
            return []
        with self._lock:
            start = self._cursor % len(profiles)
            self._cursor = (start + 1) % len(profiles)
        rotated = profiles[start:] + profiles[:start]
        attempts = min(len(rotated), max(1, int(settings.VLM_MAX_ATTEMPTS)))
        return rotated[:attempts]


class VLMService:
    def __init__(self):
        self.aadhaar_regex = re.compile(r"\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b")
        self.pan_regex = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b", re.IGNORECASE)
        self.provider_rotator = VLMProviderRotator()

    def process_visuals(self, task_id: str, sanitized_screenshot: str, sanitized_dom: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(sanitized_screenshot, str) or not sanitized_screenshot.startswith("data:image/"):
            raise ValueError("Security rejection: screenshot must be a sanitized image data URL")
        if not isinstance(sanitized_dom, dict) or not isinstance(sanitized_dom.get("elements", []), list):
            raise ValueError("Security rejection: malformed sanitized DOM")
        dom_str = str(sanitized_dom)
        forbidden_patterns = [
            self.aadhaar_regex, self.pan_regex,
            re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
            re.compile(r"(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)"),
            re.compile(r"\b(?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b"),
            re.compile(r"\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b", re.I),
            re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}", re.I),
            re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b", re.I),
        ]
        if any(pattern.search(dom_str) for pattern in forbidden_patterns):
            raise ValueError("Security rejection: outbound DOM contains an unredacted sensitive pattern")
        for match in re.finditer(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", dom_str):
            digits = re.sub(r"[ -]", "", match.group(0))
            if 13 <= len(digits) <= 19 and self._luhn_valid(digits):
                raise ValueError("Security rejection: outbound DOM contains an unredacted card number")

        heuristic = self._from_dom(sanitized_dom, metadata)
        heuristic["grounding_source"] = "dom_heuristic"
        heuristic["provenance"] = "DOM_PLUS_HEURISTIC"
        vision = self._try_real_vlm(sanitized_screenshot, heuristic, metadata)
        if vision:
            heuristic.update(vision)
            heuristic["grounding_source"] = "vision_model"
            heuristic["provenance"] = "DOM_PLUS_REAL_VLM"
        return heuristic

    @staticmethod
    def _luhn_valid(number: str) -> bool:
        total = 0
        parity = len(number) % 2
        for index, char in enumerate(number):
            digit = int(char)
            if index % 2 == parity:
                digit *= 2
                if digit > 9:
                    digit -= 9
            total += digit
        return total % 10 == 0

    def _try_real_vlm(self, screenshot: str, heuristic: Dict[str, Any], metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not settings.API_KEY or not screenshot or not str(screenshot).startswith("data:image"):
            return None
        candidates = self.provider_rotator.ordered_candidates()
        if not candidates:
            return None

        prompt = (
            "Describe the webpage layout in JSON with keys: "
            "spatial_layout (one sentence), visual_state (one sentence), "
            "page_type, notable_visible_text (array of short strings). "
            "Do not transcribe any numbers that look like IDs or secrets. "
            f"Known DOM summary: {heuristic.get('spatial_layout')}"
        )
        for candidate in candidates:
            model = str(candidate["model"] or "").lower()
            text_only_markers = ("gpt-oss", "deepseek-chat", "llama-3.3-70b-versatile", "whisper", "tts-", "embed")
            if any(marker in model for marker in text_only_markers):
                continue

            headers = {
                "Authorization": f"Bearer {candidate['key']}",
                "Content-Type": "application/json",
            }
            payload = {
                "model": candidate["model"],
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": screenshot[:180000]}}
                    ]
                }],
                "max_tokens": 400,
                "temperature": 0,
            }
            try:
                resp = requests.post(
                    candidate["url"],
                    headers=headers,
                    json=payload,
                    timeout=settings.VLM_REQUEST_TIMEOUT_SECONDS,
                )
                if resp.status_code != 200:
                    print(f"[VLM] {candidate['provider']} returned HTTP {resp.status_code}; rotating provider/key")
                    continue

                content = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
                if not isinstance(content, str):
                    continue
                match = re.search(r"\{.*\}", content, re.DOTALL)
                if not match:
                    return {"spatial_layout": content.strip()[:400]} if content else None
                parsed = json.loads(match.group(0))
                out = {}
                if parsed.get("spatial_layout"):
                    out["spatial_layout"] = parsed["spatial_layout"]
                if parsed.get("visual_state"):
                    out["visual_state"] = parsed["visual_state"]
                if parsed.get("page_type"):
                    out["page_type"] = parsed["page_type"]
                if out:
                    return out
            except Exception as exc:
                # Exception messages may include request details. Log only
                # provider and exception type, never tokens or payload text.
                if isinstance(exc, requests.exceptions.Timeout):
                    print(f"[VLM] {candidate['provider']} timed out; using DOM heuristic")
                    # Keep a slow provider from multiplying the wait. The
                    # cursor advances, so the next vision request starts on
                    # the next configured credential/provider.
                    break
                print(f"[VLM] {candidate['provider']} request failed ({type(exc).__name__}); rotating provider/key")
        return None

    def _from_dom(self, sanitized_dom: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
        elements = sanitized_dom.get("elements", [])
        viewport = metadata.get("viewport", sanitized_dom.get("viewport") or {"width": 1280, "height": 800})
        headings = sanitized_dom.get("headings") or []
        result_items = sanitized_dom.get("result_items") or []

        detected_elements: List[Dict[str, Any]] = []
        for idx, el in enumerate(elements):
            tag = el.get("tag", "div")
            role = el.get("role") or tag
            label = el.get("label") or el.get("placeholder") or el.get("name") or f"Element {idx+1}"
            bbox = el.get("bbox", [0, 0, 100, 30])
            is_sensitive = el.get("sensitive", False)
            semantic_type = el.get("semantic_type", "")
            context = (el.get("context") or "")[:120]
            description = (
                f"Masked sensitive {semantic_type} field"
                if is_sensitive
                else f"Interactive {tag} '{label}'" + (f" context: {context}" if context else "")
            )
            detected_elements.append({
                "visual_id": f"vis_{idx + 1}",
                "role": role,
                "label": label,
                "bbox": bbox,
                # DOM-echo heuristic, not a vision detection: keep confidence
                # modest so fusion never mistakes it for visual proof.
                "confidence": 0.6,
                "visual_description": description
            })

        buttons = [e for e in elements if e.get("tag") == "button" or e.get("type") == "submit" or e.get("role") == "button"]
        inputs = [e for e in elements if e.get("tag") in ("input", "textarea", "select")]
        sensitive_inputs = [e for e in inputs if e.get("sensitive")]
        priced = [it for it in result_items if it.get("price_value") is not None]

        title_lower = str(metadata.get("title") or sanitized_dom.get("title") or "").lower()
        url_lower = str(metadata.get("url") or sanitized_dom.get("url") or "").lower()

        page_type = "unknown"
        if result_items:
            page_type = "search_results"
        elif "login" in title_lower or "sign in" in title_lower or "login" in url_lower:
            page_type = "login"
        elif "register" in title_lower or "sign up" in title_lower:
            page_type = "registration"
        elif "search" in title_lower or "find" in title_lower:
            page_type = "search"
        elif any(kw in title_lower for kw in ["form", "apply", "application", "onboard"]):
            page_type = "application_form"
        elif "upload" in title_lower or "document" in title_lower:
            page_type = "document_upload"
        elif len(inputs) > 3:
            page_type = "application_form"
        elif len(inputs) == 0 and len(buttons) > 0:
            page_type = "dashboard"

        heading_txt = "; ".join(h.get("text", "") for h in headings[:6] if isinstance(h, dict))
        card_txt = "; ".join(
            f"{it.get('title','item')} {it.get('price_text') or ''}".strip()
            for it in result_items[:8]
        )
        spatial_layout = (
            f"Viewport {viewport.get('width', 1280)}x{viewport.get('height', 800)}. "
            f"{len(inputs)} inputs ({len(sensitive_inputs)} masked), {len(buttons)} buttons, "
            f"{len(result_items)} result cards ({len(priced)} with prices)."
        )
        if heading_txt:
            spatial_layout += f" Headings: {heading_txt}."
        if card_txt:
            spatial_layout += f" Cards: {card_txt}."

        visual_state = (
            f"Visible result cards={len(result_items)}. "
            f"Priced items={len(priced)}. Sensitive blackouts={len(sensitive_inputs)}."
        )

        return {
            "page_type": page_type,
            "page_purpose": f"Likely a {page_type.replace('_', ' ')} page.",
            "detected_elements": detected_elements,
            "spatial_layout": spatial_layout,
            "visual_state": visual_state
        }


vlm_service = VLMService()
