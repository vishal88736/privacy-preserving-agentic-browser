import sys, time
from playwright.sync_api import sync_playwright
sys.path.append('.')
from tests.e2e_master_hardening_suite import setup_browser

def run():
    with sync_playwright() as p:
        context, ext_id = setup_browser(p)
        page = context.pages[0] if context.pages else context.new_page()
        
        # Attach listener to service worker
        for sw in context.service_workers:
            if ext_id in sw.url:
                sw.on("console", lambda msg: print(f"[SW] {msg.text}"))
        
        context.on("serviceworker", lambda sw: sw.on("console", lambda msg: print(f"[SW] {msg.text}")))

        page.goto("http://localhost:5000/page-b-sensitive-form.html")
        page.wait_for_load_state("networkidle")
        sp = context.new_page()
        sp.goto(f"chrome-extension://{ext_id}/sidepanel/index.html")
        sp.wait_for_load_state("networkidle")
        time.sleep(1)
        sp.fill("#task-prompt", "Fill this application using my saved profile and ask before submitting")
        sp.click("#start-task-btn")
        for _ in range(15):
            time.sleep(1)
            if sp.is_visible("#action-confirmation-modal"):
                sp.click("#modal-approve-btn")
run()
