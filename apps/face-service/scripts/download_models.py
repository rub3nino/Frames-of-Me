#!/usr/bin/env python3
"""Fetch the insightface model pack (and optionally the anti-spoofing weights) into a
model root so the runtime container needs no network.

    python scripts/download_models.py --root /models [--model buffalo_l] [--liveness 1]

Layout produced (what the service expects via MODEL_ROOT):
    <root>/models/<name>/det_10g.onnx, w600k_r50.onnx     (insightface convention)
    <root>/antispoof/AntiSpoofing_bin_1.5_128.onnx        (optional)
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.request

KEEP_MODELS = {"det_10g.onnx", "w600k_r50.onnx"}  # detection + recognition only

# MiniFASNet (Silent-Face architecture) trained on CelebA-Spoof by hairymax/Face-AntiSpoofing,
# pinned to a commit; verified by SHA-256. Note: that repository publishes no licence file.
LIVENESS_URL = "https://raw.githubusercontent.com/hairymax/Face-AntiSpoofing/eed4e278d80e60c2c63ea8e480886266e566ec63/saved_models/AntiSpoofing_bin_1.5_128.onnx"
LIVENESS_SHA256 = "a6c0553fab996a56962baeb0a49013a03c32b866999f6aea76936b6833929bda"
LIVENESS_REL_PATH = os.path.join("antispoof", "AntiSpoofing_bin_1.5_128.onnx")


def download_pack(root: str, name: str, prune: bool) -> str:
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name=name, root=root, providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    assert "detection" in app.models and "recognition" in app.models, "pack lacks detection/recognition"
    pack_dir = app.model_dir
    del app
    zip_path = pack_dir + ".zip"
    if os.path.exists(zip_path):
        os.remove(zip_path)
    if prune:
        for fn in os.listdir(pack_dir):
            if fn.endswith(".onnx") and fn not in KEEP_MODELS:
                os.remove(os.path.join(pack_dir, fn))
    return pack_dir


def download_liveness(root: str) -> str:
    dest = os.path.join(root, LIVENESS_REL_PATH)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not os.path.exists(dest):
        tmp = dest + ".part"
        with urllib.request.urlopen(LIVENESS_URL, timeout=60) as resp, open(tmp, "wb") as out:
            while chunk := resp.read(1024 * 1024):
                out.write(chunk)
        os.replace(tmp, dest)
    digest = hashlib.sha256(open(dest, "rb").read()).hexdigest()
    if digest != LIVENESS_SHA256:
        os.remove(dest)
        raise SystemExit(f"liveness weights checksum mismatch: {digest}")
    return dest


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--root", default=os.environ.get("MODEL_ROOT", "/models"))
    p.add_argument("--model", default=os.environ.get("MODEL_NAME", "buffalo_l"))
    p.add_argument("--liveness", type=int, default=1, help="1 = also fetch the anti-spoofing ONNX (default), 0 = skip")
    p.add_argument("--no-prune", action="store_true", help="keep landmark/genderage models of the pack")
    args = p.parse_args()

    os.makedirs(args.root, exist_ok=True)
    pack = download_pack(args.root, args.model, prune=not args.no_prune)
    print(f"model pack ready: {pack} -> {sorted(os.listdir(pack))}")
    if args.liveness:
        print(f"liveness weights ready: {download_liveness(args.root)}")
    else:
        print("liveness weights skipped (service will answer method=none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
