#!/usr/bin/env python3
"""
Interactive Test Browser Launcher for PrivAgent
Launches Chromium with the PrivAgent extension loaded, opens the benchmark portal,
and opens the side panel.
"""

import os
import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

WORKSPACE_DIR = os.path.dirname(os.path.abspath(__file__))
EXT_PATH = os.path.join(WORKSPACE_DIR, "extension")
BROWSER_BIN = "/home/vishal/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
USER_DATA = "/tmp/privagent_interactive_test_profile"

def ensure_servers():
    import socket
    def is_port_open(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(('127.0.0.1', port)) == 0

    if not is_port_open(5000):
        print("[Launcher] Starting test server on http://localhost:5000 ...")
        subprocess.Popen([sys.executable, os.path.join(WORKSPACE_DIR, "test-server", "app.py")])
        time.sleep(1)

    if not is_port_open(8000):
        print("[Launcher] Starting backend server on http://localhost:8000 ...")
        subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--app-dir", os.path.join(WORKSPACE_DIR, "backend"), "--port", "8000"])
        time.sleep(2)

def main():
    ensure_servers()

    print("[Launcher] Starting Chromium test browser with PrivAgent extension...")
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA,
            executable_path=BROWSER_BIN,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT_PATH}",
                f"--load-extension={EXT_PATH}",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--enable-features=SidePanelEntryPoints"
            ]
        )

        ext_id = None
        for _ in range(25):
            for sw in context.service_workers:
                if "chrome-extension://" in sw.url:
                    ext_id = sw.url.split("/")[2]
                    break
            if ext_id:
                break
            time.sleep(0.2)

        if not ext_id:
            dummy = context.new_page()
            dummy.goto("chrome://extensions")
            time.sleep(1)
            for sw in context.service_workers:
                if "chrome-extension://" in sw.url:
                    ext_id = sw.url.split("/")[2]
                    break
            dummy.close()

        print(f"[Launcher] PrivAgent loaded with Extension ID: {ext_id}")

        # Page 1: Flight comparison test portal
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("http://localhost:5000/flight-search.html")
        print("[Launcher] Tab 1: Opened http://localhost:5000/flight-search.html")

        # Page 2: PrivAgent Side Panel UI
        if ext_id:
            sp = context.new_page()
            sp.goto(f"chrome-extension://{ext_id}/sidepanel/index.html")
            print(f"[Launcher] Tab 2: Opened PrivAgent UI at chrome-extension://{ext_id}/sidepanel/index.html")

        print("\n" + "="*60)
        print("  PrivAgent Test Browser is now running!")
        print("  - Tab 1: Flight search benchmark portal (http://localhost:5000/flight-search.html)")
        print("  - Tab 2: PrivAgent Side Panel")
        print("  Keep this window open to interact with the agent.")
        print("="*60 + "\n")

        # Keep alive while browser windows exist
        try:
            while len(context.pages) > 0:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                context.close()
            except Exception:
                pass

if __name__ == "__main__":
    main()
