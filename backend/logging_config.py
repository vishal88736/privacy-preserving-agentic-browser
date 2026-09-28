"""Central logging configuration for the local agent backend.

Two sinks, two formats, on purpose:

* A rotating **JSONL file** (``backend/logs/backend.jsonl``) is the machine-
  readable artifact. One JSON object per line, so ``jq``/``grep``/ingestion
  pipelines can read it without a parser that has to cope with multi-line
  tracebacks.
* A **human-readable console** stream for interactive work.

Before this module the backend had no logging configuration at all. Two
modules called ``logging.getLogger`` (which, unconfigured, writes WARNING and
above to stderr and drops INFO), ``vlm_service`` used bare ``print()`` for all
of its diagnostics, and ``server.py`` used ``traceback.print_exc()``. Provider
rotation decisions — the single most useful thing to see while debugging a VLM
run — were therefore only visible by restarting the process attached to
stdout.

Privacy: every message and field is scrubbed before it is written. This server
holds live provider API keys in memory and its exception text can quote
provider URLs and upstream error bodies, so an unscrubbed log file sitting in
the project directory is a credential-leak path. Redaction uses the same
category rules the inbound boundary already uses (``privacy_rules``), plus
credential-shape scrubbing that mirrors the packaging guard.
"""

import datetime as _dt
import json
import logging
import logging.handlers
import os
import re
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

__all__ = [
    "JsonLinesFormatter",
    "configure_logging",
    "get_logger",
    "log_dir",
    "log_file_path",
    "redact",
    "uvicorn_log_config",
]


DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_LOG_FILE = "backend.jsonl"

# 8 MiB x 5 rotations keeps a long debugging session's history on disk without
# letting an error loop fill the volume. Rotation is size-based so a crash loop
# cannot produce an unbounded file between restarts.
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
DEFAULT_BACKUP_COUNT = 5

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}

_CONFIGURED = False
_CONFIG_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

