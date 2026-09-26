from tests.e2e_master_hardening_suite import test_5_document_upload
import sys

try:
    test_5_document_upload()
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
