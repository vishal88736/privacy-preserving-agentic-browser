import os
import time
from playwright.sync_api import sync_playwright

EXT_PATH = os.path.abspath("extension")
CHROMIUM_EXEC = "/home/vishal/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
OUT_DIR = os.path.abspath("tests/qa_screenshots")
os.makedirs(OUT_DIR, exist_ok=True)

def run_visual_qa():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            "",
            executable_path=CHROMIUM_EXEC,
            headless=True,
            args=[
                f"--disable-extensions-except={EXT_PATH}",
                f"--load-extension={EXT_PATH}",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        
        # Discover Extension ID
        ext_id = None
        for _ in range(20):
            for sw in context.service_workers:
                if "chrome-extension://" in sw.url:
                    ext_id = sw.url.split("/")[2]
                    break
            if ext_id:
                break
            time.sleep(0.3)
            
        if not ext_id:
            background_pages = context.background_pages
            if background_pages:
                ext_id = background_pages[0].url.split("/")[2]
                
        print(f"Extension ID discovered: {ext_id}")
        assert ext_id, "Could not discover extension ID"

        # Create page for side panel
        page = context.new_page()
        sidepanel_url = f"chrome-extension://{ext_id}/sidepanel/index.html"
        
        # 1. Test 360px width - Default Dark Mode - Empty State
        page.set_viewport_size({"width": 360, "height": 720})
        page.goto(sidepanel_url)
        page.wait_for_load_state("networkidle")
        time.sleep(0.5)
        page.screenshot(path=os.path.join(OUT_DIR, "01_empty_state_dark_360.png"))
        print("✓ Captured 01_empty_state_dark_360.png")

        # 2. Test Light Mode Toggle
        page.click("#theme-btn")
        time.sleep(0.3)
        page.screenshot(path=os.path.join(OUT_DIR, "02_empty_state_light_360.png"))
        print("✓ Captured 02_empty_state_light_360.png")
        
        # Toggle back to dark
        page.click("#theme-btn")
        time.sleep(0.2)

        # 3. Test Narrow Width 320px
        page.set_viewport_size({"width": 320, "height": 720})
        time.sleep(0.3)
        page.screenshot(path=os.path.join(OUT_DIR, "03_narrow_width_320.png"))
        print("✓ Captured 03_narrow_width_320.png")

        # Reset to 380px for rich state inspections
        page.set_viewport_size({"width": 380, "height": 780})

        # 4. Long Task Input Text & Focus
        long_prompt = "Fill out this official citizen verification application form using my saved local profile credentials. Redact my Aadhaar and PAN numbers, choose Pune as residence, and ask for explicit confirmation before submitting."
        page.fill("#task-prompt", long_prompt)
        page.screenshot(path=os.path.join(OUT_DIR, "04_task_input_filled.png"))
        print("✓ Captured 04_task_input_filled.png")

        # 5. Active Running State + Progress Timeline + Activity Feed
        page.evaluate("""() => {
            const app = window.privAgentApp;
            app.task = {
                id: 'task_qa_123',
                state: 'OBSERVING',
                stateDetail: 'Scanning page structure & interactive form fields...',
                prompt: 'Fill application form using saved profile',
                currentStep: 2,
                maxSteps: 25,
                tabId: 101,
                privacyMetrics: {
                    sensitiveFieldsDetected: 3,
                    sensitiveFieldsCurrent: 3,
                    serverCallsCount: 2,
                    detectedCategories: ['Aadhaar', 'PAN', 'Password']
                },
                steps: [
                    {
                        stepNumber: 1,
                        timestamp: Date.now() - 3000,
                        thought: 'Page analyzed. 14 interactive inputs detected. Sanitized Aadhaar and PAN fields locally.',
                        action: { action: 'TYPE', target: { label: 'Full Name' }, risk: 'LOW', value_source: 'LOCAL_FULL_NAME' }
                    },
                    {
                        stepNumber: 2,
                        timestamp: Date.now() - 1000,
                        thought: 'Analyzing visual layout. Masked sensitive identity boxes. Grounding submit button.',
                        action: { action: 'CLICK', target: { label: 'Next Step' }, risk: 'LOW' }
                    }
                ]
            };
            app.renderAll();
            app.feed.replaceChildren();
            app.task.steps.forEach(s => app.addStep(s, 'done'));
        }""")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "05_active_running_state.png"))
        print("✓ Captured 05_active_running_state.png")

        # 6. Confirmation Modal UI
        page.evaluate("""() => {
            const app = window.privAgentApp;
            app.showConfirmation({
                action: {
                    action: 'SUBMIT',
                    target: { label: 'Submit Application (#btn-submit-app)' },
                    risk: 'HIGH',
                    value_source: 'LOCAL_AADHAAR, LOCAL_PAN'
                },
                reason: 'This action will submit your completed application to the portal.',
                privacySummary: { dataKeptLocal: 'Aadhaar, PAN & Password (stays on device)' }
            });
        }""")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "06_confirmation_modal.png"))
        print("✓ Captured 06_confirmation_modal.png")

        # Close confirmation modal
        page.click("#modal-reject-btn")
        time.sleep(0.3)

        # 7. Completed / Done State
        page.evaluate("""() => {
            const app = window.privAgentApp;
            app.task.state = 'COMPLETED';
            app.task.currentStep = 4;
            app.renderAll();
            app.showDone({
                result: 'Application submitted successfully. Registration ID: APP-2026-8942'
            });
        }""")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "07_task_completed.png"))
        print("✓ Captured 07_task_completed.png")

        # 8. Error / Attention State
        page.evaluate("""() => {
            const app = window.privAgentApp;
            app.task.state = 'FAILED';
            app.renderAll();
            app.showError(
                'Upload rejected: Verification portal requires a PDF under 2MB.',
                'You can retry with a compressed document or take control manually.'
            );
        }""")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "08_task_error.png"))
        print("✓ Captured 08_task_error.png")

        # 9. Stopped State
        page.evaluate("""() => {
            const app = window.privAgentApp;
            app.showStopped();
        }""")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "09_task_stopped.png"))
        print("✓ Captured 09_task_stopped.png")

        # 10. Local Vault Modal
        page.click("#vault-btn")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "10_vault_modal.png"))
        print("✓ Captured 10_vault_modal.png")
        page.click("#close-vault-btn")
        time.sleep(0.3)

        # 11. Settings Modal
        page.click("#settings-btn")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "11_settings_modal.png"))
        print("✓ Captured 11_settings_modal.png")
        page.click("#close-settings-btn")
        time.sleep(0.3)

        # 12. Privacy Info Sheet
        page.click("#privacy-pill")
        time.sleep(0.4)
        page.screenshot(path=os.path.join(OUT_DIR, "12_privacy_sheet_modal.png"))
        print("✓ Captured 12_privacy_sheet_modal.png")
        page.click("#close-privacy-btn")
        time.sleep(0.3)

        context.close()
        print("\nALL 12 VISUAL QA TESTS COMPLETED SUCCESSFULLY!")

if __name__ == "__main__":
    run_visual_qa()
