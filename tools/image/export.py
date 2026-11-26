"""Bounded, local image decoding and export. No publication or network I/O.

The caller owns the final destination. ``render_export`` writes only a previously
nonexistent staging file and removes that file if writing or verification fails.
Pillow is the only runtime dependency (release verification uses Pillow 13.0.0).
"""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import hashlib
import math
from pathlib import Path
import re
from typing import Any, Callable
import warnings

from PIL import GifImagePlugin, Image, ImageChops, ImageOps, UnidentifiedImageError


MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 512
MAX_DECODED_PIXELS = 64_000_000
MAX_OUTPUT_EDGE = 4096
_FORMATS = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp", "GIF": "gif"}
_EXTENSIONS = {"png": {".png", ".apng"}, "jpeg": {".jpg", ".jpeg"},
               "webp": {".webp"}, "gif": {".gif"}}
_ACTIONS = {"first_frame", "optimize_gif", "resize", "convert_image", "assemble_frames"}


class MediaExportError(RuntimeError):
    """A stable public code and safe, structured details, never decoder messages."""

    def __init__(self, code: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = dict(details or {})
        super().__init__(code)


@dataclass
class _Media:
    metadata: dict[str, Any]
    images: list[Image.Image]
    default_image: bool = False
    encoded: bytes = b""


@dataclass(frozen=True)
class _FixedOverlay:
    image: Image.Image
    source_sha256: str


@dataclass(frozen=True)
class _OverlayPalette:
    box: tuple[int, int, int, int]
    mask: Image.Image
    indices: Image.Image
    colors: list[int]


def _cancel(check: Callable[[], Any] | None) -> None:
    if check is not None and check():
        raise MediaExportError("cancelled")


def _integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise MediaExportError("invalid_spec", {"field": field})
    return value


def _duration(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MediaExportError("invalid_media")
    if not math.isfinite(value) or value < 0:
        raise MediaExportError("invalid_media")
    return int(value) if float(value).is_integer() else float(value)


def _decode(data: bytes, *, suffix: str | None = None,
            cancel_check: Callable[[], Any] | None = None,
            pixel_budget: int = MAX_DECODED_PIXELS) -> _Media:
    _cancel(cancel_check)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                format_name = _FORMATS.get(source.format or "")
                if format_name is None:
                    raise MediaExportError("unsupported_format")
                if suffix is not None and suffix.lower() not in _EXTENSIONS[format_name]:
                    raise MediaExportError("format_mismatch")
                width, height = source.size
                if width < 1 or height < 1 or width * height > pixel_budget:
                    raise MediaExportError("input_pixel_limit_exceeded")
                count = getattr(source, "n_frames", 1)
                if count > MAX_FRAMES:
                    raise MediaExportError("frame_limit_exceeded", {"maxFrames": MAX_FRAMES})
                if count * width * height > pixel_budget:
                    raise MediaExportError("input_pixel_limit_exceeded")
                loop = source.info.get("loop")
                if loop is not None:
                    loop = _integer(loop, "loop", 0, 65535)
                default_image = bool(source.info.get("default_image", False))
                images, durations = [], []
                has_transparency = False
                for index in range(count):
                    _cancel(cancel_check)
                    source.seek(index)
                    source.load()
                    if source.size != (width, height):
                        raise MediaExportError("invalid_media")
                    frame = source.convert("RGBA")
                    has_transparency |= frame.getextrema()[3][0] < 255
                    images.append(frame)
                    durations.append(_duration(source.info.get("duration", 0)))
                metadata = {
                    "format": format_name, "width": width, "height": height,
                    "frames": count, "durationsMs": durations, "durationMs": sum(durations),
                    "loop": loop, "hasTransparency": has_transparency,
                    "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                }
                return _Media(metadata, images, default_image, data)
    except MediaExportError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise MediaExportError("input_pixel_limit_exceeded") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError, OverflowError,
            IndexError, TypeError, RuntimeError):
        raise MediaExportError("invalid_media") from None


def _read(path: str | Path, *, cancel_check: Callable[[], Any] | None = None,
          pixel_budget: int = MAX_DECODED_PIXELS) -> _Media:
    _cancel(cancel_check)
    try:
        path = Path(path)
        if not path.is_file():
            raise MediaExportError("source_not_found")
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise MediaExportError("input_size_limit_exceeded", {"maxBytes": MAX_INPUT_BYTES})
        with path.open("rb") as stream:
            data = stream.read(MAX_INPUT_BYTES + 1)
        if len(data) > MAX_INPUT_BYTES:
            raise MediaExportError("input_size_limit_exceeded", {"maxBytes": MAX_INPUT_BYTES})
    except MediaExportError:
        raise
    except (OSError, TypeError, ValueError):
        raise MediaExportError("source_unreadable") from None
    return _decode(data, suffix=path.suffix, cancel_check=cancel_check, pixel_budget=pixel_budget)


def inspect_media(path: str | Path) -> dict[str, Any]:
    """Decode every frame, verify its extension, and return safe metadata."""
    return _read(path).metadata


def load_fixed_overlay(path: str | Path, size: tuple[int, int] | None = None, *,
                       cancel_check: Callable[[], Any] | None = None) -> _FixedOverlay:
    media = _read(path, cancel_check=cancel_check, pixel_budget=MAX_OUTPUT_EDGE**2)
    overlay = media.images[0]
    if (Path(path).suffix.lower() != ".png" or media.metadata["format"] != "png"
            or media.metadata["frames"] != 1 or overlay.getchannel("A").getextrema() != (0, 255)):
        raise MediaExportError("invalid_fixed_overlay")
    if size is not None and overlay.size != size:
        if overlay.width * size[1] != overlay.height * size[0]:
            raise MediaExportError("fixed_overlay_aspect_mismatch")
        overlay = overlay.resize(size, Image.Resampling.LANCZOS)
        if overlay.getchannel("A").getextrema() != (0, 255):
            raise MediaExportError("fixed_overlay_not_visible_at_output_size")
    return _FixedOverlay(overlay, media.metadata["sha256"])


def _background(spec: dict[str, Any]) -> tuple[int, int, int, int] | None:
    color = spec.get("background")
    if color is None:
        return None
    if not isinstance(color, str) or re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None:
        raise MediaExportError("invalid_spec", {"field": "background"})
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def _size(spec: dict[str, Any], original: tuple[int, int]) -> tuple[int, int]:
    width, height = spec.get("width"), spec.get("height")
    if width is not None:
        width = _integer(width, "width", 1, MAX_OUTPUT_EDGE)
    if height is not None:
        height = _integer(height, "height", 1, MAX_OUTPUT_EDGE)
    if width is None and height is None:
        width, height = original
    elif width is None:
        width = max(1, round(original[0] * height / original[1]))
    elif height is None:
        height = max(1, round(original[1] * width / original[0]))
    if width > MAX_OUTPUT_EDGE or height > MAX_OUTPUT_EDGE:
        raise MediaExportError("output_dimension_limit_exceeded", {"maxEdge": MAX_OUTPUT_EDGE})
    return width, height


def _resize(image: Image.Image, size: tuple[int, int], fit: str,
            background: tuple[int, int, int, int] | None) -> Image.Image:
    if fit == "cover":
        fitted = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS)
    else:
        fitted = ImageOps.contain(image, size, method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, background or (0, 0, 0, 0))
    canvas.alpha_composite(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return canvas


def _needs_padding(original: tuple[int, int], target: tuple[int, int]) -> bool:
    return original[0] * target[1] != original[1] * target[0]


def _cleanup(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # Preserve the original safe error; never surface filesystem exceptions
        # containing private staging paths to an external caller.
        pass


def _overlay_palette(overlay: _FixedOverlay, available: int) -> _OverlayPalette:
    if available < 2:
        raise MediaExportError("fixed_overlay_palette_too_small")
    alpha = overlay.image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value == 255 else 0)
    box = mask.getbbox()
    mask = mask.crop(box)
    patch = overlay.image.crop(box)
    reserved = max(1, min(32, available // 4))
    patch.putalpha(mask)
    indices = patch.quantize(colors=reserved, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    used = [index for index, count in enumerate(indices.histogram(mask=mask)) if count > 0]
    source_palette = indices.getpalette()
    palette = [value for index in used for value in source_palette[index * 3:index * 3 + 3]]
    remap = [0] * 256
    for target, index in enumerate(used, start=available - len(used)):
        remap[index] = target
    return _OverlayPalette(box, mask, indices.point(remap), palette)


def _palette(image: Image.Image, colors: int, transparent: bool,
             fixed: _OverlayPalette | None) -> Image.Image:
    # Reserve one fixed index in every frame, including opaque frames, so disposal
    # to the logical-screen background correctly clears previously visible pixels.
    count = colors - int(transparent) - (len(fixed.colors) // 3 if fixed else 0)
    result = image.convert("RGB").quantize(colors=count, method=Image.Quantize.MEDIANCUT,
                                          dither=Image.Dither.NONE)
    palette = (result.getpalette() or [])[:count * 3]
    palette += [0] * (count * 3 - len(palette))
    if fixed:
        palette += fixed.colors
        result.paste(fixed.indices, fixed.box[:2], fixed.mask)
    palette += [0] * (colors * 3 - len(palette))
    result.putpalette(palette)
    if transparent:
        transparent_index = colors - 1
        result.paste(transparent_index, mask=image.getchannel("A").point(lambda value: 255 if value < 128 else 0))
        result.info["transparency"] = transparent_index
    return result


def _encode_gif(images: list[Image.Image], durations: list[int | float], loop: int | None,
                colors: int, cancel_check: Callable[[], Any] | None,
                overlay: _FixedOverlay | None) -> bytes:
    for duration in durations:
        if duration > 655350 or duration % 10 != 0:
            raise MediaExportError("gif_duration_not_representable", {"unitMs": 10, "maxDurationMs": 655350})
    transparent = any(frame.getextrema()[3][0] < 255 for frame in images)
    fixed = _overlay_palette(overlay, colors - int(transparent)) if overlay else None
    output = BytesIO()
    for index, frame in enumerate(images):
        _cancel(cancel_check)
        paletted = _palette(frame, colors, transparent, fixed)
        paletted.info["version"] = b"89a"
        info: dict[str, Any] = {"optimize": False, "duration": durations[index], "disposal": 2}
        if transparent:
            info.update(transparency=colors - 1, background=colors - 1)
        if index == 0:
            if loop is not None:
                info["loop"] = loop
            for block in GifImagePlugin.getheader(paletted, info=info)[0]:
                output.write(block)
        # Pillow's save_all merges identical frames even with optimize=False.
        # Its public GIF block writers preserve every frame and its own palette.
        info["include_color_table"] = index > 0
        for block in GifImagePlugin.getdata(paletted, **info):
            output.write(block)
    output.write(b";")
    return output.getvalue()


def _encode(images: list[Image.Image], format_name: str, durations: list[int | float],
            loop: int | None, quality: int, colors: int, default_image: bool,
            cancel_check: Callable[[], Any] | None, overlay: _FixedOverlay | None) -> bytes:
    _cancel(cancel_check)
    if format_name == "gif":
        return _encode_gif(images, durations, loop, colors, cancel_check, overlay)
    output = BytesIO()
    options: dict[str, Any] = {}
    if format_name == "jpeg":
        options.update(quality=quality, optimize=True, subsampling=0)
        first = images[0].convert("RGB")
    else:
        first = images[0]
    if format_name == "png":
        options.update(optimize=True, compress_level=9)
    elif format_name == "webp":
        options.update(quality=quality, method=6)
    if len(images) > 1:
        if format_name == "jpeg":
            raise MediaExportError("animation_requires_animated_output")
        options.update(save_all=True, append_images=images[1:], duration=durations,
                       loop=loop if loop is not None else 1)
        if format_name == "png":
            options.update(disposal=0, blend=0)
            if default_image:
                options.update(default_image=True, duration=durations[1:])
    first.save(output, format={"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[format_name], **options)
    return output.getvalue()


def _validate_result(result: _Media, *, size: tuple[int, int], frame_count: int,
                     format_name: str, durations: list[int | float], loop: int | None) -> None:
    metadata = result.metadata
    if metadata["format"] != format_name or (metadata["width"], metadata["height"]) != size:
        raise MediaExportError("output_verification_failed")
    if metadata["frames"] != frame_count:
        raise MediaExportError("animation_not_preserved")
    if format_name == "gif" or frame_count > 1:
        if any(abs(actual - expected) > 0.01 for actual, expected in zip(metadata["durationsMs"], durations)):
            raise MediaExportError("animation_not_preserved")
        expected_loop = loop if format_name == "gif" or loop is not None else 1
        if metadata["loop"] != expected_loop:
            raise MediaExportError("animation_not_preserved")


def _verify_fixed_overlay(result: _Media, overlay: _FixedOverlay,
                          cancel_check: Callable[[], Any] | None) -> dict[str, Any]:
    mask = overlay.image.getchannel("A").point(lambda value: 255 if value == 255 else 0)
    box = mask.getbbox()
    mask = mask.crop(box)
    outside = ImageChops.invert(mask)
    baseline = result.images[0].crop(box)
    baseline.paste((0, 0, 0, 0), mask=outside)
    for frame in result.images:
        _cancel(cancel_check)
        selected = frame.crop(box)
        selected.paste((0, 0, 0, 0), mask=outside)
        if selected.tobytes() != baseline.tobytes():
            raise MediaExportError("fixed_overlay_not_preserved")
    return {"status": "passed", "scope": "identical_decoded_pixels_under_opaque_overlay",
            "sourceSha256": overlay.source_sha256, "bounds": list(box),
            "opaquePixels": mask.histogram()[255], "checkedFrames": len(result.images),
            "decodedPixelSha256": hashlib.sha256(baseline.tobytes()).hexdigest()}


def render_export(spec: dict[str, Any], destination: Path, *,
                  cancel_check: Callable[[], Any] | None = None,
                  _overlay: _FixedOverlay | None = None) -> dict[str, Any]:
    """Render into a new staging path and verify every output frame.

    Staging suffixes are unrestricted: the caller validates the final output
    extension. A truthy ``cancel_check()`` stops work with code ``cancelled``.
    Source and published destination ownership remain entirely with the caller.
    GIF size fitting never drops frames or resizes, and automatically reduces
    palettes only to 64 colors. An explicitly smaller ``colors`` value is kept
    as the floor. Unchanged GIF optimization keeps original bytes if smaller.
    """
    if isinstance(spec, dict) and spec.get("action") == "video_to_gif":
        from tools.image.video_gif import render_video_gif
        return render_video_gif(spec, destination, cancel_check=cancel_check)
    created = False
    try:
        destination = Path(destination)
        if destination.exists() or destination.is_symlink():
            raise MediaExportError("destination_exists")
        _cancel(cancel_check)
        if not isinstance(spec, dict) or spec.get("action") not in _ACTIONS:
            raise MediaExportError("invalid_spec", {"field": "action"})
        action = spec["action"]
        background = _background(spec)
        fit = spec.get("fit", "contain")
        if fit not in {"contain", "cover"}:
            raise MediaExportError("invalid_spec", {"field": "fit"})
        quality = _integer(spec.get("quality", 90), "quality", 1, 100)
        colors = _integer(spec.get("colors", 256), "colors", 2, 256)
        max_bytes = spec.get("maxBytes")
        if max_bytes is not None:
            max_bytes = _integer(max_bytes, "maxBytes", 1, 2**53 - 1)
        default_image = False
        source_fallback = None
        if action == "assemble_frames":
            entries = spec.get("frames")
            if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_FRAMES:
                raise MediaExportError("invalid_spec", {"field": "frames"})
            images, durations = [], []
            remaining_pixels = MAX_DECODED_PIXELS
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                    raise MediaExportError("invalid_spec", {"field": "frames"})
                frame_media = _read(entry["path"], cancel_check=cancel_check, pixel_budget=remaining_pixels)
                if frame_media.metadata["frames"] != 1:
                    raise MediaExportError("animated_source_not_allowed")
                remaining_pixels -= frame_media.metadata["width"] * frame_media.metadata["height"]
                images.extend(frame_media.images)
                durations.append(_integer(entry.get("durationMs"), "durationMs", 1, 655350))
            source_format, loop = "gif", spec.get("loop", 0)
        else:
            if not isinstance(spec.get("sourcePath"), str):
                raise MediaExportError("invalid_spec", {"field": "sourcePath"})
            media = _read(spec["sourcePath"], cancel_check=cancel_check)
            images, durations = media.images, media.metadata["durationsMs"]
            source_format, loop = media.metadata["format"], media.metadata["loop"]
            default_image = media.default_image
            if action == "convert_image" and len(images) > 1:
                raise MediaExportError("animated_source_not_allowed")
            if action == "optimize_gif" and source_format != "gif":
                raise MediaExportError("gif_source_required")
            if (action == "optimize_gif"
                    and not any(field in spec for field in ("width", "height", "background", "loop", "colors"))
                    and (max_bytes is None or media.metadata["bytes"] <= max_bytes)):
                # Re-encoding an already compact GIF can grow its delta frames.
                # Preserve the verified original bytes when no change was requested.
                source_fallback = media
            if action == "first_frame":
                images, durations, loop, default_image = images[:1], [0], None, False
        if "loop" in spec:
            loop = _integer(spec["loop"], "loop", 0, 65535)
        elif loop is not None:
            loop = _integer(loop, "loop", 0, 65535)
        format_name = spec.get("outputFormat", "png" if action == "first_frame" else source_format)
        if format_name not in _EXTENSIONS:
            raise MediaExportError("invalid_spec", {"field": "outputFormat"})
        if action == "optimize_gif" and format_name != "gif":
            raise MediaExportError("invalid_spec", {"field": "outputFormat"})
        if len(images) > 1 and format_name == "jpeg":
            raise MediaExportError("animation_requires_animated_output")
        size = _size(spec, images[0].size)
        if size[0] * size[1] * len(images) > MAX_DECODED_PIXELS:
            raise MediaExportError("output_pixel_limit_exceeded")
        if action == "optimize_gif" and any(image.size != size for image in images):
            raise MediaExportError("invalid_spec", {"field": "width"})
        source_has_transparency = any(image.getextrema()[3][0] < 255 for image in images)
        needs_padding = fit == "contain" and any(_needs_padding(image.size, size) for image in images)
        if format_name == "jpeg" and background is None and (source_has_transparency or needs_padding):
            raise MediaExportError("background_required")
        transformed = []
        for frame in images:
            _cancel(cancel_check)
            # Preserve the exact decoded first-frame RGBA values when no transform
            # was requested, including RGB values under fully transparent pixels.
            fitted = frame if frame.size == size and background is None else _resize(frame, size, fit, background)
            transformed.append(Image.alpha_composite(fitted, _overlay.image) if _overlay else fitted)
        palette_attempts = [colors]
        quality_attempts = [quality]
        if max_bytes is not None:
            if format_name == "gif":
                # Automatic compression has a 64-color quality floor. Explicitly
                # requesting fewer colors permits that value, never a lower one.
                palette_attempts += [value for value in (128, 64) if value < colors]
            elif format_name in {"jpeg", "webp"}:
                quality_attempts += [value for value in (85, 70, 50, 30, 15, 1) if value < quality]
        smallest_bytes = None
        output_data = None
        verified = None
        for palette_count in palette_attempts:
            for attempt_quality in quality_attempts:
                _cancel(cancel_check)
                data = _encode(transformed, format_name, durations, loop, attempt_quality,
                               palette_count, default_image, cancel_check, _overlay)
                if source_fallback is not None and len(source_fallback.encoded) < len(data):
                    data = source_fallback.encoded
                smallest_bytes = min(smallest_bytes or len(data), len(data))
                if max_bytes is not None and len(data) > max_bytes:
                    continue
                verified = _decode(data, cancel_check=cancel_check)
                _validate_result(verified, size=size, frame_count=len(transformed), format_name=format_name,
                                 durations=durations, loop=loop)
                if _overlay:
                    verified.metadata["fixedOverlay"] = _verify_fixed_overlay(verified, _overlay, cancel_check)
                output_data = data
                break
            if output_data is not None:
                break
        if output_data is None or verified is None:
            raise MediaExportError("size_limit_exceeded", {"maxBytes": max_bytes, "smallestBytes": smallest_bytes})
        _cancel(cancel_check)
        # Exclusive creation prevents races from replacing a preexisting artifact.
        with destination.open("xb") as stream:
            created = True
            stream.write(output_data)
            stream.flush()
        _cancel(cancel_check)
        if destination.stat().st_size != len(output_data):
            raise MediaExportError("output_verification_failed")
        digest_state = hashlib.sha256()
        with destination.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                _cancel(cancel_check)
                digest_state.update(block)
        digest = digest_state.hexdigest()
        if digest != verified.metadata["sha256"]:
            raise MediaExportError("output_verification_failed")
        _cancel(cancel_check)
        return verified.metadata
    except MediaExportError:
        if created:
            _cleanup(destination)
        raise
    except FileExistsError:
        raise MediaExportError("destination_exists") from None
    except (OSError, ValueError, TypeError, KeyError, OverflowError, RuntimeError):
        if created:
            _cleanup(destination)
        raise MediaExportError("export_failed") from None


__all__ = ["MediaExportError", "inspect_media", "render_export"]
