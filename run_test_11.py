import sys
sys.path.append('tests')
from e2e_master_hardening_suite import test_11_complex_forms
try:
    test_11_complex_forms()
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
