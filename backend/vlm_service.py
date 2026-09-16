"""
Server visual/layout perception.
Uses the sanitized screenshot when a vision model is configured; otherwise
builds a high-signal layout summary from the ENRICHED DOM (cards, prices,
headings) instead of re-labeling inputs only.
"""

import re
from typing import Dict, Any, List, Optional
import json
import requests
from config import settings


class VLMService:
    def __init__(self):
        self.aadhaar_regex = re.compile(r"\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b")
        self.pan_regex = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b")

    def process_visuals(self, task_id: str, sanitized_screenshot: str, sanitized_dom: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
        dom_str = str(sanitized_dom)
        if self.aadhaar_regex.search(dom_str):
            raise ValueError("Security rejection: Outgoing payload contains unmasked Aadhaar number")
        if self.pan_regex.search(dom_str):
            raise ValueError("Security rejection: Outgoing payload contains unmasked PAN number")

        heuristic = self._from_dom(sanitized_dom, metadata)
        vision = self._try_real_vlm(sanitized_screenshot, heuristic, metadata)
        if vision:
            heuristic.update(vision)
        return heuristic

    def _try_real_vlm(self, screenshot: str, heuristic: Dict[str, Any], metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not settings.API_KEY or not screenshot or not str(screenshot).startswith("data:image"):
            return None
        # Only call a vision-capable endpoint when the configured model looks like a VLM.
        model = (settings.VLM_MODEL or "").lower()
        if not any(k in model for k in ("vl", "vision", "gpt-4o", "gemini", "grok")):
            return None
        try:
            headers = {
                "Authorization": f"Bearer {settings.API_KEY}",
                "Content-Type": "application/json"
            }
            prompt = (
                "Describe the webpage layout in JSON with keys: "
                "spatial_layout (one sentence), visual_state (one sentence), "
                "page_type, notable_visible_text (array of short strings). "
                "Do not transcribe any numbers that look like IDs or secrets. "
                f"Known DOM summary: {heuristic.get('spatial_layout')}"
            )
            payload = {
                "model": settings.VLM_MODEL,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": screenshot[:180000]}}
                    ]
                }],
                "max_tokens": 400,
                "temperature": 0
            }
            resp = requests.post(f"{settings.AI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=12)
            if resp.status_code != 200:
                return None
            content = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content") or ""
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
            return out
        except Exception as e:
            print(f"[VLM] optional vision call skipped: {e}")
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
                "confidence": 0.96,
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
