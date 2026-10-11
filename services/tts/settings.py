"""Non-secret, per-machine TTS settings shared by client and Studio utilities."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_settings(path=None, *, environ=None):
    env = os.environ if environ is None else environ
    path = Path(path or env.get('OPENNOVA_CONFIG') or ROOT / 'config/voice.local.json').expanduser()
    try:
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        section = data.get('tts', {})
        if not isinstance(section, dict) or any(not isinstance(v, str) for v in section.values()):
            raise ValueError()
    except (OSError, UnicodeError, ValueError, AttributeError):
        raise ValueError('Invalid TTS settings in config/voice.local.json (OPENNOVA_CONFIG).') from None
    data_dir = env.get('OPENNOVA_TTS_DATA_DIR') or section.get('data_dir') or str(Path.home() / 'AgentWorkstation')
    return {'data_dir': str(Path(data_dir).expanduser()),
            'url': env.get('OPENNOVA_TTS_URL') or section.get('url') or 'http://127.0.0.1:18000'}


if __name__ == '__main__':
    print(load_settings()['data_dir'])
