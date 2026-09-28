"""Contracts for the adapted TheAgenticBrowser Planner + Critique loop."""

import json
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from agentic.critic import assess_termination, build_critic_messages, parse_critic_output
from agentic.orchestrator import compose_reasoning_messages
from agentic.planner import build_planner_messages, parse_planner_output
from agentic.prompts import (
    ACTION_CONTRACT_PROMPT,
    CRITIC_SYSTEM_PROMPT,
    PLANNER_SYSTEM_PROMPT,
    UNIVERSAL_TASK_PROMPT,
)
from agentic.schemas import CritiqueOutput, StepReasoning
from config import settings
from gpt_oss_service import GPTOSSService


class AgenticLoopTests(unittest.TestCase):
    def test_message_builders_use_sanitized_observation_and_delta_fields(self):
        safe_observation = {
            "elements": [{
                "id": "el_email",
                "label": "Email address",
                "value": "[REDACTED_EMAIL]",
                "value_source": "LOCAL_EMAIL",
            }]
        }
        planner_messages = build_planner_messages(
            "Open the account page", "Open account page", "", safe_observation, [], "https://example.test"
        )
        self.assertEqual(planner_messages[0]["content"], PLANNER_SYSTEM_PROMPT)
        planner_user = json.loads(planner_messages[-1]["content"])
        self.assertEqual(planner_user["SANITIZED_OBSERVATION"], safe_observation)
        self.assertIn("[REDACTED_EMAIL]", planner_messages[-1]["content"])
        self.assertIn("LOCAL_EMAIL", planner_messages[-1]["content"])
        self.assertNotIn("Synthetic-Raw-Email", planner_messages[-1]["content"])

        critic_messages = build_critic_messages(
            "Open account page", "Click account", {"success": True}, "The URL changed to the account page."
        )
        self.assertEqual(critic_messages[0]["content"], CRITIC_SYSTEM_PROMPT)
        critic_user = json.loads(critic_messages[-1]["content"])
        self.assertIn("observation_delta", critic_user)
        self.assertNotIn("ss_analysis", critic_user)
        self.assertNotIn("screenshot", critic_messages[-1]["content"].lower())

    def test_planner_rejects_empty_next_step_and_critic_coerces_bare_terminate(self):
        with self.assertRaisesRegex(ValueError, "no next_step"):
            parse_planner_output('{"plan":"Search the catalog","next_step":"  "}')

        critique = parse_critic_output('{"feedback":"No answer was gathered.","terminate":true}')
        self.assertFalse(critique.terminate)
        self.assertEqual(critique.final_response, "")

    def test_termination_backstop_trips_at_three_consecutive_failures(self):
        critic = CritiqueOutput(feedback="Still no progress.", terminate=False, final_response="")
        two_failures = assess_termination([{"success": False}, {"success": False}], critic)
        three_failures = assess_termination(
            [{"success": False}, {"success": False}, {"success": False}], critic
        )
        self.assertFalse(two_failures["terminate"])
        self.assertTrue(three_failures["terminate"])
        self.assertEqual(three_failures["consecutive_failures"], 3)

    def test_composition_uses_one_universal_prompt_and_preserves_user_payload(self):
        user_content = '{"ORIGINAL_USER_REQUEST":"read the page title"}'
        messages = compose_reasoning_messages(user_content)
        self.assertEqual(messages, [
            {"role": "system", "content": UNIVERSAL_TASK_PROMPT},
            {"role": "user", "content": user_content},
        ])
        self.assertNotIn(PLANNER_SYSTEM_PROMPT, messages[0]["content"])
        self.assertNotIn(CRITIC_SYSTEM_PROMPT, messages[0]["content"])
        self.assertNotIn(ACTION_CONTRACT_PROMPT, messages[0]["content"])

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
        self.assertIn("Never emit UPLOAD", ACTION_CONTRACT_PROMPT)
        self.assertNotIn("SUBMIT | UPLOAD |", ACTION_CONTRACT_PROMPT)

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


if __name__ == "__main__":
    unittest.main()
