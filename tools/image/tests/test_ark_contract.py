"""Provider switch contracts; no remote inference."""
from pathlib import Path
import unittest

from tools.image.schema import ContractError, normalize


class ArkContractTests(unittest.TestCase):
    def test_image_defaults_to_ark_and_keeps_reference_edit(self):
        args = normalize('image_generate', {'mode': 'edit', 'prompt': '保持身份，换为白色卫衣',
                         'references': ['person.png'], 'outputPath': 'result.png', 'size': '1024x1024'}, Path.cwd())
        self.assertEqual(args['provider'], 'ark')
        self.assertTrue(Path(args['references'][0]).is_absolute())

    def test_seedream_model_matches_executor_and_allows_omission(self):
        from tools.image.providers.ark_provider import IMAGE_MODEL
        from tools.image.schema import SCHEMAS
        model = SCHEMAS['image_generate']['properties']['model']
        self.assertEqual(model['enum'], [IMAGE_MODEL, 'minimax-h3-image'])
        self.assertEqual(model['default'], IMAGE_MODEL)
        args = {'mode': 'create', 'outputPath': 'test.png', 'prompt': 'image'}
        self.assertNotIn('model', SCHEMAS['image_generate']['required'])
        for options in ({}, {'model': IMAGE_MODEL}):
            normalize('image_generate', {**args, **options}, Path.cwd())
        with self.assertRaises(ContractError):
            normalize('image_generate', {**args, 'model': 'seedream-5.5'}, Path.cwd())

    def test_gif_defaults_to_video_route(self):
        args = normalize('gif_generate', {'sourcePath': 'approved.png', 'outputDir': 'exports',
                         'motion': '眨眼', 'durationSeconds': 4, 'fps': 10}, Path.cwd())
        self.assertEqual((args['provider'], args['mode']), ('ark', 'video'))

    def test_native_gif_and_openai_quality_are_not_ark_parameters(self):
        with self.assertRaises(ContractError):
            normalize('gif_generate', {'sourcePath': 'a.png', 'outputDir': 'exports', 'motion': 'wave', 'mode': 'native'}, Path.cwd())
        with self.assertRaises(ContractError):
            normalize('image_generate', {'mode': 'create', 'prompt': 'circle', 'outputPath': 'a.png', 'quality': 'high'}, Path.cwd())

    def test_watermark_requires_actual_boolean(self):
        for value in (1, 'false', None):
            with self.subTest(value=value), self.assertRaises(ContractError):
                normalize('image_generate', {'mode': 'create', 'prompt': 'circle', 'outputPath': 'a.png', 'watermark': value}, Path.cwd())

    def test_video_export_requires_video_and_gif(self):
        base = {'action': 'video_to_gif', 'sourcePath': 'input.mp4', 'outputPath': 'final.gif', 'fps': 10}
        self.assertEqual(normalize('media_export', base, Path.cwd())['outputFormat'], 'gif')
        for changes in ({'sourcePath': 'a.png'}, {'outputPath': 'a.png'}, {'fps': 12}, {'durationMs': 10001}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                normalize('media_export', {**base, **changes}, Path.cwd())

    def test_video_parameters_cannot_silently_change_other_actions(self):
        with self.assertRaisesRegex(ContractError, 'video_parameter_requires'):
            normalize('media_export', {'action': 'optimize_gif', 'sourcePath': 'in.gif', 'outputPath': 'out.gif', 'fps': 10}, Path.cwd())


if __name__ == '__main__':
    unittest.main()
