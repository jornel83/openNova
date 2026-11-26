"""Packaging diagnostics must retain useful failures without exposing local tokens."""
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'macos/smoke.py'
spec = importlib.util.spec_from_file_location('macos_smoke', SOURCE)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SafeDiagnosticsTests(unittest.TestCase):
    def test_web_launch_tokens_are_removed_from_failed_restart_diagnostics(self):
        raw = ('dsh web: http://127.0.0.1:59999/?token=temporary-local-token_123\n'
               'session "fixture-session" not found\n'
               'details: http://127.0.0.1:59999/?mode=local&token=another-token&view=logs')
        result = smoke.safe(raw)
        self.assertNotIn('temporary-local-token_123', result)
        self.assertNotIn('another-token', result)
        self.assertIn('session "fixture-session" not found', result)
        self.assertIn('&view=logs', result)

    def test_bearer_and_raw_hex_tokens_are_removed(self):
        result = smoke.safe('Authorization: Bearer test-token.value\n' + 'e' * 64)
        self.assertNotIn('test-token.value', result)
        self.assertNotIn('e' * 64, result)
        self.assertIn('Bearer [redacted]', result)


if __name__ == '__main__':
    unittest.main()
