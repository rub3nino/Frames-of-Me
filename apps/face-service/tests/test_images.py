import pytest

from app import images
from app.images import ImageTooLarge, ImageUndecodable, decode_image
from tests.conftest import make_image


def test_decodes_jpeg_to_bgr():
    d = decode_image(make_image(64, 48, "JPEG", color=(255, 0, 0)))
    assert (d.width, d.height) == (64, 48)
    assert d.bgr.shape == (48, 64, 3)
    assert d.bgr.dtype.name == "uint8"
    # pure red in RGB becomes high value in channel 2 of BGR
    assert d.bgr[0, 0, 2] > 200 and d.bgr[0, 0, 0] < 40


def test_decodes_png():
    d = decode_image(make_image(30, 20, "PNG"))
    assert (d.width, d.height, d.bgr.shape) == (30, 20, (20, 30, 3))


def test_exif_orientation_is_applied():
    d = decode_image(make_image(100, 40, "JPEG", orientation=6))  # rotate 90 CW
    assert (d.width, d.height) == (40, 100)
    assert d.bgr.shape[:2] == (100, 40)


def test_long_edge_is_capped_to_1600():
    d = decode_image(make_image(3200, 1600, "JPEG"))
    assert (d.width, d.height) == (3200, 1600)  # original dimensions are reported
    assert d.bgr.shape[1] == 1600 and d.bgr.shape[0] == 800  # detector image is scaled


def test_small_image_is_not_upscaled():
    d = decode_image(make_image(200, 100, "PNG"))
    assert d.bgr.shape[:2] == (100, 200)


def test_pixel_cap(monkeypatch):
    monkeypatch.setattr(images, "MAX_PIXELS", 1000)
    with pytest.raises(ImageTooLarge):
        decode_image(make_image(40, 40, "PNG"))
    decode_image(make_image(30, 30, "PNG"))  # 900 px: fine
    with pytest.raises(ImageTooLarge):
        decode_image(make_image(40, 40, "PNG"), max_pixels=1599)


@pytest.mark.parametrize("payload", [b"", b"not an image", b"\xff\xd8\xff\xe0 truncated"])
def test_undecodable(payload):
    with pytest.raises(ImageUndecodable):
        decode_image(payload)


def test_unsupported_format_rejected():
    with pytest.raises(ImageUndecodable):
        decode_image(make_image(10, 10, "GIF"))
