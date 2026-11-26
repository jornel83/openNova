from base64 import b64decode
from hashlib import sha256
from io import BytesIO
import unittest

from PIL import Image
from tools.image.review import contact_sheet


def animation(frame_count=17):
    images = [Image.new('RGB', (16, 12), (i * 11 % 255, 15, 30)) for i in range(frame_count)]
    stream = BytesIO()
    images[0].save(stream, 'GIF', save_all=True, append_images=images[1:], duration=100, loop=0)
    return stream.getvalue()


class TestGifContactSheet(unittest.TestCase):
    def test_returns_inclusive_sample_indices_timing_and_decoded_png(self):
        gif = animation()
        result = contact_sheet(gif)
        self.assertEqual(result['sha256'], sha256(gif).hexdigest())
        self.assertEqual(result['frames'], 17)
        self.assertEqual(result['indices'], list(range(0, 17, 2)))
        self.assertEqual(result['timestampsMs'], [i * 100 for i in result['indices']])
        with Image.open(BytesIO(b64decode(result['png']))) as sheet:
            self.assertEqual(sheet.format, 'PNG')
            self.assertEqual(sheet.size, (960, 792))
            for offset, index in enumerate(result['indices']):
                self.assertEqual(sheet.getpixel((offset % 3 * 320 + 160, offset // 3 * 264 + 120)), (index * 11 % 255, 15, 30))

    def test_single_frame_gif_is_not_an_animation_review(self):
        with self.assertRaisesRegex(ValueError, 'gif_review_animation_required'):
            contact_sheet(animation(1))
