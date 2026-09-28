import pathlib
import sys
import unittest
import json
from unittest.mock import patch
from requests.exceptions import Timeout
from starlette.responses import JSONResponse

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
            # The action type may ride in the message or in a structured
            # `extra` field, so assert against the records rather than the
            # rendered text. What this guards is that the record exists at all:
            # without it the assertNotIn below would pass vacuously.
            self.assertTrue(
                any('TYPE' in str(getattr(r, 'msg', '')) or getattr(r, 'action_type', None) == 'TYPE'
                    for r in captured.records),
                'plan_step did not record the resolved action type',
            )
            self.assertNotIn(sentinel, output)
            # Structured fields are written to the JSONL file, so they are a
            # log sink too and must be held to the same rule as the message.
            self.assertNotIn(sentinel, repr([r.__dict__ for r in captured.records]))
        finally:
            settings.API_KEY = previous_key

    # --- Request guard middleware -------------------------------------------------
    #
    # The guard is a pure ASGI middleware, so it is driven the way a server would
    # drive it: a scope in, a send collector out. Asserting on the downstream
    # "was it reached" flag is what makes these boundary tests meaningful — a
    # rejected request must never reach a model endpoint.

    @staticmethod
    def _drive(path, headers, method='POST', client=('test-client', 1234)):
        """Run one request through RequestGuardMiddleware; return (status, reached, body)."""
        import asyncio

        reached = []
        sent = []

        async def downstream(scope, receive, send):
            reached.append(True)
            await JSONResponse({'detail': 'reached'}, status_code=200)(scope, receive, send)

        async def send(message):
            sent.append(message)

        async def receive():
            return {'type': 'http.request', 'body': b'{}', 'more_body': False}

        raw_headers = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
        scope = {
            'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(),
            'query_string': b'', 'headers': raw_headers,
            'server': ('test', 80), 'client': client, 'scheme': 'http',
        }
        asyncio.run(server.RequestGuardMiddleware(downstream)(scope, receive, send))
        status = next((m['status'] for m in sent if m['type'] == 'http.response.start'), None)
        return status, bool(reached)

    def test_model_routes_reject_webpage_origin(self):
        status, reached = self._drive('/vision', {'origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        self.assertFalse(reached, 'a webpage-originated call must not reach the endpoint')

    def test_model_routes_require_a_valid_extension_origin_shape(self):
        # Origin shape is necessary but not sufficient: a valid-looking origin
        # still has to present the shared secret.
        for origin in ('chrome-extension://' + 'a' * 32, 'moz-extension://0123abcd-0123-0123-0123-0123456789ab'):
            status, reached = self._drive('/reason', {'origin': origin})
            self.assertEqual(status, 401, f'{origin} without a token must be rejected')
            self.assertFalse(reached)

    def test_model_routes_reject_a_missing_or_wrong_shared_secret(self):
        origin = 'chrome-extension://' + 'a' * 32
        with patch.object(server.settings, 'BACKEND_SHARED_SECRET', 's' * 32):
            status, reached = self._drive('/vision', {'origin': origin, 'x-privagent-token': 'wrong' + 's' * 26})
            self.assertEqual(status, 401)
            self.assertFalse(reached)

            status, reached = self._drive('/vision', {'origin': origin, 'x-privagent-token': 's' * 32})
            self.assertEqual(status, 200)
            self.assertTrue(reached, 'a correctly authenticated call must be allowed through')

    def test_model_routes_fail_closed_when_no_secret_is_configured(self):
        # A deployment that forgot to set BACKEND_SHARED_SECRET must not fall
        # open to unauthenticated callers.
        origin = 'chrome-extension://' + 'a' * 32
        with patch.object(server.settings, 'BACKEND_SHARED_SECRET', ''):
            status, reached = self._drive('/vision', {'origin': origin})
            self.assertEqual(status, 503)
            self.assertFalse(reached)

    def test_model_routes_reject_an_oversized_declared_body(self):
        origin = 'chrome-extension://' + 'a' * 32
        with patch.object(server.settings, 'BACKEND_SHARED_SECRET', 's' * 32):
            status, reached = self._drive(
                '/vision',
                {'origin': origin, 'x-privagent-token': 's' * 32, 'content-length': str(64 * 1024 * 1024)},
            )
            self.assertEqual(status, 413)
            self.assertFalse(reached)

    def test_repeated_calls_from_one_client_are_rate_limited(self):
        # The bucket is per client address, so a caller cannot spend an
        # unmetered provider key by simply authenticating correctly.
        origin = 'chrome-extension://' + 'a' * 32
        client = ('rate-limit-client', 5555)
        server._rate_buckets.pop(client[0], None)
        with patch.object(server.settings, 'BACKEND_SHARED_SECRET', 's' * 32):
            headers = {'origin': origin, 'x-privagent-token': 's' * 32}
            allowed = 0
            limited = 0
            for _ in range(int(server._BUCKET_CAPACITY) + 5):
                status, reached = self._drive('/reason', headers, client=client)
                if status == 200 and reached:
                    allowed += 1
                elif status == 429:
                    limited += 1
        server._rate_buckets.pop(client[0], None)
        self.assertEqual(allowed, int(server._BUCKET_CAPACITY),
                         'the bucket must allow exactly its capacity before throttling')
        self.assertGreater(limited, 0, 'requests beyond the capacity must be throttled')

    def test_non_model_routes_are_not_guarded(self):
        status, reached = self._drive('/health', {}, method='GET')
        self.assertEqual(status, 200)
        self.assertTrue(reached)

    def test_trailing_slash_cannot_bypass_the_model_endpoint_guard(self):
        status, reached = self._drive('/reason/', {'origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        self.assertFalse(reached)


if __name__ == '__main__':
    unittest.main()
