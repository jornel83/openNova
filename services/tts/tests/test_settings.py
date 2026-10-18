import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest


class SettingsTests(unittest.TestCase):
    def test_explicit_studio_payload_does_not_validate_unused_provider(self):
        result = subprocess.run([sys.executable, '-c',
            "from probe_http import vivian_payload; print(vivian_payload('你好')['voice'])"],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, 'OPENNOVA_TTS_PROVIDER': 'invalid'},capture_output=True,text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'Vivian')

    def test_provider_and_voice_follow_config_and_environment(self):
        sys_path = Path(__file__).resolve().parents[1] / 'settings.py'
        spec = importlib.util.spec_from_file_location('tts_settings', sys_path)
        settings = importlib.util.module_from_spec(spec); spec.loader.exec_module(settings)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'voice.json'
            config.write_text(json.dumps({'tts': {'provider': 'cloud', 'doubao_voice': 'female-test'}}))
            self.assertEqual(settings.load_settings(config, environ={})['provider'], 'doubao')
            self.assertEqual(settings.load_settings(config, environ={})['doubao_voice'], 'female-test')
            self.assertEqual(settings.load_settings(config, environ={'OPENNOVA_TTS_PROVIDER': 'studio'})['provider'], 'studio')
            with self.assertRaises(ValueError):
                settings.load_settings(config, environ={'OPENNOVA_TTS_PROVIDER': 'invalid'})

    def test_local_settings_environment_precedence_and_portable_default(self):
        path = Path(__file__).resolve().parents[1] / 'settings.py'
        spec = importlib.util.spec_from_file_location('tts_settings', path)
        settings = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(settings)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'voice.local.json'
            config.write_text(json.dumps({'tts': {'data_dir': '/remote/models', 'url': 'http://localhost:9000'}}))
            self.assertEqual(settings.load_settings(config, environ={})['data_dir'], '/remote/models')
            self.assertEqual(settings.load_settings(config, environ={'OPENNOVA_TTS_DATA_DIR': '/other'})['data_dir'], '/other')
            self.assertEqual(settings.load_settings(config, environ={})['url'], 'http://localhost:9000')
            config.unlink()
            self.assertEqual(settings.load_settings(config, environ={})['data_dir'], str(Path.home() / 'AgentWorkstation'))


if __name__ == '__main__':
    unittest.main()
