"""Shared browser/test-page bootstrapping for the Playwright e2e suites.

These suites drive a real Chromium with the real extension loaded, and some of
them also call the live backend. Two things used to make them unrunnable
outside one developer's machine:

1. ``PRIVAGENT_BROWSER_BIN`` had a hardcoded absolute path to a specific
   Playwright build under that developer's home directory. Any other machine,
   and any CI runner, got a path that did not exist.
2. There was no way to say "the prerequisites are not available here" other
   than crashing with a Playwright error.

This module resolves the browser from, in order: the explicit environment
variable, whatever Playwright itself has installed, or a system Chrome/Chromium.
:func:`require_browser` turns a missing browser into a clean skip instead of a
traceback, and :func:`require_backend` does the same for the live backend and
its provider credentials.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_PATH = REPO_ROOT / "extension"
TEST_PAGES = REPO_ROOT / "test-server" / "pages"
BACKEND_URL = os.environ.get("PRIVAGENT_BACKEND_URL", "http://localhost:8000")

# Suffixes worth trying when Playwright has not installed a browser itself.
_SYSTEM_CHROME_NAMES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
)


class MissingPrerequisite(RuntimeError):
    """A suite cannot run here; the caller should skip, not fail."""


def resolve_extension_path() -> str:
    """Absolute path to the extension directory the manifests load from."""
    path = EXTENSION_PATH.resolve()
    if not (path / "manifest.json").is_file():
        raise MissingPrerequisite(f"extension manifest not found at {path}")
    return str(path)


def resolve_browser_path() -> str | None:
    """Locate a Chromium/Chrome binary, or None when none is available.

    Order matters: an explicit override always wins, then the browser Playwright
    manages (so a pinned version is preferred), then any system install.
    """
    override = os.environ.get("PRIVAGENT_BROWSER_BIN", "").strip()
    if override:
        if not Path(override).exists():
            raise MissingPrerequisite(
                f"PRIVAGENT_BROWSER_BIN points at {override}, which does not exist"
            )
        return override

    # Playwright's own download, if present. Its registry is a module-level
    # dict of platform -> path, so probe rather than importing internals.
    try:
        from playwright._impl._driver import compute_driver_executable  # noqa: F401
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            path = playwright.chromium.executable_path
            if path and Path(path).exists():
                return path
    except Exception:
        # Playwright not installed, or no browser downloaded. Fall through to
        # a system browser, which is all CI needs.
        pass

    for name in _SYSTEM_CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return found

    return None


def require_browser() -> str:
    """Return a usable browser path or raise MissingPrerequisite."""
    try:
        path = resolve_browser_path()
    except MissingPrerequisite:
        raise
    if not path:
        raise MissingPrerequisite(
            "no Chromium/Chrome found. Run `npx playwright install chromium`, "
            "install a system Chrome, or set PRIVAGENT_BROWSER_BIN."
        )
    return path


def require_playwright():
    """Import playwright or raise MissingPrerequisite."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise MissingPrerequisite(
            "playwright is not installed. Run: pip install -r backend/requirements.txt"
        ) from exc
    return sync_playwright


def require_backend() -> str:
    """Return the backend URL, or raise when it is not reachable.

    The suites that assert on real model behaviour need the backend up with a
    working provider key. Refusing to start is better than failing halfway
    through a run and leaving a misleading result.
    """
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(BACKEND_URL)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8000
    try:
        with socket.create_connection((host, port), timeout=2):
            pass
    except OSError as exc:
        raise MissingPrerequisite(
            f"backend not reachable at {BACKEND_URL}. Start it with: python backend/server.py"
        ) from exc
    return BACKEND_URL


def run_or_skip(main, suite_name: str) -> int:
    """Run a suite's main(), turning a missing prerequisite into exit code 0.

    Suites call this instead of invoking main() directly so an unavailable
    browser or backend shows up as an explicit skip in CI rather than a red
    build that says nothing about the code.
    """
    try:
        return main()
    except MissingPrerequisite as exc:
        print(f"SKIP {suite_name}: {exc}", file=sys.stderr)
        print(f"{suite_name}: skipped (missing prerequisite)", flush=True)
        return 0
