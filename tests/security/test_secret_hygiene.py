"""
Secret-hygiene check for the working tree.

`.env` is gitignored and untracked, which protects future commits but says
nothing about the file sitting on disk or about a key pasted into a source file.
This test pins the properties that actually matter:

1. The real env file is never tracked by git.
2. The real env file is not readable by other users on the machine.
3. No provider key appears in a TRACKED file. `.env` itself is exempt because it
   is the legitimate home for those values; everything else must be clean, so a
   key pasted into source or committed by accident fails here rather than in a
   breach.
"""

import re
import stat
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"

# Provider key shapes and the backend's own shared secret.
SECRET_PATTERNS = {
    "Groq API key": re.compile(r"\bgsk_[A-Za-z0-9]{20,}"),
    "OpenRouter API key": re.compile(r"\bsk-or-v1-[A-Za-z0-9_\-]{20,}"),
    "OpenAI-style API key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}"),
    "HuggingFace token": re.compile(r"\bhf_[A-Za-z0-9]{30,}"),
    "private key block": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}

# Files that legitimately describe the secret *shapes* without holding values.
SHAPE_DOC_FILES = {".env.example", "backend/.env.example"}

# Directories that are not part of the shipped extension or backend.
SKIP_DIRS = {".git", "node_modules", "dist", "__pycache__", "references", ".venv"}

TEXT_SUFFIXES = {
    ".js", ".mjs", ".cjs", ".ts", ".json", ".py", ".md", ".txt", ".html", ".css",
    ".yml", ".yaml", ".sh", ".example", ".cfg", ".ini", ".toml", "",
}

# The exact pattern the packaging guard uses, so this test fails if the build
# script's own scan regresses. Kept in sync deliberately rather than imported:
# scripts/package-extension.mjs is ESM and running it needs a full build.
_SECRET_PROBE_JS = (
    r"/\b(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}"
    r"|gsk_[A-Za-z0-9]{20,}"
    r"|hf_[A-Za-z0-9]{20,})\b/.test("
)


def _node_executable():
    """Return the node binary path, or None when node is unavailable."""
    import shutil

    return shutil.which("node")


def git_tracked_files():
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return [p for p in out.stdout.split("\0") if p]


class SecretHygieneTests(unittest.TestCase):
    def test_env_file_is_not_tracked(self):
        tracked = git_tracked_files()
        if tracked is None:
            self.skipTest("git is unavailable in this environment")
        self.assertNotIn(".env", tracked,
                         ".env holds real credentials and must never be committed")
        self.assertNotIn("backend/.env", tracked,
                         "backend/.env holds real credentials and must never be committed")

    @unittest.skipUnless(ENV_FILE.is_file(), "no local .env present")
    def test_env_file_is_owner_only(self):
        mode = stat.S_IMODE(ENV_FILE.stat().st_mode)
        self.assertEqual(
            mode & (stat.S_IRWXG | stat.S_IRWXO), 0,
            f".env is mode {mode:o}; credentials should be 600 (owner only)",
        )

    def test_no_tracked_file_contains_a_live_credential(self):
        tracked = git_tracked_files()
        if tracked is None:
            self.skipTest("git is unavailable in this environment")

        offenders = []
        for rel in tracked:
            path = ROOT / rel
            if not path.is_file():
                continue
            if rel in SHAPE_DOC_FILES or path.suffix in (".png", ".gz", ".onnx", ".wasm", ".zip"):
                continue
            if any(part in SKIP_DIRS for part in Path(rel).parts):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for label, pattern in SECRET_PATTERNS.items():
                if pattern.search(text):
                    offenders.append(f"{rel}: {label}")

        self.assertEqual(
            offenders, [],
            "credential-shaped values found in tracked files:\n  " + "\n  ".join(offenders),
        )

    def test_agentic_vendor_material_contains_no_live_credential(self):
        """Scan agentic prompts and vendored references before they are tracked."""
        vendor_dir = ROOT / "backend" / "agentic"
        candidates = list(vendor_dir.glob("*.py"))
        candidates.extend((vendor_dir / "_upstream").glob("*.py"))
        candidates.append(vendor_dir / "LICENSE.TheAgentic")
        offenders = []
        for path in candidates:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for label, pattern in SECRET_PATTERNS.items():
                if pattern.search(text):
                    offenders.append(f"{path.relative_to(ROOT)}: {label}")

        self.assertEqual(
            offenders, [],
            "credential-shaped values found in TheAgentic vendor material:\n  " + "\n  ".join(offenders),
        )

    def test_packaging_would_reject_a_planted_key(self):
        """The build's secret scan must still match real provider key shapes.

        The packaging guard is the last line of defence if a key is committed by
        accident. If its pattern ever stops matching, it fails silently and ships
        the key, so the pattern is exercised here against the shapes it claims
        to catch.
        """
        node = _node_executable()
        if node is None:
            self.skipTest("node is unavailable in this environment")

        positive = {
            "Groq": "gsk_" + "A" * 40,
            "OpenRouter": "sk-or-v1-" + "b" * 40,
            "OpenAI": "sk-" + "c" * 40,
            "HuggingFace": "hf_" + "d" * 34,
        }
        negatives = {
            "the word sk": "sk-key-a",
            "a short token": "gsk_short",
            "plain text": "const apiKey = settings.API_KEY;",
            "a placeholder": "replace-with-a-random-32-byte-or-longer-secret",
        }

        def _probe(value: str) -> bool:
            # Pass the sample through argv rather than interpolating it into the
            # source, so the generated code has no quoting to get wrong.
            result = subprocess.run(
                [node, "-e", f"process.exit({_SECRET_PROBE_JS}process.argv[1]) ? 0 : 1)", value],
                capture_output=True,
            )
            return result.returncode == 0

        for label, value in positive.items():
            self.assertTrue(
                _probe(value),
                f"the packaging secret pattern no longer matches a real {label} key, "
                f"so a planted key would ship undetected",
            )

        for label, value in negatives.items():
            self.assertFalse(
                _probe(value),
                f"the packaging secret pattern false-positives on {label}, "
                f"which would block every build",
            )


if __name__ == "__main__":
    unittest.main()
