#!/usr/bin/env python3
"""Offline selfie search: embed selfie files with the face-service and score them against every
face vector of an event with the engine's own pgvector query. Raw cosines, no thresholds.

    DATABASE_URL=postgres://rephoto:...@localhost:5433/rephoto \\
    python scripts/eval/offline-search.py --event conferenza-2026 --selfies selfies/ \\
        --face-service http://localhost:8090 --out offline-search.csv [--top 500 | --all]

Selfie files: every image under --selfies. The subject is the file stem up to the first `_`, `-`
or `.` (alice_1.jpg → alice), or the whole stem; override with --subjects-csv (filename,subject).
The largest face of each selfie is used (as the `match` job does); the others are reported
with face_index > 0 only when --all-faces is given.

Output CSV: selfie,subject,face_index,face_px,quality,rank,photo_id,external_face_id,cosine,
similarity,filename,sha256 — one row per candidate face (top N per selfie, or all with --all).
`similarity` = the engine mapping 80 + 20 × clamp((c − MIN)/(SURE − MIN)) for c ≥ MIN, else empty.
evaluate.py reads this file with --offline for the threshold sweep.

Null-selfie protocol (scripts/eval/null-selfie.md): selfies of people NOT in the event → every row
here is an impostor score; the p99/max per selfie tell you how low MIN can go.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from pathlib import Path

try:
    import psycopg
except ImportError:  # pragma: no cover
    sys.exit("psycopg is required: pip install -r scripts/eval/requirements-eval.txt")

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None
    import urllib.request

IMAGE_EXT = {".jpg", ".jpeg", ".png"}

SEARCH_SQL = """
select v.external_face_id::text, v.photo_id::text, 1 - (v.embedding <=> %(vec)s::vector) as cos
from face_vectors v
where v.event_id = %(event)s::uuid
order by v.embedding <=> %(vec)s::vector
limit %(limit)s
"""

SEARCH_ALL_SQL = """
select v.external_face_id::text, v.photo_id::text, 1 - (v.embedding <=> %(vec)s::vector) as cos
from face_vectors v
where v.event_id = %(event)s::uuid
order by cos desc
"""


def embed(url: str, path: Path, max_faces: int, min_size: int) -> dict:
    data = path.read_bytes()
    ctype = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    endpoint = f"{url.rstrip('/')}/v1/embed?max_faces={max_faces}&min_size={min_size}"
    if httpx is not None:
        with httpx.Client(timeout=120) as client:
            response = client.post(endpoint, files={"image": (path.name, data, ctype)})
            response.raise_for_status()
            return response.json()
    # urllib fallback: minimal multipart
    import json
    import uuid

    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{path.name}\"\r\n"
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(endpoint, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 (local service)
        return json.load(response)


def subject_of(path: Path, overrides: dict[str, str]) -> str:
    if path.name in overrides:
        return overrides[path.name]
    stem = path.stem
    for sep in ("_", "-", "."):
        if sep in stem:
            return stem.split(sep)[0]
    return stem


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", required=True, help="event slug")
    ap.add_argument("--selfies", required=True, type=Path, help="folder (or file) of selfies")
    ap.add_argument("--subjects-csv", type=Path, help="filename,subject overrides")
    ap.add_argument("--face-service", default=os.environ.get("FACE_SERVICE_URL", "http://localhost:8090"))
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--top", type=int, default=500, help="candidates per selfie face (HNSW, like the engine)")
    ap.add_argument("--all", action="store_true", help="every vector of the event (exact scan, big CSV)")
    ap.add_argument("--all-faces", action="store_true", help="score every face of the selfie, not only the largest")
    ap.add_argument("--ef-search", type=int, default=500, help="hnsw.ef_search for --top (engine uses 500)")
    ap.add_argument("--min-cosine", type=float, default=float(os.environ.get("INSIGHTFACE_MIN_COSINE", "0.50")))
    ap.add_argument("--sure-cosine", type=float, default=float(os.environ.get("INSIGHTFACE_SURE_COSINE", "0.70")))
    args = ap.parse_args()
    if not args.database_url:
        sys.exit("DATABASE_URL (or --database-url) is required")

    overrides: dict[str, str] = {}
    if args.subjects_csv:
        with args.subjects_csv.open(newline="") as fh:
            for row in csv.DictReader(fh):
                overrides[row["filename"]] = row["subject"]
    files = sorted(p for p in args.selfies.rglob("*") if p.suffix.lower() in IMAGE_EXT) if args.selfies.is_dir() else [args.selfies]
    if not files:
        sys.exit(f"no selfies under {args.selfies}")

    def similarity(c: float) -> str:
        if c < args.min_cosine:
            return ""
        t = min(1.0, max(0.0, (c - args.min_cosine) / (args.sure_cosine - args.min_cosine)))
        return f"{80 + 20 * t:.1f}"

    with psycopg.connect(args.database_url) as conn, args.out.open("w", newline="") as fh:
        cur = conn.cursor()
        cur.execute("select id from events where slug = %s", (args.event,))
        row = cur.fetchone()
        if not row:
            sys.exit(f"event not found: {args.event}")
        event_id = str(row[0])
        cur.execute("select count(*) from face_vectors where event_id = %s::uuid", (event_id,))
        total = cur.fetchone()[0]
        cur.execute("select exists (select 1 from information_schema.columns where table_name = 'photos' and column_name = 'filename')")
        has_filename = cur.fetchone()[0]
        print(f"event {args.event} ({event_id}): {total} face vectors; {len(files)} selfies", file=sys.stderr)

        writer = csv.writer(fh)
        writer.writerow(["selfie", "subject", "face_index", "face_px", "quality", "rank", "photo_id", "external_face_id", "cosine", "similarity", "filename", "sha256"])
        for n, path in enumerate(files, 1):
            t0 = time.time()
            try:
                result = embed(args.face_service, path, max_faces=10 if args.all_faces else 1, min_size=20)
            except Exception as error:
                print(f"{path.name}: embed failed: {error}", file=sys.stderr)
                writer.writerow([path.name, subject_of(path, overrides), "", "", "", "", "", "", "", "", "embed_error", ""])
                continue
            faces = sorted(result.get("faces", []), key=lambda f: -(f["bbox"]["width"] * f["bbox"]["height"]))
            if not faces:
                writer.writerow([path.name, subject_of(path, overrides), "", "", "", "", "", "", "", "", "no_face", ""])
                print(f"{path.name}: no face", file=sys.stderr)
                continue
            width, height = result.get("width", 0), result.get("height", 0)
            for face_index, face in enumerate(faces if args.all_faces else faces[:1]):
                vec = "[" + ",".join(f"{v:.6f}" for v in face["embedding"]) + "]"
                face_px = int(max(face["bbox"]["width"] * width, face["bbox"]["height"] * height))
                with conn.transaction():
                    if args.all:
                        cur.execute(SEARCH_ALL_SQL, {"vec": vec, "event": event_id})
                    else:
                        cur.execute(f"set local hnsw.ef_search = {int(args.ef_search)}")
                        cur.execute(SEARCH_SQL, {"vec": vec, "event": event_id, "limit": args.top})
                    hits = cur.fetchall()
                photo_ids = sorted({h[1] for h in hits})
                meta: dict[str, tuple[str, str]] = {}
                if photo_ids:
                    cols = "id::text, sha256, " + ("filename" if has_filename else "null")
                    cur.execute(f"select {cols} from photos where id = any(%s::uuid[])", (photo_ids,))
                    for pid, sha, fname in cur.fetchall():
                        meta[pid] = (fname or "", sha)
                for rank, (ext_id, pid, cos) in enumerate(hits, 1):
                    fname, sha = meta.get(pid, ("", ""))
                    writer.writerow([path.name, subject_of(path, overrides), face_index, face_px, f"{face.get('quality', 0):.3f}", rank, pid, ext_id, f"{float(cos):.4f}", similarity(float(cos)), fname, sha])
            best = f"{float(hits[0][2]):.3f}" if hits else "-"
            print(f"{n}/{len(files)} {path.name}: {len(faces)} face(s), best cosine {best}, {(time.time() - t0) * 1000:.0f} ms", file=sys.stderr)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
