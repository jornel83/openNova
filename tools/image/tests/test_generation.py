"""Seedream execution and recovery through the normal tool envelope, offline."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from tools.image.generation import run_image
from tools.image.providers import ark_provider as ark
from tools.image.schema import ContractError
from tools.image.tool import invoke


class Crash(BaseException):
    pass


class Client:
    def __init__(self):
        self.calls = []
        self.failure = None

    def create_image(self, payload):
        self.calls.append(payload)
        if self.failure:
            raise self.failure
        size = (1024, 1024)
        if 'x' in payload['size']:
            size = tuple(map(int, payload['size'].split('x')))
        stream = io.BytesIO()
        Image.new('RGB', size, 'orange').save(stream, 'PNG')
        body = {'data':[{'b64_json':base64.b64encode(stream.getvalue()).decode()}],
                'usage':{'generated_images':1,'total_tokens':123,'other':'redact'}}
        return ark.APIResponse(body, 'request-42', 200)

    def close(self):
        pass


class GenerationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.project = self.base/'project'
        self.project.mkdir()
        self.state = self.base/'state'
        self.host = dict(base_dir=self.project, state_dir=self.state, operation_id='op-1',
                         binding={'projectId':'sample','requestId':'first'})
        self.args = dict(mode='create',prompt='Sunshine',outputPath='version-1.png')
        credentials = patch.object(ark, 'resolve_credential', return_value=ark.Credential('sentinel-secret','unit'))
        credentials.start()
        self.addCleanup(credentials.stop)
        self.client = Client()
        factory = patch.object(ark,'ArkClient',return_value=self.client)
        factory.start()
        self.addCleanup(factory.stop)

    def run_image(self, args=None, **kw):
        return invoke('image_generate', self.args if args is None else args, **{**self.host,**kw})

    def test_create_edit_versions_ratio_replay_and_receipt(self):
        result = self.run_image()
        self.assertEqual(result['status'],'completed')
        self.assertEqual(self.client.calls[0]['response_format'], 'url')
        self.assertNotIn('image',self.client.calls[0])
        self.assertEqual(result['generation']['requestId'],'request-42')
        self.assertEqual(result['generation']['usage'],{'generated_images':1,'total_tokens':123})
        args = dict(self.args,mode='edit',references=['version-1.png'],width=640,height=320,
                    outputPath='version-2.webp')
        result2 = self.run_image(args,operation_id='op-2')
        self.assertEqual(result2['status'],'completed',result2)
        self.assertTrue(self.client.calls[1]['image'].startswith('data:image/png;base64,'))
        w,h = map(int,self.client.calls[1]['size'].split('x'))
        self.assertEqual(w,2*h)
        self.assertEqual(result2['inputs'][0]['sha256'],result['artifact']['sha256'])
        self.assertEqual([result2['artifact'][k] for k in ('width','height','format')],[640,320,'webp'])
        (self.project/'version-1.png').unlink()
        self.assertEqual(self.run_image(args,operation_id='op-2'),result2)
        self.assertEqual(len(self.client.calls),2)
        logs = ''.join(p.read_text() for p in self.state.rglob('*.json'))
        self.assertNotIn('sentinel-secret',logs)
        self.assertNotIn('data:image/',logs)

    def test_url_response_saves_image_and_receipt_without_signed_url(self):
        stream = io.BytesIO()
        Image.new('RGB', (1024, 1024)).save(stream, 'PNG')
        url = 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/image.png?signature=private'
        self.client.create_image = Mock(return_value=ark.APIResponse(
            {'data': [{'url': url}], 'usage': {'generated_images': 1}}, 'url-id', 200))
        self.client.download_image = Mock(return_value=stream.getvalue())
        result = self.run_image()
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(self.run_image(), result)
        self.client.create_image.assert_called_once()
        self.client.download_image.assert_called_once()
        self.assertEqual(self.client.download_image.call_args.args, (url,))
        self.assertNotIn('signature=private', ''.join(p.read_text() for p in self.state.rglob('*.json')))

    def test_failed_delivery_keeps_model_receipt_and_never_resubmits(self):
        self.client.create_image = Mock(return_value=ark.APIResponse(
            {'data': [{'url': 'https://invalid.test/?signature=private'}],
             'usage': {'generated_images': 1}}, 'url-id', 200))
        self.client.download_image = Mock(side_effect=ark.ProviderError('download_url_not_allowed', category='download'))
        result = self.run_image()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error']['code'], 'download_url_not_allowed')
        self.assertEqual(result['generation']['requestId'], 'url-id')
        self.assertEqual(result['generation']['usage']['generated_images'], 1)
        self.assertEqual(self.run_image(), result)
        self.client.create_image.assert_called_once()
        self.assertNotIn('signature=private', ''.join(p.read_text() for p in self.state.rglob('*.json')))

    def test_explicit_rejection_and_lost_response_never_resubmit(self):
        for index, unknown in enumerate((True,False)):
            self.client.failure = ark.ProviderError('mocked_failure',category='transient' if unknown else 'permission',
                status_code=500 if unknown else 403,error_code=None if unknown else 'AccessDenied',
                request_id='request-1',outcome_unknown=unknown)
            kw = dict(operation_id=f'op-{index}')
            result = self.run_image(**kw)
            self.assertEqual(result['status'],'unknown' if unknown else 'failed')
            self.assertEqual(result['generation']['requestId'],'request-1')
            self.assertEqual(result['generation']['reason'],'mocked_failure')
            self.assertEqual(self.run_image(**kw),result)
        self.assertEqual(len(self.client.calls),2)

    def test_crash_after_post_reservation_stops_with_unknown(self):
        def hook(stage):
            if stage=='after_reserve':
                raise Crash
        with self.assertRaises(Crash):
            self.run_image(hook=hook)
        self.assertEqual(self.run_image()['status'],'unknown')
        self.assertEqual(self.client.calls,[])

    def test_crash_after_receiving_reuses_saved_bytes_and_preserves_post_count(self):
        def hook(stage):
            if stage=='after_response':
                raise Crash
        with self.assertRaises(Crash):
            self.run_image(hook=hook)
        self.assertEqual(self.run_image()['status'],'completed')
        self.assertEqual(len(self.client.calls),1)

    def test_crash_after_publication_wins_over_late_cancel(self):
        def hook(stage):
            if stage=='after_publish':
                raise Crash
        with self.assertRaises(Crash):
            self.run_image(hook=hook)
        result = self.run_image(cancel_check=lambda:True)
        self.assertEqual(result['status'],'completed',result)
        self.assertEqual(len(self.client.calls),1)

    def test_reference_is_frozen_in_order(self):
        for name,color in [('source.png','red'),('style.png','blue')]:
            Image.new('RGB',(24,24),color).save(self.project/name)
        self.args.update(mode='edit',references=['source.png','style.png'])
        original = (self.project/'source.png').read_bytes()
        def hook(stage):
            if stage=='after_reserve':
                (self.project/'source.png').unlink()
        result = self.run_image(hook=hook)
        self.assertEqual(result['status'],'completed')
        self.assertEqual(base64.b64decode(self.client.calls[0]['image'][0].split(',')[1]),original)

    def test_expected_current_image_version_compares_captured_bytes_before_post(self):
        image = self.project/'current.png'
        Image.new('RGB',(32,32),'blue').save(image)
        expected = {'current.png': hashlib.sha256(image.read_bytes()).hexdigest()}
        self.args.update(mode='edit', references=['current.png'])
        Image.new('RGB',(32,32),'red').save(image)
        result = self.run_image(expected_reference_hashes=expected)
        self.assertEqual(result['error']['code'], 'reference_version_changed')
        self.assertEqual(self.client.calls, [])
        expected['current.png'] = hashlib.sha256(image.read_bytes()).hexdigest()
        result = self.run_image(expected_reference_hashes=expected, operation_id='op-2')
        self.assertEqual(result['status'], 'completed')
        with self.assertRaisesRegex(ContractError,'operation_id_conflict'):
            self.run_image(expected_reference_hashes={}, operation_id='op-2')

    def test_recover_only_cannot_submit_even_before_first_post(self):
        with self.assertRaisesRegex(ContractError,'image_operation_state_missing'):
            self.run_image(recover_only=True)
        self.assertFalse(self.state.exists())
        with patch.object(ark,'resolve_credential',side_effect=Crash):
            with self.assertRaises(Crash):
                self.run_image()
        with self.assertRaisesRegex(ContractError,'image_recovery_not_submitted'):
            self.run_image(recover_only=True)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.run_image()['status'],'completed')

    def test_recover_only_after_persisting_response_uses_no_key(self):
        def hook(stage):
            if stage=='after_response':
                raise Crash
        with self.assertRaises(Crash):
            self.run_image(hook=hook)
        with patch.object(ark,'resolve_credential',side_effect=AssertionError('must remain offline')):
            self.assertEqual(self.run_image(recover_only=True)['status'],'completed')
        self.assertEqual(len(self.client.calls),1)

    def test_invalid_parameters_and_escaping_paths_make_no_requests(self):
        outside = self.base/'private.png'
        Image.new('RGB',(32,32)).save(outside)
        (self.project/'link.png').symlink_to(outside)
        for i,changes in enumerate([{'outputPath':'../not-in-project.png'},
                                    {'mode':'edit','references':['link.png']},
                                    {'mode':'edit','references':['../private.png']},
                                    {'outputPath':'exists.png'},{'outputPath':'missing/file.png'},
                                    {'size':'128x128'},{'outputPath':'bad.gif'},{'model':'unknown'}]):
            (self.project/'exists.png').touch()
            try:
                result=self.run_image({**self.args,**changes},operation_id=f'invalid-{i}')
            except ContractError:
                continue
            self.assertEqual(result['status'],'failed')
        self.assertEqual(len(self.client.calls),0)

    def test_replay_with_changed_parameters_or_missing_record_does_not_regenerate(self):
        self.run_image()
        with self.assertRaisesRegex(ContractError,'operation_id_conflict'):
            self.run_image(dict(self.args,prompt='Different'))
        (self.state/'op-1/operation.json').unlink()
        with self.assertRaisesRegex(ContractError,'image_operation_state_missing'):
            self.run_image()
        self.assertEqual(len(self.client.calls),1)


if __name__=='__main__':
    unittest.main()