# Shapes deliberately overlapping with the extension's packaging guard
# (scripts/package-extension.mjs) and the credential scan in
# tests/security/test_secret_hygiene.py.
_CREDENTIAL_PATTERNS = [
    (re.compile(r"\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{8,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bpk-(?:live|test)-[A-Za-z0-9]{8,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bgsk_[A-Za-z0-9]{8,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\bhf_[A-Za-z0-9]{8,}\b"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}"), "[REDACTED_BEARER_TOKEN]"),
    # Assigned secrets keep their label so a log line stays diagnosable.
    (
        re.compile(
            r"((?:api[_-]?key|secret|password|passwd|token|authorization)"
            r"\s*[:=]\s*)(?!\[REDACTED_)[\"']?[^\s\"',}]{4,}[\"']?",
            re.I,
        ),
        r"\1[REDACTED_ASSIGNED_SECRET]",
    ),
]

# `extra=` keys that are safe to copy verbatim into a record. Anything else is
# dropped rather than guessed at, because a caller can attach a whole request
# body under an arbitrary key.
_SAFE_FIELD_PREFIX = ("privagent_",)

# Attribute names on a LogRecord that are not caller-supplied `extra` data.
_RESERVED_RECORD_ATTRS = frozenset(
    """args asctime created exc_info exc_text filename funcName levelname levelno
    lineno module msecs message msg name pathname process processName relativeCreated
    stack_info stacklevel thread threadName taskName""".split()
)


def _redact_text(value: str) -> str:
    for pattern, replacement in _CREDENTIAL_PATTERNS:
        value = pattern.sub(replacement, value)
    return value


# Structured field names the codebase uses. Anything not listed here and not
# prefixed with `privagent_` is dropped by `_extra_fields`, so an arbitrary
# `extra` payload cannot reach the log file.
_EXTRA_FIELD_ALLOWLIST = frozenset(
    {
        "endpoint", "provider", "model", "models", "reason", "category",
        "action_type", "action", "step", "step_id", "status_code", "attempt",
        "attempts", "task_id", "tab_id", "timeout_s", "field_count",
        "element_count", "payload_bytes", "content_length", "client",
        "detected_categories", "rotation", "candidates", "elapsed_ms",
    }
)


def redact(value: Any) -> Any:
    """Scrub a string or structure for logging.

    Credential shapes are replaced outright, then the project's own PII
    category rules (``privacy_rules``, the same ones the inbound boundary uses)
    decide whether the remainder is safe. A PII hit collapses to its category:
    the category is what makes the line actionable, the value is not.
    """
    try:
        from privacy_rules import find_sensitive_category
    except Exception:  # pragma: no cover - only when run outside backend/
        find_sensitive_category = None

    def _walk(node: Any, depth: int = 0) -> Any:
        if node is None or isinstance(node, (bool, int, float)):
            return node
        if isinstance(node, str):
            text = _redact_text(node)
            if find_sensitive_category is not None:
                category = find_sensitive_category(text)
                if category:
                    return f"[REDACTED_{category}]"
            return text if len(text) <= 2000 else text[:2000] + "…[truncated]"
        if isinstance(node, BaseException):
            return {"type": type(node).__name__, "message": _walk(str(node), depth + 1)}
        if depth >= 4:
            return "[depth-limited]"
        if isinstance(node, dict):
            return {str(k)[:120]: _walk(v, depth + 1) for k, v in list(node.items())[:50]}
        if isinstance(node, (list, tuple, set)):
            items = list(node)[:50]
            out = [_walk(v, depth + 1) for v in items]
            if len(node) > 50:
                out.append(f"[+{len(node) - 50} more]")
            return out
        return _walk(str(node), depth + 1)

    return _walk(value)


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

def _extra_fields(record: logging.LogRecord) -> Dict[str, Any]:
    """Caller-supplied structured fields, excluding LogRecord internals.

    Only allow-listed names survive. A future ``logger.info(..., body=payload)``
    must not be able to quietly write a request body to disk, so the default
    answer for an unrecognised key is "drop it" rather than "probably fine".
    """
    fields = {}
    for key, value in record.__dict__.items():
        if key in _RESERVED_RECORD_ATTRS or key.startswith("_"):
            continue
        if not (key.startswith(_SAFE_FIELD_PREFIX) or key in _EXTRA_FIELD_ALLOWLIST):
            continue
        fields[key] = redact(value)
    return fields


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


class JsonLinesFormatter(logging.Formatter):
    """One JSON object per line, with the traceback kept as a single string.

    The traceback is embedded rather than split across records because a
    multi-line record would break the one-object-per-line contract that makes
    this file greppable.
    """

    converter = _dt.datetime.fromtimestamp

    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "v": 1,
            "ts": _utc_now_iso(),
            "epoch_ms": int(record.created * 1000),
            "level": record.levelname.lower(),
            "logger": record.name,
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "message": redact(record.getMessage()),
        }

        fields = _extra_fields(record)
        if fields:
            payload["fields"] = fields

        if record.exc_info:
            exc_type, exc_value, exc_tb = record.exc_info
            payload["exception"] = {
                "type": getattr(exc_type, "__name__", str(exc_type)),
                "message": redact(str(exc_value)),
                "traceback": redact("".join(traceback.format_exception(exc_type, exc_value, exc_tb))),
            }
        elif record.exc_text:
            payload["exception"] = {"traceback": redact(record.exc_text)}

        if record.stack_info:
            payload["stack"] = redact(record.stack_info)

        try:
            return json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # Never let an unserializable field lose the record itself.
            payload.pop("fields", None)
            return json.dumps(payload, ensure_ascii=False, default=str)


