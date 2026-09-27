#!/usr/bin/env python3
"""Replay the same grounded browser decisions against reasoning model IDs.

Input is JSON Lines. Each row contains the sanitized planner inputs captured
or authored for one decision:
  {"case_id":"search-1", "task":"...", "task_state":{},
   "page_state":{}, "fused_observation":{"elements":[]}, "task_history":[],
   "expected_action":"CLICK", "expected_target_id":"el_12",
   "expected_terminal":false, "must_ask_user":false,
   "must_not_target_ids":[]}

Labels are optional. Unlabeled cases still contribute grounding, repair, and
latency metrics. The production planner and its action-grounding repairs are
used; model output text and page content are never written to the report.
"""

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from config import settings  # noqa: E402
from gpt_oss_service import gpt_oss_service  # noqa: E402


def load_cases(path):
    cases = []
    with Path(path).open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc.msg}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"Line {line_number} must be a JSON object.")
            if not isinstance(row.get("task"), str) or not isinstance(row.get("fused_observation"), dict):
                raise ValueError(f"Line {line_number} needs string task and object fused_observation fields.")
            if not isinstance(row["fused_observation"].get("elements", []), list):
                raise ValueError(f"Line {line_number}: fused_observation.elements must be a list.")
            cases.append(row)
    if not cases:
        raise ValueError("No cases found.")
    return cases


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - position) + ordered[high] * (position - low)


def evaluate_model(model, cases):
    previous_model = settings.REASONING_MODEL
    settings.REASONING_MODEL = model
    rows = []
    try:
        for index, case in enumerate(cases, 1):
            started = time.perf_counter()
            try:
                plan = gpt_oss_service.plan_step(
                    task=case["task"],
                    fused_observation=case["fused_observation"],
                    task_history=case.get("task_history") or [],
                    task_state=case.get("task_state"),
                    page_state=case.get("page_state"),
                )
                action = plan.get("action") if isinstance(plan, dict) else None
                action = action if isinstance(action, dict) else {}
                action_name = action.get("action")
                target = action.get("target") if isinstance(action.get("target"), dict) else {}
                target_id = target.get("element_id")
                allowed_ids = {
                    element.get("id") or element.get("element_id")
                    for element in case["fused_observation"].get("elements", [])
                    if isinstance(element, dict)
                }
                allowed_ids.discard(None)
                trace = plan.get("model_trace") or {}
                thought = plan.get("thought") if isinstance(plan.get("thought"), str) else ""
                rows.append({
                    "case_id": str(case.get("case_id") or index),
                    "action": action_name,
                    "target_id": target_id,
                    "expected_action": case.get("expected_action"),
                    "expected_target_id": case.get("expected_target_id"),
                    "expected_terminal": case.get("expected_terminal"),
                    "must_ask_user": case.get("must_ask_user"),
                    "must_not_target_ids": case.get("must_not_target_ids") or [],
                    "target_grounded": target_id is None or target_id in allowed_ids,
                    "grounding_repair": "grounding-repair:" in thought,
                    "latency_ms": (time.perf_counter() - started) * 1000,
                    "trace": {
                        "source": trace.get("source"),
                        "provider": trace.get("provider"),
                        "model": trace.get("model") or model,
                    },
                })
            except Exception as exc:
                rows.append({
                    "case_id": str(case.get("case_id") or index),
                    "action": "ERROR",
                    "error_type": type(exc).__name__,
                    "latency_ms": (time.perf_counter() - started) * 1000,
                    "trace": {"source": "error", "provider": None, "model": model},
                })
    finally:
        settings.REASONING_MODEL = previous_model

    action_labeled = [row for row in rows if row.get("expected_action") is not None]
    target_labeled = [row for row in rows if row.get("expected_target_id") is not None]
    terminal_labeled = [row for row in rows if row.get("expected_terminal") is not None]
    clarification_labeled = [row for row in rows if row.get("must_ask_user") is not None]
    should_ask = [row for row in clarification_labeled if row["must_ask_user"]]
    should_not_ask = [row for row in clarification_labeled if not row["must_ask_user"]]
    targeted = [row for row in rows if row.get("target_id") is not None]
    forbidden_labeled = [row for row in rows if row.get("must_not_target_ids")]
    latencies = [row["latency_ms"] for row in rows]

    return {
        "model": model,
        "cases": len(rows),
        "errors": sum(row.get("action") == "ERROR" for row in rows),
        "action_accuracy": round(sum(row.get("action") == row["expected_action"] for row in action_labeled) / len(action_labeled), 4) if action_labeled else None,
        "target_accuracy": round(sum(row.get("target_id") == row["expected_target_id"] for row in target_labeled) / len(target_labeled), 4) if target_labeled else None,
        "terminal_accuracy": round(sum((row.get("action") == "DONE") == bool(row["expected_terminal"]) for row in terminal_labeled) / len(terminal_labeled), 4) if terminal_labeled else None,
        "clarification_recall": round(sum(row.get("action") == "ASK_USER" for row in should_ask) / len(should_ask), 4) if should_ask else None,
        "unneeded_clarification_rate": round(sum(row.get("action") == "ASK_USER" for row in should_not_ask) / len(should_not_ask), 4) if should_not_ask else None,
        "grounded_target_rate": round(sum(row["target_grounded"] for row in targeted) / len(targeted), 4) if targeted else None,
        "grounding_repair_rate": round(sum(row.get("grounding_repair", False) for row in rows) / len(rows), 4),
        "forbidden_target_count": sum(row.get("target_id") in row.get("must_not_target_ids", []) for row in forbidden_labeled),
        "latency_ms": {
            "median": round(statistics.median(latencies), 1) if latencies else None,
            "p95": round(percentile(latencies, 0.95), 1) if latencies else None,
        },
        "cases_detail": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", help="Sanitized JSON Lines planner cases")
    parser.add_argument("--models", help="Comma-separated model IDs; defaults to configured REASONING_MODEL")
    args = parser.parse_args()
    if not settings.API_KEY:
        parser.error("No reasoning API key is configured. Set the same backend environment used by the browser agent.")
    models = [item.strip() for item in (args.models or settings.REASONING_MODEL).split(",") if item.strip()]
    if not models:
        parser.error("At least one model ID is required.")
    try:
        cases = load_cases(args.cases)
        report = {
            "evaluation": "grounded browser-planner replay",
            "endpoint_host": urlsplit(settings.AI_BASE_URL).hostname,
            "case_count": len(cases),
            "results": [evaluate_model(model, cases) for model in models],
        }
        print(json.dumps(report, indent=2))
    except (OSError, ValueError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
