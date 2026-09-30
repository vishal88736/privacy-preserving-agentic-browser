"""Contracts for the adapted TheAgenticBrowser Planner + Critique loop."""

import json
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from agentic.context import (
    MAX_EVIDENCE_CHARS,
    build_page_evidence,
    select_relevant_elements,
    summarize_history,
)
from agentic.orchestrator import compose_reasoning_messages
from agentic.prompts import UNIVERSAL_TASK_PROMPT
from agentic.schemas import CritiqueOutput, StepReasoning
from config import settings
from gpt_oss_service import GPTOSSService


class AgenticLoopTests(unittest.TestCase):
    def test_composition_uses_one_universal_prompt_and_preserves_user_payload(self):
        user_content = '{"ORIGINAL_USER_REQUEST":"read the page title"}'
        messages = compose_reasoning_messages(user_content)
        self.assertEqual(messages, [
            {"role": "system", "content": UNIVERSAL_TASK_PROMPT},
            {"role": "user", "content": user_content},
        ])
        self.assertEqual(messages[0]["content"], UNIVERSAL_TASK_PROMPT)

    def test_universal_prompt_matches_live_input_and_output_contracts(self):
        for field in (
            "ORIGINAL_USER_REQUEST", "TASK_STATE", "UNTRUSTED_WEBPAGE_CONTENT",
            "PAGE_STATE", "ALLOWED_ELEMENT_IDS", "AVAILABLE_ELEMENTS", "ACTION_HISTORY",
            "next_step", '"feedback"', '"terminate"', '"final_response"',
            '"planner_feedback"', '"terminate_assessment"', '"is_terminal"',
        ):
            self.assertIn(field, UNIVERSAL_TASK_PROMPT)
        self.assertIn("Never emit UPLOAD", UNIVERSAL_TASK_PROMPT)
        self.assertNotIn("SUBMIT | UPLOAD |", UNIVERSAL_TASK_PROMPT)
        self.assertIn("Never emit FILL_FORM_PLAN", UNIVERSAL_TASK_PROMPT)
        self.assertIn("Never emit\nSWITCH_TAB", UNIVERSAL_TASK_PROMPT)
        self.assertIn("runtime confirmation is\nstill required for SUBMIT", UNIVERSAL_TASK_PROMPT)
        self.assertIn("three consecutive failed steps", UNIVERSAL_TASK_PROMPT)
        for playbook in (
            "[PLAY/MEDIA]", "[BOOK/TICKETS]", "[SHEETS/GRID WRITING]",
            "[VISIT ANY WEBSITE]", "[LOGIN]", "[DOWNLOAD]",
        ):
            self.assertIn(playbook, UNIVERSAL_TASK_PROMPT)
        self.assertIn("ArrowDown/ArrowRight/ArrowLeft/ArrowUp/Tab", UNIVERSAL_TASK_PROMPT)
        self.assertIn("booking correctly parked", UNIVERSAL_TASK_PROMPT)
        self.assertIn("Spreadsheet and booking values are user data", UNIVERSAL_TASK_PROMPT)
        self.assertNotIn("SUBMIT | UPLOAD |", UNIVERSAL_TASK_PROMPT)

    def test_step_reasoning_schema_accepts_universal_and_role_parser_fields(self):
        result = StepReasoning.model_validate({
            "plan": "Read the page title and return it.",
            "next_step": "Extract the visible page content.",
            "feedback": "The title is available in the page evidence.",
            "terminate": False,
            "planner_feedback": "The title is available in the page evidence.",
            "terminate_assessment": False,
            "final_response": "",
            "action": {"action": "EXTRACT"},
        })
        self.assertEqual(result.next_step, "Extract the visible page content.")
        self.assertEqual(result.feedback, result.planner_feedback)
        self.assertEqual(result.terminate, result.terminate_assessment)

    def test_plan_step_carries_plan_feedback_and_termination_from_mocked_transport(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        payload = {
            "action": {"action": "WAIT"},
            "plan": "Read the title and report it.",
            "planner_feedback": "The title is visible in the observation.",
            "terminate_assessment": True,
            "final_response": "The page title is Example.",
        }
        response = type("Response", (), {
            "status_code": 200,
            "json": lambda self: {"choices": [{"message": {"content": json.dumps(payload)}}]},
        })()
        sent_payload = {}
        try:
            def mock_post(_url, **kwargs):
                sent_payload.update(kwargs["json"])
                return response

            with patch("gpt_oss_service.requests.post", side_effect=mock_post):
                result = service.plan_step(
                    "Read the page title", {"elements": []}, [], {"intent": "EXTRACT"}, None
                )
        finally:
            settings.API_KEY = previous_key

        self.assertEqual(result["plan"], payload["plan"])
        self.assertEqual(result["planner_feedback"], payload["planner_feedback"])
        self.assertTrue(result["terminate_assessment"])
        self.assertEqual(result["final_response"], payload["final_response"])
        self.assertEqual(sent_payload["messages"][0]["content"], UNIVERSAL_TASK_PROMPT)
        sent_user_message = json.loads(sent_payload["messages"][1]["content"])
        self.assertEqual(set(sent_user_message), {
            "ORIGINAL_USER_REQUEST", "TASK_STATE", "UNTRUSTED_WEBPAGE_CONTENT"
        })
        untrusted_region = sent_user_message["UNTRUSTED_WEBPAGE_CONTENT"]
        self.assertIn('"ALLOWED_ELEMENT_IDS"', untrusted_region)
        self.assertIn('"AVAILABLE_ELEMENTS"', untrusted_region)
        self.assertIn('"ACTION_HISTORY"', untrusted_region)

    def test_reasoning_model_content_is_unwrapped_before_parsing(self):
        """gpt-oss returns the chain of thought and the JSON in one field.

        Bedrock/Groq gpt-oss answers look like
        ``<reasoning>...thinking...</reasoning>{"action": {...}}``. Parsing
        that as bare JSON failed on every attempt in the logs and surfaced as
        "Model returned invalid schema", so the stripper is the fix.
        """
        from gpt_oss_service import _extract_json, _strip_reasoning

        reasoning = (
            "<reasoning>We should use EXTRACT then DONE, the title is known. "
            "Note the plan mentions {\"action\": \"CLICK\"} as a counterexample."
            "</reasoning>"
            + json.dumps({
                "plan": "Read the title",
                "next_step": "Extract the title",
                "action": {"action": "DONE", "risk": "LOW"},
                "final_response": "Example Domain",
            })
        )
        stripped = _strip_reasoning(reasoning)
        self.assertTrue(stripped.startswith("{"))
        # The JSON quoted inside the reasoning prose must not win.
        self.assertEqual(_extract_json(stripped)["action"]["action"], "DONE")
        self.assertEqual(_extract_json(_strip_reasoning(reasoning))["final_response"], "Example Domain")

        # <think> variant, and pure JSON must pass through untouched.
        self.assertEqual(
            _extract_json(_strip_reasoning('<think>hmm</think>{"action":{"action":"CLICK"}}'))["action"]["action"],
            "CLICK",
        )
        self.assertEqual(_strip_reasoning('{"action":{"action":"WAIT"}}'), '{"action":{"action":"WAIT"}}')

        # An unterminated reasoning block yields nothing rather than a plan
        # scraped out of the prose: a wrong plan is worse than a clean failure.
        # Only an answer that begins immediately after the tag is trusted.
        self.assertEqual(_strip_reasoning('<reasoning>thinking about {"action":"CLICK"}'), "")
        self.assertEqual(_strip_reasoning('<reasoning>{"a":1}'), '{"a":1}')

    def test_plan_step_sends_headroom_for_reasoning_tokens(self):
        """A reasoning model spends completion tokens before emitting JSON."""
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        response = type("Response", (), {
            "status_code": 200,
            "json": lambda self: {"choices": [{"message": {"content": '{"action":{"action":"WAIT"}}'}}]},
        })()
        seen = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            seen["max_tokens"] = json.get("max_tokens")
            return response

        try:
            with patch("gpt_oss_service.requests.post", side_effect=fake_post):
                service.plan_step("t", {"elements": []}, [], {"intent": "unknown"}, None)
        finally:
            settings.API_KEY = previous_key

        self.assertGreaterEqual(seen["max_tokens"], 4000)

    def test_plan_step_accepts_a_reasoning_wrapped_action(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        wrapped = (
            "<reasoning>Title is in PAGE_STATE; EXTRACT then answer.</reasoning>"
            + json.dumps({
                "thought": "Reading the title",
                "action": {"action": "DONE", "risk": "LOW"},
                "final_response": "Example Domain",
                "terminate_assessment": True,
            })
        )
        response = type("Response", (), {
            "status_code": 200,
            "json": lambda self: {"choices": [{"message": {"content": wrapped}}]},
        })()
        try:
            with patch("gpt_oss_service.requests.post", return_value=response):
                result = service.plan_step(
                    "What is the page title?", {"elements": []}, [], {"intent": "EXTRACT"}, None
                )
        finally:
            settings.API_KEY = previous_key

        self.assertEqual(result["action"]["action"], "DONE")
        self.assertEqual(result["final_response"], "Example Domain")
        self.assertTrue(result["terminate_assessment"])

    def test_fenced_and_prose_prefixed_answers_are_recovered(self):
        """Intermittent compliance: fences and a lead-in must not be fatal."""
        from gpt_oss_service import _extract_json, _strip_reasoning

        plan = json.dumps({"action": {"action": "DONE"}, "final_response": "ok"})

        fenced = "<reasoning>done</reasoning>\n```json\n" + plan + "\n```"
        self.assertEqual(_extract_json(_strip_reasoning(fenced))["action"]["action"], "DONE")

        prose = "<reasoning>done</reasoning>Here is the JSON object you asked for:\n" + plan
        self.assertEqual(_extract_json(_strip_reasoning(prose))["action"]["action"], "DONE")

        bare_fence = "```json\n" + plan + "\n```"
        self.assertEqual(_extract_json(_strip_reasoning(bare_fence))["action"]["action"], "DONE")

    def test_plan_step_repairs_one_unparseable_response(self):
        """A single malformed body must not end the task."""
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        bad = "<reasoning>thinking</reasoning>I could not comply, sorry."
        good = json.dumps({
            "thought": "retrying",
            "action": {"action": "CLICK", "target": {"element_id": "el_1"}, "risk": "LOW"},
        })
        responses = [
            type("R", (), {"status_code": 200,
                           "json": lambda self, c=bad: {"choices": [{"message": {"content": c}}]}})(),
            type("R", (), {"status_code": 200,
                           "json": lambda self, c=good: {"choices": [{"message": {"content": c}}]}})(),
        ]
        calls = []

        def fake_post(url, headers=None, json=None, timeout=None):
            calls.append(json)
            return responses[min(len(calls) - 1, len(responses) - 1)]

        try:
            with patch("gpt_oss_service.requests.post", side_effect=fake_post):
                result = service.plan_step(
                    "Click the button", {"elements": [{"id": "el_1"}]}, [], {"intent": "CLICK"}, None
                )
        finally:
            settings.API_KEY = previous_key

        self.assertEqual(len(calls), 2, "expected exactly one repair retry")
        self.assertEqual(result["action"]["action"], "CLICK")
        # The repair turn carries the instruction and a deterministic temperature.
        self.assertIn("could not be parsed", calls[1]["messages"][-1]["content"])
        self.assertEqual(calls[1]["temperature"], 0.0)

    def test_plan_step_gives_up_after_one_repair_retry(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        bad = "<reasoning>thinking</reasoning>still not json"
        calls = []

        def fake_post(url, headers=None, json=None, timeout=None):
            calls.append(json)
            return type("R", (), {"status_code": 200,
                                  "json": lambda self: {"choices": [{"message": {"content": bad}}]}})()

        try:
            with patch("gpt_oss_service.requests.post", side_effect=fake_post):
                with self.assertRaisesRegex(Exception, "invalid schema"):
                    service.plan_step(
                        "Click", {"elements": [{"id": "el_1"}]}, [], {"intent": "CLICK"}, None
                    )
        finally:
            settings.API_KEY = previous_key

        self.assertEqual(len(calls), 2, "must not retry indefinitely")

    def test_plan_step_rejects_bare_critic_termination(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        payload = {
            "action": {"action": "WAIT"},
            "terminate_assessment": True,
            "final_response": "   ",
        }
        response = type("Response", (), {
            "status_code": 200,
            "json": lambda self: {"choices": [{"message": {"content": json.dumps(payload)}}]},
        })()
        try:
            with patch("gpt_oss_service.requests.post", return_value=response):
                result = service.plan_step(
                    "Read the page title", {"elements": []}, [], {"intent": "EXTRACT"}, None
                )
        finally:
            settings.API_KEY = previous_key

        self.assertFalse(result["terminate_assessment"])


class CompactContextTests(unittest.TestCase):
    """Short history summary + relevant observation only + current request."""

    def test_empty_history_summarizes_to_empty_string(self):
        self.assertEqual(summarize_history([]), "")
        self.assertEqual(summarize_history(None), "")

    def test_summary_keeps_last_outcome_failure_count_and_extracts(self):
        history = [
            {"action": "CLICK", "target": "el_1", "success": True},
            {"action": "TYPE", "target": "el_2", "success": False, "error": "stale target"},
            {
                "action": "EXTRACT", "target": None, "success": True,
                "extracted_text": "Price 42",
                "planner_feedback": "Search box filled; results observed.",
            },
        ]
        summary = summarize_history(history)
        self.assertIn("steps=3", summary)
        self.assertIn("consecutive_failures=0", summary)
        self.assertIn("EXTRACT", summary)
        self.assertIn("Price 42", summary)
        self.assertIn("results observed", summary)
        # Older steps collapse: their detail must not ride along verbatim.
        self.assertNotIn("stale target", summary)

    def test_summary_counts_consecutive_failures_like_the_breakers(self):
        history = [
            {"action": "CLICK", "target": "el_1", "success": True},
            {"action": "CLICK", "target": "el_2", "success": False, "error": "a"},
            {"action": "CLICK", "target": "el_3", "success": False, "error": "b"},
        ]
        self.assertIn("consecutive_failures=2", summarize_history(history))

    def test_relevant_elements_come_first_and_dicts_stay_whole(self):
        elements = [{"id": f"el_{i}", "label": f"control {i}"} for i in range(10)]
        fused = {"elements": elements}
        page_state = {
            "ranked_candidates": [{"element_id": "el_7"}],
            "resolved_references": {"first": "el_3"},
            "suggested_search_element": {"id": "el_0"},
        }
        selected = select_relevant_elements(fused, page_state, max_elements=5)
        # Relevant ids first, observation order preserved within each group.
        self.assertEqual(
            [el["id"] for el in selected],
            ["el_0", "el_3", "el_7", "el_1", "el_2"],
        )
        # Whole dicts, not slimmed projections.
        self.assertEqual(selected[0], {"id": "el_0", "label": "control 0"})

    def test_small_observations_pass_through_untouched(self):
        elements = [{"id": "el_1", "label": "Search"}]
        fused = {"elements": elements}
        evidence = build_page_evidence(fused, {"url": "https://example.test"}, {"el_1"}, [])
        self.assertEqual(evidence["AVAILABLE_ELEMENTS"], elements)
        self.assertEqual(evidence["ALLOWED_ELEMENT_IDS"], ["el_1"])
        self.assertEqual(evidence["ACTION_HISTORY"], "")
        self.assertEqual(evidence["PAGE_STATE"]["url"], "https://example.test")

    def test_byte_budget_holds_on_a_bloated_page(self):
        elements = [
            {"id": f"el_{i}", "label": f"control number {i} with padding text " * 10}
            for i in range(200)
        ]
        fused = {"elements": elements, "visible_text": "x" * 9000}
        page_state = {"ranked_candidates": [{"element_id": "el_150"}]}
        allowed = {f"el_{i}" for i in range(200)}
        history = [{"action": "CLICK", "target": "el_1", "success": True}]
        evidence = build_page_evidence(fused, page_state, allowed, history)
        import json as _json
        self.assertLessEqual(
            len(_json.dumps(evidence, separators=(",", ":"))), MAX_EVIDENCE_CHARS
        )
        # Relevance survives the budget: the ranked id is still present.
        self.assertIn("el_150", [el["id"] for el in evidence["AVAILABLE_ELEMENTS"]])
        # Safety authority and loop memory are never cut.
        self.assertEqual(len(evidence["ALLOWED_ELEMENT_IDS"]), 200)
        self.assertIn("steps=1", evidence["ACTION_HISTORY"])
        # The excerpt cap is honored with an honest omitted count.
        self.assertLessEqual(len(evidence["PAGE_STATE"]["visible_text_excerpt"]), 1500)
        self.assertGreater(evidence["PAGE_STATE"]["visible_text_omitted_chars"], 0)

    def test_plan_step_sends_compact_keys_with_stable_names(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = "unit-test-api-key"
        payload = {"action": {"action": "WAIT"}}
        response = type("Response", (), {
            "status_code": 200,
            "json": lambda self: {"choices": [{"message": {"content": json.dumps(payload)}}]},
        })()
        seen = {}
        real_post = None

        def fake_post(url, headers=None, json=None, timeout=None):
            seen["messages"] = json["messages"]
            return response

        try:
            with patch("gpt_oss_service.requests.post", side_effect=fake_post):
                service.plan_step(
                    "Read the page title",
                    {
                        "elements": [{"id": "el_1", "label": "Title"}],
                        "provenance": "REAL_VLM",
                        "visual_layout_summary": "A centered results list below the search field.",
                        "visual_state_summary": "The result list has loaded.",
                    },
                    [{
                        "action": {"action": "CLICK", "target": {"element_id": "el_9"}},
                        "success": True,
                        "diagnostic": {"post_action_verification": {
                            "status": "OBSERVED_NO_VISIBLE_CHANGE",
                            "visible_state_changed": False,
                            "target_present": True,
                            "target_state_changed": False,
                        }},
                    }],
                    {"intent": "EXTRACT"},
                    {"url": "https://example.test", "provenance": "REAL_VLM"},
                )
        finally:
            settings.API_KEY = previous_key

        user = json.loads(seen["messages"][1]["content"])
        self.assertEqual(user["ORIGINAL_USER_REQUEST"], "Read the page title")
        wrapped = user["UNTRUSTED_WEBPAGE_CONTENT"]
        self.assertTrue(wrapped.startswith("<untrusted_webpage_content>"))
        evidence = json.loads(
            wrapped.split("\n", 1)[1].rsplit("\n", 1)[0]
        )
        for key in ("PAGE_STATE", "ALLOWED_ELEMENT_IDS", "AVAILABLE_ELEMENTS", "ACTION_HISTORY"):
            self.assertIn(key, evidence)
        self.assertEqual(evidence["PAGE_STATE"]["visual_layout"], "A centered results list below the search field.")
        self.assertEqual(evidence["PAGE_STATE"]["visual_state"], "The result list has loaded.")
        self.assertEqual(evidence["PAGE_STATE"]["perception_provenance"], "REAL_VLM")
        # History is a summary string now, carrying the failure signal.
        self.assertIsInstance(evidence["ACTION_HISTORY"], str)
        self.assertIn("consecutive_failures=0", evidence["ACTION_HISTORY"])
        self.assertIn("post_action_verification", evidence["ACTION_HISTORY"])
        self.assertIn("visible_state_changed=False", evidence["ACTION_HISTORY"])


class UploadGroundingTests(unittest.TestCase):
    """The backend half of the stored-document invariant.

    The extension re-checks this before anything is executed, but the planner
    should never forward an upload the user never authorized in the first
    place: an ``UPLOAD`` that does not name one of the user's own stored
    documents is an invented handle, not a file the user chose.
    """

    def _repair(self, action, stored_documents):
        sys.path.insert(0, str(ROOT / "backend"))
        from gpt_oss_service import _repair_action
        parsed = {"action": action}
        return _repair_action(parsed, {"el_file"}, None, {"elements": []}, stored_documents)

    def test_upload_naming_a_stored_document_is_forwarded(self):
        result = self._repair(
            {"action": "UPLOAD", "target": {"element_id": "el_file"}, "value_source": "LOCAL_DOCUMENT_AADHAAR"},
            ["LOCAL_DOCUMENT_AADHAAR"],
        )
        self.assertEqual(result["action"]["action"], "UPLOAD")
        self.assertEqual(result["action"]["value_source"], "LOCAL_DOCUMENT_AADHAAR")

    def test_upload_naming_anything_else_is_downgraded(self):
        for action in (
            {"action": "UPLOAD", "target": {"element_id": "el_file"}},
            {"action": "UPLOAD", "target": {"element_id": "el_file"}, "value_source": "LOCAL_DOCUMENT_PASSPORT"},
            {"action": "UPLOAD", "target": {"element_id": "el_file"}, "value_source": "/home/me/passport.pdf"},
            {"action": "UPLOAD", "target": {"element_id": "el_file"}, "value": "file:///etc/passwd"},
            {"action": "UPLOAD", "target": {"element_id": "el_file"}, "value_source": "LOCAL_PAN"},
        ):
            with self.subTest(action=action):
                result = self._repair(action, ["LOCAL_DOCUMENT_AADHAAR"])
                self.assertEqual(result["action"]["action"], "WAIT")
                self.assertIn("STORED_DOCUMENTS", result["thought"])

    def test_stored_document_tokens_are_validated_server_side(self):
        from agentic.context import build_page_evidence
        evidence = build_page_evidence(
            {"elements": []}, {"url": "https://example.test"}, set(), [],
            ["LOCAL_DOCUMENT_AADHAAR", "../../etc/passwd", "LOCAL_AADHAAR", "LOCAL_DOCUMENT_aadhar"],
        )
        self.assertEqual(evidence["STORED_DOCUMENTS"], ["LOCAL_DOCUMENT_AADHAAR"])


if __name__ == "__main__":
    unittest.main()
