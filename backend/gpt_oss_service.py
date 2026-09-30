import json
import logging
import re
from urllib.parse import urlsplit
from typing import Dict, Any, List, Optional
import requests
from config import settings
from privacy_rules import OutboundPrivacyError, find_sensitive_category
from vlm_service import looks_like_provider_error
from agentic.orchestrator import compose_reasoning_messages
from agentic.context import build_page_evidence

logger = logging.getLogger(__name__)
_SAFE_ACTION_TYPES = {
    "CLICK", "TYPE", "SELECT", "CHECK", "UNCHECK", "HOVER", "SUBMIT", "UPLOAD", "NAVIGATE", "SCROLL",
    "WAIT", "DONE", "ASK_USER", "PRESS_KEY", "GO_BACK", "GO_FORWARD",
    "EXTRACT", "OPEN_TAB", "SWITCH_TAB", "FILL_FORM_PLAN"
}


def _log_safe_plan_shape(parsed: dict) -> None:
    action = parsed.get("action") if isinstance(parsed, dict) else None
    action_type = action.get("action") if isinstance(action, dict) else None
    if action_type not in _SAFE_ACTION_TYPES:
        action_type = "OTHER"
    logger.info("plan_step resolved an action type", extra={"action_type": action_type})


# Reasoning models (gpt-oss on Bedrock, and Groq's gpt-oss family) return the
# chain-of-thought and the answer in the SAME `content` field, wrapped in
# <think>/<reasoning> tags, with the JSON after it. Parsing that as bare JSON
# always failed with "Model returned invalid schema", which is exactly what the
# logs recorded on every attempt.
_THINK_TAGS = ("reasoning", "think")


def _strip_reasoning(content: str) -> str:
    """Return only the answer portion of a reasoning model's content.

    Handles the two shapes seen in practice:
      * tagged   — ``<reasoning>...</reasoning>{...}``
      * untagged  — ``Thought: ...\n{...}`` with no closing tag

    The answer is whatever follows the last closing tag, or — when no tag
    closed — the first ``{``. A response that is already pure JSON passes
    through unchanged.
    """
    if not isinstance(content, str):
        return ""
    text = content
    for tag in _THINK_TAGS:
        closing = re.search(rf"</{tag}\s*>", text, re.I)
        if closing:
            return _tidy_answer(text[closing.end():])
        opening = re.search(rf"<{tag}\s*>", text, re.I)
        if opening:
            # An unterminated block means the model never finished its answer.
            # Only trust it when the answer starts immediately; otherwise return
            # nothing so the caller reports a clean parse failure. Scanning the
            # rest of the reasoning prose instead would find whatever JSON
            # snippet the model quoted while thinking and treat it as a plan.
            tail = text[opening.end():].lstrip()
            return tail if tail.startswith("{") else ""
    return _tidy_answer(text)


def _tidy_answer(answer: str) -> str:
    """Normalize the answer tail: drop code fences and any prose lead-in.

    Safe to run only once the reasoning trace is already removed, so scanning
    forward to the first ``{`` cannot pick up a JSON snippet the model quoted
    while thinking. Intermittently the model wraps the object in ```json
    fences or prefixes it with "Here is the JSON:", which previously surfaced
    as "Model returned invalid schema".
    """
    text = answer.strip()
    fence = re.match(r"^```(?:json)?\s*", text, re.I)
    if fence:
        text = text[fence.end():]
        closing_fence = re.search(r"```\s*$", text)
        if closing_fence:
            text = text[:closing_fence.start()]
    text = text.strip()
    if not text.startswith("{") and "{" in text:
        text = text[text.index("{"):]
    return text


def _extract_json(content: str) -> dict:
    # Fast path first: most well-behaved providers return a bare JSON object.
    if not isinstance(content, str) or not content.strip():
        raise Exception("No JSON object found in response")
    stripped = _strip_reasoning(content)
    if stripped and stripped != content.strip():
        content = stripped
    text = content.strip()
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    # Balanced scan: parse the first well-formed {...} block. A greedy
    # first-{-to-last-} span would wrap prose between braces into an invalid
    # object whose parse failure gets misreported as a provider error and
    # triggers a needless (slow) provider rotation.
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start != -1:
        try:
            parsed, _ = decoder.raw_decode(text[start:])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        start = text.find("{", start + 1)
    raise Exception("No JSON object found in response")


