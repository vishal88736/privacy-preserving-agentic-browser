"""
Browser Automation Manager
==========================
Wraps the browser_agent-main Playwright stack into a reusable module that the
backend agentic loop can call.  Handles Chrome CDP connection, initializes all
sub-controllers, and exposes tool functions for the agent bridge.

Uses the same Playwright-based browser setup, cursor injection, and DOM
analysis as the standalone browser_agent-main CLI, but designed to be driven
by the privacy-aware backend pipeline rather than a direct LLM.
"""

import os
import sys
import time
import json
import subprocess
import platform
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path

# ---------------------------------------------------------------------------
# Add browser_agent-main to Python path so we can import its modules
# ---------------------------------------------------------------------------
_AGENT_ROOT = Path(__file__).resolve().parent.parent / "browser_agent-main"
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

# ---------------------------------------------------------------------------
# Imports from browser_agent-main
# ---------------------------------------------------------------------------
from browser.browser_setup import initialize_browser, close_browser, inject_cursor_script
from browser.controllers.browser_controller import (
    initialize as init_browser_controller,
    get_browser_tools,
)
from browser.analyzers.page_analyzer import (
    analyze_page as _analyze_page_tool,
    page_elements as _page_elements,
)
from browser.controllers.element_controller import click as _click_tool, type as _type_tool, select_option as _select_option_tool
from browser.controllers.keyboard_controller import keyboard_action as _keyboard_tool
from browser.navigation.navigator import navigate as _navigate_tool, go_back as _go_back_tool
from browser.navigation.scroll_manager import scroll as _scroll_tool
from browser.utils.user_interaction import ask_user as _ask_user_tool

from config import settings


