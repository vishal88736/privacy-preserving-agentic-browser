import pathlib
import sys
import unittest
import json
from unittest.mock import patch
from requests.exceptions import Timeout

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

from vlm_service import VLMService, VLMProviderRotator
from gpt_oss_service import GPTOSSService
from config import settings
import server


class BackendBoundaryTests(unittest.TestCase):
    def test_legacy_agent_routes_are_not_mounted(self):
        paths = {route.path for route in server.app.routes}
        self.assertNotIn('/agent/execute', paths)
        self.assertNotIn('/agent/execute/stream', paths)

    def test_vlm_rejects_malformed_and_unredacted_dom(self):
        service = VLMService()
        with self.assertRaises(ValueError):
            service.process_visuals('t', 'raw bytes', {'elements': []}, {})
        with self.assertRaises(ValueError):
            service.process_visuals('t', 'data:image/png;base64,AA==', {'visible_text': 'x@example.com', 'elements': []}, {})

    def test_vlm_rejects_unredacted_card_and_ifsc_values(self):
        service = VLMService()
        for value in ('Card 4532015000000007', 'IFSC SBIN0001234', 'ifsc sbin0001234'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                service.process_visuals('t', 'data:image/png;base64,AA==', {'visible_text': value, 'elements': []}, {})

    def test_heuristic_provenance_is_explicit(self):
        service = VLMService()
        previous_key = settings.API_KEY
        settings.API_KEY = ''
        try:
            result = service.process_visuals('t', 'data:image/png;base64,AA==', {'elements': [], 'visible_text': 'safe'}, {})
            self.assertEqual(result['provenance'], 'DOM_PLUS_HEURISTIC')
            self.assertEqual(result['grounding_source'], 'dom_heuristic')
        finally:
            settings.API_KEY = previous_key

    def test_vlm_429_keeps_heuristic_provenance(self):
        service = VLMService()
        previous_key = settings.API_KEY
        previous_model = settings.VLM_MODEL
        settings.API_KEY = 'test-key'
        settings.VLM_MODEL = 'test/vision-model'
        response = type('Response', (), {'status_code': 429})()
        try:
            with patch('vlm_service.requests.post', return_value=response):
                result = service.process_visuals('t', 'data:image/png;base64,AA==', {'elements': [], 'visible_text': 'safe'}, {})
            self.assertEqual(result['provenance'], 'DOM_PLUS_HEURISTIC')
            self.assertEqual(result['grounding_source'], 'dom_heuristic')
        finally:
            settings.API_KEY = previous_key
            settings.VLM_MODEL = previous_model

    def test_vlm_provider_tokens_rotate_and_fail_over_across_providers(self):
        previous = {
            name: getattr(settings, name)
            for name in (
                'API_KEY', 'OPENROUTER_API_KEYS', 'HUGGINGFACE_API_KEYS', 'GROQ_API_KEYS',
                'VLM_PROVIDER_ORDER', 'VLM_MAX_ATTEMPTS', 'VLM_MODEL',
                'VLM_OPENROUTER_MODEL', 'VLM_HUGGINGFACE_MODEL', 'VLM_GROQ_MODEL'
            )
        }
        settings.API_KEY = 'test-master-key'
        settings.OPENROUTER_API_KEYS = ('or-test-1', 'or-test-2')
        settings.HUGGINGFACE_API_KEYS = ('hf-test-1',)
        settings.GROQ_API_KEYS = ('gq-test-1',)
        settings.VLM_PROVIDER_ORDER = 'openrouter,huggingface,groq'
        settings.VLM_MAX_ATTEMPTS = 3
        settings.VLM_MODEL = 'test/default-vision'
        settings.VLM_OPENROUTER_MODEL = 'test/openrouter-vision'
        settings.VLM_HUGGINGFACE_MODEL = 'test/hf-vision'
        settings.VLM_GROQ_MODEL = 'test/groq-vision'
        responses = [
            type('Response', (), {'status_code': 429})(),
            type('Response', (), {'status_code': 429})(),
            type('Response', (), {
                'status_code': 200,
                'json': lambda self: {'choices': [{'message': {'content': '{"spatial_layout":"layout ok"}'}}]}
            })(),
        ]
        calls = []

        def fake_post(url, **kwargs):
            calls.append((url, kwargs))
            return responses.pop(0)

        try:
            with patch('vlm_service.requests.post', side_effect=fake_post):
                result = VLMService().process_visuals(
                    't', 'data:image/png;base64,AA==', {'elements': [], 'visible_text': 'safe'}, {}
                )
            self.assertEqual(result['provenance'], 'DOM_PLUS_REAL_VLM')
            self.assertEqual(calls[0][0], 'https://openrouter.ai/api/v1/chat/completions')
            self.assertEqual(calls[0][1]['headers']['Authorization'], 'Bearer or-test-1')
            self.assertEqual(calls[1][0], 'https://openrouter.ai/api/v1/chat/completions')
            self.assertEqual(calls[1][1]['headers']['Authorization'], 'Bearer or-test-2')
            self.assertEqual(calls[2][0], 'https://router.huggingface.co/v1/chat/completions')
            self.assertEqual(calls[2][1]['headers']['Authorization'], 'Bearer hf-test-1')
            self.assertEqual(calls[2][1]['json']['model'], 'test/hf-vision')
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_vlm_provider_rotator_round_robins_keys_and_providers(self):
        previous = {
            name: getattr(settings, name)
            for name in ('OPENROUTER_API_KEYS', 'HUGGINGFACE_API_KEYS', 'GROQ_API_KEYS', 'VLM_PROVIDER_ORDER', 'VLM_MAX_ATTEMPTS')
        }
        settings.OPENROUTER_API_KEYS = ('or-a', 'or-b')
        settings.HUGGINGFACE_API_KEYS = ()
        settings.GROQ_API_KEYS = ('gq-a',)
        settings.VLM_PROVIDER_ORDER = 'openrouter,groq'
        settings.VLM_MAX_ATTEMPTS = 1
        try:
            rotator = VLMProviderRotator()
            ordered = [rotator.ordered_candidates()[0] for _ in range(3)]
            self.assertEqual([entry['key'] for entry in ordered], ['or-a', 'or-b', 'gq-a'])
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_vlm_timeout_falls_back_without_serial_provider_waits(self):
        previous = {
            name: getattr(settings, name)
            for name in ('API_KEY', 'OPENROUTER_API_KEYS', 'HUGGINGFACE_API_KEYS', 'GROQ_API_KEYS', 'VLM_PROVIDER_ORDER', 'VLM_MAX_ATTEMPTS')
        }
        settings.API_KEY = 'test-master-key'
        settings.OPENROUTER_API_KEYS = ('or-test',)
        settings.HUGGINGFACE_API_KEYS = ('hf-test',)
        settings.GROQ_API_KEYS = ('gq-test',)
        settings.VLM_PROVIDER_ORDER = 'openrouter,huggingface,groq'
        settings.VLM_MAX_ATTEMPTS = 3
        try:
            with patch('vlm_service.requests.post', side_effect=Timeout) as post, patch('vlm_service.settings.VLM_REQUEST_TIMEOUT_SECONDS', 1):
                result = VLMService().process_visuals(
                    't', 'data:image/png;base64,AA==', {'elements': [], 'visible_text': 'safe'}, {}
                )
            self.assertEqual(result['provenance'], 'DOM_PLUS_HEURISTIC')
            self.assertEqual(post.call_count, 1)
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_prompt_derived_text_is_not_written_to_plan_step_logs(self):
        service = GPTOSSService()
        previous_key = settings.API_KEY
        settings.API_KEY = 'test-key'
        sentinel = 'Synthetic-Private-Name-Log-Check'
        model_result = {
            'thought': sentinel,
            'action': {'action': 'TYPE', 'target': {'element_id': 'el_1'}, 'value': sentinel}
        }
        response = type('Response', (), {
            'status_code': 200,
            'json': lambda self: {'choices': [{'message': {'content': json.dumps(model_result)}}]}
        })()
        try:
            with patch('gpt_oss_service.requests.post', return_value=response), self.assertLogs('gpt_oss_service', level='INFO') as captured:
                service.plan_step(
                    sentinel,
                    {'elements': [{'id': 'el_1'}]},
                    [],
                    {'intent': 'FILL_FORM'},
                    None
                )
            output = '\n'.join(captured.output)
            self.assertIn('action_type=TYPE', output)
            self.assertNotIn(sentinel, output)
        finally:
            settings.API_KEY = previous_key

    def test_model_routes_reject_webpage_origin(self):
        import asyncio
        from starlette.requests import Request
        scope = {
            'type': 'http', 'method': 'POST', 'path': '/vision', 'raw_path': b'/vision',
            'query_string': b'', 'headers': [(b'origin', b'https://evil.example')],
            'server': ('test', 80), 'client': ('test', 1234), 'scheme': 'http',
        }
        called = []
        async def call_next(_request):
            called.append(True)
            return None
        response = asyncio.run(server.require_extension_origin(Request(scope), call_next))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(called, [])


if __name__ == '__main__':
    unittest.main()