def _try_parse_plan(content: str) -> Optional[Dict[str, Any]]:
    """Parse a model reply into a plan, or None when it is not one.

    Deliberately returns None instead of raising: a non-plan body is a
    recoverable condition (one repair retry), not an exception, and letting it
    raise here would skip the retry and end the task.
    """
    try:
        parsed = _extract_json(content)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) and "action" in parsed else None


def _repair_retry(headers: Dict[str, str], payload: Dict[str, Any], user_content: str) -> str:
    """Re-ask once, demanding a bare JSON object and nothing else.

    Capped at a single attempt: a second failure is a real provider problem,
    and retrying further would only add latency to an already-failing task.
    """
    repair = dict(payload)
    repair["messages"] = compose_reasoning_messages(user_content) + [{
        "role": "user",
        "content": (
            "Your previous reply could not be parsed. Reply with ONLY the JSON "
            "object required by the output schema: no reasoning tags, no prose, "
            "no markdown fences. The object must contain an \"action\" object."
        ),
    }]
    repair["temperature"] = 0.0
    resp = requests.post(
        f"{settings.AI_BASE_URL}/chat/completions",
        headers=headers,
        json=repair,
        timeout=settings.REASONING_REQUEST_TIMEOUT_SECONDS,
    )
    if resp.status_code != 200:
        raise Exception(f"Model API error: {resp.status_code}")
    choices = resp.json().get("choices") or []
    content = (choices[0].get("message") or {}).get("content") if choices else None
    if not isinstance(content, str) or not content.strip():
        raise Exception("Empty response from reasoning model")
    return content


def _allowed_ids(fused_observation: Dict[str, Any], page_state: Optional[Dict[str, Any]]) -> set:
    # The current observation is the authority for executable targets. Page
    # state is a derived summary and can lag a re-render; accepting IDs from
    # it would turn a stale reference into an executable target.
    ids = set()
    for el in (fused_observation or {}).get("elements", []) or []:
        if isinstance(el, dict) and el.get("id"):
            ids.add(el["id"])
        if isinstance(el, dict) and el.get("element_id"):
            ids.add(el["element_id"])
    return {i for i in ids if i}


def _option_texts(fused_observation: Optional[Dict[str, Any]], element_id: Optional[str]) -> List[str]:
    """Collect option text/value strings for a select element from the observation."""
    texts: List[str] = []
    if not element_id:
        return texts
    for el in (fused_observation or {}).get("elements", []) or []:
        if not isinstance(el, dict):
            continue
        if el.get("id") != element_id and el.get("element_id") != element_id:
            continue
        dom = el.get("dom") if isinstance(el.get("dom"), dict) else el
        options = dom.get("options")
        if not isinstance(options, list):
            continue
        for opt in options:
            if isinstance(opt, dict):
                for key in ("text", "label", "value"):
                    if isinstance(opt.get(key), str) and opt[key].strip():
                        texts.append(opt[key].strip().lower())
            elif isinstance(opt, str) and opt.strip():
                texts.append(opt.strip().lower())
    return texts


def _value_matches_option(value: str, options: List[str]) -> bool:
    """Fuzzy match a proposed select value against known option texts."""
    if not options:
        return True  # options unknown: cannot judge, do not block
    normalized = re.sub(r"\s+", " ", re.sub(r"[._\-]+", " ", value.strip().lower())).strip()
    for option in options:
        if normalized == option or normalized in option or option in normalized:
            return True
    return False


