import sys
sys.path.append('tests')
from e2e_master_hardening_suite import test_5_document_upload
try:
    test_5_document_upload()
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
