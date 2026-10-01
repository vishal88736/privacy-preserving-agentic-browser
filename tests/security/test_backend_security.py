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
from privacy_rules import find_sensitive_category
import server


class BackendBoundaryTests(unittest.TestCase):
    def test_page_dates_and_order_references_do_not_trigger_ambiguous_pii_rules(self):
        examples = (
            'Book a flight from Delhi to Mumbai departing 12/03/2025',
            'Deliver on 12/03/2025 please',
            'Order reference 482173920184',
        )
        for text in examples:
            with self.subTest(text=text):
                self.assertIsNone(find_sensitive_category(text))
        self.assertEqual(find_sensitive_category('Date of birth: 12/03/1990'), 'DOB')
        self.assertEqual(find_sensitive_category('Aadhaar number: 482173920184'), 'AADHAAR')
        self.assertEqual(find_sensitive_category('482173920184'), 'AADHAAR')
        self.assertEqual(find_sensitive_category('Aadhaar order reference: 482173920184'), 'AADHAAR')

    def test_backend_privacy_rejection_has_a_distinct_error_code(self):
        req = server.ReasonRequest(
            task='Questions? Email support@example.com',
            fused_observation={'elements': []},
            task_history=[],
        )
        previous_key = settings.API_KEY
        settings.API_KEY = 'unit-test-api-key'
        try:
            with self.assertRaises(Exception) as raised:
                server.process_reason(req)
        finally:
            settings.API_KEY = previous_key
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.detail['code'], 'OUTBOUND_PRIVACY_BLOCK')

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

    def test_vision_boundary_accepts_a_complete_audit_and_rejects_inconsistent_audits(self):
        good = {
            'status': 'masked', 'coverage': 'complete', 'withheld': False,
            'local_model_completed': True, 'ocr_completed': True,
            'regions': [{'category': 'PASSWORD', 'x': 1, 'y': 2,
                         'width': 10, 'height': 12, 'method': 'dom'}],
            'detected_categories': ['PASSWORD'],
        }
        def request(audit, *, top_level=False, conflicting=False):
            metadata = {'redaction_audit': {**audit, **({'coverage': 'unknown'} if conflicting else {})}}
            return server.VisionRequest(
                task_id='t', sanitized_screenshot='data:image/png;base64,AA==',
                sanitized_dom={'elements': []},
                redaction_audit=(server.RedactionAudit(**audit) if top_level else None),
                metadata=metadata)
        with patch.object(server.vlm_service, 'process_visuals', return_value={'provenance': 'DOM_PLUS_HEURISTIC'}) as process:
            self.assertEqual(server.process_vision(request(good))['status'], 'success')
            self.assertEqual(server.process_vision(request(good, top_level=True))['status'], 'success')
            with self.assertRaises(Exception) as raised:
                server.process_vision(request(good, top_level=True, conflicting=True))
            self.assertEqual(raised.exception.status_code, 400)
            self.assertIn('disagree', raised.exception.detail)
            for change in ({'status': 'withheld'}, {'status': 'unknown'}, {'coverage': 'partial'},
                           {'ocr_completed': False}, {'regions': []}):
                with self.subTest(change=change):
                    with self.assertRaises(Exception) as raised:
                        server.process_vision(request({**good, **change}))
                    self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(process.call_count, 2, 'a rejected screenshot must never reach a VLM')

    def test_vision_boundary_accepts_the_geometry_real_pages_actually_produce(self):
        """Regression: the audit schema must accept the regions the extension really sends.

        content.js bboxOf() returns raw getBoundingClientRect() values with no
        clamping, so a field scrolled above the viewport has a negative y, a
        field inside a horizontally-scrolled container has a negative x, and a
        display:none file input is deliberately retained despite not being
        rendered -- giving a 0x0 box. An earlier ge=0 / gt=0 schema rejected
        all three with HTTP 400, so /vision never ran for nearly every login or
        upload page and the client silently degraded to DOM_ONLY.
        """
        real_world = {
            'status': 'masked', 'coverage': 'complete', 'withheld': False,
            'local_model_completed': True, 'ocr_completed': True,
            'regions': [
                # A sensitive field scrolled above the viewport.
                {'category': 'EMAIL', 'x': 20, 'y': -480.0, 'width': 300.0, 'height': 24.0, 'method': 'dom'},
                # A field inside a horizontally-scrolled container.
                {'category': 'PAN', 'x': -30.0, 'y': 100.0, 'width': 200.0, 'height': 20.0, 'method': 'ocr'},
                # A display:none file input, retained on purpose by content.js.
                {'category': 'AADHAAR', 'x': 0.0, 'y': 0.0, 'width': 0.0, 'height': 0.0, 'method': 'dom'},
            ],
            'detected_categories': ['EMAIL', 'PAN', 'AADHAAR'],
        }
        request = server.VisionRequest(
            task_id='t', sanitized_screenshot='data:image/png;base64,AA==',
            sanitized_dom={'elements': []}, metadata={'redaction_audit': real_world})

        with patch.object(server.vlm_service, 'process_visuals', return_value={'provenance': 'DOM_PLUS_REAL_VLM'}) as process:
            result = server.process_vision(request)
        self.assertEqual(result['status'], 'success')
        self.assertEqual(process.call_count, 1, 'real page geometry must not cost us the VLM')

        # A dense page may legitimately mask more regions than the old 256 cap.
        dense = {**real_world, 'regions': [
            {'category': 'OTP', 'x': 1.0, 'y': 2.0, 'width': 10.0, 'height': 10.0, 'method': 'ocr'}
        ] * 400}
        with patch.object(server.vlm_service, 'process_visuals', return_value={'provenance': 'DOM_PLUS_REAL_VLM'}) as process:
            server.process_vision(server.VisionRequest(
                task_id='t', sanitized_screenshot='data:image/png;base64,AA==',
                sanitized_dom={'elements': []}, metadata={'redaction_audit': dense}))
        self.assertEqual(process.call_count, 1, 'a dense page must not be rejected on region count alone')

    def test_vision_provider_can_run_without_a_reasoning_key(self):
        service = VLMService()
        candidate = {'provider': 'OpenRouter', 'model': 'test/vision-model',
                     'key': 'vision-key', 'url': 'https://example.test/chat/completions'}
        response = type('Response', (), {
            'status_code': 200,
            'json': lambda self: {'choices': [{'message': {'content': '{"spatial_layout":"Visible form"}'}}]}
        })()
        with patch.object(settings, 'API_KEY', ''), \
             patch.object(service.provider_rotator, 'ordered_candidates', return_value=[candidate]), \
             patch('vlm_service.requests.post', return_value=response) as post:
            result = service.process_visuals('t', 'data:image/png;base64,AA==', {'elements': []},
                                             {'visual_query': 'What is shown?'})
        self.assertEqual(result['provenance'], 'DOM_PLUS_REAL_VLM')
        text = post.call_args.kwargs['json']['messages'][0]['content'][0]
        self.assertEqual(text['type'], 'text')
        self.assertIn('What is shown?', text['text'])
        self.assertEqual(set(text), {'type', 'text'}, 'do not send nonstandard fields to the OpenAI-compatible API')

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

    def test_dom_layout_annotations_are_not_reported_as_visual_detections(self):
        result = VLMService()._from_dom({
            'elements': [{
                'id': 'el_1', 'tag': 'button', 'label': 'Search',
                'bbox': [10, 20, 80, 30], 'is_interactive': True
            }]
        }, {})
        self.assertEqual(result['detected_elements'], [])
        self.assertEqual(result['dom_annotations_provenance'], 'DOM')
        self.assertEqual(result['dom_annotations'][0]['element_id'], 'el_1')
        self.assertNotIn('confidence', result['dom_annotations'][0])

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


