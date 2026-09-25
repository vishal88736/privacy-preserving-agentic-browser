"""
PrivAgent SIH - Synthetic Privacy Sentinel & Latency Audit
Checks known test sentinels in extension-to-local-backend payloads and measures
the browser-visible workflow and model endpoint roundtrips. It cannot prove
that unknown PII is absent or inspect backend-to-provider traffic.
"""

import os
import sys
import time
import json
import re
from playwright.sync_api import sync_playwright

EXT_PATH = os.path.abspath("extension")
BROWSER_BIN = "/home/vishal/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
USER_DATA = "/tmp/test_chrome_profile_privagent_audit"

SENSITIVE_TEST_VALUES = [
    "4821 7392 0184",       # Aadhaar
    "482173920184",         # Aadhaar stripped
    "ABCDE1234F",           # PAN
    "SecureDemoPass#2026",  # Plaintext password
    "9876543210",           # Phone
    "15/08/2002"            # DOB
]

def run_privacy_and_latency_audit():
    os.system(f"rm -rf {USER_DATA}")
    print("\n================================================================")
    print("STARTING PRIVACY BOUNDARY ASSERTION & LATENCY AUDIT")
    print("================================================================")

    outbound_payloads = []
    requests_by_identity = {}
    latencies = {}

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA,
            executable_path=BROWSER_BIN,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT_PATH}",
                f"--load-extension={EXT_PATH}",
                "--no-sandbox",
                "--disable-gpu"
            ]
        )
        time.sleep(2)
        ext_id = None
        for sw in context.service_workers:
            if "chrome-extension://" in sw.url:
                ext_id = sw.url.split("/")[2]
                break

        assert ext_id, "Extension failed to load"

        # Capture only extension-to-local-backend requests. Provider egress is
        # made by the backend process and is outside this browser-context audit.
        def handle_request(req):
            if "localhost:8000" in req.url:
                record = {
                    "url": req.url,
                    "method": req.method,
                    "post_data": req.post_data,
                    "headers": req.headers,
                    "started_at": time.perf_counter(),
                    "duration_ms": None,
                }
                outbound_payloads.append(record)
                requests_by_identity[id(req)] = record

        def handle_response(response):
            record = requests_by_identity.get(id(response.request))
            if record:
                record["duration_ms"] = round((time.perf_counter() - record["started_at"]) * 1000, 2)

        context.on("request", handle_request)
        context.on("response", handle_response)

        # Open Aadhaar Government Portal
        t0 = time.time()
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("http://localhost:5000/government-aadhaar.html")
        page.wait_for_load_state("networkidle")
        t_page_load = time.time() - t0

        # A selector probe, not the complete extension DOM extraction stage.
        t0 = time.time()
        dom_res = page.evaluate("() => { const s = performance.now(); const el = document.querySelectorAll('input, button, select, a'); const e = performance.now(); return { count: el.length, latency: e - s }; }")
        latencies["dom_query_probe_ms"] = round(dom_res["latency"], 2)

        # Open Sidepanel
        sp = context.new_page()
        sp.goto(f"chrome-extension://{ext_id}/sidepanel/index.html")
        sp.wait_for_load_state("networkidle")
        time.sleep(1)

        # Run SIH Demo Workflow:
        # Prompt: "Fill this application using my saved profile and ask before submitting"
        print("\n[SIH Demo] Starting Aadhaar Citizen Portal flow...")
        sp.fill("#task-prompt", "Fill this application using my saved profile and ask before submitting")
        time.sleep(0.5)

        t_start_step = time.time()
        sp.click("#start-task-btn")

        confirmation_handled = False
        completed = False

        for sec in range(50):
            time.sleep(1)
            state = sp.inner_text("#agent-state-text")
            confirm_visible = sp.is_visible("#confirmation-modal")
            done_visible = sp.is_visible("#done-state")

            if confirm_visible and not confirmation_handled:
                confirmation_handled = True
                print(f"  [SIH Demo Step 10] Agent paused before submit and displayed transparent confirmation card!")
                verb = sp.inner_text("#confirm-action-verb")
                target = sp.inner_text("#confirm-action-target")
                local_data = sp.inner_text("#confirm-data-local")
                print(f"    Action: {verb} on {target}")
                print(f"    Protected data kept local: {local_data}")
                time.sleep(1)
                # User confirms
                sp.click("#modal-approve-btn")
                print("  [SIH Demo Step 12] User clicked Approve & Run!")

            success_box = page.evaluate("() => document.getElementById('submission-banner')?.style.display")
            if done_visible or state.upper() in ("COMPLETED", "DONE") or success_box == "block":
                completed = True
                total_duration = time.time() - t_start_step
                latencies["total_workflow_seconds"] = round(total_duration, 2)
                print(f"  [SIH Demo Step 14] Task successfully completed in {round(total_duration, 1)}s!")
                break

        # Check injected values in page
        val_name = page.input_value("#full_name")
        val_aadhaar = page.input_value("#aadhaar_num")
        val_pan = page.input_value("#pan_num")
        print("\n[Page Verification] Synthetic local profile values present:")
        print(f"  Full name configured: {bool(val_name)}")
        print(f"  Aadhaar configured:   {bool(val_aadhaar)}")
        print(f"  PAN configured:       {bool(val_pan)}")

        context.close()

    # --- PRIVACY BOUNDARY ASSERTIONS ---
    print("\n----------------------------------------------------------------")
    print("EXTENSION-TO-LOCAL-BACKEND PRIVACY ASSERTIONS")
    print("----------------------------------------------------------------")
    print(f"Total extension-to-backend model requests captured: {len(outbound_payloads)}")

    violations = []
    for req in outbound_payloads:
        url = req["url"]
        body = req.get("post_data") or ""
        print(f"  Captured: {req['method']} {url} (size: {len(body)} bytes)")

        # Assert zero plain secrets in request payload
        for secret in SENSITIVE_TEST_VALUES:
            if secret in body:
                violations.append(f"Synthetic privacy sentinel matched in request to {url}!")

        # Check payload shape and that sensitive controls are represented by
        # sanitized DOM values. This does not decode or prove screenshot pixels.
        if "/vision" in url:
            parsed = json.loads(body)
            assert str(parsed.get("sanitized_screenshot", "")).startswith("data:image/"), "Vision payload missing screenshot data URL"
            elements = parsed.get("sanitized_dom", {}).get("elements", [])
            for element in elements:
                if element.get("sensitive"):
                    assert element.get("value") == "[REDACTED]", "Sensitive DOM value was not redacted"

        # Verify reasoning payload uses symbolic references
        if "/reason" in url:
            # Check for symbolic tokens
            has_symbolic = any(tok in body for tok in ["LOCAL_AADHAAR", "LOCAL_PAN", "LOCAL_FULL_NAME", "LOCAL_PASSWORD"])
            if has_symbolic:
                print("    ✔ Found symbolic vault reference in /reason payload")

    print(f"\nPrivacy assertion result: {len(violations)} violations detected.")
    if violations:
        for v in violations:
            print("❌ " + v)
        raise AssertionError("Privacy boundary violated: plaintext secrets found in outbound payloads!")
    else:
        if outbound_payloads:
            print("✔ Known synthetic sentinels were absent from captured extension-to-backend payloads.")
        else:
            print("ℹ No extension-to-backend model payloads were captured in this run.")
        print("  This run does not establish protection for unknown PII or inspect backend-to-provider egress.")

    # --- LATENCY SUMMARY ---
    print("\n----------------------------------------------------------------")
    print("MEASURED PERFORMANCE LATENCIES")
    print("----------------------------------------------------------------")
    print(f"  DOM query probe:                {latencies.get('dom_query_probe_ms', 'not measured')} ms")
    for endpoint in ("/vision", "/reason", "/interpret"):
        samples = [r["duration_ms"] for r in outbound_payloads if endpoint in r["url"] and r["duration_ms"] is not None]
        if samples:
            average = round(sum(samples) / len(samples), 2)
            print(f"  {endpoint} roundtrip:            n={len(samples)}, avg={average} ms, max={max(samples)} ms")
        else:
            print(f"  {endpoint} roundtrip:            not observed")
    print(f"  Complete workflow:              {latencies.get('total_workflow_seconds', 'not completed')} seconds")
    print("----------------------------------------------------------------\n")
    return True

if __name__ == "__main__":
    ok = run_privacy_and_latency_audit()
    sys.exit(0 if ok else 1)
