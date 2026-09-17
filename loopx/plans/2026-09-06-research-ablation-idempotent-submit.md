# Research-Ablation Idempotent Submit-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the training-monitor extension's existing `_monitor_key`/`_existing_monitor` lookup logic into a shared, public module, then build a `loopx-research-ablation-check-before-submit` CLI that reports whether a `run_id` has already been tracked — so a host never double-submits a real training job after a crash/restart.

**Architecture:** A new `monitor_lookup.py` module holds the two functions (renamed public, behavior unchanged); `settlement.py` is edited to import from it instead of defining them itself. A new thin CLI wraps `existing_monitor()` and classifies its result into three states. Same package, same "package test convention" split as the rest of `loopx-research-ablation`: the extraction task touches LoopX-core-adjacent code (pytest, reusing `loopx_goal_fixture`), the new CLI is package-internal glue (plain-assert smoke script).

**Tech Stack:** Python 3.12, argparse.

**Spec:** `docs/superpowers/specs/2026-09-06-research-ablation-idempotent-submit-design.md`

## Global Constraints

- `monitor_key()`/`existing_monitor()` must be byte-for-byte behavior-identical to the current `_monitor_key`/`_existing_monitor` in `settlement.py` — this is a pure move, not a rewrite. `tests/extensions/test_research_ablation_settlement.py` must continue to pass unchanged after the move.
- `check-before-submit` does **not** take `--agent-id` — `existing_monitor()`'s underlying `list_goal_todos` call never uses it, so no dead parameter is declared (confirmed during plan self-review, spec updated accordingly).
- `check-before-submit`'s exit code is **0 for every successful query**, regardless of which of the three states (`no_prior_attempt` / `already_tracked_open` / `already_tracked_done`) it reports — the decision lives in the JSON `status` field, matching `list-attempts`'s convention, not `validate_cli.py`'s (where exit code IS the pass/fail signal). Only a genuine execution error (bad `--registry-path`, malformed `--goal-id`) exits 1.
- This plan does not implement reverse orphan reconciliation (cluster running but LoopX unaware), automatic new-run_id generation, or the SKILL.md operational playbook — all explicitly out of scope per the spec.
- No change to LoopX core (`loopx/` outside `packages/loopx-research-ablation/`).

---

### Task 1: Extract `monitor_lookup.py`

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/monitor_lookup.py`
- Modify: `packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py` (remove `_MONITOR_KEY_NAMESPACE`, `_UNSAFE_TOKEN_CHARS`, `_monitor_key`, `_existing_monitor`; import `monitor_key`, `existing_monitor` from `.monitor_lookup` instead; update the two call sites inside `settle()` from `_monitor_key(run_id)`/`_existing_monitor(...)` to `monitor_key(run_id)`/`existing_monitor(...)`)
- Create: `tests/extensions/test_research_ablation_monitor_lookup.py`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `MONITOR_KEY_NAMESPACE = "ablmon"`; `monitor_key(run_id: str) -> str`; `existing_monitor(*, registry_path: Path, goal_id: str, monitor_key: str) -> dict[str, Any] | None`. Task 2 imports both functions from this module.

- [ ] **Step 1: Write the failing test**

```python
# tests/extensions/test_research_ablation_monitor_lookup.py
from pathlib import Path

from loopx_research_ablation.monitor_lookup import existing_monitor, monitor_key


def test_monitor_key_sanitizes_and_namespaces():
    key = monitor_key("abl.moe-topk2.20260906-1430")
    assert key.startswith("ablmon:r-")
    assert key == "ablmon:r-abl.moe-topk2.20260906-1430"


def test_monitor_key_handles_digit_leading_run_id():
    key = monitor_key("20260906-run")
    assert key.startswith("ablmon:r-")


