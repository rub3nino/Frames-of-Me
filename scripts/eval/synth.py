#!/usr/bin/env python3
"""Synthetic "hall photo" generator: paste portraits onto backgrounds at controlled face sizes.

    python scripts/eval/synth.py --portraits photo/ --out synth/ --count 200 \
        --sizes 24,32,48,64,80,100,140,200,300 --canvas 6000x4000

Each output image is a background (from --backgrounds, or a generated grey/gradient canvas) with
1..--max-faces portraits pasted at a chosen face size, random rotation, optional blur, random JPEG
quality. The face size is expressed on the 1600-px scale (the long edge the web derivative is
rendered at): a face of 80 px "on the 1600 scale" occupies 80 * (canvas_long_edge / 1600) px in
the saved file, so recall-by-size curves line up with what the pipeline sees.

Portraits: every image file in --portraits. The face region defaults to the whole image, so
pre-crop portraits to head-and-shoulders (or give `--portraits-csv` with columns
`file,subject,x,y,w,h` — normalised face box 0..1; subject defaults to the file stem).

Outputs under --out:
    synth_000001.jpg ...            the images (upload them with scripts/ingest/ingest.ts)
    labels.csv                      subject,filename  (one row per pasted face; evaluate.py input)
    synth_meta.csv                  filename,subject,face_px_1600,face_px_file,rotation_deg,blur,
                                    jpeg_quality,x,y,w,h  (per pasted face; evaluate.py --synth-meta)
Only numpy + Pillow are needed.
"""
from __future__ import annotations

import argparse
import csv
import math
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


@dataclass
class Portrait:
    path: Path
    subject: str
    box: tuple[float, float, float, float]  # normalised x, y, w, h of the face in the file
    image: Image.Image  # the face crop with some margin, RGB
    face: tuple[float, float, float, float]  # face box in crop pixels: x, y, w, h


def load_portraits(folder: Path, csv_path: Path | None, margin: float) -> list[Portrait]:
    boxes: dict[str, tuple[str, tuple[float, float, float, float]]] = {}
    if csv_path:
        with csv_path.open(newline="") as fh:
            for row in csv.DictReader(fh):
                box = (float(row.get("x", 0) or 0), float(row.get("y", 0) or 0), float(row.get("w", 1) or 1), float(row.get("h", 1) or 1))
                boxes[row["file"]] = (row.get("subject") or Path(row["file"]).stem, box)
    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in IMAGE_EXT) if folder.is_dir() else [folder]
    out: list[Portrait] = []
    for path in files:
        subject, box = boxes.get(path.name, boxes.get(str(path), (path.stem, (0.0, 0.0, 1.0, 1.0))))
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            w, h = im.size
            # Face box in pixels, expanded by `margin` on every side so the crop looks like a head shot.
            bx, by, bw, bh = box[0] * w, box[1] * h, box[2] * w, box[3] * h
            x0 = max(0, int(bx - bw * margin))
            y0 = max(0, int(by - bh * margin))
            x1 = min(w, int(bx + bw * (1 + margin)))
            y1 = min(h, int(by + bh * (1 + margin)))
            crop = im.crop((x0, y0, x1, y1)).copy()
        out.append(Portrait(path=path, subject=subject, box=box, image=crop, face=(bx - x0, by - y0, bw, bh)))
    if not out:
        sys.exit(f"no portraits under {folder}")
    return out


def load_backgrounds(folder: Path | None) -> list[Path]:
    if not folder:
        return []
    return sorted(p for p in folder.rglob("*") if p.suffix.lower() in IMAGE_EXT)


