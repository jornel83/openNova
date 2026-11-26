"""Crash, cancellation and reconciliation tests for host-only GIF bundles."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from tools.image import bundle
from tools.image.schema import ContractError


class Crash(BaseException):
    pass


class GIFBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-gif-bundle-')
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.gif'
        Image.new('RGBA', (20, 10), 'red').save(
            self.source, save_all=True, append_images=[Image.new('RGBA', (20, 10), 'blue')],
            duration=[70, 190], loop=4)
        self.arguments = {'action': 'optimize_gif', 'sourcePath': 'input.gif', 'outputPath': 'delivery/result.gif'}
        self.options = {'base_dir': self.root, 'state_dir': self.root / 'state', 'operation_id': 'bundle-one',
                        'binding': {'projectId': 'p1', 'requestId': 'r1'}}
        self.directory = self.root / 'state/.gif-bundles/bundle-one'

    def tearDown(self):
        self.temp.cleanup()

    def run_bundle(self, arguments=None, first_frame_path='delivery/first.png', **options):
        return bundle.run_gif_bundle(arguments or self.arguments, first_frame_path, **{**self.options, **options})

    def record(self):
        return json.loads((self.directory / 'manifest.json').read_text())

    def assert_error(self, code, callback):
        with self.assertRaises(ContractError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def crash_at(self, phase):
        def hook(current):
            if current == phase:
                raise Crash()
        with self.assertRaises(Crash):
            self.run_bundle(hook=hook)

    def test_complete_bundle_manifest_pixels_and_runtime_reconcile(self):
        receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(set(receipt['artifacts']), {'gif', 'firstFrame'})
        self.assertFalse(receipt['publication']['atomicAcrossFiles'])
        self.assertEqual(receipt['generation']['remoteCalls'], 0)
        self.assertEqual(receipt['visualReview']['status'], 'not_checked')
        for artifact in [*receipt['artifacts'].values(), receipt['manifest']]:
            actual = Path(artifact['path']).read_bytes()
            self.assertEqual(artifact['bytes'], len(actual))
            self.assertEqual(artifact['sha256'], hashlib.sha256(actual).hexdigest())
        record = self.record()
        self.assertEqual(record['artifacts'], receipt['artifacts'])
        self.assertEqual(record['binding'], self.options['binding'])
        self.assertEqual(record['request']['sourcePath'], str(self.source.resolve()))
        self.assertEqual(record['runtime']['pillow'], Image.__version__)
        with Image.open(receipt['artifacts']['gif']['path']) as gif, Image.open(receipt['artifacts']['firstFrame']['path']) as first:
            self.assertEqual(gif.convert('RGBA').tobytes(), first.convert('RGBA').tobytes())
        self.assertEqual(receipt['firstFrameValidation']['status'], 'passed')

    def test_completed_replay_does_not_read_original_or_encode_again(self):
        first = self.run_bundle()
        self.source.unlink()
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            self.assertEqual(self.run_bundle(), first)

    def test_same_id_different_arguments_frame_path_and_binding_are_conflicts(self):
        self.run_bundle()
        self.assert_error('operation_id_conflict', lambda: self.run_bundle({**self.arguments, 'colors': 64}))
        self.assert_error('operation_id_conflict', lambda: self.run_bundle(first_frame_path='other.png'))
        self.assert_error('operation_id_conflict', lambda: self.run_bundle(binding={'projectId': 'p2'}))

    def test_preexisting_first_frame_leaves_explicit_terminal_partial_gif(self):
        first = self.root / 'delivery/first.png'
        first.parent.mkdir()
        first.write_bytes(b'never overwrite this')
        receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'partial')
        self.assertEqual(receipt['terminalStatus'], 'failed')
        self.assertEqual(set(receipt['artifacts']), {'gif'})
        self.assertEqual(first.read_bytes(), b'never overwrite this')
        first.unlink()
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('terminal must not dispatch')):
            replay = self.run_bundle()
        self.assertEqual(replay['terminalStatus'], 'failed')
        self.assertFalse(first.exists())

    def test_preexisting_gif_is_never_overwritten(self):
        target = self.root / 'delivery/result.gif'
        target.parent.mkdir()
        target.write_bytes(b'existing user bytes')
        receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['artifacts'], {})
        self.assertEqual(target.read_bytes(), b'existing user bytes')

    def test_cancel_before_dispatch_is_durable_terminal(self):
        receipt = self.run_bundle(cancel_check=lambda: True)
        self.assertEqual(receipt['status'], 'cancelled')
        self.assertFalse((self.root / 'delivery/result.gif').exists())
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('must not dispatch')):
            self.assertEqual(self.run_bundle()['status'], 'cancelled')

    def test_cancel_between_steps_is_partial_and_never_starts_new_child(self):
        state = {'cancel': False}
        def hook(phase):
            if phase == 'after_gif_manifest':
                state['cancel'] = True
        receipt = self.run_bundle(hook=hook, cancel_check=lambda: state['cancel'])
        self.assertEqual(receipt['status'], 'partial')
        self.assertEqual(receipt['terminalStatus'], 'cancelled')
        self.assertFalse((self.directory / 'children/first-frame').exists())
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('terminal must not dispatch')):
            self.assertEqual(self.run_bundle()['terminalStatus'], 'cancelled')

    def test_cancel_during_first_frame_preserves_child_terminal(self):
        state = {'cancel': False}
        def hook(phase):
            if phase == 'firstFrame:after_prepare':
                state['cancel'] = True
        receipt = self.run_bundle(hook=hook, cancel_check=lambda: state['cancel'])
        self.assertEqual(receipt['status'], 'partial')
        self.assertEqual(receipt['terminalStatus'], 'cancelled')
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('terminal must not dispatch')):
            self.assertEqual(self.run_bundle()['terminalStatus'], 'cancelled')

    def test_crash_after_gif_child_commit_reuses_gif_and_runs_only_first_frame(self):
        self.crash_at('after_gif')
        self.source.unlink()
        from tools.image.export import render_export
        seen = []
        def render(spec, destination, **kwargs):
            seen.append(spec['action'])
            self.assertEqual(spec['action'], 'first_frame')
            return render_export(spec, destination, **kwargs)
        with patch('tools.image.export.render_export', side_effect=render):
            receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(seen, ['first_frame'])

    def test_crash_after_first_frame_commit_reuses_both_even_when_cancelled(self):
        self.crash_at('after_first_frame')
        self.source.unlink()
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            receipt = self.run_bundle(cancel_check=lambda: True)
        self.assertEqual(receipt['status'], 'completed')

    def test_crash_after_first_frame_render_reuses_saved_render(self):
        self.crash_at('firstFrame:after_render')
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            self.assertEqual(self.run_bundle()['status'], 'completed')

    def test_missing_parent_manifest_does_not_reinitialize_children(self):
        self.run_bundle()
        (self.directory / 'manifest.json').unlink()
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('must not dispatch')):
            self.assert_error('bundle_manifest_missing', self.run_bundle)
        self.assertTrue((self.root / 'delivery/result.gif').exists())

    def test_failed_initial_record_is_never_reinitialized_as_new_intent(self):
        with patch('tools.image.bundle.atomic_json', side_effect=OSError('disk failure')):
            self.assert_error('bundle_initial_record_failed', self.run_bundle)
        self.assertTrue((self.directory / 'intent.json').exists())
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('must not dispatch')):
            self.assert_error('bundle_manifest_missing', self.run_bundle)

    def test_partial_manifest_write_failure_recovers_saved_gif(self):
        actual = bundle.atomic_json
        failed = {'done': False}
        def save(path, record):
            if record['stage'] == 'gif_committed' and not failed['done']:
                failed['done'] = True
                raise OSError('cannot record committed gif')
            actual(path, record)
        with patch('tools.image.bundle.atomic_json', side_effect=save):
            partial = self.run_bundle()
        self.assertEqual(partial['status'], 'partial')
        self.assertTrue(partial['bookkeepingPending'])
        self.source.unlink()
        self.assertEqual(self.run_bundle()['status'], 'completed')

    def test_completion_write_failure_returns_saved_files_and_replays_without_encoding(self):
        actual = bundle.atomic_json
        def save(path, record):
            if record['stage'] in ('first_frame_committed', 'committed'):
                raise OSError('cannot record complete bundle')
            actual(path, record)
        with patch('tools.image.bundle.atomic_json', side_effect=save):
            receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'completed')
        self.assertTrue(receipt['bookkeepingPending'])
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            replay = self.run_bundle()
        self.assertEqual(replay['status'], 'completed')
        self.assertNotIn('bookkeepingPending', replay)

    def test_terminal_marker_survives_failed_manifest_update(self):
        actual = bundle.atomic_json
        def save(path, record):
            if record.get('terminalStatus'):
                raise OSError('cannot update terminal manifest')
            actual(path, record)
        with patch('tools.image.bundle.atomic_json', side_effect=save):
            receipt = self.run_bundle(cancel_check=lambda: True)
        self.assertEqual(receipt['status'], 'cancelled')
        self.assertTrue(receipt['bookkeepingPending'])
        with patch('tools.image.bundle.run_export', side_effect=AssertionError('must not dispatch')):
            self.assertEqual(self.run_bundle()['status'], 'cancelled')

    def test_pending_child_ledgers_reconcile_without_encoding(self):
        from tools.image import operations
        actual = operations.atomic_json
        def save(path, record):
            if record.get('status') == 'completed':
                raise OSError('child completion record unavailable')
            actual(path, record)
        with patch('tools.image.operations.atomic_json', side_effect=save):
            receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'completed')
        self.assertTrue(receipt['bookkeepingPending'])
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            replay = self.run_bundle()
        self.assertEqual(replay['status'], 'completed')
        self.assertNotIn('bookkeepingPending', replay)
        for child_id in ('gif', 'first-frame'):
            child = json.loads((self.directory / 'children' / child_id / 'operation.json').read_text())
            self.assertEqual(child['status'], 'completed')

    def test_missing_child_record_after_crash_is_not_new_work(self):
        self.crash_at('after_gif')
        (self.directory / 'children/gif/operation.json').unlink()
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            receipt = self.run_bundle()
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error']['code'], 'bundle_child_record_missing')
        self.assertTrue((self.root / 'delivery/result.gif').exists())

    def test_cancelled_partial_reconciles_pending_gif_without_starting_first_frame(self):
        from tools.image import operations
        actual = operations.atomic_json
        state = {'cancel': False}
        def save(path, record):
            if record.get('status') == 'completed':
                raise OSError('child completion record unavailable')
            actual(path, record)
        def hook(phase):
            if phase == 'after_gif_manifest':
                state['cancel'] = True
        with patch('tools.image.operations.atomic_json', side_effect=save):
            receipt = self.run_bundle(hook=hook, cancel_check=lambda: state['cancel'])
        self.assertEqual(receipt['status'], 'partial')
        self.assertEqual(receipt['terminalStatus'], 'cancelled')
        self.assertTrue(receipt['bookkeepingPending'])
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not encode')):
            replay = self.run_bundle()
            repeated = self.run_bundle()
        self.assertEqual(replay, repeated)
        self.assertEqual(replay['terminalStatus'], 'cancelled')
        self.assertNotIn('bookkeepingPending', replay)
        self.assertFalse((self.directory / 'children/first-frame').exists())

    def test_changed_committed_output_is_detected_without_rewrite(self):
        receipt = self.run_bundle()
        gif = Path(receipt['artifacts']['gif']['path'])
        gif.write_bytes(b'external edit')
        self.assert_error('committed_artifact_changed', self.run_bundle)
        self.assertEqual(gif.read_bytes(), b'external edit')

    def test_parallel_bundle_reentry_does_not_duplicate_children(self):
        observed = []
        def hook(phase):
            if phase == 'after_gif':
                try:
                    self.run_bundle()
                except ContractError as error:
                    observed.append(error.code)
        self.assertEqual(self.run_bundle(hook=hook)['status'], 'completed')
        self.assertEqual(observed, ['operation_in_progress'])


if __name__ == '__main__':
    unittest.main()
