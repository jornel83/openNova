"""Exercise the production latent check for geometries outside the pinned benchmark."""
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tools.video.veda_worker import install_clip_summary


class ClipSummaryTests(unittest.TestCase):
    def setUp(self):
        # Match the pinned node's helper interface without allocating GPU tensors.
        module = ModuleType('pinned_benchmark')
        module.canonical_request_id = lambda value: value
        module._torch_finite = lambda tensor: tensor.finite
        module._output_directory = lambda: Path('output/veda-benchmark')
        self.write = module._write_exclusive = Mock()
        modules = patch.dict(sys.modules, {module.__name__: module})
        modules.start()
        self.addCleanup(modules.stop)
        self.registry = {'H3BenchmarkSummary': type('BenchmarkSummary', (), {'__module__': module.__name__})}
        self.report = json.dumps(dict(request_id='request', mode='ON', evaluations=4, finite_model_outputs=True))

    def summary(self, frames):
        install_clip_summary(self.registry, 'request', dict(width=576, height=1024, length=frames))
        tensors = (SimpleNamespace(shape=(1, 24, (frames - 5) // 17 * 5 + 2, 64, 36), finite=True),
                   SimpleNamespace(shape=(1, 32, 2, round(frames * 40 / 24)), finite=True))
        samples = {'samples': SimpleNamespace(is_nested=True, unbind=lambda: tensors)}
        return self.registry['OpenNovaClipSummary'](), samples, tensors

    def test_registered_workflow_checks_all_output_lengths(self):
        workflow = json.loads((Path(__file__).resolve().parents[1] / 'veda_workflow.json').read_text())
        for frames in [107, 124, 158, 175, 192, 226, 243, 277, 294, 328, 345, 362]:
            with self.subTest(frames=frames):
                node, samples, _ = self.summary(frames)
                self.assertIsInstance(node, self.registry[workflow['summary']['class_type']])
                result = node.save(samples, self.report, 576, 1024, frames, 4, 'ON')
                self.assertIs(result['result'][0], samples)
                self.assertTrue(self.write.call_args.args[1]['finite_latents'])

    def test_rejects_mismatched_request_geometry_audio_or_nonfinite_latents(self):
        for mismatch in ('id', 'geometry', 'audio', 'nonfinite'):
            with self.subTest(mismatch=mismatch):
                node, samples, tensors = self.summary(192)
                report = json.dumps({**json.loads(self.report), 'request_id': 'other'}) if mismatch == 'id' else self.report
                frames = 226 if mismatch == 'geometry' else 192
                if mismatch == 'audio':
                    tensors[1].shape = (1, 32, 2, 1)
                if mismatch == 'nonfinite':
                    tensors[0].finite = False
                with self.assertRaises(ValueError):
                    node.save(samples, report, 576, 1024, frames, 4, 'ON')
        self.write.assert_not_called()
