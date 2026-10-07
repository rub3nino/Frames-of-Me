"""Image decoding for the face service.

Pillow decodes the upload (EXIF orientation applied), the pixel count is capped,
the long edge is bounded (DET_LONG_EDGE, default 2560 px), and the result is handed
to insightface as a BGR array. The image bytes are never logged or stored.
"""

from __future__ import annotations

import io
import os
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

# Pillow's own decompression-bomb guard would raise at ~179 MP; the service applies
# its own cap (MAX_PIXELS) before any pixel is decoded, so the guard is disabled.
Image.MAX_IMAGE_PIXELS = None



def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


MAX_PIXELS = 120_000_000
DEFAULT_LONG_EDGE = 2560
# Long edge of the image the detector sees. Detection recall on small faces (a 60-80 px
# face in a 24 MP hall photo) is what motivates 2560 over the previous 1600: see
# docs/test-readiness.md §3. Overridable per call (`max_long_edge`) and via DET_LONG_EDGE.
MAX_LONG_EDGE = _env_int("DET_LONG_EDGE", DEFAULT_LONG_EDGE)
ACCEPTED_FORMATS = frozenset({"JPEG", "PNG"})

# EXIF orientations that swap width and height.
_TRANSPOSED_ORIENTATIONS = frozenset({5, 6, 7, 8})


class ImageUndecodable(ValueError):
    """The bytes are not a JPEG/PNG Pillow can decode (HTTP 400)."""


class ImageTooLarge(ValueError):
    """The decoded image would exceed MAX_PIXELS (HTTP 413)."""


@dataclass(frozen=True)
class DecodedImage:
    """`bgr` is what the detector sees (long edge <= MAX_LONG_EDGE); `width`/`height`
    are the dimensions of the original, EXIF-oriented photo."""

    bgr: np.ndarray
    width: int
    height: int

    @property
    def scaled_width(self) -> int:
        return int(self.bgr.shape[1])

    @property
    def scaled_height(self) -> int:
        return int(self.bgr.shape[0])


def _orientation(img: Image.Image) -> int:
    try:
        return int(img.getexif().get(0x0112, 1) or 1)
    except Exception:  # corrupt EXIF must not fail the request
        return 1


def decode_image(data: bytes, *, max_pixels: int | None = None, max_long_edge: int | None = None) -> DecodedImage:
    max_pixels = MAX_PIXELS if max_pixels is None else max_pixels
    max_long_edge = MAX_LONG_EDGE if max_long_edge is None else max_long_edge
    try:
        img = Image.open(io.BytesIO(data))
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageUndecodable("not a decodable image") from exc
    if img.format not in ACCEPTED_FORMATS:
        raise ImageUndecodable(f"unsupported format {img.format!r}")

    raw_w, raw_h = img.size
    if raw_w <= 0 or raw_h <= 0:
        raise ImageUndecodable("empty image")
    if raw_w * raw_h > max_pixels:
        raise ImageTooLarge(f"{raw_w}x{raw_h} exceeds {max_pixels} pixels")

    if _orientation(img) in _TRANSPOSED_ORIENTATIONS:
        width, height = raw_h, raw_w
    else:
        width, height = raw_w, raw_h

    long_edge = max(raw_w, raw_h)
    scale = min(1.0, max_long_edge / long_edge)
    target = (max(1, round(raw_w * scale)), max(1, round(raw_h * scale)))
    if scale < 1.0 and img.format == "JPEG":
        # DCT-domain downscale: Pillow picks the largest reduction (1/2, 1/4, 1/8) whose
        # result is still >= `target`, so the decoded image is never smaller than the
        # detector image; the resize below only shrinks it to the exact edge. With a
        # 2560 px edge a 20 MP (5568 px) JPEG decodes at 1/2 (2784 px); a 7000 px one at
        # 1/2 too (1/4 would give 1750 < 2560). With 1600 the same files decode at 1/2 and 1/4.
        img.draft("RGB", target)

    try:
        img.load()
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
    except (OSError, ValueError, SyntaxError) as exc:
        raise ImageUndecodable("truncated or corrupt image") from exc

    if max(img.size) > max_long_edge:
        s = max_long_edge / max(img.size)
        img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.Resampling.BILINEAR, reducing_gap=2.0)

    rgb = np.asarray(img, dtype=np.uint8)
    bgr = np.ascontiguousarray(rgb[:, :, ::-1])
    return DecodedImage(bgr=bgr, width=int(width), height=int(height))