def _repair_action(parsed: dict, allowed: set, page_state: Optional[Dict[str, Any]], fused_observation: Optional[Dict[str, Any]] = None, stored_documents: Optional[List[str]] = None) -> dict:
    act = parsed.get("action") or {}
    if not isinstance(act, dict):
        _log_safe_plan_shape(parsed)
        return parsed
    target = act.get("target") or {}
    eid = target.get("element_id") if isinstance(target, dict) else None
    if act.get("action") in ("DONE", "WAIT", "SCROLL", "GO_BACK", "GO_FORWARD", "EXTRACT", "PRESS_KEY", "OPEN_TAB", "SWITCH_TAB", "ASK_USER"):
        _log_safe_plan_shape(parsed)
        return parsed

    action_type = act.get("action")
    downgrade_reason = None

    # Upload guard: an UPLOAD is only meaningful as "attach THIS one of the
    # user's own stored documents". A token that is not in STORED_DOCUMENTS —
    # or a value/path where a token belongs — is an invented handle, not a
    # file the user chose, so it is downgraded rather than forwarded. The
    # extension enforces the same rule again before anything is executed.
    if action_type == "UPLOAD":
        allowed_docs = {
            str(name) for name in (stored_documents or [])
            if re.fullmatch(r"LOCAL_DOCUMENT_[A-Z0-9_]{1,48}", str(name))
        }
        source = act.get("value_source")
        if not isinstance(source, str) or source not in allowed_docs:
            downgrade_reason = "UPLOAD must name a document from STORED_DOCUMENTS"

    # Value hallucination guard 1: TYPE with neither an inline value nor a
    # symbolic source would be rejected by the extension's schema anyway —
    # repairing here saves the wasted observation roundtrip.
    if action_type == "TYPE" and not act.get("value") and not act.get("value_source"):
        downgrade_reason = "TYPE has no value and no value_source"

    # Value hallucination guard 2: a SELECT value that matches none of the
    # element's known options is fabricated. The extension executor would
    # fail to match it; downgrade so the model re-observes.
    if action_type == "SELECT" and not downgrade_reason:
        proposed_value = act.get("value")
        if isinstance(proposed_value, str) and proposed_value.strip():
            options = _option_texts(fused_observation, eid)
            if not _value_matches_option(proposed_value, options):
                downgrade_reason = f"SELECT value '{proposed_value.strip()[:40]}' matches no option of {eid or 'the target'}"

    # Hallucination guard 3: a NAVIGATE target must be a real http(s) URL —
    # invented scheme-relative or internal URLs fail at execution.
    if action_type == "NAVIGATE":
        nav_target = act.get("target") or {}
        nav_url = nav_target.get("url") if isinstance(nav_target, dict) else None
        if not isinstance(nav_url, str) or not re.match(r"^https?://", nav_url.strip(), re.I):
            downgrade_reason = "NAVIGATE target is not a valid http(s) URL"

    if downgrade_reason:
        act["action"] = "WAIT"
        act["target"] = None
        parsed["action"] = act
        parsed["thought"] = (parsed.get("thought") or "") + f" [grounding-repair: {downgrade_reason}; waiting to re-observe]"
        _log_safe_plan_shape(parsed)
        return parsed

    # Hallucination guard: any target id that is not a known page element is
    # fabricated, including when the observation supplied no element ids at
    # all (an empty allowed set must NOT let a hallucinated id pass through).
    if eid and eid not in allowed:
        # Never replace a hallucinated/stale target with a different control.
        # A safe re-observation is preferable to executing a semantically
        # unrelated element that happens to be ranked or resolved.
        act["action"] = "WAIT"
        act["target"] = None
        parsed["action"] = act
        parsed["thought"] = (
            parsed.get("thought") or ""
        ) + f" [grounding-repair: {eid} is not in the current observation; waiting to re-observe]"
    _log_safe_plan_shape(parsed)
    return parsed