def test_existing_monitor_returns_none_when_absent(loopx_goal_fixture):
    registry_path, goal_id, agent_id = loopx_goal_fixture
    result = existing_monitor(
        registry_path=registry_path, goal_id=goal_id, monitor_key="ablmon:r-nope"
    )
    assert result is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/extensions/test_research_ablation_monitor_lookup.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'loopx_research_ablation.monitor_lookup'`

- [ ] **Step 3: Read `settlement.py`'s current definitions before moving them**

Run: `sed -n '38,105p' packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py`

This shows the exact current bodies of `_MONITOR_KEY_NAMESPACE`, `_UNSAFE_TOKEN_CHARS`, `_monitor_key`, and `_existing_monitor` (already confirmed during this plan's own writing — reproduced in Step 4 below verbatim, but re-read the live file first in case anything shifted since fix rounds landed on Task 6/7).

- [ ] **Step 4: Write `monitor_lookup.py`** (move, rename, no behavior change)

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/monitor_lookup.py
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from loopx.control_plane.todos.contract import TODO_TASK_CLASS_MONITOR
from loopx.todos import list_goal_todos

MONITOR_KEY_NAMESPACE = "ablmon"
_UNSAFE_TOKEN_CHARS = re.compile(r"[^a-z0-9_.:-]+")


def monitor_key(run_id: str) -> str:
    """Build a Todo `capability_binding_ref`-safe monitor key for `run_id`.

    Must match `TODO_CAPABILITY_BINDING_REF_PATTERN`:
    `^[a-z][a-z0-9_.-]{0,31}:[a-z][a-z0-9_.:-]{2,95}$` - both the namespace
    and the token must start with a lowercase letter, so an arbitrary
    (possibly digit-leading, possibly dotted-only) run_id is sanitized and
    given a letter-leading token prefix.
    """
    sanitized = _UNSAFE_TOKEN_CHARS.sub("-", run_id.strip().lower()).strip("-.:")
    token = f"r-{sanitized}" if sanitized else "r-run"
    return f"{MONITOR_KEY_NAMESPACE}:{token}"


def existing_monitor(
    *, registry_path: Path, goal_id: str, monitor_key: str
) -> dict[str, Any] | None:
    projection = list_goal_todos(registry_path=registry_path, goal_id=goal_id, role="agent")
    for item in projection.get("todos", []):
        if (
            isinstance(item, dict)
            and item.get("capability_binding_ref") == monitor_key
            and item.get("task_class") == TODO_TASK_CLASS_MONITOR
        ):
            return item
    return None
```

- [ ] **Step 5: Update `settlement.py` to import from the new module**

Remove from `settlement.py`: the `_MONITOR_KEY_NAMESPACE`/`_UNSAFE_TOKEN_CHARS` module-level constants, the `_monitor_key` function, and the `_existing_monitor` function (all now live in `monitor_lookup.py`). Remove the now-unused `import re` if nothing else in `settlement.py` uses the `re` module (check with `grep -n "re\." packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py` first).

Add this import near the top of `settlement.py`, alongside its existing `from .classify import Classification` line:

```python
from .monitor_lookup import existing_monitor, monitor_key
```

Then update `settle()`'s body: every call to `_monitor_key(run_id)` becomes `monitor_key(run_id)`, and every call to `_existing_monitor(registry_path=..., goal_id=..., monitor_key=...)` becomes `existing_monitor(registry_path=..., goal_id=..., monitor_key=...)`.

- [ ] **Step 6: Run to verify it passes — both the new test and the existing settlement suite**

Run: `.venv/bin/pytest tests/extensions/test_research_ablation_monitor_lookup.py tests/extensions/test_research_ablation_settlement.py -v`
Expected: all pass. The settlement tests passing unchanged is the proof this was a pure move, not a behavior change.

- [ ] **Step 7: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/monitor_lookup.py packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py tests/extensions/test_research_ablation_monitor_lookup.py
git commit -m "refactor(research-ablation): extract monitor_lookup.py from settlement.py"
```

---

### Task 2: `check-before-submit` CLI

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/check_before_submit_cli.py`
- Create: `packages/loopx-research-ablation/smoke/check_before_submit_cli_smoke.py`

**Interfaces:**
- Consumes: `monitor_key`, `existing_monitor` from Task 1's `monitor_lookup.py`; `TODO_STATUS_DONE` from `loopx.control_plane.todos.contract` (the same module `settlement.py` already imports `TODO_TASK_CLASS_MONITOR` from — `TODO_STATUS_DONE = "done"`, confirmed by reading that file directly).
- Produces: `main(argv: list[str] | None = None) -> int`, entrypoint for a future `pyproject.toml` `[project.scripts] loopx-research-ablation-check-before-submit = "loopx_research_ablation.check_before_submit_cli:main"` (added by whichever plan's packaging task runs last — check `pyproject.toml`'s existence and current `[project.scripts]` contents before deciding whether to create or extend it, same pattern as the monitor plan's Task 8 and the dedup plan's Task 4).

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/check_before_submit_cli_smoke.py
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, "PYTHONPATH": str(PKG_ROOT / "src")}
    return subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.check_before_submit_cli", *args],
        capture_output=True,
        text=True,
        env=env,
    )


def test_bad_registry_path_exits_1_with_stderr_message():
    with tempfile.TemporaryDirectory() as tmp:
        result = _run_cli(
            [
                "--run-id", "abl.nope",
                "--registry-path", str(Path(tmp) / "does-not-exist"),
                "--goal-id", "fixture-goal",
            ]
        )
        assert result.returncode == 1
        assert "validation error" in result.stderr.lower()


if __name__ == "__main__":
    test_bad_registry_path_exits_1_with_stderr_message()
    print("check_before_submit_cli_smoke: OK (no_prior_attempt/already_tracked_* cases covered by tests/extensions/test_research_ablation_check_before_submit.py, which needs a real LoopX registry)")