class ConsoleFormatter(logging.Formatter):
    """Readable single line, with the traceback appended when present."""

    default_time_format = "%H:%M:%S"

    def format(self, record: logging.LogRecord) -> str:
        level = record.levelname
        if record.levelno >= logging.ERROR:
            level = "ERROR"
        elif record.levelno == logging.WARNING:
            level = "WARN "
        else:
            level = f"{level[:4]:<4}"

        line = f"{self.formatTime(record)} {level} {record.name}: {redact(record.getMessage())}"
        fields = _extra_fields(record)
        if fields:
            try:
                line += " " + json.dumps(fields, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                pass
        if record.exc_info:
            line += "\n" + redact("".join(traceback.format_exception(*record.exc_info)))
        return line


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in _TRUTHY:
        return True
    if raw in _FALSY:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _resolve_level() -> int:
    raw = os.getenv("LOG_LEVEL", DEFAULT_LOG_LEVEL).strip().upper()
    resolved = logging.getLevelNamesMapping().get(raw)
    if resolved is None:
        return logging.getLevelName(DEFAULT_LOG_LEVEL)
    return resolved


def log_dir() -> Path:
    """Directory holding the rotating log files."""
    configured = os.getenv("LOG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    # backend/logs next to this file, regardless of the process CWD, so the
    # log lands in the same place whether the server is started from the repo
    # root, from backend/, or by uvicorn's --app-dir.
    return Path(__file__).resolve().parent / "logs"


def log_file_path() -> Path:
    return log_dir() / os.getenv("LOG_FILE", DEFAULT_LOG_FILE).strip()


def _install_global_hooks() -> None:
    """Route otherwise-invisible failures into the log file.

    ``sys.excepthook`` covers a crash on the main thread; the threading hook
    covers a worker thread, which by default prints to stderr and is lost the
    moment the process is restarted. Both are installed once and never removed.
    """

    def _hook(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        logging.getLogger("privagent.uncaught").critical(
            "Uncaught exception", exc_info=(exc_type, exc_value, exc_tb)
        )

    def _thread_hook(args):
        if issubclass(args.exc_type, SystemExit):
            return
        logging.getLogger("privagent.uncaught").critical(
            "Uncaught exception in thread %s", getattr(args.thread, "name", "?"),
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = _hook
    if hasattr(threading, "excepthook"):
        threading.excepthook = _thread_hook


def configure_logging(force: bool = False) -> Optional[logging.Handler]:
    """Install the file and console handlers. Idempotent.

    Returns the file handler, or ``None`` when file logging is disabled or the
    log directory could not be created. Failing to open a log file must not stop
    the server: the console sink and the privacy boundary matter more than the
    artifact, so a permissions problem degrades to a warning.
    """
    global _CONFIGURED
    with _CONFIG_LOCK:
        if _CONFIGURED and not force:
            return None
        _CONFIGURED = True

    root = logging.getLogger()
    level = _resolve_level()
    root.setLevel(level)

    # Replace only handlers this module installed. A host that configured its
    # own logging (pytest, an embedding process) keeps them.
    for handler in list(root.handlers):
        if getattr(handler, "_privagent_managed", False):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass

    formatter_console = ConsoleFormatter()
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(formatter_console)
    console.setLevel(level)
    console._privagent_managed = True
    root.addHandler(console)

    file_handler: Optional[logging.Handler] = None
    if _env_flag("LOG_TO_FILE", True):
        target_dir = log_dir()
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            file_handler = logging.handlers.RotatingFileHandler(
                log_file_path(),
                maxBytes=_env_int("LOG_MAX_BYTES", DEFAULT_MAX_BYTES),
                backupCount=_env_int("LOG_BACKUP_COUNT", DEFAULT_BACKUP_COUNT),
                encoding="utf-8",
                delay=True,
            )
            file_handler.setFormatter(JsonLinesFormatter())
            # The file sink stays at DEBUG so a run can be reproduced with
            # LOG_LEVEL=DEBUG without changing which records are eligible.
            file_handler.setLevel(logging.DEBUG)
            file_handler._privagent_managed = True
            root.addHandler(file_handler)
        except OSError as exc:
            root.warning(
                "Could not open the log file at %s (%s); continuing with console output only.",
                log_file_path(), type(exc).__name__,
            )

    # uvicorn installs its own handlers on its own loggers; route them through
    # the same two sinks instead of leaving a third, differently-formatted
    # destination behind.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        target = logging.getLogger(name)
        target.handlers = [h for h in target.handlers if not getattr(h, "_privagent_managed", False)]
        target.propagate = True

    _install_global_hooks()
    return file_handler


def get_logger(name: str) -> logging.Logger:
    """A module logger. ``configure_logging()`` must have been called once."""
    return logging.getLogger(name)


def uvicorn_log_config() -> Dict[str, Any]:
    """A ``log_config`` dict for :func:`uvicorn.run`.

    Passing this keeps uvicorn's startup banner, access log and error log in the
    JSONL file alongside the application's own records. Without it, uvicorn
    re-installs its colourised handlers on every ``--reload`` cycle and the
    access log never reaches the file at all.
    """
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "jsonl": {"()": "logging_config.JsonLinesFormatter"},
            "console": {"()": "logging_config.ConsoleFormatter"},
        },
        "handlers": {
            "file": {
                "class": "logging.handlers.RotatingFileHandler",
                "formatter": "jsonl",
                "filename": str(log_file_path()),
                "maxBytes": _env_int("LOG_MAX_BYTES", DEFAULT_MAX_BYTES),
                "backupCount": _env_int("LOG_BACKUP_COUNT", DEFAULT_BACKUP_COUNT),
                "encoding": "utf-8",
                "delay": True,
            },
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "console",
                "stream": "ext://sys.stderr",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["console", "file"], "level": _resolve_level_name(), "propagate": False},
            "uvicorn.error": {"level": _resolve_level_name()},
            "uvicorn.access": {
                "handlers": ["console", "file"],
                "level": _resolve_level_name(),
                "propagate": False,
            },
        },
        "root": {"handlers": ["console", "file"], "level": _resolve_level_name()},
    }


def _resolve_level_name() -> str:
    return logging.getLevelName(_resolve_level())
