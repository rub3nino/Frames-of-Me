import numpy as np

from app.liveness import INPUT_SIZE, NoLiveness, increased_crop, load_liveness, preprocess


def test_increased_crop_is_square_and_padded():
    rgb = np.full((100, 200, 3), 7, dtype=np.uint8)
    crop = increased_crop(rgb, (0.0, 0.0, 40.0, 20.0), bbox_inc=1.5)
    assert crop.shape == (60, 60, 3)
    assert crop[0, 0].tolist() == [0, 0, 0]  # padded region (above/left of the image)
    assert crop[59, 59].tolist() == [7, 7, 7]  # inside the image


def test_preprocess_layout():
    t = preprocess(np.full((64, 64, 3), 255, dtype=np.uint8))
    assert t.shape == (1, 3, INPUT_SIZE, INPUT_SIZE) and t.dtype == np.float32
    assert float(t.max()) == 1.0


def test_load_liveness_falls_back_to_none(tmp_path):
    assert isinstance(load_liveness(None), NoLiveness)
    assert isinstance(load_liveness(str(tmp_path / "missing.onnx")), NoLiveness)
    r = NoLiveness().predict(np.zeros((10, 10, 3), dtype=np.uint8), None)
    assert (r.live, r.score, r.method) == (True, 0.0, "none")
