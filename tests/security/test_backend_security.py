import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

from vlm_service import VLMService
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
