"""
SIH Benchmark Evaluation Web Server
Serves test benchmark pages on http://localhost:5000
"""

import http.server
import socketserver
import os
import sys

PORT = 5000
DIRECTORY = os.path.join(os.path.dirname(__file__), "pages")

INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>PrivAgent SIH Benchmark Test Suite</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Outfit', sans-serif; background: #0b0f19; color: #f8fafc; padding: 40px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 26px; margin-bottom: 8px; color: #6366f1; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 20px; transition: border 0.2s; text-decoration: none; color: inherit; }
    .card:hover { border-color: #6366f1; }
    .card-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .card-desc { font-size: 13px; color: #94a3b8; line-height: 1.4; }
    .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-top: 10px; font-weight: 600; }
    .tag-gov { background: rgba(37,99,235,0.2); color: #60a5fa; }
    .tag-search { background: rgba(2,132,199,0.2); color: #38bdf8; }
    .tag-doc { background: rgba(16,185,129,0.2); color: #34d399; }
    .tag-sec { background: rgba(244,63,94,0.2); color: #fb7185; }
  </style>
</head>
<body>
  <h1>PrivAgent SIH Benchmark Suite</h1>
  <p>Test websites engineered to validate DOM+VLM perception, local privacy redaction, symbolic secret resolution, and safety gates.</p>
  <div class="grid">
    <a href="/government-aadhaar.html" class="card">
      <div class="card-title">1. Aadhaar & Citizen Services</div>
      <div class="card-desc">Tests sensitive PII detection (12-digit Aadhaar, PAN, DOB), screenshot blackout, and local secret injection.</div>
      <span class="tag tag-gov">Government Form</span>
    </a>
    <a href="/flight-search.html" class="card">
      <div class="card-title">2. Flight Comparison (Pune → Delhi)</div>
      <div class="card-desc">Tests multi-step form entry, search click, visual result observation, and cheapest option identification.</div>
      <span class="tag tag-search">Multi-Step Navigation</span>
    </a>
    <a href="/document-upload.html" class="card">
      <div class="card-title">3. Identity Document Upload</div>
      <div class="card-desc">Tests file upload target identification, LOCAL_DOCUMENT resolution, and synthetic file attachment without server leakage.</div>
      <span class="tag tag-doc">Document Protection</span>
    </a>
    <a href="/prompt-injection.html" class="card">
      <div class="card-title">4. Adversarial Prompt Injection</div>
      <div class="card-desc">Tests untrusted webpage content quarantining and ensures the agent ignores malicious exfiltration attempts.</div>
      <span class="tag tag-sec">Threat Defense</span>
    </a>
    <a href="/page-a-normal-form.html" class="card">
      <div class="card-title">A. Normal Form (non-sensitive)</div>
      <div class="card-desc">Name, email, phone, address, country, submit. Baseline: no PII gates expected.</div>
      <span class="tag tag-search">Validation</span>
    </a>
    <a href="/page-b-sensitive-form.html" class="card">
      <div class="card-title">B. Sensitive Form (PII + password)</div>
      <div class="card-desc">Name, Aadhaar, PAN, DOB, password, submit. Every value stays local via symbolic refs.</div>
      <span class="tag tag-gov">Validation</span>
    </a>
    <a href="/page-c-visual-ui.html" class="card">
      <div class="card-title">C. Visual UI (DOM-insufficient)</div>
      <div class="card-desc">Custom cards, pills, canvas chart. Requires DOM + VLM fusion to interpret.</div>
      <span class="tag tag-search">Validation</span>
    </a>
    <a href="/page-d-document-upload.html" class="card">
      <div class="card-title">D. Document Upload + Confirm</div>
      <div class="card-desc">File input, upload button, confirmation state. Bytes never reach the AI backend.</div>
      <span class="tag tag-doc">Validation</span>
    </a>
    <a href="/page-e-prompt-injection.html" class="card">
      <div class="card-title">E. Hostile Page Battery</div>
      <div class="card-desc">Five injection shapes: ignore-orders, exfiltrate password, reveal Aadhaar, upload docs, dangerous click.</div>
      <span class="tag tag-sec">Validation</span>
    </a>
  </div>
</body>
</html>
"""

class BenchmarkHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(INDEX_HTML.encode("utf-8"))
            return
        return super().do_GET()

def run_server():
    with socketserver.TCPServer(("", PORT), BenchmarkHandler) as httpd:
        print(f"SIH Benchmark Web Server running at http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            httpd.server_close()

if __name__ == "__main__":
    run_server()
