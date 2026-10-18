"""Doubao TTS 2.0: bounded SSE to 24 kHz mono signed-16 PCM, direct HTTPS."""
import base64
import binascii
from contextlib import contextmanager
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'
DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts'
ROOT = Path(__file__).resolve().parents[2]
MAX_EVENT = 2 * 1024 * 1024
MAX_PCM = 120 * 48000


class DoubaoTTSError(ValueError):
    """Only locally authored messages; never echo credentials or remote bodies."""


def _validated_key(key):
    # http.client's invalid-header exception contains the supplied value. Reject
    # malformed credentials ourselves, before it can reach any traceback/logger.
    if len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise DoubaoTTSError('豆包 TTS Key 格式无效，请检查本机配置。')
    return key


def load_tts_key(*, environ=None):
    env = os.environ if environ is None else environ
    key = env.get('DOUBAO_TTS_API_KEY', '').strip()
    if key:
        return _validated_key(key)
    path = Path(env.get('OPENNOVA_SECRETS_FILE') or ROOT / 'config/secrets.local.json').expanduser()
    try:
        section = json.loads(path.read_text(encoding='utf-8'))['doubao']
        key = (section.get('tts_api_key') or section.get('api_key') or '').strip()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise DoubaoTTSError('请在 config/secrets.local.json 配置 doubao.api_key 或 doubao.tts_api_key。') from None
    if not key:
        raise DoubaoTTSError('缺少豆包 TTS Key；请配置 doubao.api_key 或 DOUBAO_TTS_API_KEY。')
    return _validated_key(key)


def service_error(code):
    if code in (401, 403, 45000030):
        return DoubaoTTSError('豆包 TTS 鉴权或资源权限不足；请检查 Key，并在同一应用开通语音合成模型 2.0（45000030 表示资源未授权）。')
    if code in (429, 45000000):
        return DoubaoTTSError('豆包 TTS 调用受限；请检查音色权限、额度和并发限制。')
    return DoubaoTTSError('豆包 TTS 服务请求失败，请稍后重试或检查控制台。')


def decode_sse(response):
    """Yield before EOF, but accept completion only with the terminal success code."""
    fields, size, received, events = [], 0, 0, 0
    started = time.monotonic()
    while True:
        line = response.readline(MAX_EVENT + 1)
        if not line:
            raise DoubaoTTSError('豆包 TTS 音频流提前结束，未收到完成标记。')
        size += len(line)
        if size > MAX_EVENT or time.monotonic() - started > 120:
            raise DoubaoTTSError('豆包 TTS 响应超过大小或时间上限。')
        if line.strip():
            fields.append(line.rstrip(b'\r\n'))
            continue
        data = b'\n'.join(field[5:].lstrip(b' ') for field in fields if field.startswith(b'data:'))
        kind = next((field[6:].strip() for field in fields if field.startswith(b'event:')), b'')
        fields, size = [], 0
        events += 1
        if events > 10000:
            raise DoubaoTTSError('豆包 TTS 事件数量超过上限。')
        if not data:
            continue
        try:
            result = json.loads(data)
            code = result['code']
            if type(code) is not int:
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise DoubaoTTSError('豆包 TTS 返回无效事件。') from None
        if kind in (b'151', b'153'):
            raise service_error(code)
        if code == 20000000:
            if not received or received % 2:
                raise DoubaoTTSError('豆包 TTS 返回空音频或不完整 PCM。')
            return
        if code != 0:
            raise service_error(code)
        encoded = result.get('data')
        if encoded is not None:
            try:
                if not isinstance(encoded, str):
                    raise ValueError()
                pcm = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise DoubaoTTSError('豆包 TTS 返回无效音频编码。') from None
            received += len(pcm)
            if received > MAX_PCM:
                raise DoubaoTTSError('豆包 TTS 音频超过两分钟上限。')
            if pcm:
                yield pcm


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        fp.close()
        raise DoubaoTTSError('豆包 TTS 返回异常重定向，已停止请求。')


@contextmanager
def stream_pcm(text, voice=DEFAULT_VOICE):
    request = urllib.request.Request(ENDPOINT,
        data=json.dumps({'user': {'uid': 'opennova'}, 'req_params': {
            'text': text, 'speaker': voice,
            'audio_params': {'format': 'pcm', 'sample_rate': 24000, 'speech_rate': 0}
        }}).encode(), headers={'Content-Type': 'application/json',
            'X-Api-Key': load_tts_key(), 'X-Api-Resource-Id': 'seed-tts-2.0',
            'X-Api-Request-Id': str(uuid.uuid4())})
    # Domestic TTS traffic does not inherit the GPT HTTP proxy. Never redirect a key.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.headers.get_content_type() != 'text/event-stream':
                raise DoubaoTTSError('豆包 TTS 没有返回预期的 SSE 音频流。')
            yield decode_sse(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise service_error(error.code) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        raise DoubaoTTSError('无法连接豆包 TTS 或音频流超时；请检查当前网络。') from None


def check_service(voice=DEFAULT_VOICE):
    """Small billable synthesis, discarded without opening audio devices."""
    audible = False
    with stream_pcm('你好。', voice) as chunks:
        for pcm in chunks:
            audible = audible or any(pcm)
    if not audible:
        raise DoubaoTTSError('豆包 TTS 预检返回全静音音频。')


if __name__ == '__main__':
    import argparse
    from settings import load_settings
    parser = argparse.ArgumentParser(description='豆包 TTS 短句合成预检；产生少量用量，不打开音频设备。')
    parser.add_argument('--voice', default=load_settings(validate_provider=False)['doubao_voice'])
    args = parser.parse_args()
    try:
        check_service(args.voice)
        print('豆包 TTS 短句合成成功；未播放、未开启麦克风。')
    except DoubaoTTSError as error:
        parser.exit(1, str(error) + '\n')
