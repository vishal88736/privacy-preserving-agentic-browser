#!/usr/bin/env python3
"""Summarize end-to-end task timing traces exported by the browser extension.

The input contains one JSON object per task run. Reports include completion,
step count, total task time, and per-stage latency. Prompt text, page text,
thoughts, and action values are not expected in the export.
"""

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - position) + ordered[high] * (position - low)


def load_runs(path):
    runs = []
    with Path(path).open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc.msg}") from exc
            if not isinstance(row, dict) or not isinstance(row.get("steps"), list):
                raise ValueError(f"Line {line_number} must contain a task object with a steps list.")
            runs.append(row)
    if not runs:
        raise ValueError("No task runs found.")
    return runs


def summarize(runs):
    elapsed = [float(run["elapsed_ms"]) for run in runs if isinstance(run.get("elapsed_ms"), (int, float))]
    agent_elapsed = [float(run["agent_elapsed_ms"]) for run in runs if isinstance(run.get("agent_elapsed_ms"), (int, float))]
    human_wait = [float(run["human_wait_ms"]) for run in runs if isinstance(run.get("human_wait_ms"), (int, float))]
    step_counts = [len(run.get("steps") or []) for run in runs]
    reported = [run for run in runs if run.get("success") is not None]
    reviewed = [run for run in runs if isinstance(run.get("reviewed_success"), bool)]
    stage_values = defaultdict(list)
    intent_groups = defaultdict(list)
    model_groups = defaultdict(list)
    case_groups = defaultdict(list)
    for run in runs:
        intent_groups[str(run.get("intent") or "unknown")].append(run)
        if run.get("case_id"):
            case_groups[str(run["case_id"])].append(run)
        models = sorted({str(model) for model in run.get("reasoning_models", []) if model})
        model_groups[", ".join(models) if models else "unknown/local-only"].append(run)
        terminal_timings = run.get("terminal_step_timings_ms") or run.get("last_step_timings_ms") or {}
        if isinstance(terminal_timings, dict):
            for name, duration in terminal_timings.items():
                if isinstance(duration, (int, float)):
                    stage_values[name].append(float(duration))
        for step in run.get("steps") or []:
            timings = step.get("timings_ms") or {}
            if not isinstance(timings, dict):
                continue
            for name, duration in timings.items():
                if isinstance(duration, (int, float)):
                    stage_values[name].append(float(duration))

    def group_stats(group):
        values = [float(run["elapsed_ms"]) for run in group if isinstance(run.get("elapsed_ms"), (int, float))]
        reported_group = [run for run in group if run.get("success") is not None]
        reviewed_group = [run for run in group if isinstance(run.get("reviewed_success"), bool)]
        return {
            "tasks": len(group),
            "agent_reported_success_rate": round(sum(run.get("success") is True for run in reported_group) / len(reported_group), 4) if reported_group else None,
            "reviewed_success_rate": round(sum(run["reviewed_success"] is True for run in reviewed_group) / len(reviewed_group), 4) if reviewed_group else None,
            "reviewed_tasks": len(reviewed_group),
            "median_elapsed_ms": round(statistics.median(values), 1) if values else None,
            "median_agent_elapsed_ms": round(statistics.median(float(run["agent_elapsed_ms"]) for run in group if isinstance(run.get("agent_elapsed_ms"), (int, float))), 1)
            if any(isinstance(run.get("agent_elapsed_ms"), (int, float)) for run in group) else None,
            "median_human_wait_ms": round(statistics.median(float(run["human_wait_ms"]) for run in group if isinstance(run.get("human_wait_ms"), (int, float))), 1)
            if any(isinstance(run.get("human_wait_ms"), (int, float)) for run in group) else None,
            "median_steps": round(statistics.median(len(run.get("steps") or []) for run in group), 1) if group else None,
            "median_remote_calls": round(statistics.median(float(run["remote_calls"]) for run in group if isinstance(run.get("remote_calls"), (int, float))), 1)
            if any(isinstance(run.get("remote_calls"), (int, float)) for run in group) else None,
        }

    return {
        "tasks": len(runs),
        "agent_reported_success_rate": round(sum(run.get("success") is True for run in reported) / len(reported), 4) if reported else None,
        "reviewed_success_rate": round(sum(run["reviewed_success"] is True for run in reviewed) / len(reviewed), 4) if reviewed else None,
        "reviewed_tasks": len(reviewed),
        "median_elapsed_ms": round(statistics.median(elapsed), 1) if elapsed else None,
        "p95_elapsed_ms": round(percentile(elapsed, 0.95), 1) if elapsed else None,
        "median_agent_elapsed_ms": round(statistics.median(agent_elapsed), 1) if agent_elapsed else None,
        "median_human_wait_ms": round(statistics.median(human_wait), 1) if human_wait else None,
        "median_steps": round(statistics.median(step_counts), 1) if step_counts else None,
        "stage_latency_ms": {
            name: {
                "samples": len(values),
                "median": round(statistics.median(values), 1),
                "p95": round(percentile(values, 0.95), 1),
            }
            for name, values in sorted(stage_values.items())
        },
        "by_intent": {key: group_stats(group) for key, group in sorted(intent_groups.items())},
        "by_reasoning_model": {key: group_stats(group) for key, group in sorted(model_groups.items())},
        "by_case_id": {key: group_stats(group) for key, group in sorted(case_groups.items())},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", help="JSONL file of task timing traces downloaded from the extension")
    args = parser.parse_args()
    try:
        print(json.dumps(summarize(load_runs(args.runs)), indent=2))
    except (OSError, ValueError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
