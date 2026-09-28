"""Tests for backend/logging_config.py.

The privacy assertions are the substance of this file. A redaction regression in
a logger does not raise: it writes a live provider key or a page value into a
file that the README invites people to attach to a bug report. The formatting
tests exist to keep the JSONL contract (one object per line) honest.
"""

import json
import logging
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

import logging_config
from logging_config import (
    ConsoleFormatter,
    JsonLinesFormatter,
    configure_logging,
    log_dir,
    log_file_path,
    redact,
    uvicorn_log_config,
)


def make_record(msg='hello', level=logging.INFO, args=(), exc_info=None, **extra):
    record = logging.LogRecord(
        name='test', level=level, pathname=__file__, lineno=10,
        msg=msg, args=args, exc_info=exc_info, func='fn',
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


class RedactionTests(unittest.TestCase):
    """A log file that can leak a credential is worse than no log file."""

    def test_provider_key_shapes_are_removed(self):
        for secret in (
            'sk-or-v1-abcdefghijklmnopqrstuvwx',
            'sk-proj-abcdefghijklmnopqrst',
            'gsk_ABCDEFGHIJKLMNOPQRST',
            'hf_abcdefghijklmnopqrstuvwxyz01',
            'pk-live-abcdefghij1234',
        ):
            out = redact(f'provider call failed using {secret}')
            self.assertNotIn(secret, out)
            self.assertIn('[REDACTED_API_KEY]', out)

    def test_bearer_and_assigned_secrets_are_removed(self):
        self.assertEqual(
            redact('Authorization: Bearer abcdef0123456789xyz'),
            'Authorization: [REDACTED_BEARER_TOKEN]',
        )
        self.assertEqual(redact('password: hunter2xyz'), 'password: [REDACTED_ASSIGNED_SECRET]')

    def test_pii_collapses_to_its_category(self):
        out = redact('the form held aadhaar 2345 6789 0123')
        self.assertNotIn('2345', out)
        self.assertIn('AADHAAR', out)

        out = redact('reach me at synthetic.person@example.invalid')
        self.assertNotIn('example.invalid', out)
        self.assertIn('EMAIL', out)

    def test_ordinary_diagnostics_survive_untouched(self):
        for text in (
            'VLM processing error (TimeoutError)',
            'Provider returned HTTP 429; rotating provider/key',
            'Navigation blocked: unsupported scheme',
        ):
            self.assertEqual(redact(text), text)

    def test_redaction_is_idempotent(self):
        once = redact('Authorization: Bearer abcdef0123456789xyz')
        self.assertEqual(redact(once), once)
        pii = redact('aadhaar 2345 6789 0123')
        self.assertEqual(redact(pii), pii)

    def test_nested_structures_are_scrubbed(self):
        out = redact({
            'token': 'gsk_ABCDEFGHIJKLMNOPQRST',
            'nested': {'note': 'aadhaar 2345 6789 0123'},
            'items': ['sk-or-v1-abcdefghijklmnopqrst'],
        })
        blob = json.dumps(out)
        self.assertNotIn('ABCDEFGHIJKLMNOP', blob)
        self.assertNotIn('2345', blob)
        self.assertNotIn('abcdefghijklmnop', blob)

    def test_long_text_is_capped(self):
        self.assertLess(len(redact('x' * 9000)), 3000)

    def test_passthrough_types_survive(self):
        self.assertIsNone(redact(None))
        self.assertEqual(redact(7), 7)
        self.assertIs(redact(True), True)


class JsonLinesFormatterTests(unittest.TestCase):
    def test_emits_exactly_one_json_object_per_line(self):
        line = JsonLinesFormatter().format(make_record('hello'))
        self.assertNotIn('\n', line)
        parsed = json.loads(line)
        self.assertEqual(parsed['v'], 1)
        self.assertEqual(parsed['level'], 'info')
        self.assertEqual(parsed['message'], 'hello')
        self.assertEqual(parsed['logger'], 'test')
        self.assertIn('epoch_ms', parsed)

    def test_exception_is_embedded_as_one_string(self):
        try:
            raise ValueError('boom')
        except ValueError:
            import sys as _sys
            exc_info = _sys.exc_info()
        line = JsonLinesFormatter().format(make_record('failed', level=logging.ERROR, exc_info=exc_info))
        # A multi-line record would break the one-object-per-line contract.
        self.assertNotIn('\n', line)
        parsed = json.loads(line)
        self.assertEqual(parsed['exception']['type'], 'ValueError')
        self.assertEqual(parsed['exception']['message'], 'boom')
        self.assertIn('Traceback', parsed['exception']['traceback'])

    def test_exception_message_is_redacted(self):
        try:
            raise ValueError('token was gsk_ABCDEFGHIJKLMNOPQRST')
        except ValueError:
            import sys as _sys
            exc_info = _sys.exc_info()
        parsed = json.loads(JsonLinesFormatter().format(
            make_record('failed', level=logging.ERROR, exc_info=exc_info)))
        self.assertNotIn('ABCDEFGHIJKLMNOP', parsed['exception']['message'])

    def test_allow_listed_fields_are_kept(self):
        record = make_record(
            'rotating', level=logging.WARNING,
            provider='OpenRouter', model='qwen', status_code=429,
        )
        fields = json.loads(JsonLinesFormatter().format(record))['fields']
        self.assertEqual(fields['provider'], 'OpenRouter')
        self.assertEqual(fields['status_code'], 429)

    def test_privagent_prefixed_fields_are_kept(self):
        record = make_record('rotating', privagent_client='127.0.0.1')
        fields = json.loads(JsonLinesFormatter().format(record))['fields']
        self.assertEqual(fields['privagent_client'], '127.0.0.1')

    def test_unrecognised_fields_are_dropped_not_guessed(self):
        # A future logger.info(..., body=payload) must not be able to write a
        # request body to disk just because the key was not thought about.
        record = make_record('rotating', request_body='SECRET PAYLOAD', raw_headers='Bearer abc')
        self.assertNotIn('fields', JsonLinesFormatter().format(record))

    def test_field_values_are_redacted(self):
        record = make_record('rotating', provider='gsk_ABCDEFGHIJKLMNOPQRST')
        self.assertNotIn('ABCDEFGHIJKLMNOP', JsonLinesFormatter().format(record))

    def test_plan_and_feedback_fields_are_redacted_in_jsonl(self):
        api_key = 'sk-or-v1-abcdefghijklmnopqrstuvwx'
        email = 'synthetic.person@example.invalid'
        plan_fields = redact({
            'plan': f'Key seen: {api_key}',
            'planner_feedback': f'Contact {email}',
        })
        record = make_record(json.dumps(plan_fields))

        line = JsonLinesFormatter().format(record)

        self.assertIn('[REDACTED_API_KEY]', line)
        self.assertIn('EMAIL', line)
        for secret in (api_key, 'abcdefghijklmnop', email, 'example.invalid'):
            self.assertNotIn(secret, line)

    def test_logrecord_internals_are_not_mistaken_for_fields(self):
        # `name` and `message` exist on every record; treating them as extra
        # data would duplicate the record's own fields.
        parsed = json.loads(JsonLinesFormatter().format(make_record('hello')))
        self.assertIsNone(parsed.get('fields'))


class ConsoleFormatterTests(unittest.TestCase):
    def test_line_is_human_readable_and_carries_fields(self):
        line = ConsoleFormatter().format(make_record('rotating', provider='Groq'))
        self.assertIn('rotating', line)
        self.assertIn('Groq', line)
        self.assertIn('test', line)

    def test_long_text_is_redacted_on_console_too(self):
        self.assertNotIn('gsk_ABCDEFGHIJKLMNOP', ConsoleFormatter().format(
            make_record('key gsk_ABCDEFGHIJKLMNOPQRST')))


class ConfigurationTests(unittest.TestCase):
    def test_configure_logging_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = {k: os.environ.get(k) for k in ('LOG_DIR', 'LOG_TO_FILE')}
            os.environ['LOG_DIR'] = tmp
            os.environ['LOG_TO_FILE'] = 'true'
            try:
                first = configure_logging(force=True)
                count = len(logging.getLogger().handlers)
                self.assertIsNotNone(first)
                # A second call without force must not stack another pair of
                # handlers; duplicate log lines are worse than missing ones.
                self.assertIsNone(configure_logging())
                self.assertEqual(len(logging.getLogger().handlers), count)
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                configure_logging(force=True)

    def test_file_handler_receives_debug_even_when_console_is_higher(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = {k: os.environ.get(k) for k in ('LOG_DIR', 'LOG_TO_FILE', 'LOG_LEVEL')}
            os.environ['LOG_DIR'] = tmp
            os.environ['LOG_TO_FILE'] = 'true'
            os.environ['LOG_LEVEL'] = 'WARNING'
            try:
                handler = configure_logging(force=True)
                self.assertEqual(handler.level, logging.DEBUG)
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                configure_logging(force=True)

    def test_an_unwritable_log_dir_degrades_to_console_only(self):
        previous_dir = os.environ.get('LOG_DIR')
        previous_flag = os.environ.get('LOG_TO_FILE')
        # A path under a file, not a directory: mkdir must fail.
        with tempfile.NamedTemporaryFile(delete=False) as blocker:
            blocker.write(b'x')
            blocker_path = blocker.name
        os.environ['LOG_DIR'] = str(pathlib.Path(blocker_path) / 'logs')
        os.environ['LOG_TO_FILE'] = 'true'
        try:
            with self.assertLogs(level='WARNING') as captured:
                handler = configure_logging(force=True)
            self.assertIsNone(handler)
            self.assertTrue(any('Could not open the log file' in line for line in captured.output))
            # The server must still be able to log.
            logging.getLogger('test').info('still works')
        finally:
            if previous_dir is None:
                os.environ.pop('LOG_DIR', None)
            else:
                os.environ['LOG_DIR'] = previous_dir
            if previous_flag is None:
                os.environ.pop('LOG_TO_FILE', None)
            else:
                os.environ['LOG_TO_FILE'] = previous_flag
            pathlib.Path(blocker_path).unlink(missing_ok=True)
            configure_logging(force=True)

    def test_log_dir_defaults_beside_the_server_not_the_cwd(self):
        previous = os.environ.pop('LOG_DIR', None)
        cwd = os.getcwd()
        try:
            os.chdir(tempfile.gettempdir())
            self.assertEqual(log_dir(), pathlib.Path(logging_config.__file__).resolve().parent / 'logs')
        finally:
            os.chdir(cwd)
            if previous is not None:
                os.environ['LOG_DIR'] = previous

    def test_log_level_accepts_a_name_and_falls_back_on_junk(self):
        previous = os.environ.get('LOG_LEVEL')
        try:
            os.environ['LOG_LEVEL'] = 'DEBUG'
            self.assertEqual(logging_config._resolve_level(), logging.DEBUG)
            os.environ['LOG_LEVEL'] = 'not-a-level'
            self.assertEqual(logging_config._resolve_level(), logging.INFO)
        finally:
            if previous is None:
                os.environ.pop('LOG_LEVEL', None)
            else:
                os.environ['LOG_LEVEL'] = previous

    def test_uvicorn_log_config_routes_uvicorn_into_both_sinks(self):
        config = uvicorn_log_config()
        self.assertIn('file', config['loggers']['uvicorn']['handlers'])
        self.assertIn('console', config['loggers']['uvicorn']['handlers'])
        self.assertIn('file', config['loggers']['uvicorn.access']['handlers'])
        self.assertIn('jsonl', config['handlers']['file']['formatter'])
        # `disable_existing_loggers` must stay False: turning it on would silence
        # every getLogger in the codebase the first time uvicorn reloads.
        self.assertFalse(config['disable_existing_loggers'])

    def test_unhandled_exceptions_reach_the_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous_dir = os.environ.get('LOG_DIR')
            previous_flag = os.environ.get('LOG_TO_FILE')
            os.environ['LOG_DIR'] = tmp
            os.environ['LOG_TO_FILE'] = 'true'
            try:
                configure_logging(force=True)
                with self.assertLogs('privagent.uncaught', level='CRITICAL') as captured:
                    try:
                        raise RuntimeError('unhandled')
                    except RuntimeError:
                        import sys as _sys
                        logging_config.sys.excepthook(*_sys.exc_info())
                self.assertIn('Uncaught exception', captured.output[0])
                self.assertIn('RuntimeError', captured.output[0])
            finally:
                for key, value in (('LOG_DIR', previous_dir), ('LOG_TO_FILE', previous_flag)):
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                configure_logging(force=True)


class EndToEndTests(unittest.TestCase):
    def test_records_reach_a_real_jsonl_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous_dir = os.environ.get('LOG_DIR')
            previous_flag = os.environ.get('LOG_TO_FILE')
            os.environ['LOG_DIR'] = tmp
            os.environ['LOG_TO_FILE'] = 'true'
            try:
                handler = configure_logging(force=True)
                log = logging.getLogger('e2e')
                log.setLevel(logging.INFO)
                log.info('rotation decision', extra={'provider': 'Groq', 'status_code': 429})
                log.warning('key leaked here: sk-or-v1-abcdefghijklmnopqrstuvwx')
                for attached in logging.getLogger().handlers:
                    attached.flush()
                handler.close()

                lines = [l for l in pathlib.Path(log_file_path()).read_text().splitlines() if l.strip()]
                self.assertEqual(len(lines), 2)
                records = [json.loads(l) for l in lines]
                self.assertEqual(records[0]['fields']['provider'], 'Groq')
                self.assertNotIn('abcdefghijklmnop', records[1]['message'])
            finally:
                for key, value in (('LOG_DIR', previous_dir), ('LOG_TO_FILE', previous_flag)):
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                configure_logging(force=True)


if __name__ == '__main__':
    unittest.main()