class GPTOSSService:
    def __init__(self):
        pass

    def interpret_task(self, task: str) -> Dict[str, Any]:
        if not settings.API_KEY:
            return {
                "intent": "unknown",
                "target": None,
                "constraints": [],
                "entities": [],
                "expected_state": "Completed task",
                "subgoals": [],
                "confidence": 0.0
            }

        prompt = """You are PrivAgent's task interpreter.
Analyze the user's natural language request and output a structured JSON semantic goal.

 Distinguish:
 - intent: primary verb (SEARCH, NAVIGATE, FILL_FORM, UPLOAD, PLAY, CLICK, EXTRACT)
 - target: what they want (type + entity + attributes)
 - constraints: cheapest, latest, first, price limits, brand, location,
   AND submission/scope guards: "must NOT submit the form" when the user
   says do not submit / don't submit / stop before submitting / ask before
   submitting, plus any section scoping ("personal information section only")
 - references: words like this/that/the first one/on this page
 - expected_state: what the browser should look like when fully done
 - subgoals: ordered atomic steps

Output ONLY a valid JSON object. Do NOT include markdown blocks:
{
  "intent": "SEARCH",
  "target": { "type": "product", "entity": "laptop", "attributes": {} },
  "constraints": ["cheapest", "price <= 60000"],
  "entities": ["laptop"],
  "references": ["first suitable"],
  "expected_state": "The cheapest matching laptop product page is open",
  "subgoals": ["search", "filter by budget", "open cheapest matching result"],
  "current_subgoal": "search",
  "confidence": 0.95
 }

 For form tasks, append submission guards verbatim when the user states
 them, e.g. "constraints": ["must NOT submit the form"].
 """
        headers = {
            "Authorization": f"Bearer {settings.API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": settings.REASONING_MODEL,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": task}
            ],
            "temperature": 0.0
        }

        try:
            resp = requests.post(
                f"{settings.AI_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
                timeout=settings.INTERPRETATION_REQUEST_TIMEOUT_SECONDS,
            )
            if resp.status_code == 200:
                raw_choices = resp.json().get("choices") or []
                message = raw_choices[0].get("message") or {} if raw_choices else {}
                content = message.get("content")
                if not isinstance(content, str) or not content.strip():
                    raise Exception("Empty response from interpretation model")
                return _extract_json(_strip_reasoning(content))
            raise Exception(f"Model error: {resp.status_code}")
        except Exception as e:
            logger.warning("Task interpretation failed (%s); using the local interpreter.",
                            type(e).__name__, extra={"endpoint": "/interpret"})
            return {
                "intent": "unknown",
                "target": None,
                "constraints": [],
                "entities": [],
                "expected_state": "Completed task",
                "subgoals": [],
                "confidence": 0.0
            }

    def plan_step(self, task: str, fused_observation: Dict[str, Any], task_history: List[Dict[str, Any]], task_state: Optional[Dict[str, Any]] = None, page_state: Optional[Dict[str, Any]] = None, stored_documents: Optional[List[str]] = None) -> Dict[str, Any]:
        if not settings.API_KEY:
            raise Exception("API_KEY is missing. General semantic reasoning requires a live model.")

        allowed = _allowed_ids(fused_observation, page_state)

        try:
            # Planner + Critique reasoning (backend/agentic, adapted from
            # TheAgenticBrowser's Planner -> Browser -> Critique loop): one
            # universal system prompt handles plan management, action
            # grounding, and critique while preserving the symbolic-action
            # contract. The extension's step history is the loop memory; see
            # agentic/orchestrator.py for why the loop itself stays in the
            # extension.
            # Compact request composition (agentic/context.py): short history
            # summary + relevant observation only + current request. Key names
            # stay stable for the live prompt's contract; values compact.
            # ALLOWED_ELEMENT_IDS is never truncated (grounding authority).
            page_evidence = build_page_evidence(
                fused_observation, page_state, allowed, task_history, stored_documents
            )
            user_msg = {
                "ORIGINAL_USER_REQUEST": task,
                "TASK_STATE": task_state or {},
                "UNTRUSTED_WEBPAGE_CONTENT": (
                    "<untrusted_webpage_content>\n"
                    + json.dumps(page_evidence, separators=(",", ":"))
                    + "\n</untrusted_webpage_content>"
                ),
            }
            sensitive_category = find_sensitive_category(json.dumps(user_msg, separators=(',', ':')))
            if sensitive_category:
                raise OutboundPrivacyError(
                    f"Outbound privacy check blocked an unredacted {sensitive_category} pattern."
                )

            headers = {
                "Authorization": f"Bearer {settings.API_KEY}",
                "Content-Type": "application/json"
            }
            user_content = json.dumps(user_msg, separators=(',', ':'))
            payload = {
                "model": settings.REASONING_MODEL,
                "messages": compose_reasoning_messages(user_content),
                "temperature": 0.1,
                # Reasoning models spend completion tokens on the chain of
                # thought before emitting JSON. 1500 truncated the tail of the
                # object (the logs show an unparseable body ending mid-plan);
                # 4000 leaves room for the trace plus the full contract.
                "max_tokens": 4000
            }

            resp = requests.post(
                f"{settings.AI_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
                timeout=settings.REASONING_REQUEST_TIMEOUT_SECONDS,
            )
            if resp.status_code == 200:
                raw_choices = resp.json().get("choices") or []
                if not raw_choices:
                    raise Exception("Empty response from reasoning model")
                message = raw_choices[0].get("message") or {}
                content = message.get("content")
                if not isinstance(content, str) or not content.strip():
                    raise Exception("Empty response from reasoning model")
                # Gateways can return HTTP 200 whose content is the provider's
                # error text; that must never be parsed as a plan.
                if looks_like_provider_error(content):
                    raise Exception("Reasoning provider returned an error instead of a plan")
                parsed = _try_parse_plan(content)
                if parsed is None:
                    # Reasoning models comply intermittently: roughly one call
                    # in several returns a body whose JSON cannot be parsed,
                    # which used to end the task with "invalid schema". One
                    # repair retry costs nothing in the happy path and turns
                    # that terminal failure into a usable step.
                    logger.warning(
                        "Reasoning response was not parseable JSON; retrying once with a repair instruction.",
                        extra={"endpoint": "/reason"},
                    )
                    content = _repair_retry(headers, payload, user_content)
                    parsed = _try_parse_plan(content)
                if isinstance(parsed, dict) and "action" in parsed:
                    act = parsed.get("action")
                    if not isinstance(act, dict):
                        raise Exception("Model returned invalid schema")
                    if act.get("value_source") and act.get("value"):
                        valid_sources = ("LOCAL_AADHAAR", "LOCAL_PAN", "LOCAL_DOCUMENT", "LOCAL_PASSWORD", "LOCAL_FULL_NAME", "LOCAL_DOB", "LOCAL_PHONE", "LOCAL_EMAIL", "LOCAL_ADDRESS", "LOCAL_PROFILE", "LOCAL_CREDIT_CARD", "LOCAL_CVV", "LOCAL_SSN", "LOCAL_SIN", "LOCAL_NIN", "LOCAL_NHS", "LOCAL_IBAN", "LOCAL_CITY", "LOCAL_STATE", "LOCAL_ZIP", "LOCAL_COUNTRY", "LOCAL_GENDER", "LOCAL_TERMS")
                        if act["value_source"] not in valid_sources and not re.fullmatch(r"LOCAL_CUSTOM_[A-Z0-9_]{1,48}", str(act["value_source"])):
                            act["value_source"] = None
                    parsed = _repair_action(parsed, allowed, page_state, fused_observation, stored_documents)
                    # Planner + Critique roles, carried through for the side
                    # panel's transparency view and the log file. The
                    # extension acts only on `action`; these fields never
                    # authorize anything.
                    if not isinstance(parsed.get("plan"), str):
                        parsed["plan"] = ""
                    if not isinstance(parsed.get("planner_feedback"), str):
                        parsed["planner_feedback"] = ""
                    if not isinstance(parsed.get("final_response"), str):
                        parsed["final_response"] = ""
                    parsed["final_response"] = parsed["final_response"].strip()
                    # A critic stop is a user-facing answer, not a bare flag.
                    # Keep the two together so the extension cannot finish
                    # silently on malformed model output.
                    parsed["terminate_assessment"] = (
                        parsed.get("terminate_assessment") is True
                        and bool(parsed["final_response"])
                    )
                    parsed["model_trace"] = {
                        "component": "reasoning",
                        "source": "remote",
                        "provider": urlsplit(settings.AI_BASE_URL).hostname or "configured endpoint",
                        "model": settings.REASONING_MODEL,
                    }
                    return parsed
                raise Exception("Model returned invalid schema")
            raise Exception(f"Model API error: {resp.status_code}")

        except Exception as e:
            logger.warning("Semantic reasoning failed (%s); propagating to the caller.",
                            type(e).__name__, extra={"endpoint": "/reason"})
            raise e

gpt_oss_service = GPTOSSService()
