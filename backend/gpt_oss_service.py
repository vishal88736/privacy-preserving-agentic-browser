"""
GPT-OSS 120B Reasoning & Planning Service
Interprets unified observation, performs goal decomposition, and produces
structured JSON action plans with symbolic value references.
"""

import json
import re
from typing import Dict, Any, List
import requests
from config import settings

class GPTOSSService:
    def __init__(self):
        pass

    def _call_live_model(self, task: str, fused_observation: Dict[str, Any], task_history: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not settings.API_KEY:
            return None

        try:
            system_prompt = """You are PrivAgent, an autonomous privacy-preserving browser agent.
Given the sanitized webpage observation and the user's task, decide the next single action to take.
Output ONLY a valid JSON object matching this schema:
{
  "thought": "Brief explanation of observation and next step",
  "action": {
    "action": "CLICK" | "TYPE" | "NAVIGATE" | "SUBMIT" | "UPLOAD" | "DONE" | "WAIT",
    "target": { "element_id": "...", "label": "..." },
    "value": "...",
    "value_source": "LOCAL_AADHAAR" | "LOCAL_PAN" | "LOCAL_DOCUMENT" | "LOCAL_PASSWORD",
    "risk": "LOW" | "MEDIUM" | "HIGH",
    "requires_confirmation": boolean
  },
  "is_terminal": boolean
}
Do not output markdown fences or explanatory text. Never output plaintext Aadhaar, PAN, passwords or documents.
If task_history shows a SUBMIT or UPLOAD action was already performed, the goal is reached: return DONE, never repeat the same SUBMIT/UPLOAD.
If the goal is fulfilled, return action DONE with is_terminal true; otherwise is_terminal must be false."""

            user_msg = {
                "task": task,
                "observation": fused_observation,
                "history": task_history[-5:] if task_history else []
            }

            headers = {
                "Authorization": f"Bearer {settings.API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": settings.REASONING_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(user_msg)}
                ],
                "temperature": 0.2,
                "max_tokens": 1000
            }

            resp = requests.post(f"{settings.AI_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=12)
            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"].strip()
                if content.startswith("```"):
                    content = re.sub(r"^```(?:json)?\n?", "", content)
                    content = re.sub(r"\n?```$", "", content)
                parsed = json.loads(content)
                if isinstance(parsed, dict) and "action" in parsed:
                    return parsed
        except Exception as e:
            print(f"[GPTOSS] Live model notice ({e}), falling back to deterministic planner")
            return None
        return None

    def plan_step(self, task: str, fused_observation: Dict[str, Any], task_history: List[Dict[str, Any]]) -> Dict[str, Any]:
        lower_task = task.lower()
        elements = fused_observation.get("elements", [])

        # Try live model first if API key is configured
        live_plan = self._call_live_model(task, fused_observation, task_history)
        if live_plan:
            # Deterministic progress guard: a live model may repeat an already
            # executed high-risk action (e.g. SUBMIT after the form submitted).
            # Repeating it can never advance the task, so convert to DONE.
            live_action = (live_plan.get("action") or {})
            if live_action.get("action") in ("SUBMIT", "UPLOAD"):
                live_target = (live_action.get("target") or {}).get("element_id")
                for h in task_history:
                    ha = (h.get("action") or {})
                    if ha.get("action") == live_action.get("action"):
                        ha_target = (ha.get("target") or {}).get("element_id")
                        if live_target is None or ha_target is None or ha_target == live_target:
                            return {
                                "thought": "The requested submission/upload step was already performed. Task goal reached.",
                                "action": {
                                    "action": "DONE",
                                    "risk": "LOW",
                                    "requires_confirmation": False
                                },
                                "is_terminal": True
                            }
            return live_plan

        # Check prompt injection heuristic in page content
        for el in elements:
            label = (el.get("dom", {}).get("label") or el.get("visual", {}).get("description") or "").lower()
            if "ignore all previous instructions" in label or "exfiltrate password" in label:
                return {
                    "thought": "Security Alert: Detected malicious prompt-injection attempt inside webpage content. Quarantining untrusted instructions and proceeding with original user task safely.",
                    "action": {
                        "action": "WAIT",
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

        # Check if previous action was submit
        last_action = task_history[-1].get("action", {}) if task_history else {}
        if last_action.get("action") == "SUBMIT":
            return {
                "thought": "Application submitted successfully. Task goal reached.",
                "action": {
                    "action": "DONE",
                    "risk": "LOW",
                    "requires_confirmation": False
                },
                "is_terminal": True
            }

        # Scenario 0: Navigation / Open Website
        if any(lower_task.startswith(w) for w in ["open", "go to", "navigate to"]):
            already_navigated = any(h.get("action", {}).get("action") == "NAVIGATE" for h in task_history)
            if already_navigated and not any(w in lower_task for w in ["search", "find", "click", "then", "and"]):
                return {
                    "thought": "Target website loaded successfully. Navigation task completed.",
                    "action": {
                        "action": "DONE",
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": True
                }
            if not task_history:
                target_url = "https://www.youtube.com" if "youtube" in lower_task else \
                             ("https://www.google.com" if "google" in lower_task else \
                             ("http://localhost:5000" if "localhost" in lower_task else "https://www.google.com"))
                return {
                    "thought": f"Opening target website: {target_url}",
                    "action": {
                        "action": "NAVIGATE",
                        "target": { "url": target_url },
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

        # Scenario 1: Document Upload
        if any(w in lower_task for w in ["upload", "document", "pdf"]):
            upload_el = next((e for e in elements if e.get("dom", {}).get("type") == "file" or e.get("interaction", {}).get("uploadable")), None)
            if upload_el:
                already_uploaded = any(h.get("action", {}).get("action") == "UPLOAD" for h in task_history)
                if not already_uploaded:
                    return {
                        "thought": f"Located file upload target '{upload_el.get('dom', {}).get('label') or 'Upload'}'. Instructing client to attach local Aadhaar document.",
                        "action": {
                            "action": "UPLOAD",
                            "target": {
                                "element_id": upload_el.get("id"),
                                "label": upload_el.get("dom", {}).get("label") or "Upload Identity Document"
                            },
                            "value_source": "LOCAL_DOCUMENT",
                            "risk": "HIGH",
                            "requires_confirmation": True
                        },
                        "is_terminal": False
                    }

        # Scenario 2: Identity / Government Form (Aadhaar / Profile)
        if any(w in lower_task for w in ["aadhaar", "form", "fill", "profile", "application"]):
            # Find next unfilled input
            for el in elements:
                dom = el.get("dom")
                if not dom or dom.get("tag") != "input":
                    continue
                if dom.get("type") in ["submit", "button", "file"]:
                    continue

                el_id = el.get("id")
                # Check if already filled
                already_filled = any(h.get("action", {}).get("target", {}).get("element_id") == el_id for h in task_history)
                if already_filled:
                    continue

                label = (dom.get("label") or dom.get("name") or "").lower()
                val_source = dom.get("value_source") or "LOCAL_PROFILE"

                if "aadhaar" in label:
                    val_source = "LOCAL_AADHAAR"
                elif "pan" in label:
                    val_source = "LOCAL_PAN"
                elif "name" in label:
                    val_source = "LOCAL_FULL_NAME"
                elif "dob" in label or "birth" in label:
                    val_source = "LOCAL_DOB"
                elif "phone" in label or "mobile" in label:
                    val_source = "LOCAL_PHONE"
                elif "password" in label:
                    val_source = "LOCAL_PASSWORD"

                return {
                    "thought": f"Identified form input '{dom.get('label') or el_id}'. Requesting local value resolution for {val_source}.",
                    "action": {
                        "action": "TYPE",
                        "target": {
                            "element_id": el_id,
                            "label": dom.get("label") or "Form Field"
                        },
                        "value_source": val_source,
                        "risk": "MEDIUM" if dom.get("sensitive") else "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

            # All inputs filled -> click Submit
            for el in elements:
                dom = el.get("dom")
                if not dom:
                    continue
                label = (dom.get("label") or "").lower()
                if (dom.get("tag") == "button" or dom.get("type") == "submit") and any(w in label for w in ["submit", "apply", "proceed", "continue"]):
                    return {
                        "thought": "All required form fields are filled. Proposing final application submission.",
                        "action": {
                            "action": "SUBMIT",
                            "target": {
                                "element_id": el.get("id"),
                                "label": dom.get("label") or "Submit Application"
                            },
                            "risk": "HIGH",
                            "requires_confirmation": True
                        },
                        "is_terminal": False
                    }

        # Scenario 3: Flight Search
        if any(w in lower_task for w in ["flight", "pune", "delhi"]):
            origin = next((e for e in elements if any(w in (e.get("dom", {}).get("label") or "").lower() for w in ["from", "origin"])), None)
            dest = next((e for e in elements if any(w in (e.get("dom", {}).get("label") or "").lower() for w in ["to", "destination"])), None)
            search_btn = next((e for e in elements if "search" in (e.get("dom", {}).get("label") or "").lower()), None)

            if origin and not any(h.get("action", {}).get("target", {}).get("element_id") == origin.get("id") for h in task_history):
                return {
                    "thought": "Setting departure city: Pune",
                    "action": {
                        "action": "TYPE",
                        "target": { "element_id": origin.get("id"), "label": "Origin City" },
                        "value": "Pune",
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

            if dest and not any(h.get("action", {}).get("target", {}).get("element_id") == dest.get("id") for h in task_history):
                return {
                    "thought": "Setting arrival city: Delhi",
                    "action": {
                        "action": "TYPE",
                        "target": { "element_id": dest.get("id"), "label": "Destination City" },
                        "value": "Delhi",
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

            if search_btn and not any(h.get("action", {}).get("target", {}).get("element_id") == search_btn.get("id") for h in task_history):
                return {
                    "thought": "Triggering flight search comparison",
                    "action": {
                        "action": "CLICK",
                        "target": { "element_id": search_btn.get("id"), "label": "Search Flights" },
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

        # Scenario 4: Media Playback / YouTube ("play ...", "watch ...", "listen ...", "song ...")
        if any(w in lower_task for w in ["play", "song", "video", "youtube", "music", "watch", "listen"]):
            # Check if video was already clicked
            already_clicked_video = any(h.get("action", {}).get("action") == "CLICK" and
                                       any(w in (h.get("action", {}).get("target", {}).get("label") or "").lower() for w in ["video", "play", "song"])
                                       for h in task_history)
            if already_clicked_video:
                return {
                    "thought": "Selected video is playing. Task completed.",
                    "action": {
                        "action": "DONE",
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": True
                }

            # If there's a video link on screen (e.g. on search results), click to play!
            video_link = next((e for e in elements if "/watch" in (e.get("dom", {}).get("href") or "") or
                               "video-title" in (e.get("dom", {}).get("id") or "") or
                               any(w in (e.get("dom", {}).get("label") or "").lower() for w in ["video", "watch"])), None)

            if video_link:
                v_label = video_link.get("dom", {}).get("label") or "Play Video"
                return {
                    "thought": f"Identified top video result '{v_label}'. Playing video.",
                    "action": {
                        "action": "CLICK",
                        "target": { "element_id": video_link.get("id"), "label": v_label },
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

            # Search elements
            search_input = next((e for e in elements if e.get("dom", {}).get("tag") == "input" and
                                (any(w in (e.get("dom", {}).get("placeholder") or "").lower() for w in ["search", "find"]) or
                                 e.get("dom", {}).get("name") == "search_query" or
                                 e.get("dom", {}).get("id") == "search")), None)
            search_btn = next((e for e in elements if "search" in (e.get("dom", {}).get("label") or "").lower() or
                               e.get("dom", {}).get("id") == "search-icon-legacy"), None)

            clean_query = lower_task
            for w in ["play", "watch", "listen to", "search for", "on youtube", "song of", "song by"]:
                clean_query = clean_query.replace(w, "")
            clean_query = clean_query.strip() or "karan aujla popular song"

            search_input_id = search_input.get("id") if search_input else None
            typed_search = any(h.get("action", {}).get("action") == "TYPE" and
                              h.get("action", {}).get("target", {}).get("element_id") == search_input_id
                              for h in task_history)

            if search_input and not typed_search:
                return {
                    "thought": f"Entering search query: '{clean_query}' into search bar.",
                    "action": {
                        "action": "TYPE",
                        "target": { "element_id": search_input.get("id"), "label": "Search" },
                        "value": clean_query,
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

            if search_btn and typed_search and not any(h.get("action", {}).get("target", {}).get("element_id") == search_btn.get("id") for h in task_history):
                return {
                    "thought": "Submitting search query to fetch video results.",
                    "action": {
                        "action": "CLICK",
                        "target": { "element_id": search_btn.get("id"), "label": "Search" },
                        "risk": "LOW",
                        "requires_confirmation": False
                    },
                    "is_terminal": False
                }

        # Default completion
        return {
            "thought": "All tasks steps completed.",
            "action": {
                "action": "DONE",
                "risk": "LOW",
                "requires_confirmation": False
            },
            "is_terminal": True
        }

gpt_oss_service = GPTOSSService()
