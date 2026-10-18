"""Non-secret, per-machine TTS settings shared by client and Studio utilities."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def normalize_provider(provider):
    if provider == 'cloud':
        return 'doubao'
    if provider not in ('studio', 'doubao'):
        raise ValueError('TTS provider 必须为 studio 或 doubao（cloud 为 doubao 别名）。')
    return provider


def default_speed(provider):
    return 1.0 if normalize_provider(provider) == 'doubao' else 1.5


def load_settings(path=None, *, environ=None, validate_provider=True):
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
    provider = env.get('OPENNOVA_TTS_PROVIDER') or section.get('provider') or 'studio'
    return {'data_dir': str(Path(data_dir).expanduser()),
            'provider': normalize_provider(provider) if validate_provider else provider,
            'doubao_voice': env.get('OPENNOVA_DOUBAO_TTS_VOICE') or section.get('doubao_voice') or 'zh_female_vv_uranus_bigtts',
            'url': env.get('OPENNOVA_TTS_URL') or section.get('url') or 'http://127.0.0.1:18000'}


if __name__ == '__main__':
    print(load_settings()['data_dir'])
