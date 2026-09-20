import os
import time
from playwright.sync_api import sync_playwright

EXT_PATH = os.path.abspath("extension")
BROWSER_BIN = "/home/vishal/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
USER_DATA = "/tmp/test_chrome_profile_privagent_debug"

with sync_playwright() as p:
    os.system(f"rm -rf {USER_DATA}")
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
    
    if ext_id:
        # hook sw console
        for sw in context.service_workers:
            sw.on("console", lambda msg: print(f"[SW] {msg.text}"))

    page = context.pages[0] if context.pages else context.new_page()
    page.goto("http://localhost:5000/page-b-sensitive-form.html")
    page.wait_for_load_state("networkidle")

    sp = context.new_page()
    sp.goto(f"chrome-extension://{ext_id}/sidepanel/index.html")
    sp.wait_for_load_state("networkidle")
    time.sleep(1)

    sp.on("console", lambda msg: print(f"[SP] {msg.text}"))
    page.on("console", lambda msg: print(f"[PG] {msg.text}"))

    sp.fill("#task-prompt", "Fill this application using my saved profile and ask before submitting")
    sp.click("#start-task-btn")

    for sec in range(15):
        time.sleep(1)
        confirm_visible = sp.is_visible("#confirmation-modal")
        state = sp.inner_text("#agent-state-text")
        print(f"[Sec {sec}] State: {state}, confirm_visible: {confirm_visible}")
        if confirm_visible:
            sp.click("#modal-approve-btn")

    context.close()
