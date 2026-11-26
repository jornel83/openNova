"""Real decoder/encoder regressions for the local image export boundary."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import GifImagePlugin, Image

MODULE_PATH = Path(__file__).resolve().parents[1] / "export.py"
MODULE_SPEC = importlib.util.spec_from_file_location("nova_image_export", MODULE_PATH)
export = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = export
MODULE_SPEC.loader.exec_module(export)


class MediaExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nova-image-export-test-")
        self.base = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def still(self, name="source.png", mode="RGB", color=(12, 70, 200), size=(20, 10)):
        path = self.base / name
        Image.new(mode, size, color).save(path)
        return path

    def animation(self, *, transparent=False, loop=4, repeated=False):
        path = self.base / "source.gif"
        palette = [0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 0] + [0] * (256 * 3 - 12)
        frames = []
        for index in range(3):
            frame = Image.new("P", (20, 10), 0 if transparent else index + 1)
            frame.putpalette(palette)
            if transparent:
                frame.paste(index + 1, (index * 5, 2, index * 5 + 5, 7))
            if repeated and index == 1:
                frame = frames[0].copy()
            frames.append(frame)
        info = {"loop": loop, "background": 0, "optimize": False}
        if transparent:
            info["transparency"] = 0
        # Create duplicate input frames without Pillow save_all coalescing them.
        with path.open("wb") as stream:
            for block in GifImagePlugin.getheader(frames[0], info=info)[0]:
                stream.write(block)
            for index, frame in enumerate(frames):
                options = dict(info, duration=[40, 120, 230][index], disposal=2,
                               include_color_table=index > 0)
                for block in GifImagePlugin.getdata(frame, **options):
                    stream.write(block)
            stream.write(b";")
        return path

    def render(self, source, action, name="output.png", **options):
        destination = self.base / name
        metadata = export.render_export({"sourcePath": str(source), "action": action, **options}, destination)
        return destination, metadata

    def error(self, code, source, action, **options):
        destination = self.base / "failed.tmp"
        with self.assertRaises(export.MediaExportError) as caught:
            export.render_export({"sourcePath": str(source), "action": action, **options}, destination)
        self.assertEqual(caught.exception.code, code)
        self.assertFalse(destination.exists())
        self.assertNotIn(str(self.base), str(caught.exception))
        return caught.exception

    def test_first_frame_is_exact_decoded_rgb_and_receipt_matches_file(self):
        source = self.animation()
        original = source.read_bytes()
        output, receipt = self.render(source, "first_frame")
        with Image.open(source) as before, Image.open(output) as after:
            self.assertEqual(before.convert("RGBA").tobytes(), after.convert("RGBA").tobytes())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(receipt["format"], "png")
        self.assertEqual(receipt["frames"], 1)
        self.assertEqual(receipt["sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
        self.assertEqual(receipt["bytes"], output.stat().st_size)

    def test_transparent_first_frame_retains_hidden_rgb_values(self):
        source = self.animation(transparent=True)
        output, receipt = self.render(source, "first_frame")
        with Image.open(source) as before, Image.open(output) as after:
            self.assertEqual(before.convert("RGBA").tobytes(), after.convert("RGBA").tobytes())
        self.assertTrue(receipt["hasTransparency"])

    def test_transparent_jpeg_requires_explicit_background(self):
        source = self.still(mode="RGBA", color=(255, 0, 0, 128))
        self.error("background_required", source, "convert_image", outputFormat="jpeg")
        output, receipt = self.render(source, "convert_image", "white.jpg", outputFormat="jpeg",
                                      background="#FFFFFF", quality=100)
        with Image.open(output) as result:
            pixel = result.getpixel((5, 5))
        self.assertLessEqual(max(abs(a - b) for a, b in zip(pixel, (255, 127, 127))), 2)
        self.assertFalse(receipt["hasTransparency"])

    def test_static_conversion_rejects_every_animated_input_format(self):
        self.error("animated_source_not_allowed", self.animation(), "convert_image", outputFormat="png")
        for extension, format_name in (("png", "PNG"), ("webp", "WEBP")):
            source = self.base / f"animated.{extension}"
            Image.new("RGBA", (10, 10), "red").save(
                source, format=format_name, save_all=True,
                append_images=[Image.new("RGBA", (10, 10), "blue")], duration=[70, 130], loop=2)
            self.error("animated_source_not_allowed", source, "convert_image", outputFormat="jpeg", background="#FFFFFF")

    def test_gif_optimization_retains_every_frame_nonuniform_delays_and_loop(self):
        source = self.animation(repeated=True)
        output, receipt = self.render(source, "optimize_gif", "optimized.gif", colors=128)
        self.assertEqual(receipt["frames"], 3)
        self.assertEqual(receipt["durationsMs"], [40, 120, 230])
        self.assertEqual(receipt["durationMs"], 390)
        self.assertEqual(receipt["loop"], 4)
        with Image.open(source) as before, Image.open(output) as after:
            for index in range(3):
                before.seek(index)
                after.seek(index)
                self.assertEqual(before.convert("RGBA").tobytes(), after.convert("RGBA").tobytes())

    def test_gif_transparency_disposal_and_local_palettes_decode_correctly(self):
        source = self.animation(transparent=True)
        output, receipt = self.render(source, "optimize_gif", "optimized.gif", colors=16)
        self.assertTrue(receipt["hasTransparency"])
        with Image.open(source) as before, Image.open(output) as after:
            for index in range(3):
                before.seek(index)
                after.seek(index)
                self.assertEqual(before.convert("RGBA").tobytes(), after.convert("RGBA").tobytes())

    def test_contain_uses_exact_canvas_and_preserves_aspect_ratio(self):
        source = self.still(size=(20, 10), color="red")
        output, receipt = self.render(source, "resize", width=40, height=40)
        self.assertEqual((receipt["width"], receipt["height"]), (40, 40))
        with Image.open(output) as result:
            self.assertEqual(result.getchannel("A").getbbox(), (0, 10, 40, 30))
        self.assertTrue(receipt["hasTransparency"])

    def test_cover_is_explicit_and_crops_center_without_stretching(self):
        source = self.still(size=(30, 10), color="red")
        with Image.open(source) as original:
            original.paste("blue", (10, 0, 20, 10))
            original.save(source)
        output, receipt = self.render(source, "resize", width=10, height=10, fit="cover")
        with Image.open(output) as result:
            self.assertEqual(result.convert("RGB").getcolors(), [(100, (0, 0, 255))])
        self.assertFalse(receipt["hasTransparency"])

    def test_single_dimension_infers_other_dimension(self):
        source = self.still(size=(20, 10))
        _, receipt = self.render(source, "resize", width=40)
        self.assertEqual((receipt["width"], receipt["height"]), (40, 20))

    def test_jpeg_padding_requires_explicit_background(self):
        source = self.still()
        self.error("background_required", source, "resize", width=40, height=40, outputFormat="jpeg")
        output, receipt = self.render(source, "resize", "padded.jpg", width=40, height=40,
                                      outputFormat="jpeg", background="#FFFFFF", quality=100)
        with Image.open(output) as result:
            self.assertEqual(result.getpixel((1, 1)), (255, 255, 255))
        self.assertEqual((receipt["width"], receipt["height"]), (40, 40))

    def test_animated_resize_preserves_timing_loop_and_transparent_padding(self):
        _, receipt = self.render(self.animation(), "resize", "resized.gif", width=40, height=40)
        self.assertEqual(receipt["durationsMs"], [40, 120, 230])
        self.assertEqual(receipt["loop"], 4)
        self.assertEqual(receipt["frames"], 3)
        self.assertTrue(receipt["hasTransparency"])

    def test_corrupt_and_truncated_input_are_sanitized(self):
        source = self.base / "broken.gif"
        source.write_bytes(b"not an image: private payload")
        self.error("invalid_media", source, "first_frame")
        source = self.animation()
        source.write_bytes(source.read_bytes()[:50])
        self.error("invalid_media", source, "first_frame")

    def test_extension_mismatch_is_rejected(self):
        source = self.still()
        disguised = self.base / "disguised.gif"
        disguised.write_bytes(source.read_bytes())
        self.error("format_mismatch", disguised, "first_frame")

    def test_unachievable_max_bytes_never_creates_output_or_changes_source(self):
        source = self.animation()
        original = source.read_bytes()
        error = self.error("size_limit_exceeded", source, "optimize_gif", maxBytes=1)
        self.assertGreater(error.details["smallestBytes"], 1)
        self.assertEqual(source.read_bytes(), original)

    def test_max_bytes_reduces_palette_without_resizing_or_dropping_frames(self):
        source = self.base / "colors.gif"
        frame = Image.new("RGB", (64, 64))
        frame.putdata([(x * 4, y * 4, (x + y) * 2) for y in range(64) for x in range(64)])
        frame.save(source)
        _, full = self.render(source, "optimize_gif", "full.gif")
        _, low = self.render(source, "optimize_gif", "low.gif", colors=64)
        _, fitted = self.render(source, "optimize_gif", "fitted.gif", maxBytes=low["bytes"])
        self.assertLess(fitted["bytes"], full["bytes"])
        self.assertLessEqual(fitted["bytes"], low["bytes"])
        self.assertEqual((fitted["width"], fitted["height"], fitted["frames"]), (64, 64, 1))

    def test_default_optimization_never_expands_an_already_compact_gif(self):
        source = self.base / "compact.gif"
        Image.new("RGB", (40, 40), "red").save(source, optimize=True, save_all=True,
                                               append_images=[Image.new("RGB", (40, 40), "blue")],
                                               duration=[60, 170], loop=3)
        original = source.read_bytes()
        output, receipt = self.render(source, "optimize_gif", "compact-output.gif", maxBytes=len(original))
        self.assertLessEqual(receipt["bytes"], len(original))
        self.assertEqual(output.read_bytes(), original)
        self.assertEqual(receipt["durationsMs"], [60, 170])
        self.assertEqual(receipt["loop"], 3)

    def test_automatic_gif_compression_respects_64_color_floor(self):
        source = self.base / "gradient.gif"
        gradient = Image.new("RGB", (64, 64))
        gradient.putdata([(x * 4, y * 4, (x + y) * 2) for y in range(64) for x in range(64)])
        gradient.save(source)
        _, low = self.render(source, "optimize_gif", "explicit16.gif", colors=16)
        with patch.object(export, "_encode_gif", wraps=export._encode_gif) as encoder:
            self.error("size_limit_exceeded", source, "optimize_gif", maxBytes=low["bytes"])
        self.assertEqual([call.args[3] for call in encoder.call_args_list], [256, 128, 64])
        _, allowed = self.render(source, "optimize_gif", "allowed16.gif", colors=16, maxBytes=low["bytes"])
        self.assertLessEqual(allowed["bytes"], low["bytes"])
        with patch.object(export, "_encode_gif", wraps=export._encode_gif) as encoder:
            self.error("size_limit_exceeded", source, "optimize_gif", colors=16, maxBytes=1)
        self.assertEqual([call.args[3] for call in encoder.call_args_list], [16])

    def test_assemble_frames_preserves_repeats_durations_and_loop(self):
        red, blue = self.still("red.png", color="red"), self.still("blue.png", color="blue")
        output = self.base / "assembled.gif"
        receipt = export.render_export({"action": "assemble_frames", "loop": 7, "frames": [
            {"path": str(red), "durationMs": 30}, {"path": str(red), "durationMs": 110},
            {"path": str(blue), "durationMs": 240}]}, output)
        self.assertEqual(receipt["frames"], 3)
        self.assertEqual(receipt["durationsMs"], [30, 110, 240])
        self.assertEqual(receipt["loop"], 7)

    def test_gif_subcentisecond_durations_fail_explicitly(self):
        source = self.still()
        output = self.base / "impossible.gif"
        with self.assertRaises(export.MediaExportError) as caught:
            export.render_export({"action": "assemble_frames", "frames": [
                {"path": str(source), "durationMs": 33}]}, output)
        self.assertEqual(caught.exception.code, "gif_duration_not_representable")
        self.assertFalse(output.exists())

    def test_cancel_before_or_after_write_leaves_no_output(self):
        source = self.still()
        destination = self.base / "cancelled.png"
        for callback in (lambda: True, lambda: destination.exists()):
            with self.assertRaises(export.MediaExportError) as caught:
                export.render_export({"action": "first_frame", "sourcePath": str(source)},
                                     destination, cancel_check=callback)
            self.assertEqual(caught.exception.code, "cancelled")
            self.assertFalse(destination.exists())

    def test_existing_destination_is_never_overwritten(self):
        source = self.still()
        destination = self.base / "existing.png"
        destination.write_bytes(b"private existing bytes")
        with self.assertRaises(export.MediaExportError) as caught:
            export.render_export({"action": "first_frame", "sourcePath": str(source)}, destination)
        self.assertEqual(caught.exception.code, "destination_exists")
        self.assertEqual(destination.read_bytes(), b"private existing bytes")

    def test_input_size_frame_and_decoded_pixel_limits(self):
        source = self.animation()
        for constant, limit, code in (("MAX_INPUT_BYTES", 10, "input_size_limit_exceeded"),
                                      ("MAX_FRAMES", 2, "frame_limit_exceeded")):
            with patch.object(export, constant, limit):
                self.error(code, source, "first_frame")
        with self.assertRaises(export.MediaExportError) as caught:
            export._read(source, pixel_budget=500)
        self.assertEqual(caught.exception.code, "input_pixel_limit_exceeded")


if __name__ == "__main__":
    unittest.main()
