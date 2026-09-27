# Comparing reasoning models on browser tasks

`scripts/evaluate_agent_models.py` replays the same sanitized browser observations through the production reasoning planner for each model ID. This isolates planner/model differences while keeping the task, page state, action history, target allowlist, prompt, and grounding repairs fixed.

Create a JSONL file with one decision per line. Label expected actions and targets from a human-reviewed successful run. Include ambiguous requests with `must_ask_user`, completed tasks with `expected_terminal`, and tempting but incorrect controls with `must_not_target_ids`.

```json
{"case_id":"search-submit","task":"Search for noise cancelling headphones","task_state":{"intent":"SEARCH"},"page_state":{"page_type":"search_home"},"fused_observation":{"elements":[{"id":"el_search","dom":{"tag":"input","label":"Search"}},{"id":"el_submit","dom":{"tag":"button","label":"Search"}}]},"task_history":[],"expected_action":"TYPE","expected_target_id":"el_search","expected_terminal":false,"must_ask_user":false,"must_not_target_ids":["el_submit"]}
```

Run it with the backend's configured endpoint and credentials:

```sh
python3 scripts/evaluate_agent_models.py path/to/cases.jsonl --models model-a,model-b
```

The report includes action and target accuracy where labels exist, clarification recall, unnecessary clarification rate, terminal accuracy, grounding repairs, forbidden-target selections, errors, and latency. Case details contain action names and element IDs only; model thoughts, task text, page text, and field values are omitted. The fixture itself must be sanitized before it is saved because the planner sends it to the configured model endpoint.

This is a planner replay benchmark. It compares decisions on captured states; it does not measure browser execution success, page changes after actions, or full-task completion. Keep a separate end-to-end task suite for those outcomes, and use multiple real tasks per capability (navigation, search, filtering, forms, extraction, and clarification) before switching the default model.
