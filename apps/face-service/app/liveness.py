"""Passive liveness (anti-spoofing) on a single face crop.

`SilentFaceLiveness` runs a MiniFASNet model (the architecture of MiniVision's
Silent-Face-Anti-Spoofing) exported to ONNX: input is a 1.5x-enlarged square crop
around the face, resized to 128x128, RGB/255; output is a 2-class logit vector where
index 0 = live. When the weights are not present the service falls back to
`NoLiveness`, which reports `method: "none"` and never rejects.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

INPUT_SIZE = 128
BBOX_INCREASE = 1.5
DEFAULT_THRESHOLD = 0.5
DEFAULT_MODEL_FILENAME = "antispoof/AntiSpoofing_bin_1.5_128.onnx"


@dataclass(frozen=True)
class LivenessResult:
    live: bool
    score: float
    method: str


class NoLiveness:
    method = "none"

    def predict(self, bgr: np.ndarray, bbox: tuple[float, float, float, float] | None) -> LivenessResult:
        return LivenessResult(live=True, score=0.0, method=self.method)


def increased_crop(rgb: np.ndarray, bbox: tuple[float, float, float, float], *, bbox_inc: float = BBOX_INCREASE) -> np.ndarray:
    """Square crop of side `bbox_inc * max(w, h)` centred on the bbox, zero-padded outside the image."""

    real_h, real_w = rgb.shape[:2]
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    side = int(round(max(w, h) * bbox_inc))
    if side <= 0:
        raise ValueError("empty bbox")
    xc, yc = x1 + w / 2, y1 + h / 2
    x0, y0 = int(xc - side / 2), int(yc - side / 2)
    sx1, sy1 = max(0, x0), max(0, y0)
    sx2, sy2 = min(real_w, x0 + side), min(real_h, y0 + side)
    out = np.zeros((side, side, 3), dtype=np.uint8)
    if sx2 > sx1 and sy2 > sy1:
        out[sy1 - y0 : sy2 - y0, sx1 - x0 : sx2 - x0] = rgb[sy1:sy2, sx1:sx2]
    return out


def preprocess(crop_rgb: np.ndarray) -> np.ndarray:
    import cv2

    resized = cv2.resize(crop_rgb, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
    tensor = resized.transpose(2, 0, 1).astype(np.float32) / 255.0
    return np.ascontiguousarray(tensor[None])


def _softmax(x: np.ndarray) -> np.ndarray:
    x = x - np.max(x)
    e = np.exp(x)
    return e / np.sum(e)


class SilentFaceLiveness:
    method = "silent-face"

    def __init__(self, model_path: str, *, threshold: float = DEFAULT_THRESHOLD, threads: int = 1) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self._session = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        inp = self._session.get_inputs()[0]
        if list(inp.shape[1:]) != [3, INPUT_SIZE, INPUT_SIZE]:
            raise RuntimeError(f"unexpected liveness model input shape {inp.shape}")
        self._input_name = inp.name
        self.threshold = float(threshold)
        self.model_path = model_path

    def predict(self, bgr: np.ndarray, bbox: tuple[float, float, float, float] | None) -> LivenessResult:
        if bbox is None:
            return LivenessResult(live=False, score=0.0, method=self.method)
        rgb = bgr[:, :, ::-1]
        tensor = preprocess(increased_crop(rgb, bbox))
        logits = np.asarray(self._session.run(None, {self._input_name: tensor})[0]).reshape(-1)
        probs = _softmax(logits.astype(np.float64))
        score = float(np.clip(probs[0], 0.0, 1.0))
        return LivenessResult(live=score >= self.threshold, score=score, method=self.method)


def load_liveness(model_path: str | None, *, threshold: float = DEFAULT_THRESHOLD, threads: int = 1) -> NoLiveness | SilentFaceLiveness:
    if model_path and os.path.isfile(model_path):
        return SilentFaceLiveness(model_path, threshold=threshold, threads=threads)
    return NoLiveness()