def generated_background(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """A neutral hall-like background: vertical gradient + light noise, random tint."""
    w, h = size
    base = rng.randint(70, 150)
    tint = np.array([rng.randint(-15, 15) for _ in range(3)], dtype=np.float32)
    rows = np.linspace(base + 30, base - 30, h, dtype=np.float32)[:, None, None]
    noise = np.random.default_rng(rng.randint(0, 2**31 - 1)).normal(0, 6, (h, w, 1)).astype(np.float32)
    arr = np.clip(rows + tint[None, None, :] + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def open_background(path: Path, size: tuple[int, int]) -> Image.Image:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        return ImageOps.fit(im, size, Image.Resampling.LANCZOS)


def paste_face(canvas: Image.Image, portrait: Portrait, face_px: int, rotation: float, rng: random.Random) -> tuple[int, int, int, int]:
    """Scale the portrait so its face box has `face_px` long edge, rotate, paste at a random spot."""
    crop = portrait.image
    cw, ch = crop.size
    # Face box inside the crop (the crop includes the margin around the box).
    face_x, face_y, face_w, face_h = portrait.face
    face_long = max(face_w, face_h, 1.0)
    scale = face_px / face_long
    new_size = (max(2, int(round(cw * scale))), max(2, int(round(ch * scale))))
    scaled = crop.resize(new_size, Image.Resampling.LANCZOS)
    if rotation:
        scaled = scaled.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=None)
        mask = Image.new("L", crop.size, 255).resize(new_size).rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
    else:
        mask = None
    sw, sh = scaled.size
    W, H = canvas.size
    x = rng.randint(0, max(0, W - sw))
    y = rng.randint(0, max(0, H - sh))
    canvas.paste(scaled, (x, y), mask)
    if rotation:
        # The rotated crop is centred in the expanded bitmap; report the face box of the unrotated one.
        fx = x + int((sw - cw * scale) / 2 + face_x * scale)
        fy = y + int((sh - ch * scale) / 2 + face_y * scale)
    else:
        fx, fy = x + int(face_x * scale), y + int(face_y * scale)
    return fx, fy, int(face_w * scale), int(face_h * scale)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--portraits", required=True, type=Path, help="folder (or single file) of portraits")
    ap.add_argument("--portraits-csv", type=Path, help="file,subject,x,y,w,h (normalised face box)")
    ap.add_argument("--backgrounds", type=Path, help="folder of background photos (else generated)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--count", type=int, default=50, help="images to generate")
    ap.add_argument("--sizes", default="24,32,48,64,80,100,140,200,300", help="face long edges on the 1600-px scale")
    ap.add_argument("--canvas", default="6000x4000", help="output size WxH (24 MP default)")
    ap.add_argument("--max-faces", type=int, default=4, help="faces per image, 1..n (distinct subjects)")
    ap.add_argument("--rotation", type=float, default=15.0, help="max |rotation| in degrees")
    ap.add_argument("--blur", type=float, default=1.5, help="max gaussian blur radius applied to the whole image (0 = off)")
    ap.add_argument("--blur-prob", type=float, default=0.3)
    ap.add_argument("--quality", default="70-95", help="JPEG quality range")
    ap.add_argument("--margin", type=float, default=0.6, help="crop margin around the face box (fraction of the box)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    sizes = [int(s) for s in args.sizes.split(",") if s.strip()]
    W, H = (int(v) for v in args.canvas.lower().split("x"))
    scale_1600 = max(W, H) / 1600.0
    qmin, qmax = (int(v) for v in args.quality.split("-"))
    portraits = load_portraits(args.portraits, args.portraits_csv, args.margin)
    backgrounds = load_backgrounds(args.backgrounds)
    args.out.mkdir(parents=True, exist_ok=True)

    labels_path = args.out / "labels.csv"
    meta_path = args.out / "synth_meta.csv"
    with labels_path.open("w", newline="") as lf, meta_path.open("w", newline="") as mf:
        labels = csv.writer(lf)
        meta = csv.writer(mf)
        labels.writerow(["subject", "filename"])
        meta.writerow(["filename", "subject", "face_px_1600", "face_px_file", "rotation_deg", "blur", "jpeg_quality", "x", "y", "w", "h"])
        for i in range(1, args.count + 1):
            name = f"synth_{i:06d}.jpg"
            canvas = open_background(rng.choice(backgrounds), (W, H)) if backgrounds else generated_background((W, H), rng)
            n_faces = rng.randint(1, min(args.max_faces, len(portraits)))
            chosen = rng.sample(portraits, n_faces)
            blur = round(rng.uniform(0.3, args.blur), 2) if args.blur > 0 and rng.random() < args.blur_prob else 0.0
            quality = rng.randint(qmin, qmax)
            rows = []
            for portrait in chosen:
                size_1600 = rng.choice(sizes)
                face_px = max(4, int(round(size_1600 * scale_1600)))
                rotation = round(rng.uniform(-args.rotation, args.rotation), 1) if args.rotation > 0 else 0.0
                x, y, w, h = paste_face(canvas, portrait, face_px, rotation, rng)
                rows.append((portrait.subject, size_1600, face_px, rotation, x, y, w, h))
            if blur:
                canvas = canvas.filter(ImageFilter.GaussianBlur(blur))
            canvas.save(args.out / name, "JPEG", quality=quality, optimize=False)
            for subject, size_1600, face_px, rotation, x, y, w, h in rows:
                labels.writerow([subject, name])
                meta.writerow([name, subject, size_1600, face_px, rotation, blur, quality, x, y, w, h])
            if i % 25 == 0 or i == args.count:
                print(f"{i}/{args.count}", file=sys.stderr)
    print(f"wrote {args.count} images, {labels_path}, {meta_path}")


if __name__ == "__main__":
    main()