class TestVisionFailureIsReported(unittest.TestCase):
    """A dead vision provider must not look like a working one.

    Falling back to the DOM heuristic is correct behaviour, but reporting it as
    an ordinary DOM_PLUS_HEURISTIC result makes a wrong model id or an
    exhausted rate limit indistinguishable from a page that simply had nothing
    visual to say. The reason has to travel with the response.
    """

    def _dom(self):
        return {
            "url": "https://example.test/",
            "title": "Example",
            "elements": [],
            "headings": [],
            "visible_text": "hello",
        }

    def _screenshot(self):
        # 1x1 transparent PNG.
        return ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
                "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

    def test_total_provider_failure_is_reported_not_hidden(self):
        from vlm_service import VLMService
        from config import settings

        service = VLMService()
        original = service._try_real_vlm
        # Every provider is unavailable.
        service._try_real_vlm = lambda *a, **k: {
            "failure": {
                "attempts": [{"provider": "groq", "model": "qwen/qwen3.8-27b", "reason": "http_429"}],
                "reason": "groq/qwen/qwen3.8-27b: http_429",
                "provider": "groq",
                "model": "qwen/qwen3.8-27b",
            }
        }
        try:
            out = service.process_visuals("t1", self._screenshot(), self._dom(), {})
        finally:
            service._try_real_vlm = original

        self.assertEqual(out["provenance"], "DOM_PLUS_HEURISTIC")
        self.assertNotEqual(
            out.get("grounding_source"), "vision_model",
            "a failed rotation must not claim vision grounding",
        )
        self.assertIn("vision_unavailable", out)
        self.assertEqual(out["vision_unavailable"]["reason"], "groq/qwen/qwen3.8-27b: http_429")
        self.assertEqual(out["model_trace"]["source"], "unavailable")
        self.assertEqual(out["model_trace"]["model"], "qwen/qwen3.8-27b")

    def test_health_reports_the_effective_first_vision_model(self):
        import importlib
        server = importlib.import_module("server")
        # Patch the rotator instead of calling the real ordered_candidates().
        # The previous version called the same function the endpoint calls and
        # then asserted equality with its result, so it could only fail if
        # health_check stopped consulting the rotator at all -- it could not
        # catch the endpoint reporting the wrong model. Worse,
        # ordered_candidates() ADVANCES the round-robin cursor, so the old test
        # mutated shared rotator state and was order-dependent.
        with patch.object(server.vlm_service.provider_rotator, 'ordered_candidates',
                          return_value=[{'provider': 'Groq', 'model': 'qwen/effective-first'},
                                        {'provider': 'Groq', 'model': 'qwen/second'}]):
            body = server.health_check()
        self.assertEqual(body['models']['vlm'], 'qwen/effective-first',
                         'health must name the model actually tried first')

        # And when the rotator raises, diagnostics must still answer.
        with patch.object(server.vlm_service.provider_rotator, 'ordered_candidates',
                          side_effect=RuntimeError('rotator unreadable')):
            body = server.health_check()
        self.assertEqual(body['status'], 'healthy')
        self.assertIn('vlm', body['models'])
        self.assertIn('vlm_providers', body)


