#!/usr/bin/env python3
"""Launch Chromium with the PrivAgent extension loaded and side panel opened.

This script launches the Chromium browser (Playwright Chromium) with:
1. PrivAgent extension unpacked and loaded.
2. The PrivAgent side panel opened and authenticated to the local backend.
3. A web page tab (YouTube/Google) opened ready for testing.
"""

import os
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "tests"))

try:
    from e2e_support import resolve_browser_path, resolve_extension_path
except ImportError:
    def resolve_extension_path():
        return str(REPO_ROOT / "extension")
    def resolve_browser_path():
        playwright_path = Path("/home/vishal/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")
        if playwright_path.exists():
            return str(playwright_path)
        return None

def main():
    browser_bin = resolve_browser_path()
    if not browser_bin:
        print("❌ Error: No Chromium executable found.")
        sys.exit(1)

    ext_path = resolve_extension_path()
    user_data_dir = str(REPO_ROOT / "scratch" / "test-browser-profile")
    os.makedirs(user_data_dir, exist_ok=True)

    # Read backend secret token from .env if present
    backend_token = ""
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("BACKEND_SHARED_SECRET="):
                backend_token = line.split("=", 1)[1].strip().strip('"').strip("'")
                break

    print("=" * 60)
    print("🚀 Launching Chromium Test Browser with PrivAgent Extension")
    print(f"   Browser:   {browser_bin}")
    print(f"   Extension: {ext_path}")
    print(f"   Backend:   http://localhost:8000")
    print("=" * 60)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            executable_path=browser_bin,
            headless=False,
            args=[
                f"--disable-extensions-except={ext_path}",
                f"--load-extension={ext_path}",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--autoplay-policy=no-user-gesture-required",
            ],
            viewport={"width": 1280, "height": 850},
        )

        # Discover Extension ID
        print("⏳ Detecting PrivAgent extension ID...")
        ext_id = None
        for _ in range(30):
            for sw in context.service_workers:
                if "chrome-extension://" in sw.url:
                    ext_id = sw.url.split("/")[2]
                    break
            if ext_id:
                break
            if context.background_pages:
                ext_id = context.background_pages[0].url.split("/")[2]
                break
            time.sleep(0.3)

        if not ext_id:
            # Wake up extension via extensions page if needed
            temp_page = context.new_page()
            try:
                temp_page.goto("chrome://extensions", timeout=5000)
            except Exception:
                pass
            time.sleep(1)
            for sw in context.service_workers:
                if "chrome-extension://" in sw.url:
                    ext_id = sw.url.split("/")[2]
                    break
            try:
                temp_page.close()
            except Exception:
                pass

        if not ext_id:
            print("⚠️ Warning: Could not auto-detect extension ID from service worker.")
            print("   Please check chrome://extensions to inspect the loaded extension.")
        else:
            sidepanel_url = f"chrome-extension://{ext_id}/sidepanel/index.html"
            print(f"✅ Extension ID: {ext_id}")
            print(f"✅ Side Panel URL: {sidepanel_url}")

            # Open Side Panel in first page
            panel_page = context.pages[0] if context.pages else context.new_page()
            panel_page.goto(sidepanel_url)
            panel_page.wait_for_load_state("domcontentloaded")

            # Configure backend token in extension so it is authenticated
            if backend_token:
                panel_page.evaluate("""async (token) => {
                    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                        await new Promise((resolve) => {
                            chrome.runtime.sendMessage(
                                {
                                    type: 'UPDATE_SETTINGS',
                                    payload: {
                                        backendUrl: 'http://localhost:8000',
                                        backendToken: token,
                                        alwaysConfirm: false
                                    }
                                },
                                (res) => resolve(res)
                            );
                        });
                    }
                    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                        chrome.storage.local.get(['privagent_settings'], (res) => {
                            const current = res.privagent_settings || {};
                            current.backendUrl = 'http://localhost:8000';
                            current.backendToken = token;
                            chrome.storage.local.set({ privagent_settings: current });
                        });
                    }
                    const tokenInput = document.getElementById('settings-backend-token');
                    if (tokenInput) tokenInput.value = token;
                    const urlInput = document.getElementById('settings-backend');
                    if (urlInput) urlInput.value = 'http://localhost:8000';
                }""", backend_token)
                print("🔑 Pre-configured and authenticated backend token in extension.")

            # Open YouTube in a second tab
            web_page = context.new_page()
            print("🌐 Opening YouTube in second tab...")
            try:
                web_page.goto("https://www.youtube.com", timeout=15000)
            except Exception as e:
                print(f"   (YouTube load notice: {e})")

            # Bring side panel page to attention or side by side
            panel_page.bring_to_front()

        print("\n" + "=" * 60)
        print("✨ Browser is ready! Keep this process running while testing.")
        print("   Press Ctrl+C in this terminal when finished.")
        print("=" * 60 + "\n")

        # Keep browser open until all pages are closed by user
        try:
            while context.pages:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nExiting browser...")
        finally:
            context.close()

if __name__ == "__main__":
    main()
