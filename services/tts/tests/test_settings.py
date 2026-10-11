import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


class SettingsTests(unittest.TestCase):
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
