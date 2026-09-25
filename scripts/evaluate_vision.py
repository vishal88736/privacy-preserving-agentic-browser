#!/usr/bin/env python3
"""Score annotated JSONL runs for perception, redaction, latency, and resources.

Each input row may contain:
  {"objects":{"truth":[{"label":"button","bbox":[x,y,w,h]}],"predicted":[...]},
   "pii":{"truth":[{"category":"EMAIL","bbox":[...]}],"predicted":[...]},
   "redactions":{"truth":[{"category":"EMAIL","bbox":[...]}],"predicted":[...]},
   "end_to_end_latency_ms":1234,"client_heap_bytes":123456,"client_asset_bytes":12345}

Coordinates are CSS pixel boxes in the same viewport coordinate space.
"truth" values must be labeled by a human; the script does not invent results.
"""

import argparse
import json
import math
import statistics
import sys
from pathlib import Path


def iou(a, b):
    if not isinstance(a, list) or not isinstance(b, list) or len(a) != 4 or len(b) != 4:
        return 0.0
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    intersection = max(0, right - left) * max(0, bottom - top)
    union = max(0, aw) * max(0, ah) + max(0, bw) * max(0, bh) - intersection
    return intersection / union if union > 0 else 0.0


def match_boxes(truth, predicted, threshold, label_key):
    candidates = []
    for ti, actual in enumerate(truth):
        for pi, guess in enumerate(predicted):
            if label_key and actual.get(label_key) != guess.get(label_key):
                continue
            overlap = iou(actual.get("bbox"), guess.get("bbox"))
            if overlap >= threshold:
                candidates.append((overlap, ti, pi))
    candidates.sort(reverse=True)
    used_truth, used_predicted = set(), set()
    for _overlap, ti, pi in candidates:
        if ti not in used_truth and pi not in used_predicted:
            used_truth.add(ti)
            used_predicted.add(pi)
    return len(used_truth), len(predicted) - len(used_predicted), len(truth) - len(used_truth)


def metrics(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else (1.0 if fn == 0 else 0.0)
    recall = tp / (tp + fn) if tp + fn else 1.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "tp": tp, "fp": fp, "fn": fn}


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - position) + ordered[high] * (position - low)


def score(path, threshold):
    objects = [0, 0, 0]
    pii = [0, 0, 0]
    redactions = [0, 0, 0]
    latencies, heaps, asset_sizes = [], [], []
    records = 0
    with Path(path).open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc.msg}") from exc
            records += 1
            for section, totals, label_key in (
                ("objects", objects, "label"),
                ("pii", pii, "category"),
                ("redactions", redactions, "category"),
            ):
                data = row.get(section) or {}
                counts = match_boxes(data.get("truth", []), data.get("predicted", []), threshold, label_key)
                for index, value in enumerate(counts):
                    totals[index] += value
            if isinstance(row.get("end_to_end_latency_ms"), (int, float)):
                latencies.append(float(row["end_to_end_latency_ms"]))
            if isinstance(row.get("client_heap_bytes"), (int, float)):
                heaps.append(int(row["client_heap_bytes"]))
            if isinstance(row.get("client_asset_bytes"), (int, float)):
                asset_sizes.append(int(row["client_asset_bytes"]))
    if records == 0:
        raise ValueError("The annotation file contains no records.")
    return {
        "records": records,
        "iou_threshold": threshold,
        "visual_context": metrics(*objects),
        "pii_detection": metrics(*pii),
        "redaction": metrics(*redactions),
        "latency_ms": {
            "median": round(statistics.median(latencies), 2) if latencies else None,
            "p95": round(percentile(latencies, 0.95), 2) if latencies else None,
        },
        "client_resources": {
            "max_heap_bytes": max(heaps) if heaps else None,
            "max_shipped_asset_bytes": max(asset_sizes) if asset_sizes else None,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("annotations", help="Path to annotated JSON Lines input")
    parser.add_argument("--iou", type=float, default=0.5, help="Box match IoU threshold (default: 0.5)")
    args = parser.parse_args()
    if not 0 < args.iou <= 1:
        parser.error("--iou must be in (0, 1]")
    try:
        print(json.dumps(score(args.annotations, args.iou), indent=2))
    except (OSError, ValueError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