```

Note: this smoke script deliberately covers only the execution-error path (bad registry path), because the three real classification states (`no_prior_attempt`/`already_tracked_open`/`already_tracked_done`) require a real LoopX goal registry to populate — that needs `loopx_goal_fixture`, which lives in `tests/extensions/conftest.py` (pytest-only). Step 5 below adds those three cases as a pytest file, matching how Task 6 split its own package-internal vs. LoopX-core-adjacent tests.

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python packages/loopx-research-ablation/smoke/check_before_submit_cli_smoke.py`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write `check_before_submit_cli.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/check_before_submit_cli.py
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from loopx.control_plane.todos.contract import TODO_STATUS_DONE

from .monitor_lookup import existing_monitor, monitor_key


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="loopx-research-ablation-check-before-submit")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--registry-path", required=True)
    parser.add_argument("--goal-id", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _parse_args(argv)
    try:
        key = monitor_key(args.run_id)
        todo = existing_monitor(
            registry_path=Path(args.registry_path),
            goal_id=args.goal_id,
            monitor_key=key,
        )
        if todo is None:
            status, todo_status = "no_prior_attempt", None
        elif todo.get("status") == TODO_STATUS_DONE:
            status, todo_status = "already_tracked_done", todo.get("status")
        else:
            status, todo_status = "already_tracked_open", todo.get("status")

        print(
            json.dumps(
                {"status": status, "monitor_key": key, "todo_status": todo_status},
                sort_keys=True,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - protocol boundary reports all failures uniformly
        print(f"validation error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify the smoke test passes**

Run: `.venv/bin/python packages/loopx-research-ablation/smoke/check_before_submit_cli_smoke.py`
Expected: prints `check_before_submit_cli_smoke: OK ...`

- [ ] **Step 5: Write the pytest cases covering the three real classification states**

```python
# tests/extensions/test_research_ablation_check_before_submit.py
import json
import subprocess
import sys
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[2] / "packages" / "loopx-research-ablation"


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, "PYTHONPATH": str(PKG_ROOT / "src")}
    return subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.check_before_submit_cli", *args],
        capture_output=True,
        text=True,
        env=env,
    )


def test_no_prior_attempt_when_never_tracked(loopx_goal_fixture):
    registry_path, goal_id, agent_id = loopx_goal_fixture
    result = _run_cli(
        ["--run-id", "abl.never-tracked", "--registry-path", str(registry_path), "--goal-id", goal_id]
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "no_prior_attempt"
    assert payload["todo_status"] is None


def test_already_tracked_open_after_upsert(loopx_goal_fixture):
    registry_path, goal_id, agent_id = loopx_goal_fixture
    from loopx_research_ablation.classify import Classification
    from loopx_research_ablation.settlement import settle

    settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.open-run",
        classification=Classification(status="still_running", is_terminal=False, stall_signal="changed"),
        evidence={"last_step": 5}, cadence_seconds=1800, expires_in_seconds=5400,
    )
    result = _run_cli(
        ["--run-id", "abl.open-run", "--registry-path", str(registry_path), "--goal-id", goal_id]
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "already_tracked_open"


def test_already_tracked_done_after_completion(loopx_goal_fixture):
    registry_path, goal_id, agent_id = loopx_goal_fixture
    from loopx_research_ablation.classify import Classification
    from loopx_research_ablation.settlement import settle

    settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.done-run",
        classification=Classification(status="completed_normally", is_terminal=True, stall_signal=None),
        evidence={
            "run_id": "abl.done-run", "status": "completed_normally", "exit_code": 0,
            "last_step": 100, "target_step": 100, "log_path": "/tmp/t.log",
            "metrics_path": "/tmp/m.json",
        },
        cadence_seconds=1800, expires_in_seconds=5400,
    )
    result = _run_cli(
        ["--run-id", "abl.done-run", "--registry-path", str(registry_path), "--goal-id", goal_id]
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "already_tracked_done"
```

- [ ] **Step 6: Run to verify it passes**

Run: `.venv/bin/pytest tests/extensions/test_research_ablation_check_before_submit.py -v`
Expected: 3/3 pass. If `settle()`'s two calls (upsert-only vs upsert+complete) don't produce the Todo status you expect, re-read `settlement.py`'s current body rather than guessing — its exact behavior was hardened during Task 6's own real-API reconciliation and must not be re-guessed here.

- [ ] **Step 7: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/check_before_submit_cli.py packages/loopx-research-ablation/smoke/check_before_submit_cli_smoke.py tests/extensions/test_research_ablation_check_before_submit.py
git commit -m "feat(research-ablation): add check-before-submit CLI"
```
