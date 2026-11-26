import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from tools.image.schema import ContractError, tool_definitions
from tools.image.tool import invoke
from tools.image import operations


class Crash(BaseException):
    """Simulates process death, bypassing ordinary operation error handling."""


class MediaOperationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / 'input.png'
        Image.new('RGBA', (16, 8), (70, 30, 20, 180)).save(self.source)
        self.args = {'action': 'first_frame', 'sourcePath': 'input.png', 'outputPath': 'delivery/first.png'}
        self.options = dict(base_dir=self.root, state_dir=self.root / 'state', operation_id='test-action',
                            binding={'projectId': 'project-one', 'requestId': 'request-one'})

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, args=None, **kwargs):
        return invoke('media_export', args or self.args, **{**self.options, **kwargs})

    def record(self):
        return json.loads((self.root / 'state/test-action/operation.json').read_text())

    def assert_code(self, code, call):
        with self.assertRaises(ContractError) as captured:
            call()
        self.assertEqual(captured.exception.code, code)

    def test_export_receipt_manifest_and_actual_pixels_agree(self):
        receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(receipt['generation']['remoteCalls'], 0)
        self.assertEqual(receipt['visualReview']['status'], 'not_checked')
        with Image.open(receipt['artifact']['path']) as exported, Image.open(self.source) as source:
            self.assertEqual(exported.convert('RGBA').tobytes(), source.convert('RGBA').tobytes())
        self.assertEqual(self.record()['artifact'], receipt['artifact'])
        self.assertFalse(list((self.root / 'delivery').glob('.opennova-media-*')))

    def test_replay_uses_original_result_even_after_original_source_removed(self):
        first = self.run_tool()
        self.source.unlink()
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            self.assertEqual(self.run_tool(), first)

    def test_same_id_with_changed_arguments_or_binding_is_rejected(self):
        self.run_tool()
        self.assert_code('operation_id_conflict', lambda: self.run_tool({**self.args, 'outputPath': 'another.png'}))
        self.assert_code('operation_id_conflict', lambda: self.run_tool(binding={'projectId': 'project-two'}))

    def test_new_operation_can_export_same_source_again(self):
        self.run_tool()
        receipt = self.run_tool({**self.args, 'outputPath': 'another.png'}, operation_id='new-intent')
        self.assertEqual(receipt['status'], 'completed')

    def test_capture_freezes_input_against_later_edits(self):
        def hook(phase):
            if phase == 'after_prepare':
                Image.new('RGBA', (16, 8), (255, 0, 0, 255)).save(self.source)
        receipt = self.run_tool(hook=hook)
        with Image.open(receipt['artifact']['path']) as exported:
            self.assertEqual(exported.convert('RGBA').getpixel((0, 0)), (70, 30, 20, 180))

    def test_export_rejects_changed_host_bound_source_before_publication(self):
        expected = {str(self.source.resolve()): operations.sha(self.source)}
        Image.new('RGBA', (16, 8), 'red').save(self.source)
        receipt = self.run_tool(expected_reference_hashes=expected)
        self.assertEqual(receipt['error']['code'], 'input_reference_changed')
        self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_bound_export_never_writes_to_a_replacement_parent(self):
        root = self.root.resolve()
        parent = root / 'delivery'
        parent.mkdir()
        expected = operations.identity(parent)
        (root / 'unrelated').mkdir()
        parent.rename(root / 'original-delivery')
        parent.symlink_to(root / 'unrelated', target_is_directory=True)
        result = self.run_tool(expected_output_parent_identity=expected)
        self.assertEqual(result['error']['code'], 'target_parent_changed')
        self.assertFalse((root / 'unrelated/first.png').exists())

    def test_bound_export_final_link_uses_the_open_directory_identity(self):
        root = self.root.resolve()
        parent = root / 'delivery'
        parent.mkdir()
        expected = operations.identity(parent)
        real_link = os.link

        def link_with_renamed_parent(*args, **kwargs):
            parent.rename(root / 'original-delivery')
            parent.mkdir()
            return real_link(*args, **kwargs)

        with patch('tools.image.operations.os.link', side_effect=link_with_renamed_parent):
            receipt = self.run_tool(expected_output_parent_identity=expected)
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse((parent / 'first.png').exists())
        self.assertTrue((root / 'original-delivery/first.png').is_file())

    def test_preexisting_output_is_not_overwritten(self):
        output = self.root / self.args['outputPath']
        output.parent.mkdir()
        output.write_bytes(b'user content')
        receipt = self.run_tool()
        self.assertEqual(receipt['error']['code'], 'media_target_exists')
        self.assertEqual(output.read_bytes(), b'user content')

    def test_target_created_during_render_is_not_overwritten(self):
        output = self.root / self.args['outputPath']
        def hook(phase):
            if phase == 'before_publish':
                output.write_bytes(b'user won the race')
        receipt = self.run_tool(hook=hook)
        self.assertEqual(receipt['error']['code'], 'media_target_exists')
        self.assertEqual(output.read_bytes(), b'user won the race')

    def test_cancel_before_commit_leaves_no_artifact(self):
        receipt = self.run_tool(cancel_check=lambda: True)
        self.assertEqual(receipt['status'], 'cancelled')
        self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_cancel_during_render_is_cancelled_not_failed(self):
        state = {'cancel': False}
        def hook(phase):
            if phase == 'after_prepare':
                state['cancel'] = True
        receipt = self.run_tool(hook=hook, cancel_check=lambda: state['cancel'])
        self.assertEqual(receipt['status'], 'cancelled')
        self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_crash_after_render_reuses_rendered_bytes(self):
        def hook(phase):
            if phase == 'after_render':
                raise Crash()
        with self.assertRaises(Crash):
            self.run_tool(hook=hook)
        self.source.unlink()
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'completed')

    def test_prepared_operation_rejects_changed_executor_or_pillow(self):
        for field in ('executorRevision', 'pillow'):
            with self.subTest(field=field):
                operation_id = 'runtime-' + field
                def hook(phase):
                    if phase == 'after_prepare':
                        raise Crash()
                with self.assertRaises(Crash):
                    self.run_tool(hook=hook, operation_id=operation_id)
                different = {**operations.executor_runtime(), field: 'changed'}
                with patch('tools.image.operations.executor_runtime', return_value=different), \
                        patch('tools.image.export.render_export', side_effect=AssertionError('must not render with changed runtime')):
                    receipt = self.run_tool(operation_id=operation_id)
                self.assertEqual(receipt['status'], 'failed')
                self.assertEqual(receipt['error']['code'], 'media_runtime_changed')
                self.assertNotEqual(receipt['runtime'][field], 'changed')
                self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_completed_operation_retains_original_runtime_after_upgrade(self):
        first = self.run_tool()
        self.assertEqual(set(first['runtime']), {'python', 'pillow', 'executorRevision'})
        self.assertEqual(len(first['runtime']['executorRevision']), 64)
        with patch('tools.image.operations.executor_runtime', side_effect=AssertionError('completed replay needs no new runtime')), \
                patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            self.assertEqual(self.run_tool(), first)

    def test_static_export_does_not_inspect_or_require_video_executables(self):
        with patch('tools.image.operations.shutil.which', side_effect=AssertionError('PNG export must not inspect FFmpeg')):
            receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'completed')
        self.assertNotIn('videoTools', receipt['runtime'])

    def test_prepared_video_rejects_changed_executable_identity_without_running_it(self):
        video = self.root / 'input.mp4'
        video.write_bytes(b'frozen input; rendering must not start in this test')
        executables = self.root / 'executables'
        executables.mkdir()
        for name in ('ffmpeg', 'ffprobe'):
            executable = executables / name
            executable.write_text('#!/bin/sh\nexit 0\n')
            executable.chmod(0o700)
        arguments = {'action': 'video_to_gif', 'sourcePath': str(video), 'outputPath': 'delivery/video.gif'}
        with patch('tools.image.operations.shutil.which', side_effect=lambda name: str(executables / name)):
            for name in ('ffmpeg', 'ffprobe'):
                with self.subTest(tool=name):
                    operation_id = 'runtime-' + name
                    def hook(phase):
                        if phase == 'after_prepare':
                            raise Crash()
                    with self.assertRaises(Crash):
                        self.run_tool(arguments, hook=hook, operation_id=operation_id)
                    # A binary replacement at the same path must change the
                    # frozen identity even if its advertised version were equal.
                    replacement = executables / 'replacement'
                    replacement.write_text('#!/bin/sh\nexit 0\n')
                    replacement.chmod(0o700)
                    replacement.replace(executables / name)
                    with patch('tools.image.export.render_export', side_effect=AssertionError('changed video runtime must not render')):
                        receipt = self.run_tool(arguments, operation_id=operation_id)
                    self.assertEqual(receipt['status'], 'failed')
                    self.assertEqual(receipt['error']['code'], 'media_runtime_changed')
                    current = operations.executor_runtime(video=True)
                    self.assertNotEqual(receipt['runtime']['videoTools'][name], current['videoTools'][name])
                    self.assertFalse((self.root / arguments['outputPath']).exists())

    def test_rendered_operation_reuses_bytes_after_runtime_upgrade(self):
        def hook(phase):
            if phase == 'after_render':
                raise Crash()
        with self.assertRaises(Crash):
            self.run_tool(hook=hook)
        original_runtime = self.record()['runtime']
        with patch('tools.image.operations.executor_runtime', side_effect=AssertionError('publication needs no new runtime')), \
                patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(receipt['runtime'], original_runtime)

    def test_crash_after_publication_recovers_as_completed_even_if_cancelled(self):
        def hook(phase):
            if phase == 'after_publish':
                raise Crash()
        with self.assertRaises(Crash):
            self.run_tool(hook=hook)
        self.assertEqual(self.record()['stage'], 'publishing')
        receipt = self.run_tool(cancel_check=lambda: True)
        self.assertEqual(receipt['status'], 'completed')
        self.assertTrue(Path(receipt['artifact']['path']).exists())

    def test_bookkeeping_error_after_publication_does_not_hide_saved_file(self):
        def hook(phase):
            if phase == 'after_publish':
                raise OSError('simulated notification failure')
        receipt = self.run_tool(hook=hook)
        self.assertEqual(receipt['status'], 'completed')
        self.assertTrue(Path(receipt['artifact']['path']).exists())

    def test_completion_record_write_failure_does_not_persist_failed_status(self):
        write_record = operations.atomic_json
        failed = False
        def fail_once(path, value):
            nonlocal failed
            if value['status'] == 'completed' and not failed:
                failed = True
                raise OSError('completion record temporarily unavailable')
            return write_record(path, value)
        with patch('tools.image.operations.atomic_json', side_effect=fail_once):
            receipt = self.run_tool()
        self.assertTrue(failed)
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(self.record()['status'], 'completed')
        self.assertNotIn('bookkeepingPending', receipt)
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            self.assertEqual(self.run_tool(), receipt)

    def test_persistent_completion_write_failure_reports_saved_file_and_recovers(self):
        write_record = operations.atomic_json
        def unavailable(path, value):
            if value['status'] == 'completed':
                raise OSError('completion record unavailable')
            return write_record(path, value)
        with patch('tools.image.operations.atomic_json', side_effect=unavailable):
            receipt = self.run_tool()
            self.assertEqual(receipt['status'], 'completed')
            self.assertTrue(receipt['bookkeepingPending'])
            self.assertEqual(self.record()['stage'], 'publishing')
            self.assertEqual(self.record()['status'], 'running')
            operations.verify_artifact(receipt['artifact'])
            self.source.unlink()
            with patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
                again = self.run_tool(cancel_check=lambda: True)
            self.assertEqual(again['status'], 'completed')
            self.assertTrue(again['bookkeepingPending'])
        with patch('tools.image.export.render_export', side_effect=AssertionError('must not render again')):
            recovered = self.run_tool(cancel_check=lambda: True)
        self.assertEqual(recovered['status'], 'completed')
        self.assertNotIn('bookkeepingPending', recovered)
        self.assertEqual(recovered['artifact'], receipt['artifact'])
        self.assertEqual(self.record()['status'], 'completed')
        self.assertFalse(list((self.root / 'delivery').glob('.opennova-media-*')))

    def test_changed_publication_copy_is_rejected_before_linking(self):
        def hook(phase):
            if phase == 'before_publish':
                Path(self.record()['publicationPath']).write_bytes(b'not an image')
        receipt = self.run_tool(hook=hook)
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error']['code'], 'publication_copy_changed')
        self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_replaced_publication_copy_does_not_claim_or_remove_foreign_target(self):
        expected = {}
        def hook(phase):
            if phase == 'before_publish':
                temporary = Path(self.record()['publicationPath'])
                output = self.root / self.args['outputPath']
                # Equal bytes are insufficient: both files belong to another writer.
                output.write_bytes(temporary.read_bytes())
                replacement = temporary.with_name('replacement.png')
                replacement.write_bytes(temporary.read_bytes())
                replacement.replace(temporary)
                expected.update(path=temporary, temporary=operations.identity(temporary),
                                output=operations.identity(output), data=output.read_bytes())
        receipt = self.run_tool(hook=hook)
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error']['code'], 'publication_copy_changed')
        output = self.root / self.args['outputPath']
        self.assertEqual(operations.identity(output), expected['output'])
        self.assertEqual(output.read_bytes(), expected['data'])
        self.assertEqual(operations.identity(expected['path']), expected['temporary'])

    def test_copy_replaced_inside_link_is_not_reported_as_verified_output(self):
        link = os.link
        def replaced(source, target):
            replacement = Path(source).with_name('replacement.png')
            replacement.write_bytes(b'foreign content')
            replacement.replace(source)
            link(source, target)
        with patch('tools.image.operations.os.link', side_effect=replaced):
            receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error']['code'], 'publication_copy_changed')
        # An unrecognized inode must remain untouched, even on the failure path.
        self.assertEqual((self.root / self.args['outputPath']).read_bytes(), b'foreign content')
        self.assertEqual(Path(self.record()['publicationPath']).read_bytes(), b'foreign content')

    def test_copy_replaced_inside_link_cannot_claim_identical_existing_target(self):
        link = os.link
        expected = {}
        def replaced(source, target):
            target = Path(target)
            target.write_bytes(Path(source).read_bytes())
            replacement = Path(source).with_name('replacement.png')
            link(target, replacement)
            replacement.replace(source)
            expected.update(identity=operations.identity(target), data=target.read_bytes())
            link(source, target)
        with patch('tools.image.operations.os.link', side_effect=replaced):
            receipt = self.run_tool()
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['error']['code'], 'media_target_exists')
        output = self.root / self.args['outputPath']
        self.assertEqual(operations.identity(output), expected['identity'])
        self.assertEqual(output.read_bytes(), expected['data'])

    def test_fifo_source_is_rejected_without_waiting_for_a_writer(self):
        fifo = self.root / 'pipe.png'
        os.mkfifo(fifo)
        root = Path(__file__).resolve().parents[3]
        request = {'tool': 'media_export', 'arguments': {**self.args, 'sourcePath': str(fifo)},
                   'context': {'operationId': 'fifo', 'workspace': str(self.root), 'stateDir': str(self.root / 'fifo-state')}}
        result = subprocess.run([sys.executable, str(root / 'tools/image/tool.py'), '--request', '-'],
                                input=json.dumps(request), text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        response = json.loads(result.stdout)
        self.assertEqual(response['result']['error']['code'], 'invalid_source_size_or_type')
        self.assertFalse((self.root / self.args['outputPath']).exists())

    def test_changed_committed_file_is_detected_without_rewrite(self):
        receipt = self.run_tool()
        output = Path(receipt['artifact']['path'])
        output.write_bytes(b'external edit')
        self.assert_code('committed_artifact_changed', self.run_tool)
        self.assertEqual(output.read_bytes(), b'external edit')

    def test_snapshot_tampering_after_crash_is_rejected(self):
        def hook(phase):
            if phase == 'after_prepare':
                raise Crash()
        with self.assertRaises(Crash):
            self.run_tool(hook=hook)
        snapshot = Path(self.record()['inputs'][0]['snapshotPath'])
        snapshot.write_bytes(b'tampered')
        receipt = self.run_tool()
        self.assertEqual(receipt['error']['code'], 'input_snapshot_changed')

    def test_parent_replacement_before_publish_is_rejected(self):
        def hook(phase):
            if phase == 'before_publish':
                (self.root / 'delivery').rename(self.root / 'old-delivery')
                (self.root / 'delivery').mkdir()
        receipt = self.run_tool(hook=hook)
        self.assertEqual(receipt['error']['code'], 'target_parent_changed')
        self.assertFalse((self.root / 'delivery/first.png').exists())

    def test_parallel_reentry_does_not_duplicate_work(self):
        observed = []
        def hook(phase):
            if phase == 'after_prepare':
                try:
                    self.run_tool()
                except ContractError as error:
                    observed.append(error.code)
        self.assertEqual(self.run_tool(hook=hook)['status'], 'completed')
        self.assertEqual(observed, ['operation_in_progress'])

    def test_host_fields_are_not_tool_arguments_and_dimensions_are_strict(self):
        for fields in ({'operationId': 'spoof'}, {'width': 64}, {'quality': True}, {'unknown': 1}):
            with self.subTest(fields=fields):
                self.assertRaises(ContractError, lambda: self.run_tool({**self.args, **fields}))

    def test_gif_recovery_requires_a_saved_operation(self):
        self.assert_code('gif_operation_state_missing', lambda: invoke('gif_generate',
            {'motion': 'wave', 'sourcePath': 'input.png', 'outputDir': 'clips'}, **self.options,
            recover_only=True))

    def test_contract_file_and_cli_envelope(self):
        root = Path(__file__).resolve().parents[3]
        self.assertEqual(json.loads((root / 'tools/image/tool-definitions.json').read_text()), tool_definitions())
        request = {'tool': 'media_export', 'arguments': self.args,
                   'context': {'operationId': 'cli-action', 'workspace': str(self.root), 'stateDir': str(self.root / 'cli-state')}}
        result = subprocess.run([sys.executable, str(root / 'tools/image/tool.py'), '--request', '-'],
                                input=json.dumps(request), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads(result.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()
