"""Offline tests for credential selection and the documented ASR wire protocol."""
import gzip
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import redirect_stdout


SCRIPT = Path(__file__).resolve().parents[1] / 'doubao_asr.py'
spec = importlib.util.spec_from_file_location('doubao_asr', SCRIPT)
asr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asr)


class CredentialTests(unittest.TestCase):
    def test_existing_output_is_rejected_before_reading_audio_or_calling_api(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'result.json'
            output.write_text('keep previous result')
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), '--audio', str(Path(directory) / 'missing.wav'),
                 '--output', str(output)], capture_output=True, text=True,
                env={**os.environ, 'DOUBAO_ASR_API_KEY': 'test-secret'}, timeout=5)
            self.assertEqual(completed.returncode, 1)
            self.assertIn('结果文件已存在', completed.stderr)
            self.assertEqual(output.read_text(), 'keep previous result')

    def test_loads_local_json_and_environment_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'secrets.local.json'
            path.write_text(json.dumps({'doubao': {'api_key_name': 'name', 'api_key': 'test-secret'}}))
            self.assertEqual(asr.load_key(path, environ={}), 'test-secret')
            self.assertEqual(asr.load_key(path, environ={'DOUBAO_ASR_API_KEY': ' override '}), 'override')
            self.assertEqual(asr.load_key(environ={'OPENNOVA_SECRETS_FILE': str(path)}), 'test-secret')

    def test_missing_or_invalid_config_does_not_expose_contents_or_read_readme(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'secrets.local.json'
            (Path(directory) / 'README.md').write_text('API Key: `old-secret`')
            for content in [None, 'private-malformed-value', '[]', '{}',
                            '{"doubao":{"api_key":""}}', '{"doubao":{"api_key":123}}']:
                if content is not None:
                    path.write_text(content)
                with self.subTest(content=content), self.assertRaises(asr.ASRError) as caught:
                    asr.load_key(path, environ={})
                self.assertNotIn('private-malformed-value', str(caught.exception))
                self.assertNotIn('old-secret', str(caught.exception))

    def test_errors_redact_key_before_truncation(self):
        secret = 'unique-test-secret'
        self.assertNotIn(secret, asr.safe_message('API denied ' + secret, secret))
        self.assertNotIn('unique-test', asr.safe_message('x' * 995 + secret, secret))


class ProtocolTests(unittest.TestCase):
    def test_last_audio_packet_marks_end_and_roundtrips_pcm(self):
        packet = asr.encode_packet(b'\x01\x00\x02\x00', audio=True, final=True)
        self.assertEqual(packet[:4], bytes.fromhex('11 22 01 00'))
        self.assertEqual(struct.unpack('>I', packet[4:8])[0], len(packet[8:]))
        self.assertEqual(gzip.decompress(packet[8:]), b'\x01\x00\x02\x00')

    def test_plain_server_frame_without_sequence(self):
        payload = b'{"result":{"text":"hello"}}'
        packet = bytes.fromhex('11 90 10 00') + struct.pack('>I', len(payload)) + payload
        body, final = asr.decode_packet(packet)
        self.assertEqual(body['result']['text'], 'hello')
        self.assertFalse(final)

    def test_gzipped_final_response_uses_signed_sequence(self):
        payload = gzip.compress(b'{"result":{"text":"hello"}}')
        packet = bytes.fromhex('11 93 11 00') + struct.pack('>iI', -3, len(payload)) + payload
        body, final = asr.decode_packet(packet)
        self.assertEqual(body['result']['text'], 'hello')
        self.assertTrue(final)

    def test_error_frame_is_not_a_successful_transcript(self):
        payload = b'resource unavailable'
        packet = bytes.fromhex('11 f0 00 00') + struct.pack('>II', 45000001, len(payload)) + payload
        with self.assertRaisesRegex(asr.ASRError, '45000001'):
            asr.decode_packet(packet)

    def test_truncated_or_unsupported_frames_fail_closed(self):
        for packet in [b'\x11', bytes.fromhex('11 91 10 00 00 00 00 01'),
                       bytes.fromhex('11 90 10 00 00 00 00 09 7b 7d'),
                       bytes.fromhex('21 90 10 00 00 00 00 02 7b 7d'),
                       bytes.fromhex('11 90 12 00 00 00 00 02 7b 7d')]:
            with self.subTest(packet=packet.hex()), self.assertRaises(asr.ASRError):
                asr.decode_packet(packet)

    def test_partial_revisions_replace_text_and_require_terminal_frame(self):
        result = asr.Transcript()
        result.update({'result': {'text': '这句话'}}, False)
        result.update({'result': {'text': '这句太抽象。'}}, False)
        with self.assertRaises(asr.ASRError):
            result.finish()
        result.update({'result': {'text': '这句太抽象。'}}, True)
        self.assertEqual(result.finish(), '这句太抽象。')

    def test_error_status_and_empty_final_are_not_success(self):
        with self.assertRaises(asr.ASRError):
            asr.Transcript().update({'code': 45000002, 'message': 'empty audio'}, True)
        result = asr.Transcript()
        result.update({'result': {'text': ''}}, True)
        with self.assertRaises(asr.ASRError):
            result.finish()


class LiveOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_progress_and_final_text_are_visible_even_without_final_revision(self):
        incoming = asyncio.Queue()

        def respond(text=None, final=False):
            body = {} if text is None else {'result': {'text': text}}
            payload = json.dumps(body).encode()
            header = bytes([0x11, 0x92 if final else 0x90, 0x10, 0])
            incoming.put_nowait(header + struct.pack('>I', len(payload)) + payload)

        class Socket:
            response = SimpleNamespace(headers={})
            packets = 0

            async def send(self, packet):
                if packet[1] >> 4 == 1:
                    respond()
                else:
                    self.packets += 1
                    if self.packets == 5 or packet[1] & 2:
                        respond('测试实时转写。', final=bool(packet[1] & 2))
                await asyncio.sleep(0)

            def __aiter__(self):
                return self

            async def __anext__(self):
                return await incoming.get()

        class Connection:
            async def __aenter__(self):
                return Socket()

            async def __aexit__(self, *args):
                pass

        async def capture(seconds, device):
            for index in range(10):
                await asyncio.sleep(0)
                yield struct.pack('<h', 1200) * 3200, index == 9

        class InvalidStatus(Exception):
            pass

        modules = {
            'websockets.asyncio.client': SimpleNamespace(connect=lambda *a, **kw: Connection()),
            'websockets.exceptions': SimpleNamespace(InvalidStatus=InvalidStatus),
        }
        output = io.StringIO()
        with patch.dict(sys.modules, modules), patch.object(asr, 'microphone_chunks', capture), redirect_stdout(output):
            report = await asr.recognize(None, 'test-secret', 'test-resource', mic_seconds=2)
        self.assertTrue(report['success'])
        self.assertEqual(report['text'], '测试实时转写。')
        log = output.getvalue()
        self.assertIn('收音 1.0/2 秒', log)
        self.assertIn('音量峰值 1200/32768', log)
        self.assertIn('已发送 5 包', log)
        self.assertIn('收到 3 条响应', log)
        self.assertIn('最终：测试实时转写。', log)
        self.assertNotIn('test-secret', log)


class MicrophoneTests(unittest.IsolatedAsyncioTestCase):
    def fake_device(self, blocks, status=False):
        """Replace only the physical sounddevice boundary, with PCM callbacks."""
        lifecycle = []

        class InputStream:
            def __init__(self, **kwargs):
                self.callback = kwargs['callback']
                assert (kwargs['samplerate'], kwargs['channels'], kwargs['dtype']) == (16000, 1, 'int16')

            def __enter__(self):
                lifecycle.append('opened')
                for block in blocks:
                    self.callback(block, len(block) // 2, None, status)
                return self

            def __exit__(self, *args):
                lifecycle.append('closed')

        return SimpleNamespace(RawInputStream=InputStream), lifecycle

    async def test_mic_yields_live_pcm_and_marks_exact_capture_duration(self):
        fake, lifecycle = self.fake_device([b'\x01\x00' * 3200] * 3)
        with patch.dict(sys.modules, {'sounddevice': fake}):
            chunks = [chunk async for chunk in asr.microphone_chunks(0.45)]
        self.assertEqual([len(data) for data, final in chunks], [6400, 6400, 1600])
        self.assertEqual([final for data, final in chunks], [False, False, True])
        self.assertEqual(b''.join(data for data, final in chunks), b'\x01\x00' * 7200)
        self.assertEqual(lifecycle, ['opened', 'closed'])

    async def test_capture_overflow_is_failure_and_closes_microphone(self):
        fake, lifecycle = self.fake_device([b'\x01\x00' * 3200], status=True)
        with patch.dict(sys.modules, {'sounddevice': fake}):
            with self.assertRaises(asr.ASRError):
                _ = [chunk async for chunk in asr.microphone_chunks(1)]
        self.assertEqual(lifecycle, ['opened', 'closed'])

    async def test_stopping_consumer_releases_microphone(self):
        fake, lifecycle = self.fake_device([b'\x01\x00' * 3200] * 2)
        with patch.dict(sys.modules, {'sounddevice': fake}):
            source = asr.microphone_chunks(1)
            await anext(source)
            await source.aclose()
        self.assertEqual(lifecycle, ['opened', 'closed'])

    async def test_slow_consumer_fails_instead_of_silently_dropping_audio(self):
        fake, lifecycle = self.fake_device([b'\x01\x00' * 3200] * 20)
        with patch.dict(sys.modules, {'sounddevice': fake}):
            with self.assertRaises(asr.ASRError):
                _ = [chunk async for chunk in asr.microphone_chunks(10)]
        self.assertEqual(lifecycle, ['opened', 'closed'])


if __name__ == '__main__':
    unittest.main()
