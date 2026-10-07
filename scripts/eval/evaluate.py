#!/usr/bin/env python3
"""Precision / recall of "only my photos" from ground-truth labels and the galleries the system built.

    python scripts/eval/evaluate.py --labels labels.csv --manifest manifest.csv \
        --subjects subjects.csv --galleries galleries.csv [--hits match-hits.csv] \
        [--faces faces.csv] [--synth-meta synth_meta.csv] [--offline offline-search.csv] \
        --out report/

Inputs (CSV with header; column names are matched case-insensitively, extra columns ignored):
  labels.csv      subject,filename           every (subject, photo) pair that is TRUE. A photo listed
                                             for any subject is "fully labelled": every subject NOT
                                             listed for it is assumed absent.
  manifest.csv    filename,sha256,photoId    from scripts/ingest/ingest.ts (links filename → photo id)
  subjects.csv    subject,email              which participant (e-mail) stands for which subject
  galleries.csv   email,photo_id,score[,source][,cosine]   admin export GET /v1/admin/export/galleries.csv
                  (user_email / userEmail / photoId / photo_id are all accepted)
  match-hits.csv  email,photo_id,cosine[,similarity][,kept]  (optional) admin export of match_hits:
                  all hits including the ones below MIN → enables the threshold sweep
  offline-search.csv  subject,photo_id,cosine  (optional) from scripts/eval/offline-search.py; same
                  role as match-hits for the sweep
  faces.csv       photo_id,bbox              (optional) for false negatives by face size:
                  \\copy (select f.photo_id, f.bbox::text as bbox from faces f join photos p on p.id = f.photo_id
                          where p.event_id = '<event uuid>') to 'faces.csv' csv header
  synth_meta.csv  filename,subject,face_px_1600,...   (optional) from synth.py: exact face size per pair

Outputs under --out: report.md, per_subject.csv, pairs.csv (every scored pair with its verdict),
sweep.csv (when cosines are available), hist_*.png (when matplotlib is installed).

Definitions: a prediction is a (subject, photo) pair present in the subject's gallery. Only
predictions on fully-labelled photos are judged (others are reported as "unverified"). The
"sure" group is score >= --sure-score (default 90 = the web's 0.9 threshold); "maybe" is below.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path


# ------------------------------------------------------------------ csv helpers

def read_csv(path: Path | None, *aliases: tuple[str, tuple[str, ...]]) -> list[dict[str, str]]:
    """Read a CSV and rename columns to canonical names via (canonical, (alias, ...)) pairs."""
    if path is None:
        return []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            return []
        lookup: dict[str, str] = {}
        normalised = {f.strip().lower().replace("_", "").replace(" ", ""): f for f in reader.fieldnames}
        for canonical, names in aliases:
            for name in (canonical,) + names:
                key = name.lower().replace("_", "")
                if key in normalised:
                    lookup[canonical] = normalised[key]
                    break
        rows = []
        for raw in reader:
            row = {canonical: (raw.get(src) or "").strip() for canonical, src in lookup.items()}
            rows.append(row)
        return rows


def base_name(filename: str) -> str:
    return filename.replace("\\", "/").split("/")[-1]


def fnum(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


# ------------------------------------------------------------------ metrics

def prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def text_hist(values: list[float], lo: float, hi: float, bins: int, width: int = 40) -> str:
    if not values:
        return "  (no values)\n"
    step = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        i = min(bins - 1, max(0, int((v - lo) / step)))
        counts[i] += 1
    peak = max(counts) or 1
    lines = []
    for i, c in enumerate(counts):
        bar = "#" * int(round(width * c / peak))
        lines.append(f"  {lo + i * step:6.2f}–{lo + (i + 1) * step:5.2f} {c:6d} {bar}")
    return "\n".join(lines) + "\n"


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


SIZE_BUCKETS = [(0, 32), (32, 48), (48, 64), (64, 80), (80, 100), (100, 140), (140, 200), (200, 300), (300, 10_000)]


def bucket(px: float) -> str:
    for lo, hi in SIZE_BUCKETS:
        if lo <= px < hi:
            return f"{lo}-{hi if hi < 10_000 else '+'}"
    return "?"


# ------------------------------------------------------------------ main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", required=True, type=Path)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--subjects", required=True, type=Path)
    ap.add_argument("--galleries", required=True, type=Path)
    ap.add_argument("--hits", type=Path, help="match-hits.csv export (all cosines)")
    ap.add_argument("--offline", type=Path, help="offline-search.py output (subject,photo_id,cosine)")
    ap.add_argument("--faces", type=Path, help="faces.csv (photo_id,bbox) for FN by face size")
    ap.add_argument("--synth-meta", type=Path, help="synth_meta.csv from synth.py")
    ap.add_argument("--sure-score", type=float, default=90.0, help="score >= this is the 'sure' group (web: 0.9 → 90)")
    ap.add_argument("--min-cosine", type=float, default=0.50, help="MIN used by the run (annotated in the sweep)")
    ap.add_argument("--sure-cosine", type=float, default=0.70)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    labels = read_csv(args.labels, ("subject", ()), ("filename", ("file", "photo", "name")))
    manifest = read_csv(args.manifest, ("filename", ("file",)), ("sha256", ()), ("photoId", ("photo_id", "id")), ("status", ()))
    subjects = read_csv(args.subjects, ("subject", ()), ("email", ("user_email", "userEmail")))
    galleries = read_csv(
        args.galleries,
        ("email", ("user_email", "userEmail", "user")),
        ("photoId", ("photo_id", "photo")),
        ("score", ("similarity",)),
        ("source", ()),
        ("cosine", ("cos",)),
        ("feedback", ("verdict",)),
    )
    hits = read_csv(args.hits, ("email", ("user_email", "userEmail")), ("photoId", ("photo_id",)), ("cosine", ("cos",)), ("kept", ()))
    offline = read_csv(args.offline, ("subject", ()), ("photoId", ("photo_id",)), ("cosine", ("cos",)))
    faces = read_csv(args.faces, ("photoId", ("photo_id",)), ("bbox", ()))
    synth_meta = read_csv(args.synth_meta, ("filename", ()), ("subject", ()), ("facePx", ("face_px_1600",)))

    # filename → photoId (manifest), by full relative path and by basename
    photo_by_name: dict[str, str] = {}
    for row in manifest:
        pid = row.get("photoId") or ""
        if not pid:
            continue
        photo_by_name.setdefault(row["filename"], pid)
        photo_by_name.setdefault(base_name(row["filename"]), pid)
    email_to_subject = {r["email"].lower(): r["subject"] for r in subjects if r.get("email")}
    subject_set = {r["subject"] for r in subjects}

    # ground truth
    truth: dict[str, set[str]] = defaultdict(set)  # subject → photo ids
    labelled_photos: set[str] = set()
    unresolved = 0
    for row in labels:
        pid = photo_by_name.get(row["filename"]) or photo_by_name.get(base_name(row["filename"]))
        if not pid:
            unresolved += 1
            continue
        truth[row["subject"]].add(pid)
        labelled_photos.add(pid)
    all_subjects = sorted(subject_set | set(truth))

    # predictions
    pred: dict[str, dict[str, dict[str, str]]] = defaultdict(dict)  # subject → photo → row
    unknown_emails: set[str] = set()
    for row in galleries:
        subject = email_to_subject.get(row.get("email", "").lower())
        if subject is None:
            unknown_emails.add(row.get("email", ""))
            continue
        if row.get("feedback") == "not_me":
            continue
        pred[subject][row["photoId"]] = row

    # face sizes per photo (fraction of the long edge × 1600) and exact per pair from synth
    face_px_by_photo: dict[str, list[float]] = defaultdict(list)
    for row in faces:
        try:
            bbox = json.loads(row["bbox"])
            face_px_by_photo[row["photoId"]].append(max(float(bbox["width"]), float(bbox["height"])) * 1600)
        except (ValueError, KeyError, TypeError):
            continue
    face_px_by_pair: dict[tuple[str, str], float] = {}
    for row in synth_meta:
        pid = photo_by_name.get(row["filename"]) or photo_by_name.get(base_name(row["filename"]))
        px = fnum(row.get("facePx"))
        if pid and px is not None:
            face_px_by_pair[(row["subject"], pid)] = px

    # judge every pair
    pairs = []  # dicts for pairs.csv
    per_subject = {}
    g_tp = g_fp = g_fn = 0
    sure_tp = sure_fp = maybe_tp = maybe_fp = 0
    unverified = 0
    true_scores: list[float] = []
    false_scores: list[float] = []
    fn_sizes: list[float] = []
    tp_sizes: list[float] = []
    for subject in all_subjects:
        t = truth.get(subject, set())
        p = pred.get(subject, {})
        tp = fp = 0
        for pid, row in p.items():
            score = fnum(row.get("score"))
            if score is not None and score <= 1.0:
                score *= 100  # web-style 0..1
            sure = score is not None and score >= args.sure_score
            if pid not in labelled_photos:
                unverified += 1
                pairs.append({"subject": subject, "photo_id": pid, "verdict": "unverified", "score": score, "source": row.get("source", "")})
                continue
            correct = pid in t
            if correct:
                tp += 1
                if score is not None:
                    true_scores.append(score)
                if sure:
                    sure_tp += 1
                else:
                    maybe_tp += 1
            else:
                fp += 1
                if score is not None:
                    false_scores.append(score)
                if sure:
                    sure_fp += 1
                else:
                    maybe_fp += 1
            px = face_px_by_pair.get((subject, pid)) or (max(face_px_by_photo[pid]) if face_px_by_photo.get(pid) else None)
            if correct and px is not None:
                tp_sizes.append(px)
            pairs.append({"subject": subject, "photo_id": pid, "verdict": "tp" if correct else "fp", "score": score, "source": row.get("source", ""), "face_px": px})
        missed = t - set(p)
        for pid in missed:
            px = face_px_by_pair.get((subject, pid)) or (max(face_px_by_photo[pid]) if face_px_by_photo.get(pid) else None)
            if px is not None:
                fn_sizes.append(px)
            pairs.append({"subject": subject, "photo_id": pid, "verdict": "fn", "score": None, "source": "", "face_px": px})
        fn = len(missed)
        pr, rc, f1 = prf(tp, fp, fn)
        per_subject[subject] = {"subject": subject, "truth": len(t), "predicted": len(p), "tp": tp, "fp": fp, "fn": fn, "precision": pr, "recall": rc, "f1": f1}
        g_tp += tp
        g_fp += fp
        g_fn += fn
    g_p, g_r, g_f = prf(g_tp, g_fp, g_fn)
    perfect = sum(1 for s in per_subject.values() if s["fp"] == 0 and s["fn"] == 0 and s["truth"] > 0)
    clean = sum(1 for s in per_subject.values() if s["fp"] == 0)

    # threshold sweep from raw cosines (match-hits or offline search)
    cos_rows: list[tuple[str, str, float]] = []
    for row in hits:
        subject = email_to_subject.get(row.get("email", "").lower())
        c = fnum(row.get("cosine"))
        if subject and c is not None:
            cos_rows.append((subject, row["photoId"], c))
    for row in offline:
        c = fnum(row.get("cosine"))
        if row.get("subject") and c is not None:
            cos_rows.append((row["subject"], row["photoId"], c))
    sweep = []
    best_cos: dict[tuple[str, str], float] = {}
    for subject, pid, c in cos_rows:
        key = (subject, pid)
        if c > best_cos.get(key, -1):
            best_cos[key] = c
    true_cos = [c for (s, pid), c in best_cos.items() if pid in labelled_photos and pid in truth.get(s, set())]
    false_cos = [c for (s, pid), c in best_cos.items() if pid in labelled_photos and pid not in truth.get(s, set())]
    total_truth = sum(len(v) for v in truth.values())
    if best_cos:
        thresholds = [round(0.25 + i * 0.01, 2) for i in range(0, 61)]
        for th in thresholds:
            tp = sum(1 for c in true_cos if c >= th)
            fp = sum(1 for c in false_cos if c >= th)
            fn = total_truth - tp
            p, r, f = prf(tp, fp, fn)
            sweep.append({"threshold": th, "tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f})
        with (args.out / "sweep.csv").open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(sweep[0].keys()))
            w.writeheader()
            w.writerows(sweep)

    # files
    with (args.out / "per_subject.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["subject", "truth", "predicted", "tp", "fp", "fn", "precision", "recall", "f1"])
        w.writeheader()
        for s in per_subject.values():
            w.writerow({k: (f"{v:.4f}" if isinstance(v, float) else v) for k, v in s.items()})
    with (args.out / "pairs.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["subject", "photo_id", "verdict", "score", "source", "face_px"])
        w.writeheader()
        for row in pairs:
            w.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in w.fieldnames})

    # FN by face size
    size_table = []
    if fn_sizes or tp_sizes:
        by_bucket: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for px in tp_sizes:
            by_bucket[bucket(px)][0] += 1
        for px in fn_sizes:
            by_bucket[bucket(px)][1] += 1
        for lo, hi in SIZE_BUCKETS:
            name = f"{lo}-{hi if hi < 10_000 else '+'}"
            tp_n, fn_n = by_bucket.get(name, [0, 0])
            if tp_n + fn_n:
                size_table.append((name, tp_n, fn_n, tp_n / (tp_n + fn_n)))

    # optional PNG histograms
    png_note = ""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        if true_scores or false_scores:
            plt.figure(figsize=(7, 4))
            plt.hist([true_scores, false_scores], bins=20, range=(80, 100), label=["true", "false"], color=["#2a9d8f", "#e76f51"])
            plt.xlabel("score")
            plt.ylabel("pairs")
            plt.legend()
            plt.title("Gallery scores: true vs false pairs")
            plt.tight_layout()
            plt.savefig(args.out / "hist_scores.png", dpi=120)
            plt.close()
        if true_cos or false_cos:
            plt.figure(figsize=(7, 4))
            plt.hist([true_cos, false_cos], bins=40, range=(0.2, 1.0), label=["true", "false"], color=["#2a9d8f", "#e76f51"])
            plt.axvline(args.min_cosine, color="k", linestyle="--", label="MIN")
            plt.axvline(args.sure_cosine, color="k", linestyle=":", label="SURE")
            plt.xlabel("cosine")
            plt.ylabel("pairs")
            plt.legend()
            plt.title("Raw cosines: true vs false pairs")
            plt.tight_layout()
            plt.savefig(args.out / "hist_cosines.png", dpi=120)
            plt.close()
        if sweep:
            plt.figure(figsize=(7, 4))
            plt.plot([s["threshold"] for s in sweep], [s["precision"] for s in sweep], label="precision")
            plt.plot([s["threshold"] for s in sweep], [s["recall"] for s in sweep], label="recall")
            plt.plot([s["threshold"] for s in sweep], [s["f1"] for s in sweep], label="F1")
            plt.axvline(args.min_cosine, color="k", linestyle="--")
            plt.xlabel("cosine threshold")
            plt.legend()
            plt.title("Threshold sweep")
            plt.tight_layout()
            plt.savefig(args.out / "sweep.png", dpi=120)
            plt.close()
        png_note = "PNG histograms written next to this report."
    except Exception as error:  # matplotlib missing or headless trouble: text histograms are enough
        png_note = f"(no PNG: {type(error).__name__}: {error})"

    # report
    lines = []
    lines.append("# RePhoto — evaluation report\n")
    lines.append(f"Labels: {len(labels)} pairs, {len(labelled_photos)} labelled photos, {len(all_subjects)} subjects"
                 + (f", {unresolved} label rows without a manifest match" if unresolved else "") + ".  ")
    lines.append(f"Galleries: {len(galleries)} rows, {sum(len(p) for p in pred.values())} judged pairs, {unverified} unverified (photo not labelled)"
                 + (f", {len(unknown_emails)} e-mails not in subjects.csv" if unknown_emails else "") + ".\n")
    lines.append("## Global\n")
    lines.append("| TP | FP | FN | precision | recall | F1 |\n|---|---|---|---|---|---|")
    lines.append(f"| {g_tp} | {g_fp} | {g_fn} | {g_p:.3f} | {g_r:.3f} | {g_f:.3f} |\n")
    lines.append(f"Subjects with a perfect gallery (0 FP, 0 FN): **{perfect}/{len(per_subject)}**; with no false photo at all: **{clean}/{len(per_subject)}**.\n")
    lines.append("## Sure / maybe split (score ≥ %.0f = «Le tue foto»)\n" % args.sure_score)
    lines.append("| group | true | false | precision |\n|---|---|---|---|")
    lines.append(f"| sure | {sure_tp} | {sure_fp} | {sure_tp / (sure_tp + sure_fp):.3f} |" if sure_tp + sure_fp else "| sure | 0 | 0 | – |")
    lines.append(f"| maybe | {maybe_tp} | {maybe_fp} | {maybe_tp / (maybe_tp + maybe_fp):.3f} |\n" if maybe_tp + maybe_fp else "| maybe | 0 | 0 | – |\n")
    lines.append("## Per subject\n")
    lines.append("| subject | truth | predicted | TP | FP | FN | P | R | F1 |\n|---|---|---|---|---|---|---|---|---|")
    for s in per_subject.values():
        lines.append(f"| {s['subject']} | {s['truth']} | {s['predicted']} | {s['tp']} | {s['fp']} | {s['fn']} | {s['precision']:.2f} | {s['recall']:.2f} | {s['f1']:.2f} |")
    lines.append("")
    lines.append("## Score histograms (gallery score, 80–100)\n")
    lines.append("True pairs:\n```\n" + text_hist(true_scores, 80, 100, 10) + "```")
    lines.append("False pairs:\n```\n" + text_hist(false_scores, 80, 100, 10) + "```\n")
    if best_cos:
        lines.append("## Raw cosines and threshold sweep\n")
        lines.append(f"{len(best_cos)} (subject, photo) pairs with a cosine; true: {len(true_cos)}, false: {len(false_cos)}. "
                     f"True p5/p50 = {percentile(true_cos, 0.05):.3f}/{percentile(true_cos, 0.5):.3f}; "
                     f"false p95/p99/max = {percentile(false_cos, 0.95):.3f}/{percentile(false_cos, 0.99):.3f}/{max(false_cos) if false_cos else float('nan'):.3f}.\n")
        lines.append("True pairs:\n```\n" + text_hist(true_cos, 0.2, 1.0, 16) + "```")
        lines.append("False pairs:\n```\n" + text_hist(false_cos, 0.2, 1.0, 16) + "```\n")
        lines.append("| threshold | TP | FP | FN | precision | recall | F1 |\n|---|---|---|---|---|---|---|")
        for s in sweep:
            if abs(s["threshold"] * 100 % 5) < 1e-6 or abs(s["threshold"] - args.min_cosine) < 1e-9 or abs(s["threshold"] - args.sure_cosine) < 1e-9:
                mark = " ←MIN" if abs(s["threshold"] - args.min_cosine) < 1e-9 else (" ←SURE" if abs(s["threshold"] - args.sure_cosine) < 1e-9 else "")
                lines.append(f"| {s['threshold']:.2f}{mark} | {s['tp']} | {s['fp']} | {s['fn']} | {s['precision']:.3f} | {s['recall']:.3f} | {s['f1']:.3f} |")
        best = max(sweep, key=lambda s: s["f1"])
        zero_fp = [s for s in sweep if s["fp"] == 0]
        lines.append(f"\nBest F1 at threshold {best['threshold']:.2f} (P {best['precision']:.3f}, R {best['recall']:.3f}). "
                     + (f"Lowest threshold with 0 FP: {zero_fp[0]['threshold']:.2f} (recall {zero_fp[0]['recall']:.3f})." if zero_fp else "No threshold in 0.25–0.85 reaches 0 FP.")
                     + " Full table: sweep.csv\n")
    else:
        lines.append("## Raw cosines\n\nNot available: pass --hits (match-hits export, MATCH_LOG=true) or --offline (offline-search.py) for the threshold sweep.\n")
    lines.append("## False negatives by face size (px on the 1600-px scale)\n")
    if size_table:
        lines.append("| face px | found (TP) | missed (FN) | recall |\n|---|---|---|---|")
        for name, tp_n, fn_n, rc in size_table:
            lines.append(f"| {name} | {tp_n} | {fn_n} | {rc:.2f} |")
        lines.append("\nSize = exact per pair from synth_meta.csv when given, else the largest face of the photo from faces.csv (approximation).\n")
    else:
        lines.append("Not available: pass --faces (faces.csv) or --synth-meta.\n")
    lines.append(f"\n{png_note}\n")
    (args.out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"TP {g_tp}  FP {g_fp}  FN {g_fn}  precision {g_p:.3f}  recall {g_r:.3f}  F1 {g_f:.3f}  → {args.out / 'report.md'}")


if __name__ == "__main__":
    main()
