from tests.e2e_master_hardening_suite import test_3_sensitive_form
try:
    test_3_sensitive_form()
except Exception as e:
    print(f"Error: {e}")