class TestVisionRotationAccumulatesRealFailures(unittest.TestCase):
    """Drive the real rotation loop; do not mock the unit under test.

    The companion test above replaces _try_real_vlm with a literal dict, so it
    proves only that process_visuals propagates a failure it was handed. Delete
    the whole failures/accumulation block in vlm_service and that test still
    passes. These cases patch requests.post instead, so they fail if the
    accumulation, the per-candidate attribution, or the final `if failures`
    return ever regresses.
    """

    def _dom(self):
        return {"url": "https://example.test/", "title": "Example",
                "elements": [], "headings": [], "visible_text": "hello"}

    def _screenshot(self):
        return ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
                "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

    def _service_with_candidates(self, candidates):
        from vlm_service import VLMService
        service = VLMService()
        service.provider_rotator.ordered_candidates = lambda: list(candidates)
        return service

    def _post_returning(self, response):
        class _Resp:
            status_code = response["status_code"]

            @staticmethod
            def json():
                return response.get("json", {})
        return _Resp()

    def test_http_error_rotation_is_recorded_per_candidate(self):
        import requests
        service = self._service_with_candidates([
            {"provider": "groq", "model": "qwen/vision-1", "key": "k1", "url": "https://a.test/v1/chat/completions"},
            {"provider": "hf", "model": "qwen/vision-2", "key": "k2", "url": "https://b.test/v1/chat/completions"},
        ])
        calls = []

        def fake_post(url, **kwargs):
            calls.append(kwargs.get("headers", {}).get("Authorization"))
            return self._post_returning({"status_code": 429})

        with patch.object(requests, "post", side_effect=fake_post):
            out = service.process_visuals("t", self._screenshot(), self._dom(), {})

        self.assertIn("vision_unavailable", out, "a total rotation failure must be reported")
        failure = out["vision_unavailable"]
        self.assertEqual(len(failure["attempts"]), 2, "both candidates must be recorded")
        self.assertEqual(failure["attempts"][0]["provider"], "groq")
        self.assertEqual(failure["attempts"][0]["reason"], "http_429")
        self.assertEqual(failure["attempts"][1]["provider"], "hf")
        # Per-candidate attribution must be correct, not carried over.
        self.assertNotEqual(failure["attempts"][0]["model"], failure["attempts"][1]["model"])
        self.assertNotEqual(out.get("grounding_source"), "vision_model")
        self.assertEqual(len(calls), 2, "both credentials must actually be tried")

    def test_empty_content_and_non_json_are_distinguished(self):
        import requests
        service = self._service_with_candidates([
            {"provider": "groq", "model": "qwen/vision-1", "key": "k1", "url": "https://a.test/v1/chat/completions"},
            {"provider": "hf", "model": "qwen/vision-2", "key": "k2", "url": "https://b.test/v1/chat/completions"},
        ])
        responses = [
            self._post_returning({"status_code": 200, "json": {"choices": [{"message": {"content": "  "}}]}}),
            self._post_returning({"status_code": 200, "json": {"choices": [{"message": {"content": "not json at all"}}]}}),
        ]
        with patch.object(requests, "post", side_effect=responses):
            out = service.process_visuals("t", self._screenshot(), self._dom(), {})

        reasons = [a["reason"] for a in out["vision_unavailable"]["attempts"]]
        self.assertEqual(reasons, ["empty_content", "non_json"])

    def test_a_timeout_stops_the_rotation_but_still_reports(self):
        import requests
        service = self._service_with_candidates([
            {"provider": "groq", "model": "qwen/vision-1", "key": "k1", "url": "https://a.test/v1/chat/completions"},
            {"provider": "hf", "model": "qwen/vision-2", "key": "k2", "url": "https://b.test/v1/chat/completions"},
        ])

        def fake_post(*a, **k):
            raise requests.exceptions.Timeout("upstream timed out")

        with patch.object(requests, "post", side_effect=fake_post):
            out = service.process_visuals("t", self._screenshot(), self._dom(), {})

        reasons = [a["reason"] for a in out["vision_unavailable"]["attempts"]]
        self.assertEqual(reasons, ["timeout"])
        # A timeout is terminal for the request: do not keep burning credentials.
        self.assertEqual(len(reasons), 1, "a timeout must not fan out to every remaining candidate")

    def test_a_working_provider_still_wins_and_reports_no_failure(self):
        import requests
        service = self._service_with_candidates([
            {"provider": "groq", "model": "qwen/vision-1", "key": "k1", "url": "https://a.test/v1/chat/completions"},
            {"provider": "hf", "model": "qwen/vision-2", "key": "k2", "url": "https://b.test/v1/chat/completions"},
        ])
        good = {"choices": [{"message": {"content": (
            '{"spatial_layout": "two columns", "visual_state": "idle", "page_type": "form"}'
        )}}]}

        def fake_post(*a, **k):
            return self._post_returning({"status_code": 200, "json": good})

        with patch.object(requests, "post", side_effect=fake_post):
            out = service.process_visuals("t", self._screenshot(), self._dom(), {})

        self.assertNotIn("vision_unavailable", out, "a success must not be reported as a failure")
        self.assertEqual(out.get("grounding_source"), "vision_model")
        self.assertEqual(out.get("provenance"), "DOM_PLUS_REAL_VLM")

    def test_no_configured_provider_is_reported_not_silently_healthy(self):
        service = self._service_with_candidates([])
        out = service.process_visuals("t", self._screenshot(), self._dom(), {})
        self.assertIn("vision_unavailable", out)
        self.assertEqual(out["vision_unavailable"]["reason"], "no_provider_configured")
        self.assertNotEqual(out.get("grounding_source"), "vision_model")