class BrowserAutomationManager:
    """
    Manages a single Playwright browser session and exposes tool functions
    that map to the actions the reasoning model can output.
    """

    def __init__(
        self,
        cdp_endpoint: str = "http://localhost:9222",
        headless: bool = False,
    ):
        self.cdp_endpoint = cdp_endpoint
        self.headless = headless
        self.playwright = None
        self.browser = None
        self.page = None
        self._connected = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        """Connect to Chrome via CDP and initialize all sub-controllers."""
        if self._connected:
            return True

        browser_options = {
            "headless": self.headless,
            "channel": "chrome",
            "args": [
                "--start-maximized",
                "--disable-notifications",
                "--disable-extensions",
            ],
        }
        connection_options = {"cdp_endpoint": self.cdp_endpoint}

        try:
            print(f"[BrowserAutomation] Connecting to Chrome at {self.cdp_endpoint}...")
            self.playwright, self.browser, self.page = initialize_browser(
                browser_options, connection_options
            )

            # Initialize all the browser_agent-main sub-controllers
            init_browser_controller(self.page)

            self._connected = True
            print("[BrowserAutomation] ✅ Connected and controllers initialized")
            return True
        except Exception as e:
            print(f"[BrowserAutomation] ❌ Connection failed: {e}")
            return False

    def disconnect(self):
        """Disconnect from Chrome (Chrome stays open)."""
        if self.playwright and self.browser:
            try:
                close_browser(self.playwright, self.browser)
                print("[BrowserAutomation] 🔌 Disconnected")
            except Exception as e:
                print(f"[BrowserAutomation] Disconnect warning: {e}")
        self._connected = False
        self.playwright = None
        self.browser = None
        self.page = None

    @property
    def is_connected(self) -> bool:
        return self._connected

    # ------------------------------------------------------------------
    # Tool Execution — maps action names to browser_agent-main tools
    # ------------------------------------------------------------------

    def analyze_page(self) -> Dict[str, Any]:
        """
        Analyze the current page and return structured element data.
        Returns both the formatted text representation and raw element list.
        """
        self._ensure_connected()
        try:
            formatted_text = _analyze_page_tool()
            # Import the freshly-populated page_elements from the analyzer
            from browser.analyzers.page_analyzer import page_elements
            return {
                "formatted_text": formatted_text,
                "elements": list(page_elements) if page_elements else [],
                "url": self.page.url,
                "title": self.page.title(),
            }
        except Exception as e:
            return {"error": str(e), "elements": [], "url": "", "title": ""}

    def execute_action(self, action: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a single action returned by the reasoning model.

        Expected action format (from /reason endpoint):
        {
            "action": "CLICK | TYPE | SELECT | NAVIGATE | SCROLL | GO_BACK | PRESS_KEY | ASK_USER | WAIT | DONE",
            "target": {"element_id": "5", "label": "Submit"},
            "value": "some text",
            "value_source": null | "LOCAL_AADHAAR" | ...
        }
        """
        self._ensure_connected()

        action_type = (action.get("action") or "WAIT").upper()
        target = action.get("target") or {}
        value = action.get("value")
        value_source = action.get("value_source")

        try:
            if action_type == "CLICK":
                return self._do_click(target)
            elif action_type == "TYPE":
                return self._do_type(target, value)
            elif action_type == "SELECT":
                return self._do_select(target, value)
            elif action_type == "NAVIGATE":
                url = value or target.get("url") or target.get("label") or ""
                return self._do_navigate(url)
            elif action_type == "SCROLL":
                direction = value or target.get("direction") or "down"
                return self._do_scroll(direction)
            elif action_type == "GO_BACK":
                return self._do_go_back()
            elif action_type == "PRESS_KEY":
                key = value or target.get("key") or "Enter"
                return self._do_keyboard(key)
            elif action_type == "ASK_USER":
                prompt = value or target.get("prompt") or "Please provide input"
                return {"result": f"[ASK_USER] {prompt}", "needs_user_input": True}
            elif action_type == "WAIT":
                time.sleep(1)
                return {"result": "Waited 1 second"}
            elif action_type == "DONE":
                return {"result": "Task marked as complete", "is_terminal": True}
            elif action_type in ("SUBMIT", "UPLOAD"):
                # SUBMIT/UPLOAD are high-risk, handled same as CLICK but flagged
                return self._do_click(target)
            elif action_type == "EXTRACT":
                obs = self.analyze_page()
                return {"result": f"Page content extracted", "observation": obs}
            else:
                return {"result": f"Unknown action type: {action_type}", "error": True}
        except Exception as e:
            return {"result": f"Action execution error: {str(e)}", "error": True}

    # ------------------------------------------------------------------
    # Private tool wrappers
    # ------------------------------------------------------------------

    def _do_click(self, target: Dict[str, Any]) -> Dict[str, Any]:
        element_id = target.get("element_id")
        label = target.get("label", "")

        # Build a target description compatible with the click tool
        if element_id is not None:
            target_desc = json.dumps({"id": str(element_id), "text": label})
        elif label:
            target_desc = label
        else:
            return {"result": "No click target specified", "error": True}

        result = _click_tool(target_desc)
        return {"result": str(result)}

    def _do_type(self, target: Dict[str, Any], value: str) -> Dict[str, Any]:
        if not value:
            return {"result": "No value to type", "error": True}

        # First click the target field to focus it
        click_result = self._do_click(target)
        if "error" in click_result:
            return click_result

        time.sleep(0.1)  # Brief pause for focus

        result = _type_tool(value)
        return {"result": str(result)}

    def _do_select(self, target: Dict[str, Any], value: str) -> Dict[str, Any]:
        element_id = target.get("element_id")
        label = target.get("label", "")

        select_input = {
            "type": "dropdown",
            "text": label,
            "value": value or "",
        }
        if element_id is not None:
            select_input["id"] = str(element_id)

        result = _select_option_tool(json.dumps(select_input))
        return {"result": str(result)}

    def _do_navigate(self, url: str) -> Dict[str, Any]:
        if not url:
            return {"result": "No URL provided for navigation", "error": True}
        result = _navigate_tool(url)
        return {"result": str(result)}

    def _do_scroll(self, direction: str) -> Dict[str, Any]:
        result = _scroll_tool(direction)
        return {"result": str(result)}

    def _do_go_back(self) -> Dict[str, Any]:
        result = _go_back_tool()
        return {"result": str(result)}

    def _do_keyboard(self, key: str) -> Dict[str, Any]:
        result = _keyboard_tool(key)
        return {"result": str(result)}

    # ------------------------------------------------------------------
    # Observation building — creates the fused_observation for /reason
    # ------------------------------------------------------------------

    def build_observation(self, page_analysis: Dict[str, Any]) -> Dict[str, Any]:
        """
        Build a fused_observation compatible with the /reason endpoint
        from raw page analysis data.
        """
        elements = page_analysis.get("elements", [])
        url = page_analysis.get("url", "")
        title = page_analysis.get("title", "")

        # Convert browser_agent-main element format to the /reason format
        fused_elements = []
        for el in elements:
            fused_el = {
                "id": str(el.get("id", "")),
                "element_id": str(el.get("id", "")),
                "tag": el.get("tagName", "div"),
                "role": el.get("type", "interactive"),
                "label": el.get("text", ""),
                "type": el.get("type", ""),
                "bbox": [
                    el.get("x", 0),
                    el.get("y", 0),
                    el.get("width", 0),
                    el.get("height", 0),
                ],
                "sensitive": False,  # Privacy layer will handle this
                "context": el.get("text", "")[:120],
            }

            # Check for attributes
            attrs = el.get("attributes", {})
            if attrs:
                fused_el["placeholder"] = attrs.get("placeholder", "")
                fused_el["name"] = attrs.get("id", "") or attrs.get("class", "")

            fused_elements.append(fused_el)

        return {
            "url": url,
            "title": title,
            "elements": fused_elements,
            "visible_text": page_analysis.get("formatted_text", ""),
        }

    def build_page_state(self, page_analysis: Dict[str, Any]) -> Dict[str, Any]:
        """
        Build a page_state dict for the /reason endpoint with enriched
        page context (ranked candidates, headings, etc.)
        """
        elements = page_analysis.get("elements", [])
        url = page_analysis.get("url", "")
        title = page_analysis.get("title", "")

        # Classify page type from URL and title
        title_lower = title.lower()
        url_lower = url.lower()
        page_type = "unknown"
        if "search" in title_lower or "find" in title_lower:
            page_type = "search"
        elif "login" in title_lower or "sign in" in title_lower:
            page_type = "login"
        elif "form" in title_lower or "apply" in title_lower:
            page_type = "application_form"
        elif "upload" in title_lower or "document" in title_lower:
            page_type = "document_upload"

        # Extract headings from elements
        headings = [
            {"text": el.get("text", ""), "level": el.get("tagName", "H1")}
            for el in elements
            if el.get("tagName", "").upper().startswith("H")
        ]

        # Build ranked candidates (interactive elements)
        ranked_candidates = []
        for el in elements:
            el_type = el.get("type", "")
            if el_type in ("button", "link", "input", "dropdown", "textarea", "checkbox", "radio"):
                ranked_candidates.append({
                    "element_id": str(el.get("id", "")),
                    "type": el_type,
                    "label": el.get("text", ""),
                    "relevance": 0.8,
                })

        return {
            "url": url,
            "title": title,
            "page_type": page_type,
            "summary": f"{title} - {page_type} page with {len(elements)} elements",
            "headings": headings[:10],
            "ranked_candidates": ranked_candidates[:30],
            "resolved_references": {},
            "visible_text_excerpt": page_analysis.get("formatted_text", "")[:2000],
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _ensure_connected(self):
        if not self._connected:
            raise RuntimeError(
                "Browser not connected. Call connect() first."
            )

    def get_current_url(self) -> str:
        self._ensure_connected()
        return self.page.url

    def get_page_title(self) -> str:
        self._ensure_connected()
        return self.page.title()

    def take_screenshot(self) -> Optional[bytes]:
        """Take a screenshot of the current viewport (for VLM if needed)."""
        self._ensure_connected()
        try:
            return self.page.screenshot(type="png")
        except Exception as e:
            print(f"[BrowserAutomation] Screenshot error: {e}")
            return None
