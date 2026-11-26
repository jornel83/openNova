"""Exercises durable GIF submission and delivery without network calls."""
import base64
import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

from tools.image.gif_generation import run_gif
from tools.image.providers import ark_provider as ark
from tools.image.schema import ContractError


class Crash(BaseException):
    pass


class Client:
    def __init__(self, fixture):
        self.fixture = fixture
        self.posts = []
        self.queries = []
        self.downloads = 0
        self.submit_error = None
        self.status = 'running'
        self.download_error = None

    def create_video(self, payload):
        self.posts.append(payload)
        if self.submit_error:
            raise self.submit_error
        return ark.APIResponse({'id': 'same-video-id'}, 'create-label', 200)

    def get_video(self, task_id):
        self.queries.append(task_id)
        return ark.APIResponse({'id': task_id, 'status': self.status,
                                'content': {'video_url': 'https://example.test/private-signed-data'}}, 'status-label', 200)

    def download_video(self, url, path):
        self.downloads += 1
        if self.download_error:
            raise self.download_error
        shutil.copyfile(self.fixture, path)

    def close(self):
        pass


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires FFmpeg and ffprobe')
class GifGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        cls.fixture = Path(temporary.name).resolve() / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=96x48:rate=24:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        str(cls.fixture)], check=True, capture_output=True, timeout=20)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.project = root / 'project'
        self.project.mkdir()
        self.state = root / 'state'
        self.source = self.project / 'approved.png'
        Image.new('RGB', (96, 48), 'lightblue').save(self.source)
        self.tool = dict(sourcePath=self.source.name, outputDir='version', motion='Brief blink',
                         width=96, height=48)
        self.host = dict(base_dir=self.project, state_dir=self.state, operation_id='gif-request',
                         binding={'projectId': 'project', 'requestId': 'turn'}, wait_seconds=0)
        self.client = Client(self.fixture)
        credentials = patch.object(ark, 'resolve_credential', return_value=ark.Credential('sentinel-key', 'fixture'))
        credentials.start()
        self.addCleanup(credentials.stop)

    def execute(self, args=None, **options):
        return run_gif(self.tool if args is None else args, client_factory=lambda _: self.client,
                       **{**self.host, **options})

    def test_resume_same_task_and_publish_actual_first_frame(self):
        def interrupt_after_id(phase):
            if phase == 'after_submit':
                raise Crash()

        with self.assertRaises(Crash):
            self.execute(hook=interrupt_after_id)
        waiting = self.execute(recover_only=True)
        self.assertEqual((waiting['status'], waiting['generation']['providerStatus']), ('pending', 'running'))
        self.assertEqual(waiting['generation']['taskId'], 'same-video-id')
        payload = self.client.posts[0]
        self.assertEqual(payload['content'][1]['role'], 'first_frame')
        frozen = base64.b64decode(payload['content'][1]['image_url']['url'].split(',')[1])
        self.assertEqual(hashlib.sha256(frozen).hexdigest(), waiting['inputs'][0]['sha256'])
        self.source.unlink()
        self.client.status = 'succeeded'
        self.client.download_error = ark.ProviderError('download_http_error', status_code=503)
        pending = self.execute(recover_only=True)
        self.assertEqual(pending['error']['code'], 'gif_download_pending')
        self.client.download_error = None
        completed = self.execute(recover_only=True)
        self.assertEqual(completed['status'], 'completed', completed)
        self.assertEqual(self.client.downloads, 2)
        self.assertEqual(self.client.queries, ['same-video-id'] * 3)
        self.assertEqual(len(self.client.posts), 1)
        self.assertEqual(completed['generation']['remoteCalls'], 1)
        self.assertEqual(completed['firstFrameValidation']['scope'], 'exact_decoded_rgba')
        self.assertEqual(completed['artifact']['durationMs'], 4000)
        self.assertEqual(completed['artifact']['frames'], 40)
        self.assertEqual(completed['artifact']['loop'], 0)
        self.assertEqual(completed['artifacts']['video']['sha256'], hashlib.sha256(self.fixture.read_bytes()).hexdigest())
        self.assertEqual(self.execute(), completed)
        self.assertEqual(self.client.downloads, 2)
        self.assertEqual({p.name for p in (self.project / 'version').iterdir()},
                         {'animation.gif', 'first-frame.png', 'source.mp4'})
        journal = ''.join(path.read_text() for path in self.state.rglob('*.json'))
        self.assertNotIn('private-signed-data', journal)
        self.assertNotIn('sentinel-key', journal)
        self.assertNotIn('data:image', journal)

    def test_recover_after_publishing_video_link_does_not_redownload(self):
        def interrupt_after_link(phase):
            if phase == 'after_video_link':
                raise Crash()

        self.execute()
        self.client.status = 'succeeded'
        with self.assertRaises(Crash):
            self.execute(recover_only=True, hook=interrupt_after_link)
        already_published = self.project / 'version' / 'source.mp4'
        self.assertTrue(already_published.exists())
        self.assertEqual(self.execute(recover_only=True)['status'], 'completed')
        self.assertEqual(self.client.downloads, 1)
        self.assertEqual(self.client.queries, ['same-video-id'])

    def test_unknown_submission_never_posts_again(self):
        self.client.submit_error = ark.ProviderError('ark_transport_interrupted', outcome_unknown=True)
        first = self.execute()
        self.assertEqual(first['status'], 'unknown')
        self.assertEqual(self.execute(recover_only=True), first)
        self.assertEqual(self.execute(), first)
        self.assertEqual(len(self.client.posts), 1)
        self.assertEqual(self.client.queries, [])

    def test_runtime_change_preserves_pending_job_until_compatible_runtime_returns(self):
        waiting = self.execute()
        updated = {**waiting['runtime'], 'python': '3.11.999'}
        with patch('tools.image.gif_generation._runtime', return_value=updated):
            with self.assertRaisesRegex(ContractError, 'media_runtime_changed'):
                self.execute(recover_only=True)
        self.assertEqual(self.client.queries, [])
        self.assertEqual(len(self.client.posts), 1)
        self.client.status = 'succeeded'
        finished = self.execute(recover_only=True)
        self.assertEqual(finished['status'], 'completed')
        self.assertEqual(self.client.queries, ['same-video-id'])
        self.assertEqual(len(self.client.posts), 1)

    def test_preflight_reference_and_existing_output_fail_without_post(self):
        failure = self.execute(expected_reference_hashes={self.source.name: '0' * 64})
        self.assertEqual(failure['error']['code'], 'reference_version_changed')
        destination = self.project / 'version'
        destination.mkdir()
        failure = self.execute(operation_id='occupied')
        self.assertEqual(failure['error']['code'], 'media_target_exists')
        self.assertEqual(self.client.posts, [])
        self.assertEqual(list(destination.iterdir()), [])

    def test_change_to_published_artifact_is_reported(self):
        self.execute()
        self.client.status = 'succeeded'
        result = self.execute(recover_only=True)
        Path(result['artifacts']['firstFrame']['path']).write_bytes(b'replaced')
        with self.assertRaisesRegex(ContractError, 'committed_artifact_changed'):
            self.execute(recover_only=True)
        self.assertEqual(self.client.downloads, 1)

    def test_motion_reference_and_fixed_layer_survive_original_file_changes(self):
        motion = self.project / 'clean.png'
        Image.new('RGB', (96, 48), 'lightpink').save(motion)
        motion_hash = hashlib.sha256(motion.read_bytes()).hexdigest()
        title = self.project / 'title.png'
        overlay = Image.new('RGBA', (96, 48))
        ImageDraw.Draw(overlay).rectangle((8, 5, 45, 8), fill=(17, 31, 129, 255))
        overlay.save(title)
        title_hash = hashlib.sha256(title.read_bytes()).hexdigest()
        arguments = {**self.tool, 'motionReferencePath': motion.name, 'fixedOverlayPath': title.name}
        pending = self.execute(arguments)
        self.assertEqual(pending['status'], 'pending')
        actual = base64.b64decode(self.client.posts[0]['content'][1]['image_url']['url'].split(',')[1])
        self.assertEqual(hashlib.sha256(actual).hexdigest(), motion_hash)
        title.unlink()
        self.client.status = 'succeeded'
        result = self.execute(arguments, recover_only=True)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['artifact']['fixedOverlay']['sourceSha256'], title_hash)
        self.assertEqual(result['artifact']['fixedOverlay']['checkedFrames'], 40)


if __name__ == '__main__':
    unittest.main()
