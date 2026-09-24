"""Retired backend-driven browser loop.

The former implementation captured raw Chrome screenshots, performed only
partial text sanitization, and auto-proceeded through high-risk actions. It is
removed so the extension's local privacy sanitizer and confirmation UI remain
the only supported browser-agent execution path. The module intentionally
exports no router or task endpoints.
"""
